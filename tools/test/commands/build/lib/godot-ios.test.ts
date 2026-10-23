import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  additionalPlist,
  IOS_ICONS,
  iosIdentity,
  iosOptions,
  localizeTracking,
  privacyKey,
  privacyOptions,
  pushEntitlement,
  reversedClientId,
  trackingRequested,
  trackingSource,
  trackingTexts,
} from '../../../../src/commands/build/lib/godot-ios.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';
import { fakeBin, write } from '../helpers.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-ios-')));
}

const withAdapters = (adapters: Record<string, string>, extra: Record<string, unknown> = {}) => ({ ...extra, environments: { STG: { adapters } } });

describe('iOS preset values', () => {
  it('names identities, privacy keys, reversed client IDs and push entitlements', () => {
    expect([iosIdentity('DEV'), iosIdentity('STG'), iosIdentity('PROD')]).toEqual(['Apple Development', 'Apple Distribution', 'Apple Distribution']);
    expect(['NSPrivacyCollectedDataTypeUserID', 'NSPrivacyCollectedDataTypeOtherUserContent', 'NSPrivacyCollectedDataTypeDeviceID'].map(privacyKey)).toEqual([
      'user_id',
      'other_user_content',
      'device_id',
    ]);
    expect(reversedClientId('1-a.apps.googleusercontent.com')).toBe('com.googleusercontent.apps.1-a');
    expect(pushEntitlement(withAdapters({ 'push-apns': 'push-apns' }), 'STG')).toBe('Production');
    expect(pushEntitlement(withAdapters({ 'push-apns': 'push-apns-sandbox' }), 'STG')).toBe('Development');
    expect(pushEntitlement(withAdapters({ 'push-apns': 'fake' }), 'STG')).toBe('Disabled');
    expect(pushEntitlement({}, 'DEV')).toBe('Disabled');
    expect(trackingRequested({ consent: { trackingRequest: true } })).toBe(true);
    expect(trackingRequested({ consent: { trackingRequest: false } })).toBe(false);
    expect(trackingRequested({})).toBe(false);
    expect(IOS_ICONS.every(([key, size]) => key.endsWith(`_${String(size)}x${String(size)}`))).toBe(true);
  });

  it('turns privacy answers into preset items with purpose bits', () => {
    const answer = { type: 'NSPrivacyCollectedDataTypeCrashData', linked: false, tracking: true, shared: false, optional: true, rows: [] };
    expect(
      privacyOptions([
        { ...answer, purposes: ['NSPrivacyCollectedDataTypePurposeDeveloperAdvertising', 'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising', 'NSPrivacyCollectedDataTypePurposeProductPersonalization', 'NSPrivacyCollectedDataTypePurposeOther', 'Unknown'] },
      ]),
    ).toEqual({
      'privacy/tracking_enabled': true,
      'privacy/tracking_domains': [],
      'privacy/collected_data/crash_data/collected': true,
      'privacy/collected_data/crash_data/linked_to_user': false,
      'privacy/collected_data/crash_data/used_for_tracking': true,
      'privacy/collected_data/crash_data/collection_purposes': 60,
    });
    expect(privacyOptions([])).toEqual({ 'privacy/tracking_enabled': false, 'privacy/tracking_domains': [] });
  });

  it('writes the additional plist content only for the chosen adapters and fails on missing IDs', () => {
    expect(additionalPlist({ settings: {}, env: 'DEV', trackingText: null })).toBe('');
    expect(additionalPlist({ settings: {}, env: 'DEV', trackingText: 'a&b' })).toBe('<key>NSUserTrackingUsageDescription</key>\n<string>a&amp;b</string>');
    expect(() => additionalPlist({ settings: withAdapters({ ads: 'ads-admob' }), env: 'STG', trackingText: null })).toThrow('game settings admob.appIdIos is missing');
    expect(() => additionalPlist({ settings: withAdapters({ 'login-google': 'login-google' }), env: 'STG', trackingText: null })).toThrow('game settings loginGoogle.iosClientId is missing');
    expect(additionalPlist({ settings: withAdapters({ ads: 'fake', 'login-google': 'fake' }), env: 'STG', trackingText: null })).toBe('');
  });

  it('needs appleTeamId and leaves entitlements/additional empty without Sign in with Apple', async () => {
    const base = { env: 'DEV' as const, version: '1.0.0', versionCode: 10000000, privacy: [], trackingText: null, icon: (size: number) => Promise.resolve(`res://${String(size)}.png`) };
    await expect(iosOptions({ ...base, settings: {} })).rejects.toThrow('game settings appleTeamId is missing');
    await expect(iosOptions({ ...base, settings: { appleTeamId: '' } })).rejects.toThrow('game settings appleTeamId is missing');
    const options = await iosOptions({ ...base, settings: { appleTeamId: 'T', appId: 'a.b' } });
    expect(options['entitlements/additional']).toBe('');
    expect(options['entitlements/push_notifications']).toBe('Disabled');
    expect(options['application/additional_plist_content']).toBe('');
    expect(options['icons/app_store_1024x1024']).toBe('res://1024.png');
    expect(options['architectures/arm64']).toBe(true);
  });
});

describe('tracking text', () => {
  it('reads the source text and the translations with the source as fallback', async () => {
    const root = tmp();
    await expect(trackingSource(root)).rejects.toThrow('data/system/reserved_string.csv has no [auth_tracking_usage] text');
    write(root, 'data/system/reserved_string.csv', ',\nAll,All\nid,tstring\nid,text\n[auth_tracking_usage],\n');
    await expect(trackingSource(root)).rejects.toThrow('has no [auth_tracking_usage] text');
    write(root, 'data/system/reserved_string.csv', ',\nAll,All\nid,tstring\nid,text\n[auth_tracking_usage],Track\n');
    expect(await trackingSource(root)).toBe('Track');
    write(root, 'data/translations/pt-BR.csv', 'key,source,text\n"reserved_string.text.[auth_tracking_usage]",Track,Rastrear\n');
    write(root, 'data/translations/ja.csv', 'key,source,text\n"reserved_string.text.[auth_tracking_usage]",Track,\n');
    expect(await trackingTexts(root, ['pt-BR', 'ja', 'ko'], 'Track')).toEqual([
      ['pt_BR', 'Rastrear'],
      ['ja', 'Track'],
      ['ko', 'Track'],
    ]);
  });

  it('does nothing without languages and fails when the ipa has no app', async () => {
    const ws = makeWorkspace();
    const bin = fakeBin(ws, { ditto: 'mkdir -p "$4/Payload"' });
    const ctx = createContext({ cwd: ws.root, env: { ...ws.env, ...bin.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await localizeTracking(ctx, join(ws.root, 'g.ipa'), [], 'kc', 'Apple Development');
    await expect(localizeTracking(ctx, join(ws.root, 'g.ipa'), [['en', 'x']], 'kc', 'Apple Development')).rejects.toThrow('g.ipa has no Payload/*.app');
  });
});
