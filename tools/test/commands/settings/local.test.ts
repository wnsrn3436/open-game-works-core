import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { concurrencyLimit } from '../../../src/commands/instance/lib/prepare.ts';
import { changedUnits, routeHarnessWrite } from '../../../src/commands/settings/lib/scope.ts';
import { loadHarnessSettings } from '../../../src/lib/settings.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

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
    expect(settings.loop).toEqual({ funIterations: 3, judgeVotes: 2, judgePanel: [judge], variants: 1, playTimeLimitMs: 2_700_000, playBudgetMs: 900_000, judgeInstanceBudgetMs: 240000, judgeTimeLimitMs: 3_600_000 });
    expect(settings.jobWaitTimeoutMs).toBe(read(sharedPath).jobWaitTimeoutMs);
  });

  it('works without settings.local.json', async () => {
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
    expect(settings.loop).toEqual({ funIterations: 4, judgeVotes: 2, judgePanel: [judge], variants: 1, playTimeLimitMs: 2_700_000, playBudgetMs: 900_000, judgeInstanceBudgetMs: 240000, judgeTimeLimitMs: 3_600_000 });
    expect(settings.agents.play).toEqual({ cli: 'claude-code', model: 'claude-haiku-5-5', effort: 'medium' });
  });

  it('writes a path that is not local-scope to settings.json also when settings.local.json holds it, and moves it out of there', async () => {
    writeLocal({ jobWaitTimeoutMs: 1000, humanLanguage: 'ko' });
    await expect(loadHarnessSettings(ws.env)).rejects.toThrow('settings.local.json holds jobWaitTimeoutMs, which is not a local-scope path');
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '2000')).toMatchObject({ code: 0 });
    expect(read(localPath)).toEqual({ humanLanguage: 'ko' });
    expect(read(sharedPath).jobWaitTimeoutMs).toBe(2000);
    expect((await loadHarnessSettings(ws.env)).jobWaitTimeoutMs).toBe(2000);
  });

  it('names the unset of each path of settings.local.json that no schema node reaches, which removes it from both files without the checks of the rest', async () => {
    const shared = read(sharedPath);
    writeLocal({ humanLanguage: 'ko', retiredLimit: 3, loop: { retiredJudge: OPUS, judgePanel: [] }, jobWaitTimeoutMs: 1000 });
    patchShared({ retiredLimit: 2 });
    const moveLine =
      'settings.local.json holds jobWaitTimeoutMs, which is not a local-scope path: set the value that applies on every host with ogw settings set harness jobWaitTimeoutMs <JSON value>, which moves the paths that are not local-scope to settings.json';
    await expect(loadHarnessSettings(ws.env)).rejects.toMatchObject({
      message: `settings.local.json holds retiredLimit, loop.retiredJudge, which no node of the harness settings schema reaches: remove each with ogw settings unset harness retiredLimit, ogw settings unset harness loop.retiredJudge\n${moveLine}`,
    });
    // the schema check of the merged value refuses a set while such a path is there
    expect((await settingsCmd('set', 'harness', 'loop.retiredJudge', 'null')).code).toBe(1);
    // each unset works while the other path that the schema does not allow is still there
    expect(await settingsCmd('unset', 'harness', 'retiredLimit')).toEqual({ code: 0, stdout: 'unset retiredLimit\n', stderr: '' });
    expect(read(sharedPath)).toEqual(shared);
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', loop: { retiredJudge: OPUS, judgePanel: [] }, jobWaitTimeoutMs: 1000 });
    await expect(loadHarnessSettings(ws.env)).rejects.toMatchObject({
      message: `settings.local.json holds loop.retiredJudge, which no node of the harness settings schema reaches: remove it with ogw settings unset harness loop.retiredJudge\n${moveLine}`,
    });
    expect(await settingsCmd('unset', 'harness', 'loop.retiredJudge')).toEqual({ code: 0, stdout: 'unset loop.retiredJudge\n', stderr: '' });
    expect(await settingsCmd('unset', 'harness', 'loop.retiredJudge')).toEqual({ code: 0, stdout: 'loop.retiredJudge is not set\n', stderr: '' });
    expect(read(localPath)).toEqual({ humanLanguage: 'ko', loop: { judgePanel: [] }, jobWaitTimeoutMs: 1000 });
    // a path that the schema has keeps the message that names the move to settings.json
    await expect(loadHarnessSettings(ws.env)).rejects.toMatchObject({ message: moveLine });
    expect(await settingsCmd('set', 'harness', 'jobWaitTimeoutMs', '2000')).toMatchObject({ code: 0 });
    const settings = await loadHarnessSettings(ws.env);
    expect(settings.humanLanguage).toBe('ko');
    expect(settings.jobWaitTimeoutMs).toBe(2000);
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
    expect(read(localPath)).toEqual({ humanLanguage: 'ko' });
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

  it('keeps instanceMeasureLimit in settings.local.json, with the schema default 8 and no value below 2', async () => {
    expect(await settingsCmd('get', 'harness', 'instanceMeasureLimit')).toMatchObject({ code: 0, stdout: expect.stringContaining('8\n') as unknown });
    expect((await loadHarnessSettings(ws.env)).instanceMeasureLimit).toBe(8);
    expect((await settingsCmd('set', 'harness', 'instanceMeasureLimit', '1')).code).not.toBe(0);
    expect(await settingsCmd('set', 'harness', 'instanceMeasureLimit', '12')).toEqual({ code: 0, stdout: 'set instanceMeasureLimit\n', stderr: '' });
    expect(read(localPath)).toEqual({ instanceMeasureLimit: 12 });
    expect((await loadHarnessSettings(ws.env)).instanceMeasureLimit).toBe(12);
  });

  it('marks local-scope paths and run paths in describe and list', async () => {
    expect((await settingsCmd('describe', 'harness', 'humanLanguage')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'maxConcurrentInstances')).stdout).toContain('x-scope: local\n');
    expect((await settingsCmd('describe', 'harness', 'loop.judgePanel.0.model')).stdout).toContain('x-scope: local\nx-run: true\n');
    expect((await settingsCmd('describe', 'harness', 'loop.funIterations')).stdout).toContain('x-scope: local\nx-run: true\n');
    expect((await settingsCmd('describe', 'harness', 'jobWaitTimeoutMs')).stdout).not.toContain('x-scope');
    expect((await settingsCmd('describe', 'harness', 'loop.judgeVotes')).stdout).not.toContain('x-scope');
    const rows = (JSON.parse((await settingsCmd('list', 'harness', '--json')).stdout) as { paths: { path: string; xScope: string | null; xRun: true | null }[] }).paths;
    const local = rows.filter((r) => r.xScope === 'local').map((r) => r.path);
    expect(local).toEqual(expect.arrayContaining(['humanLanguage', 'agents', 'agents.content.model', 'useLocalCore', 'loop.judgePanel', 'maxConcurrentInstances', 'measured', 'webSmokeCpuThrottleRate']));
    expect(local).toEqual(expect.arrayContaining(['loop.funIterations', 'loop.variants', 'loop.playTimeLimitMs', 'loop.judgeTimeLimitMs']));
    // the criteria of the loop and of web smoke apply on every host
    for (const path of ['jobWaitTimeoutMs', 'loop', 'loop.judgeVotes', 'loop.playBudgetMs', 'loop.judgeInstanceBudgetMs', 'loopStop', 'loopStop.successJudges', 'webSmokeDeviceBenchmarkIndex', 'webSmokeBootTimeoutMs', 'hosts']) {
      expect(local).not.toContain(path);
    }
    const run = rows.filter((r) => r.xRun === true).map((r) => r.path);
    expect(run).toEqual(expect.arrayContaining(['agents', 'agents.content.model', 'playInstances', 'imageMethod', 'measured', 'loop.funIterations', 'loop.judgePanel', 'loop.variants', 'loop.playTimeLimitMs', 'loop.judgeTimeLimitMs']));
    for (const path of ['humanLanguage', 'useLocalCore', 'maxConcurrentInstances', 'instanceMeasureLimit', 'reviewRunConcurrency', 'testDevices', 'webSmokeCpuThrottleRate', 'loop.judgeVotes']) expect(run).not.toContain(path);
    // a run path is a local-scope path
    expect(run.filter((path) => !local.includes(path))).toEqual([]);
  });
});

describe('routeHarnessWrite', () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'schemas', 'harness-settings.schema.json'), 'utf8')) as Record<string, unknown>;

  it('splits changes into units the merge replaces whole', () => {
    expect(changedUnits({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1, 2] }, d: { e: 1 } })).toEqual([['a', 'b'], ['a', 'c'], ['d', 'e']]);
    expect(changedUnits({ a: { b: 1 } }, {})).toEqual([['a']]);
    expect(changedUnits({}, { a: {} })).toEqual([['a']]);
  });

  it('routes each unit by its scope and moves the units of settings.local.json that are not local-scope', () => {
    const files = { shared: { jobWaitTimeoutMs: 1, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [] } }, local: null };
    const next = { jobWaitTimeoutMs: 2, playInstances: 2, loop: { funIterations: 3, judgeVotes: 4, judgePanel: [OPUS] } };
    expect(routeHarnessWrite(schema, files, next)).toEqual({
      shared: { jobWaitTimeoutMs: 2, loop: { funIterations: 3, judgeVotes: 4, judgePanel: [] } },
      local: { playInstances: 2, loop: { judgePanel: [OPUS] } },
    });
    // a unit that settings.local.json holds and that is not local-scope moves to settings.json, also when the write does not change it
    const held = { shared: files.shared, local: { humanLanguage: 'ko', loop: { judgeVotes: 6 } } };
    expect(routeHarnessWrite(schema, held, { ...files.shared, jobWaitTimeoutMs: 2, humanLanguage: 'ko', loop: { ...files.shared.loop, judgeVotes: 6 } })).toEqual({
      shared: { jobWaitTimeoutMs: 2, loop: { funIterations: 3, judgeVotes: 6, judgePanel: [] } },
      local: { humanLanguage: 'ko' },
    });
  });
});
