import { inflateRawSync } from 'node:zlib';
import { OgwError } from '../../../lib/errors.ts';

export interface ZipEntry {
  name: string;
  data(): Buffer;
}

function findEnd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** True when the bytes look like a zip archive. */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 22 && buf.readUInt32LE(0) === 0x04034b50 && findEnd(buf) !== -1;
}

/** Entries of a zip archive (stored and deflated entries; no ZIP64). */
export function zipEntries(buf: Buffer): ZipEntry[] {
  const end = findEnd(buf);
  if (end === -1) throw new OgwError('not a zip archive');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new OgwError('broken zip central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (size === 0xffffffff || local === 0xffffffff) throw new OgwError(`ZIP64 entry not supported: ${name}`);
    entries.push({
      name,
      data() {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new OgwError(`zip method ${String(method)} not supported: ${name}`);
      },
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
