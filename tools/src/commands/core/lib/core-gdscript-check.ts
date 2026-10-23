/**
 * `godot` `## GDScript` rules for core code, checked from the source: `Variant` and untyped `Array`, `Dictionary`
 * (with the input boundary function exception), `OS.is_debug_build()` and `OS.has_feature()`, the forbidden table of name-string APIs, `assert`,
 * `create_tween()` and `Tween.tween_property()` outside `TweenCore`, `uid://` strings, and the
 * `Engine.get_singleton()` exception's `@warning_ignore("unsafe_method_access")` outside core adapters.
 */
import { forbiddenCall } from '../../check/static/forbidden-api.ts';
import { at, finding, type Finding } from '../../check/static/lib/context.ts';
import type { FuncDecl, GdFile } from '../../check/static/lib/gd-ast.ts';
import type { Token } from '../../check/static/lib/gd-lexer.ts';
import { callsOf, resolverFor } from '../../check/static/lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from '../../check/static/lib/gd-types.ts';
import { allClasses, callTarget, chainText, classFuncs } from '../../check/static/lib/gd-walk.ts';
import { isAdapterPath, moduleFolderOf } from './core-static-context.ts';
import { moduleFolder } from './impl.ts';

export const NAME = 'GDScript';

const INPUT_BOUNDARY = 'ogw:input_boundary';
/** Calls the content check forbids that `## GDScript` allows in core code. */
const NOT_CORE_RULES = new Set(['Engine.is_editor_hint']);
const TWEEN_CALLS = new Set(['create_tween', 'tween_property']);
const TWEEN_CORE = moduleFolder('TweenCore');

type Range = [number, number];

/** Index of the token that closes the bracket opened at `open`. */
function closerOf(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.type !== 'op') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Token range of a function's parameter list, parentheses included. */
function paramRange(file: GdFile, fn: FuncDecl): Range | null {
  for (let i = fn.t0; i <= fn.t1; i++) {
    const t = file.tokens[i] as Token;
    if (t.type === 'op' && t.text === '(') return [i, closerOf(file.tokens, i)];
    if (t.type === 'op' && t.text === ':') return null;
  }
  return null;
}

/**
 * Token ranges where an input boundary function may write `Variant` and untyped `Array`, `Dictionary`: its parameter
 * list and its body. Its return type is not one of them.
 */
function boundaryRanges(file: GdFile, fn: FuncDecl): Range[] {
  const params = paramRange(file, fn);
  const out: Range[] = params ? [params] : [];
  for (let i = params ? params[1] + 1 : fn.t0; i <= fn.t1; i++) {
    const t = file.tokens[i] as Token;
    if (t.type === 'op' && t.text === ':') {
      out.push([i + 1, fn.t1]);
      break;
    }
  }
  return out;
}

function isMarker(text: string): boolean {
  return text.trim() === INPUT_BOUNDARY;
}

/** Input boundary functions (marker comment on the line directly above the `func` line) and misplaced markers. */
export function inputBoundaries(file: GdFile): { ranges: Range[]; findings: Finding[] } {
  const markers = new Map(file.comments.filter((c) => !c.trailing && isMarker(c.text)).map((c) => [c.line, c]));
  const used = new Set<number>();
  const ranges: Range[] = [];
  for (const cls of allClasses(file.top)) {
    for (const fn of classFuncs(cls)) {
      if (!markers.has(fn.line - 1)) continue;
      used.add(fn.line - 1);
      ranges.push(...boundaryRanges(file, fn));
    }
  }
  const findings = file.comments
    .filter((c) => c.text.trim().startsWith(INPUT_BOUNDARY) && !used.has(c.line))
    .map((c) => finding(NAME, at(file.path, c.line), `\`# ${INPUT_BOUNDARY}\` is not a comment line of its own directly above a \`func\` line`));
  return { ranges, findings };
}

function inRanges(index: number, ranges: readonly Range[]): boolean {
  return ranges.some(([a, b]) => index >= a && index <= b);
}

function tokenProblem(t: Token, next: Token | undefined, boundary: readonly Range[]): string | null {
  if (t.type === 'str') return t.value.includes('uid://') ? '`uid://` string' : null;
  if (t.type !== 'name') return null;
  if (t.text === 'Variant') return inRanges(t.index, boundary) ? null : '`Variant` notation outside the parameters and body of an input boundary function';
  if ((t.text === 'Array' || t.text === 'Dictionary') && !(next?.type === 'op' && next.text === '[')) {
    return inRanges(t.index, boundary) ? null : `untyped \`${t.text}\` outside the parameters and body of an input boundary function`;
  }
  if (t.text === 'assert') return '`assert`';
  return null;
}

/** `@warning_ignore(...)` annotations that name `unsafe_method_access`, by line. */
function unsafeMethodIgnores(file: GdFile): number[] {
  const lines: number[] = [];
  file.tokens.forEach((t, i) => {
    const name = file.tokens[i + 1];
    if (t.type !== 'op' || t.text !== '@' || name?.type !== 'name' || !name.text.startsWith('warning_ignore')) return;
    const open = file.tokens[i + 2];
    if (open?.type !== 'op' || open.text !== '(') return;
    const args = file.tokens.slice(i + 3, closerOf(file.tokens, i + 2));
    if (args.some((a) => a.type === 'str' && a.value === 'unsafe_method_access')) lines.push(t.line);
  });
  return lines;
}

function tokenFindings(file: GdFile): Finding[] {
  const { ranges, findings } = inputBoundaries(file);
  const out = [...findings];
  for (const t of file.tokens) {
    const problem = tokenProblem(t, file.tokens[t.index + 1], ranges);
    if (problem) out.push(finding(NAME, at(file.path, t.line), problem));
  }
  if (!isAdapterPath(file.path)) {
    for (const line of unsafeMethodIgnores(file)) {
      out.push(finding(NAME, at(file.path, line), '`@warning_ignore("unsafe_method_access")` outside a core adapter'));
    }
  }
  return out;
}

async function callFindings(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out: Finding[] = [];
  const inTweenCore = moduleFolderOf(file.path) === TWEEN_CORE;
  const cache = new Map<unknown, TypeResolver>();
  for (const { call, scope } of callsOf(file)) {
    const chain = chainText(call.callee);
    if (chain !== null && NOT_CORE_RULES.has(chain)) continue;
    if (inTweenCore && TWEEN_CALLS.has(callTarget(call)?.name ?? '')) continue;
    const why = await forbiddenCall(call, resolverFor(index, file, scope, cache));
    if (why) out.push(finding(NAME, at(file.path, call.line), why));
  }
  return out;
}

/** `## GDScript` findings of one core file. */
export async function gdscriptFindings(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  return [...tokenFindings(file), ...(await callFindings(file, index))];
}
