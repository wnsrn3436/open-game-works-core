import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dataCheck from '../../../../src/commands/check/static/data-check.ts';
import * as designTarget from '../../../../src/commands/check/static/design-target.ts';
import * as hapticFormat from '../../../../src/commands/check/static/haptic-format.ts';
import * as objectDestroy from '../../../../src/commands/check/static/object-destroy.ts';
import * as resourceHash from '../../../../src/commands/check/static/resource-hash.ts';
import * as simulationTarget from '../../../../src/commands/check/static/simulation-target.ts';
import type { DataRun } from '../../../../src/commands/data/api.ts';
import { absentLines, lines, memContext, sorted } from './helpers.ts';

const dataRun = vi.hoisted(() => ({ value: null as DataRun | null, calls: [] as unknown[] }));

vi.mock('../../../../src/commands/data/api.ts', () => ({
  runData: (_ctx: unknown, _game: unknown, options: unknown) => {
    dataRun.calls.push(options);
    return Promise.resolve(dataRun.value);
  },
}));

const sha = (data: string): string => createHash('sha256').update(data).digest('hex');

describe('resource hash', () => {
  it('compares file hashes with resources.csv', async () => {
    const variantHash = sha(sha('v1') + sha('v2'));
    const sc = memContext({
      'resource/resources.csv': [
        'key,description,spec,status,method,source,license,attribution,sha256',
        `icon/ok,x,size=8x8,final,,,,,${sha('ok')}`,
        `icon/bad,x,size=8x8,final,,,,,${sha('other')}`,
        `sfx/hit,x,length=100;variants=2,final,,,,,${variantHash}`,
        `sfx/missing,x,length=100;variants=2,final,,,,,${variantHash}`,
        'icon/none,x,size=8x8,placeholder,,,,,',
        `icon/upper,x,size=8x8,final,,,,,${sha('up').toUpperCase()}`,
        `icon/dash,x,size=8x8,final,,,,,${sha('d')}`,
        '',
      ].join('\n'),
      'resource/icon/ok.png': 'ok',
      'resource/icon/ok.png.import': 'meta',
      'resource/icon/bad.png': 'bad',
      'resource/sfx/hit.1.wav': 'v1',
      'resource/sfx/hit.2.wav': 'v2',
      'resource/sfx/missing.1.wav': 'v1',
      'resource/icon/upper.png': 'up',
      // Not a file of icon/dash: the extension is not letters and digits (`ogw resource sync` file rule).
      'resource/icon/dash.p-g': 'd',
    });
    const found = await resourceHash.run(sc);
    expect(absentLines(found)).toEqual([
      'resource/resources.csv:5 | resource hash: file of `sfx/missing` is missing',
      'resource/resources.csv:6 | resource hash: file of `icon/none` is missing',
      'resource/resources.csv:8 | resource hash: file of `icon/dash` is missing',
    ]);
    expect(lines(found)).toEqual([
      `resource/resources.csv:3 | resource hash: SHA-256 of \`icon/bad\` is ${sha('bad')}, not \`${sha('other')}\`; run \`ogw resource sync\``,
      'resource/resources.csv:5 | resource hash: file of `sfx/missing` is missing',
      'resource/resources.csv:6 | resource hash: file of `icon/none` is missing',
      'resource/resources.csv:8 | resource hash: file of `icon/dash` is missing',
    ]);
    expect(resourceHash.variantsOf('length=1;variants=0')).toBe(1);
    expect(resourceHash.variantsOf('variants=3')).toBe(3);
    expect(resourceHash.variantsOf('')).toBe(1);
  });

  it('does nothing without resources.csv', async () => {
    expect(await resourceHash.run(memContext({ 'a.txt': 'x' }))).toEqual([]);
  });
});

describe('haptic format', () => {
  it('checks haptic patterns', async () => {
    const sc = memContext({
      'resource/haptic/ok.json': '{"segments": [{"delay_ms": 0, "duration_ms": 1, "intensity": 1000}]}',
      'resource/haptic/ok.json.import': 'x',
      'resource/haptic/empty.json': '{"segments": []}',
      'resource/haptic/bad.json': '{\n  "segments": [\n    {"delay_ms": -1, "duration_ms": 1, "intensity": 0},\n    {"delay_ms": 0, "duration_ms": 0, "intensity": 0},\n    {"delay_ms": 0, "duration_ms": 1, "intensity": 1001},\n    {"delay_ms": 0, "duration_ms": 1.5, "intensity": 1},\n    {"delay_ms": 0, "duration_ms": 1, "intensity": 1, "x": 1},\n    5\n  ],\n  "extra": 1\n}',
      'resource/haptic/notjson.json': '{\n"segments": [',
      'resource/haptic/array.json': '[]',
      'resource/haptic/latin.json': Buffer.from([0xff, 0xfe]),
      'resource/haptic/proto.json': '{"segments": [{"delay_ms": 0, "duration_ms": 1, "intensity": 1}], "__proto__": {}}',
    });
    expect(lines(await hapticFormat.run(sc))).toEqual(sorted([
      'resource/haptic/array.json:1 | haptic format: not a JSON object',
      'resource/haptic/bad.json:3 | haptic format: segment 0: `delay_ms` -1 is out of range',
      'resource/haptic/bad.json:4 | haptic format: segment 1: `duration_ms` 0 is out of range',
      'resource/haptic/bad.json:5 | haptic format: segment 2: `intensity` 1001 is out of range',
      'resource/haptic/bad.json:6 | haptic format: segment 3: `duration_ms` is not an integer',
      'resource/haptic/bad.json:7 | haptic format: segment 4: unknown key `x`',
      'resource/haptic/bad.json:8 | haptic format: segment 5: segment is not an object',
      'resource/haptic/bad.json:10 | haptic format: unknown key `extra`',
      'resource/haptic/empty.json:1 | haptic format: `segments` is not a list of one or more segments',
      'resource/haptic/latin.json:1 | haptic format: not UTF-8',
      'resource/haptic/notjson.json:2 | haptic format: not JSON',
      'resource/haptic/proto.json:1 | haptic format: unknown key `__proto__`',
    ]));
  });
});

describe('design target', () => {
  it('checks the target tables of design.md', async () => {
    const doc = [
      '# game',
      '## feel targets',
      '',
      '| metric | min | max | data |',
      '|---|---|---|---|',
      '| `input_latency_ms` | 0 | 100 | |',
      '| `fun_ms` | 1 | 2 | |',
      '| `reward_interval_ms` | 1.5 | x | `stage.reward_every` |',
      '| `scene_load_ms` | 300 | 200 | |',
      '## tuning targets',
      '| metric | min | max | data |',
      '|:-|-|-|-|',
      '| content.level | -5 | 10 | |',
      '| content. | 1 | 1 | |',
      '## other',
      '| metric | min | max | data |',
      '|---|---|---|---|',
      '| nope | a | b | |',
      '',
    ].join('\n');
    const sc = memContext({ 'design.md': doc });
    expect(lines(await designTarget.run(sc))).toEqual([
      'design.md:7 | design target: `fun_ms` is not a metric name',
      'design.md:8 | design target: max `x` of `reward_interval_ms` is not an integer',
      'design.md:8 | design target: min `1.5` of `reward_interval_ms` is not an integer',
      'design.md:9 | design target: min 300 of `scene_load_ms` is greater than max 200',
      'design.md:14 | design target: `content.` is not a metric name',
    ]);
    expect(await designTarget.run(memContext({ 'a.md': '' }))).toEqual([]);
  });
});

describe('simulation target', () => {
  it('checks sim_ columns and values', async () => {
    const level = [
      'desc,,,,,,',
      'All,Client,None,None,None,Client,None',
      'id(key),int,int?,int?,int?,int?,string',
      'id,moves,sim_moves_left_min,sim_moves_left_max,sim_solve_permille_min,sim_bad_max,sim_x',
      '[level_1],10,5,3,500,null,a',
      '[level_2],10,1,3,null,,b',
      '#[level_3],10,9,1,,,c',
      '',
    ].join('\n');
    const rows = ['', 'All,None', 'id,int?', 'id,sim_a_min', '[a],1', ''].join('\n');
    const sc = memContext({ 'data/tables/level.csv': level, 'data/tables/rows.csv': rows, 'data/tables/plain.csv': 'a\nAll\nid(key)\nid\n' });
    expect(lines(await simulationTarget.run(sc))).toEqual(sorted([
      'data/tables/level.csv:2 | simulation target: column `sim_bad_max` build target is `Client`, not `None`',
      'data/tables/level.csv:4 | simulation target: column `sim_bad_max` has no pair column `sim_bad_min`',
      'data/tables/level.csv:4 | simulation target: column `sim_solve_permille_min` has no pair column `sim_solve_permille_max`',
      'data/tables/level.csv:4 | simulation target: column `sim_x` is not `sim_<metric>_min` or `sim_<metric>_max`',
      'data/tables/level.csv:5 | simulation target: `sim_moves_left_min` 5 is greater than `sim_moves_left_max` 3',
      'data/tables/rows.csv:3 | simulation target: table with `sim_` columns has a first column that is not `id(key)`',
      'data/tables/rows.csv:4 | simulation target: column `sim_a_min` has no pair column `sim_a_max`',
    ]).map((l) => l));
  });
});

describe('data check', () => {
  beforeEach(() => {
    dataRun.calls = [];
  });

  it('turns ERROR lines into failures and WARN lines into warnings, with a binary build', async () => {
    dataRun.value = {
      exitCode: 1,
      stderr: '',
      lines: [
        { level: 'ERROR', code: 'ref_missing', where: 'data/tables/item.csv:7:3', message: 'no [x]', text: '' },
        { level: 'WARN', code: 'translation_missing', where: 'data/translations/ko.csv:2:1', message: 'missing', text: '' },
      ],
    };
    const result = await dataCheck.run(memContext({ 'settings.json': '{}' }));
    expect(result).toEqual({
      failures: [{ where: 'data/tables/item.csv:7', message: 'data check ref_missing no [x]' }],
      warnings: [{ where: 'data/translations/ko.csv:2:1', message: 'data check translation_missing missing' }],
    });
    expect(dataRun.calls).toEqual([{ binary: true, generate: false }]);
  });

  it('reports a failed binary build without ERROR lines and stops on argument errors', async () => {
    dataRun.value = { exitCode: 1, stderr: 'translation file would change\nmore', lines: [] };
    expect((await dataCheck.run(memContext({}))).failures).toEqual([
      { where: 'data:1', message: 'data check binary build failed: translation file would change; run `ogw data g` and commit' },
    ]);
    dataRun.value = { exitCode: 2, stderr: 'bad argument', lines: [] };
    await expect(dataCheck.run(memContext({}))).rejects.toThrow('data tool failed: bad argument');
    dataRun.value = { exitCode: 0, stderr: '', lines: [] };
    expect(await dataCheck.run(memContext({}))).toEqual({ failures: [], warnings: [] });
  });
});

describe('object destroy', () => {
  it('has nothing to check for Godot and is not defined for other engines', async () => {
    expect(await objectDestroy.run(memContext({ 'settings.json': '{"engine": "godot"}' }))).toEqual([]);
    await expect(objectDestroy.run(memContext({ 'settings.json': '{"engine": "unity"}' }))).rejects.toThrow('not defined: static check object destroy for engine unity');
    await expect(objectDestroy.run(memContext({ 'settings.json': '{}' }))).rejects.toThrow('game settings `engine` is missing');
  });
});
