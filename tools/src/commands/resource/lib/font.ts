/** Reading the tables of a TrueType or OpenType font file: its family name and the characters it has glyphs for. */

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);

/** Offset and length of the table `tag`, or null when the file is not a font or has no such table. */
function table(data: Buffer, tag: string): { offset: number; length: number } | null {
  if (data.length < 12 || !SFNT_VERSIONS.has(data.readUInt32BE(0))) return null;
  const count = data.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (record + 16 > data.length) return null;
    if (data.toString('latin1', record, record + 4) !== tag) continue;
    const offset = data.readUInt32BE(record + 8);
    const length = data.readUInt32BE(record + 12);
    return offset + length <= data.length ? { offset, length } : null;
  }
  return null;
}

function utf16be(data: Buffer, start: number, length: number): string {
  let out = '';
  for (let i = 0; i + 1 < length; i += 2) out += String.fromCharCode(data.readUInt16BE(start + i));
  return out;
}

/**
 * The family name of the font, as font matching knows it: the typographic family (name ID 16) when it has one, else
 * the family (name ID 1), from an English (US) Windows Unicode record, else any Windows Unicode record, else a
 * Macintosh Roman one; null when the file has none of them.
 */
export function fontFamily(data: Buffer): string | null {
  const name = table(data, 'name');
  if (name === null) return null;
  const count = data.readUInt16BE(name.offset + 2);
  const strings = name.offset + data.readUInt16BE(name.offset + 4);
  const found = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const record = nameRecord(data, name.offset + 6 + i * 12, strings);
    if (record !== null && !found.has(record.key)) found.set(record.key, record.value);
  }
  for (const key of ['en16', 'en1', 'w16', 'w1', 'm16', 'm1']) {
    const value = found.get(key);
    if (value !== undefined) return value;
  }
  return null;
}

/** A family name record (ID 1 or 16) at `r`, keyed by its kind (`en` English Windows, `w` other Windows, `m` Mac) and ID. */
function nameRecord(data: Buffer, r: number, strings: number): { key: string; value: string } | null {
  const platform = data.readUInt16BE(r);
  const encoding = data.readUInt16BE(r + 2);
  const id = data.readUInt16BE(r + 6);
  const length = data.readUInt16BE(r + 8);
  const start = strings + data.readUInt16BE(r + 10);
  if ((id !== 1 && id !== 16) || start + length > data.length) return null;
  if (platform === 3 && (encoding === 1 || encoding === 10)) {
    return { key: `${data.readUInt16BE(r + 4) === 0x409 ? 'en' : 'w'}${String(id)}`, value: utf16be(data, start, length) };
  }
  if (platform === 1 && encoding === 0) return { key: `m${String(id)}`, value: data.toString('latin1', start, start + length) };
  return null;
}

/** The glyph a cmap subtable of format 4 or 12 at `at` maps `code` to; 0 when none. */
function lookup(data: Buffer, at: number, code: number): number {
  const format = data.readUInt16BE(at);
  if (format === 4) {
    if (code > 0xffff) return 0;
    const segments = data.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      if (code > data.readUInt16BE(ends + s * 2)) continue;
      const start = data.readUInt16BE(starts + s * 2);
      if (code < start) return 0;
      const rangeOffset = data.readUInt16BE(ranges + s * 2);
      if (rangeOffset === 0) return (code + data.readInt16BE(deltas + s * 2)) & 0xffff;
      const glyphAt = ranges + s * 2 + rangeOffset + (code - start) * 2;
      if (glyphAt + 2 > data.length) return 0;
      const glyph = data.readUInt16BE(glyphAt);
      return glyph === 0 ? 0 : (glyph + data.readInt16BE(deltas + s * 2)) & 0xffff;
    }
    return 0;
  }
  if (format === 12) {
    const groups = data.readUInt32BE(at + 12);
    for (let g = 0; g < groups; g++) {
      const r = at + 16 + g * 12;
      const first = data.readUInt32BE(r);
      const last = data.readUInt32BE(r + 4);
      if (code >= first && code <= last) return data.readUInt32BE(r + 8) + (code - first);
    }
  }
  return 0;
}

/** The Unicode cmap subtables of format 4 and 12. */
function unicodeSubtables(data: Buffer): number[] {
  const cmap = table(data, 'cmap');
  const subtables: number[] = [];
  if (cmap === null) return subtables;
  const count = data.readUInt16BE(cmap.offset + 2);
  for (let i = 0; i < count; i++) {
    const r = cmap.offset + 4 + i * 8;
    const platform = data.readUInt16BE(r);
    const encoding = data.readUInt16BE(r + 2);
    const at = cmap.offset + data.readUInt32BE(r + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && at + 2 <= data.length && [4, 12].includes(data.readUInt16BE(at))) subtables.push(at);
  }
  return subtables;
}

function glyphOf(data: Buffer, subtables: readonly number[], char: string): number {
  const code = char.codePointAt(0) ?? 0;
  for (const at of subtables) {
    const glyph = lookup(data, at, code);
    if (glyph !== 0) return glyph;
  }
  return 0;
}

/**
 * The characters of `text` (the space U+0020 left out) that the font has no glyph for, each once, in the order of `text`. Every
 * character is missing when the file has no Unicode cmap subtable of format 4 or 12.
 */
export function missingCharacters(data: Buffer, text: string): string[] {
  const subtables = unicodeSubtables(data);
  return [...new Set(Array.from(text).filter((c) => c !== ' '))].filter((c) => glyphOf(data, subtables, c) === 0);
}

type Point = { x: number; y: number; on: boolean };

type Loca = (glyph: number) => [number, number];

/** The contours of glyph `glyph` of the `glyf` table in font units, composite glyphs resolved; empty for a blank glyph. */
function contours(data: Buffer, glyf: number, loca: Loca, glyph: number, depth = 0): Point[][] {
  const [start, end] = loca(glyph);
  if (end <= start || depth > 8) return [];
  const at = glyf + start;
  const count = data.readInt16BE(at);
  return count >= 0 ? simpleContours(data, at, count) : compositeContours(data, glyf, loca, at, depth);
}

/** The flags of the points of a simple glyph from `p`, and the offset after them. */
function pointFlags(data: Buffer, p: number, points: number): { flags: number[]; next: number } {
  const flags: number[] = [];
  while (flags.length < points) {
    const flag = data.readUInt8(p++);
    flags.push(flag);
    if (flag & 8) {
      const repeat = data.readUInt8(p++);
      for (let r = 0; r < repeat; r++) flags.push(flag);
    }
  }
  return { flags, next: p };
}

/** One coordinate per point (x with flag bits 2 and 16, y with 4 and 32), from `p`; and the offset after them. */
function coordinates(data: Buffer, p: number, flags: readonly number[], short: number, same: number): { values: number[]; next: number } {
  const values: number[] = [];
  let v = 0;
  for (const flag of flags) {
    if (flag & short) {
      const d = data.readUInt8(p++);
      v += flag & same ? d : -d;
    } else if (!(flag & same)) {
      v += data.readInt16BE(p);
      p += 2;
    }
    values.push(v);
  }
  return { values, next: p };
}

function simpleContours(data: Buffer, at: number, count: number): Point[][] {
  const endPts: number[] = [];
  for (let i = 0; i < count; i++) endPts.push(data.readUInt16BE(at + 10 + i * 2));
  const points = count === 0 ? 0 : (endPts[count - 1] ?? -1) + 1;
  const instructions = at + 10 + count * 2;
  const { flags, next } = pointFlags(data, instructions + 2 + data.readUInt16BE(instructions), points);
  const xs = coordinates(data, next, flags, 2, 16);
  const ys = coordinates(data, xs.next, flags, 4, 32);
  const out: Point[][] = [];
  let first = 0;
  for (const last of endPts) {
    const contour: Point[] = [];
    for (let i = first; i <= last; i++) contour.push({ x: xs.values[i] ?? 0, y: ys.values[i] ?? 0, on: ((flags[i] ?? 0) & 1) === 1 });
    out.push(contour);
    first = last + 1;
  }
  return out;
}

/** The 2×2 transform of a component (flag 8: one scale, 0x40: x and y scales, 0x80: a matrix) from `p`. */
function componentTransform(data: Buffer, p: number, flags: number): { m: [number, number, number, number]; next: number } {
  const f2dot14 = (o: number): number => data.readInt16BE(o) / 16384;
  if (flags & 8) return { m: [f2dot14(p), 0, 0, f2dot14(p)], next: p + 2 };
  if (flags & 0x40) return { m: [f2dot14(p), 0, 0, f2dot14(p + 2)], next: p + 4 };
  if (flags & 0x80) return { m: [f2dot14(p), f2dot14(p + 2), f2dot14(p + 4), f2dot14(p + 6)], next: p + 8 };
  return { m: [1, 0, 0, 1], next: p };
}

function compositeContours(data: Buffer, glyf: number, loca: Loca, at: number, depth: number): Point[][] {
  const out: Point[][] = [];
  let p = at + 10;
  for (;;) {
    const flags = data.readUInt16BE(p);
    const component = data.readUInt16BE(p + 2);
    const words = (flags & 1) !== 0;
    const dx = words ? data.readInt16BE(p + 4) : data.readInt8(p + 4);
    const dy = words ? data.readInt16BE(p + 6) : data.readInt8(p + 5);
    const { m, next } = componentTransform(data, p + (words ? 8 : 6), flags);
    p = next;
    // offsets are x and y values (flag 2); point matching is not supported and leaves the component in place
    const [ox, oy] = flags & 2 ? [dx, dy] : [0, 0];
    for (const contour of contours(data, glyf, loca, component, depth + 1)) {
      out.push(contour.map((q) => ({ x: m[0] * q.x + m[2] * q.y + ox, y: m[1] * q.x + m[3] * q.y + oy, on: q.on })));
    }
    if (!(flags & 0x20)) return out;
  }
}

/** An SVG path of the contours moved by `x0`, with y flipped about `baseline`. Quadratic curves as in TrueType. */
function pathOf(glyph: Point[][], x0: number, baseline: number): string {
  const parts: string[] = [];
  const f = (v: number): string => (Math.round(v * 100) / 100).toString();
  for (const contour of glyph) {
    if (contour.length === 0) continue;
    const pts = contour.map((q) => ({ x: q.x + x0, y: baseline - q.y, on: q.on }));
    const startIndex = pts.findIndex((q) => q.on);
    const first = pts[0] as Point;
    const last = pts[pts.length - 1] as Point;
    const start = startIndex >= 0 ? (pts[startIndex] as Point) : { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, on: true };
    const ordered = startIndex >= 0 ? [...pts.slice(startIndex + 1), ...pts.slice(0, startIndex + 1)] : [...pts, first];
    parts.push(`M${f(start.x)} ${f(start.y)}`);
    let control: Point | null = null;
    for (const q of ordered) {
      if (q.on) {
        parts.push(control ? `Q${f(control.x)} ${f(control.y)} ${f(q.x)} ${f(q.y)}` : `L${f(q.x)} ${f(q.y)}`);
        control = null;
      } else {
        if (control) {
          const mid = { x: (control.x + q.x) / 2, y: (control.y + q.y) / 2 };
          parts.push(`Q${f(control.x)} ${f(control.y)} ${f(mid.x)} ${f(mid.y)}`);
        }
        control = q;
      }
    }
    if (control) parts.push(`Q${f(control.x)} ${f(control.y)} ${f(start.x)} ${f(start.y)}`);
    parts.push('Z');
  }
  return parts.join('');
}

export interface TextOutline {
  /** SVG path data, in font units, y down, the top of the line at 0. */
  path: string;
  /** The advance width of the line. */
  width: number;
  /** The line height: ascender − descender of `hhea`. */
  height: number;
  /** The box that holds the line box and every point of the outlines (ink past the line box included), in path units. */
  box: { x: number; y: number; width: number; height: number };
  unitsPerEm: number;
}

/**
 * The outline of `text` set in one line from the TrueType outlines (`glyf`) of the font, glyph after glyph by their
 * advance widths plus `spacing` (in font units). Null when the font has no `glyf` outlines (e.g. a CFF font).
 */
export function textOutline(data: Buffer, text: string, spacing: number): TextOutline | null {
  const head = table(data, 'head');
  const hhea = table(data, 'hhea');
  const hmtx = table(data, 'hmtx');
  const locaTable = table(data, 'loca');
  const glyfTable = table(data, 'glyf');
  if (!head || !hhea || !hmtx || !locaTable || !glyfTable) return null;
  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const longLoca = data.readInt16BE(head.offset + 50) === 1;
  const ascender = data.readInt16BE(hhea.offset + 4);
  const descender = data.readInt16BE(hhea.offset + 6);
  const metrics = data.readUInt16BE(hhea.offset + 34);
  const loca = (g: number): [number, number] =>
    longLoca
      ? [data.readUInt32BE(locaTable.offset + g * 4), data.readUInt32BE(locaTable.offset + g * 4 + 4)]
      : [data.readUInt16BE(locaTable.offset + g * 2) * 2, data.readUInt16BE(locaTable.offset + g * 2 + 2) * 2];
  const advance = (g: number): number => data.readUInt16BE(hmtx.offset + Math.min(g, metrics - 1) * 4);
  const subtables = unicodeSubtables(data);
  let x = 0;
  const parts: string[] = [];
  const chars = Array.from(text);
  const bounds = { left: 0, top: 0, right: 0, bottom: ascender - descender };
  chars.forEach((char, i) => {
    const glyph = glyphOf(data, subtables, char);
    const outline = contours(data, glyfTable.offset, loca, glyph);
    for (const q of outline.flat()) {
      bounds.left = Math.min(bounds.left, q.x + x);
      bounds.right = Math.max(bounds.right, q.x + x);
      bounds.top = Math.min(bounds.top, ascender - q.y);
      bounds.bottom = Math.max(bounds.bottom, ascender - q.y);
    }
    parts.push(pathOf(outline, x, ascender));
    x += advance(glyph) + (i < chars.length - 1 ? spacing : 0);
  });
  bounds.right = Math.max(bounds.right, x);
  const box = { x: Math.floor(bounds.left), y: Math.floor(bounds.top), width: Math.ceil(bounds.right) - Math.floor(bounds.left), height: Math.ceil(bounds.bottom) - Math.floor(bounds.top) };
  return { path: parts.join(''), width: x, height: ascender - descender, box, unitsPerEm };
}
