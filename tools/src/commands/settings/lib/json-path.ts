import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject, type JsonObject } from '../../../lib/json.ts';

/** A settings path split into keys. A core settings key is one segment although it holds `.`. */
export type Segments = readonly string[];

export { isPlainObject, mergeSettings, type JsonObject } from '../../../lib/json.ts';

const INDEX = /^(0|[1-9][0-9]*)$/;

export function isIndex(segment: string): boolean {
  return INDEX.test(segment);
}

export function display(segments: Segments): string {
  return segments.join('.');
}

/** The value at the path, or undefined when the path has no value. */
export function getAt(value: unknown, segments: Segments): unknown {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!isIndex(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Kind of container to create for a missing parent at `segments` (the path of the container). */
export type ContainerKind = (segments: Segments) => 'array' | 'object';

function childOf(parent: unknown, segment: string, path: Segments): unknown {
  if (Array.isArray(parent)) return parent[arrayIndex(parent, segment, path)];
  if (isPlainObject(parent)) return Object.hasOwn(parent, segment) ? parent[segment] : undefined;
  throw new OgwError(`${display(path.slice(0, -1))} is not an object or array`);
}

function arrayIndex(array: unknown[], segment: string, path: Segments): number {
  if (!isIndex(segment)) throw new OgwError(`${display(path)}: ${segment} is not an array index`);
  const index = Number(segment);
  if (index > array.length) throw new OgwError(`${display(path)}: index ${segment} is past the end of the array`);
  return index;
}

function put(parent: unknown, segment: string, value: unknown, path: Segments): void {
  if (Array.isArray(parent)) {
    parent[arrayIndex(parent, segment, path)] = value;
    return;
  }
  (parent as JsonObject)[segment] = value;
}

/** Returns a copy of `root` with `value` at the path. Missing parents are created. */
export function setAt(root: JsonObject, segments: Segments, value: unknown, kind: ContainerKind): JsonObject {
  if (segments.length === 0) throw new OgwError('empty settings path');
  const copy = structuredClone(root);
  let parent: unknown = copy;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    const here = segments.slice(0, i + 1);
    let child = childOf(parent, segment, here);
    if (child === undefined) {
      child = kind(here) === 'array' ? [] : {};
      put(parent, segment, child, here);
    }
    parent = child;
  }
  const last = segments[segments.length - 1] as string;
  if (!Array.isArray(parent) && !isPlainObject(parent)) throw new OgwError(`${display(segments.slice(0, -1))} is not an object or array`);
  put(parent, last, structuredClone(value), segments);
  return copy;
}

/** Returns a copy of `root` without the value at the path, or null when the path has no value. */
export function unsetAt(root: JsonObject, segments: Segments): JsonObject | null {
  if (segments.length === 0) throw new OgwError('empty settings path');
  if (getAt(root, segments) === undefined) return null;
  const copy = structuredClone(root);
  const parent = getAt(copy, segments.slice(0, -1));
  const last = segments[segments.length - 1] as string;
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else Reflect.deleteProperty(parent as JsonObject, last);
  return copy;
}

function isContainer(value: unknown): value is JsonObject | unknown[] {
  return Array.isArray(value) || isPlainObject(value);
}

function childKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, i) => String(i));
  return isPlainObject(value) ? Object.keys(value) : [];
}

/** Paths whose value differs between `before` and `after`: every changed leaf and every changed container. */
export function changedPaths(before: unknown, after: unknown, prefix: Segments = []): string[][] {
  if (!isContainer(before) && !isContainer(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [[...prefix]];
  }
  const out: string[][] = [];
  const bothSameKind = Array.isArray(before) === Array.isArray(after) && isContainer(before) && isContainer(after);
  if (!bothSameKind) out.push([...prefix]);
  const keys = [...new Set([...childKeys(before), ...childKeys(after)])];
  for (const key of keys) {
    out.push(...changedPaths(getAt(before, [key]), getAt(after, [key]), [...prefix, key]));
  }
  return out;
}

/** Leaf paths that `filled` has and `original` does not, with their values. */
export function addedLeaves(original: unknown, filled: unknown, prefix: Segments = []): { path: string[]; value: unknown }[] {
  if (original === undefined) {
    if (isPlainObject(filled) && Object.keys(filled).length > 0) {
      return Object.keys(filled).flatMap((key) => addedLeaves(undefined, filled[key], [...prefix, key]));
    }
    return [{ path: [...prefix], value: filled }];
  }
  if (Array.isArray(original) && Array.isArray(filled)) {
    return filled.flatMap((item, i) => addedLeaves(original[i], item, [...prefix, String(i)]));
  }
  if (!isPlainObject(original) || !isPlainObject(filled)) return [];
  return Object.keys(filled).flatMap((key) => addedLeaves(original[key], filled[key], [...prefix, key]));
}
