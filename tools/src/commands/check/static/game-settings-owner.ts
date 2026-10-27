import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { listTags, showFile } from '../../../lib/git.ts';
import { openRun } from '../../../lib/runstate.ts';
import { loadSchema, schemaPath, withDefaults } from '../../../lib/settings.ts';
import { lastProdTagName } from '../../build/lib/names.ts';
import { coreReleaseOfGame } from '../../core/api.ts';
import { gameCheckErrors, gameSettingsValue } from '../../settings/api.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isRecord } from './lib/json-pos.ts';
import { keyLine } from './option-entry.ts';

/**
 * game settings owner: game settings fail `ogw game check`; a game settings item whose schema `x-owner` is not
 * `content`, a game settings `core` key whose core settings schema `x-owner` is `human`, or the value at a path of the
 * reference commit's `humanDecided`, differs from the open run's reference commit (skipped without an open run or
 * before the reference commit is set); with a PROD tag,
 * `dailyResetOffsetMs` or `nicknameUnique` differs from the last `prod-<version>` tag (schema defaults filled in).
 */
export const NAME = 'game settings owner';

const PROD_FIXED = ['dailyResetOffsetMs', 'nicknameUnique'];

/**
 * The game settings keys that may not change after the first PROD build and differ between two settings that both have
 * the schema defaults filled in. `ogw check` and the build-time backward compatibility check share it.
 */
export function prodFixedChanges(now: Record<string, unknown>, prod: Record<string, unknown>): string[] {
  return PROD_FIXED.filter((key) => !isDeepStrictEqual(now[key], prod[key]));
}

/** Top-level game settings items whose schema `x-owner` is not `content`. */
export function humanItems(schema: Record<string, unknown>): string[] {
  const props = isRecord(schema.properties) ? schema.properties : {};
  return Object.keys(props).filter((k) => {
    const p = props[k];
    return !(isRecord(p) && p['x-owner'] === 'content');
  });
}

/** Dotted paths of core settings schema properties with `"x-owner": "human"`. */
export function humanCoreKeys(schema: unknown, prefix = ''): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema.properties)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isRecord(value) && value['x-owner'] === 'human') out.push(path);
    out.push(...humanCoreKeys(value, path));
  }
  return out;
}

/** Value at a core settings key: a flat key (`NetworkCore.retryCount`) or nested objects. */
export function coreValue(core: unknown, key: string): unknown {
  if (!isRecord(core)) return undefined;
  if (key in core) return core[key];
  let cur: unknown = core;
  for (const part of key.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Line of a core settings key in the settings text: the flat key, else its last segment. */
function coreKeyLine(text: string, key: string): number {
  return text.includes(`"${key}"`) ? keyLine(text, key) : keyLine(text, key.split('.').pop() ?? key);
}

/** Line of a `humanDecided` path in the settings text: its core settings key, else its last key. */
function humanDecidedLine(text: string, path: string): number {
  return path.startsWith('core.') ? coreKeyLine(text, path.slice('core.'.length)) : keyLine(text, path.split('.').pop() ?? path);
}

async function settingsAt(sc: StaticContext, rev: string): Promise<Record<string, unknown>> {
  const bytes = await showFile(sc.root, rev, 'settings.json');
  if (!bytes) return {};
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  return isRecord(parsed) ? parsed : {};
}

async function referenceFindings(sc: StaticContext, current: Record<string, unknown>, text: string, schema: Record<string, unknown>): Promise<Finding[]> {
  const run = await openRun(sc.game);
  if (!run?.referenceCommit) return [];
  const ref = await settingsAt(sc, run.referenceCommit);
  const out: Finding[] = [];
  for (const key of humanItems(schema)) {
    if (!isDeepStrictEqual(current[key], ref[key])) out.push(finding(NAME, at('settings.json', keyLine(text, key)), `\`${key}\` is not a content item and differs from the run reference commit ${run.referenceCommit}`));
  }
  const decided = Array.isArray(ref.humanDecided) ? ref.humanDecided.filter((p): p is string => typeof p === 'string') : [];
  for (const path of decided) {
    if (!isDeepStrictEqual(gameSettingsValue(current, path), gameSettingsValue(ref, path))) {
      out.push(finding(NAME, at('settings.json', humanDecidedLine(text, path)), `\`${path}\` is in humanDecided and differs from the run reference commit ${run.referenceCommit}`));
    }
  }
  const release = await coreReleaseOfGame(sc.ctx, sc.game);
  const coreSchema = JSON.parse(await readFile(join(release.dir, 'core-settings.schema.json'), 'utf8')) as unknown;
  for (const key of humanCoreKeys(coreSchema)) {
    if (!isDeepStrictEqual(coreValue(current.core, key), coreValue(ref.core, key))) {
      out.push(finding(NAME, at('settings.json', coreKeyLine(text, key)), `core settings key \`${key}\` is owned by human and differs from the run reference commit ${run.referenceCommit}`));
    }
  }
  return out;
}

async function prodFindings(sc: StaticContext, current: Record<string, unknown>, text: string, schema: Record<string, unknown>): Promise<Finding[]> {
  const tag = lastProdTagName(await listTags(sc.root));
  if (tag === null) return [];
  const prod = withDefaults(schema, await settingsAt(sc, tag));
  const now = withDefaults(schema, current);
  return prodFixedChanges(now, prod).map((key) =>
    finding(NAME, at('settings.json', keyLine(text, key)), `\`${key}\` differs from the last PROD build \`${tag}\``),
  );
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const out: Finding[] = (await gameCheckErrors(sc.ctx, sc.game)).map((e) => finding(NAME, at('settings.json', 1), `ogw game check: ${e}`));
  const current = (await sc.settings()) as Record<string, unknown>;
  const text = await sc.text('settings.json');
  const schema = (await loadSchema(schemaPath('game-settings', sc.ctx.env))) as Record<string, unknown>;
  out.push(...(await referenceFindings(sc, current, text, schema)));
  out.push(...(await prodFindings(sc, current, text, schema)));
  return out;
}
