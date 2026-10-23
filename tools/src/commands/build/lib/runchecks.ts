import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { placeholderFailures } from '../../check/api.ts';
import { NAME as DEBUG_TEXT } from '../../check/static/debug-text.ts';
import { NAME as DEV_REFERENCE } from '../../check/static/dev-reference.ts';
import { staticCheck } from '../../check/static-api.ts';
import { runContract } from '../../contract/api.ts';
import type { DataRun } from '../../data/api.ts';
import { contractVersionAt } from './atcommit.ts';
import { saveSchemaCheck } from './saveschema.ts';
import { gameSettingsAt, type BuildCheck } from './buildrun.ts';
import { tagCommit, type BuildTag, type Env } from './names.ts';
import { imageLabel } from './registry.ts';
import { outcome, type CheckWithHuman } from './settingschecks.ts';
import { prodFixedChanges } from '../../check/static/game-settings-owner.ts';

export function plain(name: string, env: Env, details: string[]): CheckWithHuman {
  return { check: { name, result: outcome(name, env, details), details }, human: null };
}

/** `DEV code` and `debug text` from the static check of the checkout. */
export async function staticChecks(ctx: Context, game: GameRepo, env: Env): Promise<CheckWithHuman[]> {
  const debugText = env !== 'DEV';
  const result = await staticCheck(ctx, game, { debugText });
  const lines = (prefix: string): string[] =>
    result.failures.filter((f) => f.message.startsWith(prefix)).map((f) => `${f.where}: ${f.message}`);
  const checks = [plain('DEV code', env, lines(DEV_REFERENCE))];
  if (debugText) checks.push(plain('debug text', env, lines(DEBUG_TEXT)));
  return checks;
}

export async function placeholderCheck(ctx: Context, game: GameRepo, env: Env): Promise<CheckWithHuman> {
  const failures = await placeholderFailures(ctx, game);
  return plain('placeholder', env, failures.map((f) => `${f.where}: ${f.message}`));
}

export interface CompatInput {
  ctx: Context;
  game: GameRepo;
  env: Env;
  settings: GameSettings;
  lastProd: BuildTag;
  data: DataRun;
  /** PROD build with data: compare the compat data version with the STG image label. */
  stgImage: string | null;
  compat: string;
}

async function settingsCompat(input: CompatInput): Promise<string[]> {
  const commit = await tagCommit(input.game.root, input.lastProd.tag);
  const last = await gameSettingsAt(input.game.root, commit, input.ctx.env);
  const details: string[] = [];
  for (const key of prodFixedChanges(input.settings, last)) details.push(`game settings ${key} differs from ${input.lastProd.tag}`);
  const now = (input.settings.environments?.PROD?.updatePublicKeys ?? []) as string[];
  for (const key of (last.environments?.PROD?.updatePublicKeys ?? []) as string[]) {
    if (!now.includes(key)) details.push(`game settings environments.PROD.updatePublicKeys lost ${key} of ${input.lastProd.tag}`);
  }
  return details;
}

/** `backward compatibility` (`build` `## backward compatibility`), when a PROD tag exists. */
export async function compatibilityCheck(input: CompatInput): Promise<CheckWithHuman> {
  const details: string[] = [];
  const contract = await runContract(input.ctx, input.game);
  details.push(...contract.violations.map((v) => `contract: ${v}`));
  if (contract.exitCode !== 0 && contract.violations.length === 0) details.push(`contract: contract tool failed: ${contract.stderr.trim()}`);
  const dataCodes = new Set(['protocol_change', 'prod_change']);
  details.push(...input.data.lines.filter((l) => l.level === 'ERROR' && dataCodes.has(l.code)).map((l) => `data: ${l.text}`));
  if (input.stgImage !== null) {
    const label = await imageLabel(input.ctx, input.stgImage, 'ogw.compat_client_data_version');
    if ((label ?? '') !== input.compat) details.push(`server image: ${input.stgImage} label ogw.compat_client_data_version differs from compat_client_data_version`);
  }
  details.push(...(await settingsCompat(input)));
  const prodCommit = await tagCommit(input.game.root, input.lastProd.tag);
  const current = await contractVersionAt(input.game.root, 'HEAD');
  const previous = await contractVersionAt(input.game.root, prodCommit);
  let unknownKinds: string[] = [];
  if (current !== null && previous !== null && current > previous) {
    const saveSchema = await saveSchemaCheck({ ctx: input.ctx, game: input.game, prodCommit, currentVersion: current });
    details.push(...saveSchema.failures);
    unknownKinds = saveSchema.unknownKinds;
  }
  if (details.length === 0 && unknownKinds.length > 0) {
    const unknown = unknownKinds.map((kind) => `save schema: unknown: no sampled ${kind} record has a contract version below ${String(current)}`);
    return { check: { name: 'backward compatibility', result: 'unknown', details: unknown }, human: null };
  }
  return plain('backward compatibility', input.env, details);
}

export function failedChecks(checks: readonly CheckWithHuman[]): BuildCheck[] {
  return checks.map((c) => c.check).filter((c) => c.result === 'fail');
}
