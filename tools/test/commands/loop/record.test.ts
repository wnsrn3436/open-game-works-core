import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DefectsFile, Finding, FindingsFile } from '../../../src/commands/loop/lib/defects.ts';
import { ogw } from '../../helpers/workspace.ts';
import { addJob, commit, currentRun, git, openBuildRun, openLoopRun, read, readJsonFile, setRun, setupGame, write, type TestGame } from './helpers.ts';

const mocks = vi.hoisted(() => ({ placeholderFailures: vi.fn() }));
vi.mock('../../../src/commands/check/api.ts', async (orig) => ({ ...(await orig<object>()), placeholderFailures: mocks.placeholderFailures }));

beforeEach(() => {
  mocks.placeholderFailures.mockReset().mockResolvedValue([]);
});

const R = 'records/loops/update-1';

/** The judge calibration line of `## human` for a game without a calibration report on main. */
const NEVER = '- judge calibration: never run (ogw judge calibrate g; labels: 0, added with ogw judge label g)';

function checkFile(commitSha: string): object {
  return {
    commit: commitSha,
    checks: [
      { name: 'regression test', platform: null, result: 'pass', failures: [], warnings: [] },
      { name: 'static check', platform: null, result: 'fail', failures: [{ where: 'data/tables/a.csv:3', message: 'id_name bad', evidence: ['log.txt'] }], warnings: [] },
      { name: 'no blocker', platform: null, result: 'pass', failures: [], warnings: [] },
      { name: 'full flow', platform: null, result: 'pass', failures: [], warnings: [] },
      { name: 'performance', platform: 'web', result: 'fail', failures: [], warnings: [], hostLoad: { cpuMaxPercent: 95 } },
      { name: 'performance', platform: 'android', result: 'pass', failures: [], warnings: [], hostLoad: { cpuMaxPercent: 20 } },
      { name: 'no placeholder', platform: null, result: 'fail', failures: [{ where: 'x', message: 'placeholder icon/a', evidence: [] }], warnings: [] },
      {
        name: 'row simulation',
        platform: null,
        result: 'fail',
        failures: [
          { where: 'data/tables/s.csv:2', message: 'error [s1] crashed', evidence: [] },
          { where: 'data/tables/s.csv:3', message: 'out [s2] too slow', evidence: [] },
          { where: '', message: 'no where', evidence: [] },
        ],
        warnings: [],
      },
    ],
  };
}

const FEEDBACK = [
  '## coverage', '', 'unknown: none', '', '## observations', '',
  '1000 | lobby | tap start | nothing happens | stuck | blocker | cap/1.png',
  '2000 | run | jump | ok | fine | none | cap/2.png',
  '3000 | | swipe | turns | odd | minor | cap/3.png',
  '4000 | run | dash | slow | bad | huge | ',
  '',
].join('\n');

const JUDGE = [
  '## vs baseline', '', 'none', '', '## vs reference', '', 'none', '',
  '## moments', '', '`B` is better at core action. reason: faster', '',
  '## loser better', '', 'A had music', '',
  '## defects', '',
  '| instance | where | what | why | severity | evidence |',
  '|---|---|---|---|---|---|',
  '| B | boss | no telegraph | unfair | major | cap/j.png |',
  '| A | lobby | baseline issue | x | minor | cap/k.png |',
  '| B | shop | no evidence | x | minor | |',
  '',
].join('\n');

const AGENT = { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };

/** A judge entry of `evaluate-<n>.json` with the fields a test does not look at filled in. */
function judgeOf(fields: Record<string, unknown>): Record<string, unknown> {
  return { agent: AGENT, omittedMoments: [], votes: null, lostMoments: [], telemetry: null, status: 'done', ...fields };
}

/** The `evaluate-<n>.json` fields of the step 4 judges together and the kind. */
function together(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'completeness', elements: ['game feel'], votes: null, vsBaseline: null, vsReference: 'unknown', ...fields };
}

async function iterationOne(): Promise<{ g: TestGame; sha: string }> {
  const g = setupGame();
  await openLoopRun(g, { iteration: 1 });
  const sha = git(g.root, 'rev-parse', 'HEAD');
  write(g.root, `${R}/check-1.json`, checkFile(sha));
  write(g.root, `${R}/measure-1.json`, {
    commit: sha,
    targets: [
      { metric: 'fps', min: 30, max: 60, value: 20, result: 'out', data: null },
      { metric: 'gold_rate', min: 1, max: 5, value: 9, result: 'out', data: 'economy.rate' },
      { metric: 'jump_ms', min: 1, max: 5, value: 3, result: 'in', data: null },
    ],
  });
  write(g.root, `${R}/play-1-1.md`, FEEDBACK);
  write(g.root, `${R}/play-1-2.md`, '## observations\n\n1 | a | b | c | d | major | e\n');
  write(g.root, `${R}/judge-1-1.md`, JUDGE);
  write(g.root, `${R}/evaluate-1.json`, {
    commit: sha,
    baseline: 'base0',
    plays: [
      { result: `${R}/play-1-1.md`, instance: 'i1', platform: 'android', moment: null, status: 'done' },
      { result: `${R}/play-1-2.md`, instance: 'i2', platform: 'web', moment: null, status: 'failed' },
    ],
    judges: [
      judgeOf({ kind: 'main', result: `${R}/judge-1-1.md`, A: 'base0', B: sha, instanceSide: 'B', omittedMoments: ['boss'], vsReference: 'fail' }),
      judgeOf({ kind: 'success', result: `${R}/judge-1-2.md`, A: sha, B: 'base0', instanceSide: 'A', vsReference: 'unknown', status: 'failed', agent: { ...AGENT, cli: 'codex' } }),
    ],
    ...together({ votes: [{ element: 'game feel', this: 2, baseline: 0, decision: 'this' }], vsBaseline: 'better', vsReference: 'fail' }),
    measure: `${R}/measure-1.json`,
  });
  commit(g.root);
  return { g, sha };
}

describe('ogw loop findings', () => {
  it('collects check, measure, play and judge findings and discards incomplete ones', async () => {
    const { g } = await iterationOne();
    // a row without a capture cell, and a row that cannot be read
    write(g.root, `${R}/play-1-1.md`, `${FEEDBACK}5000 | menu | open | freezes | stuck | blocker\n6000 | broken row\n`);
    commit(g.root);
    const out = await ogw(g.ws, ['loop', 'findings', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: `${R}/findings-1.json\nfindings: 9\ndiscarded: 4\n` });
    const file = readJsonFile(g.root, `${R}/findings-1.json`) as FindingsFile;
    const base = { id: null, drop: null };
    expect(file.findings).toEqual([
      { ...base, source: 'check', severity: null, owner: null, where: 'data/tables/a.csv:3', what: 'id_name bad', why: null, evidence: [`${R}/check-1.json#static check`, 'log.txt'] },
      { ...base, source: 'check', severity: null, owner: 'client content', where: 'data/tables/s.csv:2', what: 'error [s1] crashed', why: null, evidence: [`${R}/check-1.json#row simulation`] },
      { ...base, source: 'check', severity: null, owner: 'data', where: 'data/tables/s.csv:3', what: 'out [s2] too slow', why: null, evidence: [`${R}/check-1.json#row simulation`] },
      { ...base, source: 'check', severity: null, owner: 'design', where: 'fps', what: 'value 20 out of 30..60', why: null, evidence: [`${R}/measure-1.json#fps`] },
      { ...base, source: 'check', severity: null, owner: 'data', where: 'gold_rate', what: 'value 9 out of 1..5', why: null, evidence: [`${R}/measure-1.json#gold_rate`] },
      { ...base, source: 'play', severity: 'blocker', owner: null, where: 'lobby', what: 'tap start → nothing happens', why: 'stuck', evidence: ['cap/1.png', `${R}/play-1-1.md:7`] },
      { ...base, source: 'play', severity: null, owner: null, where: 'run', what: 'dash → slow', why: 'bad', evidence: [`${R}/play-1-1.md:10`] },
      { ...base, source: 'play', severity: 'blocker', owner: null, where: 'menu', what: 'open → freezes', why: 'stuck', evidence: [`${R}/play-1-1.md:11`] },
      { ...base, source: 'judge', severity: 'major', owner: null, where: 'boss', what: 'no telegraph', why: 'unfair', evidence: ['cap/j.png'] },
      { ...base, source: 'judge', severity: 'minor', owner: null, where: 'shop', what: 'no evidence', why: 'x', evidence: [] },
    ].filter((f) => f.evidence.length > 0));
    expect(file.discarded.map((f) => f.what)).toEqual(['no where', 'swipe → turns', '6000 | broken row', 'no evidence']);
    expect(file.discarded[2]?.evidence).toEqual([`${R}/play-1-1.md:12`]);
    expect(git(g.root, 'status', '--porcelain')).toBe(`?? ${R}/findings-1.json`);
  });

  it('makes judge findings of the failed vs reference rows with the judge result path, for main and success judges', async () => {
    const { g, sha } = await iterationOne();
    const reference = (side: string): string => `## vs reference\n\n| instance | element | result | reason | evidence |\n|---|---|---|---|---|\n| ${side} | \`no friction\` | fail | four taps first | frames |\n\n## defects\n\nnone\n`;
    write(g.root, `${R}/judge-1-1.md`, reference('B'));
    write(g.root, `${R}/judge-1-3.md`, reference('A'));
    const evaluate = readJsonFile(g.root, `${R}/evaluate-1.json`) as { judges: object[] };
    evaluate.judges.push(judgeOf({ kind: 'success', result: `${R}/judge-1-3.md`, A: sha, B: 'base0', instanceSide: 'A', vsReference: 'fail' }));
    write(g.root, `${R}/evaluate-1.json`, evaluate);
    commit(g.root);
    await ogw(g.ws, ['loop', 'findings', 'g']);
    const file = readJsonFile(g.root, `${R}/findings-1.json`) as FindingsFile;
    expect(file.findings.filter((f) => f.where === 'vs reference: no friction').map((f) => f.evidence)).toEqual([
      ['frames', `${R}/judge-1-1.md`],
      ['frames', `${R}/judge-1-3.md`],
    ]);
  });

  it('makes a finding of a memorable_moment the step 4 judge did not get', async () => {
    const { g } = await iterationOne();
    const evaluate = readJsonFile(g.root, `${R}/evaluate-1.json`) as Record<string, unknown>;
    write(g.root, `${R}/evaluate-1.json`, { ...evaluate, memorableMoment: 'omitted' });
    commit(g.root);
    await ogw(g.ws, ['loop', 'findings', 'g']);
    const file = readJsonFile(g.root, `${R}/findings-1.json`) as FindingsFile;
    expect(file.findings.filter((f) => f.where === 'judge moment: memorable_moment')).toEqual([{
      id: null,
      drop: null,
      source: 'judge',
      severity: 'minor',
      owner: 'design',
      where: 'judge moment: memorable_moment',
      what: 'memorable_moment omitted',
      why: 'the judge does not see the memorable moment of `brief.md`',
      evidence: [`${R}/evaluate-1.json`],
    }]);
  });

  it('takes only blocker play observations in a confirmation iteration', async () => {
    const { g } = await iterationOne();
    await setRun(g, (run) => {
      run.data.loop = { confirms: [{ iteration: 1, candidate: 0 }] };
    });
    await ogw(g.ws, ['loop', 'findings', 'g']);
    const file = readJsonFile(g.root, `${R}/findings-1.json`) as FindingsFile;
    expect(file.findings.filter((f) => f.source === 'play').map((f) => f.severity)).toEqual(['blocker']);
    expect(file.discarded.filter((f) => f.source === 'play')).toEqual([]);
  });

  it('collects only check findings without an evaluate file, and fails before an iteration', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    expect((await ogw(g.ws, ['loop', 'findings', 'g'])).stdout).toContain('findings: 0\n');
    write(g.root, `${R}/check-2.json`, checkFile('c'));
    expect((await ogw(g.ws, ['loop', 'findings', 'g'])).stdout).toContain('findings: 3\ndiscarded: 1');
    await setRun(g, (run) => {
      run.iteration = 0;
    });
    expect((await ogw(g.ws, ['loop', 'findings', 'g'])).code).toBe(1);
    expect((await ogw(g.ws, ['loop', 'findings', 'g', '--hardening'])).stderr).toContain('only in a build run');
  });

  it('makes hardening findings from the last round', async () => {
    const g = setupGame();
    await openBuildRun(g);
    const fixes = (rows: string[]): string => ['## changes', '', 'none', '', '## content agent fixes', '', '| file:line | owner | problem | task |', '|---|---|---|---|', ...rows, '', '## unknown', '', 'none', ''].join('\n');
    write(g.root, 'records/hardening/stg-0.2.0-server-1.md', fixes(['| old.ts:1 | contract | old | x |']));
    write(g.root, 'records/hardening/stg-0.2.0-server-2.md', fixes(['| contract/a.proto:4 | contract | missing range | add |']));
    write(g.root, 'records/hardening/stg-0.2.0-client-2.md', fixes(['| client/ui/shop.gd:9 | client content | trusts the price | read it from the response |']));
    write(g.root, 'records/hardening/stg-0.2.0-client-1.md', '## content agent fixes\n\nnone\n');
    write(g.root, 'records/hardening/dev-0.2.0-server-3.md', fixes(['| z | data | other build | x |']));
    const out = await ogw(g.ws, ['loop', 'findings', 'g', '--hardening']);
    expect(out.stdout).toBe('records/loops/build-stg-0.2.0/findings-hardening-2.json\nfindings: 2\ndiscarded: 0\n');
    expect((readJsonFile(g.root, 'records/loops/build-stg-0.2.0/findings-hardening-2.json') as FindingsFile).findings).toEqual([
      { source: 'hardening', severity: null, owner: 'client content', where: 'client/ui/shop.gd:9', what: 'trusts the price', why: null, evidence: ['records/hardening/stg-0.2.0-client-2.md'], id: null, drop: null },
      { source: 'hardening', severity: null, owner: 'contract', where: 'contract/a.proto:4', what: 'missing range', why: null, evidence: ['records/hardening/stg-0.2.0-server-2.md'], id: null, drop: null },
    ]);
    write(g.root, 'records/hardening/stg-0.2.0-server-3.md', '## content agent fixes\n\n| where | who |\n|---|---|\n| a | b |\n');
    expect((await ogw(g.ws, ['loop', 'findings', 'g', '--hardening'])).stderr).toContain('records/hardening/stg-0.2.0-server-3.md `## content agent fixes` needs the columns file:line, owner, problem, task');
    const empty = setupGame();
    await openBuildRun(empty);
    expect((await ogw(empty.ws, ['loop', 'findings', 'g', '--hardening'])).stderr).toContain('no hardening record of stg-0.2.0');
  });
});

function filled(file: FindingsFile, fill: (f: Finding, i: number) => Partial<Finding>): FindingsFile {
  return { ...file, findings: file.findings.map((f, i) => ({ ...f, severity: f.severity ?? 'minor', owner: f.owner ?? 'design', why: f.why ?? 'w', ...fill(f, i) })) };
}

describe('ogw loop record', () => {
  it('refuses unfilled findings', async () => {
    const { g } = await iterationOne();
    await ogw(g.ws, ['loop', 'findings', 'g']);
    const out = await ogw(g.ws, ['loop', 'record', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('findings without id, severity, owner or why');
    expect(git(g.root, 'status', '--porcelain')).toBe(`?? ${R}/findings-1.json`);
    const g2 = setupGame();
    await openLoopRun(g2, { iteration: 1 });
    expect((await ogw(g2.ws, ['loop', 'record', 'g'])).stderr).toContain('finding file missing');
  });

  it('merges findings into the defect list and writes the iteration record', async () => {
    const { g, sha } = await iterationOne();
    await ogw(g.ws, ['loop', 'findings', 'g']);
    const file = readJsonFile(g.root, `${R}/findings-1.json`) as FindingsFile;
    const ids = ['static-bad', 'sim-crash', 'sim-slow', 'low-fps', 'gold', 'start-stuck', 'dash', 'boss'];
    write(g.root, `${R}/content-1.md`, '## defects\n\n| id | result | note |\n|---|---|---|\n| static-bad | fixed | |\n');
    write(g.root, `${R}/defects.json`, {
      defects: [
        { id: 'old', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 },
        { id: 'static-bad', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [`${R}/check-0.json#static check`], source: 'check', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 },
      ],
      previous: { defects: [], previous: null, recordedBy: 'start' },
      recordedBy: 'iteration-0',
    });
    commit(g.root);
    write(g.root, `${R}/findings-1.json`, filled(file, (_f, i) => ({ id: i === 6 ? null : (ids[i] ?? 'x'), drop: i === 6 ? 'placeholder' : null })));
    const out = await ogw(g.ws, ['loop', 'record', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: `${R}/defects.json\n${R}/iteration-1.md\n` });
    const defects = readJsonFile(g.root, `${R}/defects.json`) as DefectsFile;
    expect(defects.recordedBy).toBe('iteration-1');
    expect(defects.previous?.recordedBy).toBe('iteration-0');
    expect(defects.previous?.defects.map((d) => d.id)).toEqual(['old', 'static-bad']);
    expect(defects.previous?.previous).toBeNull();
    expect(defects.defects.find((d) => d.id === 'static-bad')?.repeatedDefect).toBe(1);
    expect(defects.defects.map((d) => [d.id, d.severity, d.status])).toEqual([
      ['start-stuck', 'blocker', 'open'],
      ['boss', 'major', 'open'],
      ['static-bad', 'minor', 'open'],
      ['sim-crash', 'minor', 'open'],
      ['sim-slow', 'minor', 'open'],
      ['low-fps', 'minor', 'open'],
      ['gold', 'minor', 'open'],
      ['old', 'major', 'fixed'],
    ]);
    const record = read(g.root, `${R}/iteration-1.md`);
    expect(record).toContain(`## commit\n\n- instance: ${sha}\n- baseline: base0\n- confirms: none\n- kind: completeness\n`);
    expect(record).toContain('| static check | fail | records/loops/update-1/check-1.json |');
    expect(record).toContain('| performance | fail | records/loops/update-1/check-1.json |');
    expect(record).toContain(
      `### ${R}/judge-1-1.md\n\n- kind: main\n- status: done\n- agent: claude-code claude-opus-5-5 high\n- A: base0\n- B: ${sha}\n- vs reference: fail\n- omitted moments: boss\n\n#### moments\n\n\`B\` is better at core action. reason: faster\n\n#### loser better\n\nA had music`,
    );
    expect(record).toContain(`### ${R}/judge-1-2.md\n\n- kind: success\n- status: failed\n- agent: codex claude-opus-5-5 high\n`);
    expect(record).toContain(
      '## votes\n\n- vs baseline: better\n- vs reference: fail\n\n| element | this | baseline | decision |\n|---|---|---|---|\n| game feel | 2 | 0 | this |\n\n## play\n',
    );
    expect(record).toContain(`#### moments\n\nnone\n\n#### loser better\n\nnone`);
    expect(record).toContain(`| ${R}/play-1-1.md | 1 | 0 | 1 | 1 |\n| ${R}/play-1-2.md | 0 | 1 | 0 | 0 |`);
    expect(record).toContain('| start-stuck | blocker | design | lobby |');
    expect(record).toContain('| fps | 20 | 30..60 | out |');
    expect(record).toContain('## load\n\n| platform | hostLoad |\n|---|---|\n| web | {"cpuMaxPercent":95} |\n| android | {"cpuMaxPercent":20} |');
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([`${R}/defects.json`, `${R}/findings-1.json`, `${R}/iteration-1.md`]);
    expect(git(g.root, 'status', '--porcelain')).toBe('');
  });

  it('lists the resources that became temporary since the instance commit of the previous iteration, the base commit for iteration 1', async () => {
    const list = (rows: Record<string, string>): string => `key,status,license\n${Object.entries(rows).map(([key, status]) => `${key},${status},MIT`).join('\n')}\n`;
    const g = setupGame({}, { 'resource/resources.csv': list({ 'icon/old': 'temporary', 'icon/a': 'requested', 'icon/b': 'requested', 'icon/c': 'requested' }) });
    const section = async (iteration: number, rows: Record<string, string> | null): Promise<string> => {
      await setRun(g, (run) => {
        run.iteration = iteration;
      });
      if (rows !== null) {
        write(g.root, 'resource/resources.csv', list(rows));
        write(g.root, `${R}/check-${String(iteration)}.json`, checkFile(commit(g.root, `iteration ${String(iteration)}`)));
      }
      write(g.root, `${R}/findings-${String(iteration)}.json`, { findings: [], discarded: [] });
      expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
      return /## temporary resources\n\n([^#]*)/.exec(read(g.root, `${R}/iteration-${String(iteration)}.md`))?.[1]?.trim() ?? '';
    };
    await openLoopRun(g, { iteration: 1 });
    // icon/old is temporary at the base commit already
    expect(await section(1, { 'icon/old': 'temporary', 'icon/a': 'temporary', 'icon/b': 'requested', 'icon/c': 'requested' })).toBe('- `icon/a`');
    // icon/a became temporary in iteration 1; icon/b after the instance commit of iteration 1
    expect(await section(2, { 'icon/old': 'temporary', 'icon/a': 'temporary', 'icon/b': 'temporary', 'icon/c': 'requested' })).toBe('- `icon/b`');
    // recording iteration 2 again compares with iteration 1, not with its own earlier record
    expect(await section(2, null)).toBe('- `icon/b`');
    // an iteration without a check file has no instance commit
    write(g.root, 'resource/resources.csv', list({ 'icon/old': 'temporary', 'icon/a': 'temporary', 'icon/b': 'temporary', 'icon/c': 'temporary' }));
    commit(g.root, 'icon/c');
    expect(await section(3, null)).toBe('none');
  });

  it('writes the candidate of a confirmation iteration and keeps its non-blocker play defects awaiting confirmation', async () => {
    const { g } = await iterationOne();
    await setRun(g, (run) => {
      run.data.loop = { confirms: [{ iteration: 1, candidate: 0 }] };
    });
    const defect = (id: string, severity: string): object => ({ id, severity, owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 });
    write(g.root, `${R}/defects.json`, { defects: [defect('stuck', 'blocker'), defect('slow', 'major')], previous: null, recordedBy: 'iteration-0' });
    write(g.root, `${R}/findings-1.json`, { findings: [], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    expect(read(g.root, `${R}/iteration-1.md`)).toContain('- confirms: 0\n');
    const defects = readJsonFile(g.root, `${R}/defects.json`) as DefectsFile;
    expect(defects.defects.map((d) => [d.id, d.status])).toEqual([['stuck', 'fixed'], ['slow', 'awaiting confirmation']]);
    // a major defect that comes back as a blocker finding is confirmed open
    write(g.root, `${R}/findings-1.json`, { findings: [{ source: 'play', severity: 'blocker', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'], id: 'slow', drop: null }], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    const again = readJsonFile(g.root, `${R}/defects.json`) as DefectsFile;
    expect(again.defects.find((d) => d.id === 'slow')).toMatchObject({ severity: 'blocker', status: 'open', repeatedDefect: 1 });
  });

  it('decides an awaiting defect whose confirmation gave a result by a finding of its id from any source', async () => {
    const { g } = await iterationOne();
    const awaiting = (id: string, source: string, evidence: string[]): object => ({ id, severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence, source, status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 });
    write(g.root, `${R}/defects.json`, { defects: [awaiting('chk', 'check', [`${R}/check-1.json#regression test`]), awaiting('ply', 'play', [])], previous: null, recordedBy: 'iteration-0' });
    const finding = (id: string, source: string): object => ({ source, severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'], id, drop: null });
    write(g.root, `${R}/findings-1.json`, { findings: [finding('chk', 'play'), finding('ply', 'check')], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    const defects = (readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).defects;
    // the same id is the same cause: a play finding of a check defect and a check finding of a play defect make them open
    expect(['chk', 'ply'].map((id) => defects.find((d) => d.id === id)).map((d) => [d?.id, d?.status, d?.repeatedDefect])).toEqual([['chk', 'open', 1], ['ply', 'open', 1]]);
  });

  it('confirms a non-blocker play defect of a confirmation iteration by a judge finding of its id', async () => {
    const { g } = await iterationOne();
    await setRun(g, (run) => {
      run.data.loop = { confirms: [{ iteration: 1, candidate: 0 }] };
    });
    write(g.root, `${R}/defects.json`, { defects: [{ id: 'slow', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 }], previous: null, recordedBy: 'iteration-0' });
    write(g.root, `${R}/findings-1.json`, { findings: [{ source: 'judge', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'], id: 'slow', drop: null }], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    expect((readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).defects.find((d) => d.id === 'slow')).toMatchObject({ status: 'open', repeatedDefect: 1 });
    // with no done play the play confirmation gives no result, a finding of the id or not
    const evaluate = readJsonFile(g.root, `${R}/evaluate-1.json`) as { plays: { status: string }[] };
    write(g.root, `${R}/evaluate-1.json`, { ...evaluate, plays: evaluate.plays.map((p) => ({ ...p, status: 'failed' })) });
    write(g.root, `${R}/defects.json`, { defects: [{ id: 'slow', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 }], previous: null, recordedBy: 'iteration-0' });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    expect((readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).defects.find((d) => d.id === 'slow')).toMatchObject({ status: 'awaiting confirmation', repeatedDefect: 0 });
  });

  it('confirms a defect only by its own source, and refuses a dropped finding with an id', async () => {
    const { g } = await iterationOne();
    const ui = { id: 'ui', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [`${R}/check-1.json#no such check`], source: 'check', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 };
    write(g.root, `${R}/defects.json`, { defects: [ui], previous: null, recordedBy: 'iteration-0' });
    const play = { source: 'play', severity: 'major', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'] };
    write(g.root, `${R}/findings-1.json`, { findings: [{ ...play, id: 'ui', drop: null }], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    // a play finding of the id is no result of the check confirmation
    expect((readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).defects.find((d) => d.id === 'ui')).toMatchObject({ status: 'awaiting confirmation', repeatedDefect: 0 });
    write(g.root, `${R}/findings-1.json`, { findings: [{ ...play, id: 'ui', drop: 'placeholder resource' }], discarded: [] });
    const dropped = await ogw(g.ws, ['loop', 'record', 'g']);
    expect(dropped.code).toBe(1);
    expect(dropped.stderr).toContain('findings without id');
  });

  it('records again from the previous content when the label repeats', async () => {
    const { g } = await iterationOne();
    write(g.root, `${R}/defects.json`, {
      defects: [{ id: 'gone', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'check', status: 'fixed', refusedReason: null, repeatedDefect: 0, oscillation: 0 }],
      previous: { defects: [], previous: null, recordedBy: 'iteration-0' },
      recordedBy: 'iteration-1',
    });
    write(g.root, `${R}/findings-1.json`, { findings: [{ source: 'check', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'], id: 'new-one', drop: null }], discarded: [] });
    await ogw(g.ws, ['loop', 'record', 'g']);
    const defects = readJsonFile(g.root, `${R}/defects.json`) as DefectsFile;
    expect(defects.defects.map((d) => d.id)).toEqual(['new-one']);
    expect(defects.previous).toEqual({ defects: [], previous: null, recordedBy: 'iteration-0' });
  });

  it('confirms by source only where this record has a result', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    const d = (id: string, source: string, evidence: string[]): object => ({ id, severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence, source, status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 });
    const perf = `${R}/check-1.json#performance`;
    const fps = `${R}/measure-1.json#fps`;
    write(g.root, `${R}/defects.json`, {
      defects: [
        d('chk-pass', 'check', [perf]),
        d('chk-unknown', 'check', [`${R}/check-1.json#static check`]),
        d('chk-found', 'check', [perf]),
        d('msr-in', 'check', [fps]),
        d('msr-found', 'check', [fps]),
        d('msr-unknown', 'check', [`${R}/measure-1.json#load`]),
        d('ply-fixed', 'play', ['p']),
        d('ply-found', 'play', ['p']),
        d('jdg', 'judge', ['j']),
        d('hrd', 'hardening', ['h']),
      ],
      previous: null,
      recordedBy: 'iteration-1',
    });
    write(g.root, `${R}/check-2.json`, {
      commit: 'c',
      gate: 'pass',
      checks: [
        { name: 'static check', platform: null, result: 'unknown', failures: [], warnings: [] },
        { name: 'performance', platform: 'web', result: 'pass', failures: [], warnings: [] },
        { name: 'performance', platform: 'android', result: 'unknown', failures: [], warnings: [] },
      ],
    });
    write(g.root, `${R}/measure-2.json`, {
      commit: 'c',
      targets: [
        { metric: 'fps', min: 30, max: 60, value: 40, result: 'in', data: null },
        { metric: 'load', min: 0, max: 1, value: null, result: 'unknown', data: null },
      ],
    });
    write(g.root, `${R}/evaluate-2.json`, {
      commit: 'c',
      baseline: null,
      plays: [
        { result: `${R}/play-2-1.md`, instance: 'i1', platform: 'web', moment: null, status: 'failed' },
        { result: `${R}/play-2-2.md`, instance: 'i2', platform: 'web', moment: null, status: 'done' },
      ],
      judges: [judgeOf({ kind: 'main', result: `${R}/judge-2-1.md`, A: 'c', B: null, instanceSide: 'A', vsReference: 'unknown', status: 'failed' })],
      ...together(),
      measure: `${R}/measure-2.json`,
    });
    const found = (id: string, source: string): object => ({ source, severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: ['e'], id, drop: null });
    write(g.root, `${R}/findings-2.json`, { findings: [found('chk-found', 'check'), found('msr-found', 'check'), found('ply-found', 'play')], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    const defects = (readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).defects;
    expect(defects.map((x) => [x.id, x.status, x.repeatedDefect])).toEqual([
      ['chk-found', 'open', 1],
      ['msr-found', 'open', 1],
      ['ply-found', 'open', 1],
      ['chk-pass', 'fixed', 0],
      ['chk-unknown', 'awaiting confirmation', 0],
      ['msr-in', 'fixed', 0],
      ['msr-unknown', 'awaiting confirmation', 0],
      ['ply-fixed', 'fixed', 0],
      ['jdg', 'awaiting confirmation', 0],
      ['hrd', 'awaiting confirmation', 0],
    ]);
  });

  it('writes empty judge, play, measurement and load sections without an evaluate file', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    write(g.root, `${R}/check-2.json`, { commit: 'c', checks: [] });
    write(g.root, `${R}/findings-2.json`, { findings: [], discarded: [] });
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    const record = read(g.root, `${R}/iteration-2.md`);
    expect(record).toContain('## judge\n\nnone\n\n## votes\n\nnone\n\n## play\n\nnone\n');
    expect(record).toContain('## measurements\n\nnone\n\n## load\n\nnone\n');
    expect((readJsonFile(g.root, `${R}/defects.json`) as DefectsFile).previous).toBeNull();
  });

  it('records hardening findings into the defect list only', async () => {
    const g = setupGame();
    await openBuildRun(g, { iteration: 0 });
    const run = 'records/loops/build-stg-0.2.0';
    expect((await ogw(g.ws, ['loop', 'record', 'g', '--hardening'])).stderr).toContain('no findings-hardening');
    write(g.root, `${run}/findings-hardening-1.json`, { findings: [], discarded: [] });
    write(g.root, 'records/hardening/stg-0.2.0-server-1.md', '## content agent fixes\n\nnone\n');
    write(g.root, 'records/hardening/stg-0.2.0-server-2.md', '## content agent fixes\n\nnone\n');
    write(g.root, `${run}/findings-hardening-2.json`, { findings: [{ source: 'hardening', severity: 'major', owner: 'contract', where: 'a.proto:1', what: 'x', why: 'y', evidence: ['h'], id: 'range', drop: null }], discarded: [] });
    write(g.root, `${run}/defects.json`, {
      defects: [{ id: 'old-h', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'hardening', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 }],
      previous: null,
      recordedBy: 'hardening-1',
    });
    const out = await ogw(g.ws, ['loop', 'record', 'g', '--hardening']);
    expect(out).toMatchObject({ code: 0, stdout: `${run}/defects.json\n` });
    const defects = readJsonFile(g.root, `${run}/defects.json`) as DefectsFile;
    expect(defects.recordedBy).toBe('hardening-2');
    expect(defects.defects.map((x) => [x.id, x.status])).toEqual([['range', 'open'], ['old-h', 'fixed']]);
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([`${run}/defects.json`, `${run}/findings-hardening-2.json`]);
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).stderr).toContain('has not started an iteration');
    // a hardening record of a newer round without its finding file
    write(g.root, 'records/hardening/stg-0.2.0-client-3.md', '## content agent fixes\n\nnone\n');
    const stale = await ogw(g.ws, ['loop', 'record', 'g', '--hardening']);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`${run}/findings-hardening-2.json is not of the latest hardening round 3`);
    expect((readJsonFile(g.root, `${run}/defects.json`) as DefectsFile).recordedBy).toBe('hardening-2');
    const l = setupGame();
    await openLoopRun(l, { iteration: 1 });
    expect((await ogw(l.ws, ['loop', 'record', 'g', '--hardening'])).stderr).toContain('only in a build run');
  });
});

describe('hardening confirmation', () => {
  it('confirms a fixed hardening defect in a round without content agent fixes', async () => {
    const g = setupGame();
    await openBuildRun(g, { iteration: 1 });
    const run = 'records/loops/build-stg-0.2.0';
    write(g.root, 'records/hardening/stg-0.2.0-server-1.md', '## content agent fixes\n\n| file:line | owner | problem | task |\n|---|---|---|---|\n| a.proto:1 | contract | no range | add |\n');
    write(g.root, 'records/hardening/stg-0.2.0-server-2.md', '## content agent fixes\n\nnone\n');
    write(g.root, 'records/hardening/stg-0.2.0-client-2.md', '## content agent fixes\n\nnone\n');
    write(g.root, `${run}/defects.json`, {
      defects: [{ id: 'range', severity: 'major', owner: 'contract', where: 'a.proto:1', what: 'no range', why: 'y', evidence: [], source: 'hardening', status: 'awaiting confirmation', refusedReason: null, repeatedDefect: 0, oscillation: 0 }],
      previous: null,
      recordedBy: 'iteration-1',
    });
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'findings', 'g', '--hardening'])).stdout).toBe(`${run}/findings-hardening-2.json\nfindings: 0\ndiscarded: 0\n`);
    expect((await ogw(g.ws, ['loop', 'record', 'g', '--hardening'])).code).toBe(0);
    const defects = readJsonFile(g.root, `${run}/defects.json`) as DefectsFile;
    expect(defects.recordedBy).toBe('hardening-2');
    expect(defects.defects.map((d) => [d.id, d.status])).toEqual([['range', 'fixed']]);
  });
});

describe('ogw loop baseline and verdict', () => {
  it('gives the baseline from earlier records', async () => {
    const g = setupGame();
    const run = await openLoopRun(g, { iteration: 3 });
    expect((await ogw(g.ws, ['loop', 'baseline', 'g'])).stdout).toBe(`${run.baseCommit}\n`);
    const rec = (sha: string, vs: string): string => `## commit\n\n- instance: ${sha}\n- baseline: none\n\n## checks\n\nnone\n\n## judge\n\n### j\n\n- kind: main\n- vs baseline: ${vs}\n- vs reference: pass\n`;
    write(g.root, `${R}/iteration-1.md`, rec('c1', 'better'));
    write(g.root, `${R}/iteration-3.md`, rec('c3', 'better'));
    expect(JSON.parse((await ogw(g.ws, ['loop', 'baseline', 'g', '--json'])).stdout)).toEqual({ baseline: 'c1' });
    const c = setupGame();
    await openLoopRun(c, { name: 'create-1', command: 'create', iteration: 1 });
    expect((await ogw(c.ws, ['loop', 'baseline', 'g'])).stdout).toBe('none\n');
    const b = setupGame();
    const build = await openBuildRun(b, { iteration: 4 });
    expect((await ogw(b.ws, ['loop', 'baseline', 'g'])).stdout).toBe(`${build.baseCommit}\n`);
  });

  it('records the verdict in the run state', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 3 });
    const defectsOf = (recordedBy: string, list: object[] = []): object => ({ defects: list, previous: null, recordedBy });
    const missing = await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect(missing).toMatchObject({ code: 1, stderr: expect.stringContaining(`${R}/iteration-3.md is missing`) as unknown });
    write(g.root, `${R}/iteration-3.md`, '## judge\n\nnone\n');
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stderr).toContain(`${R}/defects.json is not recorded by iteration-3 (missing)`);
    write(g.root, `${R}/defects.json`, defectsOf('iteration-2'));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stderr).toContain('is not recorded by iteration-3 (iteration-2)');
    expect(((await currentRun(g)).data.loop as { verdict?: unknown } | undefined)?.verdict ?? null).toBeNull();
    write(g.root, `${R}/defects.json`, defectsOf('iteration-3'));
    const out = await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: 'limit reached\niteration 3\nlimit 3\n' });
    expect(((await currentRun(g)).data.loop as { verdict: unknown }).verdict).toEqual({ iteration: 3, reason: 'limit reached', evidence: ['iteration 3', 'limit 3'] });
    await setRun(g, (run) => {
      run.iteration = 1;
    });
    write(g.root, `${R}/iteration-1.md`, '## judge\n\nnone\n');
    write(g.root, `${R}/defects.json`, defectsOf('iteration-1'));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('continue\n');
    const rep = { id: 'rep', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'check', status: 'open', refusedReason: null, repeatedDefect: 3, oscillation: 0 };
    write(g.root, `${R}/defects.json`, defectsOf('iteration-1', [rep]));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('repeated defect\nrep 3\n');
  });

  it('starts a confirmation iteration after a confirm verdict, with the candidate as baseline and no content input', async () => {
    const g = setupGame({}, { 'settings.json': { coreVersion: '1.0.0', buildPlatforms: ['android', 'web'], loopIterationLimit: 10 } });
    await openLoopRun(g, { iteration: 2 });
    const rec = (sha: string): string => `## commit\n\n- instance: ${sha}\n- baseline: none\n\n## checks\n\nnone\n\n## judge\n\nnone\n`;
    write(g.root, `${R}/iteration-1.md`, rec('c1'));
    write(g.root, `${R}/iteration-2.md`, rec('c2'));
    await setRun(g, (run) => {
      run.data.loop = { verdict: { iteration: 2, reason: 'confirm', evidence: [] } };
    });
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 3\nconfirms iteration 2\nkind: completeness\n');
    expect((await ogw(g.ws, ['loop', 'baseline', 'g'])).stdout).toBe('c2\n');
    const input = await ogw(g.ws, ['loop', 'input', 'g', 'content']);
    expect(input).toMatchObject({ code: 1, stderr: expect.stringContaining('iteration 3 confirms iteration 2') as unknown });
    // a confirm verdict on a confirmation iteration confirms the same candidate again; any other verdict ends it
    await setRun(g, (run) => {
      (run.data.loop as { verdict: unknown }).verdict = { iteration: 3, reason: 'confirm', evidence: [] };
    });
    const fourth = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(fourth.stderr).toBe('');
    expect(fourth.stdout).toBe('iteration 4\nconfirms iteration 2\nkind: completeness\n');
    await setRun(g, (run) => {
      (run.data.loop as { verdict: unknown }).verdict = { iteration: 4, reason: 'continue', evidence: [] };
    });
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 5\nkind: completeness\n');
    // a confirm verdict of an earlier iteration does not make the next one a confirmation iteration
    await setRun(g, (run) => {
      (run.data.loop as { verdict: unknown }).verdict = { iteration: 2, reason: 'confirm', evidence: [] };
    });
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 6\nkind: completeness\n');
    expect(((await currentRun(g)).data.loop as { confirms: unknown }).confirms).toEqual([
      { iteration: 3, candidate: 2 },
      { iteration: 4, candidate: 2 },
    ]);
  });

  it('gives confirm while a resource or translation job of the run is unhandled', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    const checks = ['regression test', 'static check', 'no blocker', 'performance', 'UI quality', 'no placeholder', 'full flow']
      .map((n) => `| ${n} | ${n === 'no placeholder' ? 'fail' : 'pass'} | p |`).join('\n');
    const judges = ['main', 'success', 'success'].map((kind, i) => `### j${String(i)}\n\n- kind: ${kind}\n- vs baseline: better\n- vs reference: pass`).join('\n\n');
    write(g.root, `${R}/iteration-2.md`, `## commit\n\n- instance: c2\n- baseline: none\n\n## checks\n\n| check | result | file |\n|---|---|---|\n${checks}\n\n## judge\n\n${judges}\n`);
    write(g.root, `${R}/defects.json`, { defects: [], previous: null, recordedBy: 'iteration-2' });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout.split('\n')[0]).toBe('success');
    const job = await addJob(g.ws, { status: 'running', meta: { role: 'translation', game: 'g' } });
    const out = await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect(out.stdout.split('\n')[0]).toBe('confirm');
    expect(out.stdout).toContain(`unhandled worker job ${job.id}`);
    await setRun(g, (run) => {
      (run.data.loop as { handled: string[] }).handled = [job.id];
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout.split('\n')[0]).toBe('success');
  });

  it('counts only the worker jobs of the run that the iteration commit has not seen, and no stuck job', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    write(g.root, 'a.txt', 'a');
    const before = commit(g.root, 'merged before');
    write(g.root, 'b.txt', 'b');
    const instance = commit(g.root, 'instance');
    write(g.root, 'c.txt', 'c');
    const after = commit(g.root, 'merged after');
    const checks = ['regression test', 'static check', 'no blocker', 'performance', 'UI quality', 'no placeholder', 'full flow']
      .map((n) => `| ${n} | pass | p |`).join('\n');
    const judges = ['main', 'success', 'success'].map((kind, i) => `### j${String(i)}\n\n- kind: ${kind}\n- vs baseline: better\n- vs reference: pass`).join('\n\n');
    write(g.root, `${R}/iteration-2.md`, `## commit\n\n- instance: ${instance}\n- baseline: none\n\n## checks\n\n| check | result | file |\n|---|---|---|\n${checks}\n\n## judge\n\n${judges}\n`);
    write(g.root, `${R}/defects.json`, { defects: [], previous: null, recordedBy: 'iteration-2' });
    // other roles, a worker job from before the run, a job merged before the instance commit, a stuck job
    for (const role of ['content', 'play', 'judge']) await addJob(g.ws, { status: 'done', meta: { role, game: 'g' } });
    await addJob(g.ws, { status: 'running', startedAt: 0, meta: { role: 'translation', game: 'g' } });
    const seen = await addJob(g.ws, { status: 'done', meta: { role: 'resource', game: 'g' } });
    const stuck = await addJob(g.ws, { status: 'done', meta: { role: 'translation', game: 'g' } });
    const late = await addJob(g.ws, { status: 'done', meta: { role: 'resource', game: 'g' } });
    await setRun(g, (run) => {
      run.data.loop = {
        handled: [seen.id],
        merges: [{ job: seen.id, role: 'resource', before: before, after: before }],
        stuck: [{ job: stuck.id, failure: 'merge of job x failed: no worktree' }],
      };
    });
    const unseen = await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect(unseen.stdout.split('\n')[0]).toBe('confirm');
    expect(unseen.stdout).toContain(`unhandled worker job ${late.id}`);
    expect(unseen.stdout).not.toContain(stuck.id);
    // merged after the instance commit: the iteration did not see it
    await setRun(g, (run) => {
      const data = run.data.loop as { handled: string[]; merges: object[] };
      data.handled.push(late.id);
      data.merges.push({ job: late.id, role: 'resource', before: instance, after });
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout.split('\n')[0]).toBe('confirm');
    await setRun(g, (run) => {
      const data = run.data.loop as { merges: { job: string; after: string }[] };
      data.merges = data.merges.map((m) => (m.job === late.id ? { ...m, after: before } : m));
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout.split('\n')[0]).toBe('success');
  });

  it('gives success from the loop iteration record, not from a newer evaluate file', async () => {
    const g = setupGame({ loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 3, successJudges: 1 } });
    await openLoopRun(g, { iteration: 1 });
    const checks = ['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality', 'no placeholder'];
    const judge = (path: string, kind: string, reference: string): string => `### ${path}\n\n- kind: ${kind}\n- status: done\n- A: a\n- B: b\n- vs baseline: better\n- vs reference: ${reference}\n`;
    const recordText = (reference: string): string => [
      '## checks', '', '| check | result | file |', '|---|---|---|', ...checks.map((c) => `| ${c} | pass | ${R}/check-1.json |`), '',
      '## judge', '', judge(`${R}/judge-1-1.md`, 'main', 'pass'), judge(`${R}/judge-1-2.md`, 'success', reference),
    ].join('\n');
    write(g.root, `${R}/defects.json`, { defects: [], previous: null, recordedBy: 'iteration-1' });
    write(g.root, `${R}/iteration-1.md`, recordText('fail'));
    // check and evaluate files that would give success are not read
    write(g.root, `${R}/check-1.json`, { commit: 'c', checks: checks.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] })), gate: 'pass' });
    write(g.root, `${R}/evaluate-1.json`, {
      commit: 'c', baseline: 'b', plays: [], measure: null,
      judges: [
        judgeOf({ kind: 'main', result: `${R}/judge-1-1.md`, A: 'c', B: 'b', instanceSide: 'A', vsReference: 'pass' }),
        judgeOf({ kind: 'success', result: `${R}/judge-1-2.md`, A: 'c', B: 'b', instanceSide: 'A', vsReference: 'pass' }),
      ],
      ...together({ vsBaseline: 'better', vsReference: 'pass' }),
    });
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe('continue\n');
    write(g.root, `${R}/iteration-1.md`, recordText('pass'));
    expect((await ogw(g.ws, ['loop', 'verdict', 'g'])).stdout).toBe(`success\n${R}/judge-1-1.md\n${R}/judge-1-2.md\n${R}/check-1.json\n`);
  });
});

describe('ogw loop end-record', () => {
  it('needs a stop verdict', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).stderr).toContain('no stop reason');
    await ogw(g.ws, ['loop', 'verdict', 'g']);
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).stderr).toContain('no stop reason');
    // confirm is no stop reason: the next iteration confirms the candidate
    await setRun(g, (run) => {
      run.data.loop = { verdict: { iteration: 1, reason: 'confirm', evidence: [] } };
    });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).stderr).toContain('no stop reason');
  });

  it('writes stopped by human when a person stopped the loop, and only then', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    await setRun(g, (run) => {
      run.data.loop = { verdict: { iteration: 1, reason: 'continue', evidence: [] } };
    });
    const out = await ogw(g.ws, ['loop', 'end-record', 'g', '--stopped-by-human']);
    expect(out.stderr).toBe('');
    expect(read(g.root, `${R}/end.md`)).toContain('## reason\n\nstopped by human\n\n- last verdict: continue (iteration 1)\n');
    await setRun(g, (run) => {
      run.data.loop = { verdict: { iteration: 1, reason: 'plateau', evidence: ['2', '3', '4'] } };
    });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g', '--stopped-by-human'])).stderr).toContain('the loop already stopped with plateau');
  });

  it('writes stopped by human with no verdict yet', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 0 });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g', '--stopped-by-human'])).stderr).toBe('');
    expect(read(g.root, `${R}/end.md`)).toContain('## reason\n\nstopped by human\n\n- last verdict: none\n');
  });

  it('writes the loop end record', async () => {
    const { g, sha } = await iterationOne();
    write(g.root, `${R}/iteration-1.md`, `## commit\n\n- instance: ${sha}\n\n## judge\n\n### j\n\n- kind: main\n- vs baseline: better\n- vs reference: fail\n`);
    write(g.root, `${R}/assumptions.md`, '# assumptions\n\n## speed (needs human)\n\n- decision: d\n- evidence: e\n\n## color\n\n- decision: blue\n- evidence: needs human review\n');
    write(g.root, 'records/core-proposals/9-x.md', 'status: proposed\n');
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,final,unknown\nicon/b,final,MIT\n');
    write(g.root, `${R}/check-1.json`, {
      commit: sha,
      checks: [
        { name: 'no blocker', platform: null, result: 'pass', failures: [], warnings: [] },
        { name: 'static check', platform: null, result: 'pass', failures: [], warnings: [
          { where: 'records/setup/banned-words/ko.txt:1:1', message: 'data check banned_word_missing ko', evidence: [] },
          { where: 'x:1:1', message: 'data check other', evidence: [] },
        ] },
      ],
    });
    write(g.root, `${R}/defects.json`, {
      defects: [
        { id: 'open-one', severity: 'minor', owner: 'data', where: 'w', what: 'broken', why: 'y', evidence: [], source: 'check', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 },
        { id: 'fixed-one', severity: 'minor', owner: 'data', where: 'w', what: 'x', why: 'y', evidence: [], source: 'check', status: 'fixed', refusedReason: null, repeatedDefect: 0, oscillation: 0 },
      ],
      previous: null,
      recordedBy: 'iteration-1',
    });
    commit(g.root);
    write(g.ws.root, 'human.txt', 'check the shop on STG\n\n  \nlook at the icon\n## not a heading\n');
    mocks.placeholderFailures.mockResolvedValue([{ where: 'a', message: 'placeholder icon/z', evidence: [] }]);
    await setRun(g, (run) => {
      run.data.loop = {
        tasks: [{ role: 'resource', input: '/r/1.md', jobs: [], retries: 2, gaveUp: true, lastFailure: 'boom' }],
        handled: [],
        merges: [],
        verdict: { iteration: 1, reason: 'plateau', evidence: ['1', '2'] },
        prepareMerge: { commit: sha, mainHead: 'm', baseCommit: 'm', created: true },
      };
      run.data['core upgrade'] = { version: '1.2.0', skipped: ['1.3.0'] };
    });
    const out = await ogw(g.ws, ['loop', 'end-record', 'g', '--human', 'human.txt'], { cwd: g.ws.root });
    expect(out).toMatchObject({ code: 0, stdout: `${R}/end.md\n` });
    expect(read(g.root, `${R}/end.md`)).toBe(
      [
        '## reason', '', 'plateau', '', '- 1', '- 2', '',
        '## result', '', `- merge commit: ${sha}`, '- vs baseline: better', `- last judge result: ${R}/judge-1-1.md`,
        `- completeness check of iteration 1 (${sha})`, '- no blocker: pass', '- performance: unknown', '- no placeholder: unknown', '- full flow: unknown', '- UI quality: unknown', '',
        '## failures', '', '- placeholder icon/z', `- open defect open-one (found on ${sha}): broken`, '- not given again /r/1.md: boom', '',
        '## human', '', '- needs human: speed (decision: d)', '- core proposal: records/core-proposals/9-x.md', '- license unknown: icon/a',
        '- skipped core version: 1.3.0', '- banned word list missing: ko', '- judge calibration: never run (ogw judge calibrate g; labels: 0, added with ogw judge label g)', '- check the shop on STG', '- look at the icon', '- ## not a heading', '',
      ].join('\n'),
    );
    expect(git(g.root, 'log', '-1', '--name-only', '--format=')).toBe(`${R}/end.md`);
    expect((await ogw(g.ws, ['loop', 'end-record', 'g', '--human', 'missing.txt'])).stderr).toContain('--human file not found');
  });

  it('reads the last iteration files, the merged iteration, and only what the run added or gave up', async () => {
    const g = setupGame({}, { 'records/core-proposals/1-old.md': 'status: proposed\n' });
    await openLoopRun(g, { iteration: 10 });
    const record = (sha: string, vs: string): string => `## commit\n\n- instance: ${sha}\n\n## judge\n\n### j\n\n- kind: main\n- vs baseline: ${vs}\n- vs reference: fail\n`;
    const check = (sha: string, result: string, language: string): object => ({
      commit: sha,
      checks: [
        { name: 'no blocker', platform: null, result, failures: [], warnings: [] },
        { name: 'static check', platform: null, result: 'pass', failures: [], warnings: [
          { where: `records/setup/banned-words/${language}.txt:1:1`, message: `data check banned_word_missing ${language}`, evidence: [] },
        ] },
      ],
    });
    const evaluate = (sha: string, n: number): object => ({
      commit: sha,
      baseline: null,
      plays: [],
      judges: [judgeOf({ kind: 'main', result: `${R}/judge-${String(n)}-1.md`, A: sha, B: null, instanceSide: 'A', vsReference: 'fail' })],
      ...together({ vsReference: 'fail' }),
      measure: null,
    });
    write(g.root, 'game.txt', 'v2');
    const c2 = commit(g.root, 'iteration 2');
    write(g.root, 'game.txt', 'v10');
    const c10 = commit(g.root, 'iteration 10');
    for (const [n, sha, vs, result, language] of [[2, c2, 'same', 'fail', 'ko'], [10, c10, 'better', 'pass', 'ja']] as const) {
      write(g.root, `${R}/iteration-${String(n)}.md`, record(sha, vs));
      write(g.root, `${R}/check-${String(n)}.json`, check(sha, result, language));
      write(g.root, `${R}/evaluate-${String(n)}.json`, evaluate(sha, n));
    }
    write(g.root, 'records/core-proposals/1-old.md', 'status: proposed\nchanged in the run\n');
    write(g.root, 'records/core-proposals/2-new.md', 'status: proposed\n');
    commit(g.root, 'records');
    await setRun(g, (run) => {
      run.data.loop = {
        tasks: [
          { role: 'translation', input: '/t/ko.md', jobs: [], retries: 1, gaveUp: false, lastFailure: 'still trying' },
          { role: 'resource', input: '/r/2.md', jobs: [], retries: 2, gaveUp: true, lastFailure: 'boom' },
        ],
        handled: [],
        merges: [],
        verdict: { iteration: 10, reason: 'limit reached', evidence: [] },
        prepareMerge: { commit: c2, mainHead: 'm', baseCommit: 'm', created: true },
        stuck: [{ job: 'jobx', failure: 'merge of job jobx failed: no worktree' }],
      };
    });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
    const text = read(g.root, `${R}/end.md`);
    const merged = ['no blocker: fail', 'performance: unknown', 'no placeholder: unknown', 'full flow: unknown', 'UI quality: unknown'].map((l) => `- merged iteration ${l}\n`).join('');
    expect(text).toContain(
      `## result\n\n- merge commit: ${c2}\n- vs baseline: same\n- last judge result: ${R}/judge-10-1.md\n- completeness check of iteration 10 (${c10})\n- no blocker: pass\n`
      + `- performance: unknown\n- no placeholder: unknown\n- full flow: unknown\n- UI quality: unknown\n- merged iteration: 2 (${R}/iteration-2.md)\n${merged}\n`,
    );
    expect(text).toContain(`## failures\n\n- defects at the merge commit: the defect table of ${R}/iteration-2.md\n- not given again /r/2.md: boom\n- not merged jobx: merge of job jobx failed: no worktree\n\n`);
    expect(text).toContain(`## human\n\n- core proposal: records/core-proposals/2-new.md\n- banned word list missing: ja\n${NEVER}\n`);
    // with the work synced after the merged commit, its no placeholder result does not hold for the merged tree
    await setRun(g, (run) => {
      (run.data.loop as { prepareMerge: object }).prepareMerge = { commit: c2, withSyncedWork: true, mainHead: 'm', baseCommit: 'm', created: true };
    });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
    const synced = read(g.root, `${R}/end.md`);
    expect(synced).toContain(`- merged iteration: 2 (${R}/iteration-2.md)\n- merged iteration no blocker: fail\n- merged iteration performance: unknown\n- merged iteration full flow: unknown\n`);
    expect(synced).toContain('- merged iteration UI quality: unknown\n- merged tree not checked as a whole\n\n## failures');
    // the same when the commit to merge is the commit of the last check file
    await setRun(g, (run) => {
      (run.data.loop as { prepareMerge: object }).prepareMerge = { commit: c10, withSyncedWork: true, mainHead: 'm', baseCommit: 'm', created: true };
    });
    expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
    const syncedLast = read(g.root, `${R}/end.md`);
    expect(syncedLast).toContain(`- completeness check of iteration 10 (${c10})\n- no blocker: pass\n- performance: unknown\n- full flow: unknown\n- UI quality: unknown\n- merged tree not checked as a whole\n\n## failures`);
    expect(syncedLast).not.toContain('merged iteration:');
  });

  it('lists the resources temporary at the commit to merge, and none without that commit', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/t,temporary,MIT\nicon/u,requested,MIT\n');
    const chosen = commit(g.root, 'iteration 1');
    // a resource job synced after the chosen commit: icon/t final, icon/u and icon/v temporary
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/t,final,MIT\nicon/u,temporary,MIT\nicon/v,temporary,MIT\n');
    commit(g.root, 'synced resource job');
    const human = async (prepareMerge: unknown): Promise<string> => {
      await setRun(g, (run) => {
        run.data.loop = { tasks: [], handled: [], merges: [], verdict: { iteration: 1, reason: 'limit reached', evidence: [] }, prepareMerge };
      });
      expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
      return read(g.root, `${R}/end.md`).split('## human\n\n')[1] ?? '';
    };
    expect(await human({ commit: chosen, mainHead: 'm', baseCommit: 'm', created: true })).toBe(`- temporary resource (the next update game makes it again): icon/t\n${NEVER}\n`);
    expect(await human({ commit: null, mainHead: 'm', baseCommit: 'm', created: true })).toBe(`${NEVER}\n`);
    expect(await human(null)).toBe(`${NEVER}\n`);
  });

  it('writes the rates and recommendations of the last judge calibration report on main, or the label count without one', async () => {
    const g = setupGame();
    write(g.root, 'records/calibration/labels.json', [{ A: 'a', B: 'b', answers: { 'game feel': 'A' }, note: '', at: 1 }]);
    commit(g.root, 'label');
    await openLoopRun(g, { iteration: 1 });
    // a report on the work branch only is not on main
    write(g.root, 'records/calibration/9.md', '## rates\n\n- false win rate: 0.00 (0 of 9)\n');
    commit(g.root, 'not on main');
    const human = async (): Promise<string> => {
      await setRun(g, (run) => {
        run.data.loop = { tasks: [], handled: [], merges: [], verdict: { iteration: 1, reason: 'limit reached', evidence: [] }, prepareMerge: null };
      });
      expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
      return read(g.root, `${R}/end.md`).split('## human\n\n')[1] ?? '';
    };
    expect(await human()).toBe('- judge calibration: never run (ogw judge calibrate g; labels: 1, added with ogw judge label g)\n');
    const rates = '## rates\n\n- false win rate: 0.33 (1 of 3)\n- order consistency: none\n- sensitivity: no\n- human agreement: none\n- labels: 1\n';
    git(g.root, 'checkout', '--quiet', 'main');
    write(g.root, 'records/calibration/100.md', '## rates\n\n- false win rate: 0.00 (0 of 3)\n\n## recommendations\n\nnone\n');
    write(g.root, 'records/calibration/200.md', `${rates}\n## recommendations\n\n- raise loop.judgeVotes to 4 (false win rate 0.33 (1 of 3))\n\n## pairs\n\nnone\n`);
    commit(g.root, 'calibration');
    git(g.root, 'checkout', '--quiet', 'loop/update-1');
    expect(await human()).toBe(
      '- judge calibration: records/calibration/200.md: false win rate: 0.33 (1 of 3); order consistency: none; sensitivity: no; human agreement: none; labels: 1\n'
      + '- judge calibration recommendation: raise loop.judgeVotes to 4 (false win rate 0.33 (1 of 3))\n',
    );
  });

  it('writes why nothing was merged', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    const cases: [unknown, string][] = [
      [null, '- not merged: ogw loop prepare-merge has not run'],
      [{ commit: null, mainHead: 'm2', baseCommit: 'm1', created: false }, '- not merged: main HEAD m2 is not the work branch base m1'],
      [{ commit: null, mainHead: 'm1', baseCommit: 'm1', created: true }, '- not merged: no iteration passed the gate checks'],
      [
        { commit: null, mainHead: 'm1', baseCommit: 'm1', created: false, failed: 'ogw data failed on merge/update-1:\n a.csv:1 bad \n\nboom' },
        '- vs baseline: none\n- not merged: ogw loop prepare-merge failed: ogw data failed on merge/update-1:; a.csv:1 bad; boom\n- last judge',
      ],
    ];
    for (const [prepareMerge, expected] of cases) {
      await setRun(g, (run) => {
        run.data.loop = { tasks: [], handled: [], merges: [], verdict: { iteration: 1, reason: 'limit reached', evidence: [] }, prepareMerge };
      });
      expect((await ogw(g.ws, ['loop', 'end-record', 'g'])).code).toBe(0);
      const text = read(g.root, `${R}/end.md`);
      expect(text).toContain(expected);
      expect(text).toContain('## reason\n\nlimit reached\n\n## result\n\n- merge commit: none\n- vs baseline: none\n');
      expect(text).toContain(`- last judge result: none\n- completeness check: none\n\n## failures\n\nnone\n\n## human\n\n${NEVER}\n`);
    }
  });
});
