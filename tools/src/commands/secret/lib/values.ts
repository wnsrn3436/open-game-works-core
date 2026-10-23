import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { OgwError } from '../../../lib/errors.ts';

/** An Ed25519 private key seed: 32 random bytes, standard base64. */
export function ed25519Seed(): string {
  return randomBytes(32).toString('base64');
}

/** 32 secure random bytes, base64url without padding. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Standard base64 of the 32-byte Ed25519 public key of a standard base64 seed. */
export function ed25519PublicKey(seedBase64: string): string {
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length !== 32 || seed.toString('base64') !== seedBase64) throw new OgwError('not a standard base64 32-byte Ed25519 seed');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(jwk.x ?? '', 'base64url').toString('base64');
}

/** Connection string of `secrets.db` when `deploy` is set (game settings schema `secrets.dbPassword`). */
export function dbConnectionString(password: string): string {
  return `postgresql://postgres:${encodeURIComponent(password)}@db:5432/postgres`;
}
