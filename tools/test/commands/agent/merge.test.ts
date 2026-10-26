import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli, gameWithRun, runAgent } from './helpers.ts';

const data = vi.hoisted(() => ({ exitCode: 0, calls: [] as string[], write: null as ((root: string) => void) | null }));
vi.mock('../../../src/commands/data/api.ts', () => ({
  runData: (_ctx: unknown, game: { root: string }) => {
    data.calls.push(game.root);
    data.write?.(game.root);
    return Promise.resolve({ exitCode: data.exitCode, lines: data.exitCode === 0 ? [] : [{ level: 'ERROR', code: 'x', where: 'w', message: 'm', text: 'ERROR x bad row' }], stderr: '' });
  },
}));

/**
 * The `ogw code check core` type check of `ogw agent merge`: `fake` gives the failure lines of a commit (`agent/<id>`
 * for a branch, a commit id for main); with `real` the check runs. `calls` lists the commits checked.
 */
type FakeTypeCheck = (commit: string) => { failures: string[]; complete: boolean; stops?: { part: 'TypeScript' | 'engine'; reason: string }[] };
const typeCheck = vi.hoisted(() => {
  const pass: FakeTypeCheck = () => ({ failures: [], complete: true });
  return { real: false, fake: pass, calls: [] as string[] };
});
vi.mock('../../../src/commands/code/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/code/api.ts')>();
  return {
    ...actual,
    runCoreTypeCheck: (ctx: Parameters<typeof actual.runCoreTypeCheck>[0], commit: string, root: string) => {
      typeCheck.calls.push(commit);
      return typeCheck.real ? actual.runCoreTypeCheck(ctx, commit, root) : Promise.resolve({ stops: [], ...typeCheck.fake(commit) });
    },
  };
});

beforeEach(() => {
  typeCheck.real = false;
  typeCheck.fake = () => ({ failures: [], complete: true });
  typeCheck.calls = [];
  data.exitCode = 0;
  data.calls = [];
  data.write = null;
});

const RESOURCES = 'key,status\nhero,placeholder\nsword,placeholder\n';

/** A resource job whose agent changes `hero` and adds an image, then commits. */
async function resourceJob(ws: TestWorkspace, root: string, extra = ''): Promise<string> {
  const fake = fakeAgentCli(
    ws,
    [
      "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,final\\nsword,placeholder\\n');",
      "fs.mkdirSync('resource/2d', { recursive: true }); fs.writeFileSync('resource/2d/hero.png', 'img');",
      extra,
      "execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'hero']);",
      "fs.writeFileSync(output, 'done');",
    ].join('\n'),
  );
  const { id, waited } = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/hero.md')], fake.env, root);
  expect(waited.code).toBe(0);
  return id;
}

async function gameForMerge(ws: TestWorkspace): Promise<string> {
  const { root } = await gameWithRun(ws, { 'resource/resources.csv': RESOURCES, 'records/loops/r1/resource-requests/hero.md': '## keys\n' });
  return root;
}

describe('ogw agent merge: game worktrees', () => {
  it('merges resources.csv by row with the branch changes, runs ogw data, and removes the worktree', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,placeholder\nsword,placeholder\nshield,placeholder\n');
    commitAll(root, 'branch adds shield');
    writeFileSync(join(root, 'untracked-note.md'), 'keep me');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
    expect(readFileSync(join(root, 'resource/resources.csv'), 'utf8')).toBe('key,status\nhero,final\nsword,placeholder\nshield,placeholder\n');
    expect(readFileSync(join(root, 'resource/2d/hero.png'), 'utf8')).toBe('img');
    expect(sh(root, 'git', ['log', '-1', '--format=%s']).trim()).toBe(`ogw agent merge ${id}`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('?? untracked-note.md\n');
    expect(data.calls).toEqual([root]);
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(false);
    expect(sh(root, 'git', ['branch', '--list', `agent/${id}`])).toBe('');
    expect((await readJob(id, ws.env)).meta.merged).toBe(true);
    const again = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(again).toMatchObject({ code: 1, stdout: `not merged ${id}: already merged: the job was merged before\n` });
  });

  it('commits the files ogw data changes and creates with the merge', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, {
      'resource/resources.csv': RESOURCES,
      'records/loops/r1/resource-requests/hero.md': '## keys\n',
      'data/generated/ids.txt': 'old\n',
    });
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'untracked-note.md'), 'keep me');
    data.write = (dir) => {
      writeFileSync(join(dir, 'data/generated/ids.txt'), 'new\n');
      writeFileSync(join(dir, 'data/generated/built.bin'), 'bin');
    };
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
    expect(sh(root, 'git', ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ')).toHaveLength(3);
    const files = sh(root, 'git', ['diff', '--name-only', 'HEAD^1', 'HEAD']).split('\n').filter((line) => line !== '');
    expect(files).toEqual(expect.arrayContaining(['data/generated/ids.txt', 'data/generated/built.bin', 'resource/resources.csv', 'resource/2d/hero.png']));
    expect(sh(root, 'git', ['log', '-1', '--format=%s']).trim()).toBe(`ogw agent merge ${id}`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('?? untracked-note.md\n');
  });

  it('does not merge when git refuses to start the merge, and keeps the worktree and branch', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    mkdirSync(join(root, 'resource/2d'), { recursive: true });
    writeFileSync(join(root, 'resource/2d/hero.png'), 'mine');
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { merged: string[]; failed: { id: string; reason: string; detail: string }[] };
    expect(result.merged).toEqual([]);
    expect(result.failed).toMatchObject([{ id, reason: 'conflict' }]);
    expect(result.failed[0]?.detail).toContain('untracked working tree files would be overwritten');
    expect(data.calls).toEqual([]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(root, 'resource/resources.csv'), 'utf8')).toBe(RESOURCES);
    expect(readFileSync(join(root, 'resource/2d/hero.png'), 'utf8')).toBe('mine');
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('?? resource/2d/hero.png\n');
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(true);
    expect(sh(root, 'git', ['branch', '--list', `agent/${id}`])).toContain(`agent/${id}`);
    expect((await readJob(id, ws.env)).meta.merged).toBe(false);
  });

  it('keeps the worktree and changes nothing on a row conflict', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,other\nsword,placeholder\n');
    const before = commitAll(root, 'branch changes hero');
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ merged: [], failed: [{ id, reason: 'conflict', detail: 'resource/resources.csv: key hero changed on both sides' }] });
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(true);
    expect((await readJob(id, ws.env)).meta.merged).toBe(false);
  });

  it('does not merge a sub-agent file that is not CSV, with the reason of an ogw data failure', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,\"final\\n');");
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,placeholder\nsword,other\n');
    const before = commitAll(root, 'branch changes sword');
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    const failed = (JSON.parse(run.stdout) as { failed: { id: string; reason: string; detail: string }[] }).failed;
    expect(failed).toEqual([{ id, reason: 'data', detail: expect.stringMatching(/^resource\/resources\.csv: invalid CSV/) as string }]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('does not merge a sub-agent resources.csv without the key column when the branch did not change that file', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'name,status\\nhero,final\\n');");
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: { reason: string; detail: string }[] }).failed).toEqual([{ id, reason: 'data', detail: expect.stringContaining('resource/resources.csv') as string }]);
  });

  it('does not merge a sub-agent file that is not CSV when the branch did not change that file', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,\"final\\n');");
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: { reason: string }[] }).failed.map((f) => f.reason)).toEqual(['data']);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
  });

  it('is a conflict when another file conflicts in git', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('settings.json', '{\"a\": 1}\\n');");
    writeFileSync(join(root, 'settings.json'), '{"a": 2}\n');
    commitAll(root, 'branch settings');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.stdout).toBe(`not merged ${id}: conflict: settings.json\n`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('does not merge when ogw data fails, and removes what the merge left', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    data.exitCode = 1;
    data.write = (dir) => {
      writeFileSync(join(dir, 'data-built.bin'), 'bin');
    };
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.stdout).toBe(`not merged ${id}: data: ERROR x bad row\n`);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(existsSync(join(root, 'resource/2d/hero.png'))).toBe(false);
    expect(existsSync(join(root, 'data-built.bin'))).toBe(false);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('refuses a checkout with uncommitted changes or on another branch', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'settings.json'), '{"dirty": true}\n');
    expect((await ogw(ws, ['agent', 'merge', id], { cwd: root })).stdout).toContain('uncommitted changes');
    sh(root, 'git', ['checkout', '--quiet', '--', 'settings.json']);
    sh(root, 'git', ['checkout', '--quiet', '-b', 'other']);
    expect((await ogw(ws, ['agent', 'merge', id], { cwd: root })).stdout).toContain(`is not on loop/r1`);
  });

  it('merges translations and the glossary by their rules', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, {
      'records/loops/r1/translation-input-ko-1.md': 'ko',
      'data/translations/ko.csv': `${head}a,A,,h,\nb,B,,h,\n`,
      'data/glossary.csv': 'source,id_name,note,source_hash,ko\nSword,[sword],,s,\n',
    });
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', ${JSON.stringify(`${head}a,A,h,h,에이\nb,B,h,h,비\n`)});`,
        "fs.writeFileSync('data/glossary.csv', 'source,id_name,note,source_hash,ko\\nSword,[sword],,s,검\\n');",
        "execFileSync('git', ['commit', '-qam', 'ko']); fs.writeFileSync(output, 'ok');",
      ].join('\n'),
    );
    const { id } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], fake.env, root);
    writeFileSync(join(root, 'data/translations/ko.csv'), `${head}a,A2,,h2,\nc,C,,h,\n`);
    writeFileSync(join(root, 'data/glossary.csv'), 'source,id_name,note,source_hash,ko\nSword,[sword],noted,s,\n');
    commitAll(root, 'branch source change');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.code).toBe(0);
    expect(readFileSync(join(root, 'data/translations/ko.csv'), 'utf8')).toBe(`${head}a,A2,h,h2,에이\nc,C,,h,\n`);
    expect(readFileSync(join(root, 'data/glossary.csv'), 'utf8')).toBe('source,id_name,note,source_hash,ko\nSword,[sword],noted,s,검\n');
  });

  it('does not merge a translation file that is not UTF-8, with the reason of an ogw data failure', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, { 'records/loops/r1/translation-input-ko-1.md': 'ko', 'data/translations/ko.csv': `${head}a,A,,h,\n` });
    // CP949 bytes of the text cell, which a lossy decode would have turned into U+FFFD and merged
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', Buffer.concat([Buffer.from(${JSON.stringify(`${head}a,A,h,h,`)}), Buffer.from([0xbe, 0xc8, 0x0a])]));`,
        "execFileSync('git', ['commit', '-qam', 'ko']); fs.writeFileSync(output, 'ok');",
      ].join('\n'),
    );
    const { id } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], fake.env, root);
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: unknown[] }).failed).toEqual([{ id, reason: 'data', detail: 'data/translations/ko.csv: not UTF-8' }]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(root, 'data/translations/ko.csv'), 'utf8')).toBe(`${head}a,A,,h,\n`);
  });

  it('reports unknown and running jobs', async () => {
    const ws = makeWorkspace();
    const run = await ogw(ws, ['agent', 'merge', 'nojob1']);
    expect(run).toMatchObject({ code: 1, stdout: 'not merged nojob1: error: job not found: nojob1\n' });
    expect((await ogw(ws, ['agent', 'merge'])).stderr).toContain('usage: ogw agent merge');
  });
});
