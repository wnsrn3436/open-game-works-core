import type { RawData } from 'ws';

/** The bytes of one `ws` message (`RawData`: a Buffer, an ArrayBuffer or a list of Buffers). */
export function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
