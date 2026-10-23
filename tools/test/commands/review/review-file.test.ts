import { describe, expect, it } from 'vitest';
import { debtMismatch, outOfScopeItem, parseReviewFile, urgentOutOfScope } from '../../../src/commands/review/lib/review-file.ts';

const DEBT_HEAD = '| id | result | finding | evidence |\n|---|---|---|---|';

describe('parseReviewFile', () => {
  it('reads `none` with a note after it as an empty section, and still refuses other text', () => {
    const file = (previous: string): string => `# review: x round 3\n\n## findings\n\nnone\n\n## previous\n\n${previous}\n\n## out of scope\n\nnone\n\n## debt\n\nnone\n\n## must fix\n\nnone\n\n## unknown\n\nnone\n`;
    expect(parseReviewFile(file('none. Round 2 (`x-2.md`) had no findings'))).toEqual({ findings: [], previous: [], outOfScope: [], debt: [], mustFix: [] });
    expect(parseReviewFile(file('none'))).toEqual({ findings: [], previous: [], outOfScope: [], debt: [], mustFix: [] });
    expect(parseReviewFile(file('nothing changed'))).toBeNull();
    expect(parseReviewFile(file('nonesuch'))).toBeNull();
  });

  it('reads `\\|` in a cell as `|`, and refuses a row whose unescaped `|` adds cells', () => {
    const file = (cell: string): string => [
      '# review: x round 4', '', '## findings', '',
      '| id | aspect | severity | location | evidence | fix | spec change | confidence |',
      '|---|---|---|---|---|---|---|---|',
      `| R4-1 | structure | medium | a.ts:1 | ${cell} | use one | no | 80 |`, '',
      '## previous', '', '| id | result | evidence |', '|---|---|---|', '| R3-1 | fixed | gone |', '',
      '## out of scope', '', 'none', '',
      '## debt', '', 'none', '',
      '## must fix', '', 'none', '',
      '## unknown', '', 'none', '',
    ].join('\n');
    const parsed = parseReviewFile(file('`x \\|\\| y` repeats'));
    expect(parsed?.findings.map((f) => [f.id, f.evidence, f.specChange])).toEqual([['R4-1', '`x || y` repeats', 'no']]);
    // a `|` written unescaped shifts the cells after it: the file is not in the form
    expect(parseReviewFile(file('`x || y` repeats'))).toBeNull();
  });

  it('reads the out of scope list and refuses a review file without it or with other lines in it', () => {
    const file = (outOfScope: string | null): string =>
      `## findings\n\nnone\n\n## previous\n\nnone\n\n${outOfScope === null ? '' : `## out of scope\n\n${outOfScope}\n\n`}## debt\n\nnone\n\n## must fix\n\nnone\n\n## unknown\n\nnone\n`;
    expect(parseReviewFile(file('- a.ts:3: high old bug\n- src/b.ts:9: critical slow loop\n- c.ts:1: medium odd name'))?.outOfScope).toEqual(['a.ts:3: high old bug', 'src/b.ts:9: critical slow loop', 'c.ts:1: medium odd name']);
    // a review agent writes a mark right after the severity
    expect(parseReviewFile(file('- a.ts:3: high. old bug\n- b.ts:4: critical: slow loop'))?.outOfScope).toEqual(['a.ts:3: high. old bug', 'b.ts:4: critical: slow loop']);
    expect(parseReviewFile(file(null))).toBeNull();
    expect(parseReviewFile(file('a.ts:3: high old bug'))).toBeNull();
  });

  it('refuses an out of scope item of the low severity or in no form, and takes it only in a file of an earlier form', () => {
    const file = (item: string): string => `## findings\n\nnone\n\n## previous\n\nnone\n\n## out of scope\n\n- ${item}\n\n## debt\n\nnone\n\n## must fix\n\nnone\n\n## unknown\n\nnone\n`;
    for (const item of ['a.ts:3: low old bug', 'a.ts:3: old bug', 'a.ts: high old bug', 'a.ts:3: high', 'a.ts:3 high old bug']) {
      expect(parseReviewFile(file(item)), item).toBeNull();
      expect(parseReviewFile(file(item), { earlier: true })?.outOfScope, item).toEqual([item]);
    }
  });

  it('takes a low finding only in a review of the whole target, and a duplication finding only in a file of an earlier form', () => {
    const file = (row: string): string =>
      `## findings\n\n| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|\n${row}\n\n## previous\n\nnone\n\n## out of scope\n\nnone\n\n## debt\n\nnone\n\n## must fix\n\nnone\n\n## unknown\n\nnone\n`;
    expect(parseReviewFile(file('| R1-1 | structure | medium | a.ts:1 | x | y | no | 80 |'))?.findings).toHaveLength(1);
    expect(parseReviewFile(file('| R1-1 | duplication | medium | a.ts:1 | x | y | no | 80 |'))).toBeNull();
    expect(parseReviewFile(file('| R1-1 | structure | low | a.ts:1 | x | y | no | 80 |'))).toBeNull();
    expect(parseReviewFile(file('| R1-1 | structure | low | a.ts:1 | x | y | no | 80 |'), { low: true })?.findings.map((f) => f.severity)).toEqual(['low']);
    expect(parseReviewFile(file('| R1-1 | duplication | low | a.ts:1 | x | y | no | 80 |'), { earlier: true })?.findings.map((f) => [f.aspect, f.severity])).toEqual([['duplication', 'low']]);
    expect(parseReviewFile(file('| R1-1 | style | low | a.ts:1 | x | y | no | 80 |'), { earlier: true })).toBeNull();
  });

  it('reads the debt table, refuses a file without it or with a row in no form, and takes its absence in a file of an earlier form', () => {
    const file = (debt: string | null, mustFix: string | null = 'none'): string =>
      `## findings\n\nnone\n\n## previous\n\nnone\n\n## out of scope\n\nnone\n\n${debt === null ? '' : `## debt\n\n${debt}\n\n`}${mustFix === null ? '' : `## must fix\n\n${mustFix}\n\n`}## unknown\n\nnone\n`;
    expect(parseReviewFile(file(`${DEBT_HEAD}\n| D2 | fixed | none | gone |\n| D5 | open | R3-1 | still there |`))?.debt).toEqual([
      { id: 'D2', result: 'fixed', finding: null, evidence: 'gone' },
      { id: 'D5', result: 'open', finding: 'R3-1', evidence: 'still there' },
    ]);
    expect(parseReviewFile(file(null))).toBeNull();
    expect(parseReviewFile(file('none', null))).toBeNull();
    expect(parseReviewFile(file(null, null), { earlier: true })?.debt).toEqual([]);
    // a must-fix table takes `M` ids, a debt table `D` ids
    expect(parseReviewFile(file('none', `${DEBT_HEAD}\n| M1 | open | R1-1 | still |`))?.mustFix).toEqual([{ id: 'M1', result: 'open', finding: 'R1-1', evidence: 'still' }]);
    expect(parseReviewFile(file('none', `${DEBT_HEAD}\n| D1 | fixed | none | x |`))).toBeNull();
    expect(parseReviewFile(file(`${DEBT_HEAD}\n| M1 | fixed | none | x |`))).toBeNull();
    for (const row of ['| R1-1 | fixed | none | x |', '| D1 | gone | none | x |', '| D1 | open | D2 | x |']) {
      expect(parseReviewFile(file(`${DEBT_HEAD}\n${row}`)), row).toBeNull();
    }
  });
});

describe('debtMismatch', () => {
  const file = (debt: string[], findings: string[] = [], previous: string[] = [], mustFix: string[] = []): NonNullable<ReturnType<typeof parseReviewFile>> => {
    const table = (head: string, rows: string[]): string => (rows.length === 0 ? 'none' : `${head}\n${rows.join('\n')}`);
    const text = [
      '## findings', '', table('| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|', findings), '',
      '## previous', '', table('| id | result | evidence |\n|---|---|---|', previous), '',
      '## out of scope', '', 'none', '',
      '## debt', '', table(DEBT_HEAD, debt), '',
      '## must fix', '', table(DEBT_HEAD, mustFix), '',
      '## unknown', '', 'none', '',
    ].join('\n');
    const parsed = parseReviewFile(text);
    if (parsed === null) throw new Error('fixture not in the form');
    return parsed;
  };

  it('takes one row for each given item, and an open row naming an open finding of the file', () => {
    const finding = '| R2-1 | correctness | medium | a.ts:1 | x | y | no | 90 |';
    expect(debtMismatch(file([]), { debt: [], mustFix: [] })).toBeNull();
    expect(debtMismatch(file(['| D1 | fixed | none | gone |', '| D3 | open | R2-1 | left |'], [finding]), { debt: ['D1', 'D3'], mustFix: [] })).toBeNull();
    // an open debt item carried by a previous finding still open
    expect(debtMismatch(file(['| D3 | open | R1-2 | left |'], [], ['| R1-2 | open | left |']), { debt: ['D3'], mustFix: [] })).toBeNull();
  });

  it('refuses a missing, extra or repeated row, and an open row without an open finding', () => {
    expect(debtMismatch(file([]), { debt: ['D1'], mustFix: [] })).toMatch(/do not answer the debt items D1/);
    expect(debtMismatch(file(['| D1 | fixed | none | x |']), { debt: [], mustFix: [] })).toMatch(/do not answer/);
    expect(debtMismatch(file(['| D1 | fixed | none | x |', '| D1 | fixed | none | x |']), { debt: ['D1'], mustFix: [] })).toMatch(/do not answer/);
    expect(debtMismatch(file(['| D1 | open | none | x |']), { debt: ['D1'], mustFix: [] })).toMatch(/D1 are open without an open finding/);
    expect(debtMismatch(file(['| D1 | open | R1-2 | x |'], [], ['| R1-2 | fixed | x |']), { debt: ['D1'], mustFix: [] })).toMatch(/without an open finding/);
    // the must-fix table answers the must-fix items the same way
    expect(debtMismatch(file([]), { debt: [], mustFix: ['M2'] })).toMatch(/## must fix rows none do not answer the must fix items M2/);
    expect(debtMismatch(file([], [], [], ['| M2 | open | none | x |']), { debt: [], mustFix: ['M2'] })).toMatch(/## must fix rows M2 are open without an open finding/);
    expect(debtMismatch(file([], [], [], ['| M2 | fixed | none | gone |']), { debt: [], mustFix: ['M2'] })).toBeNull();
  });
});

describe('out of scope items', () => {
  it('reads location, severity and problem, and asks a fix at once for critical and high only', () => {
    expect(outOfScopeItem('server/core/a/x.ts:12: medium. slow loop')).toEqual({ location: 'server/core/a/x.ts:12', severity: 'medium', problem: 'slow loop' });
    expect(outOfScopeItem('x.ts:1: low y')).toBeNull();
    expect(urgentOutOfScope('x.ts:1: high y')).toBe(true);
    expect(urgentOutOfScope('x.ts:1: critical y')).toBe(true);
    expect(urgentOutOfScope('x.ts:1: medium y')).toBe(false);
    // an item of an earlier form had critical or high only
    expect(urgentOutOfScope('some old line')).toBe(true);
  });
});
