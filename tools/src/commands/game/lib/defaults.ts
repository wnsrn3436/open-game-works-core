import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { loadSchema, schemaPath, withDefaults } from '../../../lib/settings.ts';
import { ALWAYS_MODULES, compareBytes } from '../../generate/lib/core-spec.ts';
import { coreFiles, type CoreFiles } from '../../settings/lib/core-files.ts';
import { addedLeaves, display, getAt, isPlainObject, type JsonObject } from '../../settings/lib/json-path.ts';
import { child, infoOf, type SchemaNode } from '../../settings/lib/schema-nav.ts';
import { coreSettingMeanings } from './setting-meanings.ts';
import { TEST_TIME_LIMIT } from '../init.ts';

/** Group of the values that a human reads first (`game-setup` 10). */
export const TO_KNOW_GROUP = 'values to know';
/** Group of the game settings schema defaults outside `TO_KNOW_GROUP`. */
export const GAME_GROUP = 'game settings';

export interface DefaultValue {
  path: string;
  value: unknown;
  /**
   * `schema default` (game settings schema), `core settings` (core release `core-settings.json`), `ogw game derive`
   * (a value `ogw game derive` wrote, not a human) or `ogw game init` (the value `ogw game init` wrote, not a human).
   */
  source: 'schema default' | 'core settings' | 'ogw game derive' | 'ogw game init';
  /** `values to know`, `game settings`, or the core module the key belongs to. */
  group: string;
  /** The value for a human: a duration with its unit, a minute of the day as hh:mm, the day boundary as a time zone. */
  display: string;
  /** Game settings schema `description`, or the `meaning` of the harness module spec `## settings` row; null when none. */
  meaning: string | null;
}

/**
 * The values a human reads first: they change what players experience or how long user data is kept, or the work
 * of the loop and build. A path ending in `.*` takes every path under it. Listed in this order.
 */
export const TO_KNOW: readonly string[] = [
  'core.logging.clientLogRetentionMs',
  'core.logging.serverEventRetentionMs',
  'core.item-ledger.historyRetentionMs',
  'core.gacha.historyRetentionMs',
  'core.block-report.reportRetentionMs',
  'core.iap.withdrawnRecordRetentionMs',
  'core.push.recordRetentionMs',
  'core.matchmaker.recordRetentionMs',
  'core.user-snapshot-clone.cloneRetentionMs',
  'core.chat.retentionMs',
  'core.ranking.seasonRetentionMs',
  'pushConsent.nightStartMinute',
  'pushConsent.nightEndMinute',
  'consent.ageBandBoundaries',
  'targetFps',
  'uiQuality.*',
  'loopIterationLimit',
  'buildRetryLimit',
  'core.UnitTestCore.testTimeLimitMs',
  'core.routing.userRateLimitPerMinute',
  'core.routing.ipRateLimitPerMinute',
  'core.NativeUiCore.reviewMinIntervalMs',
  'core.AccessibilityCore.textScales',
  'core.AccessibilityCore.subtitlesDefault',
  'core.AccessibilityCore.colorFilterEnabled',
  'core.AccessibilityCore.reducedShakePermille',
  'core.AccessibilityCore.reducedFlashMaxOpacity',
  'environments.PROD.adapters.cdn',
];

/** Derived values the list shows, though game settings hold them: a human did not choose them. */
const DERIVED: readonly string[] = ['environments.PROD.adapters.cdn'];

function toKnowRank(path: string): number {
  return TO_KNOW.findIndex((p) => (p.endsWith('.*') ? path.startsWith(p.slice(0, -1)) : path === p));
}

const UNITS: readonly [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['min', 60_000],
  ['s', 1000],
];

/** A duration in ms with the largest unit that divides it. e.g. `30 d`, `2 s`, `1500 ms`. */
export function durationText(ms: number): string {
  for (const [unit, size] of UNITS) if (ms !== 0 && Number.isInteger(ms / size)) return `${String(ms / size)} ${unit}`;
  return `${String(ms)} ms`;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `dailyResetOffsetMs` as the time zone whose local midnight is the game day boundary. e.g. `00:00 UTC+9`. */
export function dayBoundaryText(offsetMs: number): string {
  if (!Number.isInteger(offsetMs / 60_000)) return durationText(offsetMs);
  const minutes = -offsetMs / 60_000;
  if (minutes === 0) return '00:00 UTC';
  const abs = Math.abs(minutes);
  const zone = abs % 60 === 0 ? String(abs / 60) : hhmm(abs).replace(/^0/, '');
  return `00:00 UTC${minutes > 0 ? '+' : '-'}${zone}`;
}

/** Keys whose value is a minute of the day. */
const MINUTE_OF_DAY: ReadonlySet<string> = new Set(['nightStartMinute', 'nightEndMinute']);

/** The value for a human (`DefaultValue.display`). */
export function displayValue(path: string, value: unknown): string {
  const key = path.slice(path.lastIndexOf('.') + 1);
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (key === 'dailyResetOffsetMs') return dayBoundaryText(value);
    if (key.endsWith('Ms')) return durationText(value);
    if (MINUTE_OF_DAY.has(key) && value >= 0 && value < 1440) return hhmm(value);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The modules the game uses (`core` skill `## module`): `ALWAYS_MODULES`, `coreModules` and their dependency closure. */
function usedModuleNames(core: CoreFiles, settings: JsonObject): Set<string> {
  const byName = new Map(core.modules.map((m) => [m.name, m as { name: string; dependencies?: unknown }]));
  const coreModules = isPlainObject(settings.coreModules) ? settings.coreModules : {};
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : []);
  const queue = [...ALWAYS_MODULES, ...names(coreModules.client), ...names(coreModules.server)];
  const seen = new Set<string>();
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const module = byName.get(name);
    if (seen.has(name) || !module) continue;
    seen.add(name);
    queue.push(...names(module.dependencies));
  }
  return seen;
}

/** The `description` of the deepest schema node on the path that has one. */
function schemaMeaning(schema: JsonObject, segments: readonly string[]): string | null {
  let nodes: SchemaNode[] = [{ node: schema, root: schema }];
  let meaning: string | null = null;
  for (const segment of segments) {
    nodes = child(nodes, segment);
    if (nodes.length === 0) break;
    meaning = infoOf(nodes).description ?? meaning;
  }
  return meaning;
}

/** The module a core settings key belongs to: the part before the first `.`. */
function moduleOf(key: string): string {
  return key.slice(0, key.indexOf('.'));
}

/**
 * Values the game uses that no human chose (`game-setup` 10): game settings schema defaults, the core settings
 * defaults of the modules the game uses, and `DERIVED`. Ordered `values to know` first (in `TO_KNOW` order), then
 * the other game settings values, then one group per module in module name order.
 */
export async function defaultValues(ctx: Context, game: string, settings: JsonObject): Promise<DefaultValue[]> {
  if (typeof settings.coreVersion !== 'string') throw new OgwError('game settings have no coreVersion');
  const schema = (await loadSchema(schemaPath('game-settings', ctx.env))) as JsonObject;
  const core = await coreFiles(ctx, settings.coreVersion, game);
  const used = usedModuleNames(core, settings);
  const meanings = await coreSettingMeanings(harnessRoot(ctx.env));
  const out: DefaultValue[] = [];
  const add = (segments: string[], value: unknown, source: DefaultValue['source'], group: string, meaning: string | null): void => {
    const path = display(segments);
    out.push({ path, value, source, group: toKnowRank(path) >= 0 ? TO_KNOW_GROUP : group, display: displayValue(path, value), meaning });
  };
  for (const leaf of addedLeaves(settings, withDefaults(schema, settings))) {
    add(leaf.path, leaf.value, 'schema default', GAME_GROUP, schemaMeaning(schema, leaf.path));
  }
  for (const path of DERIVED) {
    const segments = path.split('.');
    const value = getAt(settings, segments);
    if (value !== undefined) add(segments, value, 'ogw game derive', GAME_GROUP, schemaMeaning(schema, segments));
  }
  const written = isPlainObject(settings.core) ? settings.core : {};
  // the value `ogw game init` wrote, while no human changed it
  const [limitKey, limit] = TEST_TIME_LIMIT;
  if (written[limitKey] === limit) add(['core', limitKey], limit, 'ogw game init', moduleOf(limitKey), meanings.get(limitKey) ?? null);
  for (const [key, value] of Object.entries(core.settings)) {
    if (!used.has(moduleOf(key))) continue;
    const meaning = meanings.get(key) ?? null;
    // a key nothing of which is written is one value; a partly written object gives the leaves not written
    if (written[key] === undefined) add(['core', key], value, 'core settings', moduleOf(key), meaning);
    else for (const leaf of addedLeaves(written[key], value, ['core', key])) add(leaf.path, leaf.value, 'core settings', moduleOf(key), meaning);
  }
  const groupRank = (v: DefaultValue): [number, string] =>
    v.group === TO_KNOW_GROUP ? [0, String(toKnowRank(v.path)).padStart(4, '0')] : v.group === GAME_GROUP ? [1, ''] : [2, v.group];
  return out
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const [ra, ka] = groupRank(a.v);
      const [rb, kb] = groupRank(b.v);
      return ra - rb || compareBytes(ka, kb) || a.i - b.i;
    })
    .map(({ v }) => v);
}

/** One `## <group>` heading per group and one `<path> = <display> (<source>): <meaning>` line per value. */
export function defaultsText(values: readonly DefaultValue[]): string {
  const lines: string[] = [];
  let group: string | null = null;
  for (const v of values) {
    if (v.group !== group) {
      if (group !== null) lines.push('');
      lines.push(`## ${v.group}`);
      group = v.group;
    }
    lines.push(`${v.path} = ${v.display} (${v.source})${v.meaning === null ? '' : `: ${v.meaning}`}`);
  }
  return lines.join('\n');
}
