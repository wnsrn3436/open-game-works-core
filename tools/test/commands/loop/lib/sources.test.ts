import { describe, expect, it } from 'vitest';
import { checkFindings, hardeningFindings, judgeFindings, measureFindings, playFindings, sortOut } from '../../../../src/commands/loop/lib/findings.ts';
import { judgeMoments, readReference, referenceMoments } from '../../../../src/commands/loop/lib/setup.ts';
import { setupGame, write } from '../helpers.ts';

describe('setup records', () => {
  it('reads judge moments', () => {
    expect(judgeMoments('## judge moments\n\n- `a`: first\n  - `b` (set by lead agent):second\n- `c (set by lead agent)`: third\n- plain: no\n\n## other\n- `d`: x\n')).toEqual([
      { name: 'a', description: 'first' },
      { name: 'b', description: 'second' },
      { name: 'c', description: 'third' },
    ]);
    expect(judgeMoments('nothing')).toEqual([]);
  });

  it('reads the reference moments table and refuses other formats', () => {
    expect(referenceMoments('## moments\n\n| end ms | `start ms` | Video | Moment |\n|---|---|---|---|\n| none | none | none | `x` |\n| 20 | 0 | b.mp4 | y |\n', ['a.mp4', 'b.mp4'])).toEqual([
      { name: 'x', video: null, startMs: null, endMs: null },
      { name: 'y', video: 'b.mp4', startMs: 0, endMs: 20 },
    ]);
    const error = 'records/setup/reference/reference.md';
    const table = (row: string, header = '| moment | video | start ms | end ms |'): string => `## moments\n\n${header}\n|---|---|---|---|\n${row}\n`;
    const videos = ['a.mp4'];
    expect(() => referenceMoments(table('| m | a.mp4 | 5ms | 7 |'), videos)).toThrow(`${error} \`## moments\` cell "5ms" is not in the format of game-setup 8`);
    expect(() => referenceMoments(table('| m | a.mp4 | 1 | |'), videos)).toThrow('cell ""');
    expect(() => referenceMoments(table('| m | a.mp4 | -1 | 2 |'), videos)).toThrow('cell "-1"');
    expect(() => referenceMoments(table('| m | c.mp4 | 1 | 2 |'), videos)).toThrow(`${error} \`## moments\` video "c.mp4" is not in the format`);
    // a moment is in a video exactly when it has both times
    for (const row of ['| m | none | 1 | 2 |', '| m | a.mp4 | none | none |', '| m | a.mp4 | 1 | none |', '| m | none | none | 2 |']) {
      expect(() => referenceMoments(table(row), videos)).toThrow(`${error} \`## moments\` row "m" is not in the format`);
    }
    for (const header of ['| moment | video | start | end ms |', '| moment | video | start ms | end |', '| name | video | start ms | end ms |', '| moment | file | start ms | end ms |']) {
      expect(() => referenceMoments(table('| m | a.mp4 | 1 | 2 |', header), videos)).toThrow(`${error} \`## moments\` header is not in the format`);
    }
    expect(() => referenceMoments('## moments\n\nnone\n', videos)).toThrow(`${error} \`## moments\` is not in the format of game-setup 8`);
    expect(() => referenceMoments('## game\n\nX\n', videos)).toThrow('`## moments` is not');
  });

  it('reads the videos named in `## video`', async () => {
    const g = setupGame();
    const dir = `${g.root}/records/setup/reference`;
    expect(await readReference(g.repo)).toEqual({
      name: 'Hollow Run',
      presentation: 'Hollow Run',
      videos: [`${dir}/hollow.mp4`],
      missingVideos: [],
      moments: [
        { name: 'first 30000ms', video: `${dir}/hollow.mp4`, startMs: 0, endMs: 30000 },
        { name: 'core action', video: `${dir}/hollow.mp4`, startMs: 1000, endMs: 4000 },
        { name: 'first failure', video: null, startMs: null, endMs: null },
      ],
    });
    const moments = '## moments\n\n| moment | video | start ms | end ms |\n|---|---|---|---|\n';
    write(g.root, 'records/setup/reference/reference.md', `## game\n\nX\n\n## video\n\n  hollow.mp4  \nmy run, 2.mp4\n\n${moments}| m | my run, 2.mp4 | 1 | 2 |\n`);
    expect(await readReference(g.repo)).toEqual({
      name: 'X',
      presentation: 'X',
      videos: [`${dir}/hollow.mp4`, `${dir}/my run, 2.mp4`],
      missingVideos: ['my run, 2.mp4'],
      moments: [{ name: 'm', video: `${dir}/my run, 2.mp4`, startMs: 1, endMs: 2 }],
    });
    for (const video of ['dir/hollow.mp4', 'dir\\hollow.mp4', '', 'a.mp4\na.mp4']) {
      write(g.root, 'records/setup/reference/reference.md', `## game\n\nX\n\n## video\n\n${video}\n\n${moments}`);
      await expect(readReference(g.repo)).rejects.toThrow('records/setup/reference/reference.md `## video` is not in the format of game-setup 8');
    }
    write(g.root, 'records/setup/reference/reference.md', `## game\n\nX\n\n${moments}`);
    await expect(readReference(g.repo)).rejects.toThrow('`## video` is not');
  });
  it('reads the presentation game, or the reference game when there is none', async () => {
    const g = setupGame();
    const path = `${g.root}/records/setup/reference/reference.md`;
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('## video', '## presentation game\n\nShiny Quest\n\n## video'));
    expect((await readReference(g.repo))?.presentation).toBe('Shiny Quest');
  });

});

describe('finding sources', () => {
  it('skips passing checks and no placeholder', () => {
    const failure = { where: 'w', message: 'm', evidence: [] };
    const out = checkFindings({
      commit: 'c',
      gate: 'fail',
      checks: [
        { name: 'static check', platform: null, result: 'pass', failures: [failure], warnings: [] },
        { name: 'no placeholder', platform: null, result: 'fail', failures: [failure], warnings: [] },
        { name: 'UI quality', platform: 'web', result: 'fail', failures: [failure], warnings: [] },
      ],
    }, 'c.json');
    expect(out).toEqual([{ source: 'check', severity: null, owner: null, where: 'w', what: 'm', why: null, evidence: ['c.json#UI quality'], id: null, drop: null }]);
    expect(measureFindings({ commit: 'c', targets: [{ metric: 'm', min: 1, max: 2, value: null, result: 'out', data: null }] }, 'm.json')[0]?.what).toBe('value null out of 1..2');
  });

  it('reads play and judge findings', () => {
    const play = playFindings('## observations\n\n1 | s | | | | minor | none\n2 | s | i | h | | major | c.png\n', 'p.md');
    expect(play.map((f) => [f.what, f.why, f.evidence])).toEqual([['', null, ['p.md:3']], ['i → h', null, ['c.png', 'p.md:4']]]);
    expect(sortOut(play).discarded).toHaveLength(1);
    const judge = '## defects\n\n| instance | where | what | why | severity | evidence |\n|---|---|---|---|---|---|\n| A | w | x | | bad | e |\n';
    expect(judgeFindings(judge, 'A', 'j.md')).toEqual([{ source: 'judge', severity: null, owner: null, where: 'w', what: 'x', why: null, evidence: ['e'], id: null, drop: null }]);
    expect(judgeFindings(judge, 'B', 'j.md')).toEqual([]);
  });

  it('reads the failed vs reference rows of this side as major judge findings', () => {
    const judge = [
      '## vs reference',
      '',
      '| instance | element | result | reason | evidence |',
      '|---|---|---|---|---|',
      '| A | `no friction` | fail | four taps before the first serve | frames 0-30000 |',
      '| A | `game feel` | pass | ok | f |',
      '| A | `progression` | fail | no reward | |',
      '| B | `no friction` | fail | other side | f |',
      '',
      '## defects',
      '',
      'none',
      '',
    ].join('\n');
    expect(judgeFindings(judge, 'A', 'j.md')).toEqual([
      { source: 'judge', severity: 'major', owner: null, where: 'vs reference: no friction', what: 'four taps before the first serve', why: 'worse than the reference game, so `vs reference` is `fail`', evidence: ['frames 0-30000', 'j.md'], id: null, drop: null },
      { source: 'judge', severity: 'major', owner: null, where: 'vs reference: progression', what: 'no reward', why: 'worse than the reference game, so `vs reference` is `fail`', evidence: ['j.md'], id: null, drop: null },
    ]);
    expect(judgeFindings(judge, 'B', 'j.md').map((f) => f.what)).toEqual(['other side']);
    // a row without an element has no where: sortOut discards it
    const noElement = '## vs reference\n\n| instance | element | result | reason | evidence |\n|---|---|---|---|---|\n| B |  | fail | slow start | cap.png |\n';
    expect(sortOut(judgeFindings(noElement, 'B', 'j.md')).discarded.map((f) => f.what)).toEqual(['slow start']);
  });

  it('reads hardening fixes with an empty owner', () => {
    const text = '## content agent fixes\n\n| task | `file:line` | Owner | problem |\n|---|---|---|---|\n| fix | a.ts:1 | | wrong |\n| do | b.ts:2 | data | bad |\n';
    expect(hardeningFindings(text, 'h.md')).toEqual([
      { source: 'hardening', severity: null, owner: null, where: 'a.ts:1', what: 'wrong', why: null, evidence: ['h.md'], id: null, drop: null },
      { source: 'hardening', severity: null, owner: 'data', where: 'b.ts:2', what: 'bad', why: null, evidence: ['h.md'], id: null, drop: null },
    ]);
    expect(hardeningFindings('## content agent fixes\n\nnone\n', 'h.md')).toEqual([]);
    expect(hardeningFindings('## unknown\n\nnone\n', 'h.md')).toEqual([]);
    for (const header of ['| file | owner | problem | task |', '| file:line | who | problem | task |', '| file:line | owner | issue | task |', '| file:line | owner | problem | todo |']) {
      expect(() => hardeningFindings(`## content agent fixes\n\n${header}\n|---|---|---|---|\n| a | b | c | d |\n`, 'h.md'))
        .toThrow('h.md `## content agent fixes` needs the columns file:line, owner, problem, task');
    }
  });
});
