import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import { hostDefaults, type Role } from '../../../lib/settings.ts';
import { callerRole } from '../api.ts';
import { implConstraints } from './core-files.ts';
import { constraintIssues, gameIssues } from './game-check.ts';
import { changedPaths, display, isPlainObject, type JsonObject } from './json-path.ts';
import { locatePath, withValue, type Target, type TargetKind } from './target.ts';
import { schemaIssues, type Issue } from './validate.ts';

export interface WriteOptions {
  /** Let paths whose `x-owner` is `tool` change. */
  allowTool?: boolean;
  /** Path `unset` removes: its own missing value blocks the write. */
  unsetPath?: string;
}

/** Whether `role` may change a path of `kind` whose effective `x-owner` is `owner`. */
export function mayChange(role: Role | 'lead', kind: TargetKind, owner: string | undefined, allowTool: boolean): boolean {
  if (owner === 'tool' && !allowTool) return false;
  if (role === 'lead') return true;
  if (role === 'content') return kind === 'game' && owner === 'content';
  return role === 'core' && kind === 'core';
}

/** One line per changed path the caller may not change. */
export async function permissionIssues(ctx: Context, target: Target, next: JsonObject, allowTool: boolean): Promise<string[]> {
  const role = await callerRole(ctx);
  const lines: string[] = [];
  const denied: string[] = [];
  // the owner of a `core.` key of game settings comes from the core release of the `coreVersion` being written
  const result = withValue(ctx, target, next);
  for (const path of changedPaths(target.value, next)) {
    const text = display(path);
    if (denied.some((parent) => text.startsWith(`${parent}.`))) continue;
    const { owner } = await locatePath(result, path);
    if (mayChange(role, target.kind, owner, allowTool)) continue;
    denied.push(text);
    lines.push(`role ${role} cannot change ${text}${owner === undefined ? '' : ` (x-owner ${owner})`}`);
  }
  return lines;
}

/** `next` with the readable `name` of this host's `hosts` entry, when harness settings `next` has that entry. */
async function withHostName(target: Target, next: JsonObject): Promise<JsonObject> {
  const hosts = next.hosts;
  if (target.kind !== 'harness' || !isPlainObject(hosts)) return next;
  const id = await target.hostEntryId(hosts);
  if (id === null) return next;
  const entry = hosts[id];
  const { name } = await target.host();
  if (!isPlainObject(entry) || entry.name === name) return next;
  return { ...next, hosts: { ...hosts, [id]: { ...entry, name } } };
}

/**
 * The condition of harness settings `imageMethod`: the value each host takes, as `loadHarnessSettings` gives it (the
 * value of its `hosts` entry, else the schema default), is the `name` of a `resourceGeneration` method whose
 * `resourceTypes` has `image`. The hosts are every `hosts` entry and this host, also when it has no entry or `hosts`
 * is empty.
 */
async function imageMethodIssues(target: Target, value: JsonObject): Promise<Issue[]> {
  const hosts = isPlainObject(value.hosts) ? value.hosts : {};
  const id = await target.hostEntryId(value.hosts);
  const methods = Array.isArray(value.resourceGeneration) ? value.resourceGeneration : [];
  const makesImage = (name: string): boolean => methods.some((m) => isPlainObject(m) && m.name === name && Array.isArray(m.resourceTypes) && m.resourceTypes.includes('image'));
  const fallback = hostDefaults(target.schema).imageMethod;
  const taken: { path: string; name: unknown }[] = Object.entries(hosts).map(([entryId, entry]) => {
    const own = isPlainObject(entry) ? entry.imageMethod : undefined;
    const path = display(['hosts', entryId, 'imageMethod']);
    return own === undefined ? { path: `${path} (schema default)`, name: fallback } : { path, name: own };
  });
  // this host without an entry, or without a host id while hosts is empty, takes the schema default
  if (id === null || !(id in hosts)) taken.push({ path: 'imageMethod (schema default)', name: fallback });
  // a value that is not a string is a schema issue
  return taken
    .filter((t): t is { path: string; name: string } => typeof t.name === 'string' && !makesImage(t.name))
    .map((t) => ({ message: `${t.path}: ${t.name} is not the name of a resourceGeneration method whose resourceTypes has image` }));
}

/**
 * Schema and condition issues of a settings value of the target. Game settings are checked at the build stage, so
 * unsetting a required build stage value is refused too.
 */
export async function settingsIssues(ctx: Context, target: Target, value: JsonObject): Promise<Issue[]> {
  if (target.kind === 'game') return gameIssues(ctx, value, true, 'build');
  const issues = schemaIssues(target.schema, value);
  if (target.kind === 'harness') issues.push(...(await imageMethodIssues(target, value)));
  if (target.kind === 'core' && target.coreImpl !== null) {
    // core settings are filled one key at a time: a constraint counts once both of its keys have a value
    // (`ogw core release` checks that every constraint of an implemented side has both)
    const present = (await implConstraints(target.coreImpl)).filter((c) => c.left in value && c.right in value);
    issues.push(...constraintIssues(present, value, ''));
  }
  return issues;
}

/**
 * Writes `next` to the target file when the caller may change every changed path and the result
 * passes. The tool keeps the `name` of this host's harness settings `hosts` entry. A missing required value blocks only when it is the path being unset, because settings are
 * filled one value at a time (`game-setup` 4).
 */
export async function writeChecked(ctx: Context, target: Target, next: JsonObject, options: WriteOptions = {}): Promise<void> {
  const denied = await permissionIssues(ctx, target, next, options.allowTool === true);
  if (denied.length > 0) throw new OgwError(denied.join('\n'), 1, { errors: denied });
  const value = await withHostName(target, next);
  const issues = await settingsIssues(ctx, target, value);
  const blocking = issues.filter((i) => i.missing === undefined || i.missing === options.unsetPath).map((i) => i.message);
  if (blocking.length > 0) throw new OgwError(blocking.join('\n'), 1, { errors: blocking });
  await writeJsonAtomic(target.file, value);
}
