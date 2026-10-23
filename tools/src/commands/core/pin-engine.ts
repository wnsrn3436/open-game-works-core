import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, writeJsonAtomic } from '../../lib/fsx.ts';
import { checkoutLock } from '../../lib/git.ts';
import { resolveCoreImpl } from '../../lib/game.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withLock } from '../../lib/lock.ts';
import { readEngineJson, type EngineDownload, type EngineJson } from './lib/impl.ts';

const ENGINE = /^[a-z0-9][a-z0-9-]*$/;

/** Items whose `sha256` is missing or empty: `downloads`, `buildTools[].downloads`, `gut`, plugins not named `ogw-`. */
export function unpinnedItems(engineJson: EngineJson): EngineDownload[] {
  const items: EngineDownload[] = [
    ...(engineJson.downloads ?? []),
    ...(engineJson.buildTools ?? []).flatMap((tool) => tool.downloads ?? []),
    ...(engineJson.gut ? [engineJson.gut] : []),
    ...(engineJson.plugins ?? []).filter((plugin) => !plugin.name.startsWith('ogw-')),
  ];
  return items.filter((item) => typeof item.sha256 !== 'string' || item.sha256 === '');
}

const MAX_REDIRECTS = 10;

/**
 * Whether `pin-engine` may fetch `url`: `https:`, or `http:` to a loopback host (no network path to tamper with).
 * A hash pinned from a plain `http:` download would trust whatever a network attacker sent.
 */
export function downloadAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
}

/** SHA-256 (lower-case hex) of the file at `url`. Every URL of the redirect chain must pass `downloadAllowed`. */
export async function downloadSha256(url: string, timeoutMs: number = LIMITS.programMs): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop += 1) {
    if (!downloadAllowed(current)) throw new OgwError(`not an https URL: ${current}`);
    const response = await fetch(current, { signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new OgwError(`too many redirects: ${url}`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok || !response.body) throw new OgwError(`HTTP ${String(response.status)}`);
    const hash = createHash('sha256');
    for await (const chunk of response.body) hash.update(chunk as Uint8Array);
    return hash.digest('hex');
  }
}

/**
 * Sets the downloaded hashes on the `engine.json` on disk now, under a lock: the file is read again because the
 * core agent or another `pin-engine` job may have changed it during the downloads. Only items that are still
 * unpinned and whose `url` was downloaded get a `sha256`. Returns the pinned URLs and the URLs of unpinned items
 * that were not downloaded (added during the downloads).
 */
async function writeHashes(
  impl: string,
  engine: string,
  hashes: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<{ pinned: string[]; left: string[] }> {
  const file = join(impl, 'client', engine, 'engine.json');
  return withLock(await checkoutLock(impl, `ogw-pin-engine-${engine}.lock`, { env }), async () => {
    const fresh = await readEngineJson(impl, engine);
    const pinned: string[] = [];
    const left: string[] = [];
    for (const item of unpinnedItems(fresh)) {
      const sha = typeof item.url === 'string' ? hashes.get(item.url) : undefined;
      if (sha === undefined) {
        left.push(typeof item.url === 'string' && item.url !== '' ? item.url : '(item without url)');
        continue;
      }
      item.sha256 = sha;
      pinned.push(item.url as string);
    }
    if (pinned.length > 0) await writeJsonAtomic(file, fresh);
    return { pinned, left };
  });
}

/** `ogw core pin-engine <engine>`: fills the missing `sha256` values of `engine.json`. */
export const pinEngineCommand: CommandDef = {
  name: ['core', 'pin-engine'],
  usage: 'ogw core pin-engine <engine>',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const engine = positional(args, 0, 'engine');
    if (!ENGINE.test(engine)) throw new OgwError(`invalid engine: ${engine}`);
    const impl = await resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
    const file = join(impl, 'client', engine, 'engine.json');
    if (!exists(file)) throw new OgwError(`not found: ${file}`);
    const items = unpinnedItems(await readEngineJson(impl, engine));
    const urls = [...new Set(items.map((item) => (typeof item.url === 'string' ? item.url : '')))];
    const hashes = new Map<string, string>();
    const reasons = new Map<string, string>();
    await Promise.all(urls.map(async (url) => {
      try {
        if (url === '') throw new OgwError('no url');
        hashes.set(url, await downloadSha256(url));
      } catch (error) {
        reasons.set(url === '' ? '(item without url)' : url, error instanceof Error ? error.message : String(error));
      }
    }));
    if (reasons.size > 0) {
      const failed = [...reasons.keys()].sort();
      const lines = failed.map((url) => `${url}: ${reasons.get(url) ?? ''}`);
      throw new OgwError(`download failed, engine.json not written:\n${lines.join('\n')}`, 1, { failed });
    }
    const { pinned, left } = hashes.size > 0 ? await writeHashes(impl, engine, hashes, ctx.env) : { pinned: [], left: [] };
    if (left.length > 0) {
      throw new OgwError(`engine.json changed during the downloads; run ogw core pin-engine ${engine} again to pin:\n${left.join('\n')}`, 1, { pinned, left });
    }
    return {
      text: pinned.length > 0 ? `pinned:\n${pinned.join('\n')}` : 'nothing to pin',
      data: { pinned },
    };
  },
};
