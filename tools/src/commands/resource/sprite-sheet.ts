import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, list, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import { blank, decodeRgba, encodePng, paste, type Rgba } from './lib/image.ts';

interface FrameCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `--frames <animation>=<file>,<file>...` items in order; fails on a bad item or an animation given twice. */
function parseFrames(items: readonly string[], cwd: string): { name: string; files: string[] }[] {
  const out: { name: string; files: string[] }[] = [];
  for (const item of items) {
    const eq = item.indexOf('=');
    const name = item.slice(0, eq);
    const files = item.slice(eq + 1).split(',').filter((f) => f !== '');
    if (eq <= 0 || files.length === 0) throw new OgwError(`--frames item must be <animation>=<file>,<file>...: ${item}`);
    if (out.some((a) => a.name === name)) throw new OgwError(`--frames gives animation ${name} twice`);
    out.push({ name, files: files.map((f) => resolve(cwd, f)) });
  }
  return out;
}

async function readFrame(file: string): Promise<Rgba> {
  if (!exists(file)) throw new OgwError(`--frames file ${file} does not exist`);
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new OgwError(`--frames file ${file} is not a PNG`);
  return decodeRgba(bytes, file);
}

/** `ogw resource sprite-sheet --frames <animation>=<file>,<file>... --out <folder>` (`production.md` `## sprite sheet`). */
export const spriteSheetCommand: CommandDef = {
  name: ['resource', 'sprite-sheet'],
  usage: 'ogw resource sprite-sheet --frames <animation>=<file>,<file>... --out <folder>',
  options: { frames: { type: 'string', multiple: true }, out: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const out = str(args, 'out');
    const items = list(args, 'frames');
    if (out === undefined || items.length === 0) throw new OgwError(`usage: ${this.usage}`);
    const animations = parseFrames(items, ctx.cwd);
    const rows: Rgba[][] = [];
    for (const animation of animations) rows.push(await Promise.all(animation.files.map(readFrame)));
    const all = rows.flat();
    const w = Math.max(...all.map((f) => f.width));
    const h = Math.max(...all.map((f) => f.height));
    const sheet = blank(w * Math.max(...rows.map((r) => r.length)), h * rows.length);
    const layout: Record<string, FrameCell[]> = {};
    rows.forEach((frames, r) => {
      const name = (animations[r] as { name: string }).name;
      layout[name] = frames.map((frame, c) => {
        paste(sheet, frame, c * w + Math.floor((w - frame.width) / 2), r * h + Math.floor((h - frame.height) / 2));
        return { x: c * w, y: r * h, w, h };
      });
    });
    const folder = resolve(ctx.cwd, out);
    await mkdir(folder, { recursive: true });
    const sheetFile = join(folder, 'sheet.png');
    const manifestFile = join(folder, 'manifest.json');
    await writeFile(sheetFile, await encodePng(sheet));
    await writeFile(manifestFile, `${JSON.stringify({ frame_layout: { rows: layout } }, null, 2)}\n`);
    return { text: `${sheetFile}\n${manifestFile}`, data: { sheet: sheetFile, manifest: manifestFile } };
  },
};
