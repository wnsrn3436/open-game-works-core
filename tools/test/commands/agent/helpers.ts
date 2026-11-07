import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gameSecretService } from '../../../src/lib/secrets.ts';
import { newRunState, changeRuns, type RunState } from '../../../src/lib/runstate.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { commonDir } from '../../../src/lib/git.ts';
import { RUN_LOG_FOLDER, runLogPath } from '../../../src/lib/agentctx.ts';
import { ogw, makeGame, sh, type TestWorkspace } from '../../helpers/workspace.ts';

export { gameSecretService };

export interface FakeCall {
  argv: string[];
  cwd: string;
  prompt: string;
  pid: number;
}

/**
 * Fake `claude` and `codex` on PATH. Each call records argv, cwd and prompt, then runs `behavior`, JavaScript
 * with `prompt`, `output`, `input` (from the prompt's `## ogw agent` lines), `runLog` (the run log of the agent job,
 * from its `OGW_AGENT_KEY`) and `fs` in scope.
 */
export function fakeAgentCli(ws: TestWorkspace, behavior: string): { env: NodeJS.ProcessEnv; calls: () => FakeCall[] } {
  const bin = join(ws.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const record = join(ws.root, 'fake-calls.jsonl');
  writeFileSync(record, '');
  writeFileSync(
    join(bin, 'fake.mjs'),
    [
      "import * as fs from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "const field = (n) => (new RegExp('^- ' + n + ': (.*)$', 'm').exec(prompt) || [])[1];",
      // a fix round prompt has no `## ogw agent` lines: the paths are those of the job, as the agent knows them
      `const jobMeta = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(join(ws.harness, '.git', 'ogw-jobs'))} + '/' + String(process.env.OGW_AGENT_KEY).split('.')[0] + '.json', 'utf8')).meta; } catch { return {}; } };`,
      "const output = field('output') ?? jobMeta().output; const input = field('input') ?? jobMeta().agentInput;",
      "const fixRound = prompt.startsWith('The result file '); void fixRound;",
      `const runLog = ${JSON.stringify(join(ws.harness, '.git', 'ogw-jobs', RUN_LOG_FOLDER))} + '/' + String(process.env.OGW_AGENT_KEY).split('.')[0] + '.json';`,
      `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, pid: process.pid }) + '\\n');`,
      'void execFileSync; void runLog;',
      behavior,
    ].join('\n'),
  );
  for (const name of ['claude', 'codex']) {
    const script = join(bin, name);
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake.mjs')}" "$@"\n`);
    chmodSync(script, 0o755);
  }
  return {
    env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    calls: () =>
      readFileSync(record, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeCall),
  };
}

/**
 * A result file in the format of every role with a result format check whose input asks for no table of it (ogw.md
 * `### result format` of `## agent`): the sections those checks read, each `none`, and `- moment: none`.
 */
export const RESULT = [
  '## hypothesis', '', '- moment: none', '',
  ...['defects', 'content agent fixes', 'observations', 'findings', 'previous', 'out of scope', 'debt', 'must fix', 'unknown'].flatMap((heading) => [`## ${heading}`, '', 'none', '']),
].join('\n');

/** Behavior: write `RESULT` to the output file. */
export const WRITE_OUTPUT = `fs.writeFileSync(output, ${JSON.stringify(RESULT)});`;

/** A game repo on branch `loop/r1` with an open loop run `r1` at `iteration`. */
export async function gameWithRun(
  ws: TestWorkspace,
  files: Record<string, string | object> = {},
  run: Partial<RunState> = {},
): Promise<{ root: string; game: GameRepo }> {
  const root = makeGame(ws, 'g', { 'settings.json': {}, ...files });
  sh(root, 'git', ['checkout', '--quiet', '-b', run.branch ?? 'loop/r1']);
  const game: GameRepo = { name: 'g', root, mainRoot: root, commonDir: await commonDir(root), inWorktree: false };
  const base = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
  await changeRuns(game, (runs) => {
    runs.push(newRunState({ name: 'r1', kind: 'loop', branch: 'loop/r1', baseCommit: base, iteration: 1, ...run }));
  });
  return { root, game };
}

/** Starts an agent in the background and waits for it; returns the job id and the wait run. */
export async function runAgent(ws: TestWorkspace, argv: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const started = await ogw(ws, ['agent', ...argv, '--background'], { env, ...(cwd ? { cwd } : {}) });
  if (started.code !== 0) return { id: '', started, waited: started };
  const id = started.stdout.trim();
  const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env });
  return { id, started, waited };
}

/** Fake agent CLI behavior: writes a run log whose last `ogw core test` passed, which `ogw agent merge` needs. */
export const CORE_TEST_PASSED =
  "fs.writeFileSync(runLog, JSON.stringify({ runs: [{ command: 'ogw core test server', startedAt: 1, exitCode: 0, summary: { tests: 1, passed: 1 } }] }));";

/** The run log of agent job `id`. */
export async function readRunLog(ws: TestWorkspace, id: string): Promise<unknown> {
  return JSON.parse(readFileSync(await runLogPath(id, ws.env), 'utf8')) as unknown;
}

/** The `usage` of a job whose agent CLI printed no usage (ogw.md `### usage` of `## agent`). */
export function noUsage(model: string, effort: string, cli: 'claude-code' | 'codex' = 'claude-code'): object {
  return { cli, model, effort, inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, turns: null };
}
