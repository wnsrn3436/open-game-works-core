import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { brokerBudgetRefusal } from '../../../src/commands/agent/lib/broker-budget.ts';
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
      // the release of a held input still goes in
      await checkPlayBudget(ctxOf(play.key), ['key_up', 'a']);
      await checkPlayBudget(ctxOf(play.key), ['pad_axis', 'left_x', '0']);
      await expect(checkPlayBudget(ctxOf(play.key), ['pad_axis', 'left_x', '0.5'])).rejects.toThrow(PASSED);
      expect(await ogw(ws, ['input', 'instp1', 'touch_up', '1', '1'], { env: { ...ws.env, OGW_AGENT_KEY: play.key } })).toMatchObject({ code: 1, stderr: expect.not.stringContaining('play budget') as unknown });
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

  it.runIf(process.platform === 'darwin')('notes no step that is not put in and refuses one past the budget from inside the broker sandbox of the play agent', async () => {
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
      // the budget passes; the step fails because no such instance runs, so it puts in nothing and notes no budget
      expect(`${first.stdout}${first.stderr}`).not.toContain('play budget');
      const file = join(await jobsDir(ws.env), 'play-budget', 'agentplay2');
      expect(existsSync(file)).toBe(false);
      mkdirSync(join(file, '..'), { recursive: true });
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

describe('judge play budget', () => {
  it('fails an input or step of a judge on an instance once loop.judgeInstanceBudgetMs passed since its first one there', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', 'agentjudge2', folder);
    const ctx = createContext({ cwd: ws.root, env: { ...ws.env, OGW_AGENT_KEY: judge.key }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const budget = (await ctx.settings()).loop.judgeInstanceBudgetMs;
    const passed = `the play budget of ${String(Math.round(budget / 1000))} s of instance insta has passed: put in no more input on it`;
    try {
      let now = 1_000_000;
      playBudgetDeps.now = () => now;
      await checkPlayBudget(ctx, undefined, 'insta');
      now += budget - 1;
      await checkPlayBudget(ctx, undefined, 'insta');
      now += 1;
      await expect(checkPlayBudget(ctx, undefined, 'insta')).rejects.toThrow(passed);
      await expect(checkPlayBudget(ctx, ['tap', '1', '1'], 'insta')).rejects.toThrow(passed);
      // a held input can still be released, and another instance has its own budget
      await checkPlayBudget(ctx, ['key_up', 'a'], 'insta');
      await checkPlayBudget(ctx, undefined, 'instb');
      await clearPlayBudget(ws.env, 'agentjudge2');
      await checkPlayBudget(ctx, undefined, 'insta');
    } finally {
      judge.remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  /** A judge agent with a fake clock, for one test. */
  async function judgeAt(name: string, test: (judge: { ctx: ReturnType<typeof createContext>; env: NodeJS.ProcessEnv; ws: ReturnType<typeof jobWorkspace>; folder: string; budget: number; passed: (instance: string) => string; pass: () => void }) => Promise<void>): Promise<void> {
    const ws = jobWorkspace();
    const tmp = await newTempFolder('ogw-judge-');
    const judge = await agent(ws.env, 'judge', name, tmp);
    const env = { ...ws.env, OGW_AGENT_KEY: judge.key };
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const budget = (await ctx.settings()).loop.judgeInstanceBudgetMs;
    let now = 1_000_000;
    playBudgetDeps.now = () => now;
    try {
      await test({
        ctx,
        env,
        ws,
        folder: join(await jobsDir(ws.env), 'play-budget', `judge-${name}`),
        budget,
        passed: (instance) => `the play budget of ${String(Math.round(budget / 1000))} s of instance ${instance} has passed: put in no more input on it`,
        pass: () => {
          now += budget;
        },
      });
    } finally {
      judge.remove();
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it('refuses a name that is no instance id and writes nothing, from the broker and in the command', async () => {
    await judgeAt('agentjudge3', async ({ ctx, ws, env, folder }) => {
      const jobs = await jobsDir(ws.env);
      for (const name of ['../../escaped/made', '../../instance-releases/otherjob/instz', join(ws.root, 'outside', 'made'), '', '.']) {
        await expect(checkPlayBudget(ctx, undefined, name)).rejects.toThrow(`invalid instance id: ${name}`);
        expect(await brokerBudgetRefusal(ctx, ['step', name, '50'])).toBe(`invalid instance id: ${name}`);
        expect(await brokerBudgetRefusal(ctx, ['input', name, 'tap', '1', '1'])).toBe(`invalid instance id: ${name}`);
        expect((await ogw(ws, ['step', name, '50'], { env })).stderr).toContain(`invalid instance id: ${name}`);
      }
      expect(existsSync(join(jobs, 'escaped'))).toBe(false);
      expect(existsSync(join(jobs, 'instance-releases'))).toBe(false);
      expect(existsSync(join(ws.root, 'outside'))).toBe(false);
      expect(existsSync(folder)).toBe(false);
    });
  });

  it('reads the instance of a forwarded call as the command does', async () => {
    await judgeAt('agentjudge4', async ({ ctx, folder, passed, pass }) => {
      // the broker only reads a noted budget: the command notes it
      expect(await brokerBudgetRefusal(ctx, ['step', '--count', '6', 'insta', '50'])).toBeNull();
      expect(existsSync(folder)).toBe(false);
      await checkPlayBudget(ctx, undefined, 'insta');
      expect(await brokerBudgetRefusal(ctx, ['input', '--script=a.json', 'instb'])).toBeNull();
      pass();
      // the first step on another instance, with the same option before it
      expect(await brokerBudgetRefusal(ctx, ['step', '--count', '6', 'instb', '50'])).toBeNull();
      expect(await brokerBudgetRefusal(ctx, ['step', '--count', '6', 'insta', '50'])).toBe(passed('insta'));
      expect(await brokerBudgetRefusal(ctx, ['step', '--json', '--state', 'insta', '50'])).toBe(passed('insta'));
      expect(await brokerBudgetRefusal(ctx, ['input', '--json', 'insta', 'tap', '1', '1'])).toBe(passed('insta'));
      expect(await brokerBudgetRefusal(ctx, ['input', 'insta', 'key_up', 'a'])).toBeNull();
      // what does not parse is the command's to refuse, and the help is no input
      expect(await brokerBudgetRefusal(ctx, ['step', '--nope', 'insta', '50'])).toBeNull();
      expect(await brokerBudgetRefusal(ctx, ['step', 'insta', '50', '--help'])).toBeNull();
      expect(await brokerBudgetRefusal(ctx, ['capture', 'insta'])).toBeNull();
      expect(readdirSync(folder)).toEqual(['insta']);
    });
  });

  it('notes no budget for a call that puts in no input or step, in the command and from the broker', async () => {
    await judgeAt('agentjudge8', async ({ ctx, ws, env, folder }) => {
      for (const argv of [['input', 'insta', 'nosuchcommand'], ['input', 'insta'], ['input', 'insta', 'tap', '1', '1', '--video'], ['step', 'insta', '0'], ['step', 'insta', '50']]) {
        expect(await brokerBudgetRefusal(ctx, argv)).toBeNull();
        expect((await ogw(ws, argv, { env })).code).not.toBe(0);
      }
      const run = await ogw(ws, ['step', 'insta', '50', '--stream'], { env, stdin: 'input nosuchcommand\nstep\n' });
      expect(run.stdout.trimEnd().split('\n').map((line) => (JSON.parse(line) as { exit: number }).exit)).toEqual([1, 1]);
      expect(existsSync(folder)).toBe(false);
    });
    const ws = jobWorkspace();
    const tmp = await newTempFolder('ogw-play-');
    const play = await agent(ws.env, 'play', 'agentplay4', tmp);
    try {
      expect((await ogw(ws, ['input', 'instp1', 'not_a_command'], { env: { ...ws.env, OGW_AGENT_KEY: play.key } })).code).not.toBe(0);
      expect(existsSync(join(await jobsDir(ws.env), 'play-budget', 'agentplay4'))).toBe(false);
    } finally {
      play.remove();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('neither starts nor refuses a stream when it opens: only its lines go through the budget', async () => {
    await judgeAt('agentjudge5', async ({ ctx, folder, pass, passed, ws, env }) => {
      const open = ['step', 'insta', '50', '--stream'];
      expect(await brokerBudgetRefusal(ctx, open)).toBeNull();
      expect(existsSync(folder)).toBe(false);
      await checkPlayBudget(ctx, undefined, 'insta');
      pass();
      expect(await brokerBudgetRefusal(ctx, open)).toBeNull();
      const run = await ogw(ws, open, { env, stdin: 'step\ninput tap 1 1\ninput key_up a\n' });
      const lines = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { exit: number; error: string });
      expect(lines.slice(0, 2)).toEqual([{ exit: 1, error: passed('insta') }, { exit: 1, error: passed('insta') }]);
      expect(lines[2]?.error).toContain('insta is not running');
    });
    // a play agent the same way
    const ws = jobWorkspace();
    const tmp = await newTempFolder('ogw-play-');
    const play = await agent(ws.env, 'play', 'agentplay3', tmp);
    const ctx = createContext({ cwd: ws.root, env: { ...ws.env, OGW_AGENT_KEY: play.key }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    try {
      expect(await brokerBudgetRefusal(ctx, ['step', 'instp1', '50', '--stream'])).toBeNull();
      expect(existsSync(join(await jobsDir(ws.env), 'play-budget', 'agentplay3'))).toBe(false);
    } finally {
      play.remove();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses ogw step and ogw input past the budget of that instance only, and lets a release through', async () => {
    await judgeAt('agentjudge6', async ({ ctx, ws, env, passed, pass }) => {
      await checkPlayBudget(ctx, undefined, 'insta');
      pass();
      for (const argv of [['step', 'insta', '50'], ['step', '--count', '2', 'insta', '50'], ['input', 'insta', 'tap', '1', '1']]) {
        expect(await ogw(ws, argv, { env })).toMatchObject({ code: 1, stderr: expect.stringContaining(passed('insta')) as unknown });
      }
      for (const argv of [['input', 'insta', 'key_up', 'a'], ['step', 'instb', '50'], ['input', 'instb', 'tap', '1', '1']]) {
        expect(await ogw(ws, argv, { env })).toMatchObject({ code: 1, stderr: expect.not.stringContaining('play budget') as unknown });
      }
    });
  });

  it('reads a budget file without a time as no time', async () => {
    await judgeAt('agentjudge7', async ({ ctx, folder }) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'insta'), '');
      await checkPlayBudget(ctx, undefined, 'insta');
    });
  });
});
