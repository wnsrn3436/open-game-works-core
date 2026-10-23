import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestHost, type TestHost } from '../../../../src/commands/check/lib/test-host.ts';

let host: TestHost | null = null;

afterEach(async () => {
  await host?.close();
  host = null;
});

/** A raw HTTP request so that paths like `/app/../x` reach the server as written. */
function raw(url: string, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('test host', () => {
  it('hosts loopback servers that answer registered paths and record requests', async () => {
    host = await startTestHost();
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const created = await fetch(`${host.url}/servers`, { method: 'POST' });
    expect(created.status).toBe(201);
    const { base_url: base } = (await created.json()) as { base_url: string };
    expect(base).toBe(`${host.url}/servers/1/files`);
    const second = (await (await fetch(`${host.url}/servers`, { method: 'POST' })).json()) as { base_url: string };
    expect(second.base_url).toBe(`${host.url}/servers/2/files`);

    const put = (path: string, status: number, body: string): Promise<Response> =>
      fetch(`${host?.url ?? ''}/servers/1/responses`, {
        method: 'PUT',
        body: JSON.stringify({ path, status, headers: [['x-test', 'yes']], body: Buffer.from(body).toString('base64') }),
      });
    expect((await put('/a.json', 200, 'first')).status).toBe(204);
    expect((await put('/a.json', 201, 'second')).status).toBe(204);
    const got = await fetch(`${base}/a.json`, { method: 'POST', body: 'hello' });
    expect(got.status).toBe(201);
    expect(got.headers.get('x-test')).toBe('yes');
    expect(await got.text()).toBe('second');
    expect((await fetch(`${base}/missing?q=1`)).status).toBe(404);
    expect((await fetch(`${second.base_url}/a.json`)).status).toBe(404);

    const requests = (await (await fetch(`${host.url}/servers/1/requests`)).json()) as { path: string; headers: [string, string][]; body: string }[];
    expect(requests.map((r) => [r.path, Buffer.from(r.body, 'base64').toString()])).toEqual([
      ['/a.json', 'hello'],
      ['/missing?q=1', ''],
    ]);
    expect(requests[0]?.headers.some(([name]) => name.toLowerCase() === 'host')).toBe(true);
    expect(await (await fetch(`${host.url}/servers/2/requests`)).json()).toEqual([{ path: '/a.json', headers: expect.any(Array) as unknown, body: '' }]);

    expect((await fetch(`${host.url}/servers/1`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/a.json`)).status).toBe(404);
    expect((await fetch(`${host.url}/servers/1/requests`)).status).toBe(404);
    expect((await fetch(`${host.url}/servers/1`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers 404 to unknown servers and requests, 400 to a bad registration', async () => {
    host = await startTestHost();
    expect((await fetch(`${host.url}/servers/9/requests`)).status).toBe(404);
    expect((await fetch(`${host.url}/servers/0/requests`)).status).toBe(404);
    expect((await fetch(`${host.url}/nothing`)).status).toBe(404);
    await fetch(`${host.url}/servers`, { method: 'POST' });
    expect((await fetch(`${host.url}/servers/1/requests`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${host.url}/servers/1`, { method: 'GET' })).status).toBe(404);
    expect((await fetch(`${host.url}/servers/1/responses`, { method: 'PUT', body: '{"path": 1}' })).status).toBe(400);
    expect((await fetch(`${host.url}/servers/1/responses`, { method: 'PUT', body: 'nope' })).status).toBe(400);
    expect((await fetch(`${host.url}/servers/1/responses`, { method: 'PUT', body: '{"path": "/x", "status": 204}' })).status).toBe(204);
    expect((await fetch(`${host.url}/servers/1/files/x`)).status).toBe(204);
    expect((await fetch(`${host.url}/app/index.html`)).status).toBe(404);
  });

  it('keeps the result of PUT /result and the run ID of PUT /released', async () => {
    host = await startTestHost();
    expect(host.result()).toBeNull();
    expect((await fetch(`${host.url}/result`, { method: 'PUT', body: '{"run_id": "r1"}' })).status).toBe(204);
    expect(host.result()).toEqual({ run_id: 'r1' });
    expect(host.released()).toBeNull();
    expect((await fetch(`${host.url}/released`, { method: 'PUT', body: '{"run_id": "r1"}' })).status).toBe(204);
    expect(host.released()).toBe('r1');
    expect((await fetch(`${host.url}/released`, { method: 'PUT', body: '{}' })).status).toBe(400);
  });

  it('serves the web export under /app/ and nothing outside it', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ogw-app-'));
    mkdirSync(join(app, 'sub'));
    writeFileSync(join(app, 'sub', 'index.html'), '<html>');
    host = await startTestHost(app);
    const page = await fetch(`${host.url}/app/sub/index.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<html>');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await fetch(`${host.url}/app/none.html`)).status).toBe(404);
    expect((await raw(host.url, 'GET', '/app/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });

  it('gives each web export file the content type of web artifact deploy', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ogw-app-'));
    const names = ['index.audio.worklet.js', 'index.wasm', 'index.pck', 'a.png'];
    for (const name of names) writeFileSync(join(app, name), 'x');
    host = await startTestHost(app);
    const types: string[] = [];
    for (const name of names) types.push((await fetch(`${host.url}/app/${name}`)).headers.get('content-type') ?? '');
    expect(types).toEqual(['text/javascript', 'application/wasm', 'application/octet-stream', 'image/png']);
  });
});
