import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ogw } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

let runner: Runner;
let id: string;

beforeAll(async () => {
  runner = setupRunner();
  id = await startFor(runner);
});

afterAll(async () => {
  await stopAll(runner);
});

describe('ogw capture', () => {
  it('writes the screen PNG into captures/ of the instance checkout and prints its path', async () => {
    const run = await ogw(runner.ws, ['capture', id]);
    expect(run.code).toBe(0);
    const path = run.stdout.trim();
    expect(path).toMatch(new RegExp(`^${join(runner.root, 'captures', id)}-[0-9]+\\.png$`));
    expect(readFileSync(path, 'utf8')).toBe('PNG-main');
  });

  it('writes the video frames of --video into a folder', async () => {
    runner.config({ clients: { main: { videoFrames: 2 } } });
    const run = await ogw(runner.ws, ['capture', id, '--video', '500', '--json']);
    const data = JSON.parse(run.stdout) as { path: string; frames: string[]; result: unknown };
    expect(data.path).toMatch(new RegExp(`^${join(runner.root, 'captures', id)}-[0-9]+-video$`));
    expect(data.frames).toEqual([join(data.path, 'frame-00000.png'), join(data.path, 'frame-00001.png')]);
    expect(data.result).toEqual({ frame_count: 2, fps: 30 });
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'capture_video', args: ['500'] });
    expect((await ogw(runner.ws, ['capture', id, '--video', '0'])).stderr).toContain('invalid --video: 0');
  });

  it('writes into captures/ of the folder of a play agent', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ogw-play-'));
    const remove = await fakeAgentJob(runner.ws.env, 'agentplay2', { role: 'play', cliPid: process.ppid, folder });
    try {
      const run = await ogw(runner.ws, ['capture', id]);
      expect(run.stdout.trim().startsWith(join(folder, 'captures', `${id}-`))).toBe(true);
    } finally {
      remove();
    }
    const out = mkdtempSync(join(tmpdir(), 'ogw-judge-'));
    const removeJudge = await fakeAgentJob(runner.ws.env, 'agentjudge2', { role: 'judge', cliPid: process.ppid, output: join(out, 'result.md') });
    try {
      const run = await ogw(runner.ws, ['capture', id]);
      expect(run.stdout.trim().startsWith(join(out, 'captures', `${id}-`))).toBe(true);
    } finally {
      removeJudge();
    }
  });

  it('fails and writes nothing when the capture fails', async () => {
    runner.config({ clients: { main: { fail: { capture_screen: 'headless', capture_video: 'x' } } } });
    const before = readdirSync(join(runner.root, 'captures')).length;
    const run = await ogw(runner.ws, ['capture', id]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('capture_screen failed: "headless"');
    expect(readdirSync(join(runner.root, 'captures'))).toHaveLength(before);
    expect(existsSync(join(runner.root, 'captures'))).toBe(true);
  });
});
