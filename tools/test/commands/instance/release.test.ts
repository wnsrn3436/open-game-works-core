import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordPath } from '../../../src/commands/instance/lib/records.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { ogw } from '../../helpers/workspace.ts';
import { fakeAgentJob } from './agents.ts';
import { setupRunner, startFor, stopAll, type Runner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('./mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('./mocks/apis.ts')).launchOverrides(real) };
});

let runner: Runner;

beforeAll(() => {
  runner = setupRunner();
});

afterAll(async () => {
  await stopAll(runner);
});

/** Runs `ogw instance release <id>` as a fake running agent of `role` whose input file holds `input`. */
async function releaseAs(role: string, input: unknown, id: string, name: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = join(runner.ws.root, `${name}-input.json`);
  writeFileSync(file, JSON.stringify(input));
  const key = newAgentKey(name);
  const remove = await fakeAgentJob(runner.ws.env, name, { role, cliPid: 999_999, keyHash: key.hash, input: file });
  try {
    return await ogw(runner.ws, ['instance', 'release', id], { env: { ...runner.ws.env, OGW_AGENT_KEY: key.value } });
  } finally {
    remove();
  }
}

describe('ogw instance release', () => {
  it('stops an instance of the input of the judge agent that runs it, A, B or a fixture instance', async () => {
    const [a, b, fixture] = [await startFor(runner), await startFor(runner), await startFor(runner)];
    const input = { A: { instance: a, playGuide: '/x' }, B: { instance: b, playGuide: '/y' }, fixtures: [{ moment: { name: 'm' }, A: fixture, B: null }] };
    for (const id of [fixture, a, b]) {
      const run = await releaseAs('judge', input, id, `agentjudge${id.slice(-4)}`);
      expect(run).toMatchObject({ code: 0, stdout: `released ${id}\n` });
      expect(existsSync(await recordPath(id, runner.ws.env))).toBe(false);
    }
  });

  it('stops the instance of the input of a play agent', async () => {
    const id = await startFor(runner);
    expect(await releaseAs('play', { instance: id, playGuide: '/x' }, id, 'agentplay1')).toMatchObject({ code: 0 });
    expect(existsSync(await recordPath(id, runner.ws.env))).toBe(false);
  });

  it('refuses an instance not in the input, a caller that is no play or judge agent, and no agent at all', async () => {
    const own = await startFor(runner);
    const other = await startFor(runner);
    const foreign = await releaseAs('judge', { A: { instance: own, playGuide: '/x' }, B: null, fixtures: [] }, other, 'agentjudge9');
    expect(foreign.code).not.toBe(0);
    expect(foreign.stderr).toContain(`instance ${other} is not an instance of the input of this agent`);
    const content = await releaseAs('content', { instance: other }, other, 'agentcontent1');
    expect(content.code).not.toBe(0);
    expect(content.stderr).toContain('ogw instance release is run by a play or judge agent');
    const none = await ogw(runner.ws, ['instance', 'release', other]);
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('ogw instance release is run by a play or judge agent');
    expect(existsSync(await recordPath(other, runner.ws.env))).toBe(true);
    expect(existsSync(await recordPath(own, runner.ws.env))).toBe(true);
  });
});
