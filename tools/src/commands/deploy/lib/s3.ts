import { createHash, createHmac } from 'node:crypto';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';

export interface S3Target {
  /** Origin of the S3 compatible API, for example `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface PutObject {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 encoding of each path segment, as AWS Signature Version 4 canonical URIs need. */
export function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** `20240101T000000Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface SignInput {
  method: string;
  /** Canonical (already encoded) path. */
  path: string;
  /** Lower-case header names; every header given is signed. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `x-amz-date` value. */
  date: string;
}

/** The `Authorization` header of AWS Signature Version 4 for a request without a query string. */
export function sigV4Authorization(input: SignInput): string {
  const names = Object.keys(input.headers).sort();
  const canonical = [
    input.method,
    input.path,
    '',
    ...names.map((name) => `${name}:${(input.headers[name] as string).trim()}`),
    '',
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const day = input.date.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.date, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

/** URL and headers of a SigV4-signed (service `s3`) path-style PUT of one object. */
export function signedPut(target: S3Target, object: PutObject, now: Date): { url: string; headers: Record<string, string> } {
  const url = new URL(`${target.endpoint.replace(/\/$/, '')}/${encodeKey(target.bucket)}/${encodeKey(object.key)}`);
  const date = amzDate(now);
  const payloadHash = sha256Hex(object.body);
  const headers: Record<string, string> = {
    'cache-control': object.cacheControl,
    'content-type': object.contentType,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
  };
  const authorization = sigV4Authorization({
    method: 'PUT',
    path: url.pathname,
    headers,
    payloadHash,
    region: target.region,
    service: 's3',
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    date,
  });
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
  return { url: url.toString(), headers: { ...sent, authorization } };
}

/** PUTs one object; fails on a non-2xx answer. */
export async function putObject(target: S3Target, object: PutObject, now: Date = new Date()): Promise<void> {
  const { url, headers } = signedPut(target, object, now);
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', headers, body: object.body, signal: AbortSignal.timeout(LIMITS.httpMs) });
  } catch (error) {
    throw new OgwError(`PUT ${object.key} failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OgwError(`PUT ${object.key} failed: HTTP ${String(response.status)} ${text.slice(0, 500)}`);
  }
}

/** `Content-Type` of a web artifact file by its extension (`ogw.md` `## deploy`). */
export function contentTypeOf(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.js')) return 'text/javascript';
  if (name.endsWith('.wasm')) return 'application/wasm';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
