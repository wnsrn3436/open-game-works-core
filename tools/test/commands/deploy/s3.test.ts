import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { amzDate, contentTypeOf, encodeKey, putObject, signedPut, sigV4Authorization } from '../../../src/commands/deploy/lib/s3.ts';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' };

describe('SigV4', () => {
  it('matches the AWS GET Object example', () => {
    const auth = sigV4Authorization({
      ...AWS,
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: '20130524T000000Z',
    });
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the AWS PUT Object example', () => {
    const hash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const auth = sigV4Authorization({
      ...AWS,
      method: 'PUT',
      path: `/${encodeKey('test$file.text')}`,
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        host: 'examplebucket.s3.amazonaws.com',
        'x-amz-content-sha256': hash,
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: hash,
      date: '20130524T000000Z',
    });
    expect(auth).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('formats dates and keys', () => {
    expect(amzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)))).toBe('20260102T030405Z');
    expect(encodeKey("web/dev/1.0.0/a b(1)!*'.js")).toBe('web/dev/1.0.0/a%20b%281%29%21%2A%27.js');
  });

  it('gives content types by extension', () => {
    expect(['a.html', 'a.js', 'a.wasm', 'a.png', 'a.pck', 'a.htm'].map(contentTypeOf)).toEqual([
      'text/html; charset=utf-8', 'text/javascript', 'application/wasm', 'image/png', 'application/octet-stream', 'application/octet-stream',
    ]);
  });
});

describe('putObject', () => {
  it('sends a signed path-style PUT that the server can verify', async () => {
    const seen: { method?: string; url?: string; headers?: IncomingMessage['headers']; body?: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.statusCode = req.url?.includes('fail') ? 403 : 200;
        res.end(req.url?.includes('fail') ? 'denied' : '');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const target = { endpoint: `http://127.0.0.1:${String(port)}`, bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto' };
    const now = new Date(Date.UTC(2026, 9, 12));
    try {
      await putObject(target, { key: 'web/dev/1.0.0/index.html', body: Buffer.from('<p>'), contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' }, now);
      const expected = signedPut(target, { key: 'web/dev/1.0.0/index.html', body: Buffer.from('<p>'), contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' }, now);
      expect(seen[0]).toMatchObject({ method: 'PUT', url: '/bkt/web/dev/1.0.0/index.html', body: '<p>' });
      expect(seen[0]?.headers).toMatchObject({
        authorization: expected.headers.authorization,
        'cache-control': 'no-cache',
        'content-type': 'text/html; charset=utf-8',
        'x-amz-date': '20261012T000000Z',
        'x-amz-content-sha256': '33f2799467177287a29260780a107ac98ea63dd6165f67fcc0d74767d0a82090',
      });
      expect(expected.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261012\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      await expect(putObject(target, { key: 'fail', body: Buffer.from('x'), contentType: 'a', cacheControl: 'b' }, now)).rejects.toThrow('PUT fail failed: HTTP 403 denied');
    } finally {
      server.close();
    }
  });

  it('fails when the endpoint cannot be reached', async () => {
    const target = { endpoint: 'http://127.0.0.1:1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'auto' };
    await expect(putObject(target, { key: 'k', body: Buffer.from('x'), contentType: 'a', cacheControl: 'b' })).rejects.toThrow('PUT k failed:');
  });
});
