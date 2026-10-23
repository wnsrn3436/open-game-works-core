import { randomBytes } from 'node:crypto';

/** A short unique id: base36 Unix ms followed by 6 random hex chars. */
export function newId(now: number = Date.now()): string {
  return `${now.toString(36)}${randomBytes(3).toString('hex')}`;
}
