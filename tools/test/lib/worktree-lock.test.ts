// The git worktree commands of processes that make and remove worktrees of one repo at once run one at a time
// (ogw.md `## temp folder`): a remove or prune deletes the admin folder of a worktree another process is still adding.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRaw, WORKTREE_LOCK } from '../../src/lib/git.ts';
import { commitAll, gitInit, gitEnv, sh } from '../helpers/workspace.ts';

/** Seconds the fake git waits in each worktree command before it runs git: long enough for the lanes to overlap. */
const HOLD_SECONDS = 0.5;

/** A `git` on PATH that logs the start and end of each worktree command, with a wait before it runs git. */
function loggingGit(dir: string): { bin: string; log: string } {
  const real = sh(dir, 'sh', ['-c', 'command -v git']).trim();
  const bin = join(dir, 'bin');
  const log = join(dir, 'worktree.log');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = worktree ]; then',
      `  echo "start $2 $$" >> '${log}'`,
      `  sleep ${String(HOLD_SECONDS)}`,
      `  '${real}' "$@"; code=$?`,
      `  echo "end $2 $$" >> '${log}'`,
      '  exit $code',
      'fi',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, log };
}

/**
 * A process that waits for the file `go`, then, from `cwd`, adds a worktree `worktree` of HEAD with `worktreeAdd`,
 * lists the worktrees and removes it with `worktreeRemove`; it writes `ready` when it waits.
 */
function lane(cwd: string, worktree: string, ready: string, go: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  const script = [
    `const { gitRaw, worktreeAdd, worktreeRemove } = await import(${JSON.stringify(resolve('src/lib/git.ts'))});`,
    `const fs = await import('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(ready)}, '');`,
    `while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));`,
    `await worktreeAdd(${JSON.stringify(cwd)}, ${JSON.stringify(worktree)}, 'HEAD');`,
    `if ((await gitRaw(${JSON.stringify(cwd)}, ['worktree', 'list', '--porcelain'])).code !== 0) process.exit(3);`,
    `await worktreeRemove(${JSON.stringify(cwd)}, ${JSON.stringify(worktree)});`,
  ].join('\n');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((done) => {
    child.on('close', (code) => {
      done({ code, stderr });
    });
  });
}

async function waitFor(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) throw new Error(`not ready: ${paths.filter((path) => !existsSync(path)).join(', ')}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('worktree lock', () => {
  it('runs the worktree commands of processes on one repo one at a time, from the main checkout and from a worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-worktree-lock-'));
    const repo = join(dir, 'repo');
    gitInit(repo);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    commitAll(repo);
    const other = join(dir, 'other');
    sh(repo, 'git', ['worktree', 'add', '--quiet', '--detach', other]);
    const { bin, log } = loggingGit(dir);
    const env = { ...process.env, ...gitEnv, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
    const go = join(dir, 'go');
    const cwds = [repo, other, repo];
    const ready = cwds.map((_, k) => join(dir, `ready-${String(k)}`));
    const lanes = cwds.map((cwd, k) => lane(cwd, join(dir, `lane-${String(k)}`), ready[k] as string, go, env));
    await waitFor(ready);
    writeFileSync(go, '');
    const results = await Promise.all(lanes);
    expect(results.map((r) => r.stderr.trim())).toEqual(['', '', '']);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    // each lane ran add, list, remove and prune; no command started before the one before it ended
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(cwds.length * 4 * 2);
    for (let i = 0; i < lines.length; i += 2) {
      const [start, end] = [lines[i] as string, lines[i + 1] as string];
      expect(start.startsWith('start ')).toBe(true);
      expect(end).toBe(start.replace(/^start /, 'end '));
    }
    expect(lines.filter((line) => line.startsWith('start ')).map((line) => line.split(' ')[1]).sort()).toEqual(['add', 'add', 'add', 'list', 'list', 'list', 'prune', 'prune', 'prune', 'remove', 'remove', 'remove']);
    const listed = sh(repo, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree '));
    expect(listed).toHaveLength(2);
    expect(existsSync(join(repo, '.git', WORKTREE_LOCK))).toBe(false);
  });

  it('gives the failed result of git for a worktree command in a folder git finds no repo in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-worktree-lock-'));
    const result = await gitRaw(dir, ['worktree', 'prune'], { env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });
});
