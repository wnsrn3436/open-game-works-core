import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { concurrencyLimit } from '../../../src/commands/instance/lib/prepare.ts';
import { typeRow } from '../../../src/commands/generation/check.ts';
import { loadHarnessSettings } from '../../../src/lib/settings.ts';
import { ogw, makeWorkspace, TEST_HOST_ID, type TestWorkspace } from '../../helpers/workspace.ts';

const OTHER = 'f'.repeat(32);

let ws: TestWorkspace;
let path: string;
let localPath: string;

beforeEach(() => {
  ws = makeWorkspace();
  path = join(ws.harness, 'settings.json');
  localPath = join(ws.harness, 'settings.local.json');
});

const settingsCmd = (...argv: string[]) => ogw(ws, ['settings', ...argv]);

function read(file: string): Record<string, unknown> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

function patchShared(patch: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ ...read(path), ...patch }));
}

function writeLocal(value: Record<string, unknown> | null): void {
  if (value === null) rmSync(localPath, { force: true });
  else writeFileSync(localPath, JSON.stringify(value));
}

describe('harness settings host values', () => {
  it('keeps the host values at the top level of settings.local.json', async () => {
    expect(await settingsCmd('get', 'harness', 'maxConcurrentInstances')).toEqual({ code: 1, stdout: '', stderr: 'no value: maxConcurrentInstances\n' });
    expect((await settingsCmd('get', 'harness', 'playInstances')).stdout).toBe('3\nsource: schema default\n');
    expect(await settingsCmd('set', 'harness', 'playInstances', '2')).toEqual({ code: 0, stdout: 'set playInstances\n', stderr: '' });
    expect(await settingsCmd('set', 'harness', 'maxConcurrentInstances', '4')).toMatchObject({ code: 0 });
    expect(await settingsCmd('set', 'harness', 'testDevices', '[{"platform":"android","serial":"e1"}]')).toMatchObject({ code: 0 });
    expect(read(localPath)).toEqual({ playInstances: 2, maxConcurrentInstances: 4, testDevices: [{ platform: 'android', serial: 'e1' }] });
    expect('playInstances' in read(path)).toBe(false);
    expect((await settingsCmd('get', 'harness', 'testDevices.0.serial')).stdout).toBe('"e1"\nsource: local harness settings\n');
    expect((await settingsCmd('set', 'harness', 'maxConcurrentInstances', '1')).stderr).toBe('maxConcurrentInstances: must be >= 2\n');
    expect(await settingsCmd('unset', 'harness', 'playInstances')).toMatchObject({ code: 0, stdout: 'unset playInstances\n' });
    expect((await settingsCmd('get', 'harness', 'playInstances')).stdout).toBe('3\nsource: schema default\n');
  });

  it('sets, reads and unsets imageMethod, with the schema default when it has none', async () => {
    expect((await settingsCmd('get', 'harness', 'imageMethod')).stdout).toBe('"flux2-klein"\nsource: schema default\n');
    expect((await loadHarnessSettings(ws.env)).imageMethod).toBe('flux2-klein');
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codex"')).toEqual({ code: 0, stdout: 'set imageMethod\n', stderr: '' });
    expect(read(localPath)).toEqual({ imageMethod: 'sprite-gen-codex' });
    expect((await loadHarnessSettings(ws.env)).imageMethod).toBe('sprite-gen-codex');
    expect(await settingsCmd('unset', 'harness', 'imageMethod')).toMatchObject({ code: 0, stdout: 'unset imageMethod\n' });
    expect((await settingsCmd('get', 'harness', 'imageMethod')).stdout).toBe('"flux2-klein"\nsource: schema default\n');
  });

  it('refuses an imageMethod that is not a resourceGeneration method whose resourceTypes has image', async () => {
    const before = readFileSync(path, 'utf8');
    const refused = (name: string): string => `imageMethod: ${name} is not the name of a resourceGeneration method whose resourceTypes has image\n`;
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codx"')).toEqual({ code: 1, stdout: '', stderr: refused('sprite-gen-codx') });
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"ace-step"')).toEqual({ code: 1, stdout: '', stderr: refused('ace-step') });
    expect(readFileSync(path, 'utf8')).toBe(before);
    const methods = (JSON.parse(before) as { resourceGeneration: { name: string }[] }).resourceGeneration;
    const without = (name: string): string => JSON.stringify(methods.filter((m) => m.name !== name));
    // without a value, the schema default flux2-klein stays
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('flux2-klein'))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'imageMethod (schema default): flux2-klein is not the name of a resourceGeneration method whose resourceTypes has image\n',
    });
    // removing the method that imageMethod names leaves it dangling
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codex"')).toMatchObject({ code: 0 });
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('sprite-gen-codex'))).toEqual({ code: 1, stdout: '', stderr: refused('sprite-gen-codex') });
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('flux2-klein'))).toMatchObject({ code: 0 });
  });

  it('gives commands the values of this host', async () => {
    const none = await loadHarnessSettings(ws.env);
    expect(none.maxConcurrentInstances).toBeNull();
    expect(none.playInstances).toBe(3);
    expect(none.reviewRunConcurrency).toBe(12);
    expect(none.webSmokeCpuThrottleRate).toBeNull();
    expect(none.testDevices).toBeUndefined();
    expect(none.resourceGeneration.every((m) => m.measured === undefined)).toBe(true);
    expect(() => concurrencyLimit(none)).toThrow('maxConcurrentInstances is null: run update env first');
    expect(typeRow('image', none.resourceGeneration, null).status).toBe('unmeasured');

    writeLocal({ maxConcurrentInstances: 5, playInstances: 2, reviewRunConcurrency: 4, webSmokeCpuThrottleRate: 9, testDevices: [{ platform: 'android', serial: 'mine' }], measured: { 'flux2-klein': [{ resolution: 512, jobMs: 7, result: 'ok' }] } });
    const mine = await loadHarnessSettings(ws.env);
    expect(mine.maxConcurrentInstances).toBe(5);
    expect(mine.playInstances).toBe(2);
    expect(mine.reviewRunConcurrency).toBe(4);
    expect(mine.webSmokeCpuThrottleRate).toBe(9);
    expect(mine.testDevices).toEqual([{ platform: 'android', serial: 'mine' }]);
    expect(mine.resourceGeneration.find((m) => m.name === 'flux2-klein')?.measured).toEqual([{ resolution: 512, jobMs: 7, result: 'ok' }]);
    expect(mine.resourceGeneration.find((m) => m.name === 'ace-step')?.measured).toBeUndefined();
    expect('measured' in mine).toBe(false);
    expect(concurrencyLimit(mine)).toBe(5);
    expect(typeRow('image', mine.resourceGeneration, null).status).toBe('ok');
  });
});

/** A settings.local.json as `update env` and the human left it on a host: values of this host in its host item, and the person's values. */
const REALISTIC_LOCAL = {
  humanLanguage: 'ko',
  hosts: {
    [TEST_HOST_ID]: {
      measured: {
        'flux2-klein': [
          { resolution: 512, jobMs: 19382, result: 'ok' },
          { resolution: 1024, jobMs: 23058, result: 'ok' },
        ],
        'rig-2d': [{ jobMs: 47, result: 'ok' }],
        procedural: [{ result: 'ok' }],
      },
      name: 'host-a.local',
      reviewRunConcurrency: 8,
      maxConcurrentInstances: 8,
      imageMethod: 'sprite-gen-codex',
    },
  },
  agents: { content: { effort: 'high' } },
  loop: {
    confirmJudge: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    confirmFallback: { cli: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
  },
};

/** The same file with the host values at the top level. */
const FLAT_LOCAL = {
  measured: REALISTIC_LOCAL.hosts[TEST_HOST_ID].measured,
  reviewRunConcurrency: 8,
  maxConcurrentInstances: 8,
  imageMethod: 'sprite-gen-codex',
  humanLanguage: 'ko',
  agents: REALISTIC_LOCAL.agents,
  loop: REALISTIC_LOCAL.loop,
};

describe('host items', () => {
  it('reads the host item of this host of a realistic settings.local.json as its top-level values, and the next write writes them there', async () => {
    patchShared({ hosts: {} });
    writeLocal(REALISTIC_LOCAL);
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.maxConcurrentInstances).toBe(8);
    expect(settings.reviewRunConcurrency).toBe(8);
    expect(settings.imageMethod).toBe('sprite-gen-codex');
    expect(settings.humanLanguage).toBe('ko');
    expect(settings.loop.confirmJudge).toEqual({ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(settings.resourceGeneration.find((m) => m.name === 'flux2-klein')?.measured).toEqual(FLAT_LOCAL.measured['flux2-klein']);
    expect('hosts' in settings).toBe(false);
    expect(await settingsCmd('get', 'harness', 'maxConcurrentInstances')).toEqual({ code: 0, stdout: '8\nsource: local harness settings\n', stderr: '' });
    expect((await settingsCmd('get', 'harness', 'measured.rig-2d')).stdout).toBe('[\n  {\n    "jobMs": 47,\n    "result": "ok"\n  }\n]\nsource: local harness settings\n');
    expect((await settingsCmd('get', 'harness', 'hosts')).code).toBe(1);
    // reading changes no file
    expect(read(localPath)).toEqual(REALISTIC_LOCAL);
    // a write that changes no value still writes both files without host items
    expect(await settingsCmd('set', 'harness', 'humanLanguage', '"ko"')).toMatchObject({ code: 0 });
    expect(read(localPath)).toEqual(FLAT_LOCAL);
    expect('hosts' in read(path)).toBe(false);
    const flat = await loadHarnessSettings(ws.env);
    expect(flat).toEqual(settings);
  });

  it('merges the host item of settings.local.json over that of settings.json, under the top-level values, and leaves the items of other hosts', async () => {
    patchShared({ hosts: { [TEST_HOST_ID]: { name: 'h', playInstances: 2, maxConcurrentInstances: 6, testDevices: [{ platform: 'android', serial: 's' }] }, [OTHER]: { name: 'o', maxConcurrentInstances: 16 } } });
    writeLocal({ hosts: { [TEST_HOST_ID]: { name: 'h', maxConcurrentInstances: 4 }, [OTHER]: { name: 'o', reviewRunConcurrency: 2 } }, playInstances: 1 });
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.maxConcurrentInstances).toBe(4);
    expect(settings.playInstances).toBe(1);
    expect(settings.testDevices).toEqual([{ platform: 'android', serial: 's' }]);
    expect(settings.reviewRunConcurrency).toBe(12);
    expect(await settingsCmd('set', 'harness', 'reviewRunConcurrency', '3')).toMatchObject({ code: 0 });
    expect(read(localPath)).toEqual({ maxConcurrentInstances: 4, playInstances: 1, testDevices: [{ platform: 'android', serial: 's' }], reviewRunConcurrency: 3 });
    expect('hosts' in read(path)).toBe(false);
  });

  it('reads the host id only when a file holds a host item', async () => {
    const env = { OGW_HOST_ID: 'unreadable' };
    const run = (...argv: string[]) => ogw(ws, ['settings', ...argv], { env });
    patchShared({ hosts: {} });
    expect(await run('get', 'harness', 'playInstances')).toEqual({ code: 0, stdout: '3\nsource: schema default\n', stderr: '' });
    expect(await run('set', 'harness', 'playInstances', '2')).toMatchObject({ code: 0, stdout: 'set playInstances\n' });
    expect((await loadHarnessSettings({ ...ws.env, ...env })).playInstances).toBe(2);
    patchShared({ hosts: { [OTHER]: { name: 'o', playInstances: 5 } } });
    expect(await run('get', 'harness', 'playInstances')).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot read the host id') as string });
    await expect(loadHarnessSettings({ ...ws.env, ...env })).rejects.toThrow('cannot read the host id');
    // the item of another host is not a value of this host
    expect((await loadHarnessSettings(ws.env)).playInstances).toBe(2);
  });
});

describe('local harness settings hold only local-scope paths', () => {
  it('fails reading harness settings while settings.local.json holds a criterion, and a write moves it to settings.json', async () => {
    writeLocal({ humanLanguage: 'ko', loop: { judgeVotes: 4, judgePanel: [] }, loopStop: { plateau: 9 } });
    await expect(loadHarnessSettings(ws.env)).rejects.toThrow(
      'settings.local.json holds loop.judgeVotes, loopStop.plateau, which are not local-scope paths: set the value that applies on every host with ogw settings set loop.judgeVotes <JSON value>, which moves the paths that are not local-scope to settings.json',
    );
    expect(await settingsCmd('set', 'harness', 'loop.judgeVotes', '2')).toEqual({ code: 0, stdout: 'set loop.judgeVotes\n', stderr: '' });
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', loop: { judgePanel: [] } });
    const shared = read(path) as { loop: { judgeVotes: number }; loopStop: { plateau: number } };
    expect(shared.loop.judgeVotes).toBe(2);
    expect(shared.loopStop.plateau).toBe(9);
    expect((await loadHarnessSettings(ws.env)).loopStop.plateau).toBe(9);
  });
});
