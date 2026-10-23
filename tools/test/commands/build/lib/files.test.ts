import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleFileFailures, pckSize, splitPacks } from '../../../../src/commands/build/lib/godot-bundle.ts';
import { answers, declarations, privacyManifest, writePrivacy } from '../../../../src/commands/build/lib/privacy.ts';
import { DEV_ACCESS, needles, scanArtifacts, scanRepo } from '../../../../src/commands/build/lib/secretscan.ts';
import type { CoreSpecModule } from '../../../../src/commands/build/lib/settingschecks.ts';
import { clientDataFiles, writeUpdate } from '../../../../src/commands/build/lib/update.ts';
import { coreValue } from '../../../../src/commands/build/lib/waittime.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';
import { gameRepo, setSecrets, setupGame, write } from '../helpers.ts';
import { makeZip } from '../zipwriter.ts';

const row = (patch: Partial<CoreSpecModule['collectedData'][number]>): CoreSpecModule['collectedData'][number] => ({
  dataType: 'user_id', description: 'id', source: 'module', purposes: ['account_management'], linked: true, tracking: false, shared: false, optional: false, platforms: ['android', 'ios'], condition: null, ...patch,
});

const spec: CoreSpecModule[] = [
  {
    name: 'auth', side: 'server', adapters: [], collectedData: [
      row({}),
      row({ dataType: 'none', description: 'nothing' }),
      row({ dataType: 'nickname', description: 'name', purposes: ['app_functionality'], optional: true }),
      row({ dataType: 'in_app_messages', description: 'chat', purposes: ['app_functionality', 'fraud_prevention'], tracking: true, optional: true, platforms: ['ios'] }),
      row({ dataType: 'advertising_data', description: 'ads', source: 'ads-admob', purposes: ['third_party_advertising'], tracking: true, shared: true }),
      row({ dataType: 'coarse_location', description: 'geo', condition: { path: 'consent.ageConfirmation', value: true } }),
    ],
  },
  { name: 'unused', side: 'server', adapters: [], collectedData: [row({ dataType: 'crash_data' })] },
];

describe('store privacy disclosure', () => {
  const settings = { consent: { trackingRequest: false, ageConfirmation: false }, environments: { STG: { adapters: { ads: 'fake' } }, PROD: { serverUrl: 'https://prod.example.com' } }, privacy: { contentData: [{ ...row({ dataType: 'other_data', description: 'birth month' }), source: undefined }] } };

  it('chooses declaration rows by module, adapter and condition', () => {
    const rows = declarations(settings, 'STG', spec.slice(0, 1));
    expect(rows.map((r) => `${r.dataType}:${r.source}`)).toEqual(['user_id:module', 'nickname:module', 'in_app_messages:module', 'other_data:game settings privacy.contentData']);
    const withAds = declarations({ ...settings, consent: { ageConfirmation: true }, environments: { STG: { adapters: { ads: 'ads-admob' } } } }, 'STG', spec.slice(0, 1));
    expect(withAds.map((r) => r.dataType)).toContain('advertising_data');
    expect(withAds.map((r) => r.dataType)).toContain('coarse_location');
  });

  it('merges rows per store data type', () => {
    const rows = declarations(settings, 'STG', spec.slice(0, 1));
    const store = answers(rows.filter((r) => r.platforms.includes('ios')), 0, true);
    const other = store.find((a) => a.type === 'Other User Content');
    expect(other).toMatchObject({ linked: true, tracking: true, optional: true, purposes: ['App Functionality'] });
    expect(other?.rows.map((r) => r.description)).toEqual(['name', 'chat']);
    expect(answers(rows, 0, false).every((a) => !a.tracking)).toBe(true);
  });

  it('writes the files of the target platforms', async () => {
    const ws = makeWorkspace();
    const dir = join(ws.root, 'privacy');
    const out = await writePrivacy({ dir, env: 'STG', platforms: ['ios', 'android', 'web'], settings, modules: spec.slice(0, 1) });
    expect(out.files).toEqual(['PrivacyInfo.xcprivacy', 'app-store.md', 'google-play.md']);
    const xml = readFileSync(join(dir, 'PrivacyInfo.xcprivacy'), 'utf8');
    expect(xml).toContain('<key>NSPrivacyTracking</key>\n\t<false/>');
    expect(xml).toContain('<string>NSPrivacyCollectedDataTypeUserID</string>');
    expect(xml).toContain('<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>');
    const play = readFileSync(join(dir, 'google-play.md'), 'utf8');
    expect(play).toContain('## Personal info: Name\n\n- linked: true\n- tracking: false\n- shared: false\n- optional: true\n- purposes: App functionality\n- evidence:\n  - name (module)\n');
    expect(play).toContain('- encrypted in transit: Yes\n- users can request that data be deleted: Yes\n- account deletion URL: https://prod.example.com/account/deletion\n');
    expect(play).not.toContain('Messages');
    const app = readFileSync(join(dir, 'app-store.md'), 'utf8');
    expect(app).toContain('## Other User Content\n\n- linked: true\n- tracking: false');
    const none = await writePrivacy({ dir: join(ws.root, 'p2'), env: 'STG', platforms: ['macos'], settings: { environments: {} }, modules: [] });
    expect(none.files).toEqual(['app-store.md']);
    expect(readFileSync(join(ws.root, 'p2', 'app-store.md'), 'utf8')).toBe('# App Store Connect App Privacy\n\nNo data is collected.\n');
  });

  it('marks tracking in the manifest', () => {
    expect(privacyManifest([{ type: 'NSPrivacyCollectedDataTypeDeviceID', linked: false, tracking: true, shared: false, optional: true, purposes: [], rows: [] }])).toContain('<key>NSPrivacyTracking</key>\n\t<true/>');
  });
});

describe('secret scan', () => {
  it('finds secrets and the workspace path in the repo and in artifacts', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', { signing: { android: { keystore: 'ks' } } }, { 'leak.txt': 'value S3CRET-DB here' });
    setSecrets(ws, { 'ogw/g/STG/db': 'S3CRET-DB', 'ogw/g/STG/adminOgw': 'ADMIN-KEY', 'ogw/g/signing/ks': 'KEYSTORE', 'ogw/g/DEV/devAccess': 'DEVACCESS' });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const list = needles(ctx, 'g', JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as never, 'STG', ws.root);
    expect(list.map((n) => n.label)).toEqual(['workspace absolute path', 'secret db', 'admin operator ogw secret', 'signing android keystore']);
    expect(await scanRepo(await gameRepo(ws), list)).toEqual(['leak.txt: secret db']);
    const out = join(dir, 'builds', 'stg-1.0.0', 'android');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'g.aab'), makeZip({ 'base/assets/a.txt': `path ${ws.root}/games`, 'b.txt': 'KEYSTORE' }));
    writeFileSync(join(out, 'g.txt'), 'ADMIN-KEY');
    expect(await scanArtifacts(dir, [out, join(dir, 'none')], list)).toEqual([
      'builds/stg-1.0.0/android/g.aab!base/assets/a.txt: workspace absolute path',
      'builds/stg-1.0.0/android/g.aab!b.txt: signing android keystore',
      'builds/stg-1.0.0/android/g.txt: admin operator ogw secret',
    ]);
  });

  it('allows the DEV devAccess value only inside the build info file of a package; the repo scan keeps it', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', {}, { 'client/features/x.gd': 'var k = "DEVACCESS"' });
    setSecrets(ws, { 'ogw/g/DEV/devAccess': 'DEVACCESS' });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const dev = needles(ctx, 'g', { environments: { DEV: { secrets: { devAccess: 'devAccess' } } } }, 'DEV', ws.root);
    expect(dev.map((n) => n.label)).toEqual(['workspace absolute path', DEV_ACCESS]);
    expect(await scanRepo(await gameRepo(ws), dev)).toEqual(['client/features/x.gd: secret devAccess']);
    const info = JSON.stringify({ environment: 'DEV', dev_access: 'DEVACCESS' });
    const out = join(dir, 'builds', 'dev-1.0.0');
    put(out, 'linux/g.pck', pckWith({ 'res://generated/build_info.json': info, 'res://features/a.gd': 'x' }));
    put(out, 'web/g.pck', pckWith({ 'res://generated/build_info.json': info, 'res://features/x.gd': 'var k = "DEVACCESS"' }));
    put(out, 'android/g.apk', makeZip({ 'assets/generated/build_info.json': info, 'assets/a.txt': 'a' }, true));
    put(out, 'android2/g.apk', makeZip({ 'assets/generated/build_info.json': info, 'assets/b.txt': 'DEVACCESS' }));
    const embedded = pckWith({ 'res://generated/build_info.json': info });
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(embedded.length));
    put(out, 'windows/g.exe', Buffer.concat([Buffer.from('MZ program bytes'), embedded, size, Buffer.from('GDPC')]));
    put(out, 'windows2/g.exe', Buffer.concat([Buffer.from('MZ DEVACCESS'), embedded, size, Buffer.from('GDPC')]));
    const dirs = ['linux', 'web', 'android', 'android2', 'windows', 'windows2'].map((p) => join(out, p));
    expect(await scanArtifacts(dir, dirs, dev, [DEV_ACCESS])).toEqual([
      'builds/dev-1.0.0/web/g.pck: secret devAccess',
      'builds/dev-1.0.0/android2/g.apk!assets/b.txt: secret devAccess',
      'builds/dev-1.0.0/windows2/g.exe: secret devAccess',
    ]);
    expect(await scanArtifacts(dir, [join(out, 'linux'), join(out, 'android')], dev)).toEqual([
      'builds/dev-1.0.0/linux/g.pck: secret devAccess',
      'builds/dev-1.0.0/android/g.apk: secret devAccess',
      'builds/dev-1.0.0/android/g.apk!assets/generated/build_info.json: secret devAccess',
    ]);
  });
});

function put(dir: string, path: string, bytes: Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}

/** A Godot pck (format 3, relative file base) holding the files. */
function pckWith(files: Record<string, string>): Buffer {
  const datas = Object.values(files).map((c) => Buffer.from(c));
  const header = Buffer.alloc(24 + 16 + 64);
  header.writeUInt32LE(0x43504447, 0);
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(2, 20);
  header.writeBigUInt64LE(BigInt(header.length), 24);
  const blob = Buffer.concat(datas);
  header.writeBigUInt64LE(BigInt(header.length + blob.length), 32);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(datas.length);
  let offset = 0;
  const entries = Object.keys(files).map((path, i) => {
    const raw = Buffer.from(path);
    const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4);
    raw.copy(padded);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(padded.length);
    const tail = Buffer.alloc(8 + 8 + 16 + 4);
    tail.writeBigUInt64LE(BigInt(offset), 0);
    tail.writeBigUInt64LE(BigInt((datas[i] as Buffer).length), 8);
    offset += (datas[i] as Buffer).length;
    return Buffer.concat([head, padded, tail]);
  });
  return Buffer.concat([header, blob, count, ...entries]);
}

describe('update folder', () => {
  it('lists client data files and writes update.json', async () => {
    const ws = makeWorkspace();
    const root = join(ws.root, 'co');
    write(root, 'client/build/data/items.bin', 'items');
    write(root, 'client/build/data/translation_ko.bin', 'ko');
    write(root, 'client/build/data/data_version', 'v');
    const files = await clientDataFiles(root);
    expect(files.data.map((f) => [f.name, f.size])).toEqual([['items.bin', 5]]);
    expect(files.translations.map((f) => [f.language, f.name])).toEqual([['ko', 'translation_ko.bin']]);
    const update = await writeUpdate(root, join(ws.root, 'out'), 'p-d', ['1.0.0']);
    expect(update.apps).toEqual(['1.0.0']);
    expect(JSON.parse(readFileSync(join(ws.root, 'out', 'update', 'update.json'), 'utf8'))).toEqual(update);
    expect(readFileSync(join(ws.root, 'out', 'update', 'items.bin'), 'utf8')).toBe('items');
  });
});

describe('core settings values', () => {
  it('reads flat and nested keys', () => {
    expect(coreValue({ 'admin-api.switchCacheMs': 5 }, 'admin-api.switchCacheMs')).toBe(5);
    expect(coreValue({ 'admin-api': { switchCacheMs: 6 } }, 'admin-api.switchCacheMs')).toBe(6);
    expect(coreValue({}, 'admin-api.switchCacheMs')).toBeUndefined();
  });
});

describe('bundle packing', () => {
  const file = (target: string, size: number) => ({ target, source: '', size });
  it('splits keys by the limit in key byte order', () => {
    const keyed = [
      { key: 'b', entry: { path: 'res://resource/b.png', variants: 1 }, files: [file('res://resource/b.png', 400)] },
      { key: 'a', entry: { path: 'res://resource/a.png', variants: 1 }, files: [file('res://resource/a.png', 400)] },
      { key: 'huge', entry: { path: 'res://resource/huge.png', variants: 1 }, files: [file('res://resource/huge.png', 5000)] },
    ];
    const limit = pckSize([file('res://resource/a.png', 400), file('res://resource/b.png', 400), file('res://bundle_keys/patch_1.json', 90)]) - 1;
    const split = splitPacks(keyed, limit);
    expect(split.packs.map((p) => Object.keys(p.keys))).toEqual([['a'], ['b']]);
    expect(split.packs[0]?.keys).toEqual({ a: { path: 'res://resource/a.png', variants: 1 } });
    expect(split.failures).toEqual([`resource key huge alone passes the bundle file limit ${String(limit)}`]);
    expect(splitPacks(keyed.slice(0, 2), 100_000).packs.map((p) => Object.keys(p.keys))).toEqual([['a', 'b']]);
  });

  it('finds code and paths outside resource', async () => {
    const ws = makeWorkspace();
    write(ws.root, 'x.tscn', '[gd_scene]\n[sub_resource type="GDScript" id=1]\n');
    write(ws.root, 'y.tres', '[gd_resource]\n');
    expect(await bundleFileFailures([
      file('res://resource/a.gd', 1), file('res://scripts/b.png', 1), { target: 'res://resource/x.tscn', source: join(ws.root, 'x.tscn'), size: 1 },
      { target: 'res://.godot/imported/y.tres', source: join(ws.root, 'y.tres'), size: 1 }, file('res://bundle_keys/patch_1.json', 1),
    ])).toEqual(['bundle holds code: res://resource/a.gd', 'bundle holds a path outside resource: res://scripts/b.png', 'bundle holds an embedded script: res://resource/x.tscn']);
  });
});
