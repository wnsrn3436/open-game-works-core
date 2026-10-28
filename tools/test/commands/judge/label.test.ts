import { beforeEach, describe, expect, it, vi } from 'vitest';
import { labelDeps } from '../../../src/commands/judge/label.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { addJob, commit, openLoopRun, read, setupGame, write, type TestGame } from '../loop/helpers.ts';

const fake = vi.hoisted(() => ({ started: [] as Record<string, unknown>[], stopped: [] as string[], running: new Set<string>() }));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn((_ctx: unknown, opts: Record<string, unknown>) => {
    const id = `i${String(fake.started.length + 1)}`;
    fake.started.push(opts);
    fake.running.add(id);
    return Promise.resolve({ id, commit: opts.commit, root: '/nowhere' });
  }),
  stopInstance: vi.fn((_ctx: unknown, id: string) => {
    fake.running.delete(id);
    fake.stopped.push(id);
    return Promise.resolve();
  }),
}));

const RECORD = (instance: string, baseline: string, judge: string): string =>
  `## commit\n\n- instance: ${instance}\n- baseline: ${baseline}\n- confirms: none\n- kind: fun\n\n## judge\n\n${judge}\n`;
const JUDGED = '### j\n\n- kind: main\n- status: done';

/** main with two judged pairs (older: c1 vs c0, newer: c2 vs c1) and one record without a judge (c3 vs c2). */
function history(g: TestGame): string[] {
  write(g.root, '.gitignore', '/builds/\n');
  const commits: string[] = [];
  for (const n of [0, 1, 2, 3]) {
    write(g.root, 'client/a.txt', String(n));
    commits.push(commit(g.root, `c${String(n)}`));
  }
  const [c0, c1, c2, c3] = commits as [string, string, string, string];
  write(g.root, 'records/loops/update-1/iteration-1.md', RECORD(c1, c0, JUDGED));
  commit(g.root, 'record 1');
  write(g.root, 'records/loops/update-2/iteration-1.md', RECORD(c2, c1, JUDGED));
  commit(g.root, 'record 2');
  write(g.root, 'records/loops/update-3/iteration-1.md', RECORD(c3, c2, 'none'));
  commit(g.root, 'record 3');
  return commits;
}

/** Answers the questions in order; records every question. */
function script(answers: string[]): string[] {
  const asked: string[] = [];
  labelDeps.ask = (question) => {
    asked.push(question);
    expect(asked.length).toBeLessThanOrEqual(answers.length);
    return Promise.resolve(answers[asked.length - 1] ?? '');
  };
  return asked;
}

beforeEach(() => {
  fake.started = [];
  fake.stopped = [];
  fake.running.clear();
  labelDeps.now = () => 777;
});

describe('ogw judge label', () => {
  it('lets the human play A then B of the most recent judged pair without a label, and appends the answers on main', async () => {
    const g = setupGame();
    const [, c1, c2] = history(g);
    sh(g.root, 'git', ['checkout', '--quiet', '-b', 'elsewhere']);
    labelDeps.random = () => 0.9;
    // A, B, then the six elements (one answer typed wrong first), then the note
    const asked = script(['', '', 'x', 'a', 'B', ' s ', 'a', 'b', 's', 'A is snappier']);
    const run = await ogw(g.ws, ['judge', 'label', 'g'], { terminal: true });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // the coin above 0.5 puts the baseline commit on A
    expect(fake.started).toEqual([
      { game: 'g', commit: c1, client: 'window', played: true },
      { game: 'g', commit: c2, client: 'window', played: true },
    ]);
    expect(fake.stopped).toEqual(['i1', 'i2']);
    expect(asked[0]).toContain('Play A');
    expect(asked[1]).toContain('Play B');
    expect(asked[2]).toBe('game feel: It responds to input, and every action has feedback. e.g. sound, effect, camera shake\nWhich is better? a (A), b (B) or s (same): ');
    expect(asked[3]).toBe(asked[2]);
    expect(asked[9]).toContain('Note');
    const labels = JSON.parse(read(g.root, 'records/calibration/labels.json')) as unknown[];
    expect(labels).toEqual([
      {
        A: c1,
        B: c2,
        answers: { 'game feel': 'A', 'tension and release': 'B', progression: 'same', 'one more run': 'A', 'no friction': 'B', presentation: 'same' },
        note: 'A is snappier',
        at: 777,
      },
    ]);
    expect(sh(g.root, 'git', ['branch', '--show-current']).trim()).toBe('main');
    expect(sh(g.root, 'git', ['show', '--name-only', '--format=', 'main']).trim()).toBe('records/calibration/labels.json');
    expect(sh(g.root, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('takes the next pair once the most recent one has a label, and changes nothing without a pair', async () => {
    const g = setupGame();
    const [c0, c1, c2] = history(g) as [string, string, string];
    write(g.root, 'records/calibration/labels.json', [{ A: c1, B: c2, answers: {}, note: '', at: 1 }]);
    commit(g.root, 'label');
    labelDeps.random = () => 0.1;
    script(['', '', 'a', 'a', 'a', 'a', 'a', 'a', '']);
    expect((await ogw(g.ws, ['judge', 'label', 'g'], { terminal: true })).code).toBe(0);
    expect(fake.started.map((s) => s.commit)).toEqual([c1, c0]);
    const labels = JSON.parse(read(g.root, 'records/calibration/labels.json')) as { A: string; B: string; note: string }[];
    expect(labels.map((l) => [l.A, l.B, l.note])).toEqual([[c1, c2, ''], [c1, c0, '']]);
    const head = sh(g.root, 'git', ['rev-parse', 'HEAD']).trim();
    const none = await ogw(g.ws, ['judge', 'label', 'g'], { terminal: true });
    expect(none).toMatchObject({ code: 0, stdout: 'no judged pair without a label\n' });
    expect(sh(g.root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
  });

  it('runs only in a terminal, and not with an open run or a running calibration', async () => {
    const g = setupGame();
    history(g);
    expect((await ogw(g.ws, ['judge', 'label', 'g'])).stderr).toContain('ogw judge label asks the human: run it in a terminal');
    const job = await addJob(g.ws, { command: 'judge calibrate', game: 'g', supervisorPid: process.pid });
    expect((await ogw(g.ws, ['judge', 'label', 'g'], { terminal: true })).stderr).toContain(`ogw judge calibrate job ${job.id} of game g is running`);
    await openLoopRun(g);
    expect((await ogw(g.ws, ['judge', 'label', 'g'], { terminal: true })).stderr).toContain('game g has an open run: update-1');
    expect(fake.started).toEqual([]);
  });
});
