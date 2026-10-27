import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreReleaseOfGame, extractedAsset } from '../../../../src/commands/core/api.ts';
import { runData } from '../../../../src/commands/data/api.ts';
import { moduleFilesWithoutDev } from '../../../../src/commands/generate/api.ts';
import { buildToolProgram, requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import {
  androidExtras,
  checkPackage,
  editorPluginPaths,
  excludeFilter,
  filterCoreSettings,
  godotBuild,
  iosPluginNames,
  missingGdextensionLibraries,
  outputFile,
  packagePaths,
  presetCfg,
  stripLogDebug,
  versionCode,
  withEditorPlugins,
  writeCoreSettingsWithoutDev,
} from '../../../../src/commands/build/lib/godot.ts';
import { ENDPOINTS, prepareSigning, profileUuid, securityArg, signWindows, windowsSigner } from '../../../../src/commands/build/lib/godot-signing.ts';
import { makePck } from '../../../../src/commands/build/lib/pck.ts';
import { createContext } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { commit, fakeBin, gameRepo, gameSettings, git, setSecrets, setupGame, write } from '../helpers.ts';
import { makeZip } from '../zipwriter.ts';

vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn(), toolProgram: vi.fn(), buildToolProgram: vi.fn() }));
vi.mock('../../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), moduleFilesWithoutDev: vi.fn() }));

/** The STG and PROD module files of the mocked `moduleFilesWithoutDev`: no QACore setting `uiCheckScreens`, no `cheat`. */
const WITHOUT_DEV = { coreSettings: '{"a": 1, "environments.DEV.serverUrl": "d", "environments.STG.serverUrl": "s"}\n', serverModules: '["routing"]\n' };
beforeEach(() => {
  vi.mocked(moduleFilesWithoutDev).mockReset();
  vi.mocked(moduleFilesWithoutDev).mockResolvedValue(WITHOUT_DEV);
});

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-godot-')));
}

function ctxOf(ws: TestWorkspace, env: NodeJS.ProcessEnv = {}) {
  return createContext({ cwd: ws.root, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

describe('presets and names', () => {
  it('computes version codes and output files', () => {
    expect(versionCode('1.2.3', 'STG')).toBe(10020031);
    expect(versionCode('209.999.999', 'PROD')).toBe(2099999992);
    expect(() => versionCode('210.0.0', 'DEV')).toThrow('does not fit');
    expect(() => versionCode('1.1000.0', 'DEV')).toThrow('does not fit');
    expect(['android', 'ios', 'macos', 'windows', 'linux', 'web'].map((p) => outputFile('g', p, 'STG'))).toEqual(['g.aab', 'g.ipa', 'g.zip', 'g.exe', 'g.x86_64', 'index.html']);
    expect(outputFile('g', 'android', 'DEV')).toBe('g.apk');
    expect(excludeFilter('DEV')).toBe('tests/*,addons/gut/*,generated/launch_values.json');
    expect(excludeFilter('PROD')).toBe('tests/*,addons/gut/*,dev/*,core/*/dev/*,generated/core_settings_types.json,generated/launch_values.json');
    expect(excludeFilter('STG')).toBe(excludeFilter('PROD'));
  });

  it('writes preset cfg values', () => {
    expect(presetCfg({ name: 'web-dev', runnable: true }, { 'a/b': 1, 'c/d': 'x"y', e: ['p', 'q'] })).toBe(
      '[preset.0]\n\nname="web-dev"\nrunnable=true\n\n[preset.0.options]\n\na/b=1\nc/d="x\\"y"\ne=PackedStringArray("p", "q")\n',
    );
  });
});

describe('workspace edits', () => {
  it('drops other environments from core_settings.json and core_settings_types.json', async () => {
    const root = tmp();
    write(root, 'client/generated/core_settings.json', { 'environments.DEV.serverUrl': 'd', 'environments.STG.serverUrl': 's', a: 1, environments: { DEV: 1, STG: 2, PROD: 3 } });
    write(root, 'client/generated/core_settings_types.json', { 'environments.DEV.serverUrl': 'string', 'environments.STG.serverUrl': 'string', a: 'number' });
    await filterCoreSettings(root, 'STG');
    expect(JSON.parse(readFileSync(join(root, 'client/generated/core_settings.json'), 'utf8'))).toEqual({ 'environments.STG.serverUrl': 's', a: 1, environments: { STG: 2 } });
    expect(JSON.parse(readFileSync(join(root, 'client/generated/core_settings_types.json'), 'utf8'))).toEqual({ 'environments.STG.serverUrl': 'string', a: 'number' });
    await filterCoreSettings(tmp(), 'DEV');
  });

  it('writes the STG and PROD core settings file without the DEV modules and keeps the DEV one', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const game: GameRepo = { name: 'g', root: '/elsewhere', mainRoot: '/elsewhere', commonDir: '/elsewhere/.git', inWorktree: false };
    const root = tmp();
    write(root, 'client/generated/core_settings.json', { uiCheckScreens: [], a: 1 });
    await writeCoreSettingsWithoutDev(ctx, game, root, 'DEV');
    expect(JSON.parse(readFileSync(join(root, 'client/generated/core_settings.json'), 'utf8'))).toEqual({ uiCheckScreens: [], a: 1 });
    expect(vi.mocked(moduleFilesWithoutDev)).not.toHaveBeenCalled();
    await writeCoreSettingsWithoutDev(ctx, game, root, 'PROD');
    expect(readFileSync(join(root, 'client/generated/core_settings.json'), 'utf8')).toBe(WITHOUT_DEV.coreSettings);
    // the build workspace, not the checkout the command runs in, gives the game settings and core version
    expect(vi.mocked(moduleFilesWithoutDev).mock.calls[0]?.[1]).toMatchObject({ name: 'g', root });
  });

  it('turns LogCore.log_debug lines into pass', async () => {
    const root = tmp();
    write(root, 'a/x.gd', 'func f():\n\tLogCore.log_debug("x", [1])\n\tvar a = 1\n    LogCore.log_debug("y")  \n');
    write(root, 'a/y.txt', 'LogCore.log_debug("z")\n');
    expect(await stripLogDebug(root)).toBe(1);
    expect(readFileSync(join(root, 'a/x.gd'), 'utf8')).toBe('func f():\n\tpass\n\tvar a = 1\n    pass\n');
    expect(readFileSync(join(root, 'a/y.txt'), 'utf8')).toBe('LogCore.log_debug("z")\n');
  });

  it('adds the AdMob app ID and the Firebase config file', async () => {
    const root = tmp();
    write(root, 'client/android/build/AndroidManifest.xml', '<manifest>\n  <application>\n  </application>\n</manifest>\n');
    const settings = { appId: 'com.x.g', admob: { appIdAndroid: 'ca-app-pub-1~2' }, environments: { STG: { adapters: { ads: 'ads-admob', 'push-fcm': 'push-fcm' }, fcm: { projectId: 'p', projectNumber: '12', appIdAndroid: '1:12:android:a', apiKeyAndroid: 'k' } } } };
    await androidExtras(root, settings, 'STG');
    expect(readFileSync(join(root, 'client/android/build/AndroidManifest.xml'), 'utf8')).toContain(
      '    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-1~2" />\n    </application>',
    );
    expect(JSON.parse(readFileSync(join(root, 'client/android/build/google-services.json'), 'utf8'))).toEqual({
      project_info: { project_number: '12', project_id: 'p' },
      client: [{ client_info: { mobilesdk_app_id: '1:12:android:a', android_client_info: { package_name: 'com.x.g' } }, api_key: [{ current_key: 'k' }] }],
    });
    await expect(androidExtras(root, { environments: { DEV: { adapters: { ads: 'ads-admob' } } } }, 'DEV')).rejects.toThrow('admob.appIdAndroid is missing');
    await expect(androidExtras(root, { environments: { DEV: { adapters: { 'push-fcm': 'push-fcm' } } } }, 'DEV')).rejects.toThrow('environments.DEV.fcm is missing');
  });
});

describe('plugin enabling', () => {
  it('lists the editor plugins and the iOS plugin names of plugin folders in byte order', async () => {
    const a = tmp();
    const b = tmp();
    write(a, 'addons/ogw-push-fcm/plugin.cfg', '[plugin]\n');
    write(a, 'addons/webrtc/webrtc.gdextension', '[configuration]\n');
    write(b, 'addons/ogw-native-ui/plugin.cfg', '[plugin]\n');
    write(b, 'ios/plugins/ogw-native-ui/ogw-native-ui.gdip', '[config]\n\nname="OgwNativeUi"\nbinary="ogw-native-ui.xcframework"\n\n[dependencies]\n\nlinked=[]\n');
    write(a, 'ios/plugins/deep/x/ogw-push-apns.gdip', '[config]\nname="OgwPushApns"\n');
    expect(await editorPluginPaths([a, b, tmp()])).toEqual(['res://addons/ogw-native-ui/plugin.cfg', 'res://addons/ogw-push-fcm/plugin.cfg']);
    expect(await iosPluginNames([a, b])).toEqual(['OgwNativeUi', 'OgwPushApns']);
    write(b, 'ios/plugins/bad/bad.gdip', '[config]\nbinary="x"\n');
    await expect(iosPluginNames([b])).rejects.toThrow('bad.gdip has no [config] name');
  });

  it('sets [editor_plugins] enabled of project.godot', () => {
    const paths = ['res://addons/a/plugin.cfg', 'res://addons/b/plugin.cfg'];
    expect(withEditorPlugins('[application]\n\nconfig/name="G"\n', paths)).toBe(
      '[application]\n\nconfig/name="G"\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/a/plugin.cfg", "res://addons/b/plugin.cfg")\n',
    );
    expect(withEditorPlugins('[editor_plugins]\n\nenabled=PackedStringArray("res://addons/old/plugin.cfg")\n\n[gui]\n\nx=1\n', paths.slice(0, 1))).toBe(
      '[gui]\n\nx=1\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/a/plugin.cfg")\n',
    );
  });
});

describe('package checks', () => {
  it('lists packaged files and refuses excluded ones', async () => {
    const out = tmp();
    writeFileSync(join(out, 'g.apk'), makeZip({ 'assets/features/a.gd': 'x', 'classes.dex': 'x' }));
    expect(await packagePaths(join(out, 'g.apk'))).toEqual(['features/a.gd', 'classes.dex']);
    await checkPackage(out, 'android', 'g', 'STG');
    writeFileSync(join(out, 'g.pck'), makePck(['res://dev/bot.gd', 'res://core/ui_core/dev/x.gd', 'res://features/a.gd']));
    expect(await checkPackage(out, 'linux', 'g', 'STG')).toEqual(['linux/g.pck holds DEV code: dev/bot.gd', 'linux/g.pck holds DEV code: core/ui_core/dev/x.gd']);
    expect(await checkPackage(out, 'linux', 'g', 'DEV')).toEqual([]);
    writeFileSync(join(out, 'g.pck'), makePck(['res://tests/t.gd']));
    await expect(checkPackage(out, 'linux', 'g', 'STG')).rejects.toThrow('g.pck holds excluded files: tests/t.gd');
    writeFileSync(join(out, 'g.pck'), makePck(['res://generated/core_settings_types.json', 'res://generated/core_settings.json']));
    await expect(checkPackage(out, 'linux', 'g', 'PROD')).rejects.toThrow('g.pck holds excluded files: generated/core_settings_types.json');
    expect(await checkPackage(out, 'linux', 'g', 'DEV')).toEqual([]);
    const ios = tmp();
    writeFileSync(join(ios, 'g.ipa'), makeZip({ 'Payload/g.app/g.pck': makePck(['features/a.gd']) }));
    await expect(checkPackage(ios, 'ios', 'g', 'STG')).rejects.toThrow('g.ipa has no PrivacyInfo.xcprivacy');
    writeFileSync(join(ios, 'g.ipa'), makeZip({ 'Payload/g.app/g.pck': makePck(['features/a.gd']), 'Payload/g.app/PrivacyInfo.xcprivacy': 'x' }));
    await checkPackage(ios, 'ios', 'g', 'STG');
    await expect(checkPackage(tmp(), 'web', 'g', 'STG')).rejects.toThrow('export of web made no index.html');
  });
});

describe('signing', () => {
  it('passes the android keystore through the export env and removes it', async () => {
    const ws = makeWorkspace();
    setSecrets(ws, { 'ogw/g/signing/ks': Buffer.from('KEYSTORE').toString('base64'), 'ogw/g/signing/pw': 'pw' });
    const settings = { androidKeyAlias: 'upload', signing: { android: { keystore: 'ks', password: 'pw' } } };
    const signing = await prepareSigning(ctxOf(ws), 'g', settings, 'STG', 'android');
    const path = signing.env.GODOT_ANDROID_KEYSTORE_RELEASE_PATH as string;
    expect(readFileSync(path, 'utf8')).toBe('KEYSTORE');
    expect(signing.env).toMatchObject({ GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'upload', GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD: 'pw' });
    await signing.cleanup();
    expect(existsSync(path)).toBe(false);
    const dev = await prepareSigning(ctxOf(ws), 'g', settings, 'DEV', 'android');
    expect(Object.keys(dev.env)).toEqual(['GODOT_ANDROID_KEYSTORE_DEBUG_PATH', 'GODOT_ANDROID_KEYSTORE_DEBUG_USER', 'GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD']);
    await dev.cleanup();
    await expect(prepareSigning(ctxOf(ws), 'g', { signing: { android: {} } }, 'DEV', 'android')).rejects.toThrow('signing.android.keystore is missing');
    expect((await prepareSigning(ctxOf(ws), 'g', {}, 'DEV', 'web')).options).toEqual({});
  });

  it('uses free signing for a DEV export without signing: a debug keystore made once, macos ad-hoc, windows none', async () => {
    const ws = makeWorkspace();
    const home = join(ws.root, 'home');
    const keytool = 'prev=""; for a in "$@"; do [ "$prev" = "-keystore" ] && echo KS > "$a"; prev="$a"; done';
    const bin = fakeBin(ws, { keytool });
    const ctx = ctxOf(ws, { ...bin.env, HOME: home });
    const android = await prepareSigning(ctx, 'g', {}, 'DEV', 'android');
    const keystore = join(home, '.android', 'debug.keystore');
    expect(android.env).toEqual({ GODOT_ANDROID_KEYSTORE_DEBUG_PATH: keystore, GODOT_ANDROID_KEYSTORE_DEBUG_USER: 'androiddebugkey', GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD: 'android' });
    expect(readFileSync(keystore, 'utf8')).toBe('KS\n');
    expect(readdirSync(join(home, '.android'))).toEqual(['debug.keystore']);
    const log = readFileSync(bin.log, 'utf8');
    expect(log).toContain('-alias androiddebugkey -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname CN=Android Debug,O=Android,C=US');
    await android.cleanup();
    expect(existsSync(keystore)).toBe(true);
    await prepareSigning(ctx, 'g', {}, 'DEV', 'android');
    expect(readFileSync(bin.log, 'utf8')).toBe(log);
    expect(await prepareSigning(ctx, 'g', {}, 'DEV', 'macos')).toMatchObject({ env: {}, options: { 'codesign/codesign': 1 }, credentials: {} });
    expect(await prepareSigning(ctx, 'g', {}, 'DEV', 'windows')).toMatchObject({ env: {}, options: {}, credentials: {} });
    // a DEV macos with login-apple has no free signing
    const apple = { environments: { DEV: { adapters: { 'login-apple': 'login-apple' } } } };
    await expect(prepareSigning(ctx, 'g', apple, 'DEV', 'macos')).rejects.toThrow('signing.macos.certificate is missing');
    await expect(prepareSigning(ctx, 'g', {}, 'STG', 'android')).rejects.toThrow('signing.android.keystore is missing');
  });

  it('signs macOS STG with the Developer ID identity of a temporary keychain, the team ID and notarization', async () => {
    const ws = makeWorkspace();
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    setSecrets(ws, { 'ogw/g/signing/c': b64('P12'), 'ogw/g/signing/cp': 'cpw', 'ogw/g/signing/pp': b64('PROFILE'), 'ogw/g/signing/n': b64('P8') });
    const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const identities = (names: string) => `case "$1" in
  -i) read -r line; echo "security -i $line" >> "$(dirname "$0")/calls.log";;
  list-keychains) [ "$3" = "-s" ] || echo '    "/Users/x/login.keychain-db"';;
  find-identity) printf '%s\n' ${names} '     1 valid identities found';;
esac`;
    const bin = fakeBin(ws, { security: identities(`'  1) ${hash} "Developer ID Application: Example (TEAM123456)"'`) });
    const ctx = ctxOf(ws, { ...bin.env, HOME: tmp() });
    const settings = { appleTeamId: 'TEAM123456', macosNotary: { keyId: 'K', issuerId: 'I' }, signing: { macos: { certificate: 'c', certificatePassword: 'cp', provisioningProfile: 'pp', notaryApiKey: 'n' } } };
    const signing = await prepareSigning(ctx, 'g', settings, 'STG', 'macos');
    expect(signing.options).toMatchObject({ 'codesign/codesign': 3, 'codesign/identity': hash, 'codesign/apple_team_id': 'TEAM123456', 'notarization/notarization': 2 });
    expect(readFileSync(signing.credentials['notarization/api_key'] as string, 'utf8')).toBe('P8');
    expect(signing.credentials).toMatchObject({ 'codesign/certificate_password': 'cpw', 'notarization/api_uuid': 'I', 'notarization/api_key_id': 'K' });
    const keychain = signing.keychain as string;
    await signing.cleanup();
    const log = readFileSync(bin.log, 'utf8');
    expect(log).toMatch(/security -i "import" "\S+cert\.p12" "-k" "\S+ogw\.keychain-db" "-P" "cpw" "-T" "\/usr\/bin\/codesign"/);
    expect(log).toContain(`security list-keychains -d user -s ${keychain} /Users/x/login.keychain-db`);
    expect(log).toContain(`security find-identity -v -p codesigning ${keychain}`);
    expect(log).toMatch(/security list-keychains -d user -s \/Users\/x\/login\.keychain-db\n/);
    expect(log).toContain(`security delete-keychain ${keychain}`);
    const dev = await prepareSigning(ctx, 'g', settings, 'DEV', 'macos');
    expect(dev.options['notarization/notarization']).toBeUndefined();
    expect(dev.options['codesign/identity']).toBe(hash);
    await dev.cleanup();
    await expect(prepareSigning(ctx, 'g', { ...settings, macosNotary: undefined }, 'PROD', 'macos')).rejects.toThrow('macosNotary is missing');
    await expect(prepareSigning(ctx, 'g', { ...settings, appleTeamId: undefined }, 'PROD', 'macos')).rejects.toThrow('appleTeamId is missing');
    // a certificate that is not Developer ID Application (e.g. Apple Distribution of the Mac App Store) is refused
    fakeBin(ws, { security: identities(`'  1) ${hash} "Apple Distribution: Example (TEAM123456)"'`) });
    await expect(prepareSigning(ctx, 'g', settings, 'STG', 'macos')).rejects.toThrow('must hold one Developer ID Application identity; it holds: Apple Distribution: Example (TEAM123456)');
    expect(readFileSync(bin.log, 'utf8').match(/security delete-keychain/g)).toHaveLength(3);
  });

  it('quotes a security -i argument and refuses a line break', () => {
    expect(securityArg('a b"c\\d$e\'f')).toBe('"a b\\"c\\\\d$e\'f"');
    expect(() => securityArg('a\nb')).toThrow('line break');
  });

  it('prepares and removes the iOS keychain', async () => {
    const ws = makeWorkspace();
    const home = tmp();
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    setSecrets(ws, { 'ogw/g/signing/dc': b64('P12'), 'ogw/g/signing/dcp': 'pw', 'ogw/g/signing/dpp': b64('PROFILE') });
    const bin = fakeBin(ws, {
      security: `case "$1" in
  -i) read -r line; echo "security -i $line" >> "$(dirname "$0")/calls.log";;
  list-keychains) [ "$3" = "-s" ] || echo '    "/Users/x/login.keychain-db"';;
  cms) echo '<plist><dict><key>UUID</key><string>ABC-123</string></dict></plist>';;
esac`,
    });
    const settings = { signing: { ios: { distributionCertificate: 'dc', distributionCertificatePassword: 'dcp', distributionProvisioningProfile: 'dpp' } } };
    const signing = await prepareSigning(ctxOf(ws, { ...bin.env, HOME: home }), 'g', settings, 'STG', 'ios');
    expect(signing.options).toEqual({ 'application/provisioning_profile_uuid_release': 'ABC-123' });
    const placed = join(home, 'Library/MobileDevice/Provisioning Profiles/ABC-123.mobileprovision');
    expect(readFileSync(placed, 'utf8')).toBe('PROFILE');
    await signing.cleanup();
    expect(existsSync(placed)).toBe(false);
    const log = readFileSync(bin.log, 'utf8');
    // the keychain password and the certificate password reach security through stdin, never its command line
    const password = /security -i "create-keychain" "-p" "(\S+)" "\S+ogw\.keychain-db"/.exec(log)?.[1] ?? '';
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(log).toContain(`security -i "unlock-keychain" "-p" "${password}" `);
    expect(log).toMatch(/security -i "import" "\S+cert\.p12" "-k" "\S+ogw\.keychain-db" "-P" "pw" "-T" "\/usr\/bin\/codesign"/);
    expect(log).toContain(`security -i "set-key-partition-list" "-S" "apple-tool:,apple:,codesign:" "-s" "-k" "${password}" `);
    for (const line of log.split('\n').filter((l) => !l.startsWith('security -i '))) {
      expect(line).not.toContain(password);
      expect(line).not.toMatch(/ pw( |$)/);
    }
    expect(log).toMatch(/security list-keychains -d user -s \S+ogw\.keychain-db \/Users\/x\/login\.keychain-db/);
    expect(log).toMatch(/security list-keychains -d user -s \/Users\/x\/login\.keychain-db\n/);
    expect(log).toMatch(/security delete-keychain \S+ogw\.keychain-db/);
    await expect(profileUuid(ctxOf(ws, { PATH: '/nonexistent' }), 'x')).rejects.toThrow();
  });

  it('keeps the keychains of ios and macos exports that run at the same time in the user search list', async () => {
    const ws = makeWorkspace();
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    setSecrets(ws, { 'ogw/g/signing/dc': b64('P12'), 'ogw/g/signing/dcp': 'pw', 'ogw/g/signing/dpp': b64('PROFILE'), 'ogw/g/signing/c': b64('P12'), 'ogw/g/signing/cp': 'cpw', 'ogw/g/signing/pp': b64('PROFILE'), 'ogw/g/signing/n': b64('P8') });
    const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    // a search list kept in a file, with a pause between its read and its write; creating a keychain adds it and deleting removes it
    const bin = fakeBin(ws, {
      security: `L="$(dirname "$0")/list.txt"; [ -f "$L" ] || echo /Users/x/login.keychain-db > "$L"
case "$1" in
  -i) read -r line; case "$line" in '"create-keychain"'*) k=$(printf '%s' "$line" | sed 's/.*"\\([^"]*\\)"$/\\1/'); sleep 0.05; printf '%s\\n' "$k" >> "$L";; esac;;
  list-keychains) if [ "$4" = "-s" ]; then shift 4; sleep 0.05; printf '%s\\n' "$@" > "$L"; else sleep 0.05; sed 's/^/    "/; s/$/"/' "$L"; fi;;
  delete-keychain) grep -vxF "$2" "$L" > "$L.new"; mv "$L.new" "$L";;
  cms) echo '<plist><dict><key>UUID</key><string>ABC-123</string></dict></plist>';;
  find-identity) echo '  1) ${hash} "Developer ID Application: Example (TEAM123456)"'; echo '     1 valid identities found';;
esac`,
    });
    const list = (): string[] => readFileSync(join(bin.bin, 'list.txt'), 'utf8').trim().split('\n');
    const ctx = ctxOf(ws, { ...bin.env, HOME: tmp() });
    const settings = {
      appleTeamId: 'TEAM123456',
      macosNotary: { keyId: 'K', issuerId: 'I' },
      signing: { ios: { distributionCertificate: 'dc', distributionCertificatePassword: 'dcp', distributionProvisioningProfile: 'dpp' }, macos: { certificate: 'c', certificatePassword: 'cp', provisioningProfile: 'pp', notaryApiKey: 'n' } },
    };
    const [ios, macos] = await Promise.all([prepareSigning(ctx, 'g', settings, 'STG', 'ios'), prepareSigning(ctx, 'g', settings, 'STG', 'macos')]);
    expect(list().sort()).toEqual([ios.keychain, macos.keychain, '/Users/x/login.keychain-db'].sort());
    await ios.cleanup();
    expect(list()).toEqual([macos.keychain, '/Users/x/login.keychain-db']);
    await macos.cleanup();
    expect(list()).toEqual(['/Users/x/login.keychain-db']);
    // the ends of two exports at the same time leave no keychain behind
    const again = await Promise.all([prepareSigning(ctx, 'g', settings, 'STG', 'ios'), prepareSigning(ctx, 'g', settings, 'STG', 'macos')]);
    await Promise.all(again.map((signing) => signing.cleanup()));
    expect(list()).toEqual(['/Users/x/login.keychain-db']);
  });

  it('signs windows files with jsign and an Entra token', async () => {
    const ws = makeWorkspace();
    setSecrets(ws, { 'ogw/g/signing/cs': 'CLIENT-SECRET' });
    let form = '';
    const server = createServer((req, res) => {
      req.on('data', (c: Buffer) => (form += c.toString()));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/tenant/oauth2/v2.0/token' ? JSON.stringify({ access_token: 'TOKEN' }) : '{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    ENDPOINTS.entraToken = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const bin = fakeBin(ws, { jsign: 'for a; do case "$a" in file:*) cat "\${a#file:}" > "$(dirname "$0")/token-seen";; esac; done' });
    const settings = { trustedSigning: { tenantId: 'tenant', clientId: 'cid', endpoint: 'https://eus.codesigning.azure.net', account: 'acc', certificateProfile: 'prof' }, signing: { windows: { clientSecret: 'cs' } } };
    try {
      const signer = { program: 'jsign', prefix: [], env: { ...ws.env, ...bin.env } };
      await signWindows(ctxOf(ws, bin.env), 'g', settings, ['/out/g.exe'], signer);
      expect(new URLSearchParams(form).get('client_secret')).toBe('CLIENT-SECRET');
      expect(new URLSearchParams(form).get('scope')).toBe('https://codesigning.azure.net/.default');
      expect(readFileSync(bin.log, 'utf8')).toMatch(
          /^jsign --storetype TRUSTEDSIGNING --keystore eus\.codesigning\.azure\.net --storepass file:\S+\/access-token --alias acc\/prof --tsaurl http:\/\/timestamp\.acs\.microsoft\.com --tsmode RFC3161 --alg SHA-256 \/out\/g\.exe\n$/,
      );
      // the token reached jsign as a file, which is removed after signing
      expect(readFileSync(join(bin.bin, 'token-seen'), 'utf8')).toBe('TOKEN');
      expect(existsSync(/file:(\S+)/.exec(readFileSync(bin.log, 'utf8'))?.[1] ?? '')).toBe(false);
      await expect(signWindows(ctxOf(ws, bin.env), 'g', { ...settings, trustedSigning: { ...settings.trustedSigning, tenantId: 'other' } }, ['x'], signer)).rejects.toThrow('token request failed');
      await expect(signWindows(ctxOf(ws), 'g', {}, [], signer)).rejects.toThrow('trustedSigning is missing');
    } finally {
      server.close();
    }
  });
});

describe('windowsSigner', () => {
  const tool = (name: string, downloads: boolean, versionCommand = `${name} --version`) => ({
    platform: 'windows', hosts: ['macos-arm64'], name, version: '1', versionCommand, ...(downloads ? { downloads: [{ platform: 'any' as const, url: 'u', sha256: 's' }] } : {}),
  });

  it('runs the installed jsign with the installed Java runtime, not the programs on PATH', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws, { OGW_HOST_PLATFORM: 'macos-arm64', PATH: '/usr/bin' });
    vi.mocked(buildToolProgram).mockImplementation((_c, name) => Promise.resolve(name === 'jsign' ? '/tools/jsign/bin/jsign' : name === 'temurin' ? '/tools/jre/bin/java' : null));
    const signer = await windowsSigner(ctx, [tool('jsign', true), tool('temurin', true, 'java -version'), { ...tool('signtool', false), platform: 'android' }]);
    expect(signer).toMatchObject({ program: '/tools/jsign/bin/jsign', prefix: [], env: { PATH: '/tools/jre/bin:/usr/bin', JAVA_HOME: '/tools/jre' } });
    vi.mocked(buildToolProgram).mockImplementation((_c, name) => Promise.resolve(name === 'jsign' ? '/tools/jsign/jsign-7.1.jar' : '/tools/jre/bin/java'));
    expect(await windowsSigner(ctx, [tool('jsign', true), tool('temurin', true)])).toMatchObject({ program: '/tools/jre/bin/java', prefix: ['-jar', '/tools/jsign/jsign-7.1.jar'] });
    expect(await windowsSigner(ctx, [tool('jsign', false)])).toMatchObject({ program: 'jsign', prefix: [], env: { PATH: '/usr/bin' } });
    vi.mocked(buildToolProgram).mockResolvedValue(null);
    await expect(windowsSigner(ctx, [tool('jsign', true)])).rejects.toThrow('build tool jsign 1 is not installed: run ogw env install-engines');
    await expect(windowsSigner(ctx, [{ ...tool('jsign', true), hosts: ['linux-x64'] }])).rejects.toThrow('engine.json buildTools has no windows item jsign for this host');
  });
});

const GODOT = `case "$*" in
  *--export-*) env | grep '^GODOT_ANDROID_KEYSTORE' | sort > "$FAKE_DIR/keystore-env"; cp "$3/features/a.gd" "$FAKE_DIR/a.gd"; [ -f "$3/addons/ogw-secure-storage/lib.so" ] && touch "$FAKE_DIR/plugin-ok"; cp "$3/export_presets.cfg" "$FAKE_DIR/preset.cfg"; cp "$3/project.godot" "$FAKE_DIR/project.godot"; cp "$3/generated/build_info.json" "$FAKE_DIR/build_info.json"; [ -f "$3/generated/core_settings.json" ] && cp "$3/generated/core_settings.json" "$FAKE_DIR/core_settings.json"; [ -f "$3/.godot/export_credentials.cfg" ] && cp "$3/.godot/export_credentials.cfg" "$FAKE_DIR/credentials.cfg"; for last; do :; done; printf 'x' > "$last"; case "$last" in *.html) printf 'const CACHE_VERSION = "v1";\\n' > "$(dirname "$last")/index.service.worker.js";; esac;;
esac`;

describe('godotBuild', () => {
  beforeEach(() => {
    vi.mocked(requireEngine).mockResolvedValue('godot');
    vi.mocked(runData).mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  });

  function prepare(ws: TestWorkspace, release: string, engine: object, patch: Record<string, unknown> = {}): string {
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'engine.json'), JSON.stringify(engine));
    vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
    vi.mocked(extractedAsset).mockResolvedValue(release);
    const dir = setupGame(ws, 'g', { ...gameSettings(), ...patch });
    write(dir, 'client/project.godot', '[application]\n\nconfig/name="G"\n');
    write(dir, 'client/features/a.gd', '\tLogCore.log_debug("x")\n');
    write(dir, 'client/core/web/service-worker.js', 'const CACHE_VERSION = "___GODOT_VERSION___";\n');
    commit(dir, 'client');
    return dir;
  }

  it('exports linux from a clean checkout with the preset and build info', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    write(release, 'client-godot-plugins.zip.d/ogw-secure-storage/linux/addons/ogw-secure-storage/lib.so', 'so');
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins: [{ name: 'ogw-secure-storage', platforms: ['linux', 'android'] }] });
    vi.mocked(extractedAsset).mockImplementation((_c, _r, asset) => Promise.resolve(asset === 'client-godot-plugins.zip' ? join(release, 'client-godot-plugins.zip.d') : release));
    setSecrets(ws, {});
    const bin = fakeBin(ws, { godot: GODOT });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    const game = await gameRepo(ws);
    const outDir = join(dir, 'builds', 'stg-1.2.3');
    const artifact = await godotBuild(ctx, { game, env: 'STG', version: '1.2.3', platforms: ['linux'], settings: gameSettings(), outDir, iosPrivacy: [], privacyManifest: null }, 'linux');
    expect(artifact).toEqual({ artifact: { platform: 'linux', path: 'builds/stg-1.2.3/linux' }, devCode: [] });
    expect(vi.mocked(runData).mock.calls.at(-1)?.[2]).toEqual({ binary: true, strict: true, prodCompare: false });
    expect(readFileSync(join(outDir, 'linux', 'g.x86_64'), 'utf8')).toBe('x');
    const preset = readFileSync(join(bin.bin, 'preset.cfg'), 'utf8');
    expect(preset).toContain('name="linux-stg"\nplatform="Linux"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="build/data/*,generated/*.json"\nexclude_filter="tests/*,addons/gut/*,dev/*,core/*/dev/*,generated/core_settings_types.json,generated/launch_values.json"\n');
    expect(preset).toContain(`export_path="${join(outDir, 'linux', 'g.x86_64')}"`);
    expect(preset).toContain('binary_format/architecture="x86_64"');
    const info = JSON.parse(readFileSync(join(bin.bin, 'build_info.json'), 'utf8')) as Record<string, unknown>;
    expect(info).toMatchObject({ app_id: 'com.example.game', app_version: '1.2.3', environment: 'STG', platform: 'linux', server_url: 'https://stg.example.com', game_update_url: 'https://stg.example.com/update/deploy_list.json', ad_units: {}, instance_id: '' });
    expect(info.update_trust_keys).toEqual([{ key_id: expect.stringMatching(/^[0-9a-f]{16}$/) as string, public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }]);
    expect(info.dev_access).toBeUndefined();
    // STG: the core settings file of the used modules without DEV modules, with only the STG `<ENV>` items
    expect(JSON.parse(readFileSync(join(bin.bin, 'core_settings.json'), 'utf8'))).toEqual({ a: 1, 'environments.STG.serverUrl': 's' });
    expect(existsSync(join(bin.bin, 'plugin-ok'))).toBe(true);
    expect(readFileSync(join(bin.bin, 'a.gd'), 'utf8')).toBe('\tpass\n');
    const calls = readFileSync(bin.log, 'utf8');
    expect(calls).toMatch(/godot --headless --path \S+\/client --import\n/);
    expect(calls).toMatch(/godot --headless --path \S+\/client --export-release linux-stg \S+g\.x86_64\n/);
    expect(readdirOrEmpty(join(ws.worktrees, 'g'))).toEqual([]);
  });

  it('writes build info ad_units by the placement ID values of the id-registry branch', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins: [] });
    const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(dir, 'switch', '--quiet', '--orphan', 'id-registry');
    write(dir, 'id_registry.json', { '[banner]': 3, '[reward]': 7 });
    git(dir, 'add', 'id_registry.json');
    git(dir, 'commit', '--quiet', '-m', 'ids');
    git(dir, 'switch', '--quiet', '--force', main);
    setSecrets(ws, {});
    const bin = fakeBin(ws, { godot: GODOT });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    const game = await gameRepo(ws);
    const settings = gameSettings();
    const envs = settings.environments as Record<string, Record<string, unknown>>;
    (envs.STG as Record<string, unknown>).adUnits = { '[reward]': { linux: 'r-linux', android: 'r-android' }, '[banner]': { android: 'b-android' } };
    const input = { game, env: 'STG' as const, version: '1.2.3', platforms: ['linux'], settings, outDir: join(dir, 'builds', 'stg-1.2.3'), iosPrivacy: [], privacyManifest: null };
    await godotBuild(ctx, input, 'linux');
    expect((JSON.parse(readFileSync(join(bin.bin, 'build_info.json'), 'utf8')) as { ad_units: unknown }).ad_units).toEqual({ '7': 'r-linux' });
    (envs.STG as Record<string, unknown>).adUnits = { '[gone]': { linux: 'g' } };
    await expect(godotBuild(ctx, input, 'linux')).rejects.toThrow('game settings environments.STG.adUnits placement [gone] has no ID value in the id-registry branch');
  });

  it('exports ios with the preset, icons, privacy items and the localized tracking text', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    const zip = join(release, 'client-godot-plugins.zip.d');
    write(zip, 'ogw-native-ui/ios/ios/plugins/ogw-native-ui/ogw-native-ui.gdip', '[config]\n\nname="OgwNativeUi"\nbinary="ogw-native-ui.xcframework"\n');
    write(zip, 'ogw-native-ui/android/addons/ogw-native-ui/plugin.cfg', '[plugin]\n');
    write(zip, 'ogw-push-apns/ios/ios/plugins/ogw-push-apns/ogw-push-apns.gdip', '[config]\n\nname="OgwPushApns"\n');
    const plugins = [{ name: 'ogw-push-apns', platforms: ['ios'] }, { name: 'ogw-native-ui', platforms: ['android', 'ios'] }];
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins });
    vi.mocked(extractedAsset).mockImplementation((_c, _r, asset) => Promise.resolve(asset === 'client-godot-plugins.zip' ? zip : release));
    write(dir, 'data/system/reserved_string.csv', ',\nAll,All\nid,tstring\nid,text\n[auth_tracking_usage],Ads <you>\n[app_name],G\n');
    write(dir, 'data/translations/ko.csv', 'key,source,text\n"reserved_string.text.[auth_tracking_usage]",Ads,광고\n');
    write(dir, 'resource/app_icon/main.png', 'png');
    commit(dir, 'data');
    const home = tmp();
    const b64 = (v: string) => Buffer.from(v).toString('base64');
    setSecrets(ws, { 'ogw/g/signing/dc': b64('P12'), 'ogw/g/signing/dcp': 'pw', 'ogw/g/signing/dpp': b64('PROFILE') });
    const ipaZip = join(ws.root, 'ipa.zip');
    writeFileSync(ipaZip, makeZip({ 'Payload/g.app/g.pck': makePck(['features/a.gd']), 'Payload/g.app/PrivacyInfo.xcprivacy': 'x' }));
    const bin = fakeBin(ws, {
      godot: GODOT,
      ffmpeg: 'for last; do :; done; printf png > "$last"',
      security: `case "$1" in
  -i) read -r line; echo "security -i $line" >> "$(dirname "$0")/calls.log";;
  list-keychains) [ "$3" = "-s" ] || echo '    "/Users/x/login.keychain-db"';;
  cms) echo '<plist><dict><key>UUID</key><string>ABC-123</string></dict></plist>';;
esac`,
      ditto: `case "$1" in -x) mkdir -p "$4/Payload/g.app/en.lproj"; echo old > "$4/Payload/g.app/en.lproj/InfoPlist.strings";; -c) for last; do :; done; cp "${ipaZip}" "$last";; esac`,
      plutil: '[ "$1" = "-create" ] && touch "$3"; [ "$1" = "-replace" ] && echo "$5" >> "$6"; exit 0',
      codesign: '',
    });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    vi.mocked(toolProgram).mockResolvedValue(join(bin.bin, 'ffmpeg'));
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin, HOME: home });
    const settings = gameSettings({
      appleTeamId: 'TEAM1',
      supportedLanguages: ['ko', 'en'],
      consent: { trackingRequest: true },
      admob: { appIdIos: 'ca-app-pub-1~9' },
      loginGoogle: { iosClientId: '123-abc.apps.googleusercontent.com' },
      signing: { ios: { distributionCertificate: 'dc', distributionCertificatePassword: 'dcp', distributionProvisioningProfile: 'dpp' } },
    });
    const envs = settings.environments as Record<string, Record<string, unknown>>;
    (envs.STG as Record<string, unknown>).adapters = { ads: 'ads-admob', 'login-google': 'login-google', 'login-apple': 'login-apple', 'push-apns': 'push-apns' };
    const privacy = [{ type: 'NSPrivacyCollectedDataTypeUserID', linked: true, tracking: false, shared: false, optional: false, purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality', 'NSPrivacyCollectedDataTypePurposeAnalytics'], rows: [] }];
    const game = await gameRepo(ws);
    const outDir = join(dir, 'builds', 'stg-1.2.3');
    const artifact = await godotBuild(ctx, { game, env: 'STG', version: '1.2.3', platforms: ['ios'], settings, outDir, iosPrivacy: privacy, privacyManifest: null }, 'ios');
    expect(artifact.artifact).toEqual({ platform: 'ios', path: 'builds/stg-1.2.3/ios' });
    const preset = readFileSync(join(bin.bin, 'preset.cfg'), 'utf8');
    for (const line of [
      'name="ios-stg"\nplatform="iOS"',
      'application/bundle_identifier="com.example.game"',
      'application/app_store_team_id="TEAM1"',
      'application/version="10020031"',
      'application/short_version="1.2.3"',
      'application/export_method_debug=1',
      'application/export_method_release=0',
      'application/code_sign_identity_debug="Apple Development"',
      'application/code_sign_identity_release="Apple Distribution"',
      'application/provisioning_profile_uuid_release="ABC-123"',
      'entitlements/push_notifications="Production"',
      'entitlements/additional="<key>com.apple.developer.applesignin</key>\\n<array>\\n<string>Default</string>\\n</array>"',
      'privacy/tracking_enabled=false',
      'privacy/collected_data/user_id/collected=true',
      'privacy/collected_data/user_id/linked_to_user=true',
      'privacy/collected_data/user_id/used_for_tracking=false',
      'privacy/collected_data/user_id/collection_purposes=3',
      'icons/icon_1024x1024="res://.ogw-build/ios_1024.png"',
      'icons/ipad_167x167="res://.ogw-build/ios_167.png"',
      'plugins/OgwNativeUi=true',
      'plugins/OgwPushApns=true',
    ]) {
      expect(preset).toContain(line);
    }
    expect(preset).toContain('<key>GADApplicationIdentifier</key>\\n<string>ca-app-pub-1~9</string>');
    expect(preset).toContain('<key>GIDClientID</key>\\n<string>123-abc.apps.googleusercontent.com</string>');
    expect(preset).toContain('<string>com.googleusercontent.apps.123-abc</string>');
    expect(preset).toContain('<key>NSUserTrackingUsageDescription</key>\\n<string>Ads &lt;you&gt;</string>');
    expect(readFileSync(join(bin.bin, 'project.godot'), 'utf8')).not.toContain('[editor_plugins]');
    const calls = readFileSync(bin.log, 'utf8');
    expect(calls).toMatch(/ffmpeg -y -loglevel error -i \S+main\.png -vf scale=58:58 -pix_fmt rgb24 \S+ios_58\.png/);
    expect(calls).toMatch(/plutil -create xml1 \S+\/Payload\/g\.app\/ko\.lproj\/InfoPlist\.strings\n/);
    expect(calls).toMatch(/plutil -replace NSUserTrackingUsageDescription -string 광고 \S+ko\.lproj\/InfoPlist\.strings\n/);
    expect(calls).toMatch(/plutil -replace NSUserTrackingUsageDescription -string Ads <you> \S+en\.lproj\/InfoPlist\.strings\n/);
    expect(calls).not.toMatch(/plutil -create xml1 \S+en\.lproj/);
    expect(calls).toMatch(/codesign --force --sign Apple Distribution --keychain \S+ogw\.keychain-db --entitlements \S+entitlements\.plist \S+\/Payload\/g\.app\n/);
    expect(calls).toMatch(/ditto -c -k --sequesterRsrc --keepParent \S+\/Payload \S+g\.ipa\n/);
    expect(calls.indexOf('codesign --force')).toBeLessThan(calls.indexOf('security delete-keychain'));
  });

  it('enables the editor plugins of the android plugins in project.godot', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    const zip = join(release, 'client-godot-plugins.zip.d');
    write(zip, 'ogw-native-ui/android/addons/ogw-native-ui/plugin.cfg', '[plugin]\n');
    write(zip, 'ogw-native-ui/ios/ios/plugins/ogw-native-ui/ogw-native-ui.gdip', '[config]\nname="OgwNativeUi"\n');
    write(zip, 'ogw-push-fcm/android/addons/ogw-push-fcm/plugin.cfg', '[plugin]\n');
    write(zip, 'ogw-desk/macos/addons/ogw-desk/plugin.cfg', '[plugin]\n');
    const sha256 = 'a'.repeat(64);
    write(ws.root, `.ogw/engine-packages/${sha256}/files/addons/third/plugin.cfg`, '[plugin]\n');
    const plugins = [
      { name: 'ogw-native-ui', platforms: ['android', 'ios', 'macos'] },
      { name: 'ogw-push-fcm', platforms: ['android'] },
      { name: 'ogw-desk', platforms: ['macos'] },
      { name: 'third', platforms: ['android'], url: 'https://example.com/third.zip', sha256 },
    ];
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins });
    vi.mocked(extractedAsset).mockImplementation((_c, _r, asset) => Promise.resolve(asset === 'client-godot-plugins.zip' ? zip : release));
    write(dir, 'resource/app_icon/main.png', 'png');
    commit(dir, 'resource');
    setSecrets(ws, { 'ogw/g/signing/ks': Buffer.from('KEYSTORE').toString('base64'), 'ogw/g/signing/pw': 'pw' });
    const bin = fakeBin(ws, { godot: GODOT, ffmpeg: 'for last; do :; done; printf png > "$last"' });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    vi.mocked(toolProgram).mockResolvedValue(join(bin.bin, 'ffmpeg'));
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    const settings = gameSettings({ androidKeyAlias: 'upload', signing: { android: { keystore: 'ks', password: 'pw' } } });
    const game = await gameRepo(ws);
    await godotBuild(ctx, { game, env: 'STG', version: '1.2.3', platforms: ['android'], settings, outDir: join(dir, 'builds', 'stg-1.2.3'), iosPrivacy: [], privacyManifest: null }, 'android');
    const project = readFileSync(join(bin.bin, 'project.godot'), 'utf8');
    expect(project).toContain('config/version="1.2.3"');
    expect(project).toMatch(/\n\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/ogw-native-ui\/plugin\.cfg", "res:\/\/addons\/ogw-push-fcm\/plugin\.cfg", "res:\/\/addons\/third\/plugin\.cfg"\)\n$/);
    const preset = readFileSync(join(bin.bin, 'preset.cfg'), 'utf8');
    expect(preset).not.toContain('plugins/');
    // webrtc-native has no android arm32 library: the export has only arm64-v8a
    expect(preset).toContain('architectures/armeabi-v7a=false\narchitectures/arm64-v8a=true\n');
  });

  it('fails an export whose output names a GDExtension without its library', async () => {
    expect(missingGdextensionLibraries('ok\nWARNING: No "arm32" library found for GDExtension: res://webrtc/webrtc.gdextension.\n  at: x\n')).toEqual([
      'WARNING: No "arm32" library found for GDExtension: res://webrtc/webrtc.gdextension.',
    ]);
    expect(missingGdextensionLibraries('Library found for GDExtension\n')).toEqual([]);
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins: [] });
    setSecrets(ws, {});
    const warn = `case "$*" in *--export-*) echo 'WARNING: No "x86_64" library found for GDExtension: res://addons/w/w.gdextension.' >&2;; esac\n`;
    const bin = fakeBin(ws, { godot: warn + GODOT });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    const game = await gameRepo(ws);
    const input = { game, env: 'STG' as const, version: '1.2.3', platforms: ['linux'], settings: gameSettings(), outDir: join(dir, 'builds', 'stg-1.2.3'), iosPrivacy: [], privacyManifest: null };
    await expect(godotBuild(ctx, input, 'linux')).rejects.toThrow('export of linux has a GDExtension without its library:\nWARNING: No "x86_64" library found for GDExtension: res://addons/w/w.gdextension.');
  });

  it('exports DEV android, macos and windows without signing values with free signing and records it on the artifact', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    const jdk = join(ws.root, 'jdk', 'bin');
    const androidTools = [{ platform: 'android', hosts: ['macos-arm64'], name: 'jdk', version: '17', versionCommand: 'jlink --version', downloads: [{ platform: 'any', url: 'u', sha256: 's' }] }];
    const dir = prepare(ws, release, { godot: '4.5.1.stable', plugins: [], buildTools: androidTools });
    write(dir, 'resource/app_icon/main.png', 'png');
    write(dir, 'data/system/reserved_string.csv', ',\nAll,All\nid,tstring\nid,text\n[app_name],G\n');
    commit(dir, 'resource');
    setSecrets(ws, { 'ogw/g/DEV/devAccess': 'DA' });
    // the keytool next to the installed Java runtime makes the debug keystore, not a keytool on PATH
    mkdirSync(jdk, { recursive: true });
    writeFileSync(join(jdk, 'keytool'), `#!/bin/sh\necho "installed keytool $*" >> "${join(ws.root, 'keytool.log')}"\nprev=""; for a in "$@"; do [ "$prev" = "-keystore" ] && echo KS > "$a"; prev="$a"; done\n`, { mode: 0o755 });
    vi.mocked(buildToolProgram).mockImplementation((_c, name) => Promise.resolve(name === 'jdk' ? join(jdk, 'jlink') : null));
    const bin = fakeBin(ws, { godot: GODOT, ffmpeg: 'for last; do :; done; printf png > "$last"', keytool: 'exit 1', jsign: 'exit 1' });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    vi.mocked(toolProgram).mockResolvedValue(join(bin.bin, 'ffmpeg'));
    const home = join(ws.root, 'home');
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin, HOME: home, OGW_HOST_PLATFORM: 'macos-arm64' });
    const game = await gameRepo(ws);
    const input = { game, env: 'DEV' as const, version: '1.2.3', platforms: [], settings: gameSettings(), outDir: join(dir, 'builds', 'dev-1.2.3'), iosPrivacy: [], privacyManifest: null };

    const android = await godotBuild(ctx, input, 'android');
    expect(android.artifact).toEqual({ platform: 'android', path: 'builds/dev-1.2.3/android', freeSigning: 'debug keystore' });
    const keystore = join(home, '.android', 'debug.keystore');
    expect(readFileSync(join(bin.bin, 'keystore-env'), 'utf8')).toBe(
      `GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD=android\nGODOT_ANDROID_KEYSTORE_DEBUG_PATH=${keystore}\nGODOT_ANDROID_KEYSTORE_DEBUG_USER=androiddebugkey\n`,
    );
    expect(readFileSync(join(ws.root, 'keytool.log'), 'utf8')).toContain('installed keytool -genkeypair');
    expect(readFileSync(bin.log, 'utf8')).not.toContain('keytool ');

    const macos = await godotBuild(ctx, input, 'macos');
    expect(macos.artifact.freeSigning).toBe('ad-hoc');
    const preset = readFileSync(join(bin.bin, 'preset.cfg'), 'utf8');
    expect(preset).toContain('codesign/codesign=1');
    expect(preset).not.toContain('codesign/provisioning_profile');
    expect(preset).not.toContain('notarization/notarization');
    expect(existsSync(join(bin.bin, 'credentials.cfg'))).toBe(false);

    const windows = await godotBuild(ctx, input, 'windows');
    expect(windows.artifact.freeSigning).toBe('unsigned');
    expect(readFileSync(bin.log, 'utf8')).not.toContain('jsign');

    // with signing values DEV signs: windows goes to jsign (no jsign item here) and the artifact has no free signing
    const signed = { ...input, settings: gameSettings({ signing: { windows: { clientSecret: 'cs' } } }) };
    await expect(godotBuild(ctx, signed, 'windows')).rejects.toThrow('engine.json buildTools has no windows item jsign for this host');
    const stg = await godotBuild(ctx, { ...input, env: 'STG', outDir: join(dir, 'builds', 'stg-1.2.3') }, 'linux');
    expect(stg.artifact).toEqual({ platform: 'linux', path: 'builds/stg-1.2.3/linux' });
  });

  it('needs pinned third-party plugins, appleTeamId for iOS, and the devAccess secret for DEV', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    prepare(ws, release, { godot: '4.5.1.stable', plugins: [{ name: 'admob-sdk', platforms: ['android'] }] });
    const bin = fakeBin(ws, { godot: GODOT, ffmpeg: 'for last; do :; done; printf png > "$last"' });
    vi.mocked(toolProgram).mockResolvedValue(join(bin.bin, 'ffmpeg'));
    const game = await gameRepo(ws);
    const base = { game, version: '1.2.3', platforms: [], settings: gameSettings(), outDir: join(ws.root, 'out'), iosPrivacy: [], privacyManifest: null };
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    await expect(godotBuild(ctx, { ...base, env: 'STG' }, 'android')).rejects.toThrow('engine.json item admob-sdk has no url or sha256. Run ogw core pin-engine');
    await expect(godotBuild(ctx, { ...base, env: 'STG' }, 'ios')).rejects.toThrow('game settings appleTeamId is missing');
    setSecrets(ws, {});
    await expect(godotBuild(ctx, { ...base, env: 'DEV' }, 'web')).rejects.toThrow('secret devAccess of DEV is not in the secret store');
    setSecrets(ws, { 'ogw/g/DEV/devAccess': 'DA' });
    expect((await godotBuild(ctx, { ...base, env: 'DEV' }, 'web')).artifact.path).toBe('../../out/web');
    // the exported service worker is client core's, with the exporter's values
    expect(readFileSync(join(ws.games, '..', 'out', 'web', 'index.service.worker.js'), 'utf8')).toBe('const CACHE_VERSION = "v1";\n');
    expect(JSON.parse(readFileSync(join(bin.bin, 'build_info.json'), 'utf8'))).toMatchObject({ dev_access: 'DA', environment: 'DEV' });
    expect(readFileSync(join(bin.bin, 'preset.cfg'), 'utf8')).toContain('variant/thread_support=true');
    expect(readFileSync(join(bin.bin, 'preset.cfg'), 'utf8')).toContain('progressive_web_app/ensure_cross_origin_isolation_headers=true');
    expect(readFileSync(join(bin.bin, 'preset.cfg'), 'utf8')).toContain('html/custom_html_shell="res://core/web/ogw-shell.html"');
    expect(readFileSync(join(bin.bin, 'a.gd'), 'utf8')).toBe('\tLogCore.log_debug("x")\n');
  });
});

function readdirOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
