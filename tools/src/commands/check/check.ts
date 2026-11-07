import { rm } from 'node:fs/promises';
import { flag, str, type CommandArgs, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { LIMITS } from '../../lib/limits.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../lib/settings.ts';
import { binaryBuild } from '../data/lib/binary-build.ts';
import { withHeavyStep } from '../generation/lib/lease.ts';
import { mergedChecks, placeholderFailures, type CheckResult } from './api.ts';
import { BOT_PLAYTEST_POLL_MS, botPlaytest, readScenario } from './lib/bot-playtest.ts';
import { gameEngine, importClient } from './lib/engine.ts';
import { checkResult } from './lib/evidence.ts';
import { gameChecks, loopCheck, runTimeLimitMs, slotsOf, startTimeLimitMs, type RegressPick } from './lib/loop.ts';
import { fixedRows, rowProofs } from './lib/fix-proof.ts';
import type { FixTestProof } from '../loop/lib/files.ts';
import type { RunState } from '../../lib/runstate.ts';
import type { Evidence } from './lib/evidence.ts';
import { regressionTargets, regressionTest } from './lib/regression.ts';
import { staticCheck } from './static-api.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { agentContext } from '../../lib/agentctx.ts';

const USAGE = 'ogw check <game> [--loop|--regression [<path>]|--static|--bot|--placeholder] [--db postgresql]';
const MODES = ['loop', 'regression', 'static', 'bot', 'placeholder'] as const;
type Mode = (typeof MODES)[number];

/** Polling interval of instance state while a condition is not true yet. */
export const timing = { pollMs: BOT_PLAYTEST_POLL_MS, sampleMs: 1000 };

function modeOf(args: CommandArgs): Mode {
  const given = MODES.filter((mode) => flag(args, mode));
  const [mode] = given;
  if (given.length !== 1 || mode === undefined) throw new OgwError(`give one of --loop, --regression, --static, --bot, --placeholder\nusage: ${USAGE}`);
  return mode;
}

function dbOf(args: CommandArgs): 'postgresql' | undefined {
  const db = str(args, 'db');
  if (db === undefined) return undefined;
  if (db !== 'postgresql') throw new OgwError(`--db takes only postgresql: ${db}`);
  return db;
}

async function gameSettings(ctx: Context, game: GameRepo): Promise<GameSettings> {
  return withDefaults(await loadSchema(schemaPath('game-settings', ctx.env)), await loadGameSettings(game.root));
}

/**
 * `ogw check` runs the data tool binary build when it starts, as a heavy step (ogw.md `### performance lease`); it stops
 * when that fails.
 */
async function binaryData(ctx: Context, game: GameRepo): Promise<void> {
  await withHeavyStep(ctx, game, () => binaryBuild(ctx, game, 'data tool binary build failed; run ogw data and commit, then check again'));
}

/** The failures of one check that the text of `--loop` prints: the result file holds them all. */
const LOOP_TEXT_FAILURES = 20;
/** The warnings of one check that the text prints: `ogw data` of the checkout and the result file of `--loop` hold them all. */
const TEXT_WARNINGS = 5;

/** `checkout`: a check mode other than `--loop`. `core try` checks another core and tree than `ogw data` does, so it prints all. */
function checkText(check: CheckResult, mode: 'loop' | 'checkout' | 'core try' = 'checkout'): string[] {
  const lines = [`${check.name}${check.platform === null ? '' : ` (${check.platform})`}: ${check.result}`];
  const failures = mode === 'loop' ? check.failures.slice(0, LOOP_TEXT_FAILURES) : check.failures;
  const warnings = mode === 'core try' ? check.warnings : check.warnings.slice(0, TEXT_WARNINGS);
  for (const f of failures) lines.push(`  ${f.where} ${f.message}`.trimEnd(), ...f.evidence.map((path) => `    ${path}`));
  if (failures.length < check.failures.length) lines.push(`  ${String(check.failures.length - failures.length)} more failures, all in the result file`);
  for (const w of warnings) lines.push(`  warning ${w.where} ${w.message}`.trimEnd());
  if (warnings.length < check.warnings.length) lines.push(`  ${String(check.warnings.length - warnings.length)} more warnings, all in ${mode === 'loop' ? 'the result file' : 'ogw data <game> --json'}`);
  if (check.hostLoad) {
    const load = check.hostLoad;
    lines.push(`  hostLoad cpuMaxPercent ${String(load.cpuMaxPercent)} memoryMaxPercent ${String(load.memoryMaxPercent)} instancesMax ${String(load.instancesMax)}`);
  }
  return lines;
}

function summary(checks: readonly CheckResult[]): { checks: { name: string; result: string }[] } {
  return { checks: mergedChecks(checks) };
}

function single(check: CheckResult): CommandResult {
  return {
    exitCode: check.result === 'pass' ? 0 : 1,
    text: checkText(check).join('\n'),
    data: { checks: [check] },
    summary: summary([check]),
  };
}

async function regression(ctx: Context, game: GameRepo, godot: string, path: string | undefined, db: 'postgresql' | undefined): Promise<CommandResult> {
  const targets = await regressionTargets(game.root, path);
  const limit = await runTimeLimitMs(ctx, game);
  const startLimit = await startTimeLimitMs(ctx, game);
  const dir = await newPrivateTempFolder('ogw-check-', ctx.env);
  const evidence = { root: dir, dir: '.', relative: false };
  let result: CheckResult | null = null;
  try {
    result = await regressionTest(ctx, game, targets, { godot, evidence, runTimeLimitMs: limit, startTimeLimitMs: startLimit, ...(db ? { db } : {}) });
  } finally {
    // the evidence folder is done when no failure the output prints points into it (a passing run points at none)
    if (result === null || !result.failures.some((f) => f.evidence.length > 0)) await rm(dir, { recursive: true, force: true });
  }
  return single(result);
}

/**
 * `ogw check <game> --bot`: the bot playtest of `--loop` (no blocker and full flow) on the checkout as it is, with no
 * result file, so that the content agent sees them before the lead agent's check. It imports the client first, as
 * `--loop` does, so that the client does not run on an import older than the checkout.
 */
async function bot(ctx: Context, game: GameRepo, godot: string, db: 'postgresql' | undefined): Promise<CommandResult> {
  const importFailure = await importClient(ctx, godot, game);
  if (importFailure !== null) {
    const failure = [{ where: 'client/project.godot:1', message: `the client import failed: ${importFailure}`, evidence: [] }];
    const checks = [checkResult('no blocker', null, failure), checkResult('full flow', null, failure)];
    return { exitCode: 1, text: checks.flatMap((check) => checkText(check)).join('\n'), data: { checks }, summary: summary(checks) };
  }
  const scenario = await readScenario(game.root);
  const slots = await slotsOf(ctx);
  const dir = await newPrivateTempFolder('ogw-check-', ctx.env);
  const evidence = { root: dir, dir: '.', relative: false };
  let checks: CheckResult[] = [];
  try {
    checks = await botPlaytest(ctx, game.name, scenario, { evidence, slots, db, pollMs: timing.pollMs });
  } finally {
    // kept while a check did not pass: its logs, also those of an instance that did not start, are there
    if (checks.every((c) => c.result === 'pass')) await rm(dir, { recursive: true, force: true });
  }
  const passed = checks.length > 0 && checks.every((c) => c.result === 'pass');
  const lines = [...checks.flatMap((check) => checkText(check)), ...(passed ? [] : [`evidence: ${dir}`])];
  return { exitCode: passed ? 0 : 1, text: lines.join('\n'), data: { checks, ...(passed ? {} : { evidence: dir }) }, summary: summary(checks) };
}

async function loop(ctx: Context, game: GameRepo, settings: GameSettings, godot: string, db: 'postgresql' | undefined): Promise<CommandResult> {
  const outcome = await loopCheck(ctx, game, settings, { godot, db, ...timing });
  const text = [...outcome.checks.flatMap((check) => checkText(check, 'loop')), `result file: ${outcome.file}`, `gate: ${outcome.gate}`];
  return {
    exitCode: outcome.gate === 'pass' ? 0 : 1,
    text: text.join('\n'),
    data: { file: outcome.file, commit: outcome.commit, checks: outcome.checks, gate: outcome.gate },
    summary: summary(outcome.checks),
  };
}

/**
 * The checks `ogw core try` runs on a checkout (`core` command.md `update core`), with the data tool binary build and
 * the engine of the core the checkout's context gives, and their output lines.
 */
export async function coreTryChecks(ctx: Context, game: GameRepo, evidence: Evidence): Promise<{ checks: CheckResult[]; lines: string[] }> {
  const settings = await gameSettings(ctx, game);
  const godot = await gameEngine(ctx, game, settings);
  await binaryData(ctx, game);
  const checks = await gameChecks(ctx, game, settings, { godot, ...timing }, evidence, 'core try');
  return { checks, lines: checks.flatMap((check) => checkText(check, 'core try')) };
}

/**
 * The checks of `ogw regress check` on a checkout (ogw.md `### side` of `## regress`): those of a completeness iteration
 * picked by `pick`, and with `proof` the fix test proof of iteration `proof.iteration` of the seed-run records
 * `records/loops/<proof.records>/` on `commit`, beside the checks in their spare slots as `ogw check --loop` runs it
 * (ogw.md `### fix test proof`): the performance measurements wait for it.
 */
export async function regressChecks(
  ctx: Context,
  game: GameRepo,
  evidence: Evidence,
  pick: RegressPick,
  proof: { records: string; iteration: number; commit: string } | null,
): Promise<{ checks: CheckResult[]; fixTestProof: FixTestProof[] }> {
  const settings = await gameSettings(ctx, game);
  const godot = await gameEngine(ctx, game, settings);
  await binaryData(ctx, game);
  if (proof === null) return { checks: await gameChecks(ctx, game, settings, { godot, ...timing }, evidence, pick), fixTestProof: [] };
  const slots = await slotsOf(ctx);
  const options = { godot, runTimeLimitMs: await runTimeLimitMs(ctx, game), startTimeLimitMs: await startTimeLimitMs(ctx, game), slots };
  const run = seedRunState(proof.records, proof.iteration);
  // a content agent report that cannot be read fails the check here, before any check starts
  const fixed = await fixedRows(game, run);
  // the fix test proof works in a worktree of its own: it does not wait for the import of the checkout. It does not
  // throw (what it could not decide is `unknown` with the reason)
  const proving = rowProofs(ctx, game, run, proof.commit, fixed, options);
  const beside = {
    name: 'fix test proof',
    work: async (): Promise<void> => {
      await proving;
    },
  };
  const checks = await gameChecks(ctx, game, settings, { godot, ...timing, slots }, evidence, pick, [beside]).finally(() => Promise.allSettled([proving]));
  return { checks, fixTestProof: await proving };
}

/** The run state a fix test proof reads of seed-run records: their name as the run name and the iteration. */
function seedRunState(records: string, iteration: number): RunState {
  return { name: records, kind: 'loop', command: null, env: null, version: null, platforms: [], bundleFor: null, branch: 'main', baseCommit: '', referenceCommit: null, startedAt: 0, closedAt: null, iteration, data: {} };
}

async function runCheck(ctx: Context, args: CommandArgs): Promise<CommandResult> {
  const [name, path, ...rest] = args.positionals;
  const mode = modeOf(args);
  if (name === undefined || rest.length > 0 || (path !== undefined && mode !== 'regression')) throw new OgwError(`usage: ${USAGE}`);
  // the iteration result file is the lead agent's: an agent `ogw agent` started gets the other modes only
  const agent = mode === 'loop' ? await agentContext(ctx.env) : null;
  if (agent) throw new OgwError(`ogw check --loop is for the lead agent, not the ${agent.meta.role} agent: run --regression, --static or --bot`);
  const db = dbOf(args);
  const game = await ctx.game(name);
  const settings = await gameSettings(ctx, game);
  const godot = await gameEngine(ctx, game, settings);
  await binaryData(ctx, game);
  if (mode === 'placeholder') return single(checkResult('no placeholder', null, await placeholderFailures(ctx, game)));
  if (mode === 'static') return single(await staticCheck(ctx, game, db ? { db } : {}));
  if (mode === 'regression') return regression(ctx, game, godot, path, db);
  if (mode === 'bot') return bot(ctx, game, godot, db);
  return loop(ctx, game, settings, godot, db);
}

export const check: CommandDef = {
  name: ['check'],
  usage: USAGE,
  options: {
    loop: { type: 'boolean' },
    regression: { type: 'boolean' },
    static: { type: 'boolean' },
    bot: { type: 'boolean' },
    placeholder: { type: 'boolean' },
    db: { type: 'string' },
  },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  run: runCheck,
};
