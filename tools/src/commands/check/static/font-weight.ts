import { LIST_PATH, keyFilesIn, parseKey } from '../../resource/lib/list.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * font weight: when a `font` resource has a `wght` axis, merged core settings `LocalizationCore.headingFontWeight` is
 * not 0, so that the heading text style is drawn at a weight of its own (`client-content` `### UI composition`).
 */
export const NAME = 'font weight';

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);

/** The axis tags of the `fvar` table of a TrueType or OpenType font file; empty for another file or a font without one. */
export function fontAxes(data: Buffer): string[] {
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
    const axes: string[] = [];
    for (let a = 0; a < count && axesOffset + a * size + 4 <= data.length; a++) axes.push(data.toString('latin1', axesOffset + a * size, axesOffset + a * size + 4));
    return axes;
  }
  return [];
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const list = await sc.headerTable(LIST_PATH);
  if (list === null) return [];
  const fonts = list.rows.filter((row) => parseKey(row.values.key ?? '')?.type === 'font');
  if (fonts.length === 0) return [];
  const core = await sc.coreSettings();
  if (!('LocalizationCore.headingFontWeight' in core) || core['LocalizationCore.headingFontWeight'] !== 0) return [];
  const out: Finding[] = [];
  for (const row of fonts) {
    const key = row.values.key ?? '';
    for (const file of keyFilesIn(key, sc.files)) {
      if (!fontAxes(await sc.bytes(file.path)).includes('wght')) continue;
      out.push(
        finding(
          NAME,
          at(LIST_PATH, row.line),
          `\`${key}\` has a wght axis and LocalizationCore.headingFontWeight is 0, so headings draw at the weight of body text; set LocalizationCore.headingFontWeight and LocalizationCore.bodyFontWeight from the art direction`,
        ),
      );
      break;
    }
  }
  return out;
}
