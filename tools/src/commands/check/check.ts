import { rm } from 'node:fs/promises';
import { flag, str, type CommandArgs, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { LIMITS } from '../../lib/limits.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../lib/settings.ts';
import { binaryBuild } from '../data/lib/binary-build.ts';
import { mergedChecks, placeholderFailures, type CheckResult } from './api.ts';
import { BOT_PLAYTEST_POLL_MS, botPlaytest, readScenario } from './lib/bot-playtest.ts';
import { gameEngine, importClient } from './lib/engine.ts';
import { checkResult } from './lib/evidence.ts';
import { gameChecks, loopCheck, runTimeLimitMs, slotsOf, startTimeLimitMs } from './lib/loop.ts';
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

/** `ogw check` runs the data tool binary build when it starts; it stops when that fails. */
async function binaryData(ctx: Context, game: GameRepo): Promise<void> {
  await binaryBuild(ctx, game, 'data tool binary build failed; run ogw data and commit, then check again');
}

function checkText(check: CheckResult): string[] {
  const lines = [`${check.name}${check.platform === null ? '' : ` (${check.platform})`}: ${check.result}`];
  for (const f of check.failures) lines.push(`  ${f.where} ${f.message}`.trimEnd(), ...f.evidence.map((path) => `    ${path}`));
  for (const w of check.warnings) lines.push(`  warning ${w.where} ${w.message}`.trimEnd());
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
    result = await regressionTest(ctx, game.root, targets, { godot, evidence, runTimeLimitMs: limit, startTimeLimitMs: startLimit, ...(db ? { db } : {}) });
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
  const importFailure = await importClient(ctx, godot, game.root);
  if (importFailure !== null) {
    const failure = [{ where: 'client/project.godot:1', message: `the client import failed: ${importFailure}`, evidence: [] }];
    const checks = [checkResult('no blocker', null, failure), checkResult('full flow', null, failure)];
    return { exitCode: 1, text: checks.flatMap(checkText).join('\n'), data: { checks }, summary: summary(checks) };
  }
  const scenario = await readScenario(game.root);
  const dir = await newPrivateTempFolder('ogw-check-', ctx.env);
  const evidence = { root: dir, dir: '.', relative: false };
  let checks: CheckResult[] = [];
  try {
    checks = await botPlaytest(ctx, game.name, scenario, { evidence, slots: await slotsOf(ctx), db, pollMs: timing.pollMs });
  } finally {
    // kept while a check did not pass: its logs, also those of an instance that did not start, are there
    if (checks.length > 0 && checks.every((c) => c.result === 'pass')) await rm(dir, { recursive: true, force: true });
  }
  const passed = checks.length > 0 && checks.every((c) => c.result === 'pass');
  const lines = [...checks.flatMap(checkText), ...(passed ? [] : [`evidence: ${dir}`])];
  return { exitCode: passed ? 0 : 1, text: lines.join('\n'), data: { checks, ...(passed ? {} : { evidence: dir }) }, summary: summary(checks) };
}

async function loop(ctx: Context, game: GameRepo, settings: GameSettings, godot: string, db: 'postgresql' | undefined): Promise<CommandResult> {
  const outcome = await loopCheck(ctx, game, settings, { godot, db, ...timing });
  const text = [...outcome.checks.flatMap(checkText), `result file: ${outcome.file}`, `gate: ${outcome.gate}`];
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
  return { checks, lines: checks.flatMap(checkText) };
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
