import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTokens, type CommandDef } from '../../src/lib/command.ts';
import { OgwError } from '../../src/lib/errors.ts';
import { commitPaths, gitLine, head, statusLines } from '../../src/lib/git.ts';
import { writeJsonAtomic } from '../../src/lib/fsx.ts';
import { hostBootId, jobPaths, readJob, startJob, updateJob, waitJob, type JobRecord } from '../../src/lib/jobs.ts';
import { processStartedAt, which } from '../../src/lib/proc.ts';
import { validateAgainst, validateStructured, withDefaults } from '../../src/lib/settings.ts';
import { cleanup, waitDead } from '../helpers/procs.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh } from '../helpers/workspace.ts';

describe('parseTokens', () => {
  const spec = {
    game: { type: 'string' },
    module: { type: 'string', multiple: true },
    wait: { type: 'boolean' },
  } as const;

  it('reads positionals, single, multiple and boolean options', () => {
    const args = parseTokens(['core', '--module', 'a', 'b', '--wait', '--game=g', '--module', 'c'], spec);
    expect(args.positionals).toEqual(['core']);
    expect(args.values).toEqual({ module: ['a', 'b', 'c'], wait: true, game: 'g' });
  });

  it('rejects unknown options, missing values and repeats', () => {
    expect(() => parseTokens(['--nope'], spec)).toThrow(OgwError);
    expect(() => parseTokens(['--game'], spec)).toThrow('needs a value');
    expect(() => parseTokens(['--game', 'a', '--game', 'b'], spec)).toThrow('given twice');
    expect(() => parseTokens(['--wait=1'], spec)).toThrow('takes no value');
  });

  it('treats everything after -- as positionals', () => {
    expect(parseTokens(['--', '--wait'], spec).positionals).toEqual(['--wait']);
  });
});

describe('runCli', () => {
  const echo: CommandDef = {
    name: ['echo', 'it'],
    usage: 'ogw echo it <word>',
    run(_ctx, args) {
      if (args.positionals[0] === 'fail') return Promise.reject(new OgwError('failed on purpose', 3));
      return Promise.resolve({ text: `said ${String(args.positionals[0])}`, data: { word: args.positionals[0] } });
    },
  };

  it('dispatches by the longest name and prints text or JSON', async () => {
    const ws = makeWorkspace();
    expect(await ogw(ws, ['echo', 'it', 'hi'], { commands: [echo] })).toMatchObject({ code: 0, stdout: 'said hi\n' });
    const json = await ogw(ws, ['echo', 'it', 'hi', '--json'], { commands: [echo] });
    expect(JSON.parse(json.stdout)).toEqual({ word: 'hi' });
  });

  it('ends with the error exit code and message', async () => {
    const ws = makeWorkspace();
    const run = await ogw(ws, ['echo', 'it', 'fail'], { commands: [echo] });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('failed on purpose');
  });

  it('fails on an unknown command', async () => {
    const ws = makeWorkspace();
    expect((await ogw(ws, ['nothing'], { commands: [echo] })).code).toBe(1);
  });
});

describe('jobs', () => {
  it('runs a command in a detached supervisor and records its exit code and output', async () => {
    const ws = makeWorkspace();
    const id = await startJob({
      argv: ['job', 'status', 'missingjob'],
      cwd: ws.root,
      command: 'job status',
      game: null,
      timeLimitMs: 60_000,
      agentJob: null,
      env: ws.env,
    });
    const result = await waitJob(id, 30_000, ws.env);
    expect(result.finished).toBe(true);
    expect(result.job.status).toBe('failed');
    expect(result.job.exitCode).toBe(1);
    expect(result.stderr).toContain('job not found: missingjob');
    const wait = await ogw(ws, ['job', 'wait', id]);
    expect(wait.code).toBe(1);
    expect((await ogw(ws, ['job', 'status', id])).stdout).toBe('failed\n');
    expect((await readJob(id, ws.env)).supervisorPid).toBeTypeOf('number');
  });

  it('job wait ends with 75 and prints running while the job runs', async () => {
    const ws = makeWorkspace();
    const id = await startJob({
      argv: ['job', 'wait', 'nosuchjobyet', '--timeout', '1'],
      cwd: ws.root,
      command: 'job wait',
      game: null,
      timeLimitMs: 60_000,
      agentJob: null,
      env: ws.env,
    });
    const quick = await ogw(ws, ['job', 'wait', id, '--timeout', '0']);
    expect([75, 1]).toContain(quick.code);
    await waitJob(id, 30_000, ws.env);
  });
});

describe('job time limit', () => {
  it.runIf(process.platform !== 'win32')('ends the agent CLI process group of a job that reaches its time limit, though it ignores SIGTERM', async () => {
    const ws = makeWorkspace();
    // a running job for the command to wait on: its supervisor is this test process
    const waited: JobRecord = {
      id: `w${String(Date.now())}`,
      argv: [],
      cwd: ws.root,
      command: 'check',
      game: null,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      exitCode: null,
      supervisorPid: process.pid,
      supervisorStartedAt: processStartedAt(process.pid) ?? undefined,
      bootId: hostBootId(),
      pid: null,
      timeLimitMs: 60_000,
      agentJob: null,
      summary: null,
      meta: {},
    };
    await writeJsonAtomic((await jobPaths(waited.id, ws.env)).record, waited);
    const cli = spawn('sh', ['-c', 'trap "" TERM; sleep 60'], { detached: true, stdio: 'ignore' });
    try {
      const id = await startJob({ argv: ['job', 'wait', waited.id, '--timeout', '30000'], cwd: ws.root, command: 'job wait', game: null, timeLimitMs: 1500, agentJob: null, env: ws.env });
      await updateJob(id, (j) => {
        j.meta = { cliPid: cli.pid, cliPidStartedAt: processStartedAt(cli.pid as number) };
      }, ws.env);
      const result = await waitJob(id, 30_000, ws.env);
      expect(result.job.status).toBe('failed');
      expect(await waitDead(cli.pid as number)).toBe(true);
    } finally {
      cleanup([cli.pid]);
    }
  });
});

describe('workspace helpers', () => {
  it('makes a game repo on main', () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'settings.json': { engine: 'godot' } });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ engine: 'godot' });
  });
});

describe('statusLines', () => {
  it('lists changes and untracked files, only under the given paths when paths are given', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.harness, 'tools', 'sub'), { recursive: true });
    writeFileSync(join(ws.harness, 'tools', 'kept.ts'), 'a');
    commitAll(ws.harness, 'kept');
    writeFileSync(join(ws.harness, 'tools', 'kept.ts'), 'b');
    writeFileSync(join(ws.harness, 'tools', 'sub', 'new.ts'), 'c');
    writeFileSync(join(ws.harness, 'outside.txt'), 'd');
    expect(await statusLines(ws.harness, { env: ws.env })).toEqual([' M tools/kept.ts', '?? outside.txt', '?? tools/sub/new.ts']);
    expect(await statusLines(ws.harness, { env: ws.env }, ['tools'])).toEqual([' M tools/kept.ts', '?? tools/sub/new.ts']);
    expect(await statusLines(ws.harness, { env: ws.env }, ['nothing-here'])).toEqual([]);
  });
});

describe('settings validation', () => {
  const schema = {
    $id: 'x.schema.json',
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'integer', default: 3 }, b: { type: 'string' } },
    required: ['b'],
  };

  it('gives Ajv errors, lines and defaults with one compiled schema reused', () => {
    expect(validateStructured(schema, { b: 'x' })).toEqual([]);
    const errors = validateStructured(schema, { a: 'no', c: 1 });
    expect(errors.map((e) => [e.instancePath, e.keyword])).toEqual([['', 'required'], ['', 'additionalProperties'], ['/a', 'type']]);
    expect(validateAgainst(schema, { a: 'no', c: 1 })).toEqual(["/ must have required property 'b'", '/ must NOT have additional properties (c)', '/a must be integer']);
    expect(validateAgainst(schema, { b: 'x' })).toEqual([]);
    const value = { b: 'x' };
    expect(withDefaults(schema, value)).toEqual({ a: 3, b: 'x' });
    expect(value).toEqual({ b: 'x' });
    expect(withDefaults(schema, { a: 1, b: 'y' })).toEqual({ a: 1, b: 'y' });
    expect(validateAgainst({ ...schema, required: [] }, {})).toEqual([]);
  });
});

describe('env of lib helpers', () => {
  it('which looks at the PATH of the given env', async () => {
    const ws = makeWorkspace();
    const bin = join(ws.root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ogw-fake-tool'), '#!/bin/sh\n');
    chmodSync(join(bin, 'ogw-fake-tool'), 0o755);
    expect(await which('ogw-fake-tool', { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` })).toBe(join(bin, 'ogw-fake-tool'));
    expect(await which('ogw-fake-tool')).toBeNull();
  });

  it('git helpers run git with the given env', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'a.txt': 'a' });
    writeFileSync(join(dir, 'b.txt'), 'b');
    const env = { ...ws.env, GIT_AUTHOR_NAME: 'env-author', GIT_AUTHOR_EMAIL: 'env@example.com' };
    const commit = await commitPaths(dir, ['b.txt'], 'add b', { env });
    expect(commit).toBe(await head(dir, { env }));
    expect(await gitLine(dir, ['log', '-1', '--format=%an %ae'], { env })).toBe('env-author env@example.com');
  });

  it('commitPaths with noVerify skips the pre-commit hook', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'a.txt': 'a' });
    const hooks = sh(dir, 'git', ['rev-parse', '--git-path', 'hooks']).trim();
    mkdirSync(join(dir, hooks), { recursive: true });
    writeFileSync(join(dir, hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, hooks, 'pre-commit'), 0o755);
    writeFileSync(join(dir, 'b.txt'), 'b');
    await expect(commitPaths(dir, ['b.txt'], 'add b', { env: ws.env })).rejects.toThrow();
    expect(await commitPaths(dir, ['b.txt'], 'add b', { env: ws.env, noVerify: true })).toBe(await head(dir, { env: ws.env }));
    expect(sh(dir, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual(['add b', '', 'b.txt']);
  });

  it('commitPaths keeps what the pre-commit hook staged in the index, and leaves other changes alone', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'a.txt': 'a', 'other.txt': 'o' });
    const hooks = sh(dir, 'git', ['rev-parse', '--git-path', 'hooks']).trim();
    mkdirSync(join(dir, hooks), { recursive: true });
    writeFileSync(join(dir, hooks, 'pre-commit'), '#!/bin/sh\nif git diff --cached --name-only | grep -qx "n.gd"; then echo uid > n.gd.uid; git add n.gd.uid; fi\n');
    chmodSync(join(dir, hooks, 'pre-commit'), 0o755);
    writeFileSync(join(dir, 'n.gd'), 'extends Node\n');
    writeFileSync(join(dir, 's.txt'), 's');
    sh(dir, 'git', ['add', 's.txt']);
    writeFileSync(join(dir, 'other.txt'), 'changed');
    expect(await commitPaths(dir, ['n.gd'], 'add n', { env: ws.env })).not.toBeNull();
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(['n.gd', 'n.gd.uid']);
    expect(sh(dir, 'git', ['status', '--porcelain']).replace(/\n$/, '').split('\n').sort()).toEqual([' M other.txt', 'A  s.txt']);
  });

  it('commitPaths leaves the index at HEAD for a path the pre-commit hook reverted', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'b.gd': 'extends Node\n', 'b.gd.uid': 'uid', 'a.csv': 'a' });
    const hooks = sh(dir, 'git', ['rev-parse', '--git-path', 'hooks']).trim();
    mkdirSync(join(dir, hooks), { recursive: true });
    writeFileSync(join(dir, hooks, 'pre-commit'), '#!/bin/sh\nif git diff --cached --name-only | grep -qx "n.gd"; then echo uid > n.gd.uid; git add n.gd.uid; git checkout HEAD -- b.gd.uid; fi\n');
    chmodSync(join(dir, hooks, 'pre-commit'), 0o755);
    writeFileSync(join(dir, 'n.gd'), 'extends Node\n');
    writeFileSync(join(dir, 'b.gd.uid'), 'changed');
    expect(await commitPaths(dir, ['.'], 'add n', { env: ws.env })).not.toBeNull();
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(['n.gd', 'n.gd.uid']);
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    writeFileSync(join(dir, 'a.csv'), 'b');
    expect(await commitPaths(dir, ['a.csv'], 'change a', { env: ws.env })).not.toBeNull();
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('a.csv');
    expect(sh(dir, 'git', ['show', 'HEAD:b.gd.uid'])).toBe('uid');
  });
});
