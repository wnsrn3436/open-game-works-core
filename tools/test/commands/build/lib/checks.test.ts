import { describe, expect, it } from 'vitest';
import { dataRows, headerRows, parseCsv, parseDuration } from '../../../../src/commands/build/lib/csv.ts';
import { compareVersions, parseBuildTag, highestVersion, lastProdTag, lastProdTagName, requireVersion, type BuildTag } from '../../../../src/commands/build/lib/names.ts';
import { makePck, matchesFilter, pckPaths } from '../../../../src/commands/build/lib/pck.ts';
import type { RepoReader } from '../../../../src/commands/build/lib/repo.ts';
import {
  adapterCheck,
  admobCheck,
  bannedWordCheck,
  humanChecks,
  licenseCheck,
  privacyCheck,
  type CoreSpecModule,
  type SettingsCheckInput,
} from '../../../../src/commands/build/lib/settingschecks.ts';
import { isZip, zipEntries } from '../../../../src/commands/build/lib/zip.ts';
import { makeZip } from '../zipwriter.ts';

function reader(files: Record<string, string>): RepoReader {
  return { read: (p) => Promise.resolve(files[p] ?? null), list: () => Promise.resolve(Object.keys(files)) };
}

const table = (columns: string[], rows: string[][]): string => [columns.map(() => ''), columns.map(() => 'All'), columns.map(() => 'string'), columns, ...rows].map((r) => r.join(',')).join('\n');

function input(patch: Partial<SettingsCheckInput> = {}, files: Record<string, string> = {}): SettingsCheckInput {
  return { env: 'STG', platforms: ['android'], settings: { environments: { DEV: {}, STG: {}, PROD: {} } }, reader: reader(files), modules: [], coreSpec: [], sandboxKeys: ['iap-apple', 'push-apns'], ...patch };
}

const withAdapters = (env: 'DEV' | 'STG' | 'PROD', adapters: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  environments: { DEV: {}, STG: {}, PROD: {}, [env]: { adapters, ...extra } },
});

describe('csv', () => {
  it('parses quotes, CRLF and data tables', () => {
    expect(parseCsv('a,"b ""c""",d\r\n"x\ny",,\n')).toEqual([['a', 'b "c"', 'd'], ['x\ny', '', '']]);
    expect(headerRows('﻿key,license\nbg/a,MIT\n\nbg/b,unknown')).toEqual([{ key: 'bg/a', license: 'MIT' }, { key: 'bg/b', license: 'unknown' }]);
    expect(dataRows(table(['id', 'v'], [['[a]', '1'], ['#[b]', '2'], ['[c]']]))).toEqual([{ id: '[a]', v: '1' }, { id: '[c]', v: '' }]);
    expect(dataRows('x')).toEqual([]);
    expect(headerRows('')).toEqual([]);
  });

  it('parses durations', () => {
    expect(parseDuration('1d2h30m')).toBe(86_400_000 + 7_200_000 + 1_800_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('3s')).toBe(3000);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('3x')).toBeNull();
  });
});

describe('names', () => {
  it('parses tags and versions', () => {
    expect(parseBuildTag('stg-1.2.3-bundle-4')).toEqual({ tag: 'stg-1.2.3-bundle-4', env: 'STG', version: '1.2.3', bundle: 4 });
    expect(parseBuildTag('prod-1.02.3')).toBeNull();
    expect(parseBuildTag('qa-1.0.0')).toBeNull();
    expect(() => requireVersion('1.0')).toThrow('invalid version: 1.0');
    expect(compareVersions([1, 2, 3], [1, 10, 0])).toBeLessThan(0);
    const tags = ['prod-1.0.0', 'prod-2.0.0-bundle-1', 'prod-1.5.0', 'dev-3.0.0'].map(parseBuildTag) as BuildTag[];
    expect(highestVersion(tags)).toEqual([3, 0, 0]);
    expect(lastProdTag(tags)?.tag).toBe('prod-1.5.0');
    expect(lastProdTag([])).toBeNull();
    expect(lastProdTagName(['prod-1.9.0', 'prod-1.10.0', 'prod-2.0.0-bundle-1', 'stg-3.0.0', 'prod-x'])).toBe('prod-1.10.0');
    expect(lastProdTagName(['dev-1.0.0'])).toBeNull();
  });
});

describe('zip and pck', () => {
  it('reads stored and deflated entries', () => {
    const zip = makeZip({ 'a.txt': 'hello', 'dir/b.bin': Buffer.from([1, 2, 3]) });
    expect(isZip(zip)).toBe(true);
    expect(zipEntries(zip).map((e) => [e.name, e.data().toString('hex')])).toEqual([['a.txt', Buffer.from('hello').toString('hex')], ['dir/b.bin', '010203']]);
    expect(zipEntries(makeZip({ s: 'x' }, true))[0]?.data().toString()).toBe('x');
    expect(isZip(Buffer.from('plain text file'))).toBe(false);
    expect(() => zipEntries(Buffer.alloc(30))).toThrow('not a zip archive');
  });

  it('reads pck directories of format 2 and 3', () => {
    expect(pckPaths(makePck(['res://dev/a.gd', 'resource/b.png']))).toEqual(['dev/a.gd', 'resource/b.png']);
    expect(pckPaths(makePck(['tests/t.gd'], 2))).toEqual(['tests/t.gd']);
    expect(() => pckPaths(Buffer.from('nope'))).toThrow('not a Godot pck');
    const encrypted = makePck([]);
    encrypted.writeUInt32LE(1, 20);
    expect(() => pckPaths(encrypted)).toThrow('encrypted');
    const future = makePck([]);
    future.writeUInt32LE(9, 4);
    expect(() => pckPaths(future)).toThrow('pck format 9 not supported');
  });

  it('matches export filters', () => {
    const filter = 'tests/*,addons/gut/*,dev/*,core/*/dev/*,generated/launch_values.json';
    expect(['tests/a.gd', 'addons/gut/x/y.gd', 'dev/bot.gd', 'core/qa/dev/x.gd', 'generated/launch_values.json'].every((p) => matchesFilter(p, filter))).toBe(true);
    expect(['features/dev.gd', 'core/qa/x.gd', 'generated/build_info.json', 'xtests/a'].some((p) => matchesFilter(p, filter))).toBe(false);
  });
});

describe('license check', () => {
  const files = { 'resource/resources.csv': 'key,license\nbg/a,MIT\nbg/b,unknown\n' };
  it('fails STG with human targets and warns DEV', async () => {
    expect((await licenseCheck(input({}, files))).check).toEqual({ name: 'license', result: 'fail', details: ['resource/resources.csv: license unknown: bg/b'] });
    expect((await licenseCheck(input({}, files))).human).toEqual({ check: 'license', targets: ['bg/b'] });
    const dev = await licenseCheck(input({ env: 'DEV' }, files));
    expect([dev.check.result, dev.human]).toEqual(['warn', null]);
    expect((await licenseCheck(input({}, {}))).check.result).toBe('pass');
  });
});

describe('adapter check', () => {
  const targets = (i: SettingsCheckInput) => adapterCheck(i).human?.targets ?? [];
  it('checks DEV push-apns', () => {
    expect(targets(input({ env: 'DEV', settings: withAdapters('DEV', { 'push-apns': 'push-apns' }) }))).toEqual(['environments.DEV.adapters.push-apns']);
    expect(adapterCheck(input({ env: 'DEV', settings: withAdapters('DEV', { 'push-apns': 'push-apns-sandbox' }) })).check.result).toBe('pass');
  });
  it('checks STG fake, sandbox names and push-apns-sandbox', () => {
    const settings = withAdapters('STG', { cdn: 'fake', 'push-apns': 'push-apns-sandbox', 'iap-apple': 'iap-apple', 'iap-google': 'iap-google', 'login-apple': 'login-apple' });
    expect(targets(input({ settings }))).toEqual(['environments.STG.adapters.cdn', 'environments.STG.adapters.push-apns', 'environments.STG.adapters.iap-apple']);
    expect(targets(input({ settings: withAdapters('STG', { 'iap-apple': 'iap-apple-sandbox', 'push-apns': 'push-apns' }) }))).toEqual([]);
  });
  it('checks PROD fake, sandbox and cdn', () => {
    expect(targets(input({ env: 'PROD', settings: withAdapters('PROD', { ads: 'fake', 'iap-apple': 'iap-apple-sandbox' }) }))).toEqual([
      'environments.PROD.adapters.ads', 'environments.PROD.adapters.iap-apple', 'environments.PROD.adapters.cdn',
    ]);
    expect(targets(input({ env: 'PROD', settings: withAdapters('PROD', { cdn: 'cdn-r2' }) }))).toEqual([]);
  });
  it('checks ios login-google without login-apple and web without cdn-r2', () => {
    expect(targets(input({ platforms: ['ios'], settings: withAdapters('STG', { 'login-google': 'login-google' }) }))).toEqual(['environments.STG.adapters.login-apple']);
    expect(targets(input({ env: 'DEV', platforms: ['ios', 'web'], settings: withAdapters('DEV', { 'login-google': 'login-google', cdn: 'fake' }) }))).toEqual(['environments.DEV.adapters.cdn']);
  });
});

describe('admob check', () => {
  const placements = { 'data/tables/ad_placement.csv': table(['id', 'type'], [['[reward]', 'Rewarded'], ['[banner]', 'Banner']]) };
  it('passes without ads-admob', async () => {
    expect((await admobCheck(input({}, placements))).check.result).toBe('pass');
  });
  it('needs app IDs and unique ad unit IDs for every placement', async () => {
    const settings = {
      admob: { appIdAndroid: '' },
      environments: {
        DEV: { adUnits: { '[reward]': { android: 'shared' } } },
        STG: { adapters: { ads: 'ads-admob' }, adUnits: { '[reward]': { android: 'shared', ios: 'r-ios' }, '[banner]': { ios: 'b-ios' } } },
        PROD: {},
      },
    };
    const result = await admobCheck(input({ platforms: ['android', 'ios'], settings }, placements));
    expect(result.human?.targets).toEqual([
      'admob.appIdAndroid', 'admob.appIdIos', 'environments.STG.adUnits.[reward].android', 'environments.STG.adUnits.[banner].android',
    ]);
    const ok = { admob: { appIdAndroid: 'a', appIdIos: 'i' }, environments: { STG: { adapters: { ads: 'ads-admob' }, adUnits: { '[reward]': { android: 'r', ios: 'r2' }, '[banner]': { android: 'b', ios: 'b2' } } } } };
    expect((await admobCheck(input({ platforms: ['android', 'ios'], settings: ok }, placements))).check.result).toBe('pass');
  });
});

describe('banned word check', () => {
  const settings = { supportedLanguages: ['ko', 'en', 'ja'] };
  it('needs built rows when nickname, guild or chat is used', async () => {
    const files = { 'records/setup/banned-words/en.txt': 'bad\n', 'records/setup/banned-words/ja.txt': '\n  \n' };
    const failed = await bannedWordCheck(input({ modules: ['guild'], settings }, files));
    expect(failed.check).toEqual({ name: 'banned word', result: 'fail', details: ['data/tables/banned_word.csv has no built row'] });
    expect(failed.human?.targets).toEqual(['ko', 'ja']);
    expect((await bannedWordCheck(input({ env: 'DEV', modules: ['chat'], settings }, files))).check.result).toBe('warn');
    expect((await bannedWordCheck(input({ modules: ['shop'], settings }, files))).check.result).toBe('pass');
    const built = { 'data/tables/banned_word.csv': table(['id', 'word'], [['[w1]', 'bad']]) };
    expect((await bannedWordCheck(input({ modules: ['nickname'], settings }, built))).check.result).toBe('pass');
  });
});

describe('privacy check', () => {
  const spec: CoreSpecModule[] = [
    { name: 'ads-reward', side: 'server', adapters: ['ads-admob'], collectedData: [{ dataType: 'advertising_data', description: 'ads', source: 'ads-admob', purposes: ['third_party_advertising'], linked: false, tracking: true, shared: true, optional: true, platforms: ['android'], condition: null }] },
  ];
  it('needs game settings privacy and a collectedData row per chosen adapter', () => {
    const settings = withAdapters('STG', { ads: 'ads-admob', 'iap-apple': 'iap-apple-sandbox', cdn: 'fake' });
    const result = privacyCheck(input({ settings, modules: ['ads-reward'], coreSpec: spec }));
    expect(result.check.details).toEqual(['game settings privacy is missing', 'adapter iap-apple has no collectedData row']);
    expect(result.human).toEqual({ check: 'privacy', targets: ['iap-apple'] });
    const dev = privacyCheck(input({ env: 'DEV', settings: withAdapters('DEV', { ads: 'ads-admob' }), modules: [], coreSpec: spec }));
    expect([dev.check.result, dev.check.details]).toEqual(['warn', ['adapter ads-admob has no collectedData row']]);
    const ok = privacyCheck(input({ settings: { ...withAdapters('STG', { ads: 'ads-admob' }), privacy: { contentData: [] } }, modules: ['ads-reward'], coreSpec: spec }));
    expect(ok.check.result).toBe('pass');
  });
});

describe('humanChecks', () => {
  it('returns the five checks and DEV license warnings', async () => {
    const result = await humanChecks(input({ env: 'DEV' }, { 'resource/resources.csv': 'key,license\nx,unknown\n' }));
    expect(result.checks.map((c) => c.check.name)).toEqual(['license', 'adapter', 'admob', 'banned word', 'privacy']);
    expect(result.licenseWarnings).toEqual(['x']);
    expect((await humanChecks(input({}, {}))).licenseWarnings).toEqual([]);
  });
});
