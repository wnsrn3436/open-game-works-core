import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_PINS_KEY } from '../../../src/commands/loop/lib/harness-pin.ts';
import { RUN_LIMITS_KEY } from '../../../src/commands/loop/lib/run-limits.ts';
import { listRuns } from '../../../src/lib/runstate.ts';
import { commitAll, ogw } from '../../helpers/workspace.ts';
import { commit, currentRun, git, openBuildRun, openLoopRun, read, setRun, setupGame, write, type TestGame } from './helpers.ts';

const mocks = vi.hoisted(() => ({ placeholderFailures: vi.fn(), listInstances: vi.fn(), stopInstance: vi.fn() }));
vi.mock('../../../src/commands/check/api.ts', async (orig) => ({ ...(await orig<object>()), placeholderFailures: mocks.placeholderFailures }));
vi.mock('../../../src/commands/instance/api.ts', async (orig) => ({ ...(await orig<object>()), listInstances: mocks.listInstances, stopInstance: mocks.stopInstance }));

beforeEach(() => {
  mocks.placeholderFailures.mockReset().mockResolvedValue([]);
  mocks.listInstances.mockReset().mockResolvedValue([]);
  mocks.stopInstance.mockReset().mockResolvedValue(undefined);
});

const R = 'records/loops/update-1';
const HOUR = 3_600_000;

/** Starts an update run with `ogw loop start` and the given options; returns the run name. */
async function start(g: TestGame, ...options: string[]): Promise<string> {
  const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', ...options, '--json'], { stdin: 'add a boss\n' });
  expect(out.stderr).toBe('');
  return (JSON.parse(out.stdout) as { run: string }).run;
}

/** Commits a change to the harness repo of the workspace; returns its new HEAD. */
function changeHarness(g: TestGame): string {
  return commitAll(g.ws.harness, 'harness change');
}

/** Records iteration `n` of the run with no findings and an empty check file. */
async function recordEmpty(g: TestGame, run: string, n: number): Promise<string> {
  write(g.root, `records/loops/${run}/check-${String(n)}.json`, { commit: 'c', checks: [] });
  write(g.root, `records/loops/${run}/findings-${String(n)}.json`, { findings: [], discarded: [] });
  expect((await ogw(g.ws, ['loop', 'record', 'g'])).stderr).toBe('');
  return read(g.root, `records/loops/${run}/iteration-${String(n)}.md`);
}

describe('ogw loop start limits and harness pin', () => {
  it('keeps --limit, --until and the harness repo HEAD in the run state', async () => {
    const g = setupGame();
    const until = Date.now() + HOUR;
    await start(g, '--limit', '2', '--until', String(until));
    const run = await currentRun(g);
    expect(run.data[RUN_LIMITS_KEY]).toEqual({ iterations: 2, until });
    expect(run.data[HARNESS_PINS_KEY]).toEqual([{ commit: git(g.ws.harness, 'rev-parse', 'HEAD'), iteration: 0 }]);
    const plain = setupGame();
    await start(plain);
    expect((await currentRun(plain)).data[RUN_LIMITS_KEY]).toEqual({ iterations: null, until: null });
  });

  it('creates nothing for a limit of 0 or a time that is not later than now', async () => {
    for (const options of [['--limit', '0'], ['--limit', 'x'], ['--until', String(Date.now() - 1)], ['--until', String(Math.floor(Date.now() / 1000))]]) {
      const g = setupGame();
      const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', ...options], { stdin: 'x\n' });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(`invalid ${options[0] ?? ''}`);
      expect(await listRuns(g.repo)).toEqual([]);
      expect(git(g.root, 'branch', '--format=%(refname:short)')).toBe('id-registry\nmain');
    }
  });
});

describe('ogw loop next limits and harness pin', () => {
  it('stops at the run --limit below loopIterationLimit', async () => {
    const g = setupGame();
    await start(g, '--limit', '1');
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 1\nkind: completeness\n');
    const out = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('iteration 1 reached --limit 1');
    expect((await currentRun(g)).iteration).toBe(1);
  });

  it('refuses a harness change, naming both commits, and pins it with --repin, which the iteration record writes', async () => {
    const g = setupGame();
    const run = await start(g);
    const old = git(g.ws.harness, 'rev-parse', 'HEAD');
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).code).toBe(0);
    expect(await recordEmpty(g, run, 1)).toContain(`- kind: completeness\n- harness: ${old}\n\n## variants`);
    const changed = changeHarness(g);
    const refused = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`harness repo HEAD ${changed} is not the pinned harness commit ${old} of run ${run}: give --repin to pin ${changed}`);
    expect((await currentRun(g)).iteration).toBe(1);
    const repinned = await ogw(g.ws, ['loop', 'next', 'g', '--repin']);
    expect(repinned).toMatchObject({ code: 0, stdout: `iteration 2\nkind: completeness\nharness: ${changed} (repinned from ${old})\n` });
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0 }, { commit: changed, iteration: 2 }]);
    expect(await recordEmpty(g, run, 2)).toContain(`- harness: ${changed} (repinned from ${old})\n`);
    // the next iteration runs on the new pin without --repin, and its record names no repin
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).code).toBe(0);
    expect(await recordEmpty(g, run, 3)).toContain(`- harness: ${changed}\n\n## variants`);
  });

  it('does not check the harness in a build run, whose record writes the harness repo HEAD', async () => {
    const g = setupGame();
    await openBuildRun(g, { iteration: 0 });
    changeHarness(g);
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 1\nkind: completeness\n');
    expect((await ogw(g.ws, ['loop', 'next', 'g', '--repin'])).stdout).toBe('iteration 2\nkind: completeness\n');
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toBeUndefined();
    expect(await recordEmpty(g, 'build-stg-0.2.0', 2)).toContain(`- harness: ${git(g.ws.harness, 'rev-parse', 'HEAD')}\n`);
  });
});

describe('ogw loop verdict with blocking defects and run limits', () => {
  const checks = ['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality', 'no placeholder'];
  const judge = (path: string, kind: string): string => `### ${path}\n\n- kind: ${kind}\n- status: done\n- A: a\n- B: b\n- vs baseline: better\n- vs reference: pass\n`;
  const CANDIDATE = [
    '## commit', '', '- instance: c1', '- baseline: none', '- confirms: none', '- kind: completeness', '',
    '## checks', '', '| check | result | file |', '|---|---|---|', ...checks.map((c) => `| ${c} | pass | ${R}/check-1.json |`), '',
    '## judge', '', judge(`${R}/judge-1-1.md`, 'main'), judge(`${R}/judge-1-2.md`, 'success'),
  ].join('\n');
  const defect = (id: string, severity: string, status: string): object => ({
    id, severity, owner: 'design', where: 'w', what: `${id} what`, why: 'y', evidence: [], source: 'judge', status, refusedReason: status === 'refused' ? 'keeps the brief' : null, repeatedDefect: 0, oscillation: 0,
  });
  const defectsOf = (list: object[]): object => ({ defects: list, previous: null, recordedBy: 'iteration-1' });

  async function candidateRun(): Promise<TestGame> {
    const g = setupGame({ loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 3, successJudges: 1 } });
    await openLoopRun(g, { iteration: 1 });
    write(g.root, `${R}/iteration-1.md`, CANDIDATE);
    commit(g.root);
    return g;
  }

  it('blocks a candidate by an open major defect, not by a refused one or a minor one, and the next iteration is a completeness iteration', async () => {
    const g = await candidateRun();
    write(g.root, `${R}/defects.json`, defectsOf([defect('shop-crash', 'major', 'open'), defect('slow-menu', 'minor', 'open'), defect('dark-art', 'major', 'refused')]));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('continue\nsuccess blocked by: shop-crash\n');
    expect(((await currentRun(g)).data.loop as { verdict: unknown }).verdict).toEqual({ iteration: 1, reason: 'continue', evidence: [], blockedBy: ['shop-crash'] });
    // a completeness iteration whose gate passed is followed by a fun iteration, but not while success is blocked
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 2\nkind: completeness\n');
    await setRun(g, (run) => {
      run.iteration = 1;
    });
    write(g.root, `${R}/defects.json`, defectsOf([defect('shop-crash', 'major', 'fixed'), defect('slow-menu', 'minor', 'open'), defect('dark-art', 'major', 'refused')]));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe(`success\n${R}/judge-1-1.md\n${R}/judge-1-2.md\n${R}/check-1.json\n`);
  });

  it('writes the blocking defects and the limit reached in the end record', async () => {
    const g = await candidateRun();
    write(g.root, `${R}/defects.json`, defectsOf([defect('shop-crash', 'major', 'awaiting confirmation')]));
    await setRun(g, (run) => {
      run.data[RUN_LIMITS_KEY] = { iterations: 1, until: null };
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('limit reached\niteration 1 reached --limit 1\nsuccess blocked by: shop-crash\n');
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).stderr).toBe('');
    expect(read(g.root, `${R}/end.md`)).toContain('## reason\n\nlimit reached\n\n- iteration 1 reached --limit 1\n- success blocked by: shop-crash\n\n## result');
    // a person who stops the loop sees the blocking defects of the last verdict too
    await setRun(g, (run) => {
      run.data[RUN_LIMITS_KEY] = { iterations: null, until: null };
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('continue\nsuccess blocked by: shop-crash\n');
    expect((await ogw(g.ws, ['loop', 'end-record', 'g', '--stopped-by-human'])).stderr).toBe('');
    expect(read(g.root, `${R}/end.md`)).toContain('## reason\n\nstopped by human\n\n- last verdict: continue (iteration 1)\n- success blocked by: shop-crash\n\n## result');
  });

  it('gives limit reached once the time limit has passed, and the end record names it', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    write(g.root, `${R}/iteration-1.md`, '## judge\n\nnone\n');
    write(g.root, `${R}/defects.json`, defectsOf([]));
    commit(g.root);
    await setRun(g, (run) => {
      run.data[RUN_LIMITS_KEY] = { iterations: null, until: Date.now() + HOUR };
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('continue\n');
    await setRun(g, (run) => {
      run.data[RUN_LIMITS_KEY] = { iterations: null, until: 5 };
    });
    const out = await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect(out.stdout).toMatch(/^limit reached\nnow \d+ reached --until 5\n$/);
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).stderr).toBe('');
    expect(read(g.root, `${R}/end.md`)).toMatch(/## reason\n\nlimit reached\n\n- now \d+ reached --until 5\n\n## result/);
  });
});

describe('ogw loop resume limits and harness pin', () => {
  async function pinnedRun(iteration: number): Promise<{ g: TestGame; old: string }> {
    const g = setupGame();
    const old = git(g.ws.harness, 'rev-parse', 'HEAD');
    await openLoopRun(g, { iteration, data: { [HARNESS_PINS_KEY]: [{ commit: old, iteration: 0 }], [RUN_LIMITS_KEY]: { iterations: null, until: 9_000_000_000_000 } } });
    git(g.root, 'checkout', '-q', 'main');
    return { g, old };
  }

  it('refuses a harness change without --repin and changes nothing', async () => {
    const { g, old } = await pinnedRun(1);
    const changed = changeHarness(g);
    const before = await currentRun(g);
    const out = await ogw(g.ws, ['loop', 'resume', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`harness repo HEAD ${changed} is not the pinned harness commit ${old} of run update-1`);
    expect(await currentRun(g)).toEqual(before);
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(mocks.listInstances).not.toHaveBeenCalled();
  });

  it('repins for the current iteration before its record, and for the next one after it', async () => {
    const { g, old } = await pinnedRun(1);
    const changed = changeHarness(g);
    const out = await ogw(g.ws, ['loop', 'resume', 'g', '--repin']);
    expect(out.stdout).toBe(`harness: ${changed} (repinned from ${old}), counts for iteration 1\nchecked out loop/update-1\nnothing to sync\nresume at: iteration 1 1\n`);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0 }, { commit: changed, iteration: 1 }]);
    // the iteration record exists: the repin counts for the next iteration
    write(g.root, `${R}/iteration-1.md`, 'r');
    commit(g.root);
    const later = changeHarness(g);
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).toContain(`harness: ${later} (repinned from ${changed}), counts for iteration 2\n`);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0 }, { commit: changed, iteration: 1 }, { commit: later, iteration: 2 }]);
    // --repin on the pinned commit changes nothing
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).not.toContain('repinned');
  });

  it('replaces the limits given, and refuses a bad value or limits in a build run', async () => {
    const { g } = await pinnedRun(2);
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--limit', '4'])).stdout).toContain('limits: --limit 4, --until 9000000000000\n');
    expect((await currentRun(g)).data[RUN_LIMITS_KEY]).toEqual({ iterations: 4, until: 9_000_000_000_000 });
    const bad = await ogw(g.ws, ['loop', 'resume', 'g', '--until', '5']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('invalid --until: 5 is not later than now');
    expect((await currentRun(g)).data[RUN_LIMITS_KEY]).toEqual({ iterations: 4, until: 9_000_000_000_000 });
    const b = setupGame();
    await openBuildRun(b, { iteration: 1 });
    const build = await ogw(b.ws, ['loop', 'resume', 'g', '--limit', '3']);
    expect(build.code).toBe(1);
    expect(build.stderr).toContain('--limit and --until are taken only in a loop run');
  });
});
