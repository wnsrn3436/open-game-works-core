import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../../src/commands/check/api.ts';
import { catchOf, cleanFor, findingKey, keysOf, matches, type RegressCheckFile } from '../../../src/commands/regress/lib/keys.ts';
import { parseManifest, type SeedManifest } from '../../../src/commands/regress/lib/repo.ts';

function item(name: string, result: CheckResult['result'], failures: [string, string][] = [], platform: string | null = null): CheckResult {
  return { name, platform, result, failures: failures.map(([where, message]) => ({ where, message, evidence: [] })), warnings: [] };
}

function file(...checks: CheckResult[]): RegressCheckFile {
  return { commit: 'c', checks, fixTestProof: [] };
}

function seed(fields: Record<string, unknown> = {}): SeedManifest {
  const { manifest, problems } = parseManifest({
    state: 's',
    class: 'K1',
    element: 'no blocker',
    expect: 'caught',
    match: [{ check: 'no blocker', where: '^step \\d+$', message: '^client main error log: .*leak' }],
    fixer: 'content',
    row: { id: 'leak', severity: 'blocker', owner: 'client content', why: 'w', source: 'check' },
    ...fields,
  });
  expect(problems).toEqual([]);
  return manifest;
}

const LEAK: [string, string] = ['step 2', 'client main error log: 17932 error ResourceCore leak: icon/flame'];

describe('finding keys', () => {
  it('drop the line and column of where and the digits of the message, and keep the check and platform apart', () => {
    expect(findingKey(item('static check', 'fail'), { where: 'client/a.gd:12:4', message: 'system clock call 3 times', evidence: [] })).toBe('static check|-|client/a.gd|system clock call # times');
    expect(findingKey(item('performance', 'fail', [], 'web'), { where: 'scene/crypt', message: 'fps 41 below 54', evidence: [] })).toBe('performance|web|scene/crypt|fps # below #');
    // the same failure on another line or with other numbers is the same key
    expect(findingKey(item('static check', 'fail'), { where: 'client/a.gd:99', message: 'system clock call 7 times', evidence: [] })).toBe('static check|-|client/a.gd|system clock call # times');
  });

  it('take the id of ogw loop findings for a UI quality failure that names its kind and prefab', () => {
    const message = 'overlap A/Title A/Gold in prefab/lobby/lobby_panel (ko, macbook_air_13, lobby.open_lobby, text scale 1000)';
    expect(findingKey(item('UI quality', 'fail', [], 'android'), { where: 'scene/lobby/lobby', message, evidence: [] })).toBe('UI quality|android|overlap-prefab-lobby-lobby-panel');
  });

  it('come only from the failures of fail items', () => {
    expect([...keysOf(file(item('no blocker', 'unknown', [LEAK]), item('full flow', 'fail', [['step 3', 'save differs']])))]).toEqual(['full flow|-|step 3|save differs']);
  });
});

describe('matching and clean', () => {
  it('match the check name, the where regex and the message regex', () => {
    const s = seed();
    expect(matches(s, 'no blocker', { where: 'step 2', message: LEAK[1], evidence: [] })).toBe(true);
    expect(matches(s, 'full flow', { where: 'step 2', message: LEAK[1], evidence: [] })).toBe(false);
    expect(matches(s, 'no blocker', { where: 'step 2a', message: LEAK[1], evidence: [] })).toBe(false);
    expect(matches(s, 'no blocker', { where: 'step 2', message: 'client main error log: other', evidence: [] })).toBe(false);
  });

  it('is clean without a matching failure and with every target item giving a result; another failure of the base does not count', () => {
    const s = seed();
    expect(cleanFor(s, file(item('no blocker', 'fail', [['step 1', 'other blocker']])))).toEqual({ clean: true, reason: null });
    expect(cleanFor(s, file(item('no blocker', 'fail', [LEAK]))).clean).toBe(false);
    expect(cleanFor(s, file(item('no blocker', 'unknown', [['step 1', 'instance did not start']])))).toEqual({ clean: false, reason: 'no blocker: unknown: instance did not start' });
    expect(cleanFor(s, file(item('full flow', 'pass')))).toEqual({ clean: false, reason: 'no blocker: not in the check' });
  });

  it('takes a UI quality item that is unknown only by the flash check as giving a result', () => {
    const s = seed({ match: [{ check: 'UI quality', where: '.*', message: '^overlap ' }] });
    const flash = item('UI quality', 'unknown', [['client/dev/bot/scenario.json:1', 'flash: get_state frame_step_fps is missing, not targetFps 60']], 'android');
    expect(cleanFor(s, file(flash)).clean).toBe(true);
    const other = item('UI quality', 'unknown', [['settings.json:1', 'uiCheckScreens.0.pixelRatio: missing']], 'android');
    expect(cleanFor(s, file(flash, other)).clean).toBe(false);
  });
});

describe('catch', () => {
  it('is caught when the seeded check matches and the base does not, with the collateral keys apart', () => {
    const s = seed();
    const base = file(item('no blocker', 'fail', [['step 1', 'known blocker']]), item('full flow', 'pass'));
    const seeded = file(item('no blocker', 'fail', [['step 1', 'known blocker'], LEAK]), item('full flow', 'fail', [['step 2', 'scenario stopped at step 2']]));
    const result = catchOf(s, base, seeded);
    expect(result.catch).toBe('caught');
    expect(result.matched?.failure.message).toBe(LEAK[1]);
    expect(result.collateral).toEqual(['full flow|-|step 2|scenario stopped at step #']);
    expect(result.pipeline).toBe('none');
  });

  it('is missed when the base has it too, or when the seeded check gives a result without it', () => {
    const s = seed();
    expect(catchOf(s, file(item('no blocker', 'fail', [LEAK])), file(item('no blocker', 'fail', [LEAK])))).toMatchObject({ catch: 'missed', reason: `the base has it: ${LEAK[0]} ${LEAK[1]}` });
    expect(catchOf(s, file(item('no blocker', 'pass')), file(item('no blocker', 'pass'))).catch).toBe('missed');
  });

  it('is unknown when a target item of the seeded check gives no result and nothing matches', () => {
    const s = seed();
    const result = catchOf(s, file(item('no blocker', 'pass')), file(item('no blocker', 'unknown', [['step 1', 'host busy']])));
    expect(result).toMatchObject({ catch: 'unknown', reason: 'no blocker: unknown: host busy' });
  });

  it('of a missed seed is caught by any key the base has not', () => {
    const s = seed({ expect: 'missed', match: [], row: { id: 'x', severity: 'major', owner: 'client content', why: 'w', source: 'play', where: 'result', what: 'w', evidence: ['e'] } });
    expect(catchOf(s, file(item('regression test', 'pass')), file(item('regression test', 'pass'))).catch).toBe('missed');
    expect(catchOf(s, file(item('regression test', 'pass')), file(item('regression test', 'fail', [['client/tests/a.gd:3', 'test_rooms failed']]))).catch).toBe('caught');
  });

  it('checks the pipeline: the fields ogw loop findings fills against the row', () => {
    const ui = seed({ match: [{ check: 'UI quality', where: '.*', message: '^overlap ' }], row: { id: 'overlap-prefab-lobby-lobby-panel', severity: 'major', owner: 'client content', why: 'w', source: 'check' } });
    const failure: [string, string] = ['scene/lobby', 'overlap A B in prefab/lobby/lobby_panel (ko)'];
    expect(catchOf(ui, file(item('UI quality', 'pass')), file(item('UI quality', 'fail', [failure]))).pipeline).toBe('pass');
    const other = { ...ui, row: { ...ui.row, id: 'title-overlap' } };
    expect(catchOf(other, file(item('UI quality', 'pass')), file(item('UI quality', 'fail', [failure]))).pipeline).toBe('fail');
    const rows = seed({ match: [{ check: 'row simulation', where: '^data/', message: '^out ' }], row: { id: 'spike', severity: 'major', owner: 'data', why: 'w', source: 'check' } });
    expect(catchOf(rows, file(item('row simulation', 'pass')), file(item('row simulation', 'fail', [['data/tables/opponent.csv:5', 'out [opp_warden]: sim_turns 30']]))).pipeline).toBe('pass');
    const placeholder = seed({ match: [{ check: 'no placeholder', where: '.*', message: '^translation_stale' }] });
    expect(catchOf(placeholder, file(item('no placeholder', 'pass')), file(item('no placeholder', 'fail', [['data/translations/en.csv:3', 'translation_stale en k']]))).pipeline).toBe('none');
  });
});

describe('seed manifest', () => {
  it('names each problem', () => {
    const { problems } = parseManifest({ state: 's', expect: 'caught', match: [{ check: 'x', where: '(', message: 'm' }], fixer: 'robot', row: { id: 'i', severity: 'huge', owner: 'o', why: 'w', source: 'check' }, frozenColumns: [{ file: 1 }] });
    expect(problems).toEqual([
      'match.0.where is not a regular expression',
      'class is not a non-empty string',
      'element is not a non-empty string',
      'fixer is not one of content, translation, none',
      'row.severity is not one of blocker, major, minor',
      'frozenColumns is not an array of {"file", "columns": [<glob>, ...]}',
    ]);
    expect(parseManifest({ state: 's', class: 'c', element: 'e', expect: 'caught', fixer: 'none', row: { id: 'i', severity: 'major', owner: 'o', why: 'w', source: 'check' } }).problems).toEqual(['match is empty for expect caught']);
    expect(parseManifest({ state: 's', class: 'c', element: 'e', expect: 'missed', fixer: 'none', row: { id: 'i', severity: 'major', owner: 'o', why: 'w', source: 'play' } }).problems).toEqual([
      'row.where is not a non-empty string',
      'row.what is not a non-empty string',
      'row.evidence is not a non-empty array of strings',
    ]);
  });
});
