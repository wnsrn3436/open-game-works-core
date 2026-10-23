import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { resolveCoreImpl, type GameRepo } from '../../../lib/game.ts';
import { currentHost, type HostIdentity } from '../../../lib/host.ts';
import { gameSettingsPath, harnessSettingsPath, HOST_KEYS, hostEntryId, loadSchema, schemaPath, withGameSettingsLock } from '../../../lib/settings.ts';
import { coreFiles, coreKeys, matchCoreKey, readObject, type CoreFiles } from './core-files.ts';
import { isPlainObject, type ContainerKind, type JsonObject, type Segments } from './json-path.ts';
import { infoOf, locate, type Located, type SchemaNode } from './schema-nav.ts';

export type TargetKind = 'harness' | 'game' | 'core';

/** A settings file that `ogw settings` reads and writes. */
export interface Target {
  kind: TargetKind;
  /** `harness settings`, `game settings`, or `core settings`. */
  label: string;
  file: string;
  value: JsonObject;
  /** Schema of the file. */
  schema: JsonObject;
  game: GameRepo | null;
  /** `open-game-works-core-impl/` (or the `worktrees/_core/` worktree) for the `core` target. */
  coreImpl: string | null;
  /** Core release of game settings `coreVersion`, read once; for the `game` target only. */
  release(): Promise<CoreFiles>;
  /** This host, whose `hosts` entry holds the host keys of harness settings; for the `harness` target only. */
  host(): Promise<HostIdentity>;
  /** The id of this host's entry in the harness settings `hosts` value `hosts` (`hostEntryId`): null when it is empty; for the `harness` target only. */
  hostEntryId(hosts: unknown): Promise<string | null>;
}

function releaseOf(ctx: Context, value: JsonObject): () => Promise<CoreFiles> {
  let cached: Promise<CoreFiles> | null = null;
  return () => {
    if (typeof value.coreVersion !== 'string') return Promise.reject(new OgwError('game settings have no coreVersion'));
    cached ??= coreFiles(ctx, value.coreVersion);
    return cached;
  };
}

/** The target with another value: a game target's core release follows that value's `coreVersion`. */
export function withValue(ctx: Context, target: Target, value: JsonObject): Target {
  return { ...target, value, ...(target.kind === 'game' ? { release: releaseOf(ctx, value) } : {}) };
}

const noRelease = (): Promise<CoreFiles> => Promise.reject(new OgwError('only game settings have a core release'));
const noHost = (): Promise<never> => Promise.reject(new OgwError('only harness settings have host values'));

export async function harnessTarget(ctx: Context): Promise<Target> {
  const file = harnessSettingsPath(ctx.env);
  return {
    kind: 'harness',
    label: 'harness settings',
    file,
    value: await readObject(file),
    schema: (await loadSchema(schemaPath('harness-settings', ctx.env))) as JsonObject,
    game: null,
    coreImpl: null,
    release: noRelease,
    host: () => currentHost(ctx.env),
    hostEntryId: (hosts) => hostEntryId(hosts, ctx.env),
  };
}

export async function gameTarget(ctx: Context, name: string): Promise<Target> {
  const game = await ctx.game(name);
  const file = gameSettingsPath(game.root);
  const value = await readObject(file);
  return {
    kind: 'game',
    label: 'game settings',
    file,
    value,
    schema: (await loadSchema(schemaPath('game-settings', ctx.env))) as JsonObject,
    game,
    coreImpl: null,
    release: releaseOf(ctx, value),
    host: noHost,
    hostEntryId: noHost,
  };
}

export async function coreTarget(ctx: Context): Promise<Target> {
  const coreImpl = await resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
  const file = join(coreImpl, 'settings', 'core-settings.json');
  return {
    kind: 'core',
    label: 'core settings',
    file,
    value: await readObject(file),
    schema: await readObject(join(coreImpl, 'settings', 'core-settings.schema.json')),
    game: null,
    coreImpl,
    release: noRelease,
    host: noHost,
    hostEntryId: noHost,
  };
}

/** Reads `<target>` from the positionals: `harness`, `game <game>`, or `core`. Returns the target and the positionals after it. */
export async function openTarget(ctx: Context, positionals: readonly string[], usage: string): Promise<{ target: Target; rest: string[] }> {
  const [kind, name] = positionals;
  if (kind === 'harness') return { target: await harnessTarget(ctx), rest: positionals.slice(1) };
  if (kind === 'core') return { target: await coreTarget(ctx), rest: positionals.slice(1) };
  if (kind === 'game' && name !== undefined) return { target: await gameTarget(ctx, name), rest: positionals.slice(2) };
  throw new OgwError(`usage: ${usage}`);
}

/**
 * Runs `fn` with the target `openTarget` reads. A game target is read and written in the game settings lock
 * (`withGameSettingsLock`), so `fn` writes it from the read it was given.
 */
export async function withTarget<T>(
  ctx: Context,
  positionals: readonly string[],
  usage: string,
  fn: (opened: { target: Target; rest: string[] }) => Promise<T>,
): Promise<T> {
  const [kind, name] = positionals;
  if (kind !== 'game' || name === undefined) return fn(await openTarget(ctx, positionals, usage));
  const game = await ctx.game(name);
  return withGameSettingsLock(game.root, ctx.env, async () => fn(await openTarget(ctx, positionals, usage)));
}

/** Runs `fn` with the game settings target of `name` in the game settings lock (`withTarget`). */
export async function withGameTarget<T>(ctx: Context, name: string, fn: (target: Target) => Promise<T>): Promise<T> {
  const game = await ctx.game(name);
  return withGameSettingsLock(game.root, ctx.env, async () => fn(await gameTarget(ctx, name)));
}

function keyOf(keys: readonly string[], text: string, path: string): string {
  const key = matchCoreKey(keys, text);
  if (key === null) throw new OgwError(`no core settings key in ${path}`);
  return key;
}

function splitRest(rest: string, path: string): string[] {
  const parts = rest.split('.');
  if (parts.some((part) => part === '')) throw new OgwError(`invalid settings path: ${path}`);
  return parts;
}

/** Segments of `text` after the core settings key it starts with. */
function restOf(text: string, key: string, path: string): string[] {
  return text === key ? [] : splitRest(text.slice(key.length + 1), path);
}

/** True when the path of harness settings starts with a host key (`HOST_KEYS`): its value is in this host's `hosts` entry. */
export function isHostPath(target: Target, segments: Segments): boolean {
  return target.kind === 'harness' && (HOST_KEYS as readonly string[]).includes(segments[0] ?? '');
}

export interface PathOptions {
  /** The path is written with a value: a host key path is under this host's `hosts` entry even when `hosts` is empty. */
  create?: boolean;
}

/**
 * The path in the file: a host key path of harness settings is under `hosts.<this host id>`. When `hosts` is empty and
 * the path is not created, no host has an entry: the host id is not read and the path stays as given, whose schema is
 * the `hosts` entry schema (`locatePath`).
 */
export async function filePath(target: Target, segments: Segments, options: PathOptions = {}): Promise<string[]> {
  if (!isHostPath(target, segments)) return [...segments];
  const id = options.create === true ? (await target.host()).id : await target.hostEntryId(target.value.hosts);
  return id === null ? [...segments] : ['hosts', id, ...segments];
}

/** Splits a `.`-joined path. A core settings key is read as one segment. A harness settings host key path is under this host's `hosts` entry (`filePath`). */
export async function parsePath(target: Target, path: string, options: PathOptions = {}): Promise<string[]> {
  if (target.kind === 'core') {
    const key = keyOf(coreKeys(target.schema), path, path);
    return [key, ...restOf(path, key, path)];
  }
  if (target.kind === 'game' && path.startsWith('core.')) {
    const text = path.slice('core.'.length);
    const key = keyOf(coreKeys((await target.release()).schema), text, path);
    return ['core', key, ...restOf(text, key, path)];
  }
  return filePath(target, splitRest(path, path), options);
}

function startNodes(target: Target): SchemaNode[] {
  return [{ node: target.schema, root: target.schema }];
}

/** True when the path is `core.<core settings key>` of game settings or a path under it. */
export function isGameCoreKey(target: Target, segments: Segments): boolean {
  return target.kind === 'game' && segments[0] === 'core' && segments.length > 1;
}

/**
 * Schema nodes and effective `x-owner` of the path. `core.<key>` of game settings uses the release core settings schema.
 * A host key path of harness settings not under `hosts` uses the `hosts` entry schema.
 */
export async function locatePath(target: Target, segments: Segments): Promise<Located> {
  if (isHostPath(target, segments)) return locate(startNodes(target), ['hosts', '', ...segments]);
  if (!isGameCoreKey(target, segments)) return locate(startNodes(target), segments);
  const coreSchema = (await target.release()).schema;
  return locate(startNodes(target), segments, (done) => {
    if (done.length !== 2) return null;
    const properties = isPlainObject(coreSchema.properties) ? coreSchema.properties : {};
    const node = properties[done[1] as string];
    return isPlainObject(node) ? [{ node, root: coreSchema }] : [];
  });
}

/** Kind of each missing parent container of `segments`: an array when the schema makes it one. */
export async function containerKinds(target: Target, segments: Segments): Promise<ContainerKind> {
  const kinds: ('array' | 'object')[] = [];
  for (let n = 1; n < segments.length; n++) {
    const { nodes } = await locatePath(target, segments.slice(0, n));
    kinds.push(infoOf(nodes).type === 'array' ? 'array' : 'object');
  }
  return (parent) => kinds[parent.length - 1] ?? 'object';
}
