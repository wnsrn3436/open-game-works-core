import type { Expr, GdFile, VarDecl } from './gd-ast.ts';
import type { Variant } from './tscn.ts';

/** Red, green, blue and alpha of a color, each in 0..1. */
export type Rgba = [number, number, number, number];

/** True when the color has a tint: red, green or blue is not 1 (`client-content` Godot `## scene and prefab`). */
export function isTint(color: Rgba): boolean {
  return color[0] !== 1 || color[1] !== 1 || color[2] !== 1;
}

/** The color of a `Color(r, g, b[, a])` value written in a `.tscn` or `.tres`, or null for another value. */
export function variantColor(value: Variant | undefined): Rgba | null {
  if (value?.t !== 'call' || value.name !== 'Color') return null;
  const nums = value.args.map((a) => (a.t === 'num' ? a.v : null));
  if (nums.some((n) => n === null)) return null;
  return fromNumbers(nums as number[]);
}

function fromNumbers(nums: readonly number[]): Rgba | null {
  if (nums.length === 0) return [0, 0, 0, 1];
  if (nums.length === 3) return [nums[0] as number, nums[1] as number, nums[2] as number, 1];
  if (nums.length === 4) return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
  return null;
}

/** The value of a number literal expression (an optional `-` or `+` before a number), or null. */
function numberOf(e: Expr): number | null {
  if (e.k === 'num') {
    const text = e.text.replaceAll('_', '');
    const n = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : /^0b/i.test(text) ? Number.parseInt(text.slice(2), 2) : Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (e.k === 'unary' && (e.op === '-' || e.op === '+')) {
    const inner = numberOf(e.expr);
    return inner === null ? null : e.op === '-' ? -inner : inner;
  }
  return null;
}

/** The color of an HTML color string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or without `#`) or a named color string. */
export function stringColor(text: string): Rgba | null {
  const hex = /^#?([0-9a-f]+)$/i.exec(text.trim());
  if (hex) {
    const digits = hex[1] as string;
    const short = digits.length === 3 || digits.length === 4;
    if (!short && digits.length !== 6 && digits.length !== 8) return null;
    const step = short ? 1 : 2;
    const parts = Array.from({ length: digits.length / step }, (_, i) => Number.parseInt(digits.slice(i * step, i * step + step).repeat(short ? 2 : 1), 16) / 255);
    return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] ?? 1];
  }
  return namedColor(text.trim().replaceAll(' ', '_').toUpperCase());
}

/**
 * A named color of Godot (`Color.RED`, `Color("red")`): white red, green and blue only for `WHITE` and `TRANSPARENT`, and
 * a color that is not white for any other name, which is all this check reads of it.
 */
function namedColor(name: string): Rgba | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
  if (name === 'WHITE') return [1, 1, 1, 1];
  if (name === 'TRANSPARENT') return [1, 1, 1, 0];
  return [0, 0, 0, 1];
}

/** The `const` declarations of the script class of a file, by name. */
export function scriptConsts(file: GdFile): Map<string, VarDecl> {
  const out = new Map<string, VarDecl>();
  for (const s of file.top.body) if (s.k === 'var' && s.isConst) out.set(s.name, s);
  return out;
}

/**
 * The color of a `Color` value written in code: a `Color()` or `Color8()` call of number literals, a `Color()` of a string
 * literal, a `Color` constant, or a name of a `const` of the script that holds one of these. Null for any other value.
 */
export function codeColor(e: Expr, consts: ReadonlyMap<string, VarDecl>, seen: ReadonlySet<string> = new Set()): Rgba | null {
  if (e.k === 'member' && e.obj.k === 'name' && e.obj.name === 'Color') return namedColor(e.name);
  if (e.k === 'name') {
    const decl = consts.get(e.name);
    if (!decl?.value || seen.has(e.name)) return null;
    return codeColor(decl.value, consts, new Set([...seen, e.name]));
  }
  if (e.k !== 'call' || e.callee.k !== 'name') return null;
  return callColor(e.callee.name, e.args);
}

/** The color of a `Color()` or `Color8()` call written in code, or null. */
function callColor(name: string, args: readonly Expr[]): Rgba | null {
  const first = args[0];
  if (name === 'Color' && args.length === 1 && first?.k === 'str') return stringColor(first.value);
  const nums = args.map(numberOf);
  if (nums.some((n) => n === null)) return null;
  if (name === 'Color') return fromNumbers(nums as number[]);
  if (name !== 'Color8' || (nums.length !== 3 && nums.length !== 4)) return null;
  const [r, g, b, a] = nums as number[];
  return [(r as number) / 255, (g as number) / 255, (b as number) / 255, (a ?? 255) / 255];
}

export function colorText(color: Rgba): string {
  return `Color(${color.map((c) => String(Math.round(c * 1000) / 1000)).join(', ')})`;
}
