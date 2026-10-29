import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { cliToRun } from '../../../src/commands/agent/lib/launch.ts';
import { checkPlayBudget, clearPlayBudget, playBudgetDeps } from '../../../src/commands/agent/lib/play-budget.ts';
import { createContext } from '../../../src/lib/command.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { run } from '../../../src/lib/proc.ts';
import { ogw } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { jobWorkspace } from '../job/helpers.ts';

const saved = { ...playBudgetDeps };
afterEach(() => {
  Object.assign(playBudgetDeps, saved);
});

async function agent(env: NodeJS.ProcessEnv, role: string, name: string, folder: string): Promise<{ key: string; remove: () => void }> {
  const file = join(folder, 'input.json');
  writeFileSync(file, JSON.stringify(role === 'play' ? { instance: 'instp1', playGuide: '/x' } : { A: { instance: 'insta1', playGuide: '/x' }, B: null, fixtures: [] }));
  const key = newAgentKey(name);
  const remove = await fakeAgentJob(env, name, { role, cliPid: 999_999, keyHash: key.hash, input: file, folder });
  return { key: key.value, remove };
}

const BUDGET = 900_000;
const PASSED = 'the play budget of 900 s since the first input has passed: put in no more input and write the result';

describe('play budget', () => {
  it('fails an input or step of a play agent once loop.playBudgetMs passed since its first one, and lets other callers through', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-play-');
    const play = await agent(ws.env, 'play', 'agentplay1', folder);
    const judge = await agent(ws.env, 'judge', 'agentjudge1', folder);
    const ctxOf = (key: string | null) => createContext({ cwd: ws.root, env: key === null ? ws.env : { ...ws.env, OGW_AGENT_KEY: key }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    try {
      let now = 1_000_000;
      playBudgetDeps.now = () => now;
      await checkPlayBudget(ctxOf(play.key));
      now += BUDGET - 1;
      await checkPlayBudget(ctxOf(play.key));
      now += 1;
      await expect(checkPlayBudget(ctxOf(play.key))).rejects.toThrow(PASSED);
      // the commands refuse before they reach the instance
      for (const argv of [['step', 'instp1', '50'], ['input', 'instp1', 'tap', '1', '1']]) {
        expect(await ogw(ws, argv, { env: { ...ws.env, OGW_AGENT_KEY: play.key } })).toMatchObject({ code: 1, stderr: expect.stringContaining(PASSED) as unknown });
      }
      await checkPlayBudget(ctxOf(judge.key));
      await checkPlayBudget(ctxOf(null));
      expect(existsSync(join(await jobsDir(ws.env), 'play-budget', 'agentjudge1'))).toBe(false);
      await clearPlayBudget(ws.env, 'agentplay1');
      // a new first input after the clear
      await checkPlayBudget(ctxOf(play.key));
    } finally {
      play.remove();
      judge.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('notes the first step and refuses later ones from inside the broker sandbox of the play agent', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-play-');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'broker', 's'), folder);
    const play = await agent(ws.env, 'play', 'agentplay2', folder);
    try {
      const command = cli.brokerCommand?.(['step', 'instp1', '50']);
      if (command === undefined) throw new Error('the play agent has no broker command');
      const env = { ...ws.env, TMPDIR: folder, OGW_AGENT_KEY: play.key };
      const first = await run(command.cmd, command.args, { env, timeoutMs: 60_000 });
      // the budget passes; the step fails only because no such instance runs
      expect(`${first.stdout}${first.stderr}`).not.toContain('play budget');
      const file = join(await jobsDir(ws.env), 'play-budget', 'agentplay2');
      expect(existsSync(file)).toBe(true);
      writeFileSync(file, String(Date.now() - BUDGET));
      const later = await run(command.cmd, command.args, { env, timeoutMs: 60_000 });
      expect(`${later.stdout}${later.stderr}`).toContain(PASSED);
      expect(later.code).toBe(1);
    } finally {
      play.remove();
      await rm(cli.profileFolder as string, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
