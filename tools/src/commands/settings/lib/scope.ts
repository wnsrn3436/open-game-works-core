import { isDeepStrictEqual } from 'node:util';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject, mergeSettings, valueUnits, type JsonObject } from '../../../lib/json.ts';
import type { HarnessSettingsFiles } from '../../../lib/settings.ts';
import { display, getAt, setAt, unsetAt, type Segments } from './json-path.ts';
import { isLocalScope } from '../../../lib/schema-nav.ts';

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

/** `without` that also removes the objects of the path that it leaves empty: `settings.local.json` keeps no empty object. */
function withoutPruned(value: JsonObject, segments: Segments): JsonObject {
  let out = without(value, segments);
  for (let n = segments.length - 1; n >= 1; n--) {
    const parent = getAt(out, segments.slice(0, n));
    if (!isPlainObject(parent) || Object.keys(parent).length > 0) break;
    out = without(out, segments.slice(0, n));
  }
  return out;
}

/**
 * The two files `settings.json` and `settings.local.json` that hold harness settings `next`, from the files `files`
 * now hold. A changed local-scope path (`isLocalScope`) is written to `settings.local.json`, every other changed path
 * to `settings.json`, and a removed value is removed from both files. A path that `settings.local.json` holds and that
 * is not local-scope moves to `settings.json` with its value in `next` (AGENTS.md `## settings`). Fails when the merged
 * files would not be `next`.
 */
export function routeHarnessWrite(schema: JsonObject, files: HarnessSettingsFiles, next: JsonObject): HarnessSettingsFiles {
  let shared = files.shared;
  let local = files.local ?? {};
  const units = changedUnits(mergeSettings(shared, local), next);
  const outside = valueUnits(local).filter((unit) => !isLocalScope(schema, unit));
  for (const unit of [...units, ...outside]) {
    const value = getAt(next, unit);
    if (value === undefined) {
      shared = without(shared, unit);
      local = withoutPruned(local, unit);
    } else if (isLocalScope(schema, unit)) {
      local = setAt(local, unit, value, objectParents);
    } else {
      shared = setAt(shared, unit, value, objectParents);
      local = withoutPruned(local, unit);
    }
  }
  const merged = mergeSettings(shared, local);
  if (!isDeepStrictEqual(merged, next)) {
    const paths = changedUnits(merged, next).map(display);
    throw new OgwError(`cannot write harness settings: settings.local.json over settings.json does not give ${paths.join(', ')}`);
  }
  return { shared, local: files.local === null && Object.keys(local).length === 0 ? null : local };
}
