import { OgwError } from '../../../lib/errors.ts';

const MAGIC = 0x43504447; // "GDPC"

function readEntries(buf: Buffer, at: number): string[] {
  const count = buf.readUInt32LE(at);
  let pos = at + 4;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = buf.readUInt32LE(pos);
    pos += 4;
    const path = buf.toString('utf8', pos, pos + length).replace(/\0+$/, '');
    pos += length + 8 + 8 + 16 + 4;
    paths.push(path.replace(/^res:\/\//, ''));
  }
  return paths;
}

/** Project-relative paths stored in a Godot 4 `.pck` (pack format 2 or 3, directory not encrypted). */
export function pckPaths(buf: Buffer): string[] {
  if (buf.length < 4 || buf.readUInt32LE(0) !== MAGIC) throw new OgwError('not a Godot pck');
  const format = buf.readUInt32LE(4);
  const flags = buf.readUInt32LE(20);
  if ((flags & 1) !== 0) throw new OgwError('the pck directory is encrypted');
  if (format === 2) return readEntries(buf, 24 + 8 + 64);
  if (format === 3) return readEntries(buf, Number(buf.readBigUInt64LE(32)));
  throw new OgwError(`pck format ${String(format)} not supported`);
}

/** A pck of format 3 with these paths (and empty contents), for tests and bundle checks. */
export function makePck(paths: readonly string[], format: 2 | 3 = 3): Buffer {
  const entries = paths.map((p) => {
    const raw = Buffer.from(p);
    const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4);
    raw.copy(padded);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(padded.length);
    return Buffer.concat([head, padded, Buffer.alloc(8 + 8 + 16 + 4)]);
  });
  const count = Buffer.alloc(4);
  count.writeUInt32LE(paths.length);
  const header = Buffer.alloc(format === 2 ? 24 + 8 + 64 : 24 + 16 + 64);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(format, 4);
  if (format === 3) header.writeBigUInt64LE(BigInt(header.length), 32);
  return Buffer.concat([header, count, ...entries]);
}

/** Godot export filter glob (`*` matches any text, `/` included) against a project-relative path. */
export function matchesFilter(path: string, filter: string): boolean {
  return filter
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .some((f) => new RegExp(`^${f.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path));
}
