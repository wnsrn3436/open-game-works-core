import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HttpResponse, Net, RemoteRef, RequestInit } from '../../../src/commands/env/lib/net.ts';

export type Handler = (init: RequestInit) => HttpResponse;
export type Route = string | Buffer | object | Handler;

function isHandler(route: Route): route is Handler {
  return typeof route === 'function';
}

export interface FakeNet extends Net {
  calls: string[];
}

function toResponse(route: Route, init: RequestInit): HttpResponse {
  if (isHandler(route)) return route(init);
  const body = Buffer.isBuffer(route) ? route : Buffer.from(typeof route === 'string' ? route : JSON.stringify(route));
  return { status: 200, headers: {}, body };
}

/** A network that answers only the given URLs. */
export function fakeNet(
  routes: Record<string, Route>,
  // lsRemote: the ref lines of each repository; a commit alone is the line of HEAD
  git: { lsRemote?: Record<string, string | RemoteRef[]>; files?: Record<string, string> } = {},
): FakeNet {
  const calls: string[] = [];
  const answer = (url: string, init: RequestInit = {}): HttpResponse => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const route = routes[url];
    if (route === undefined) return { status: 404, headers: {}, body: Buffer.from('not found') };
    return toResponse(route, init);
  };
  return {
    calls,
    request: (url, init) => Promise.resolve(answer(url, init)),
    download: (url, dest, headers) => {
      const response = answer(url, headers === undefined ? {} : { headers });
      if (response.status !== 200) return Promise.reject(new Error(`download failed (${String(response.status)}): ${url}`));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, response.body);
      return Promise.resolve();
    },
    lsRemote: (url, patterns) => {
      calls.push(`ls-remote ${url} ${patterns.join(' ')}`);
      const known = git.lsRemote?.[url];
      const lines = known === undefined ? [] : typeof known === 'string' ? [{ id: known, ref: 'HEAD' }] : known;
      // git matches each pattern against the tail of a ref name, whole path parts only
      return Promise.resolve(lines.filter((l) => patterns.some((p) => l.ref === p || l.ref.endsWith(`/${p}`))));
    },
    gitFile: (url, commit, path) => {
      calls.push(`git-file ${url} ${commit} ${path}`);
      return Promise.resolve(git.files?.[`${url} ${commit} ${path}`] ?? null);
    },
  };
}

/** Writes executable shell scripts into `dir`. */
export function fakeBin(dir: string, scripts: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}
