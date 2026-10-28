import { isDeepStrictEqual } from 'node:util';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject, mergeSettings, type JsonObject } from '../../../lib/json.ts';
import type { HarnessSettingsFiles } from '../../../lib/settings.ts';
import { display, getAt, setAt, unsetAt, type Segments } from './json-path.ts';
import { isLocalScope } from './schema-nav.ts';

/**
 * The paths whose value differs between `before` and `after`, as the units the merge of the two harness settings files
 * replaces whole: the walk goes down through objects only, so an array or another value is one unit. A value that
 * becomes an object is walked into, so each of its keys goes to the file of its own path.
 */
export function changedUnits(before: unknown, after: unknown, prefix: Segments = []): string[][] {
  if (isDeepStrictEqual(before, after)) return [];
  if (!isPlainObject(after) || (Object.keys(after).length === 0 && !isPlainObject(before))) return [[...prefix]];
  const old = isPlainObject(before) ? before : {};
  const out: string[][] = isPlainObject(before) || before === undefined ? [] : [[...prefix]];
  for (const key of new Set([...Object.keys(old), ...Object.keys(after)])) {
    out.push(...changedUnits(old[key], after[key], [...prefix, key]));
  }
  return out;
}

const objectParents = (): 'object' => 'object';

function without(value: JsonObject, segments: Segments): JsonObject {
  return unsetAt(value, segments) ?? value;
}

/**
 * The two files `settings.json` and `settings.local.json` that hold harness settings `next`, from the files `files`
 * now hold. A changed local-scope path (`isLocalScope`) and a changed path `settings.local.json` already holds are
 * written to `settings.local.json`, every other changed path to `settings.json`, and a removed value is removed from
 * both files. When the write changes this host's `hosts` entry (`hostId`) and `settings.json` still holds that entry,
 * the entry moves to `settings.local.json` in the same write. Another host's entry in `settings.json` stays. Fails
 * when the merged files would not be `next`.
 */
export function routeHarnessWrite(schema: JsonObject, files: HarnessSettingsFiles, hostId: string | null, next: JsonObject): HarnessSettingsFiles {
  let shared = files.shared;
  let local = files.local ?? {};
  const units = changedUnits(mergeSettings(shared, local), next);
  const sharedHosts = isPlainObject(shared.hosts) ? shared.hosts : {};
  if (hostId !== null && Object.hasOwn(sharedHosts, hostId) && units.some((u) => u[0] === 'hosts' && (u.length === 1 || u[1] === hostId))) {
    const entry = ['hosts', hostId];
    local = setAt(local, entry, mergeSettings(sharedHosts[hostId], getAt(local, entry) ?? {}), objectParents);
    shared = without(shared, entry);
  }
  for (const unit of units) {
    const value = getAt(next, unit);
    if (value === undefined) {
      shared = without(shared, unit);
      local = without(local, unit);
    } else if (isLocalScope(schema, unit) || getAt(local, unit) !== undefined) {
      local = setAt(local, unit, value, objectParents);
    } else {
      shared = setAt(shared, unit, value, objectParents);
    }
  }
  const merged = mergeSettings(shared, local);
  if (!isDeepStrictEqual(merged, next)) {
    const paths = changedUnits(merged, next).map(display);
    throw new OgwError(`cannot write harness settings: settings.local.json over settings.json does not give ${paths.join(', ')}`);
  }
  return { shared, local: files.local === null && Object.keys(local).length === 0 ? null : local };
}
