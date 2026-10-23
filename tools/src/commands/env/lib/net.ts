import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { OgwError } from '../../../lib/errors.ts';
import { gitRaw } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface RequestInit {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
}

/** One line of `git ls-remote`: the object id and the ref name (`HEAD`, `refs/tags/v1^{}`). */
export interface RemoteRef {
  id: string;
  ref: string;
}

/**
 * Every network access of the env and generation commands goes through this interface so that tests
 * can replace it: HTTP (Docker Hub, PyPI, Hugging Face, downloads) and the git remote reads.
 */
export interface Net {
  request(url: string, init?: RequestInit): Promise<HttpResponse>;
  /** Streams the body of a GET to a file. Fails on a status other than 2xx. */
  download(url: string, dest: string, headers?: Record<string, string>): Promise<void>;
  /** `git ls-remote <url> <pattern>...`: each ref line git prints, in its order. */
  lsRemote(url: string, patterns: readonly string[]): Promise<RemoteRef[]>;
  /** The text of `path` at `commit` of the git repository at `url`, or null when the file is not there. */
  gitFile(url: string, commit: string, path: string): Promise<string | null>;
}

function headersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

const MAX_REDIRECTS = 10;
const DOWNLOAD_ATTEMPTS = 5;

let downloadRetryMs = 2_000;

/** Sets the wait before the next download attempt, times the attempt number (tests). */
export function setDownloadRetryMs(ms: number | null): void {
  downloadRetryMs = ms ?? 2_000;
}

/** A download failure that another attempt can get past: a broken connection or a stall. */
class TransientDownloadError extends Error {}

/**
 * One attempt: asks for the bytes after what `dest` already holds. A `206` answer is appended, a `200` answer
 * replaces the file.
 */
async function downloadOnce(url: string, dest: string, headers: Record<string, string>): Promise<void> {
  const have = existsSync(dest) ? statSync(dest).size : 0;
  let response: IncomingMessage;
  try {
    response = await getFollowing(url, headers, have > 0 ? { Range: `bytes=${String(have)}-` } : {});
  } catch (error) {
    throw error instanceof OgwError && error.message.includes('redirects') ? error : new TransientDownloadError(errorText(error, url));
  }
  const status = response.statusCode ?? 0;
  if (have > 0 && status === 416) {
    response.resume();
    return;
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new OgwError(`download failed (${String(status)}): ${url}`);
  }
  const append = have > 0 && status === 206;
  const idle = setIdleTimeout(response, url);
  try {
    await pipeline(response, createWriteStream(dest, { flags: append ? 'a' : 'w' }));
  } catch (error) {
    throw new TransientDownloadError(errorText(error, url));
  } finally {
    idle.stop();
  }
}

function errorText(error: unknown, url: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith('download failed') ? text : `download failed: ${text}: ${url}`;
}

let downloadIdleMs: number = LIMITS.shortMs;

/** Sets how long a download may receive nothing before it fails (tests). */
export function setDownloadIdleMs(ms: number | null): void {
  downloadIdleMs = ms ?? LIMITS.shortMs;
}

/**
 * GET with node:https rather than fetch: on this Node fetch reads large bodies an order of magnitude slower than
 * node:https on the same link. Follows redirects; `headers` go only to the origin of `url`, so a token never reaches
 * a CDN, and `everywhere` (the `Range` of a resumed download) goes to every redirect target.
 */
function getFollowing(
  url: string,
  headers: Record<string, string>,
  everywhere: Record<string, string>,
  redirects = 0,
  origin = new URL(url).origin,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const request = client.get(target, { headers: { ...(target.origin === origin ? headers : {}), ...everywhere } }, (response) => {
      // the request's timeout covers the wait for a response; a stalled body is the body's idle timer's (`setIdleTimeout`),
      // else the two timers of the same length race and a stall fails as `aborted` or as `no data`
      request.setTimeout(0);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new OgwError(`download failed: more than ${String(MAX_REDIRECTS)} redirects: ${url}`));
          return;
        }
        getFollowing(new URL(location, target).href, headers, everywhere, redirects + 1, origin).then(resolve, reject);
        return;
      }
      resolve(response);
    });
    request.setTimeout(downloadIdleMs, () => request.destroy(new OgwError(`download failed: no response within ${String(downloadIdleMs)} ms: ${url}`)));
    request.on('error', reject);
  });
}

/** Fails the body when no byte arrives for `downloadIdleMs`; a download that keeps receiving has no total time limit. */
function setIdleTimeout(response: IncomingMessage, url: string): { stop(): void } {
  let timer = setTimeout(fail, downloadIdleMs);
  function fail(): void {
    response.destroy(new OgwError(`download failed: no data for ${String(downloadIdleMs)} ms: ${url}`));
  }
  const onData = (): void => {
    clearTimeout(timer);
    timer = setTimeout(fail, downloadIdleMs);
  };
  response.on('data', onData);
  return {
    stop() {
      clearTimeout(timer);
      response.off('data', onData);
    },
  };
}

const realNet: Net = {
  async request(url, init = {}) {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      signal: AbortSignal.timeout(LIMITS.httpMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: headersOf(response), body };
  },
  async download(url, dest, headers) {
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    for (let attempt = 1; ; attempt++) {
      try {
        await downloadOnce(url, dest, headers ?? {});
        return;
      } catch (error) {
        // a status answer is final; a broken connection or a stall is tried again from the bytes already written
        if (!(error instanceof TransientDownloadError) || attempt >= DOWNLOAD_ATTEMPTS) throw error instanceof TransientDownloadError ? new OgwError(error.message) : error;
        await new Promise((resolve) => setTimeout(resolve, downloadRetryMs * attempt));
      }
    }
  },
  async lsRemote(url, patterns) {
    // git runs in a folder of the temp folder of ogw: no sandboxed agent can put a repository and its config there
    const dir = await newPrivateTempFolder('ogw-ls-remote-');
    try {
      const result = await gitRaw(dir, ['ls-remote', '--', url, ...patterns], { timeoutMs: LIMITS.shortMs });
      if (result.code !== 0) throw new OgwError(`git ls-remote ${[url, ...patterns].join(' ')} failed: ${result.stderr.trim()}`);
      return result.stdout
        .split('\n')
        .map((line) => /^([0-9a-f]+)\s+(\S+)$/.exec(line.trim()))
        .filter((m) => m !== null)
        .map((m) => ({ id: m[1] as string, ref: m[2] as string }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  async gitFile(url, commit, path) {
    const dir = await newPrivateTempFolder('ogw-gitfile-');
    try {
      const steps: string[][] = [
        ['init', '--quiet'],
        ['remote', 'add', '--', 'origin', url],
        ['fetch', '--quiet', '--depth', '1', 'origin', commit],
      ];
      for (const args of steps) {
        const result = await gitRaw(dir, args, { timeoutMs: LIMITS.programMs });
        if (result.code !== 0) throw new OgwError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
      }
      const shown = await gitRaw(dir, ['show', `FETCH_HEAD:${path}`]);
      return shown.code === 0 ? shown.stdout : null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

let current: Net = realNet;

export function net(): Net {
  return current;
}

/** Replaces the network for tests; null puts the real one back. */
export function setNet(replacement: Net | null): void {
  current = replacement ?? realNet;
}

export async function requestJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await net().request(url, { headers });
  if (response.status !== 200) throw new OgwError(`GET ${url} answered ${String(response.status)}`);
  try {
    return JSON.parse(response.body.toString('utf8')) as T;
  } catch {
    throw new OgwError(`GET ${url} did not answer JSON`);
  }
}

/**
 * The commit `ref` names among the `git ls-remote` lines of `refPatterns(ref)`: for `HEAD` or a full ref the
 * exact line, else the exact branch `refs/heads/<ref>` or tag `refs/tags/<ref>`; a tag or full ref through its
 * peeled `^{}` line when it is an annotated tag. Null when nothing matches; fails when a branch and a tag both match.
 */
export function commitOfRef(lines: readonly RemoteRef[], ref: string): string | null {
  const id = (name: string): string | undefined => lines.find((l) => l.ref === name)?.id;
  if (ref === 'HEAD' || ref.startsWith('refs/')) return id(`${ref}^{}`) ?? id(ref) ?? null;
  const branch = id(`refs/heads/${ref}`);
  const tag = id(`refs/tags/${ref}^{}`) ?? id(`refs/tags/${ref}`);
  if (branch !== undefined && tag !== undefined) throw new OgwError(`${ref} names both the branch refs/heads/${ref} and the tag refs/tags/${ref}`);
  return branch ?? tag ?? null;
}

/** The `git ls-remote` patterns that list every line `commitOfRef` reads for `ref`. */
export function refPatterns(ref: string): string[] {
  if (ref === 'HEAD') return [ref];
  if (ref.startsWith('refs/')) return [ref, `${ref}^{}`];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
}

/** The commit of `ref` (a branch, a tag, a full ref, or HEAD) of the git repository at `url`, or null when it is not there. */
export async function remoteCommit(url: string, ref: string): Promise<string | null> {
  const commit = commitOfRef(await net().lsRemote(url, refPatterns(ref)), ref);
  return commit !== null && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}
