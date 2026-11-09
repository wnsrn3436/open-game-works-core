import { isDeepStrictEqual } from 'node:util';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import { localDefaults, localHarnessSettingsPath, nonLocalUnits, type HarnessSettingsFiles, type Role } from '../../../lib/settings.ts';
import { callerRole } from '../api.ts';
import { implConstraints } from './core-files.ts';
import { constraintIssues, gameIssues } from './game-check.ts';
import { changedPaths, display, getAt, isPlainObject, setAt, unsetAt, type JsonObject, type Segments } from './json-path.ts';
import { routeHarnessWrite, withoutInFiles } from './scope.ts';
import { locatePath, withValue, type Target, type TargetKind } from './target.ts';
import { schemaIssues, type Issue } from './validate.ts';
import { LOGOTYPE_METHOD } from '../../generation/api.ts';

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

/** The game settings `humanDecided` path that `path` equals or is below, or null. */
export function lockingPath(humanDecided: unknown, path: string): string | null {
  if (!Array.isArray(humanDecided)) return null;
  const lock = humanDecided.find((locked): locked is string => typeof locked === 'string' && (path === locked || path.startsWith(`${locked}.`)));
  return lock ?? null;
}

/**
 * One line per changed path the caller may not change: by its `x-owner`, and for a role other than `lead`, a game
 * settings path equal to or below a path of game settings `humanDecided`.
 */
export async function permissionIssues(ctx: Context, target: Target, next: JsonObject, allowTool: boolean): Promise<string[]> {
  const role = await callerRole(ctx);
  const lines: string[] = [];
  const denied: string[] = [];
  // the owner of a `core.` key of game settings comes from the core release of the `coreVersion` being written
  const result = withValue(ctx, target, next);
  // `humanDecided` itself is not a content item, so a role other than `lead` reads the locks it cannot change
  const humanDecided = target.kind === 'game' && role !== 'lead' ? target.value.humanDecided : undefined;
  for (const path of changedPaths(target.value, next)) {
    const text = display(path);
    if (denied.some((parent) => text.startsWith(`${parent}.`))) continue;
    const { owner } = await locatePath(result, path);
    if (!mayChange(role, target.kind, owner, allowTool)) {
      denied.push(text);
      lines.push(`role ${role} cannot change ${text}${owner === undefined ? '' : ` (x-owner ${owner})`}`);
      continue;
    }
    const lock = lockingPath(humanDecided, text);
    if (lock === null) continue;
    denied.push(text);
    lines.push(`role ${role} cannot change ${text}: a human decided ${lock} (humanDecided)`);
  }
  return lines;
}

/**
 * The condition of harness settings `imageMethod`: the value, or the schema default when there is none, is the `name`
 * of a `resourceGeneration` method whose `resourceTypes` has `image`.
 */
function imageMethodIssues(target: Target, value: JsonObject): Issue[] {
  const methods = Array.isArray(value.resourceGeneration) ? value.resourceGeneration : [];
  const makesImage = (name: string): boolean =>
    name !== LOGOTYPE_METHOD && methods.some((m) => isPlainObject(m) && m.name === name && Array.isArray(m.resourceTypes) && m.resourceTypes.includes('image'));
  const taken = value.imageMethod === undefined ? { path: 'imageMethod (schema default)', name: localDefaults(target.schema).imageMethod } : { path: 'imageMethod', name: value.imageMethod };
  // a value that is not a string is a schema issue
  if (typeof taken.name !== 'string' || makesImage(taken.name)) return [];
  return [{ message: `${taken.path}: ${taken.name} is not the name of a resourceGeneration method whose resourceTypes has image` }];
}

/**
 * Schema and condition issues of a settings value of the target. Game settings are checked at the build stage, so
 * unsetting a required build stage value is refused too.
 */
export async function settingsIssues(ctx: Context, target: Target, value: JsonObject): Promise<Issue[]> {
  if (target.kind === 'game') return gameIssues(ctx, target.game?.name ?? 'the game', value, true, 'build');
  const issues = schemaIssues(target.schema, value);
  if (target.kind === 'harness') issues.push(...imageMethodIssues(target, value));
  if (target.kind === 'core' && target.coreImpl !== null) {
    // core settings are filled one key at a time: a constraint counts once both of its keys have a value
    // (`ogw core release` checks that every constraint of an implemented side has both)
    const present = (await implConstraints(target.coreImpl)).filter((c) => c.left in value && c.right in value);
    issues.push(...constraintIssues(present, value, ''));
  }
  return issues;
}

/** `local` with the value of `value` at each of `units` that `value` has. */
function withUnits(local: JsonObject, units: readonly string[][], value: JsonObject): JsonObject {
  let out = local;
  for (const unit of units) {
    const at = getAt(value, unit);
    if (at !== undefined) out = setAt(out, unit, at, () => 'object');
  }
  return out;
}

/**
 * Writes the two harness settings files that hold `value` (`routeHarnessWrite`): a file whose value changes, or both
 * when the files on disk hold host items (`rewrite`). A file that receives values moved out of the other file is
 * written before that file, so that a stop between the writes loses no value: `settings.local.json` receives the host
 * items (`rewrite`), and `settings.json` the paths of `settings.local.json` that are not local-scope. When both move,
 * `settings.local.json` is written first still holding the paths that leave it, then `settings.json`, then
 * `settings.local.json` without them.
 */
async function writeHarnessFiles(ctx: Context, target: Target, files: HarnessSettingsFiles, value: JsonObject): Promise<void> {
  const next = routeHarnessWrite(target.schema, files, value);
  const rewrite = files.rewrite === true;
  const writeLocal = async (local: JsonObject | null): Promise<void> => {
    if (local !== null && (rewrite || !isDeepStrictEqual(local, files.local))) await writeJsonAtomic(localHarnessSettingsPath(ctx.env), local);
  };
  const writeShared = async (): Promise<void> => {
    if (rewrite || !isDeepStrictEqual(next.shared, files.shared)) await writeJsonAtomic(target.file, next.shared);
  };
  const leaving = nonLocalUnits(target.schema, files.local);
  if (leaving.length === 0) {
    await writeLocal(next.local);
    await writeShared();
    return;
  }
  if (rewrite) await writeLocal(withUnits(next.local ?? {}, leaving, value));
  await writeShared();
  await writeLocal(next.local);
}

/**
 * Removes the harness settings path `segments`, which no schema node reaches, from `settings.local.json` and
 * `settings.json` after only the check of the caller's role against the `x-owner` on the path (ogw.md `## settings`):
 * the schema and the conditions of harness settings are not checked, so a value of another path that does not pass
 * them does not block the removal. `settings.local.json` is written first: it receives the host items when the files
 * on disk hold them (`rewrite`). False when neither file holds the path.
 */
export async function unsetUnreached(ctx: Context, target: Target, files: HarnessSettingsFiles, segments: Segments): Promise<boolean> {
  const next = unsetAt(target.value, segments);
  if (next === null) return false;
  const denied = await permissionIssues(ctx, target, next, false);
  if (denied.length > 0) throw new OgwError(denied.join('\n'), 1, { errors: denied });
  const out = withoutInFiles(files, segments);
  const rewrite = files.rewrite === true;
  if (out.local !== null && (rewrite || !isDeepStrictEqual(out.local, files.local))) await writeJsonAtomic(localHarnessSettingsPath(ctx.env), out.local);
  if (rewrite || !isDeepStrictEqual(out.shared, files.shared)) await writeJsonAtomic(target.file, out.shared);
  return true;
}

/**
 * Writes `next` to the target file when the caller may change every changed path and the result passes. A missing
 * required value blocks only when it is the path being unset, because settings are filled one value at a time
 * (`game-setup` 4). Harness settings `next` is the merged value, and is written to its two files (`writeHarnessFiles`).
 */
export async function writeChecked(ctx: Context, target: Target, next: JsonObject, options: WriteOptions = {}): Promise<void> {
  const denied = await permissionIssues(ctx, target, next, options.allowTool === true);
  if (denied.length > 0) throw new OgwError(denied.join('\n'), 1, { errors: denied });
  const issues = await settingsIssues(ctx, target, next);
  const blocking = issues.filter((i) => i.missing === undefined || i.missing === options.unsetPath).map((i) => i.message);
  if (blocking.length > 0) throw new OgwError(blocking.join('\n'), 1, { errors: blocking });
  if (target.files === null) await writeJsonAtomic(target.file, next);
  else await writeHarnessFiles(ctx, target, target.files, next);
}
