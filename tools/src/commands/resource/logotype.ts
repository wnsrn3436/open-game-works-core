import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { expectPositionals, nonNegativeInt, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, formatJson } from '../../lib/fsx.ts';
import { fontFamily, missingCharacters, textOutline } from './lib/font.ts';

type Rgb = [number, number, number];

/** A glow, shadow or outline of the lettering: its color and its size in pixels. */
export interface Edge {
  color: Rgb;
  px: number;
}

export interface LogotypeOptions {
  font: string;
  text: string;
  /** Font size in pixels. */
  height: number;
  /** Letter spacing in 1/1000 of the font size. */
  spacing: number;
  /** The fill: one color, or a top and a bottom color of a vertical gradient. */
  fill: Rgb[];
  outline: Edge | null;
  shadow: Edge | null;
  glow: Edge | null;
}

export interface Logotype {
  out: string;
  family: string;
  width: number;
  height: number;
}

function hex(value: string, what: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value);
  if (!m) throw new OgwError(`invalid ${what}: ${value} (#rrggbb)`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `<#rrggbb>:<px>`, or null when the option is not given. */
function edge(value: string | undefined, what: string): Edge | null {
  if (value === undefined) return null;
  const [color, px] = value.split(':');
  const size = Number(px);
  if (color === undefined || !Number.isInteger(size) || size < 1 || size > 200) throw new OgwError(`invalid --${what}: ${value} (<#rrggbb>:<px>, px 1 to 200)`);
  return { color: hex(color, `--${what} color`), px: size };
}

/** The alpha channel (W×H) blurred with `sigma`, then multiplied by `gain` (clamped), which grows it by about `sigma`. */
async function spread(alpha: Buffer, width: number, height: number, sigma: number, gain: number): Promise<Buffer> {
  const { data } = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(Math.max(0.3, sigma))
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Buffer.from(data.map((v) => Math.min(255, Math.round(v * gain))));
}

/** Draws `mask` in `color(y)` over `canvas` (RGBA, premultiplied in place), shifted by `dy` rows, at `opacity`. */
function over(canvas: Float32Array, mask: Buffer, width: number, height: number, color: (y: number) => Rgb, dy = 0, opacity = 1): void {
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    const [r, g, b] = color(y);
    for (let x = 0; x < width; x++) {
      const a = ((mask[sy * width + x] ?? 0) / 255) * opacity;
      if (a === 0) continue;
      const i = (y * width + x) * 4;
      canvas[i] = r * a + (canvas[i] ?? 0) * (1 - a);
      canvas[i + 1] = g * a + (canvas[i + 1] ?? 0) * (1 - a);
      canvas[i + 2] = b * a + (canvas[i + 2] ?? 0) * (1 - a);
      canvas[i + 3] = 255 * a + (canvas[i + 3] ?? 0) * (1 - a);
    }
  }
}

/** The font file, checked: it exists, has a family name, has every character of `text` and has `glyf` outlines. */
async function readFont(font: string, text: string): Promise<{ data: Buffer; family: string }> {
  if (!exists(font)) throw new OgwError(`font not found: ${font}`);
  const data = await readFile(font);
  const family = fontFamily(data);
  if (family === null) throw new OgwError(`not a font file with a family name: ${font}`);
  const missing = missingCharacters(data, text);
  if (missing.length > 0) throw new OgwError(`${font} has no glyph for: ${missing.join(' ')}`);
  if (textOutline(data, text, 0) === null) throw new OgwError(`no TrueType (glyf) outlines in ${font}: pick a .ttf font with glyf outlines`);
  return { data, family };
}

/** The coverage of the lettering at `height` px, on a canvas with `pad` px around it: one alpha byte per pixel. */
async function letters(data: Buffer, options: LogotypeOptions, pad: number): Promise<{ alpha: Buffer; width: number; height: number }> {
  const em = textOutline(data, options.text, 0)?.unitsPerEm ?? 1000;
  const set = textOutline(data, options.text, (options.spacing * em) / 1000);
  if (set === null) throw new OgwError(`no TrueType (glyf) outlines in ${options.font}`);
  const w = Math.ceil((set.width * options.height) / em);
  const h = Math.ceil((set.height * options.height) / em);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(h)}" viewBox="0 0 ${String(set.width)} ${String(set.height)}"><path fill="#ffffff" d="${set.path}"/></svg>`;
  const text = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = text.info.width + pad * 2;
  const height = text.info.height + pad * 2;
  const alpha = Buffer.alloc(width * height);
  for (let y = 0; y < text.info.height; y++) {
    for (let x = 0; x < text.info.width; x++) alpha[(y + pad) * width + x + pad] = text.data[(y * text.info.width + x) * text.info.channels + 3] ?? 0;
  }
  return { alpha, width, height };
}

/** The canvas (premultiplied) as RGBA bytes. */
function unpremultiply(canvas: Float32Array, pixels: number): Buffer {
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const a = canvas[i * 4 + 3] ?? 0;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = a > 0 ? Math.round(Math.min(255, ((canvas[i * 4 + c] ?? 0) * 255) / a)) : 0;
    rgba[i * 4 + 3] = Math.round(a);
  }
  return rgba;
}

/** The box of the drawn pixels of an RGBA image with a 4 px margin, inside the image. */
function drawnBox(rgba: Buffer, width: number, height: number): { left: number; top: number; width: number; height: number } {
  let [left, right, upper, lower] = [width, -1, height, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) < 2) continue;
      [left, right, upper, lower] = [Math.min(left, x), Math.max(right, x), Math.min(upper, y), Math.max(lower, y)];
    }
  }
  const box = { left: Math.max(0, left - 4), top: Math.max(0, upper - 4), width: 0, height: 0 };
  box.width = Math.min(width, right + 5) - box.left;
  box.height = Math.min(height, lower + 5) - box.top;
  return box;
}

/**
 * Letters `text` with the font file as a transparent PNG: the fill (one color or a vertical gradient), under it an
 * outline, a shadow below it and a glow around it. Fails, naming them, when the font has no glyph for some characters,
 * so that a missing letter is never drawn by another font.
 */
export async function renderLogotype(options: LogotypeOptions, out: string): Promise<Logotype> {
  const { data, family } = await readFont(options.font, options.text);
  const { glow, shadow, outline } = options;
  const pad = Math.max(outline?.px ?? 0, (glow?.px ?? 0) * 2, (shadow?.px ?? 0) * 2) + 4;
  const { alpha, width, height } = await letters(data, options, pad);
  const canvas = new Float32Array(width * height * 4);
  if (glow) over(canvas, await spread(alpha, width, height, glow.px / 2, 1.6), width, height, () => glow.color, 0, 0.85);
  if (shadow) over(canvas, await spread(alpha, width, height, shadow.px / 3, 1.2), width, height, () => shadow.color, Math.round(shadow.px / 2), 0.9);
  if (outline) over(canvas, await spread(alpha, width, height, outline.px / 2, 6), width, height, () => outline.color);
  const top = options.fill[0] ?? [255, 255, 255];
  const bottom = options.fill[1] ?? top;
  const [glyphTop, glyphBottom] = [pad, height - pad];
  over(canvas, alpha, width, height, (y) => {
    const t = Math.min(1, Math.max(0, (y - glyphTop) / Math.max(1, glyphBottom - glyphTop)));
    return [0, 1, 2].map((c) => Math.round((top[c] ?? 0) * (1 - t) + (bottom[c] ?? 0) * t)) as Rgb;
  });
  const rgba = unpremultiply(canvas, width * height);
  const box = drawnBox(rgba, width, height);
  await sharp(rgba, { raw: { width, height, channels: 4 } }).extract(box).png().toFile(out);
  return { out, family, width: box.width, height: box.height };
}

/** `ogw resource logotype`: the game name lettered with a font file, for a logo image (`final resource production`). */
export const logotypeCommand: CommandDef = {
  name: ['resource', 'logotype'],
  usage:
    'ogw resource logotype --font <font file> --text <text> --out <png> [--height <px>] [--spacing <1/1000 em>] [--fill <#rrggbb>[,<#rrggbb>]] [--outline <#rrggbb>:<px>] [--shadow <#rrggbb>:<px>] [--glow <#rrggbb>:<px>]',
  options: {
    font: { type: 'string' },
    text: { type: 'string' },
    out: { type: 'string' },
    height: { type: 'string' },
    spacing: { type: 'string' },
    fill: { type: 'string' },
    outline: { type: 'string' },
    shadow: { type: 'string' },
    glow: { type: 'string' },
  },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const font = str(args, 'font');
    const text = str(args, 'text');
    const out = str(args, 'out');
    if (font === undefined || text === undefined || text.trim() === '' || out === undefined) throw new OgwError(`usage: ${this.usage}`);
    const height = nonNegativeInt(args, 'height') ?? 160;
    if (height < 8 || height > 1024) throw new OgwError(`invalid --height: ${String(height)} (8 to 1024)`);
    const fill = (str(args, 'fill') ?? '#ffffff').split(',').map((c) => hex(c, '--fill'));
    if (fill.length > 2) throw new OgwError('invalid --fill: one color or two colors (top,bottom)');
    const spacing = Number(str(args, 'spacing') ?? '0');
    if (!Number.isInteger(spacing) || spacing < -200 || spacing > 1000) throw new OgwError(`invalid --spacing: ${String(spacing)} (-200 to 1000)`);
    const result = await renderLogotype(
      { font: resolve(ctx.cwd, font), text, height, spacing, fill, outline: edge(str(args, 'outline'), 'outline'), shadow: edge(str(args, 'shadow'), 'shadow'), glow: edge(str(args, 'glow'), 'glow') },
      resolve(ctx.cwd, out),
    );
    return { text: formatJson(result), data: result };
  },
};
