import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import type { CheckFailure, CheckResult } from './api.ts';
import * as actionReference from './static/action-reference.ts';
import * as anchorReference from './static/anchor-reference.ts';
import * as blockToken from './static/block-token.ts';
import * as botScenario from './static/bot-scenario.ts';
import * as contract from './static/contract.ts';
import * as coreDiff from './static/core-diff.ts';
import * as dataCheck from './static/data-check.ts';
import * as dataLiteral from './static/data-literal.ts';
import * as dataMutation from './static/data-mutation.ts';
import * as debugText from './static/debug-text.ts';
import * as designTarget from './static/design-target.ts';
import * as determinism from './static/determinism.ts';
import * as devReference from './static/dev-reference.ts';
import * as embeddedScript from './static/embedded-script.ts';
import * as engineRandom from './static/engine-random.ts';
import * as featureBoundary from './static/feature-boundary.ts';
import * as forbiddenApi from './static/forbidden-api.ts';
import * as formatArgs from './static/format-args.ts';
import * as frameCode from './static/frame-code.ts';
import * as framePolling from './static/frame-polling.ts';
import * as gameSettingsOwner from './static/game-settings-owner.ts';
import * as gameStateLock from './static/game-state-lock.ts';
import * as generatedDiff from './static/generated-diff.ts';
import * as hapticFormat from './static/haptic-format.ts';
import { at, finding, StaticContext, UnreadableFile, type Finding } from './static/lib/context.ts';
import * as lint from './static/lint.ts';
import * as literalTiming from './static/literal-timing.ts';
import * as objectDestroy from './static/object-destroy.ts';
import * as optionEntry from './static/option-entry.ts';
import * as resourceHash from './static/resource-hash.ts';
import * as resourceLoad from './static/resource-load.ts';
import * as settingsAccess from './static/settings-access.ts';
import * as sharedFormula from './static/shared-formula.ts';
import * as simulationTarget from './static/simulation-target.ts';
import * as systemClock from './static/system-clock.ts';
import * as testInput from './static/test-input.ts';
import * as typeCheck from './static/type-check.ts';
import * as virtualPadLayout from './static/virtual-pad-layout.ts';

export interface StaticCheckModule {
  NAME: string;
  run(sc: StaticContext): Promise<Finding[]>;
}

/** The checks that `ogw check --static` runs, in report order. */
export const STATIC_CHECKS: readonly StaticCheckModule[] = [
  coreDiff, generatedDiff, contract, devReference, typeCheck, lint, dataLiteral, resourceHash, blockToken, testInput, framePolling,
  hapticFormat, embeddedScript, systemClock, gameStateLock, sharedFormula, botScenario, optionEntry, gameSettingsOwner, designTarget,
  simulationTarget, featureBoundary, forbiddenApi, settingsAccess, resourceLoad, engineRandom, dataMutation, frameCode,
  literalTiming, objectDestroy, determinism, virtualPadLayout, formatArgs, actionReference, anchorReference,
];

function toFailure(f: Finding): CheckFailure {
  return { where: f.where, message: f.message, evidence: [] };
}

function order(a: CheckFailure, b: CheckFailure): number {
  return a.where.localeCompare(b.where, 'en', { numeric: true }) || a.message.localeCompare(b.message);
}

export interface StaticCheckDetail {
  result: CheckResult;
  /** The failures of `result` that are absence failures. */
  absent: CheckFailure[];
}

export interface StaticCheckOptions {
  debugText?: boolean;
  db?: 'postgresql';
  /** Environment of the git call that reads the staged changes of the checkout (the index of the commit in a pre-commit hook). */
  stagedEnv?: NodeJS.ProcessEnv;
  /** The checkout's `client/` was just imported under the import lock (`importClient`): the type check does not import again. */
  imported?: boolean;
  /** The caller's import of the checkout's `client/` failed with this message: the type check reports it and does not import again. */
  importFailure?: string;
}

/** Runs one static check; a file it could not parse is its finding at `<path>:1` (malformed content is a failure). */
async function runCheck(check: StaticCheckModule, sc: StaticContext): Promise<Finding[]> {
  try {
    return await check.run(sc);
  } catch (error) {
    if (error instanceof UnreadableFile) return [finding(check.NAME, at(error.path, 1), `${error.path} could not be read: ${error.message}`)];
    throw error;
  }
}

/** static check of the checkout with its absence failures. */
export async function staticCheckDetail(ctx: Context, game: GameRepo, options?: StaticCheckOptions): Promise<StaticCheckDetail> {
  const sc = await StaticContext.create(ctx, game, options?.stagedEnv);
  sc.imported = options?.imported === true;
  sc.importFailure = options?.importFailure ?? null;
  const checks: StaticCheckModule[] = [...STATIC_CHECKS];
  if (options?.debugText) checks.push(debugText);
  const jobs: Promise<{ failures: Finding[]; warnings: Finding[] }>[] = [
    ...checks.map(async (check) => ({ failures: await runCheck(check, sc), warnings: [] })),
    dataCheck.run(sc),
  ];
  const settled = await Promise.allSettled(jobs);
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  const done = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const found = done.flatMap((d) => d.failures).map((f) => ({ failure: toFailure(f), absent: f.absent === true }));
  found.sort((a, b) => order(a.failure, b.failure));
  const failures = found.map((f) => f.failure);
  const warnings = done.flatMap((d) => d.warnings).map(toFailure).sort(order);
  return {
    result: { name: 'static check', platform: null, result: failures.length > 0 ? 'fail' : 'pass', failures, warnings },
    absent: found.filter((f) => f.absent).map((f) => f.failure),
  };
}

/** static check of the checkout, without `debug text` unless asked. */
export async function staticCheck(ctx: Context, game: GameRepo, options?: StaticCheckOptions): Promise<CheckResult> {
  return (await staticCheckDetail(ctx, game, options)).result;
}
