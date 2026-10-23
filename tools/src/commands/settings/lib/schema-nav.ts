import { isIndex, isPlainObject, type JsonObject, type Segments } from './json-path.ts';

/** A schema node and the document its local `$ref`s resolve against. */
export interface SchemaNode {
  node: JsonObject;
  root: JsonObject;
}

const MAX_DEPTH = 32;

function resolveRef(ref: string, root: JsonObject): JsonObject | null {
  if (!ref.startsWith('#/')) return null;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    current = isPlainObject(current) ? current[part] : undefined;
  }
  return isPlainObject(current) ? current : null;
}

/** The node with the nodes its `$ref` and `allOf` stand for. */
export function expand(start: SchemaNode, depth = 0): SchemaNode[] {
  if (depth > MAX_DEPTH) return [];
  const out: SchemaNode[] = [start];
  const { node, root } = start;
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root);
    if (target) out.push(...expand({ node: target, root }, depth + 1));
  }
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) if (isPlainObject(part)) out.push(...expand({ node: part, root }, depth + 1));
  }
  return out;
}

function matchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(key);
  } catch {
    return false;
  }
}

function childOfNode(start: SchemaNode, segment: string): JsonObject[] {
  const { node } = start;
  const properties = node.properties;
  if (isPlainObject(properties) && isPlainObject(properties[segment])) return [properties[segment]];
  if (isIndex(segment) && isPlainObject(node.items)) return [node.items];
  const out: JsonObject[] = [];
  if (isPlainObject(node.patternProperties)) {
    for (const [pattern, schema] of Object.entries(node.patternProperties)) {
      if (isPlainObject(schema) && matchesPattern(pattern, segment)) out.push(schema);
    }
  }
  if (out.length === 0 && isPlainObject(node.additionalProperties)) out.push(node.additionalProperties);
  return out;
}

/** Schema nodes for the value under `segment` of a value described by `nodes`. */
export function child(nodes: readonly SchemaNode[], segment: string): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const start of nodes) {
    for (const expanded of expand(start)) {
      for (const node of childOfNode(expanded, segment)) out.push({ node, root: expanded.root });
    }
  }
  return out;
}

/** `x-owner` declared on any of the nodes (after `$ref` and `allOf`), or undefined. */
export function ownerOf(nodes: readonly SchemaNode[]): string | undefined {
  for (const start of nodes) {
    for (const { node } of expand(start)) {
      const owner = node['x-owner'];
      if (typeof owner === 'string') return owner;
    }
  }
  return undefined;
}

/**
 * Whether a game settings path is a build stage value: a node on the path (after `$ref` and `allOf`) declares
 * `x-stage` `build`. `ogw game check` without `--build` does not need it (`game-setup` skill).
 */
export function isBuildStage(schema: JsonObject, segments: readonly string[]): boolean {
  let nodes: SchemaNode[] = [{ node: schema, root: schema }];
  for (const segment of segments) {
    nodes = child(nodes, segment);
    if (nodes.some((start) => expand(start).some(({ node }) => node['x-stage'] === 'build'))) return true;
    if (nodes.length === 0) return false;
  }
  return false;
}

export interface Located {
  nodes: SchemaNode[];
  /** Effective `x-owner`: the one declared on the deepest node of the path that declares one. */
  owner: string | undefined;
}

/** Walks the path from `start`. `switchAt` replaces the nodes after a segment (core settings keys of game settings `core`). */
export function locate(
  start: SchemaNode[],
  segments: Segments,
  switchAt?: (done: Segments, nodes: SchemaNode[]) => SchemaNode[] | null,
): Located {
  let nodes = start;
  let owner = ownerOf(nodes);
  for (let i = 0; i < segments.length; i++) {
    const done = segments.slice(0, i + 1);
    nodes = switchAt?.(done, nodes) ?? child(nodes, segments[i] as string);
    if (nodes.length === 0) return { nodes, owner };
    owner = ownerOf(nodes) ?? owner;
  }
  return { nodes, owner };
}

export interface SchemaInfo {
  description?: string;
  type?: unknown;
  allowed: Record<string, unknown>;
  default?: unknown;
}

const ALLOWED_KEYWORDS = ['enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format'] as const;

/** description, type, allowed values and default of the nodes; the first node that gives one wins. */
export function infoOf(nodes: readonly SchemaNode[]): SchemaInfo {
  const info: SchemaInfo = { allowed: {} };
  for (const start of nodes) {
    for (const { node } of expand(start)) {
      if (info.description === undefined && typeof node.description === 'string') info.description = node.description;
      if (info.type === undefined && node.type !== undefined) info.type = node.type;
      if (info.default === undefined && node.default !== undefined) info.default = node.default;
      for (const keyword of ALLOWED_KEYWORDS) {
        if (info.allowed[keyword] === undefined && node[keyword] !== undefined) info.allowed[keyword] = node[keyword];
      }
    }
  }
  return info;
}

/** Property names under the nodes, in schema order. */
export function propertyNames(nodes: readonly SchemaNode[]): string[] {
  const names: string[] = [];
  for (const start of nodes) {
    for (const { node } of expand(start)) {
      if (!isPlainObject(node.properties)) continue;
      for (const name of Object.keys(node.properties)) if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Every property path under the nodes (object properties only, not array items or maps). */
export function propertyPaths(nodes: readonly SchemaNode[], prefix: Segments = [], depth = 0): string[][] {
  if (depth > MAX_DEPTH) return [];
  const out: string[][] = [];
  for (const name of propertyNames(nodes)) {
    const path = [...prefix, name];
    out.push(path);
    out.push(...propertyPaths(child(nodes, name), path, depth + 1));
  }
  return out;
}

/** Abbreviations whose `.` does not end a sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs)$/i;

/** First sentence of a description: the text up to the first `.` followed by white space that does not end an abbreviation. */
export function firstSentence(description: string | undefined): string {
  if (description === undefined) return '';
  for (const m of description.matchAll(/\.(?=\s)/gu)) {
    const head = description.slice(0, m.index);
    if (!ABBREVIATION.test(head)) return `${head}.`;
  }
  return description;
}
