import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { cliToRun } from '../../../src/commands/agent/lib/launch.ts';
import { writePlayAccess } from '../../../src/commands/instance/lib/records.ts';
import { noteUnstarted } from '../../../src/commands/instance/lib/unstarted.ts';
import { waitDeps } from '../../../src/commands/instance/wait.ts';
import { createContext } from '../../../src/lib/command.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { run } from '../../../src/lib/proc.ts';
import { ogw } from '../../helpers/workspace.ts';
import { jobWorkspace } from '../job/helpers.ts';
import { fakeAgentJob } from './agents.ts';

const JUDGE_INPUT = { A: { instance: 'insta1', playGuide: '/x' }, B: { instance: 'instb1', playGuide: '/y' }, fixtures: [{ moment: { name: 'm' }, A: 'instfa1', B: 'instfb1' }] };

async function agent(env: NodeJS.ProcessEnv, role: string, input: unknown, name: string, folder: string): Promise<{ key: string; remove: () => void }> {
  const file = join(folder, 'input.json');
  writeFileSync(file, JSON.stringify(input));
  const key = newAgentKey(name);
  const remove = await fakeAgentJob(env, name, { role, cliPid: 999_999, keyHash: key.hash, input: file, folder });
  return { key: key.value, remove };
}

function access(id: string): Parameters<typeof writePlayAccess>[0] {
  return { id, port: 1, token: 't', clients: ['main'], commandTimeoutMs: 1, videoMaxMs: null, feedbackWindowMs: null, targetFps: null, inputLatencyMs: 0 };
}

const saved = { ...waitDeps };
afterEach(() => {
  Object.assign(waitDeps, saved);
});

describe('ogw instance wait', () => {
  it('prints ready once the instance runs, exit 75 while it starts, and the reason when it was not started', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge1', folder);
    const env = { ...ws.env, OGW_AGENT_KEY: judge.key };
    waitDeps.waitMs = 0;
    try {
      await writePlayAccess(access('insta1'), ws.env);
      expect(await ogw(ws, ['instance', 'wait', 'insta1'], { env })).toMatchObject({ code: 0, stdout: 'ready insta1\n' });
      const starting = await ogw(ws, ['instance', 'wait', 'instfa1'], { env });
      expect(starting).toMatchObject({ code: 75, stdout: 'instance instfa1 is still starting: run ogw instance wait instfa1 again\n' });
      await noteUnstarted(ws.env, 'agentjudge1', 'instfb1', 'its save fixture step failed');
      const failed = await ogw(ws, ['instance', 'wait', 'instfb1'], { env });
      expect(failed).toMatchObject({ code: 1, stdout: 'instance instfb1 was not started (its save fixture step failed): it is not put in\n' });
    } finally {
      judge.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses an instance not in the input, a play agent and any other caller', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge2', folder);
    const play = await agent(ws.env, 'play', { instance: 'instp1', playGuide: '/x' }, 'agentplay2', folder);
    try {
      const foreign = await ogw(ws, ['instance', 'wait', 'instx1'], { env: { ...ws.env, OGW_AGENT_KEY: judge.key } });
      expect(foreign.code).toBe(1);
      expect(foreign.stderr).toContain('instance instx1 is not an instance of the input of this agent');
      for (const env of [{ ...ws.env, OGW_AGENT_KEY: play.key }, ws.env]) {
        const refused = await ogw(ws, ['instance', 'wait', 'instp1'], { env });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('ogw instance wait is run by a judge agent');
      }
    } finally {
      judge.remove();
      play.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('reads the play access file and the note from inside the broker sandbox of the judge agent', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'broker', 's'), folder);
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge3', folder);
    try {
      await writePlayAccess(access('instb1'), ws.env);
      await noteUnstarted(ws.env, 'agentjudge3', 'instfa1', 'its save fixture step failed');
      const env = { ...ws.env, TMPDIR: folder, OGW_AGENT_KEY: judge.key };
      const runIn = async (id: string): Promise<{ out: string; code: number | null }> => {
        const command = cli.brokerCommand?.(['instance', 'wait', id]);
        if (command === undefined) throw new Error('the judge has no broker command');
        const result = await run(command.cmd, command.args, { env, timeoutMs: 60_000 });
        return { out: `${result.stdout}${result.stderr}`, code: result.code };
      };
      expect(await runIn('instb1')).toEqual({ out: 'ready instb1\n', code: 0 });
      expect(await runIn('instfa1')).toEqual({ out: 'instance instfa1 was not started (its save fixture step failed): it is not put in\n', code: 1 });
    } finally {
      judge.remove();
      await rm(cli.profileFolder as string, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
