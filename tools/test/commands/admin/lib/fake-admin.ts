import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeGame, type TestWorkspace } from '../../../helpers/workspace.ts';

export interface SeenRequest {
  method: string;
  operation: string;
  query: Record<string, string>;
  authorization: string;
  contentType: string;
  body: Buffer;
}

export interface FakeReply {
  status?: number;
  /** A string is sent as is; anything else as JSON. */
  body: unknown;
}

export type FakeHandler = (request: SeenRequest) => FakeReply;

/** A local admin API server: answers `POST /admin/<operation>` from `handlers` and records every request. */
export class FakeAdmin {
  readonly requests: SeenRequest[] = [];
  handlers: Record<string, FakeHandler> = {};
  private server: Server;
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const seen: SeenRequest = {
          method: req.method ?? '',
          operation: url.pathname.replace(/^\/admin\//, ''),
          query: Object.fromEntries(url.searchParams),
          authorization: req.headers.authorization ?? '',
          contentType: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks),
        };
        this.requests.push(seen);
        const handler = this.handlers[seen.operation];
        const reply = handler ? handler(seen) : { status: 404, body: { error: 'not_found' } };
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => this.server.close(() => {
        done();
      }));
  }

  json(index: number): unknown {
    return JSON.parse((this.requests[index]?.body ?? Buffer.from('null')).toString('utf8'));
  }

  reset(): void {
    this.requests.length = 0;
    this.handlers = {};
  }
}

function environment(serverUrl: string, secret: string | null): Record<string, unknown> {
  const operators = [{ name: 'human', roles: ['read'], secret: 'humanAdmin' }];
  if (secret !== null) operators.push({ name: 'ogw', roles: ['read', 'ops', 'economy'], secret });
  return { serverUrl, adminOperators: operators };
}

/** Game settings whose DEV, STG, PROD servers are the given URLs, operator `ogw` secret names `ogwAdmin<ENV>`. */
export function gameSettings(urls: { DEV: string; STG: string; PROD: string }): Record<string, unknown> {
  return {
    appId: 'com.example.test',
    environments: {
      DEV: environment(urls.DEV, 'ogwAdminDEV'),
      STG: environment(urls.STG, 'ogwAdminSTG'),
      PROD: environment(urls.PROD, 'ogwAdminPROD'),
    },
  };
}

/** Secret values of operator `ogw` in the test secret store. */
export const SECRETS = { DEV: 'dev-secret', STG: 'stg-secret', PROD: 'prod-secret' } as const;

export function writeSecrets(ws: TestWorkspace, game: string): void {
  const store: Record<string, string> = {};
  for (const env of ['DEV', 'STG', 'PROD'] as const) store[`ogw/${game}/${env}/ogwAdmin${env}`] = SECRETS[env];
  writeFileSync(ws.env.OGW_TEST_SECRET_FILE as string, JSON.stringify(store));
}

/** A game repo with settings pointing every environment at its own fake server, plus the secrets. */
export function makeAdminGame(
  ws: TestWorkspace,
  name: string,
  servers: { DEV: FakeAdmin; STG: FakeAdmin; PROD: FakeAdmin },
  files: Record<string, string | object> = {},
): string {
  const dir = makeGame(ws, name, {
    'settings.json': gameSettings({ DEV: servers.DEV.url, STG: servers.STG.url, PROD: servers.PROD.url }),
    ...files,
  });
  writeSecrets(ws, name);
  return dir;
}
