import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fontWeight from '../../../../src/commands/check/static/font-weight.ts';
import { lines, memContext } from './helpers.ts';

const state = vi.hoisted((): { core: Record<string, unknown> } => ({ core: {} }));

vi.mock('../../../../src/commands/generate/api.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/commands/generate/api.ts')>()),
  mergedCoreSettings: () => Promise.resolve(state.core),
}));

/** A TrueType file with one `fvar` table holding the axes `tags`, or with no tables when `tags` is null. */
function font(tags: string[] | null): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(0x00010000, 0);
  if (tags === null) return head;
  head.writeUInt16BE(1, 4);
  const record = Buffer.alloc(16);
  record.write('fvar', 0, 'latin1');
  record.writeUInt32BE(28, 8);
  const fvar = Buffer.alloc(16 + tags.length * 20);
  fvar.writeUInt16BE(1, 0);
  fvar.writeUInt16BE(16, 4);
  fvar.writeUInt16BE(tags.length, 8);
  fvar.writeUInt16BE(20, 10);
  tags.forEach((tag, i) => fvar.write(tag, 16 + i * 20, 'latin1'));
  record.writeUInt32BE(fvar.length, 12);
  return Buffer.concat([head, record, fvar]);
}

const LIST = ['key,description,spec,status,method,source,license,attribution,sha256', 'font/main,x,,final,,,,,', 'font/plain,x,,final,,,,,', 'icon/coin,x,size=64x64,final,,,,,', ''].join('\n');

beforeEach(() => {
  state.core = { 'LocalizationCore.headingFontWeight': 0, 'LocalizationCore.bodyFontWeight': 0 };
});

describe('font weight', () => {
  it('fails a font with a wght axis while LocalizationCore.headingFontWeight is 0', async () => {
    const sc = memContext({ 'resource/resources.csv': LIST, 'resource/font/main.ttf': font(['wdth', 'wght']), 'resource/font/plain.ttf': font(null), 'resource/icon/coin.png': font(['wght']) });
    expect(lines(await fontWeight.run(sc))).toEqual([
      'resource/resources.csv:2 | font weight: `font/main` has a wght axis and LocalizationCore.headingFontWeight is 0, so headings draw at the weight of body text; set LocalizationCore.headingFontWeight and LocalizationCore.bodyFontWeight from the art direction',
    ]);
  });

  it('passes when LocalizationCore.headingFontWeight is set, when no font has a wght axis and when the core has no such key', async () => {
    const files = { 'resource/resources.csv': LIST, 'resource/font/main.ttf': font(['wght']) };
    state.core = { 'LocalizationCore.headingFontWeight': 800, 'LocalizationCore.bodyFontWeight': 0 };
    expect(await fontWeight.run(memContext(files))).toEqual([]);
    state.core = { 'LocalizationCore.headingFontWeight': 0 };
    expect(await fontWeight.run(memContext({ ...files, 'resource/font/main.ttf': font(['wdth']) }))).toEqual([]);
    state.core = {};
    expect(await fontWeight.run(memContext(files))).toEqual([]);
    expect(await fontWeight.run(memContext({}))).toEqual([]);
  });

  it('reads the axes of a real variable font and none of a file that is not a font', () => {
    expect(fontWeight.fontAxes(font(['wght', 'ital']))).toEqual(['wght', 'ital']);
    expect(fontWeight.fontAxes(Buffer.from('not a font at all'))).toEqual([]);
  });
});
