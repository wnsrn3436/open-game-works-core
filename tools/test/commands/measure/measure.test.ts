import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkDoc } from '../../../src/commands/check/static/design-target.ts';
import { collectMeasure, measureCollected, measureTargets, parseTargets, rejectRepeated } from '../../../src/commands/measure/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { resolveGame } from '../../../src/lib/game.ts';
import { changeRuns, newRunState } from '../../../src/lib/runstate.ts';
import { loadHarnessSettings, workspaceFrom } from '../../../src/lib/settings.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

const DESIGN = [
  '# design',
  '## feel targets',
  '',
  '| metric | min | max | data |',
  '|---|---|---|---|',
  '| `input_latency_ms` | 0 | 100 | |',
  '| `scene_load_ms` | 0 | 500 | `stage.load` |',
  '',
  '## tuning targets',
  '',
  '| metric | min | max | data |',
  '|---|---|---|---|',
  '| content.gold | 10 | 20 | `stage.gold` |',
  '| first_reward_ms | 0 | 1000 | |',
  '',
  '## art direction',
  'none',
].join('\n');

describe('targets', () => {
  it('parses both target tables', () => {
    expect(parseTargets(DESIGN)).toEqual([
      { metric: 'input_latency_ms', min: 0, max: 100, data: null },
      { metric: 'scene_load_ms', min: 0, max: 500, data: 'stage.load' },
      { metric: 'content.gold', min: 10, max: 20, data: 'stage.gold' },
      { metric: 'first_reward_ms', min: 0, max: 1000, data: null },
    ]);
    expect(parseTargets('## feel targets\nnone\n')).toEqual([]);
    expect(parseTargets('## feel targets\n| a | b |\n|---|---|\n| 1 | 2 |\n')).toEqual([]);
    expect(() => parseTargets('## tuning targets\n| metric | min | max | data |\n|---|---|---|---|\n| fun | 1 | 2 | |\n')).toThrow(
      'design.md:4: `fun` is not a metric name',
    );
    expect(() => parseTargets('## feel targets\n| metric | min | max | data |\n|---|---|---|---|\n| fail_count | x | 2 | |\n')).toThrow(
      'design.md:4: min `x` of `fail_count` is not an integer',
    );
    expect(() => parseTargets('## feel targets\n| metric | min | max | data |\n|---|---|---|---|\n| fail_count | 3 | 2 | |\n')).toThrow('greater than max 2');
  });

  it('reads every design.md the design target static check accepts', () => {
    const doc = [
      '## feel targets',
      '| metric | max | min | data |',
      '|---|---|---|---|',
      '| fail_count | 5 | 1 | `stage.fails` |',
      '',
      '### notes',
      '| case | ms |',
      '|---|---|',
      '| tap | 80 |',
      '## tuning targets',
      '| `metric` | `min` | `max` |',
      '|---|---|---|',
      '| goal_interval_ms | 0 | 10 |',
    ].join('\n');
    expect(checkDoc(doc)).toEqual([]);
    expect(parseTargets(doc)).toEqual([
      { metric: 'fail_count', min: 1, max: 5, data: 'stage.fails' },
      { metric: 'goal_interval_ms', min: 0, max: 10, data: null },
    ]);
  });

  it('judges in, out and unknown', () => {
    const samples = [{ telemetry: { started_at: 0, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [{ at: 0, scene_key: 'a', duration_ms: 600 }], dropped: 0 }, state: { content: { gold: 10 } } }];
    expect(measureTargets(parseTargets(DESIGN), samples).map((t) => [t.metric, t.value, t.result])).toEqual([
      ['input_latency_ms', null, 'unknown'],
      ['scene_load_ms', 600, 'out'],
      ['content.gold', 10, 'in'],
      ['first_reward_ms', null, 'unknown'],
    ]);
  });
});

describe('ogw measure', () => {
  let runner: Runner;
  let a: string;
  let b: string;
  let initial: Record<string, unknown>;

  beforeAll(async () => {
    // the play guide of the measured commit: scene s is free, so a's first reward in it took no played time of the game
    const guide = '## play mode\n\n| scene | mode | step ms |\n|---|---|---|\n| `s` | `free` | |\n| `play` | `step` | 50 |\n';
    runner = setupRunner({ files: { 'design.md': DESIGN, 'play-guide.md': guide } });
    const ws = workspaceFrom(await loadHarnessSettings(runner.ws.env), runner.ws.env);
    const game = await resolveGame(ws, 'g', runner.ws.root);
    await changeRuns(game, (runs) => {
      runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'x', iteration: 2 }));
    });
    a = await startFor(runner);
    b = await startFor(runner, ['--platform', 'ios']);
    const base = Date.now();
    initial = {
      telemetryByInstance: {
        [a]: { started_at: base, inputs: [{ at: base, command: 'tap', latency_ms: 40, feedback: {} }], rewards: [{ at: base + 300, play_at: 300, kind: 'Item', id: 1, amount: 1 }], scene_loads: [{ at: base, scene_key: 's', duration_ms: 200 }] },
        [b]: { started_at: base, inputs: [{ at: base, command: 'tap', latency_ms: 80, feedback: {} }], rewards: [{ at: base + 900, play_at: 900, kind: 'Item', id: 1, amount: 1 }] },
      },
      stateByInstance: { [a]: { content: { gold: 12 } }, [b]: { content: { gold: 30 } } },
    };
    runner.config(initial);
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  it('measures instances and writes measure-<iteration>.json of the open run', async () => {
    const run = await ogw(runner.ws, ['measure', 'g', a, b]);
    expect(run.code).toBe(0);
    const path = join(runner.root, 'records', 'loops', 'update-1', 'measure-2.json');
    expect(run.stdout).toBe(
      ['input_latency_ms: 40 [0, 100] in', 'scene_load_ms: 200 [0, 500] in', 'content.gold: 12 [10, 20] in', 'first_reward_ms: 0 [0, 1000] in', path, ''].join('\n'),
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      commit: sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim(),
      targets: [
        { metric: 'input_latency_ms', min: 0, max: 100, value: 40, result: 'in', data: null },
        { metric: 'scene_load_ms', min: 0, max: 500, value: 200, result: 'in', data: 'stage.load' },
        { metric: 'content.gold', min: 10, max: 20, value: 12, result: 'in', data: 'stage.gold' },
        { metric: 'first_reward_ms', min: 0, max: 1000, value: 0, result: 'in', data: null },
      ],
    });
  });

  it('collects raw data and measures collected files the same way', async () => {
    const ctx = createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const collected = await ogw(runner.ws, ['measure', 'g', '--collect', b, '--out', 'b.json']);
    expect(collected).toMatchObject({ code: 0, stdout: 'b.json\n' });
    const raw = JSON.parse(readFileSync(join(runner.ws.root, 'b.json'), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ instance: b, state: { content: { gold: 30 } } });
    expect(Object.keys(raw)).toEqual(['instance', 'commit', 'telemetry', 'state']);
    await collectMeasure(ctx, 'g', a, 'a.json');
    const { path } = await measureCollected(ctx, 'g', ['b.json']);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { targets: { metric: string; value: number | null; result: string }[] };
    expect(written.targets.map((t) => [t.metric, t.value, t.result])).toEqual([
      ['input_latency_ms', 80, 'in'],
      ['scene_load_ms', null, 'unknown'],
      ['content.gold', 30, 'out'],
      ['first_reward_ms', 900, 'in'],
    ]);
    const both = await ogw(runner.ws, ['measure', 'g', '--collected', 'a.json', 'b.json', '--json']);
    expect((JSON.parse(both.stdout) as { targets: { value: number }[] }).targets[2]?.value).toBe(12);
  });

  it('checks its arguments and inputs', async () => {
    const usage = 'usage: ogw measure <game> <instance id>...';
    expect((await ogw(runner.ws, ['measure', 'g'])).stderr).toContain(usage);
    expect((await ogw(runner.ws, ['measure', 'g', a, '--collect', a, '--out', 'x.json'])).stderr).toContain(usage);
    expect((await ogw(runner.ws, ['measure', 'g', '--collect', a])).stderr).toContain(usage);
    expect((await ogw(runner.ws, ['measure', 'g', a, '--collected', 'a.json'])).stderr).toContain(usage);
    expect((await ogw(runner.ws, ['measure', 'g', a, '--out', 'x.json'])).stderr).toContain('--out goes with --collect');
    writeFileSync(join(runner.ws.root, 'bad.json'), '{"x":1}');
    expect((await ogw(runner.ws, ['measure', 'g', '--collected', 'bad.json'])).stderr).toContain('not a file of ogw measure --collect');
    expect((await ogw(runner.ws, ['measure', 'other', a])).code).not.toBe(0);
  });

  it('refuses collected data of different commits', async () => {
    const raw = { instance: 'x', commit: 'c1', telemetry: { started_at: 0 }, state: {} };
    writeFileSync(join(runner.ws.root, 'c1.json'), JSON.stringify(raw));
    writeFileSync(join(runner.ws.root, 'c2.json'), JSON.stringify({ ...raw, instance: 'y', commit: 'c2' }));
    const run = await ogw(runner.ws, ['measure', 'g', '--collected', 'c1.json', 'c2.json']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the measured instances are of different commits: c1, c2');
    expect((await ogw(runner.ws, ['measure', 'g', '--collected', 'c1.json'])).code).toBe(0);
  });

  it('refuses an instance given twice: each instance is one sample', async () => {
    const raw = { instance: 'x', commit: 'c1', telemetry: { started_at: 0 }, state: {} };
    writeFileSync(join(runner.ws.root, 'x1.json'), JSON.stringify(raw));
    writeFileSync(join(runner.ws.root, 'x2.json'), JSON.stringify(raw));
    for (const args of [['measure', 'g', '--collected', 'x1.json', 'x1.json'], ['measure', 'g', '--collected', 'x1.json', 'x2.json'], ['measure', 'g', a, a, b]]) {
      const run = await ogw(runner.ws, args);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('is given more than once: each instance is one sample');
    }
    const unknown = await ogw(runner.ws, ['measure', 'g', 'zz', 'zz']);
    expect(unknown).toMatchObject({ code: 1, stderr: expect.stringContaining('instance zz is given more than once') as unknown });
    expect(() => {
      rejectRepeated(['p', 'q', 'p']);
    }).toThrow('instance p is given more than once: each instance is one sample');
    expect(() => {
      rejectRepeated(['p', 'q']);
    }).not.toThrow();
  });

  it('fails the collect of an instance whose telemetry the metrics cannot read, and such a collected file', async () => {
    const base = Date.now();
    const good = { started_at: base, inputs: [] };
    for (const [bad, reason] of [['text', 'telemetry is not a JSON object'], [{ inputs: [] }, 'telemetry has no started_at']] as const) {
      runner.config({ telemetryByInstance: { [a]: bad, [b]: good }, stateByInstance: { [a]: {}, [b]: {} } });
      const run = await ogw(runner.ws, ['measure', 'g', '--collect', a, '--out', 'bad-a.json']);
      expect(run).toMatchObject({ code: 1, stderr: expect.stringContaining(reason) as unknown });
      expect((await ogw(runner.ws, ['measure', 'g', '--collect', b, '--out', 'good-b.json'])).code).toBe(0);
      writeFileSync(join(runner.ws.root, 'bad-file.json'), JSON.stringify({ instance: 'z', commit: 'c', telemetry: bad, state: {} }));
      const read = await ogw(runner.ws, ['measure', 'g', '--collected', 'bad-file.json']);
      expect(read).toMatchObject({ code: 1, stderr: expect.stringContaining(`bad-file.json: ${reason}`) as unknown });
    }
    runner.config(initial);
  });

  it('refuses an instance started with a save fixture', async () => {
    const fixture = join(runner.ws.root, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ steps: [{ kind: 'setup', command: 'set_user_state', args: ['Gold', '[]', '{"amount":5}'], timeoutMs: 2000 }] }));
    const c = await startFor(runner, ['--fixture', fixture]);
    for (const args of [['measure', 'g', a, c], ['measure', 'g', '--collect', c, '--out', 'c.json']]) {
      const run = await ogw(runner.ws, args);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`instance ${c} was started with a save fixture`);
    }
    await ogw(runner.ws, ['instance', 'stop', c]);
  });
});
