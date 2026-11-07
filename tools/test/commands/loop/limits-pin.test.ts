import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_PINS_KEY, runHarnessSettings } from '../../../src/commands/loop/lib/harness-pin.ts';
import { createContext } from '../../../src/lib/command.ts';
import { currentRunSettings } from '../../../src/lib/settings.ts';
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

/** Writes the settings.local.json of the workspace harness. */
function writeLocal(g: TestGame, value: Record<string, unknown>): void {
  writeFileSync(join(g.ws.harness, 'settings.local.json'), JSON.stringify(value));
}

/** Records iteration `n` of the run with no findings and a check file of `checks` (none by default). */
async function recordEmpty(g: TestGame, run: string, n: number, checks: string[] = []): Promise<string> {
  const results = checks.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] }));
  write(g.root, `records/loops/${run}/check-${String(n)}.json`, { commit: 'c', checks: results });
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
    const runSettings = await currentRunSettings(g.ws.env);
    expect(run.data[HARNESS_PINS_KEY]).toEqual([{ commit: git(g.ws.harness, 'rev-parse', 'HEAD'), iteration: 0, runSettings }]);
    // the run paths, with the schema defaults filled in, and no criterion
    expect(runSettings).toMatchObject({ playInstances: 3, imageMethod: 'flux2-klein', agents: { content: { cli: 'claude-code' } }, loop: { funIterations: 3, judgePanel: [], variants: 1 } });
    expect(Object.keys(runSettings.loop as object).sort()).toEqual(['funIterations', 'judgePanel', 'judgeTimeLimitMs', 'playTimeLimitMs', 'variants']);
    expect(Object.keys(runSettings).sort()).toEqual(['agents', 'imageMethod', 'loop', 'playInstances']);
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
    const runSettings = await currentRunSettings(g.ws.env);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0, runSettings }, { commit: changed, iteration: 2, runSettings }]);
    expect(await recordEmpty(g, run, 2)).toContain(`- harness: ${changed} (repinned from ${old})\n`);
    // the next iteration runs on the new pin without --repin, and its record names no repin
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).code).toBe(0);
    expect(await recordEmpty(g, run, 3)).toContain(`- harness: ${changed}\n\n## variants`);
  });

  it('fails with the pin output before the core version check when the harness HEAD moved to a newer core', async () => {
    const g = setupGame();
    const run = await start(g);
    const old = git(g.ws.harness, 'rev-parse', 'HEAD');
    const changed = changeHarness(g);
    // the moved HEAD holds the specs of a core newer than the game's
    git(g.ws.harness, 'tag', 'core-v99.0.0');
    const refused = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`harness repo HEAD ${changed} is not the pinned harness commit ${old} of run ${run}`);
    expect(refused.stderr).not.toContain('the specs of this harness are of core');
    expect((await currentRun(g)).iteration).toBe(0);
    // with --repin the core version check runs on the new HEAD
    const repinned = await ogw(g.ws, ['loop', 'next', 'g', '--repin']);
    expect(repinned.code).toBe(1);
    expect(repinned.stderr).toContain('the specs of this harness are of core 99.0.0');
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

describe('run settings', () => {
  it('reads the run paths from the pin while the loop run is open, and repins changed ones with --repin', async () => {
    const g = setupGame({}, { 'settings.json': { coreVersion: '1.0.0', buildPlatforms: ['android', 'web'], loopIterationLimit: 5 } });
    const run = await start(g);
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).code).toBe(0);
    await recordEmpty(g, run, 1, ['regression test', 'static check', 'no blocker', 'full flow']);
    // a change of local harness settings after the start does not reach the run, and a run path the pin does not hold has no value
    const judge = { cli: 'codex', model: 'gpt', effort: 'high' };
    writeLocal(g, { loop: { variants: 3, funIterations: 1, confirmJudge: judge } });
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 2\nkind: fun\nvariants: 1\n');
    const ctx = createContext({ cwd: g.ws.root, env: g.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const inRun = await runHarnessSettings(ctx, g.repo);
    expect(inRun.loop.variants).toBe(1);
    expect(inRun.loop.funIterations).toBe(3);
    expect(inRun.loop.confirmJudge).toBeUndefined();
    expect((await ctx.settings()).loop).toMatchObject({ variants: 3, confirmJudge: judge });
    await recordEmpty(g, run, 2);
    // the iteration kind follows the funIterations of the pin: a second fun iteration in a row
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 3\nkind: fun\nvariants: 1\n');
    await recordEmpty(g, run, 3);
    // with --repin the iteration it starts reads them: one fun iteration in a row is the most
    const repinned = await ogw(g.ws, ['loop', 'next', 'g', '--repin']);
    expect(repinned).toMatchObject({ code: 0, stdout: 'iteration 4\nkind: completeness\nrun settings: loop.funIterations, loop.confirmJudge.cli, loop.confirmJudge.model, loop.confirmJudge.effort, loop.variants (repinned)\n' });
    const pins = (await currentRun(g)).data[HARNESS_PINS_KEY] as { iteration: number; runSettings: { loop: { variants: number } } }[];
    expect(pins.map((p) => [p.iteration, p.runSettings.loop.variants])).toEqual([[0, 1], [4, 3]]);
    expect((await runHarnessSettings(ctx, g.repo)).loop).toMatchObject({ variants: 3, confirmJudge: judge });
    // the harness commit did not change: the iteration record names no repin
    expect(await recordEmpty(g, run, 4)).toContain(`- harness: ${git(g.ws.harness, 'rev-parse', 'HEAD')}\n\n## variants`);
    // the loop end record lists the run settings of each pin that changed them
    expect((await ogw(g.ws, ['loop', 'end-record', 'g', '--stopped-by-human'])).stderr).toBe('');
    const end = read(g.root, `records/loops/${run}/end.md`);
    // `## time` comes after it
    const section = end.slice(end.indexOf('## run settings'), end.indexOf('\n## time\n'));
    expect(section).toContain('\n- iteration 0:\n  - agents.content.cli: "claude-code"\n');
    expect(section).toContain('\n  - loop.variants: 1\n');
    expect(section).toMatch(/\n- iteration 4:\n {2}- loop\.funIterations: 1\n {2}- loop\.confirmJudge\.cli: "codex"\n {2}- loop\.confirmJudge\.model: "gpt"\n {2}- loop\.confirmJudge\.effort: "high"\n {2}- loop\.variants: 3\n$/);
  });

  it('reads harness settings in a build run and once the run is closed', async () => {
    const g = setupGame();
    // a build run has no pin: run settings in its state are not read
    await openBuildRun(g, { iteration: 0, data: { [HARNESS_PINS_KEY]: [{ commit: 'c', iteration: 0, runSettings: { loop: { variants: 1 } } }] } });
    writeLocal(g, { loop: { variants: 4 } });
    const ctx = createContext({ cwd: g.ws.root, env: g.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect((await runHarnessSettings(ctx, g.repo)).loop.variants).toBe(4);
    const loop = setupGame();
    await start(loop);
    writeLocal(loop, { loop: { variants: 4 } });
    const loopCtx = createContext({ cwd: loop.ws.root, env: loop.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect((await runHarnessSettings(loopCtx, loop.repo)).loop.variants).toBe(1);
    await setRun(loop, (r) => {
      r.closedAt = Date.now();
    });
    expect((await runHarnessSettings(loopCtx, loop.repo)).loop.variants).toBe(4);
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
    const runSettings = await currentRunSettings(g.ws.env);
    await openLoopRun(g, { iteration, data: { [HARNESS_PINS_KEY]: [{ commit: old, iteration: 0, runSettings }], [RUN_LIMITS_KEY]: { iterations: null, until: 9_000_000_000_000 } } });
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
    const runSettings = await currentRunSettings(g.ws.env);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0, runSettings }, { commit: changed, iteration: 1, runSettings }]);
    // the iteration record exists: the repin counts for the next iteration
    write(g.root, `${R}/iteration-1.md`, 'r');
    commit(g.root);
    const later = changeHarness(g);
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).toContain(`harness: ${later} (repinned from ${changed}), counts for iteration 2\n`);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([
      { commit: old, iteration: 0, runSettings },
      { commit: changed, iteration: 1, runSettings },
      { commit: later, iteration: 2, runSettings },
    ]);
    // --repin on the pinned commit and run settings changes nothing
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).not.toContain('repinned');
    // run settings that changed are repinned without a harness change, and without --repin they stay
    writeLocal(g, { agents: { play: { model: 'claude-haiku-5-5' } } });
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).not.toContain('repinned');
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).toContain('run settings: agents.play.model (repinned), counts for iteration 2\n');
    expect(((await currentRun(g)).data[HARNESS_PINS_KEY] as unknown[]).length).toBe(4);
  });

  it('refuses a repin for the current iteration to a harness HEAD of another core, with the output of ogw loop next', async () => {
    const { g, old } = await pinnedRun(1);
    const changed = changeHarness(g);
    // the moved HEAD holds the specs of a core other than the game's core 1.0.0
    git(g.ws.harness, 'tag', 'core-v99.0.0');
    const before = await currentRun(g);
    // without --repin the pin output comes first
    const plain = await ogw(g.ws, ['loop', 'resume', 'g']);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain(`harness repo HEAD ${changed} is not the pinned harness commit ${old} of run update-1`);
    expect(plain.stderr).not.toContain('the specs of this harness are of core');
    const refused = await ogw(g.ws, ['loop', 'resume', 'g', '--repin']);
    expect(refused.code).toBe(1);
    const next = await ogw(g.ws, ['loop', 'next', 'g', '--repin']);
    expect(next.stderr).toContain('g uses core 1.0.0, and the specs of this harness are of core 99.0.0');
    expect(refused.stderr).toBe(next.stderr);
    expect(await currentRun(g)).toEqual(before);
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(mocks.listInstances).not.toHaveBeenCalled();
    // the core version is that of the branch of the run, not of the checkout
    git(g.root, 'checkout', '-q', 'loop/update-1');
    write(g.root, 'settings.json', { coreVersion: '99.0.0', buildPlatforms: ['android', 'web'], loopIterationLimit: 3 });
    commit(g.root);
    git(g.root, 'checkout', '-q', 'main');
    expect((await ogw(g.ws, ['loop', 'resume', 'g', '--repin'])).stdout).toContain(`harness: ${changed} (repinned from ${old}), counts for iteration 1\n`);
  });

  it('repins for the next iteration to a harness HEAD of another core, and leaves the core version check to ogw loop next', async () => {
    const { g, old } = await pinnedRun(1);
    // iteration 1 is recorded on the run branch: a repin counts for iteration 2
    git(g.root, 'checkout', '-q', 'loop/update-1');
    write(g.root, `${R}/iteration-1.md`, 'r');
    commit(g.root);
    git(g.root, 'checkout', '-q', 'main');
    const changed = changeHarness(g);
    git(g.ws.harness, 'tag', 'core-v99.0.0');
    const out = await ogw(g.ws, ['loop', 'resume', 'g', '--repin']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`harness: ${changed} (repinned from ${old}), counts for iteration 2\n`);
    const runSettings = await currentRunSettings(g.ws.env);
    expect((await currentRun(g)).data[HARNESS_PINS_KEY]).toEqual([{ commit: old, iteration: 0, runSettings }, { commit: changed, iteration: 2, runSettings }]);
    const next = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(next.code).toBe(1);
    expect(next.stderr).toContain('g uses core 1.0.0, and the specs of this harness are of core 99.0.0');
    expect((await currentRun(g)).iteration).toBe(1);
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
