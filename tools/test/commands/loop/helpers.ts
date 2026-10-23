import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../../../src/lib/fsx.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { jobPaths, type JobRecord } from '../../../src/lib/jobs.ts';
import { changeRuns, listRuns, newRunState, type RunState } from '../../../src/lib/runstate.ts';
import { commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

export const REFERENCE_MD = `## game

Hollow Run

## reason

genre match, recorded on android

## video

hollow.mp4

## moments

| moment | video | start ms | end ms |
|---|---|---|---|
| \`first 30000ms\` | hollow.mp4 | 0 | 30000 |
| \`core action\` | hollow.mp4 | 1000 | 4000 |
| \`first failure\` | none | none | none |
`;

export interface TestGame {
  ws: TestWorkspace;
  root: string;
  repo: GameRepo;
}

/**
 * A workspace with a game that finished `setup game`, and the agent login token in the test secret store, which
 * `ogw loop start` needs while play and judge use Claude Code.
 */
export function setupGame(settingsPatch: Record<string, unknown> = {}, files: Record<string, string | object> = {}): TestGame {
  const ws = makeWorkspace(settingsPatch);
  writeFileSync(ws.env.OGW_TEST_SECRET_FILE as string, JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'token' }));
  const root = makeGame(ws, 'g', {
    'settings.json': { coreVersion: '1.0.0', buildPlatforms: ['android', 'web'], loopIterationLimit: 3 },
    'records/setup/request.md': 'make a runner\n',
    'records/setup/name.md': 'ko: Runner\n',
    'records/setup/art-direction.md': '## style\n\npainted fantasy\n\n## palette\n\n#3a2b1c, #d4a24a\n\n## mood\n\nwarm\n',
    'records/setup/reference/reference.md': REFERENCE_MD,
    'records/setup/reference/hollow.mp4': 'video',
    ...files,
  });
  sh(root, 'git', ['branch', 'id-registry']);
  return { ws, root, repo: { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false } };
}

export function write(root: string, path: string, content: string | object): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

export function readJsonFile(root: string, path: string): unknown {
  return JSON.parse(read(root, path));
}

/** Opens a loop run on a new work branch `loop/<name>` (checked out). */
export async function openLoopRun(g: TestGame, fields: Partial<RunState> = {}): Promise<RunState> {
  const name = fields.name ?? 'update-1';
  const baseCommit = sh(g.root, 'git', ['rev-parse', 'main']).trim();
  sh(g.root, 'git', ['checkout', '--quiet', '-b', `loop/${name}`]);
  const run = newRunState({ name, kind: 'loop', command: 'update', branch: `loop/${name}`, baseCommit, startedAt: 1, ...fields });
  await changeRuns(g.repo, (runs) => {
    runs.push(run);
  });
  return run;
}

export async function openBuildRun(g: TestGame, fields: Partial<RunState> = {}): Promise<RunState> {
  const baseCommit = sh(g.root, 'git', ['rev-parse', 'main']).trim();
  sh(g.root, 'git', ['checkout', '--quiet', '-b', 'build/stg-0.2.0']);
  const run = newRunState({
    name: 'build-stg-0.2.0',
    kind: 'build',
    env: 'STG',
    version: '0.2.0',
    branch: 'build/stg-0.2.0',
    baseCommit,
    startedAt: 1,
    ...fields,
  });
  await changeRuns(g.repo, (runs) => {
    runs.push(run);
  });
  return run;
}

export async function currentRun(g: TestGame): Promise<RunState> {
  const runs = await listRuns(g.repo);
  return runs[runs.length - 1] as RunState;
}

export async function setRun(g: TestGame, change: (run: RunState) => void): Promise<void> {
  await changeRuns(g.repo, (runs) => {
    change(runs[runs.length - 1] as RunState);
  });
}

let jobCounter = 0;

/** Writes a job record without a supervisor. */
export async function addJob(ws: TestWorkspace, fields: Partial<JobRecord> & { meta?: Record<string, unknown> }): Promise<JobRecord> {
  jobCounter++;
  const job: JobRecord = {
    id: `job${String(jobCounter)}x`,
    argv: [],
    cwd: ws.root,
    command: 'agent',
    game: 'g',
    startedAt: 10 + jobCounter,
    endedAt: null,
    status: 'running',
    exitCode: null,
    supervisorPid: null,
    pid: null,
    timeLimitMs: 1000,
    agentJob: null,
    summary: null,
    meta: {},
    ...fields,
  };
  await writeJsonAtomic((await jobPaths(job.id, ws.env)).record, job);
  return job;
}

export function commit(root: string, message = 'c'): string {
  return commitAll(root, message);
}

export function git(root: string, ...args: string[]): string {
  return sh(root, 'git', args).trim();
}
