import sharp from 'sharp';
import { OgwError } from '../../../lib/errors.ts';
import { sha256Hex } from './list.ts';

/** 8-bit RGBA pixels, rows top to bottom. */
export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

export function blank(width: number, height: number): Rgba {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Decodes an image file or bytes to 8-bit RGBA. */
export async function decodeRgba(input: string | Buffer, where: string): Promise<Rgba> {
  try {
    const { data, info } = await sharp(input).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`${String(info.channels)} channels`);
    return { width: info.width, height: info.height, data };
  } catch (error) {
    throw new OgwError(`${where}: cannot read image: ${(error as Error).message}`);
  }
}

/** PNG bytes of RGBA pixels. */
export async function encodePng(image: Rgba): Promise<Buffer> {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

/** Resizes RGBA pixels to an exact size. */
export async function resizeRgba(image: Rgba, width: number, height: number): Promise<Rgba> {
  if (image.width === width && image.height === height) return image;
  const data = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { width, height, data };
}

export function crop(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
  const out = blank(width, height);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * width * 4, from, from + width * 4);
  }
  return out;
}

/** Copies `src` into `dst` at (x, y), replacing pixels; parts outside `dst` are dropped. */
export function paste(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const tx = x + col;
      if (tx < 0 || tx >= dst.width) continue;
      src.data.copy(dst.data, (ty * dst.width + tx) * 4, (row * src.width + col) * 4, (row * src.width + col) * 4 + 4);
    }
  }
}

/** Box `[x0, y0, x1, y1)` of pixels whose alpha is above `minAlpha`; null when there is none. */
export function alphaBox(image: Rgba, minAlpha: number): [number, number, number, number] | null {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] as number) <= minAlpha) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  return x1 === 0 ? null : [x0, y0, x1, y1];
}

/** Scales to fit inside (width, height), keeping the aspect ratio, and centers on a transparent canvas of that size. */
export async function fitCentered(image: Rgba, width: number, height: number): Promise<Rgba> {
  const scale = Math.min(width / image.width, height / image.height);
  const w = Math.min(width, Math.max(1, Math.round(image.width * scale)));
  const h = Math.min(height, Math.max(1, Math.round(image.height * scale)));
  const out = blank(width, height);
  paste(out, await resizeRgba(image, w, h), Math.floor((width - w) / 2), Math.floor((height - h) / 2));
  return out;
}

/** Scales to cover (width, height), keeping the aspect ratio, and crops the middle to that size. */
export async function coverCropped(image: Rgba, width: number, height: number): Promise<Rgba> {
  const scale = Math.max(width / image.width, height / image.height);
  const w = Math.max(width, Math.round(image.width * scale));
  const h = Math.max(height, Math.round(image.height * scale));
  const resized = await resizeRgba(image, w, h);
  return crop(resized, Math.floor((w - width) / 2), Math.floor((h - height) / 2), width, height);
}

/** A solid color derived from the resource key. */
export function keyColor(key: string): [number, number, number] {
  const hash = Buffer.from(sha256Hex(key), 'hex');
  return [64 + ((hash[0] as number) % 128), 64 + ((hash[1] as number) % 128), 64 + ((hash[2] as number) % 128)];
}

/** 5x7 glyphs for the characters of a snake_case word. */
export const GLYPHS: Record<string, string> = {
  a: '01110100011000111111100011000110001',
  b: '11110100011000111110100011000111110',
  c: '01110100011000010000100001000101110',
  d: '11110100011000110001100011000111110',
  e: '11111100001000011110100001000011111',
  f: '11111100001000011110100001000010000',
  g: '01110100011000010111100011000101111',
  h: '10001100011000111111100011000110001',
  i: '01110001000010000100001000010001110',
  j: '00111000100001000010000101001001100',
  k: '10001100101010011000101001001010001',
  l: '10000100001000010000100001000011111',
  m: '10001110111010110101100011000110001',
  n: '10001100011100110101100111000110001',
  o: '01110100011000110001100011000101110',
  p: '11110100011000111110100001000010000',
  q: '01110100011000110001101011001001101',
  r: '11110100011000111110101001001010001',
  s: '01111100001000001110000010000111110',
  t: '11111001000010000100001000010000100',
  u: '10001100011000110001100011000101110',
  v: '10001100011000110001100010101000100',
  w: '10001100011000110101101011010101010',
  x: '10001100010101000100010101000110001',
  y: '10001100010101000100001000010000100',
  z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110',
  '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010',
  '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110',
  '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100',
  _: '00000000000000000000000000000011111',
};

function drawText(image: Rgba, text: string, color: readonly number[]): void {
  const textWidth = text.length * 6 - 1;
  const scale = Math.max(1, Math.floor(Math.min((image.width * 0.9) / textWidth, (image.height * 0.5) / 7)));
  const left = Math.floor((image.width - textWidth * scale) / 2);
  const top = Math.floor((image.height - 7 * scale) / 2);
  for (let index = 0; index < text.length; index++) {
    const glyph = GLYPHS[text.charAt(index)] ?? '';
    for (let bit = 0; bit < glyph.length; bit++) {
      if (glyph[bit] !== '1') continue;
      const gx = left + (index * 6 + (bit % 5)) * scale;
      const gy = top + Math.floor(bit / 5) * scale;
      fillRect(image, gx, gy, scale, scale, color);
    }
  }
}

function fillRect(image: Rgba, x: number, y: number, w: number, h: number, color: readonly number[]): void {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + h); row++) {
    for (let col = Math.max(0, x); col < Math.min(image.width, x + w); col++) {
      const i = (row * image.width + col) * 4;
      image.data[i] = color[0] as number;
      image.data[i + 1] = color[1] as number;
      image.data[i + 2] = color[2] as number;
      image.data[i + 3] = 255;
    }
  }
}

/** Placeholder PNG: a solid image of the size with the last word of the resource key as text. */
export async function placeholderPng(key: string, last: string, size: [number, number]): Promise<Buffer> {
  const [width, height] = size;
  const image = blank(width, height);
  const color = keyColor(key);
  fillRect(image, 0, 0, width, height, color);
  const luminance = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
  drawText(image, last, luminance > 128 ? [0, 0, 0] : [255, 255, 255]);
  return encodePng(image);
}
