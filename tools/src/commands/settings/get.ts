import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { withDefaults } from '../../lib/settings.ts';
import { display, getAt, isIndex, isPlainObject, mergeSettings, type JsonObject, type Segments } from './lib/json-path.ts';
import { expand, infoOf } from './lib/schema-nav.ts';
import { isGameCoreKey, locatePath, openTarget, parsePath, type Target } from './lib/target.ts';

export interface ResolvedValue {
  value: unknown;
  /**
   * `harness settings`, `local harness settings`, `local harness settings over harness settings`, `game settings`,
   * `game settings over core settings`, `core settings`, or `schema default`.
   */
  source: string;
  /**
   * True when the value is written in the target file at the path itself (not a core settings key of game settings,
   * not a value of `settings.local.json`).
   */
  written: boolean;
}

/** Game settings whose `core.<key>` is the used value: game settings `core` merged over the release value (core SKILL `## core settings`). */
function withUsedCoreKey(target: Target, release: JsonObject, key: string): JsonObject {
  const fromCore = getAt(release, [key]);
  const fromGame = getAt(target.value, ['core', key]);
  const used = fromGame === undefined ? fromCore : mergeSettings(fromCore, fromGame);
  const core = isPlainObject(target.value.core) ? target.value.core : {};
  return { ...target.value, core: { ...core, [key]: used } };
}

/** Where the used value of a game settings `core.<key>` path comes from. */
function coreKeySource(written: unknown, release: JsonObject, segments: Segments): string {
  if (written === undefined) return 'core settings';
  return isPlainObject(written) && isPlainObject(getAt(release, segments.slice(1))) ? 'game settings over core settings' : 'game settings';
}

/** True when the schema gives the value at the path array `items` (an index under it is an array element). */
async function isArrayPath(target: Target, segments: Segments): Promise<boolean> {
  const { nodes } = await locatePath(target, segments);
  return nodes.some((start) => expand(start).some(({ node }) => isPlainObject(node.items)));
}

/** False when the path goes through an array element the used value does not have, or under a value that is not an object or array. */
async function elementsExist(target: Target, used: unknown, segments: Segments): Promise<boolean> {
  let current = used;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (Array.isArray(current)) {
      if (!isIndex(segment) || Number(segment) >= current.length) return false;
    } else if (current !== undefined && !isPlainObject(current)) {
      return false;
    } else if (current === undefined && isIndex(segment) && (await isArrayPath(target, segments.slice(0, i)))) {
      return false;
    }
    current = getAt(current, [segment]);
  }
  return true;
}

/** Where a value written at the path comes from: harness settings take it from `settings.local.json` when that file has one. */
function writtenSource(target: Target, segments: Segments): Pick<ResolvedValue, 'source' | 'written'> {
  const local = target.files?.local ?? null;
  const fromLocal = local === null ? undefined : getAt(local, segments);
  if (fromLocal === undefined) return { source: target.label, written: true };
  const fromShared = getAt(target.files?.shared, segments);
  const over = isPlainObject(fromLocal) && isPlainObject(fromShared);
  return { source: over ? 'local harness settings over harness settings' : 'local harness settings', written: false };
}

interface Used {
  resolved: ResolvedValue | null;
  /** The whole used value (game settings with the used core settings key, or the file filled with schema defaults). */
  used: unknown;
}

async function usedValue(target: Target, segments: Segments): Promise<Used> {
  const written = getAt(target.value, segments);
  if (isGameCoreKey(target, segments)) {
    const release = (await target.release()).settings;
    const used = withUsedCoreKey(target, release, segments[1] as string);
    const value = getAt(used, segments);
    const source = coreKeySource(written, release, segments);
    return { resolved: value === undefined ? null : { value, source, written: false }, used };
  }
  if (written !== undefined) return { resolved: { value: written, ...writtenSource(target, segments) }, used: target.value };
  const used = withDefaults(target.schema, target.value);
  const filled = getAt(used, segments);
  return { resolved: filled === undefined ? null : { value: filled, source: 'schema default', written: false }, used };
}

/** The value used at the path and where it comes from; null when nothing gives a value. */
export async function resolveValue(target: Target, segments: Segments): Promise<ResolvedValue | null> {
  const { resolved, used } = await usedValue(target, segments);
  if (resolved) return resolved;
  if (!(await elementsExist(target, used, segments))) return null;
  const { default: fallback } = infoOf((await locatePath(target, segments)).nodes);
  return fallback === undefined ? null : { value: fallback, source: 'schema default', written: false };
}

export const get: CommandDef = {
  name: ['settings', 'get'],
  usage: 'ogw settings get <harness|game <game>|core> <path>',
  async run(ctx, args) {
    const { target, rest } = await openTarget(ctx, args.positionals, this.usage);
    expectPositionals({ ...args, positionals: rest }, 1, 1, this.usage);
    const segments = await parsePath(target, rest[0] as string);
    const path = display(segments);
    const resolved = await resolveValue(target, segments);
    if (!resolved) {
      const { nodes } = await locatePath(target, segments);
      throw new OgwError(nodes.length === 0 ? `not a settings path: ${path}` : `no value: ${path}`);
    }
    const json = JSON.stringify(resolved.value, null, 2);
    return {
      text: resolved.written ? json : `${json}\nsource: ${resolved.source}`,
      data: { path, value: resolved.value, source: resolved.source },
    };
  },
};
