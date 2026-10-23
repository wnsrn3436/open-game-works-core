import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { FileEntry, UpdateJson } from '../../deploy/lib/deploylist.ts';
import { dataVersionsAt, protocolHash, type DataVersions } from './atcommit.ts';
import { dataBundleFailures, dataResourceKeys, resourceKeysAt } from './bundle-data.ts';
import { compareVersions, requireVersion, tagCommit, type BuildTag, type Env } from './names.ts';

/** Name, size and SHA-256 of a file (deploy list file entry). */
export async function fileEntry(path: string, name: string): Promise<FileEntry> {
  const bytes = await readFile(path);
  return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Client table binaries and translation binaries of `client/build/data/`. */
export async function clientDataFiles(root: string): Promise<{ data: FileEntry[]; translations: (FileEntry & { language: string })[] }> {
  const dir = join(root, 'client', 'build', 'data');
  const data: FileEntry[] = [];
  const translations: (FileEntry & { language: string })[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.bin')) continue;
    const m = /^translation_(.+)\.bin$/.exec(name);
    if (m) translations.push({ language: m[1] as string, ...(await fileEntry(join(dir, name), name)) });
    else data.push(await fileEntry(join(dir, name), name));
  }
  return { data, translations };
}

/** The `<env>-<app version>-bundle-<n>` tag with the largest n, or null. */
export function latestBundleTag(tags: readonly BuildTag[], env: Env, appVersion: string): BuildTag | null {
  const bundles = tags.filter((t) => t.env === env && t.version === appVersion && t.bundle !== null);
  return bundles.sort((a, b) => (b.bundle ?? 0) - (a.bundle ?? 0))[0] ?? null;
}

/**
 * App versions whose `<env>-<app version>` tag commit has the same Client build target protocol hash as this build,
 * and for which this build's data passes the `bundle` check together with the app version's latest bundle: this
 * build's data can go to them (`build` `## deploy`, `update.json` `apps`). The app version has the resource keys of
 * `resources.csv` at its tag commit and at its latest bundle's tag commit.
 */
export async function compatibleApps(ctx: Context, game: GameRepo, env: Env, tags: readonly BuildTag[], build: DataVersions): Promise<string[]> {
  const apps: string[] = [];
  const own = tags.filter((t) => t.env === env && t.bundle === null).sort((a, b) => compareVersions(requireVersion(a.version), requireVersion(b.version)));
  const dataKeys = await dataResourceKeys(game.root);
  for (const tag of own) {
    const commit = await tagCommit(game.root, tag.tag);
    const app = await dataVersionsAt(ctx, game, commit);
    if (protocolHash(app.client) !== protocolHash(build.client)) continue;
    const appKeys = await resourceKeysAt(game.root, commit);
    const bundle = latestBundleTag(tags, env, tag.version);
    if (bundle) for (const key of await resourceKeysAt(game.root, await tagCommit(game.root, bundle.tag))) appKeys.add(key);
    if (dataBundleFailures({ appVersion: tag.version, app, build, dataKeys, appKeys }).length === 0) apps.push(tag.version);
  }
  return apps;
}

/** Writes `builds/<env>-<version>/update/`: the client data files and `update.json`. */
export async function writeUpdate(root: string, outDir: string, dataVersion: string, apps: string[]): Promise<UpdateJson> {
  const files = await clientDataFiles(root);
  const dir = join(outDir, 'update');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of [...files.data, ...files.translations]) await copyFile(join(root, 'client', 'build', 'data', file.name), join(dir, file.name));
  const update: UpdateJson = { data_version: dataVersion, data_files: files.data, translation_files: files.translations, apps };
  await writeJsonAtomic(join(dir, 'update.json'), update);
  return update;
}
