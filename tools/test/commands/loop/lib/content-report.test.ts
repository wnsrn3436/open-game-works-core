import { describe, expect, it } from 'vitest';
import { readReportRows, reportRows } from '../../../../src/commands/loop/lib/record.ts';
import { hypothesisMomentName } from '../../../../src/commands/loop/lib/setup.ts';

describe('content agent report', () => {
  const table = (rows: string[], header = '| id | result | note |'): string => `## defects\n\n${header}\n|---|---|---|\n${rows.join('\n')}\n`;

  it('reads the defects rows that ogw loop record takes, and lists what is not in the form of the report', () => {
    expect(readReportRows(table(['| d1 | fixed | |', '| d2 | `refused` | breaks the brief |']))).toEqual({
      rows: new Map([['d1', { result: 'fixed', note: '', tests: [] }], ['d2', { result: 'refused', note: 'breaks the brief', tests: [] }]]),
      errors: [],
    });
    // the test names of a fixed row are the code spans of its note, also when the note is one code span
    const named = reportRows(table(['| d1 | fixed | `client/tests/a.gd::test_a`, `server/tests/s.test.ts::shop > buys` |', '| d2 | fixed | `client/tests/b.gd::test_b` |']));
    expect([...named.values()].map((row) => row.tests)).toEqual([['client/tests/a.gd::test_a', 'server/tests/s.test.ts::shop > buys'], ['client/tests/b.gd::test_b']]);
    expect(readReportRows('## defects\n\nnone. nothing was open\n')).toEqual({ rows: new Map(), errors: [] });
    expect(readReportRows('## unknown\n\nnone\n').errors).toEqual(['`## defects` is missing']);
    expect(readReportRows('## defects\n\nd1 fixed\n').errors).toEqual(['`## defects` is neither `none` nor a table with the columns id, result, note']);
    expect(readReportRows(table(['| d1 | done | |', '| d2 | not done | later |'])).errors).toEqual(['`## defects` row d1: result `done` is not one of fixed, refused, not reproduced, not done']);
    expect(readReportRows(table(['| d1 | fixed |'], '| id | result |')).errors).toEqual(['`## defects` columns missing: it needs id, result, note']);
    // ogw loop record reads the rows as before, whatever the errors
    expect(reportRows(table(['| d1 | done | |']))).toEqual(new Map([['d1', { result: 'done', note: '', tests: [] }]]));
  });

  it('reads the moment of the hypothesis as ogw loop evaluate does', () => {
    expect(hypothesisMomentName('## hypothesis\n\n- element: game feel\n- moment: `boss`\n')).toBe('boss');
    expect(hypothesisMomentName('## hypothesis\n\n- moment: none\n')).toBe('none');
    expect(hypothesisMomentName('## hypothesis\n\n- element: game feel\n\n## defects\n\n- moment: boss\n')).toBeNull();
  });
});
