import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameLocation } from '../../../src/commands/review/lib/debt.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';
import { reviewFile } from './helpers.ts';
import { d1, ids, inputSection, low, readList, reviewer, seedList } from './debt-fixture.ts';
import { next, wait } from './review-fixture.ts';

describe('ogw review: core lists', () => {
  it('records an out of scope item in the list of the module whose folder holds it, on main of open-game-works-core-impl', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- server/core/storage/a.ts:3: medium a missing check', '- src/x.ts:1: high an old crash']) });
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe([
      'result: done', 'round: 1', 'out of scope: src/x.ts:1: high an old crash',
      'review debt added: storage D1: server/core/storage/a.ts:3: medium a missing check',
      'review must fix added: routing M1: src/x.ts:1: high an old crash', '',
    ].join('\n'));
    expect(readList(ws.coreImpl, 'debt', 'storage.json')?.items.map((item) => [item.id, item.foundBy])).toEqual([['D1', 'routing round 1']]);
    expect(ids(ws.coreImpl, 'must fix', 'routing.json')).toEqual(['M1']);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s', 'main']).trim()).toBe('ogw: review lists of routing round 1');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('gives a finding and an out of scope line in a game file as game impact lines, not as findings or list items', async () => {
    const ws = makeWorkspace();
    const gameFinding = '| R1-1 | `correctness` | high | games/pong/resource/tween/hit.tres:10 | z is 1 | set 0 | no | 90 |';
    const env = reviewer(ws, {
      1: reviewFile([gameFinding], [], ['- games/pong/resource/tween/hit.tres:22: high z is 1 in a 2D Scale', '- src/x.ts:1: high an old crash']),
      2: reviewFile([], ['| R1-1 | open | still 1 |'], [], [], ['| M1 | fixed | none | gone |']),
    });
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe([
      'result: done', 'round: 1', 'out of scope: src/x.ts:1: high an old crash',
      'game impact: games/pong/resource/tween/hit.tres:10: high R1-1 z is 1',
      'game impact: games/pong/resource/tween/hit.tres:22: high z is 1 in a 2D Scale',
      'review must fix added: routing M1: src/x.ts:1: high an old crash', '',
    ].join('\n'));
    expect(ids(ws.coreImpl, 'must fix', 'routing.json')).toEqual(['M1']);
    // a later round (the must-fix round of M1) that answers the game finding open does not count it either
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: done\nround: 2\n/);
  });

  it('takes a file of a game repo as a game location, absolute or from the folder that holds the games, and no checkout file', () => {
    const ws = makeWorkspace();
    expect(gameLocation(join(ws.games, 'pong', 'a.tres:3'), ws.games, ws.coreImpl, ws.root)).toBe(true);
    expect(gameLocation('games/pong/a.tres:3', ws.games, ws.coreImpl, ws.root)).toBe(true);
    expect(gameLocation('server/core/storage/a.ts:3', ws.games, ws.coreImpl, ws.root)).toBe(false);
    expect(gameLocation(join(ws.coreImpl, 'server', 'a.ts:3'), ws.games, ws.coreImpl, ws.root)).toBe(false);
    // a games folder that is not directly under the workspace root: a relative location is read from the root
    expect(gameLocation('repos/games/pong/a.tres:3', join(ws.root, 'repos', 'games'), ws.coreImpl, ws.root)).toBe(true);
    expect(gameLocation('games/pong/a.tres:3', join(ws.root, 'repos', 'games'), ws.coreImpl, ws.root)).toBe(false);
    // a checkout file of the same relative path is the checkout's
    mkdirSync(join(ws.coreImpl, 'games', 'pong'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'games', 'pong', 'a.tres'), '');
    expect(gameLocation('games/pong/a.tres:3', ws.games, ws.coreImpl, ws.root)).toBe(false);
  });

  it('pays the debt in a review of the whole target: --full after done, with low findings, from no state or after done only', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- src/b.ts:9: medium a slow loop']), 2: reviewFile([low('R2-1')], [], [], ['| D1 | open | R2-1 | still |']) });
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('review debt added: routing D1: src/b.ts:9: medium a slow loop\n');
    expect((await next(ws, ['core', 'routing', '--full', '--since', 'HEAD'], env)).stderr).toContain('usage: ogw review next core');
    await next(ws, ['core', 'routing', '--full'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toBe('none');
    expect(inputSection(ws.coreImpl, 'routing', 2, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: fix\nround: 2\nopen finding: R2-1 structure low src\/a.ts:3/);
    // a review that did not end takes no --full
    expect((await next(ws, ['core', 'routing', '--full'], env)).stderr).toContain('--full of routing needs no review state or a review that ended (done or fixed)');
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { whole?: boolean; fixBase: string | null; paysDebt?: boolean }[]; full?: boolean };
    // the option is used once its round is judged; the reviews of the whole target pay debt
    expect(state.rounds.map((r) => [r.whole, r.fixBase, r.paysDebt])).toEqual([[true, null, true], [true, null, true]]);
    expect(state.full).toBeUndefined();
  });

  it('reviews a module new since --since whole, and the changes of a module that was there without debt or low findings', async () => {
    const ws = makeWorkspace();
    seedList(ws.coreImpl, 'debt', 'routing.json', { target: 'routing', nextId: 2, items: [{ ...d1, foundBy: 'x round 1' }] });
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    sh(ws.coreImpl, 'mkdir', ['-p', 'server/core/routing']);
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    const main = commitAll(ws.coreImpl, 'change');
    const env = reviewer(ws, { 1: reviewFile([low('R1-1')]), 2: reviewFile([]), 3: reviewFile([], [], [], ['| D1 | fixed | none | gone |']) });
    await next(ws, ['core', 'routing', '--since', since], env);
    expect(inputSection(ws.coreImpl, 'routing', 1, 'commit range')).toBe(`${since}..${main}`);
    expect(inputSection(ws.coreImpl, 'routing', 1, 'debt')).toBe('none');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: invalid\nround: 1\n');
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
    expect((await ogw(ws, ['review', 'clear', 'core'])).code).toBe(0);
    // routing has no folder at `before`: a module new since it is reviewed whole, and pays its debt
    await next(ws, ['core', 'routing', '--since', before], env);
    expect(inputSection(ws.coreImpl, 'routing', 1, 'commit range')).toBe('none');
    expect(inputSection(ws.coreImpl, 'routing', 1, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\nreview debt removed: routing D1\n');
  });

  it('lets an option given after an invalid --debt round decide the next round, and pays no debt in the must-fix round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([], [], ['- src/b.ts:9: medium a slow loop', '- src/c.ts:2: medium a missing check']),
      2: reviewFile([]),
      3: reviewFile([], [], [], ['| D1 | fixed | none | gone |', '| D2 | open | R2-1 | x |']),
      4: reviewFile([], [], [], ['| D1 | fixed | none | gone |', '| D2 | fixed | none | gone |']),
      5: reviewFile([], [], [], [], ['| M1 | fixed | none | gone |']),
    });
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('review debt added: routing D1');
    // a --debt round whose review file does not answer D1 and D2 is dropped as invalid
    await next(ws, ['core', 'routing', '--debt'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    // --full given now decides: the whole target, which pays the debt; an open row without its finding is invalid too
    await next(ws, ['core', 'routing', '--full'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toBe('none');
    expect(inputSection(ws.coreImpl, 'routing', 2, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop\n- D2: src/c.ts:2: medium a missing check');
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    // the kept --full starts the round again
    await next(ws, ['core', 'routing'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toBe('none');
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: done\nround: 2\n/);
    // the must-fix round: the changes since the review ended, with no debt
    const round2 = (JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] }).rounds[1]?.startCommit as string;
    writeFileSync(join(ws.coreImpl, 'records', 'review-debt', 'routing.json'), JSON.stringify({ target: 'routing', nextId: 4, items: [{ ...d1, id: 'D3' }] }));
    mkdirSync(join(ws.coreImpl, 'records', 'review-must-fix'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'records', 'review-must-fix', 'routing.json'), JSON.stringify({ target: 'routing', nextId: 2, items: [{ id: 'M1', severity: 'high', location: 'src/d.ts:1', problem: 'a crash', foundBy: 'x round 1' }] }));
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    // the review agent jobs put the ogw pre-commit hook in open-game-works-core-impl: the test commits without it
    sh(ws.coreImpl, 'git', ['add', '--all']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', 'routing change']);
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await next(ws, ['core', 'routing'], env);
    expect(inputSection(ws.coreImpl, 'routing', 3, 'commit range')).toBe(`${round2}..${main}`);
    expect(inputSection(ws.coreImpl, 'routing', 3, 'debt')).toBe('none');
    expect(inputSection(ws.coreImpl, 'routing', 3, 'must fix')).toBe('- M1: src/d.ts:1: high a crash');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 3\nreview must fix removed: routing M1\n');
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { full?: boolean; debtReview?: boolean; rounds: { paysDebt?: boolean }[] };
    expect([state.full, state.debtReview, state.rounds.at(-1)?.paysDebt]).toEqual([undefined, undefined, false]);
  });

  it('lets --respec after an invalid --debt round go on with its own review, which pays no debt', async () => {
    const ws = makeWorkspace();
    seedList(ws.coreImpl, 'debt', 'routing.json', { target: 'routing', nextId: 2, items: [{ ...d1, foundBy: 'x round 1' }] });
    sh(ws.coreImpl, 'mkdir', ['-p', 'server/core/routing']);
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    commitAll(ws.coreImpl, 'change');
    const env = reviewer(ws, { 1: reviewFile([]), 2: reviewFile([]), 3: reviewFile([]), 4: reviewFile([]) });
    // --since after an invalid --debt round 1: the changes since it, no debt
    await next(ws, ['core', 'routing', '--debt'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    await next(ws, ['core', 'routing', '--since', since], env);
    // main moves by the review files merged into it
    expect(inputSection(ws.coreImpl, 'routing', 1, 'commit range')).toMatch(new RegExp(`^${since}\\.\\.[0-9a-f]+$`));
    expect(inputSection(ws.coreImpl, 'routing', 1, 'commit range')).not.toBe(`${since}..${since}`);
    expect(inputSection(ws.coreImpl, 'routing', 1, 'debt')).toBe('none');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
    const round1 = (JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] }).rounds[0]?.startCommit as string;
    // --respec after an invalid --debt round: the round goes on with the review of round 1
    await next(ws, ['core', 'routing', '--debt'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    appendFileSync(join(ws.harness, 'skills', 'core', 'command.md'), '\n- changed\n');
    await next(ws, ['core', 'routing', '--respec'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toMatch(new RegExp(`^${round1}\\.\\.`));
    expect(inputSection(ws.coreImpl, 'routing', 2, 'debt')).toBe('none');
    const input = readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-2-input.md'), 'utf8');
    expect(/## spec changes\n\n(\S+)\n/.exec(input)?.[1]).toMatch(/round-2-spec-changes\.diff$/);
  });

  it('starts the must-fix round after done when the target has a must-fix item, and gives it to that round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- server/lib/x.ts:4: high an old crash']), 2: reviewFile([], [], [], [], ['| M1 | fixed | none | gone |']) });
    await next(ws, ['core', 'routing'], env);
    await wait(ws, ['core', 'routing']);
    await next(ws, ['core', 'routing'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'must fix')).toBe('- M1: server/lib/x.ts:4: high an old crash');
    // it checks the fix of the item, not the round before it
    expect(inputSection(ws.coreImpl, 'routing', 2, 'previous review')).toBe('none');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\nreview must fix removed: routing M1\n');
    // nothing left to confirm: no round
    expect((await next(ws, ['core', 'routing'], env)).stdout).toBe('done\n');
  });

  it('keeps a location in the review agent\'s worktree or the checkout as a checkout path, in the list of the module that holds it', async () => {
    const ws = makeWorkspace();
    const file = reviewFile([], [], ['- CWD/server/core/storage/a.ts:3: medium a missing check']);
    await next(ws, ['core', 'routing'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(file)}.replace('CWD', process.cwd()));`).env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('review debt added: storage D1: server/core/storage/a.ts:3: medium a missing check\n');
    const main = reviewFile([], [], [`- ${join(ws.coreImpl, 'server/core/mailbox/b.ts')}:5: medium an odd name`]);
    await next(ws, ['core', 'routing', '--full'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(main)});`).env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('review debt added: mailbox D1: server/core/mailbox/b.ts:5: medium an odd name\n');
  });
});
