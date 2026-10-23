import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { Net } from '../../../src/commands/env/lib/net.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import type { TestWorkspace } from '../../helpers/workspace.ts';

/**
 * Stand-in for `src/commands/core/api.ts`: published releases live in `open-game-works-core-releases/<version>/`, assets
 * pre-extracted. With harness settings `useLocalCore`, `coreRelease` gives `open-game-works-core-releases/local/` for every version.
 */
export const coreApiMock = {
  coreRelease: async (ctx: Context, version: string) => {
    if ((await ctx.settings()).useLocalCore) return { version, dir: join((await ctx.workspace()).coreReleases, 'local'), local: true };
    return coreApiMock.publishedRelease(ctx, version);
  },
  publishedRelease: async (ctx: Context, version: string) => ({
    version,
    dir: join((await ctx.workspace()).coreReleases, version),
    local: false,
  }),
  coreReleaseOfGame: async (ctx: Context, game: GameRepo) => {
    const settings = JSON.parse(readFileSync(join(game.root, 'settings.json'), 'utf8')) as { coreVersion: string };
    return coreApiMock.coreRelease(ctx, settings.coreVersion);
  },
  extractedAsset: (_ctx: Context, release: { dir: string }, asset: string) => Promise.resolve(join(release.dir, 'extracted', asset)),
  remoteReleaseVersions: () => Promise.resolve([]),
  markProposalReleased: () => Promise.resolve('marked'),
};

export function ctxOf(ws: TestWorkspace, cwd: string = ws.root): Context {
  return createContext({ cwd, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

export function write(path: string, content: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A zip (stored, not compressed) of `files`: path inside the zip → content. */
export function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The GUT zip every test release names in `engine.json` `gut`. */
export const GUT_ZIP = storedZip({ 'addons/gut/gut_cmdln.gd': 'extends SceneTree\n' });
export const GUT_URL = 'https://example.test/gut-9.4.0.zip';

/** Files the fake network serves: URL → bytes. */
export const SERVED = new Map<string, Buffer>([[GUT_URL, GUT_ZIP]]);

/** A network that serves `SERVED` and counts downloads per URL. */
export function fakeNet(downloads: Map<string, number> = new Map()): Net {
  return {
    request: () => Promise.reject(new Error('no request in this test')),
    download(url, dest) {
      downloads.set(url, (downloads.get(url) ?? 0) + 1);
      const bytes = SERVED.get(url);
      if (!bytes) return Promise.reject(new Error(`download failed (404): ${url}`));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      return Promise.resolve();
    },
    lsRemote: () => Promise.resolve([]),
    gitFile: () => Promise.resolve(null),
  };
}

interface ModuleDef {
  name: string;
  side: 'client' | 'server';
  lifecycle?: boolean;
  operations?: { name: string; inputs: ('translationKey' | 'other')[] }[];
  dependencies?: string[];
  optionalDependencies?: string[];
  devDependencies?: string[];
  settings?: { key: string; type: string; source: string; owner: string }[];
  tables?: string[];
}

export const SPEC_MODULES: ModuleDef[] = [
  { name: 'BootstrapCore', side: 'client', dependencies: ['LogCore', 'NetworkCore'], devDependencies: ['QACore'], settings: [
    { key: 'firstScene', type: 'string', source: 'game', owner: 'none' },
    { key: 'gamepadSupported', type: 'boolean', source: 'game', owner: 'none' },
    { key: 'maxResolution', type: 'array<integer>?', source: 'game', owner: 'none' },
    { key: 'appId', type: 'string', source: 'game', owner: 'none' },
  ] },
  { name: 'EventCore', side: 'client', dependencies: ['LogCore'] },
  { name: 'LogCore', side: 'client', dependencies: ['UtilCore'] },
  { name: 'NetworkCore', side: 'client', dependencies: ['EventCore', 'LogCore', 'auth'], optionalDependencies: ['UICore'], settings: [
    { key: 'NetworkCore.retryCount', type: 'integer', source: 'core', owner: 'content' },
    { key: 'environments.<ENV>.serverUrl', type: 'string', source: 'game', owner: 'none' },
  ] },
  { name: 'QACore', side: 'client', dependencies: ['LogCore', 'UICore'], settings: [
    { key: 'uiCheckScreens', type: 'array<object>', source: 'game', owner: 'none' },
    { key: 'gamepadSupported', type: 'boolean', source: 'game', owner: 'none' },
  ] },
  { name: 'UICore', side: 'client', dependencies: ['EventCore'], settings: [
    { key: 'titleScene', type: 'string', source: 'game', owner: 'none' },
  ], tables: ['ui_sound'] },
  { name: 'UtilCore', side: 'client' },
  { name: 'auth', side: 'server', dependencies: ['storage'] },
  { name: 'cheat', side: 'server', dependencies: ['storage', 'server-time'], settings: [
    { key: 'environments.<ENV>.devAllowedCidrs', type: 'array<string>', source: 'game', owner: 'none' },
  ] },
  { name: 'friend', side: 'server', dependencies: ['storage'], tables: ['friend_limit'] },
  { name: 'migration', side: 'server', dependencies: ['storage'] },
  { name: 'routing', side: 'server', dependencies: ['storage'], devDependencies: ['cheat'] },
  { name: 'server-time', side: 'server' },
  { name: 'storage', side: 'server', tables: ['level_table'] },
  { name: 'user-snapshot-clone', side: 'server', dependencies: ['storage'] },
];

export function specJson(version: string, modules: ModuleDef[] = SPEC_MODULES): object {
  return {
    version,
    modules: modules.map((m) => ({
      name: m.name,
      side: m.side,
      lifecycle: m.lifecycle ?? (m.side === 'client' && m.name !== 'BootstrapCore' && m.name !== 'UtilCore'),
      dependencies: m.dependencies ?? [],
      optionalDependencies: m.optionalDependencies ?? [],
      devDependencies: m.devDependencies ?? [],
      settings: m.settings ?? [],
      settingsConstraints: [],
      tables: (m.tables ?? []).map((name) => ({ name, columns: [] })),
      usedTables: [],
      enums: [],
      invariants: [],
      reserved: [],
      formatArguments: [],
      collectedData: [],
      adapters: [],
      operations: m.operations ?? [],
    })),
  };
}

const FAKE_DATA_TOOL = String.raw`
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const get = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const toolDir = path.join(__dirname, '..');
const game = get('--game');
const dotGit = path.join(game, '.git');
const lockFile = !fs.existsSync(dotGit)
  ? path.join(game, '.ogw-generate.lock')
  : path.join(fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(game, fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir: /, '')), 'ogw-generate.lock');
const previous = get('--previous');
fs.appendFileSync(path.join(toolDir, 'calls.jsonl'), JSON.stringify({
  args,
  cwd: process.cwd(),
  gameSettings: JSON.parse(fs.readFileSync(get('--game-settings'), 'utf8')),
  modules: JSON.parse(fs.readFileSync(get('--modules'), 'utf8')),
  lockHeld: fs.existsSync(lockFile),
  previousVersion: previous ? fs.readFileSync(path.join(previous, 'client/build/data/data_version'), 'utf8').trim() : null,
  previousServerVersion: previous ? fs.readFileSync(path.join(previous, 'server/build/data/data_version'), 'utf8').trim() : null,
}) + '\n');
const behaviorFile = path.join(game, 'fake-data-tool.json');
const b = fs.existsSync(behaviorFile) ? JSON.parse(fs.readFileSync(behaviorFile, 'utf8')) : {};
if (args.includes('--binary')) {
  const vf = path.join(game, 'data', 'version.txt');
  const v = fs.existsSync(vf) ? fs.readFileSync(vf, 'utf8').trim() : 'v0';
  for (const side of ['client', 'server']) {
    const d = path.join(game, side, 'build', 'data');
    const own = path.join(game, 'data', side + '.txt');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'data_version'), (fs.existsSync(own) ? fs.readFileSync(own, 'utf8').trim() : v) + '\n');
  }
}
for (const [p, c] of Object.entries(b.write || {})) { fs.mkdirSync(path.dirname(path.join(game, p)), { recursive: true }); fs.writeFileSync(path.join(game, p), c); }
process.stdout.write(b.stdout || '');
process.stderr.write(b.stderr || '');
process.exitCode = b.exitCode || 0;
`;

const FAKE_CONTRACT_TOOL = String.raw`
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const get = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const toolDir = path.join(__dirname, '..');
const game = get('--game');
const previous = get('--previous');
const list = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : [];
fs.appendFileSync(path.join(toolDir, 'calls.jsonl'), JSON.stringify({
  args,
  cwd: process.cwd(),
  coreSettings: JSON.parse(fs.readFileSync(get('--core-settings'), 'utf8')),
  modules: JSON.parse(fs.readFileSync(get('--modules'), 'utf8')),
  previous: previous ? {
    contract: list(path.join(previous, 'contract')),
    proto: list(path.join(previous, 'proto')),
    contractVersion: fs.readFileSync(path.join(previous, 'contract_version'), 'utf8'),
    coreSettings: JSON.parse(fs.readFileSync(path.join(previous, 'core-settings.json'), 'utf8')),
  } : null,
}) + '\n');
const behaviorFile = path.join(game, 'fake-contract-tool.json');
const b = fs.existsSync(behaviorFile) ? JSON.parse(fs.readFileSync(behaviorFile, 'utf8')) : {};
process.stdout.write(b.stdout || '');
process.stderr.write(b.stderr || '');
process.exitCode = b.exitCode || 0;
`;

export interface ReleaseOptions {
  modules?: ModuleDef[];
  coreSettings?: object;
  licenses?: object;
  clientCore?: Record<string, string>;
  serverCore?: Record<string, string>;
  plugins?: Record<string, string>;
  /** `engine.json` `plugins`. */
  enginePlugins?: object[];
  godot?: string;
  protoName?: string;
}

/** A release folder `open-game-works-core-releases/<version>/` with its assets already extracted. */
export function makeRelease(ws: TestWorkspace, version: string, options: ReleaseOptions = {}): string {
  const dir = join(ws.coreReleases, version);
  write(join(dir, 'core-spec.json'), specJson(version, options.modules));
  write(join(dir, 'core-settings.json'), options.coreSettings ?? { 'NetworkCore.retryCount': 3, 'NetworkCore.timeouts': { connectMs: 1000, readMs: 2000 } });
  write(join(dir, 'licenses.json'), options.licenses ?? {
    components: [
      { name: 'Godot Engine', version: '4.5.1', license: 'MIT', url: 'https://godotengine.org', notice: 'c', platforms: ['android'], modules: [] },
      { name: 'webrtc-native', version: '1.0', license: 'MIT', url: 'u', notice: '', platforms: ['macos'], modules: ['RealtimeCore'] },
      { name: 'net-lib', version: '2.0', license: 'BSD-3-Clause', url: 'u2', notice: '', platforms: ['android'], modules: ['NetworkCore', 'X'] },
    ],
    texts: { MIT: 'MIT text', 'BSD-3-Clause': 'BSD text' },
  });
  const ex = join(dir, 'extracted');
  write(join(ex, 'client-godot.zip', 'engine.json'), {
    godot: options.godot ?? '4.5.1.stable',
    gut: { version: '9.4.0', url: GUT_URL, sha256: sha256Of(GUT_ZIP) },
    plugins: options.enginePlugins ?? [],
  });
  for (const [path, content] of Object.entries(options.clientCore ?? { 'log_core/log_core.gd': 'class_name LogCore\n' })) {
    write(join(ex, 'client-godot.zip', 'core', path), content);
  }
  for (const [path, content] of Object.entries(options.serverCore ?? { 'Dockerfile': 'FROM x\n', 'routing/index.ts': 'export {};\n' })) {
    write(join(ex, 'server.tgz', path), content);
  }
  if (options.plugins) {
    write(join(dir, 'client-godot-plugins.zip'), 'zip');
    for (const [path, content] of Object.entries(options.plugins)) write(join(ex, 'client-godot-plugins.zip', path), content);
  }
  write(join(ex, 'data-tool.tgz', 'bin', 'data-tool.js'), FAKE_DATA_TOOL);
  write(join(ex, 'data-tool.tgz', 'proto', 'ogw', 'core.proto'), 'syntax = "proto3";\n');
  write(join(ex, 'contract-tool.tgz', 'bin', 'contract-tool.js'), FAKE_CONTRACT_TOOL);
  write(join(ex, 'contract-tool.tgz', 'proto', 'ogw', options.protoName ?? 'core.proto'), `// ${version}\n`);
  return dir;
}

export function toolCalls(releaseDir: string, tool: 'data-tool.tgz' | 'contract-tool.tgz'): Record<string, unknown>[] {
  const file = join(releaseDir, 'extracted', tool, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

export const GAME_SETTINGS = {
  engine: 'godot',
  coreVersion: '1.0.0',
  coreModules: { client: ['NetworkCore'], server: ['friend'] },
  baseResolution: [1080, 1920],
  sourceLanguage: 'ko',
  supportedLanguages: ['ko', 'en', 'zh-Hans'],
  buildPlatforms: ['android', 'ios'],
  firstScene: 'scene/lobby/main',
  environments: { DEV: { serverUrl: 'https://dev' }, STG: {}, PROD: { serverUrl: 'https://prod' } },
  core: { 'NetworkCore.retryCount': 5, 'NetworkCore.timeouts': { readMs: 9000 } },
};

/** A fake executable that logs its arguments to `<dir>/<name>.log` and runs `body` (sh). */
export function fakeProgram(dir: string, name: string, body = ''): string {
  const path = join(dir, name);
  write(path, `#!/bin/sh\necho "$@" >> "${path}.log"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
