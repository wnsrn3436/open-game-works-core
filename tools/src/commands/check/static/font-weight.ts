import { LIST_PATH, keyFilesIn, parseKey } from '../../resource/lib/list.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * font weight: for each `font` resource with a `wght` axis, merged core settings `LocalizationCore.headingFontWeight` is
 * not 0, and the font draws headings at a weight above the weight it draws body text at: a setting clamped to the range
 * of the axis, and the default of the axis for 0 (`client-content` `### UI composition`). A font draws a style at that
 * weight only when the core settings have both keys; without them the check reads nothing.
 */
export const NAME = 'font weight';

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);

/** One axis of an `fvar` table: its tag and its minimum, default and maximum value. */
export interface FontAxis {
  tag: string;
  min: number;
  def: number;
  max: number;
}

/** The axes of the `fvar` table of a TrueType or OpenType font file; empty for another file or a font without one. */
export function fontAxisRecords(data: Buffer): FontAxis[] {
  if (data.length < 12 || !SFNT_VERSIONS.has(data.readUInt32BE(0))) return [];
  const tables = data.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (record + 16 > data.length) return [];
    if (data.toString('latin1', record, record + 4) !== 'fvar') continue;
    const offset = data.readUInt32BE(record + 8);
    if (offset + 16 > data.length) return [];
    const axesOffset = offset + data.readUInt16BE(offset + 4);
    const count = data.readUInt16BE(offset + 8);
    const size = data.readUInt16BE(offset + 10);
    const axes: FontAxis[] = [];
    for (let a = 0; a < count && axesOffset + a * size + 16 <= data.length; a++) {
      const at = axesOffset + a * size;
      // Fixed 16.16 values
      axes.push({ tag: data.toString('latin1', at, at + 4), min: data.readInt32BE(at + 4) / 65536, def: data.readInt32BE(at + 8) / 65536, max: data.readInt32BE(at + 12) / 65536 });
    }
    return axes;
  }
  return [];
}

/** The axis tags of the `fvar` table of a font file. */
export function fontAxes(data: Buffer): string[] {
  return fontAxisRecords(data).map((a) => a.tag);
}

/** The weight a font with this `wght` axis draws a text style at, for its core settings weight. */
export function drawnWeight(axis: FontAxis, setting: number): number {
  if (setting === 0) return axis.def;
  return Math.min(axis.max, Math.max(axis.min, setting));
}

function weightProblem(key: string, axis: FontAxis, heading: number, body: number): string | null {
  if (heading === 0) {
    return `\`${key}\` has a wght axis and LocalizationCore.headingFontWeight is 0, so headings draw at the default weight of the font; set LocalizationCore.headingFontWeight and LocalizationCore.bodyFontWeight from the art direction`;
  }
  const h = drawnWeight(axis, heading);
  const b = drawnWeight(axis, body);
  if (h > b) return null;
  return `\`${key}\` draws headings at weight ${String(h)} and body text at weight ${String(b)} (wght axis ${String(axis.min)} to ${String(axis.max)}, default ${String(axis.def)}); set LocalizationCore.headingFontWeight above LocalizationCore.bodyFontWeight within that range`;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const list = await sc.headerTable(LIST_PATH);
  if (list === null) return [];
  const fonts = list.rows.filter((row) => parseKey(row.values.key ?? '')?.type === 'font');
  if (fonts.length === 0) return [];
  const core = await sc.coreSettings();
  const heading = core['LocalizationCore.headingFontWeight'];
  const body = core['LocalizationCore.bodyFontWeight'];
  if (typeof heading !== 'number' || typeof body !== 'number') return [];
  const out: Finding[] = [];
  for (const row of fonts) {
    const key = row.values.key ?? '';
    for (const file of keyFilesIn(key, sc.files)) {
      const axis = fontAxisRecords(await sc.bytes(file.path)).find((a) => a.tag === 'wght');
      if (axis === undefined) continue;
      const problem = weightProblem(key, axis, heading, body);
      if (problem !== null) out.push(finding(NAME, at(LIST_PATH, row.line), problem));
      break;
    }
  }
  return out;
}
