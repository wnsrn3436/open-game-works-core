import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git } from '../../../lib/git.ts';
import { needleHits, scanFiles, type Needle } from '../../../lib/secret-scan.ts';
import { gameSecretService } from '../../../lib/secrets.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { filesBelow } from '../../deploy/lib/target.ts';
import { environmentSecrets, signingSecrets } from '../../secret/lib/names.ts';
import { isPlainObject } from '../../settings/lib/json-path.ts';
import type { Env } from './names.ts';
import { isZip, zipEntries } from './zip.ts';

const PCK_MAGIC = 0x43504447; // "GDPC"

export type { Needle } from '../../../lib/secret-scan.ts';

/** Label of the DEV `devAccess` secret, which the DEV build info file holds. */
export const DEV_ACCESS = 'secret devAccess';

/** The build info file inside an exported package. */
const BUILD_INFO = 'generated/build_info.json';

/** Secret values of the build's environment and signing, plus the workspace absolute path. */
export function needles(ctx: Context, game: string, settings: GameSettings, env: Env, workspaceRoot: string): Needle[] {
  const result: Needle[] = [{ label: 'workspace absolute path', value: Buffer.from(workspaceRoot) }];
  const envSettings = settings.environments?.[env];
  const fromEnv = isPlainObject(envSettings) ? environmentSecrets(envSettings) : [];
  const names: [string, string, 'signing' | Env][] = [
    ...fromEnv.map((s): [string, string, Env] => [s.label, s.name, env]),
    ...signingSecrets(settings).map((s): [string, string, 'signing'] => [s.label, s.name, 'signing']),
  ];
  for (const [label, name, scope] of names) {
    const value = ctx.secrets.get(gameSecretService(game, scope, name));
    if (value !== null && value.length > 0) result.push({ label, value: Buffer.from(value) });
  }
  return result;
}

function hits(where: string, bytes: Buffer, list: readonly Needle[]): string[] {
  return needleHits(where, bytes, list, false);
}

type Range = readonly [number, number];

/** Byte ranges of `generated/build_info.json` in a Godot pck that starts at `base` of `bytes`. */
function pckBuildInfo(bytes: Buffer, base: number): Range[] {
  if (bytes.length < base + 40 || bytes.readUInt32LE(base) !== PCK_MAGIC) return [];
  const format = bytes.readUInt32LE(base + 4);
  const flags = bytes.readUInt32LE(base + 20);
  if ((flags & 1) !== 0) return [];
  // flag 2 (relative file base): offsets count from the pck start, else from the start of the file
  const origin = (flags & 2) !== 0 ? base : 0;
  const fileBase = origin + Number(bytes.readBigUInt64LE(base + 24));
  let pos = format === 3 ? origin + Number(bytes.readBigUInt64LE(base + 32)) : format === 2 ? base + 24 + 8 + 64 : -1;
  if (pos < 0 || pos + 4 > bytes.length) return [];
  const ranges: Range[] = [];
  const count = bytes.readUInt32LE(pos);
  pos += 4;
  for (let i = 0; i < count && pos + 4 <= bytes.length; i++) {
    const length = bytes.readUInt32LE(pos);
    const path = bytes.toString('utf8', pos + 4, pos + 4 + length).replace(/\0+$/, '').replace(/^res:\/\//, '');
    pos += 4 + length;
    if (pos + 16 > bytes.length) break;
    const offset = fileBase + Number(bytes.readBigUInt64LE(pos));
    const size = Number(bytes.readBigUInt64LE(pos + 8));
    pos += 8 + 8 + 16 + 4;
    if (path === BUILD_INFO) ranges.push([offset, offset + size]);
  }
  return ranges;
}

/** Byte ranges of the build info file in a pck file or in a pck embedded at the end of an executable. */
function buildInfoRanges(bytes: Buffer): Range[] {
  const ranges = pckBuildInfo(bytes, 0);
  if (bytes.length >= 12 && bytes.readUInt32LE(bytes.length - 4) === PCK_MAGIC) {
    const start = bytes.length - 12 - Number(bytes.readBigUInt64LE(bytes.length - 12));
    if (start >= 0) ranges.push(...pckBuildInfo(bytes, start));
  }
  return ranges;
}

/** True when every occurrence of `value` in `bytes` lies inside one of `ranges`. */
function onlyInside(bytes: Buffer, value: Buffer, ranges: readonly Range[]): boolean {
  for (let at = bytes.indexOf(value); at !== -1; at = bytes.indexOf(value, at + 1)) {
    if (!ranges.some(([from, to]) => at >= from && at + value.length <= to)) return false;
  }
  return true;
}

/**
 * Hits in one file or archive entry. A needle in `allowed` is not a hit inside the build info file: in a pck, in a pck
 * embedded in an executable, or as the archive entry itself. Inside a zip archive the needle is looked for in its entries.
 */
function fileHits(where: string, name: string, bytes: Buffer, list: readonly Needle[], allowed: ReadonlySet<string>): string[] {
  const isInfo = name === BUILD_INFO || name.endsWith(`/${BUILD_INFO}`);
  const zip = isZip(bytes);
  const ranges = zip || isInfo ? [] : buildInfoRanges(bytes);
  const checked = list.filter((n) => {
    if (!allowed.has(n.label)) return true;
    if (isInfo || zip) return false;
    return !onlyInside(bytes, n.value, ranges);
  });
  const found = hits(where, bytes, checked);
  if (!zip) return found;
  for (const entry of zipEntries(bytes)) found.push(...fileHits(`${where}!${entry.name}`, entry.name, entry.data(), list, allowed));
  return found;
}

/** Tracked files of the checkout that hold a needle. */
export async function scanRepo(game: GameRepo, list: readonly Needle[]): Promise<string[]> {
  const files = (await git(game.root, ['ls-files', '-z'])).split('\0').filter((f) => f.length > 0);
  return scanFiles(game.root, files, list, { lines: false });
}

/**
 * Artifact files and the entries of zip archives among them that hold a needle. A needle labelled in
 * `allowedInBuildInfo` is not a hit inside the package's build info file (`build` `## build-time check` `secret`: the
 * DEV build's `dev_access`).
 */
export async function scanArtifacts(root: string, dirs: readonly string[], list: readonly Needle[], allowedInBuildInfo: readonly string[] = []): Promise<string[]> {
  const found: string[] = [];
  const allowed = new Set(allowedInBuildInfo);
  for (const dir of dirs) {
    for (const path of await filesBelow(dir)) {
      const rel = relative(root, path);
      found.push(...fileHits(rel, relative(dir, path), await readFile(path), list, allowed));
    }
  }
  return found;
}
