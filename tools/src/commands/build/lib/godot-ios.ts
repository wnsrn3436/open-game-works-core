import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { parseTable } from '../../data/lib/csv.ts';
import { dataRows } from './csv.ts';
import type { Env } from './names.ts';
import type { StoreAnswer } from './privacy.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

/** iOS preset `icons/` items ogw fills from resource `app_icon/main` and their pixel size (`build` engines/godot.md). */
export const IOS_ICONS: readonly (readonly [string, number])[] = [
  ['icons/icon_1024x1024', 1024],
  ['icons/app_store_1024x1024', 1024],
  ['icons/settings_58x58', 58],
  ['icons/settings_87x87', 87],
  ['icons/notification_40x40', 40],
  ['icons/notification_60x60', 60],
  ['icons/notification_76x76', 76],
  ['icons/notification_114x114', 114],
  ['icons/spotlight_80x80', 80],
  ['icons/spotlight_120x120', 120],
  ['icons/iphone_120x120', 120],
  ['icons/iphone_180x180', 180],
  ['icons/ipad_152x152', 152],
  ['icons/ipad_167x167', 167],
  ['icons/ios_128x128', 128],
  ['icons/ios_136x136', 136],
  ['icons/ios_192x192', 192],
];

/** Bits of the iOS preset `privacy/collected_data/<key>/collection_purposes` by `NSPrivacyCollectedDataTypePurposes` value. */
export const PURPOSE_BITS: Readonly<Record<string, number>> = {
  NSPrivacyCollectedDataTypePurposeAnalytics: 1,
  NSPrivacyCollectedDataTypePurposeAppFunctionality: 2,
  NSPrivacyCollectedDataTypePurposeDeveloperAdvertising: 4,
  NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising: 8,
  NSPrivacyCollectedDataTypePurposeProductPersonalization: 16,
  NSPrivacyCollectedDataTypePurposeOther: 32,
};

/** Signing identity of the iOS export of an environment. */
export function iosIdentity(env: Env): string {
  return env === 'DEV' ? 'Apple Development' : 'Apple Distribution';
}

/** `<key>` of `privacy/collected_data/<key>/...`: the data type name after `NSPrivacyCollectedDataType`, in snake_case. */
export function privacyKey(type: string): string {
  return type
    .replace(/^NSPrivacyCollectedDataType/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** iOS preset privacy manifest items of the build's `PrivacyInfo.xcprivacy` answers. */
export function privacyOptions(list: readonly StoreAnswer[]): Record<string, unknown> {
  const options: Record<string, unknown> = { 'privacy/tracking_enabled': list.some((a) => a.tracking), 'privacy/tracking_domains': [] };
  for (const a of list) {
    const key = `privacy/collected_data/${privacyKey(a.type)}`;
    options[`${key}/collected`] = true;
    options[`${key}/linked_to_user`] = a.linked;
    options[`${key}/used_for_tracking`] = a.tracking;
    options[`${key}/collection_purposes`] = a.purposes.reduce((bits, p) => bits | (PURPOSE_BITS[p] ?? 0), 0);
  }
  return options;
}

/** `text` escaped for the text of a plist XML element. */
export function xml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** `com.googleusercontent.apps.<id>` for the client ID `<id>.apps.googleusercontent.com`. */
export function reversedClientId(clientId: string): string {
  return clientId.split('.').reverse().join('.');
}

function adapters(settings: GameSettings, env: Env): Record<string, string> {
  return (settings.environments?.[env]?.adapters ?? {}) as Record<string, string>;
}

export function trackingRequested(settings: GameSettings): boolean {
  return (settings.consent as { trackingRequest?: boolean } | undefined)?.trackingRequest === true;
}

const TRACKING_ID = '[auth_tracking_usage]';
const TRACKING_KEY = `reserved_string.text.${TRACKING_ID}`;

/** Source text of reserved string `[auth_tracking_usage]`. */
export async function trackingSource(root: string): Promise<string> {
  const path = join(root, 'data', 'system', 'reserved_string.csv');
  const row = exists(path) ? dataRows(await readFile(path, 'utf8')).find((r) => r.id === TRACKING_ID) : undefined;
  if (!row?.text) throw new OgwError(`data/system/reserved_string.csv has no ${TRACKING_ID} text`);
  return row.text;
}

/**
 * `NSUserTrackingUsageDescription` per supported language: `[<lproj name>, text]`. The lproj name is the language
 * tag with `-` replaced by `_`; the text is the translation, or the source text when the translation is missing.
 */
export async function trackingTexts(root: string, languages: readonly string[], source: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const language of languages) {
    const path = join(root, 'data', 'translations', `${language}.csv`);
    const row = exists(path) ? parseTable(await readFile(path, 'utf8'), path).rows.find((r) => r.values.key === TRACKING_KEY) : undefined;
    const text = row?.values.text ?? '';
    out.push([language.replaceAll('-', '_'), text !== '' ? text : source]);
  }
  return out;
}

interface PlistParts {
  settings: GameSettings;
  env: Env;
  trackingText: string | null;
}

/** `application/additional_plist_content`: AdMob app ID, Google Sign-In, and the source `NSUserTrackingUsageDescription`. */
export function additionalPlist(p: PlistParts): string {
  const lines: string[] = [];
  const chosen = adapters(p.settings, p.env);
  if (chosen.ads === 'ads-admob') {
    const id = (p.settings.admob as { appIdIos?: string } | undefined)?.appIdIos;
    if (!id) throw new OgwError('game settings admob.appIdIos is missing');
    lines.push('<key>GADApplicationIdentifier</key>', `<string>${xml(id)}</string>`);
  }
  if (chosen['login-google'] === 'login-google') {
    const id = (p.settings.loginGoogle as { iosClientId?: string } | undefined)?.iosClientId;
    if (!id) throw new OgwError('game settings loginGoogle.iosClientId is missing');
    lines.push('<key>GIDClientID</key>', `<string>${xml(id)}</string>`);
    lines.push('<key>CFBundleURLTypes</key>', '<array>', '<dict>', '<key>CFBundleURLSchemes</key>', '<array>', `<string>${xml(reversedClientId(id))}</string>`, '</array>', '</dict>', '</array>');
  }
  if (p.trackingText !== null) lines.push('<key>NSUserTrackingUsageDescription</key>', `<string>${xml(p.trackingText)}</string>`);
  return lines.join('\n');
}

/** `entitlements/push_notifications` by `adapters.push-apns`. */
export function pushEntitlement(settings: GameSettings, env: Env): string {
  const value = adapters(settings, env)['push-apns'];
  if (value === 'push-apns') return 'Production';
  if (value === 'push-apns-sandbox') return 'Development';
  return 'Disabled';
}

export interface IosPresetInput {
  settings: GameSettings;
  env: Env;
  version: string;
  versionCode: number;
  privacy: readonly StoreAnswer[];
  trackingText: string | null;
  /** `res://` path of resource `app_icon/main` made `size` pixels square without alpha. */
  icon(size: number): Promise<string>;
}

/** The ios export preset options (`build` engines/godot.md `### export preset`). */
export async function iosOptions(input: IosPresetInput): Promise<Record<string, unknown>> {
  const team = input.settings.appleTeamId;
  if (typeof team !== 'string' || team === '') throw new OgwError('game settings appleTeamId is missing');
  const options: Record<string, unknown> = {
    'architectures/arm64': true,
    'application/bundle_identifier': input.settings.appId,
    'application/app_store_team_id': team,
    'application/version': String(input.versionCode),
    'application/short_version': input.version,
    'application/export_method_debug': 1,
    'application/export_method_release': 0,
    'application/code_sign_identity_debug': iosIdentity('DEV'),
    'application/code_sign_identity_release': iosIdentity('PROD'),
    'application/additional_plist_content': additionalPlist(input),
    'entitlements/push_notifications': pushEntitlement(input.settings, input.env),
    'entitlements/additional':
      adapters(input.settings, input.env)['login-apple'] === 'login-apple'
        ? '<key>com.apple.developer.applesignin</key>\n<array>\n<string>Default</string>\n</array>'
        : '',
    ...privacyOptions(input.privacy),
  };
  for (const [key, size] of IOS_ICONS) options[key] = await input.icon(size);
  return options;
}

const run = (ctx: Context, cmd: string, args: string[]): Promise<string> =>
  runOk(cmd, args, { env: ctx.env, timeoutMs: LIMITS.programMs }).then((r) => r.stdout);

/**
 * Adds the localized `NSUserTrackingUsageDescription` to the exported `.ipa`: for each `[<lproj>, text]` the key in
 * `Payload/<app>.app/<lproj>.lproj/InfoPlist.strings` (made when missing), then signs the app bundle again with its own
 * entitlements and the export's identity in `keychain`, and writes the `.ipa` again.
 */
export async function localizeTracking(ctx: Context, ipa: string, texts: readonly [string, string][], keychain: string, identity: string): Promise<void> {
  if (texts.length === 0) return;
  const dir = await newPrivateTempFolder('ogw-ipa-', ctx.env);
  try {
    await run(ctx, 'ditto', ['-x', '-k', ipa, dir]);
    const name = (await readdir(join(dir, 'Payload'))).find((n) => n.endsWith('.app'));
    if (name === undefined) throw new OgwError(`${ipa} has no Payload/*.app`);
    const app = join(dir, 'Payload', name);
    for (const [lproj, text] of texts) {
      const strings = join(app, `${lproj}.lproj`, 'InfoPlist.strings');
      if (!exists(strings)) {
        await mkdir(join(app, `${lproj}.lproj`), { recursive: true });
        await run(ctx, 'plutil', ['-create', 'xml1', strings]);
      }
      await run(ctx, 'plutil', ['-replace', 'NSUserTrackingUsageDescription', '-string', text, strings]);
    }
    const entitlements = join(dir, 'entitlements.plist');
    await run(ctx, 'codesign', ['-d', '--entitlements', entitlements, '--xml', app]);
    await run(ctx, 'codesign', ['--force', '--sign', identity, '--keychain', keychain, '--entitlements', entitlements, app]);
    await rm(ipa, { force: true });
    await run(ctx, 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(dir, 'Payload'), ipa]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
