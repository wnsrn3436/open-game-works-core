import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { concurrencyLimit } from '../../../src/commands/instance/lib/prepare.ts';
import { typeRow } from '../../../src/commands/generation/check.ts';
import { loadHarnessSettings } from '../../../src/lib/settings.ts';
import { ogw, makeWorkspace, TEST_HOST_ID, type TestWorkspace } from '../../helpers/workspace.ts';

const OTHER = 'f'.repeat(32);
const OTHER_ENTRY = { name: 'other', maxConcurrentInstances: 8, playInstances: 2, testDevices: [{ platform: 'android', serial: 'o1' }], measured: { 'flux2-klein': [{ resolution: 2048, result: 'ok' }] } };

let ws: TestWorkspace;
let path: string;

beforeEach(() => {
  ws = makeWorkspace({ hosts: { [OTHER]: OTHER_ENTRY } });
  path = join(ws.harness, 'settings.json');
});

const settingsCmd = (...argv: string[]) => ogw(ws, ['settings', ...argv]);

function hosts(): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { hosts: Record<string, unknown> }).hosts;
}

function writeHosts(value: Record<string, unknown>): void {
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...file, hosts: value }));
}

describe('harness settings host values', () => {
  it('reads the host keys of this host only: no entry is not measured', async () => {
    expect(await settingsCmd('get', 'harness', 'maxConcurrentInstances')).toEqual({ code: 1, stdout: '', stderr: `no value: hosts.${TEST_HOST_ID}.maxConcurrentInstances\n` });
    expect((await settingsCmd('get', 'harness', 'playInstances')).stdout).toBe('3\nsource: schema default\n');
    expect((await settingsCmd('get', 'harness', 'measured.flux2-klein')).code).toBe(1);
    expect((await settingsCmd('get', 'harness', `hosts.${OTHER}.maxConcurrentInstances`)).stdout).toBe('8\n');
  });

  it('sets and unsets a host key in this host entry with its name and leaves another host entry', async () => {
    expect(await settingsCmd('set', 'harness', 'playInstances', '2')).toEqual({ code: 0, stdout: `set hosts.${TEST_HOST_ID}.playInstances\n`, stderr: '' });
    expect(await settingsCmd('set', 'harness', 'maxConcurrentInstances', '4')).toMatchObject({ code: 0 });
    expect(await settingsCmd('set', 'harness', 'testDevices', '[{"platform":"android","serial":"e1"}]')).toMatchObject({ code: 0 });
    expect(hosts()).toEqual({
      [OTHER]: OTHER_ENTRY,
      [TEST_HOST_ID]: { name: hostname(), playInstances: 2, maxConcurrentInstances: 4, testDevices: [{ platform: 'android', serial: 'e1' }] },
    });
    expect((await settingsCmd('get', 'harness', 'playInstances')).stdout).toBe('2\n');
    expect((await settingsCmd('get', 'harness', 'testDevices.0.serial')).stdout).toBe('"e1"\n');
    expect((await settingsCmd('set', 'harness', 'maxConcurrentInstances', '1')).stderr).toBe(`hosts.${TEST_HOST_ID}.maxConcurrentInstances: must be >= 2\n`);
    expect(await settingsCmd('unset', 'harness', 'playInstances')).toMatchObject({ code: 0, stdout: `unset hosts.${TEST_HOST_ID}.playInstances\n` });
    expect((await settingsCmd('get', 'harness', 'playInstances')).stdout).toBe('3\nsource: schema default\n');
    expect(hosts()[OTHER]).toEqual(OTHER_ENTRY);
  });

  it('sets, reads and unsets imageMethod in this host entry, with the schema default when it has none', async () => {
    expect((await settingsCmd('get', 'harness', 'imageMethod')).stdout).toBe('"flux2-klein"\nsource: schema default\n');
    expect((await loadHarnessSettings(ws.env)).imageMethod).toBe('flux2-klein');
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codex"')).toEqual({ code: 0, stdout: `set hosts.${TEST_HOST_ID}.imageMethod\n`, stderr: '' });
    expect(hosts()).toEqual({ [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: { name: hostname(), imageMethod: 'sprite-gen-codex' } });
    expect((await settingsCmd('get', 'harness', 'imageMethod')).stdout).toBe('"sprite-gen-codex"\n');
    expect((await loadHarnessSettings(ws.env)).imageMethod).toBe('sprite-gen-codex');
    expect((await loadHarnessSettings({ ...ws.env, OGW_HOST_ID: OTHER })).imageMethod).toBe('flux2-klein');
    expect(await settingsCmd('unset', 'harness', 'imageMethod')).toMatchObject({ code: 0, stdout: `unset hosts.${TEST_HOST_ID}.imageMethod\n` });
    expect((await settingsCmd('get', 'harness', 'imageMethod')).stdout).toBe('"flux2-klein"\nsource: schema default\n');
    expect(hosts()[OTHER]).toEqual(OTHER_ENTRY);
  });

  it('refuses an imageMethod that is not a resourceGeneration method whose resourceTypes has image', async () => {
    const before = readFileSync(path, 'utf8');
    const refused = (name: string): string => `hosts.${TEST_HOST_ID}.imageMethod: ${name} is not the name of a resourceGeneration method whose resourceTypes has image\n`;
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codx"')).toEqual({ code: 1, stdout: '', stderr: refused('sprite-gen-codx') });
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"ace-step"')).toEqual({ code: 1, stdout: '', stderr: refused('ace-step') });
    expect(readFileSync(path, 'utf8')).toBe(before);
    // removing the method that imageMethod names leaves it dangling
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codex"')).toMatchObject({ code: 0 });
    const methods = (JSON.parse(readFileSync(path, 'utf8')) as { resourceGeneration: { name: string }[] }).resourceGeneration;
    const without = (name: string): string => JSON.stringify(methods.filter((m) => m.name !== name));
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('sprite-gen-codex'))).toEqual({ code: 1, stdout: '', stderr: refused('sprite-gen-codex') });
    const byDefault = (id: string): string => `hosts.${id}.imageMethod (schema default): flux2-klein is not the name of a resourceGeneration method whose resourceTypes has image\n`;
    // another entry without a value takes the schema default, so flux2-klein stays
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('flux2-klein'))).toEqual({ code: 1, stdout: '', stderr: byDefault(OTHER) });
    // and so does this host without an entry
    writeHosts({ [OTHER]: { ...OTHER_ENTRY, imageMethod: 'sprite-gen-grok' } });
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('flux2-klein'))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'imageMethod (schema default): flux2-klein is not the name of a resourceGeneration method whose resourceTypes has image\n',
    });
    expect(await settingsCmd('set', 'harness', 'imageMethod', '"sprite-gen-codex"')).toMatchObject({ code: 0 });
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without('flux2-klein'))).toMatchObject({ code: 0 });
  });

  it('refuses removing the schema default imageMethod while hosts is empty', async () => {
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), hosts: {} }));
    const before = readFileSync(path, 'utf8');
    const methods = (JSON.parse(before) as { resourceGeneration: { name: string }[] }).resourceGeneration;
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', JSON.stringify(methods.filter((m) => m.name !== 'flux2-klein')))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'imageMethod (schema default): flux2-klein is not the name of a resourceGeneration method whose resourceTypes has image\n',
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses removing the method that another host entry names as its imageMethod', async () => {
    writeHosts({ [OTHER]: { ...OTHER_ENTRY, imageMethod: 'sprite-gen-codex' } });
    const before = readFileSync(path, 'utf8');
    const methods = (JSON.parse(before) as { resourceGeneration: { name: string }[] }).resourceGeneration;
    const without = JSON.stringify(methods.filter((m) => m.name !== 'sprite-gen-codex'));
    expect(await settingsCmd('set', 'harness', 'resourceGeneration', without)).toEqual({
      code: 1,
      stdout: '',
      stderr: `hosts.${OTHER}.imageMethod: sprite-gen-codex is not the name of a resourceGeneration method whose resourceTypes has image\n`,
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(await settingsCmd('set', 'harness', `hosts.${OTHER}.imageMethod`, '"sprite-gen-codx"')).toMatchObject({ code: 1, stderr: `hosts.${OTHER}.imageMethod: sprite-gen-codx is not the name of a resourceGeneration method whose resourceTypes has image\n` });
  });

  it('gives commands the values of this host', async () => {
    const none = await loadHarnessSettings(ws.env);
    expect(none.maxConcurrentInstances).toBeNull();
    expect(none.playInstances).toBe(3);
    expect(none.reviewRunConcurrency).toBe(12);
    expect(none.testDevices).toBeUndefined();
    expect(none.resourceGeneration.every((m) => m.measured === undefined)).toBe(true);
    expect(() => concurrencyLimit(none)).toThrow('maxConcurrentInstances is null: run update env first');
    expect(typeRow('image', none.resourceGeneration, null).status).toBe('unmeasured');

    writeHosts({ [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: { name: 'h', maxConcurrentInstances: 5, playInstances: 2, reviewRunConcurrency: 4, testDevices: [{ platform: 'android', serial: 'mine' }], measured: { 'flux2-klein': [{ resolution: 512, jobMs: 7, result: 'ok' }] } } });
    const mine = await loadHarnessSettings(ws.env);
    expect(mine.maxConcurrentInstances).toBe(5);
    expect(mine.playInstances).toBe(2);
    expect(mine.reviewRunConcurrency).toBe(4);
    expect(mine.testDevices).toEqual([{ platform: 'android', serial: 'mine' }]);
    expect(mine.resourceGeneration.find((m) => m.name === 'flux2-klein')?.measured).toEqual([{ resolution: 512, jobMs: 7, result: 'ok' }]);
    expect(mine.resourceGeneration.find((m) => m.name === 'ace-step')?.measured).toBeUndefined();
    expect('hosts' in mine).toBe(false);
    expect(concurrencyLimit(mine)).toBe(5);
    expect(typeRow('image', mine.resourceGeneration, null).status).toBe('ok');
  });

  it('reads no host id while hosts is empty: the host keys are the schema default or have no value', async () => {
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), hosts: {} }));
    // a host id that cannot be read: a command that reads it fails
    const env = { OGW_HOST_ID: 'unreadable' };
    const run = (...argv: string[]) => ogw(ws, ['settings', ...argv], { env });
    expect(await run('get', 'harness', 'playInstances')).toEqual({ code: 0, stdout: '3\nsource: schema default\n', stderr: '' });
    expect(await run('get', 'harness', 'maxConcurrentInstances')).toEqual({ code: 1, stdout: '', stderr: 'no value: maxConcurrentInstances\n' });
    expect(await run('get', 'harness', 'testDevices.0.serial')).toMatchObject({ code: 1, stderr: 'no value: testDevices.0.serial\n' });
    expect(await run('get', 'harness', 'measured.flux2-klein')).toMatchObject({ code: 1, stderr: 'no value: measured.flux2-klein\n' });
    expect((await run('describe', 'harness', 'playInstances')).stdout).toContain('default: 3\n');
    expect((await run('list', 'harness', '--owner', 'tool')).stdout).toMatch(/^measured\b/mu);
    expect(await run('unset', 'harness', 'playInstances')).toEqual({ code: 0, stdout: 'playInstances is not set\n', stderr: '' });
    expect((await loadHarnessSettings({ ...ws.env, ...env })).playInstances).toBe(3);
    expect(await run('set', 'harness', 'playInstances', '2')).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot read the host id') as string });
    expect(await settingsCmd('set', 'harness', 'playInstances', '2')).toMatchObject({ code: 0, stdout: `set hosts.${TEST_HOST_ID}.playInstances\n` });
    expect(await run('get', 'harness', 'playInstances')).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot read the host id') as string });
  });

  it('reads another host entry as this host only with its id', async () => {
    const settings = await loadHarnessSettings({ ...ws.env, OGW_HOST_ID: OTHER });
    expect(settings.maxConcurrentInstances).toBe(8);
    expect(settings.testDevices).toEqual([{ platform: 'android', serial: 'o1' }]);
    expect(settings.resourceGeneration.find((m) => m.name === 'flux2-klein')?.measured).toEqual([{ resolution: 2048, result: 'ok' }]);
  });
});
