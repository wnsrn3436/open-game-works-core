import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { git, revParse, showFile } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import { runData } from '../../data/api.ts';
import type { PatchEntry } from '../../deploy/lib/deploylist.ts';
import { requireEngine } from '../../env/api.ts';
import { mergedCoreSettings, resourceKeyPaths, type ResourceKeyEntry } from '../../generate/api.ts';
import { dataVersionsAt, readDataVersions, withCommitCheckout } from './atcommit.ts';
import { dataBundleFailures, dataResourceKeys, resourceKeysAt } from './bundle-data.ts';
import { headerRows } from './csv.ts';
import { engineJson } from './host.ts';
import { buildTagName, tagCommit } from './names.ts';
import type { BundleBuildInput } from './platform.ts';
import { clientDataFiles, fileEntry } from './update.ts';
import { coreValue } from './waittime.ts';

interface PackFile {
  /** `res://` path inside the pck. */
  target: string;
  /** Absolute source file. */
  source: string;
  size: number;
}

const ENTRY_OVERHEAD = 4 + 8 + 8 + 16 + 4;
const HEADER = 24 + 16 + 64 + 4;

function pad(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}

/** Bytes a pck holding these files takes (pack format 3, 32-byte file alignment). */
export function pckSize(files: readonly PackFile[]): number {
  return HEADER + files.reduce((sum, f) => sum + ENTRY_OVERHEAD + pad(Buffer.byteLength(f.target), 4) + pad(f.size, 32), 0);
}

function shaMap(text: string | null): Map<string, string> {
  return new Map(headerRows(text ?? '').map((r) => [r.key ?? '', r.sha256 ?? '']));
}

/** Keys whose `sha256` differs from the tag commit, or that the tag lacks, in any commit after the tag up to HEAD. */
export async function changedKeys(root: string, tagCommitSha: string): Promise<{ changed: string[]; removed: string[] }> {
  const base = shaMap((await showFile(root, tagCommitSha, 'resource/resources.csv'))?.toString('utf8') ?? null);
  const commits = (await git(root, ['rev-list', `${tagCommitSha}..HEAD`])).split('\n').filter((c) => c.length > 0);
  const changed = new Set<string>();
  for (const commit of commits) {
    const now = shaMap((await showFile(root, commit, 'resource/resources.csv'))?.toString('utf8') ?? null);
    for (const [key, sha] of now) if (base.get(key) !== sha) changed.add(key);
  }
  const head = shaMap((await showFile(root, 'HEAD', 'resource/resources.csv'))?.toString('utf8') ?? null);
  const removed = [...base.keys()].filter((key) => !head.has(key));
  return { changed: [...changed].filter((k) => head.has(k)).sort(), removed };
}

/** Files of a resource key: the `.import` file and its `dest_files`, or the file itself. */
async function keyFiles(clientDir: string, resPath: string): Promise<PackFile[]> {
  const rel = resPath.replace(/^res:\/\//, '');
  const importFile = join(clientDir, `${rel}.import`);
  const file = async (target: string): Promise<PackFile> => {
    const source = join(clientDir, target.replace(/^res:\/\//, ''));
    return { target, source, size: (await stat(source)).size };
  };
  if (!exists(importFile)) return [await file(resPath)];
  const text = await readFile(importFile, 'utf8');
  const deps = /^\[deps\][\s\S]*?^dest_files=\[(.*)\]$/m.exec(text);
  const dests = deps ? [...(deps[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string) : [];
  return [await file(`${resPath}.import`), ...(await Promise.all(dests.map(file)))];
}

async function changedCode(root: string, tagCommitSha: string): Promise<Set<string>> {
  const out = await git(root, ['diff', '--name-only', tagCommitSha, 'HEAD', '--', 'client/']);
  return new Set(out.split('\n').filter((p) => p.endsWith('.gd')).map((p) => `res://${p.slice('client/'.length)}`));
}

function usesChangedCode(text: string, changed: Set<string>): boolean {
  return [...text.matchAll(/^\[ext_resource [^\]]*path="([^"]+)"/gm)].some((m) => changed.has(m[1] as string));
}

/** Bundle check items about the chosen files (`build` engines/godot.md `### bundle export` 5). */
export async function bundleFileFailures(files: readonly PackFile[]): Promise<string[]> {
  const failures: string[] = [];
  for (const f of files) {
    if (f.target.endsWith('.gd') || f.target.endsWith('.gdc')) failures.push(`bundle holds code: ${f.target}`);
    else if (!/^res:\/\/(resource|\.godot\/imported|bundle_keys)\//.test(f.target)) failures.push(`bundle holds a path outside resource: ${f.target}`);
    else if ((f.target.endsWith('.tscn') || f.target.endsWith('.tres')) && (await readFile(f.source, 'utf8')).includes('type="GDScript"')) {
      failures.push(`bundle holds an embedded script: ${f.target}`);
    }
  }
  return failures;
}

interface Pack {
  keys: Record<string, ResourceKeyEntry>;
  files: PackFile[];
}

/** A changed resource key: its resource key list value and the files that go into a pck. */
export interface KeyedFiles {
  key: string;
  entry: ResourceKeyEntry;
  files: PackFile[];
}

/** Splits the keys into pcks below the limit, in key byte order. */
export function splitPacks(keyed: readonly KeyedFiles[], limit: number): { packs: Pack[]; failures: string[] } {
  const packs: Pack[] = [];
  const failures: string[] = [];
  const listFile = (n: number, keys: Record<string, ResourceKeyEntry>): PackFile => ({ target: `res://bundle_keys/patch_${String(n)}.json`, source: '', size: Buffer.byteLength(JSON.stringify(keys)) });
  for (const item of [...keyed].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))) {
    const alone = { [item.key]: item.entry };
    if (pckSize([...item.files, listFile(1, alone)]) > limit) {
      failures.push(`resource key ${item.key} alone passes the bundle file limit ${String(limit)}`);
      continue;
    }
    let pack = packs.at(-1);
    const keys = { ...(pack?.keys ?? {}), ...alone };
    if (!pack || pckSize([...pack.files, ...item.files, listFile(packs.length, keys)]) > limit) {
      pack = { keys: {}, files: [] };
      packs.push(pack);
    }
    pack.keys[item.key] = item.entry;
    pack.files.push(...item.files);
  }
  return { packs, failures };
}

const PACKER = `extends SceneTree

func _init() -> void:
\tvar spec: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]))
\tfor pck: Dictionary in spec["pcks"]:
\t\tvar packer := PCKPacker.new()
\t\tpacker.pck_start(pck["path"])
\t\tfor f: Dictionary in pck["files"]:
\t\t\tpacker.add_file(f["target"], f["source"])
\t\tpacker.flush()
\tquit(0)
`;

async function limitOf(ctx: Context, input: BundleBuildInput): Promise<number> {
  const core = await mergedCoreSettings(ctx, input.game);
  const values = ['game-update.maxFileBytes', 'GameUpdateCore.fileMaxBytes'].map((k) => coreValue(core, k));
  if (!values.every((v) => typeof v === 'number')) throw new OgwError('core settings game-update.maxFileBytes or GameUpdateCore.fileMaxBytes is missing');
  return Math.min(...values);
}

/** Bundle patch export of `build` engines/godot.md `### bundle export`; returns the bundle check failures. */
export async function godotBundle(ctx: Context, input: BundleBuildInput): Promise<string[]> {
  const root = input.game.root;
  const appCommit = await tagCommit(root, buildTagName(input.env, input.appVersion));
  const { changed, removed } = await changedKeys(root, appCommit);
  const failures = removed.map((key) => `resource key ${key} of app version ${input.appVersion} was removed`);
  const code = await changedCode(root, appCommit);
  const limit = await limitOf(ctx, input);
  const head = await revParse(root, 'HEAD', { env: ctx.env });
  const outDir = join(input.outDir, 'patch');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const bundles = await withCommitCheckout(ctx, input.game, head ?? 'HEAD', async (repo) => {
    const clientDir = join(repo.root, 'client');
    const meta = await engineJson(ctx, input.game, 'godot');
    const godot = await requireEngine(ctx, 'godot', meta.godot ?? '');
    // `ogw build run` compared this commit's data with the PROD data tag in the checkout
    const data = await runData(ctx, repo, { binary: true, strict: true, prodCompare: false });
    if (data.exitCode !== 0) throw new OgwError(`ogw data failed in the build workspace: ${data.stderr}`);
    await runOk(godot, ['--headless', '--path', clientDir, '--import'], { env: ctx.env, timeoutMs: LIMITS.programMs });
    const entries = (await readJsonIfExists<Record<string, ResourceKeyEntry>>(join(clientDir, 'generated', 'resource_keys.json'))) ?? {};
    const keyed: KeyedFiles[] = [];
    for (const key of changed) {
      const entry = entries[key];
      if (entry === undefined) continue;
      const files = (await Promise.all(resourceKeyPaths(entry).map((path) => keyFiles(clientDir, path)))).flat();
      const scene = files.find((f) => f.target.endsWith('.tscn'));
      if (scene && usesChangedCode(await readFile(scene.source, 'utf8'), code)) continue;
      keyed.push({ key, entry, files });
    }
    failures.push(...(await bundleFileFailures(keyed.flatMap((k) => k.files))));
    if (input.withData) {
      const appKeys = await resourceKeysAt(root, appCommit);
      for (const k of keyed) appKeys.add(k.key);
      const [app, build, dataKeys] = [await dataVersionsAt(ctx, input.game, appCommit), await readDataVersions(repo.root), await dataResourceKeys(repo.root)];
      failures.push(...dataBundleFailures({ appVersion: input.appVersion, app, build, dataKeys, appKeys }));
    }
    const split = splitPacks(keyed, limit);
    failures.push(...split.failures);
    if (failures.length > 0) return [];
    const spec = { pcks: [] as { path: string; files: { target: string; source: string }[] }[] };
    for (const [i, pack] of split.packs.entries()) {
      const n = i + 1;
      const list = join(clientDir, 'bundle_keys', `patch_${String(n)}.json`);
      await writeJsonAtomic(list, pack.keys);
      spec.pcks.push({ path: join(outDir, `patch_${String(n)}.pck`), files: [...pack.files, { target: `res://bundle_keys/patch_${String(n)}.json`, source: list }] });
    }
    const specFile = join(repo.root, 'ogw-pck-spec.json');
    await writeJsonAtomic(specFile, spec);
    await writeFileAtomic(join(repo.root, 'ogw-packer.gd'), PACKER);
    if (spec.pcks.length > 0) {
      await runOk(godot, ['--headless', '--path', clientDir, '--script', join(repo.root, 'ogw-packer.gd'), '--', specFile], { env: ctx.env, timeoutMs: LIMITS.programMs });
    }
    if (input.withData) {
      const files = await clientDataFiles(repo.root);
      for (const f of [...files.data, ...files.translations]) await copyFile(join(repo.root, 'client', 'build', 'data', f.name), join(outDir, f.name));
      return { versions: await readDataVersions(repo.root), files, count: spec.pcks.length };
    }
    return { versions: null, files: null, count: spec.pcks.length };
  });
  if (failures.length > 0 || Array.isArray(bundles)) return failures;
  const bundleFiles = [];
  for (let n = 1; n <= bundles.count; n++) bundleFiles.push({ bundle: `patch_${String(n)}`, ...(await fileEntry(join(outDir, `patch_${String(n)}.pck`), `patch_${String(n)}.pck`)) });
  const entry: PatchEntry = {
    data_version: bundles.versions?.client ?? (await dataVersionsAt(ctx, input.game, appCommit)).client,
    data_files: bundles.files?.data ?? [],
    translation_files: bundles.files?.translations ?? [],
    bundle_files: bundleFiles,
  };
  await writeJsonAtomic(join(outDir, 'patch.json'), entry);
  return [];
}
