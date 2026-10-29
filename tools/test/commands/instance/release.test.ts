import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { cliToRun } from '../../../src/commands/agent/lib/launch.ts';
import { createContext } from '../../../src/lib/command.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { run } from '../../../src/lib/proc.ts';
import { ogw } from '../../helpers/workspace.ts';
import { jobWorkspace } from '../job/helpers.ts';
import { fakeAgentJob } from './agents.ts';

const JUDGE_INPUT = { A: { instance: 'insta1', playGuide: '/x' }, B: { instance: 'instb1', playGuide: '/y' }, fixtures: [{ moment: { name: 'm' }, A: 'instfa1', B: null }] };

/** A fake running agent of `role` whose input file in `folder` holds `input`; its key and a remover. */
async function agent(env: NodeJS.ProcessEnv, role: string, input: unknown, name: string, folder: string): Promise<{ key: string; remove: () => void }> {
  const file = join(folder, 'input.json');
  writeFileSync(file, JSON.stringify(input));
  const key = newAgentKey(name);
  const remove = await fakeAgentJob(env, name, { role, cliPid: 999_999, keyHash: key.hash, input: file, folder });
  return { key: key.value, remove };
}

function requests(jobs: string, name: string): string[] {
  const dir = join(jobs, 'instance-releases', name);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('ogw instance release', () => {
  it('leaves a request for each instance of the input of the judge agent that runs it, A, B or a fixture', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge1', folder);
    try {
      for (const id of ['instfa1', 'insta1', 'instb1']) {
        expect(await ogw(ws, ['instance', 'release', id], { env: { ...ws.env, OGW_AGENT_KEY: judge.key } })).toMatchObject({ code: 0, stdout: `released ${id}\n` });
      }
      expect(requests(ws.jobs, 'agentjudge1')).toEqual(['insta1', 'instb1', 'instfa1']);
    } finally {
      judge.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses an instance not in the input, a play agent, any other caller, and leaves no request', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge2', folder);
    const play = await agent(ws.env, 'play', { instance: 'instp1', playGuide: '/x' }, 'agentplay2', folder);
    try {
      const foreign = await ogw(ws, ['instance', 'release', 'instx1'], { env: { ...ws.env, OGW_AGENT_KEY: judge.key } });
      expect(foreign.code).not.toBe(0);
      expect(foreign.stderr).toContain('instance instx1 is not an instance of the input of this agent');
      for (const env of [{ ...ws.env, OGW_AGENT_KEY: play.key }, ws.env]) {
        const refused = await ogw(ws, ['instance', 'release', 'instp1'], { env });
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain('ogw instance release is run by a judge agent');
      }
      expect(requests(ws.jobs, 'agentjudge2')).toEqual([]);
      expect(requests(ws.jobs, 'agentplay2')).toEqual([]);
    } finally {
      judge.remove();
      play.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('leaves its request from inside the broker sandbox of the judge agent', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'broker', 's'), folder);
    const judge = await agent(ws.env, 'judge', JUDGE_INPUT, 'agentjudge3', folder);
    try {
      const command = cli.brokerCommand?.(['instance', 'release', 'instb1']);
      if (command === undefined) throw new Error('the judge has no broker command');
      // the broker runs it with the environment of the agent job and the agent key, not through the broker socket
      const result = await run(command.cmd, command.args, { env: { ...ws.env, TMPDIR: folder, OGW_AGENT_KEY: judge.key }, timeoutMs: 60_000 });
      expect(`${result.stdout}${result.stderr}`).toBe('released instb1\n');
      expect(result.code).toBe(0);
      expect(requests(ws.jobs, 'agentjudge3')).toEqual(['instb1']);
    } finally {
      judge.remove();
      await rm(cli.profileFolder as string, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
