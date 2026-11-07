/** The `ogw regress` commands of the human command `regress harness` (ogw.md `## regress`). */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { expectPositionals, flag, list, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJson, readJsonIfExists, writeJsonAtomic } from '../../lib/fsx.ts';
import { git, gitLine, head, revParse, statusLines, tagExists } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { harnessCoreVersion } from '../core/lib/harness-core.ts';
import { parseValue } from '../settings/set.ts';
import { makeCopyRepo } from './lib/copy.ts';
import { baseTag, refresh } from './lib/refresh.ts';
import {
  ACCEPTED_FILE,
  admissionPath,
  commitRegress,
  listSeeds,
  readAccepted,
  readAdmission,
  readManifest,
  readStates,
  regressRepo,
  SEEDS_DIR,
  seedDir,
  STATES_FILE,
  stateGame,
  withRegressLock,
  writeStates,
  type Accepted,
  type StateEntry,
} from './lib/repo.ts';
import { totalsLines, type RunData } from './lib/report.ts';
import { parseAgentOverride, regressRun } from './lib/run.ts';
import { harnessSide, type SideSpec } from './lib/side.ts';

/** The core version of the harness, which `refresh`, `seed` and `status` work at; fails without a `core-v` tag. */
async function harnessVersion(ctx: Context): Promise<string> {
  const version = await harnessCoreVersion(ctx);
  if (version === null) throw new OgwError('the harness repo HEAD contains no core-v<version> tag: there is no core version to refresh the states to');
  return version;
}

/** Makes regression state `state` from `commit` of `game` (ogw.md `### regression state`); returns its entry. */
async function makeState(ctx: Context, state: string, game: string, commit: string): Promise<StateEntry> {
  const source = join((await ctx.workspace()).games, game);
  if (!exists(join(source, '.git'))) throw new OgwError(`game repo not found: ${source}`);
  const sha = await gitLine(source, ['rev-parse', '--verify', `${commit}^{commit}`], { env: ctx.env });
  const registry = await revParse(source, 'refs/heads/id-registry', { env: ctx.env });
  await makeCopyRepo(ctx, stateGame(state), { repo: source, commit: sha, registry }, { kind: 'state', state }, `regression state ${state} from ${game} ${sha}`);
  return { state, game, commit: sha };
}

const STATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const initCommand: CommandDef = {
  name: ['regress', 'init'],
  usage: 'ogw regress init',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const ws = await ctx.workspace();
    if (exists(ws.regress)) throw new OgwError(`${ws.regress} exists: the regress repo is made once`);
    const bootstrap = join(ws.harness, 'regress');
    const states = await readJson<StateEntry[]>(join(bootstrap, STATES_FILE));
    await mkdir(ws.regress, { recursive: true });
    const made: string[] = [];
    try {
      await git(ws.regress, ['init', '--quiet', '--initial-branch', 'main'], { env: ctx.env });
      if (exists(join(bootstrap, SEEDS_DIR))) await cp(join(bootstrap, SEEDS_DIR), join(ws.regress, SEEDS_DIR), { recursive: true });
      for (const seed of await listSeeds(ws.regress)) if (!states.some((s) => s.state === seed.manifest.state)) throw new OgwError(`seed ${seed.id}: state ${seed.manifest.state} is not in ${join(bootstrap, STATES_FILE)}`);
      const entries: StateEntry[] = [];
      for (const entry of states) {
        entries.push({ ...(await makeState(ctx, entry.state, entry.game, entry.commit)), ...(entry.settings === undefined ? {} : { settings: entry.settings }) });
        made.push(stateGame(entry.state));
      }
      await writeStates(ws.regress, entries);
      await commitRegress(ctx, ws.regress, [STATES_FILE, ...(exists(join(ws.regress, SEEDS_DIR)) ? [SEEDS_DIR] : [])], 'regress init');
      const seeds = await listSeeds(ws.regress);
      const text = [`regress repo: ${ws.regress}`, ...entries.map((e) => `state ${e.state}: ${stateGame(e.state)} from ${e.game} ${e.commit}`), `seeds: ${seeds.map((s) => s.id).join(', ')}`, 'next: ogw regress refresh --background'];
      return { text: text.join('\n'), data: { repo: ws.regress, states: entries, seeds: seeds.map((s) => s.id) } };
    } catch (error) {
      // nothing half made stays: the regress repo and the states made so far go
      await rm(ws.regress, { recursive: true, force: true });
      for (const game of made) await rm(join(ws.games, game), { recursive: true, force: true });
      throw error;
    }
  },
};

export const stateCommand: CommandDef = {
  name: ['regress', 'state'],
  usage: 'ogw regress state <state> --game <game> --commit <sha>',
  options: { game: { type: 'string' }, commit: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const state = positional(args, 0, 'state');
    const game = str(args, 'game');
    const commit = str(args, 'commit');
    if (game === undefined || commit === undefined) throw new OgwError(`usage: ${this.usage}`);
    if (!STATE_NAME.test(state) || /^fix-\d+$/.test(state)) throw new OgwError(`a state name is kebab-case and not fix-<n>, the name of a fix repo: ${state}`);
    const repo = await regressRepo(ctx);
    return withRegressLock(ctx, repo, async () => {
      const states = await readStates(repo);
      if (states.some((s) => s.state === state)) throw new OgwError(`state ${state} is in ${STATES_FILE}`);
      const entry = await makeState(ctx, state, game, commit);
      await writeStates(repo, [...states, entry]);
      await commitRegress(ctx, repo, [STATES_FILE], `regress state ${state}`);
      return { text: `state ${state}: ${stateGame(state)} from ${game} ${entry.commit}`, data: entry };
    });
  },
};

export const settingsCommand: CommandDef = {
  name: ['regress', 'settings'],
  usage: 'ogw regress settings <state> <path> <JSON value> [<path> <JSON value>]...',
  async run(ctx, args) {
    const [state, ...rest] = args.positionals;
    if (state === undefined || rest.length < 2 || rest.length % 2 !== 0) throw new OgwError(`usage: ${this.usage}`);
    const pairs: [string, unknown][] = [];
    for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i] as string, parseValue(rest[i + 1] as string)]);
    const repo = await regressRepo(ctx);
    return withRegressLock(ctx, repo, async () => {
      const states = await readStates(repo);
      const entry = states.find((s) => s.state === state);
      if (entry === undefined) throw new OgwError(`state ${state} is not in ${STATES_FILE}`);
      const settings = { ...entry.settings, ...Object.fromEntries(pairs) };
      await writeStates(repo, states.map((s) => (s === entry ? { ...s, settings } : s)));
      await commitRegress(ctx, repo, [STATES_FILE], `regress settings ${state}`);
      return { text: pairs.map(([path]) => `set ${path}`).join('\n'), data: { state, settings } };
    });
  },
};

async function stateLines(ctx: Context, repo: string, games: string, version: string | null): Promise<string[]> {
  const lines: string[] = [];
  for (const s of await readStates(repo)) {
    const root = join(games, stateGame(s.state));
    const tag = version === null ? null : baseTag(version);
    const tagged = tag !== null && exists(root) && (await tagExists(root, tag, { env: ctx.env }));
    lines.push(`state ${s.state}: ${tagged ? tag : 'none'}`);
  }
  return lines;
}

async function seedLines(repo: string, version: string | null): Promise<string[]> {
  const lines: string[] = [];
  for (const seed of await listSeeds(repo)) {
    const admission = version === null ? null : await readAdmission(repo, seed.id, version);
    const text = admission === null ? 'not admitted' : admission.result === 'admitted' ? 'admitted' : `stale (${admission.reason ?? ''})`;
    lines.push(`seed ${seed.id}: ${text}`);
  }
  return lines;
}

/** The accepted harness and the last run with its `## totals`. */
async function lastRunLines(repo: string): Promise<string[]> {
  const accepted = await readAccepted(repo);
  const lines = [`accepted: ${accepted === null ? 'none' : `${accepted.commit} (run ${accepted.run})`}`];
  const folder = join(repo, 'records', 'runs');
  const runs = exists(folder) ? (await readdir(folder)).filter((n) => /^\d+$/.test(n)).sort() : [];
  const last = runs.at(-1);
  const data = last === undefined ? null : await readJsonIfExists<RunData>(join(folder, last, 'run.json'));
  if (data === null || last === undefined) return [...lines, 'last run: none'];
  return [...lines, `last run: ${last}${data.catchOnly ? ' (catch only)' : ''}`, ...(data.catchOnly ? [] : totalsLines(data))];
}

export const statusCommand: CommandDef = {
  name: ['regress', 'status'],
  usage: 'ogw regress status',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const ws = await ctx.workspace();
    if (!exists(join(ws.regress, '.git'))) return { text: `regress repo: none (${ws.regress}): run ogw regress init`, data: { repo: null } };
    const version = await harnessCoreVersion(ctx);
    const lines = [
      `regress repo: ${ws.regress}`,
      `harness core version: ${version ?? 'none'}`,
      ...(await stateLines(ctx, ws.regress, ws.games, version)),
      ...(await seedLines(ws.regress, version)),
      ...(await lastRunLines(ws.regress)),
    ];
    return { text: lines.join('\n'), data: { repo: ws.regress, version, lines } };
  },
};

export const refreshCommand: CommandDef = {
  name: ['regress', 'refresh'],
  usage: 'ogw regress refresh [--background]',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const repo = await regressRepo(ctx);
    const version = await harnessVersion(ctx);
    return withRegressLock(ctx, repo, async () => {
      const self = harnessSide(await head((await ctx.workspace()).harness, { env: ctx.env }));
      const done = await refresh(ctx, repo, self, version, await listSeeds(repo), null);
      await commitRegress(ctx, repo, done.paths, `regress refresh ${version}`);
      const lines = [
        ...done.states.map((s) => `state ${s.state}: ${s.tag ?? `no ${baseTag(version)} (${s.settings}; ${s.upgrade}; ${s.content}; ${s.checks})`}`),
        ...done.seeds.map((s) => `seed ${s.seed}: ${s.admission.result}${s.admission.reason === null ? '' : ` (${s.admission.reason})`}`),
        `record: ${join(repo, 'records', `refresh-${version}.md`)}`,
      ];
      const failed = done.seeds.some((s) => s.admission.result !== 'admitted');
      return { exitCode: failed ? 1 : 0, text: lines.join('\n'), data: { version, states: done.states.map((s) => ({ state: s.state, tag: s.tag })), seeds: done.seeds } };
    });
  },
};

export const seedCommand: CommandDef = {
  name: ['regress', 'seed'],
  usage: 'ogw regress seed <folder> [--background]',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const folder = resolve(ctx.cwd, positional(args, 0, 'folder'));
    const manifest = await readManifest(folder);
    const id = basename(folder);
    const repo = await regressRepo(ctx);
    const version = await harnessVersion(ctx);
    return withRegressLock(ctx, repo, async () => {
      if (!(await readStates(repo)).some((s) => s.state === manifest.state)) throw new OgwError(`state ${manifest.state} is not in ${STATES_FILE}`);
      const state = join((await ctx.workspace()).games, stateGame(manifest.state));
      if (!(await tagExists(state, baseTag(version), { env: ctx.env }))) throw new OgwError(`state ${manifest.state} has no ${baseTag(version)}: run ogw regress refresh`);
      await mkdir(seedDir(repo, id), { recursive: true });
      await cp(folder, seedDir(repo, id), { recursive: true });
      await rm(admissionPath(repo, id, version), { force: true });
      const seed = (await listSeeds(repo)).find((s) => s.id === id);
      if (seed === undefined) throw new OgwError(`seed ${id} was not copied into ${repo}`);
      const self = harnessSide(await head((await ctx.workspace()).harness, { env: ctx.env }));
      const done = await refresh(ctx, repo, self, version, [seed], [manifest.state]);
      await commitRegress(ctx, repo, [join(SEEDS_DIR, id), ...done.paths], `regress seed ${id}`);
      const admission = done.seeds[0]?.admission;
      const text = `seed ${id}: ${admission?.result ?? 'none'}${admission?.reason ? ` (${admission.reason})` : ''}`;
      return { exitCode: admission?.result === 'admitted' ? 0 : 1, text, data: { seed: id, admission } };
    });
  },
};

function overrides(args: Parameters<CommandDef['run']>[1], name: string): SideSpec['agents'] {
  return Object.fromEntries(list(args, name).map(parseAgentOverride));
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new OgwError(`--${name} takes an integer of 1 or more: ${value}`);
  return Number(value);
}

export const runCommand: CommandDef = {
  name: ['regress', 'run'],
  usage: 'ogw regress run [--before <commit>] [--after <commit>] [--before-agent <role>=<cli>/<model>/<effort>]... [--after-agent <role>=<cli>/<model>/<effort>]... [--repeats <n>] [--seeds <id>...] [--catch-only] [--background]',
  options: {
    before: { type: 'string' },
    after: { type: 'string' },
    'before-agent': { type: 'string', multiple: true },
    'after-agent': { type: 'string', multiple: true },
    repeats: { type: 'string' },
    seeds: { type: 'string', multiple: true },
    'catch-only': { type: 'boolean' },
  },
  background: {
    timeLimitMs: () => 4 * LIMITS.jobMs,
    async validate(ctx, args) {
      await sidesOf(ctx, args);
    },
  },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const repo = await regressRepo(ctx);
    const settings = await ctx.settings();
    const repeats = positiveInt(str(args, 'repeats'), settings.regress.repeats, 'repeats');
    return withRegressLock(ctx, repo, async () => {
      const { before, after } = await sidesOf(ctx, args);
      const seeds = list(args, 'seeds');
      const outcome = await regressRun(ctx, repo, { before, after, repeats, seeds: seeds.length === 0 ? null : seeds, catchOnly: flag(args, 'catch-only') });
      return { exitCode: outcome.exitCode, text: [`report: ${outcome.report}`, ...outcome.difference].join('\n'), data: outcome };
    });
  },
};

/** The two sides of a run from its options (ogw.md `### side`). */
async function sidesOf(ctx: Context, args: Parameters<CommandDef['run']>[1]): Promise<{ before: SideSpec; after: SideSpec }> {
  const ws = await ctx.workspace();
  const repo = await regressRepo(ctx);
  const resolveCommit = async (rev: string): Promise<string> => {
    const sha = await revParse(ws.harness, `${rev}^{commit}`, { env: ctx.env });
    if (sha === null) throw new OgwError(`no commit ${rev} in the harness repo`);
    return sha;
  };
  const afterGiven = str(args, 'after');
  if (afterGiven === undefined) {
    const changes = (await statusLines(ws.harness, { env: ctx.env })).filter((line) => !line.startsWith('??'));
    if (changes.length > 0) throw new OgwError(`the harness repo has uncommitted changes; commit them or give --after <commit>:\n${changes.join('\n')}`);
  }
  const after: SideSpec = { name: 'after', commit: await resolveCommit(afterGiven ?? 'HEAD'), agents: overrides(args, 'after-agent') };
  const beforeGiven = str(args, 'before');
  const accepted: Accepted | null = beforeGiven === undefined ? await readAccepted(repo) : null;
  if (beforeGiven === undefined && accepted === null) throw new OgwError(`no ${ACCEPTED_FILE} in ${repo}: give --before <commit>`);
  const beforeAgents = list(args, 'before-agent').length > 0 ? overrides(args, 'before-agent') : ((accepted?.agents ?? {}) as SideSpec['agents']);
  const before: SideSpec = { name: 'before', commit: await resolveCommit(beforeGiven ?? (accepted as Accepted).commit), agents: beforeAgents };
  return { before, after };
}

export const acceptCommand: CommandDef = {
  name: ['regress', 'accept'],
  usage: 'ogw regress accept <run>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const runName = positional(args, 0, 'run');
    if (!/^\d+$/.test(runName)) throw new OgwError(`a run is the <unix ms> of records/runs/: ${runName}`);
    const repo = await regressRepo(ctx);
    return withRegressLock(ctx, repo, async () => {
      const data = await readJsonIfExists<RunData>(join(repo, 'records', 'runs', runName, 'run.json'));
      if (data === null) throw new OgwError(`no run ${runName} in ${join(repo, 'records', 'runs')}`);
      if (data.catchOnly) throw new OgwError(`run ${runName} was made with --catch-only: it measured no fix`);
      const after = data.sides.find((s) => s.name === 'after');
      if (after === undefined || data.sides.some((s) => s.unknown !== null) || after.info === null) throw new OgwError(`run ${runName} has an unknown side`);
      const accepted: Accepted = { commit: after.commit, agents: after.info.agents, run: runName, at: Date.now() };
      await writeJsonAtomic(join(repo, ACCEPTED_FILE), accepted);
      await commitRegress(ctx, repo, [ACCEPTED_FILE], `regress accept ${runName}`);
      return { text: `accepted: ${accepted.commit} (run ${runName})`, data: accepted };
    });
  },
};
