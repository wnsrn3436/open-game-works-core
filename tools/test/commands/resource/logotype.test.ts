import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fontFamily, missingCharacters, textOutline } from '../../../src/commands/resource/lib/font.ts';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';

/** Press Start 2P (OFL-1.1, `test/fixtures/fonts/OFL.txt`): a TrueType pixel font with Latin glyphs and no Hangul. */
const FONT = join(import.meta.dirname, '..', '..', 'fixtures', 'fonts', 'PressStart2P-Regular.ttf');

async function pixels(path: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe('font tables', () => {
  it('reads the family name, the missing characters and the glyph outlines of a TrueType font', () => {
    const data = readFileSync(FONT);
    expect(fontFamily(data)).toBe('Press Start 2P');
    expect(missingCharacters(data, 'LANTERN 등불 L')).toEqual(['등', '불']);
    expect(missingCharacters(Buffer.from('not a font'), 'A')).toEqual(['A']);
    const one = textOutline(data, 'L', 0);
    // a pixel font: straight segments only, one closed contour per letter
    expect(one?.path).toMatch(/^M[-\d. ]+(L[-\d. ]+)+Z$/);
    const two = textOutline(data, 'LL', 100);
    expect(two?.width).toBe((one?.width ?? 0) * 2 + 100);
    expect(two?.height).toBeGreaterThan(0);
    // the box holds the line box and every outline point, so ink past the advance or the descender is not cut
    for (const text of ['LL', 'jgy', 'Q_']) {
      const set = textOutline(data, text, 100);
      if (set === null) throw new Error('no outline');
      expect(set.box.x).toBeLessThanOrEqual(0);
      expect(set.box.x + set.box.width).toBeGreaterThanOrEqual(set.width);
      expect(set.box.y).toBeLessThanOrEqual(0);
      expect(set.box.y + set.box.height).toBeGreaterThanOrEqual(set.height);
      const ys = [...set.path.matchAll(/[MLQ]([-\d.]+) ([-\d.]+)/g)].map((m) => Number(m[2]));
      expect(Math.max(...ys)).toBeLessThanOrEqual(set.box.y + set.box.height);
    }
    expect(textOutline(Buffer.from('not a font'), 'L', 0)).toBeNull();
  });
});

describe('ogw resource logotype', () => {
  it('letters the text with the font file itself, in the fill, outline and glow colors', async () => {
    const ws = makeWorkspace();
    const run = await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'LANTERN', '--out', 'logo.png', '--height', '64', '--fill', '#ff0000', '--outline', '#0000ff:4', '--json']);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { family: string; width: number; height: number };
    expect(result.family).toBe('Press Start 2P');
    const { data, width, height } = await pixels(join(ws.root, 'logo.png'));
    expect([width, height]).toEqual([result.width, result.height]);
    expect(width).toBeGreaterThan(height * 4);
    let red = 0;
    let blue = 0;
    for (let i = 0; i < width * height; i++) {
      const [r, g, b, a] = [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0, data[i * 4 + 3] ?? 0];
      if (a > 250 && r > 240 && g < 20 && b < 20) red++;
      if (a > 250 && b > 240 && r < 20 && g < 20) blue++;
    }
    expect(red).toBeGreaterThan(width * 4);
    expect(blue).toBeGreaterThan(width * 2);
    // the corner is transparent and the 4 px margin holds no drawing
    expect(data[3]).toBe(0);
  });

  it('draws a vertical gradient from the top color to the bottom color', async () => {
    const ws = makeWorkspace();
    const run = await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'I', '--out', 'i.png', '--height', '80', '--fill', '#ffffff,#000000']);
    expect(run.code).toBe(0);
    const { data, width, height } = await pixels(join(ws.root, 'i.png'));
    const lightness = (y: number): number => {
      const values: number[] = [];
      for (let x = 0; x < width; x++) if ((data[(y * width + x) * 4 + 3] ?? 0) > 250) values.push(data[(y * width + x) * 4] ?? 0);
      return values.length === 0 ? -1 : values.reduce((a, b) => a + b, 0) / values.length;
    };
    const rows = Array.from({ length: height }, (_, y) => lightness(y)).filter((v) => v >= 0);
    // the gradient spans the ink, not the line box: the top of the letter is near the top color, its foot near the bottom one
    expect(rows[0]).toBeGreaterThan(230);
    expect(rows[rows.length - 1]).toBeLessThan(25);
  });

  it('refuses a text it cannot set without shaping, and characters other than the space that the font lacks', async () => {
    const ws = makeWorkspace();
    for (const [text, code] of [['مرحبا', 'U+0645'], ['a\u0301', 'U+0301'], ['A\u200bB', 'U+200B'], ['A\nB', 'U+000A']]) {
      const run = await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', text as string, '--out', 'x.png']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('with no shaping');
      expect(run.stderr).toContain(code as string);
    }
    expect((await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'A\u3000B', '--out', 'x.png'])).stderr).toContain('has no glyph for: \u3000');
    const nested = await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'A B', '--out', join('new', 'dir', 'x.png')]);
    expect(nested.code).toBe(0);
  });

  it('refuses a text with characters the font has no glyph for, and checks its options', async () => {
    const ws = makeWorkspace();
    const missing = await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', '등불 LANTERN', '--out', 'x.png']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('has no glyph for: 등 불');
    expect((await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'A'])).stderr).toContain('usage');
    expect((await ogw(ws, ['resource', 'logotype', '--font', 'none.ttf', '--text', 'A', '--out', 'x.png'])).stderr).toContain('font not found');
    expect((await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'A', '--out', 'x.png', '--fill', 'red'])).stderr).toContain('invalid --fill');
    expect((await ogw(ws, ['resource', 'logotype', '--font', FONT, '--text', 'A', '--out', 'x.png', '--outline', '#000000'])).stderr).toContain('invalid --outline');
  });
});
