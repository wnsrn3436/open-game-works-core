import { describe, expect, it } from 'vitest';
import {
  appendCoverage,
  judgeDefects,
  judgeSectionText,
  judgeVerdict,
  observations,
  referenceRows,
  vsBaselineOf,
  vsReferenceOf,
} from '../../../../src/commands/loop/lib/results.ts';

function judge(baselineRows: string[], referenceRows: string[]): string {
  return [
    '## vs baseline',
    '',
    '| element | winner | margin | reason | evidence |',
    '|---|---|---|---|---|',
    ...baselineRows,
    '',
    '## vs reference',
    '',
    '| instance | element | result | reason | evidence |',
    '|---|---|---|---|---|',
    ...referenceRows,
    '',
    '## moments',
    '',
    '`A` is better at core action. reason: x',
    '',
    '## loser better',
    '',
    'B had sound',
    '',
    '## defects',
    '',
    '| instance | where | what | why | severity | evidence |',
    '|---|---|---|---|---|---|',
    '| A | lobby | button hidden | cannot start | major | cap.png |',
    '| B | shop | slow | waits | minor | |',
  ].join('\n');
}

describe('vs baseline', () => {
  it('counts element winners from the side of this instance', () => {
    const rows = ['| game feel | A | clear | r | e |', '| progression | A | slight | r | e |', '| no friction | B | slight | r | e |'];
    expect(vsBaselineOf(judge(rows, []), 'A')).toBe('better');
    expect(vsBaselineOf(judge(rows, []), 'B')).toBe('worse');
  });

  it('is not better with a decisive loss, and ignores n/a and indistinguishable', () => {
    const rows = ['| game feel | A | clear | r | e |', '| progression | A | slight | r | e |', '| no friction | B | decisive | r | e |'];
    expect(vsBaselineOf(judge(rows, []), 'A')).toBe('indistinguishable');
    const even = ['| game feel | A | clear | r | e |', '| progression | B | slight | r | e |', '| x | n/a | | r | e |', '| y | indistinguishable | slight | r | e |'];
    expect(vsBaselineOf(judge(even, []), 'A')).toBe('indistinguishable');
    expect(vsBaselineOf(judge([], []), 'A')).toBe('indistinguishable');
  });

  it('throws when the table cannot be read', () => {
    expect(() => vsBaselineOf('## vs baseline\n\nnone\n', 'A')).toThrow('table missing');
    expect(() => vsBaselineOf('nothing', 'A')).toThrow('table missing');
    expect(() => vsBaselineOf('## vs baseline\n\n| element | margin |\n|---|---|\n', 'A')).toThrow('columns missing');
    expect(() => vsBaselineOf(judge(['| game feel | C | clear | r | e |'], []), 'A')).toThrow('unknown winner C');
  });
});

describe('vs reference', () => {
  it('passes only when every counted row of this side passes', () => {
    const pass = ['| A | game feel | pass | r | e |', '| A | progression | n/a | r | e |', '| B | game feel | fail | r | e |'];
    expect(vsReferenceOf(judge([], pass), 'A')).toBe('pass');
    expect(vsReferenceOf(judge([], pass), 'B')).toBe('fail');
    expect(vsReferenceOf(judge([], ['| A | game feel | pass | r | e |', '| A | x | unknown | r | e |']), 'A')).toBe('unknown');
    expect(vsReferenceOf(judge([], ['| A | game feel | n/a | r | e |']), 'A')).toBe('unknown');
    expect(vsReferenceOf(judge([], ['| A | game feel | unknown | r | e |', '| A | x | fail | r | e |']), 'A')).toBe('fail');
  });

  it('reads the table with instance columns when a presentation counts table comes first', () => {
    const text = judge([], ['| A | game feel | pass | r | e |', '| B | game feel | fail | r | e |']).replace(
      '## vs reference\n\n',
      '## vs reference\n\n### presentation counts\n\n| screen | panel layers | idle motion | press feedback |\n|---|---|---|---|\n| lobby | 3 | 2 | 1 |\n\n',
    );
    expect(vsReferenceOf(text, 'A')).toBe('pass');
    expect(referenceRows(text).map((r) => [r.instance, r.result])).toEqual([['A', 'pass'], ['B', 'fail']]);
  });

  it('throws when the table cannot be read', () => {
    expect(() => vsReferenceOf('', 'A')).toThrow('table missing');
    expect(() => vsReferenceOf('## vs reference\n\n| instance | result |\n|---|---|\n', 'A')).toThrow('columns missing');
    expect(() => vsReferenceOf(judge([], ['| A | game feel | maybe | r | e |']), 'A')).toThrow('unknown result maybe');
  });

  it('judgeVerdict skips vs baseline without a baseline', () => {
    const text = judge(['| game feel | A | clear | r | e |'], ['| A | game feel | pass | r | e |']);
    expect(judgeVerdict(text, 'A', false)).toEqual({ vsBaseline: null, vsReference: 'pass' });
    expect(judgeVerdict(text, 'A', true)).toEqual({ vsBaseline: 'better', vsReference: 'pass' });
  });
});

describe('judge sections', () => {
  it('reads defects, moments and loser better', () => {
    const text = judge([], []);
    expect(judgeDefects(text)).toEqual([
      { instance: 'A', where: 'lobby', what: 'button hidden', why: 'cannot start', severity: 'major', evidence: 'cap.png' },
      { instance: 'B', where: 'shop', what: 'slow', why: 'waits', severity: 'minor', evidence: '' },
    ]);
    expect(judgeDefects('## defects\n\nnone\n')).toEqual([]);
    expect(judgeSectionText(text, 'moments')).toBe('`A` is better at core action. reason: x');
    expect(judgeSectionText(text, 'loser better')).toBe('B had sound');
    expect(judgeSectionText('', 'moments')).toBe('none');
  });
});

describe('play feedback', () => {
  const feedback = [
    '## coverage',
    '',
    'unknown: shop',
    '',
    '## observations',
    '',
    '| elapsed ms | scene | input | what happened | feeling or problem | severity | capture path |',
    '|---|---|---|---|---|---|---|',
    '1200 | lobby | tap start | nothing | stuck | blocker | cap/1.png',
    '- 3400 | run | jump | fell | unfair | severity: major |',
    'not an observation',
    '| 5000 | run | swipe | turned | ok | none | cap/2.png |',
    '6000 | boss | hit | froze | stuck | blocker',
    '7000 | broken row',
    '',
    '## reproduce',
    '9 | a | b | c | d | major | e',
  ].join('\n');

  it('reads observation lines with their line numbers', () => {
    expect(observations(feedback)).toEqual([
      { line: 9, elapsed: '1200', scene: 'lobby', input: 'tap start', happened: 'nothing', feeling: 'stuck', severity: 'blocker', capture: 'cap/1.png' },
      { line: 10, elapsed: '3400', scene: 'run', input: 'jump', happened: 'fell', feeling: 'unfair', severity: 'major', capture: '' },
      { line: 12, elapsed: '5000', scene: 'run', input: 'swipe', happened: 'turned', feeling: 'ok', severity: 'none', capture: 'cap/2.png' },
      { line: 13, elapsed: '6000', scene: 'boss', input: 'hit', happened: 'froze', feeling: 'stuck', severity: 'blocker', capture: '' },
      { line: 14, elapsed: '', scene: '', input: '', happened: '7000 | broken row', feeling: '', severity: '', capture: '' },
    ]);
    expect(observations('no section')).toEqual([]);
  });

  it('appends telemetry lines at the end of `## coverage`', () => {
    expect(appendCoverage(feedback, ['device ms: 9'])).toBe(feedback.replace('unknown: shop\n', 'unknown: shop\ndevice ms: 9\n'));
    expect(appendCoverage('## coverage\n\n## observations\n', ['t'])).toBe('## coverage\n\nt\n\n## observations\n');
    expect(appendCoverage('## coverage\nx\n', ['t'])).toBe('## coverage\nx\nt\n');
    expect(appendCoverage('## observations\n', ['t'])).toBe('## observations\n\n## coverage\n\nt\n');
    expect(appendCoverage('', ['t'])).toBe('## coverage\n\nt\n');
    expect(appendCoverage('## observations', ['t'])).toBe('## observations\n\n## coverage\n\nt\n');
  });
});
