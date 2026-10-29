import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { concurrencyLimit } from '../../../src/commands/instance/lib/prepare.ts';
import { changedUnits, routeHarnessWrite } from '../../../src/commands/settings/lib/scope.ts';
import { loadHarnessSettings } from '../../../src/lib/settings.ts';
import { ogw, makeWorkspace, TEST_HOST_ID, type TestWorkspace } from '../../helpers/workspace.ts';

const OTHER = 'f'.repeat(32);
const OTHER_ENTRY = { name: 'other', maxConcurrentInstances: 8 };
const MINE = { name: 'old-name', maxConcurrentInstances: 4, measured: { 'flux2-klein': [{ resolution: 512, jobMs: 7, result: 'ok' }] } };
const OPUS = { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };

let ws: TestWorkspace;
let sharedPath: string;
let localPath: string;

beforeEach(() => {
  ws = makeWorkspace();
  sharedPath = join(ws.harness, 'settings.json');
  localPath = join(ws.harness, 'settings.local.json');
});

const settingsCmd = (...argv: string[]) => ogw(ws, ['settings', ...argv]);

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeLocal(value: Record<string, unknown>): void {
  writeFileSync(localPath, JSON.stringify(value));
}

function patchShared(patch: Record<string, unknown>): void {
  writeFileSync(sharedPath, JSON.stringify({ ...read(sharedPath), ...patch }));
}

describe('local harness settings', () => {
  it('merges settings.local.json over settings.json: objects by key, arrays and values whole', async () => {
    const judge = { cli: 'codex', model: 'gpt', effort: 'high' };
    writeLocal({ humanLanguage: 'ko', agents: { content: { model: 'claude-sonnet-5-5', effort: 'medium' } }, loop: { judgePanel: [judge] } });
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.humanLanguage).toBe('ko');
    expect(settings.agents.content).toEqual({ cli: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(settings.agents.judge).toEqual(OPUS);
    expect(settings.loop).toEqual({ funIterations: 3, judgeVotes: 2, judgePanel: [judge], variants: 1, playTimeLimitMs: 2_700_000, judgeTimeLimitMs: 3_600_000 });
    expect(settings.jobWaitTimeoutMs).toBe(read(sharedPath).jobWaitTimeoutMs);
  });

  it('works without settings.local.json and with an empty hosts', async () => {
    patchShared({ hosts: {} });
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.humanLanguage).toBe('en');
    expect(settings.playInstances).toBe(3);
    expect(settings.maxConcurrentInstances).toBeNull();
    expect(() => concurrencyLimit(settings)).toThrow('maxConcurrentInstances is null: run update env first');
    expect(await settingsCmd('get', 'harness', 'humanLanguage')).toEqual({ code: 0, stdout: '"en"\n', stderr: '' });
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '5000')).toMatchObject({ code: 0 });
    expect(existsSync(localPath)).toBe(false);
  });

  it('writes a local-scope path to settings.local.json and every other path to settings.json', async () => {
    const shared = readFileSync(sharedPath, 'utf8');
    const judge = { model: 'claude-sonnet-5-5', effort: 'medium' };
    expect(
      await settingsCmd('set', 'harness', 'humanLanguage', '"ko"', 'agents.play.model', '"claude-haiku-5-5"', 'loop.judgePanel', JSON.stringify([judge]), 'useLocalCore', 'true'),
    ).toMatchObject({ code: 0 });
    expect(readFileSync(sharedPath, 'utf8')).toBe(shared);
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', agents: { play: { model: 'claude-haiku-5-5' } }, loop: { judgePanel: [judge] }, useLocalCore: true });

    expect(await settingsCmd('set', 'harness', 'loop.funIterations', '4', 'jobWaitTimeoutMs', '5000')).toMatchObject({ code: 0 });
    expect(read(sharedPath)).toMatchObject({ loop: { funIterations: 3, judgePanel: [] }, jobWaitTimeoutMs: 5000 });
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', agents: { play: { model: 'claude-haiku-5-5' } }, loop: { judgePanel: [judge], funIterations: 4 }, useLocalCore: true });

    const settings = await loadHarnessSettings(ws.env);
    expect(settings.loop).toEqual({ funIterations: 4, judgeVotes: 2, judgePanel: [judge], variants: 1, playTimeLimitMs: 2_700_000, judgeTimeLimitMs: 3_600_000 });
    expect(settings.agents.play).toEqual({ cli: 'claude-code', model: 'claude-haiku-5-5', effort: 'medium' });
  });

  it('writes a path that settings.local.json already holds to settings.local.json', async () => {
    const shared = readFileSync(sharedPath, 'utf8');
    writeLocal({ jobWaitTimeoutMs: 1000 });
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '2000')).toMatchObject({ code: 0 });
    expect(read(localPath)).toEqual({ jobWaitTimeoutMs: 2000 });
    expect(readFileSync(sharedPath, 'utf8')).toBe(shared);
  });

  it('checks the merged result and writes no file when it does not pass', async () => {
    const shared = readFileSync(sharedPath, 'utf8');
    expect(await settingsCmd('set', 'harness', 'humanLanguage', '"k"')).toEqual({ code: 1, stdout: '', stderr: 'humanLanguage: must NOT have fewer than 2 characters\n' });
    expect(existsSync(localPath)).toBe(false);
    writeLocal({ nope: 1 });
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '5000')).toMatchObject({ code: 1, stderr: '(root): must NOT have additional properties (nope)\n' });
    expect(readFileSync(sharedPath, 'utf8')).toBe(shared);
    expect(read(localPath)).toEqual({ nope: 1 });
  });

  it('keeps reading a local-scope value that settings.json still holds, under the local value', async () => {
    patchShared({ humanLanguage: 'ja' });
    expect((await loadHarnessSettings(ws.env)).humanLanguage).toBe('ja');
    expect(await settingsCmd('get', 'harness', 'humanLanguage')).toEqual({ code: 0, stdout: '"ja"\n', stderr: '' });
    expect(await settingsCmd('set', 'harness', 'humanLanguage', '"ko"')).toMatchObject({ code: 0 });
    expect(read(sharedPath).humanLanguage).toBe('ja');
    expect((await loadHarnessSettings(ws.env)).humanLanguage).toBe('ko');
    expect(await settingsCmd('get', 'harness', 'humanLanguage')).toEqual({ code: 0, stdout: '"ko"\nsource: local harness settings\n', stderr: '' });
    // a removed value is removed from both files
    expect(await settingsCmd('set', 'harness', 'agents.content.cli', '"codex"')).toMatchObject({ code: 0 });
    expect(await settingsCmd('unset', 'harness', 'agents.content.cli')).toMatchObject({ code: 0 });
    expect(read(sharedPath).agents).toMatchObject({ content: { model: OPUS.model, effort: OPUS.effort } });
    expect('cli' in (read(sharedPath).agents as { content: object }).content).toBe(false);
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', agents: { content: {} } });
    expect(await settingsCmd('get', 'harness', 'agents.content.cli')).toMatchObject({ stdout: '"claude-code"\nsource: schema default\n' });
  });

  it('gives where a value comes from', async () => {
    writeLocal({ agents: { content: { model: 'claude-sonnet-5-5' } } });
    const source = async (path: string): Promise<unknown> => (JSON.parse((await settingsCmd('get', 'harness', path, '--json')).stdout) as { source: unknown }).source;
    expect(await source('agents.content.model')).toBe('local harness settings');
    expect(await source('agents.content')).toBe('local harness settings over harness settings');
    expect(await source('agents.content.effort')).toBe('harness settings');
    expect(await source('minCoreVersion')).toBe('harness settings');
    patchShared({ minCoreVersion: undefined });
    expect(await source('minCoreVersion')).toBe('schema default');
  });

  it('moves this host entry from settings.json to settings.local.json when it writes that entry, and leaves another host entry', async () => {
    const mine = { ...MINE, name: hostname() };
    patchShared({ hosts: { [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: mine } });
    // reading, and a write that does not change this host entry, do not move it
    expect(await settingsCmd('get', 'harness', 'maxConcurrentInstances')).toEqual({ code: 0, stdout: '4\n', stderr: '' });
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '5000')).toMatchObject({ code: 0 });
    expect(existsSync(localPath)).toBe(false);
    expect(read(sharedPath).hosts).toEqual({ [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: mine });
    // a write of the host name is a write of this host entry
    patchShared({ hosts: { [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: MINE } });

    expect(await settingsCmd('set', 'harness', 'playInstances', '2')).toEqual({ code: 0, stdout: `set hosts.${TEST_HOST_ID}.playInstances\n`, stderr: '' });
    expect(read(sharedPath).hosts).toEqual({ [OTHER]: OTHER_ENTRY });
    expect(read(localPath)).toEqual({ hosts: { [TEST_HOST_ID]: { ...MINE, name: hostname(), playInstances: 2 } } });
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.maxConcurrentInstances).toBe(4);
    expect(settings.playInstances).toBe(2);
    expect(settings.resourceGeneration.find((m) => m.name === 'flux2-klein')?.measured).toEqual(MINE.measured['flux2-klein']);
    expect((await loadHarnessSettings({ ...ws.env, OGW_HOST_ID: OTHER })).maxConcurrentInstances).toBe(8);
  });

  it('keeps instanceMeasureLimit per host in settings.local.json, with the schema default 8 and no value below 2', async () => {
    expect(await settingsCmd('get', 'harness', 'instanceMeasureLimit')).toMatchObject({ code: 0, stdout: expect.stringContaining('8\n') as unknown });
    expect((await loadHarnessSettings(ws.env)).instanceMeasureLimit).toBe(8);
    expect((await settingsCmd('set', 'harness', 'instanceMeasureLimit', '1')).code).not.toBe(0);
    expect(await settingsCmd('set', 'harness', 'instanceMeasureLimit', '12')).toEqual({ code: 0, stdout: `set hosts.${TEST_HOST_ID}.instanceMeasureLimit\n`, stderr: '' });
    expect((read(localPath) as { hosts: Record<string, { instanceMeasureLimit?: number }> }).hosts[TEST_HOST_ID]?.instanceMeasureLimit).toBe(12);
    expect((await loadHarnessSettings(ws.env)).instanceMeasureLimit).toBe(12);
    expect((await loadHarnessSettings({ ...ws.env, OGW_HOST_ID: OTHER })).instanceMeasureLimit).toBe(8);
  });

  it('marks local-scope paths in describe and list', async () => {
    expect((await settingsCmd('describe', 'harness', 'humanLanguage')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'maxConcurrentInstances')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'loop.judgePanel.0.model')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'loop.funIterations')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'jobWaitTimeoutMs')).stdout).not.toContain('x-scope');
    const rows = (JSON.parse((await settingsCmd('list', 'harness', '--json')).stdout) as { paths: { path: string; xScope: string | null }[] }).paths;
    const local = rows.filter((r) => r.xScope === 'local').map((r) => r.path);
    expect(local).toEqual(expect.arrayContaining(['humanLanguage', 'agents', 'agents.content.model', 'hosts', 'useLocalCore', 'loop.judgePanel', 'maxConcurrentInstances', 'measured']));
    expect(local).toEqual(expect.arrayContaining(['loop', 'loop.funIterations', 'loopStop']));
    expect(local).not.toContain('jobWaitTimeoutMs');
  });
});

describe('routeHarnessWrite', () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'schemas', 'harness-settings.schema.json'), 'utf8')) as Record<string, unknown>;

  it('splits changes into units the merge replaces whole', () => {
    expect(changedUnits({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1, 2] }, d: { e: 1 } })).toEqual([['a', 'b'], ['a', 'c'], ['d', 'e']]);
    expect(changedUnits({ a: { b: 1 } }, {})).toEqual([['a']]);
    expect(changedUnits({}, { a: {} })).toEqual([['a']]);
  });

  it('routes each unit and moves only this host entry', () => {
    const files = { shared: { jobWaitTimeoutMs: 1, loop: { funIterations: 3, judgePanel: [] }, hosts: { [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: MINE } }, local: null };
    const next = { jobWaitTimeoutMs: 2, loop: { funIterations: 3, judgePanel: [OPUS] }, hosts: { [OTHER]: OTHER_ENTRY, [TEST_HOST_ID]: { ...MINE, playInstances: 2 } } };
    expect(routeHarnessWrite(schema, files, TEST_HOST_ID, next)).toEqual({
      shared: { jobWaitTimeoutMs: 2, loop: { funIterations: 3, judgePanel: [] }, hosts: { [OTHER]: OTHER_ENTRY } },
      local: { loop: { judgePanel: [OPUS] }, hosts: { [TEST_HOST_ID]: { ...MINE, playInstances: 2 } } },
    });
    // a write that does not change this host entry leaves it in settings.json
    expect(routeHarnessWrite(schema, files, TEST_HOST_ID, { ...files.shared, jobWaitTimeoutMs: 2 })).toEqual({ shared: { ...files.shared, jobWaitTimeoutMs: 2 }, local: null });
  });
});
