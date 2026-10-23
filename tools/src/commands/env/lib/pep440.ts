/** PEP 440 versions and specifiers, and PEP 508 requirements, as far as pinning dependencies needs. */

import { OgwError } from '../../../lib/errors.ts';

export interface Version {
  epoch: number;
  release: number[];
  /** Pre-release as [kind order, number]: a=0, b=1, rc=2. */
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
}

const VERSION = new RegExp(
  [
    '^v?(?:(?<epoch>\\d+)!)?(?<release>\\d+(?:\\.\\d+)*)',
    '(?:[-_.]?(?<preL>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<preN>\\d+)?)?',
    '(?:-(?<postN1>\\d+)|[-_.]?(?<postL>post|rev|r)[-_.]?(?<postN2>\\d+)?)?',
    '(?:[-_.]?(?<devL>dev)[-_.]?(?<devN>\\d+)?)?',
    '(?:\\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$',
  ].join(''),
  'i',
);

const PRE_ORDER: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parseVersion(text: string): Version | null {
  const g = VERSION.exec(text.trim())?.groups;
  if (!g) return null;
  const preKind = g.preL?.toLowerCase();
  const post = g.postN1 ?? (g.postL === undefined ? undefined : (g.postN2 ?? '0'));
  return {
    epoch: Number(g.epoch ?? 0),
    release: (g.release as string).split('.').map(Number),
    pre: preKind === undefined ? null : [PRE_ORDER[preKind] as number, Number(g.preN ?? 0)],
    post: post === undefined ? null : Number(post),
    dev: g.devL === undefined ? null : Number(g.devN ?? 0),
  };
}

function compareRelease(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Sort keys of the parts after the release: a dev-only release sorts before its pre-releases. */
function preKey(v: Version): number[] {
  if (v.pre !== null) return [v.pre[0], v.pre[1]];
  if (v.post === null && v.dev !== null) return [-1, 0];
  return [3, 0];
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  return (
    Math.sign(a.epoch - b.epoch) ||
    compareRelease(a.release, b.release) ||
    compareNumbers(preKey(a), preKey(b)) ||
    compareNumbers([a.post ?? -1], [b.post ?? -1]) ||
    compareNumbers([a.dev ?? Infinity], [b.dev ?? Infinity])
  );
}

export function isPrerelease(v: Version): boolean {
  return v.pre !== null || v.dev !== null;
}

function prefixMatch(v: Version, prefix: string): boolean {
  const wanted = prefix.split('.').map(Number);
  return wanted.every((n, i) => (v.release[i] ?? 0) === n);
}

/** True when the version satisfies one specifier such as `>=1.2`, `~=2.0`, `==3.*`, `!=1.5`. */
export function satisfies(v: Version, specifier: string): boolean {
  const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(.+)$/.exec(specifier.trim());
  if (!m) return false;
  const op = m[1] as string;
  const target = (m[2] as string).trim();
  if ((op === '==' || op === '!=') && target.endsWith('.*')) {
    const match = prefixMatch(v, target.slice(0, -2));
    return op === '==' ? match : !match;
  }
  const t = parseVersion(target);
  if (!t) return false;
  const c = compareVersions(v, t);
  if (op === '~=') {
    const prefix = t.release.slice(0, Math.max(1, t.release.length - 1)).join('.');
    return c >= 0 && prefixMatch(v, prefix);
  }
  const results: Record<string, boolean> = { '==': c === 0, '===': c === 0, '!=': c !== 0, '<=': c <= 0, '>=': c >= 0, '<': c < 0, '>': c > 0 };
  return results[op] as boolean;
}

export interface Requirement {
  name: string;
  extras: string;
  specifiers: string[];
  marker: string | null;
  /** `name @ url` requirements keep their text. */
  url: string | null;
}

/** Parses a PEP 508 requirement string. */
export function parseRequirement(text: string): Requirement | null {
  const [main = '', ...markerParts] = text.split(';');
  const marker = markerParts.length > 0 ? markerParts.join(';').trim() : null;
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(main);
  if (!m) return null;
  const rest = (m[3] as string).trim();
  if (rest.startsWith('@')) return { name: m[1] as string, extras: m[2] ?? '', specifiers: [], marker, url: rest.slice(1).trim() };
  const specText = rest.replace(/^\(|\)$/g, '').trim();
  const specifiers = specText === '' ? [] : specText.split(',').map((s) => s.trim());
  return { name: m[1] as string, extras: (m[2] ?? '').replace(/\s+/g, ''), specifiers, marker, url: null };
}

/** The highest version that satisfies every specifier; pre-releases only when a specifier names one. */
export function highestMatching(versions: readonly string[], specifiers: readonly string[]): string | null {
  const allowPre = specifiers.some((s) => {
    const v = parseVersion(s.replace(/^[~=!<>]+/, '').trim());
    return v !== null && isPrerelease(v);
  });
  let best: { text: string; version: Version } | null = null;
  for (const text of versions) {
    const version = parseVersion(text);
    if (!version || (!allowPre && isPrerelease(version))) continue;
    if (!specifiers.every((s) => satisfies(version, s))) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { text, version };
  }
  return best?.text ?? null;
}

export interface MarkerHost {
  sys_platform: string;
  platform_system: string;
  os_name: string;
  platform_machine: string;
}

/** One comparison of a marker: a marker variable, an operator and the quoted value. */
export type MarkerCompare = (variable: string, op: string, value: string) => boolean;

interface MarkerToken {
  kind: 'open' | 'close' | 'value' | 'op' | 'and' | 'or' | 'variable';
  text: string;
}

const MARKER_TOKEN = /\s*(?:(\()|(\))|"([^"]*)"|'([^']*)'|(===|==|!=|<=|>=|~=|<|>|not\s+in\b|in\b)|(and|or)\b|([A-Za-z_][A-Za-z0-9_.]*))/y;

function markerTokens(marker: string): MarkerToken[] {
  const pattern = new RegExp(MARKER_TOKEN);
  const tokens: MarkerToken[] = [];
  while (marker.slice(pattern.lastIndex).trim() !== '') {
    const m = pattern.exec(marker);
    if (!m) throw new OgwError(`cannot read marker: ${marker}`);
    const [, open, close, double, single, op, word, variable] = m;
    if (open !== undefined) tokens.push({ kind: 'open', text: open });
    else if (close !== undefined) tokens.push({ kind: 'close', text: close });
    else if (op !== undefined) tokens.push({ kind: 'op', text: op.replace(/\s+/, ' ') });
    else if (word === 'and' || word === 'or') tokens.push({ kind: word, text: word });
    else if (variable !== undefined) tokens.push({ kind: 'variable', text: variable });
    else tokens.push({ kind: 'value', text: double ?? single ?? '' });
  }
  return tokens;
}

const FLIPPED: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

/**
 * Evaluates a PEP 508 marker: `and` binds before `or` and parentheses group. Each comparison of a
 * marker variable with a quoted value goes to `compare`; a value written on the left is moved to the
 * right. Throws when the marker cannot be read.
 */
export function evaluateMarker(marker: string, compare: MarkerCompare): boolean {
  const tokens = markerTokens(marker);
  let at = 0;
  const fail = (): never => {
    throw new OgwError(`cannot read marker: ${marker}`);
  };
  const next = (): MarkerToken => tokens[at++] ?? fail();
  const comparison = (first: MarkerToken): boolean => {
    const op = next();
    const second = next();
    if (op.kind !== 'op') return fail();
    if (first.kind === 'variable' && second.kind === 'value') return compare(first.text, op.text, second.text);
    if (first.kind === 'value' && second.kind === 'variable') return compare(second.text, FLIPPED[op.text] ?? op.text, first.text);
    return fail();
  };
  const atom = (): boolean => {
    const first = next();
    if (first.kind !== 'open') return comparison(first);
    const value = or();
    if (next().kind !== 'close') fail();
    return value;
  };
  const and = (): boolean => {
    let value = atom();
    while (tokens[at]?.kind === 'and') {
      at++;
      value = atom() && value;
    }
    return value;
  };
  function or(): boolean {
    let value = and();
    while (tokens[at]?.kind === 'or') {
      at++;
      value = and() || value;
    }
    return value;
  }
  const value = or();
  if (at !== tokens.length) fail();
  return value;
}

const HOST_VARIABLES: readonly string[] = ['sys_platform', 'platform_system', 'os_name', 'platform_machine'];

/** `==` and `!=` of `sys_platform`, `platform_system`, `os_name` and `platform_machine` against the host; any other comparison counts as true. */
export function compareHost(host: MarkerHost, variable: string, op: string, value: string): boolean {
  if (!HOST_VARIABLES.includes(variable) || (op !== '==' && op !== '!=')) return true;
  const equal = host[variable as keyof MarkerHost] === value;
  return op === '==' ? equal : !equal;
}

/** Evaluates a marker for this host with `compareHost`. */
export function markerHolds(marker: string | null, host: MarkerHost): boolean {
  if (marker === null) return true;
  return evaluateMarker(marker, (variable, op, value) => compareHost(host, variable, op, value));
}

export function markerHostOf(platform: string, arch: string): MarkerHost {
  const system: Record<string, string> = { darwin: 'Darwin', linux: 'Linux', win32: 'Windows' };
  const machine: Record<string, string> = { arm64: platform === 'darwin' ? 'arm64' : 'aarch64', x64: platform === 'win32' ? 'AMD64' : 'x86_64' };
  return {
    sys_platform: platform,
    platform_system: system[platform] ?? platform,
    os_name: platform === 'win32' ? 'nt' : 'posix',
    platform_machine: machine[arch] ?? arch,
  };
}
