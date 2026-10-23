import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addReproductionLine, withReproductionLine } from '../../../../src/commands/clone/lib/record.ts';
import { importResult, resultLine } from '../../../../src/commands/clone/lib/result.ts';

const L = '- line';

describe('withReproductionLine', () => {
  it.each([
    ['', `## reproduction\n\n${L}\n`],
    ['a\n', `a\n\n## reproduction\n\n${L}\n`],
    ['a\n\n\n', `a\n\n## reproduction\n\n${L}\n`],
    ['a', `a\n\n## reproduction\n\n${L}\n`],
    ['## reproduction\n', `## reproduction\n\n${L}\n`],
    ['## reproduction', `## reproduction\n\n${L}\n`],
    ['## reproduction\n- a\n', `## reproduction\n- a\n${L}\n`],
    ['## reproduction\n- a', `## reproduction\n- a\n${L}\n`],
    ['## reproduction\n\n- a\n\n\n## next\nx\n', `## reproduction\n\n- a\n${L}\n\n\n## next\nx\n`],
    ['## reproduction\n- a\n## next\n', `## reproduction\n- a\n${L}\n\n## next\n`],
    ['## reproduction\n\n## next\n', `## reproduction\n\n${L}\n\n## next\n`],
    ['## reproduction\n## next\n', `## reproduction\n\n${L}\n\n## next\n`],
    ['## reproduction\n- a\n### detail\n- b\n# top\n', `## reproduction\n- a\n### detail\n- b\n${L}\n\n# top\n`],
    ['## reproductions\n- a\n', `## reproductions\n- a\n\n## reproduction\n\n${L}\n`],
    ["x\n## reproduction\n  \n", `x\n## reproduction\n\n${L}\n  \n`],
  ])('adds the line to %j', (text, expected) => {
    expect(withReproductionLine(text, L)).toBe(expected);
  });
});

describe('resultLine', () => {
  it('adds the data versions only when they do not match', () => {
    expect(resultLine({ replacedRecords: 4, dataVersionMatches: true, dataVersion: 'b' }, 'a', 'instance')).toBe(
      'replaced_records 4, data_version_matches true',
    );
    expect(resultLine({ replacedRecords: 0, dataVersionMatches: false, dataVersion: 'b' }, 'a', 'STG')).toBe(
      'replaced_records 0, data_version_matches false, snapshot data_version a, STG data_version b',
    );
  });
});

describe('importResult', () => {
  it('reads the import output', () => {
    expect(importResult({ replaced_records: 1, data_version_matches: false, data_version: 'v' })).toEqual({
      replacedRecords: 1,
      dataVersionMatches: false,
      dataVersion: 'v',
    });
  });
});

describe('addReproductionLine', () => {
  it('keeps the lines of commands that add at the same time and leaves no lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-record-'));
    const repo = { name: 'g', root: dir, mainRoot: dir, commonDir: join(dir, '.git'), inWorktree: false };
    const path = join(dir, 'request.md');
    writeFileSync(path, 'r\n');
    await Promise.all(['- a', '- b', '- c'].map((line) => addReproductionLine(repo, path, line)));
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines.slice(0, 4)).toEqual(['r', '', '## reproduction', '']);
    expect(lines.slice(4, 7).sort()).toEqual(['- a', '- b', '- c']);
    expect(existsSync(join(dir, '.git', 'ogw-reproduction.lock'))).toBe(false);
  });
});
