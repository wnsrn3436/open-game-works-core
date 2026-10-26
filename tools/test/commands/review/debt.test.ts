import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutLine, coreDebtTarget, scopeDebt, specDebtTargetOf, type ReviewList } from '../../../src/commands/review/lib/debt.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';
import { finding, reviewFile } from './helpers.ts';
import { ctxOf, d1, ids, inputSection, mergeDefinitions, mergeOptions, readList, reviewer, seedList } from './debt-fixture.ts';
import { next, wait } from './review-fixture.ts';

describe('scopeDebt', () => {
  it('gives the debt items in the list when the review began', () => {
    const item = (id: string) => ({ id, location: `a:${id}`, problem: 'p', foundBy: 'x round 1' });
    const list: ReviewList = { target: 'x', nextId: 5, items: [item('D1'), item('D3'), item('D4')] };
    expect(scopeDebt(list, 4).map((i) => i.id)).toEqual(['D1', 'D3']);
    expect(scopeDebt(list, 5).map((i) => i.id)).toEqual(['D1', 'D3', 'D4']);
    expect(scopeDebt(list, 1)).toEqual([]);
  });
});

describe('the list target of an out of scope item', () => {
  it('is the module or tool whose folder holds the file, else the reviewed target', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    expect(await coreDebtTarget(ctx, 'server/core/storage/a.ts:3: medium x', 'routing')).toBe('storage');
    expect(await coreDebtTarget(ctx, 'client/godot/core/ui_core/a.gd:3: high x', 'routing')).toBe('UICore');
    expect(await coreDebtTarget(ctx, 'core-spec/mailbox.json:1: medium x', 'routing')).toBe('mailbox');
    expect(await coreDebtTarget(ctx, 'tools/data-tool/src/a.ts:1: medium x', 'routing')).toBe('data-tool');
    expect(await coreDebtTarget(ctx, `${join(ws.coreImpl, 'server/core/storage/a.ts')}:3: medium x`, 'routing')).toBe('storage');
    // a folder of no module, and a path outside the module folders
    expect(await coreDebtTarget(ctx, 'server/core/nope/a.ts:3: medium x', 'routing')).toBe('routing');
    expect(await coreDebtTarget(ctx, 'proto/base.proto:3: medium x', 'routing')).toBe('routing');
    expect(await specDebtTargetOf(ctx, 'skills/server-core/modules/storage.md:4: medium x', 'routing')).toBe('spec storage');
    expect(await specDebtTargetOf(ctx, 'skills/core/SKILL.md:4: medium x', 'routing')).toBe('spec routing');
    expect(checkoutLine('/w/x/a.ts:3: high y', ['/w'])).toBe('x/a.ts:3: high y');
    expect(checkoutLine('/other/a.ts:3: high y', ['/w'])).toBe('/other/a.ts:3: high y');
    expect(checkoutLine('a.ts:3: high y', ['/w'])).toBe('a.ts:3: high y');
  });
});

describe('ogw review: tool lists', () => {
  it('puts a medium item in the debt list and a high one in the must-fix list, gives only the must-fix item to the next round and to the next review', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([finding('R1-1', 'no')], [], ['- src/b.ts:9: medium a slow loop', '- src/c.ts:2: high an old crash']),
      2: reviewFile([], ['| R1-1 | fixed | ok |'], [], [], ['| M1 | fixed | none | gone |']),
      3: reviewFile([]),
    });
    await next(ws, ['tool', 'agent', 'merge', ...mergeOptions(ws)], env);
    expect(inputSection(ws.harness, 'agent merge', 1, 'debt')).toBe('none');
    const first = await wait(ws, ['tool', 'agent', 'merge']);
    expect(first.stdout).toContain('out of scope: src/c.ts:2: high an old crash\n');
    expect(first.stdout).not.toContain('out of scope: src/b.ts:9');
    expect(first.stdout).toContain('review debt added: agent merge D1: src/b.ts:9: medium a slow loop\nreview must fix added: agent merge M1: src/c.ts:2: high an old crash\n');
    // the tool commits the lists in the harness repo
    expect(sh(ws.harness, 'git', ['log', '-1', '--format=%s']).trim()).toBe('ogw: review lists of agent merge round 1');
    expect(sh(ws.harness, 'git', ['status', '--porcelain', '--', 'records'])).toBe('');
    expect(readList(ws.harness, 'debt', 'agent-merge.json')).toEqual({ target: 'agent merge', nextId: 2, items: [{ id: 'D1', location: 'src/b.ts:9', problem: 'a slow loop', foundBy: 'agent merge round 1' }] });
    expect(readList(ws.harness, 'must fix', 'agent-merge.json')).toEqual({ target: 'agent merge', nextId: 2, items: [{ id: 'M1', severity: 'high', location: 'src/c.ts:2', problem: 'an old crash', foundBy: 'agent merge round 1' }] });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    // the must-fix item is in the scope of the next round; the debt item is not
    expect(inputSection(ws.harness, 'agent merge', 2, 'must fix')).toBe('- M1: src/c.ts:2: high an old crash');
    expect(inputSection(ws.harness, 'agent merge', 2, 'debt')).toBe('none');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\nreview must fix removed: agent merge M1\n');
    expect(ids(ws.harness, 'must fix', 'agent-merge.json')).toEqual([]);
    expect((await ogw(ws, ['review', 'clear', 'tool'])).code).toBe(0);
    // the next review of the change does not take the debt item either
    await next(ws, ['tool', 'agent', 'merge', ...mergeOptions(ws)], env);
    expect(inputSection(ws.harness, 'agent merge', 1, 'debt')).toBe('none');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
    expect(ids(ws.harness, 'debt', 'agent-merge.json')).toEqual(['D1']);
  });

  it('keeps a --debt left by an invalid round after done when --since is given again, which decides only round 1', async () => {
    const ws = makeWorkspace();
    const options = mergeOptions(ws);
    const env = reviewer(ws, { 1: reviewFile([], [], ['- src/b.ts:9: medium a slow loop']), 2: reviewFile([]), 3: reviewFile([], [], [], ['| D1 | fixed | none | gone |']) });
    await next(ws, ['tool', 'agent', 'merge', ...options], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('review debt added: agent merge D1');
    await next(ws, ['tool', 'agent', 'merge', '--debt', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toMatch(/^result: invalid\n/);
    // the lead runs its round-1 call again: the kept --debt starts round 2
    expect((await next(ws, ['tool', 'agent', 'merge', ...options], env)).stdout).toContain('round: 2');
    expect(inputSection(ws.harness, 'agent merge', 2, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\nreview debt removed: agent merge D1\n');
  });

  it('pays the debt list with --debt: its items are the scope, items added meanwhile are not, and a fixed item leaves the list', async () => {
    const ws = makeWorkspace();
    expect((await next(ws, ['tool', 'agent', 'merge', '--debt', ...mergeDefinitions(ws)], ws.env)).stderr).toContain('--debt of agent merge: its debt list has no item');
    expect((await next(ws, ['tool', 'agent', 'merge', '--debt', ...mergeOptions(ws)], ws.env)).stderr).toContain('usage: ogw review next');
    seedList(ws.harness, 'debt', 'agent-merge.json', { target: 'agent merge', nextId: 2, items: [d1] });
    const env = reviewer(ws, {
      1: reviewFile([]),
      2: reviewFile([finding('R1-1', 'no')], [], ['- src/d.ts:4: medium an odd name'], ['| D1 | open | R1-1 | still slow |']),
      3: reviewFile([], ['| R1-1 | fixed | ok |'], [], ['| D1 | fixed | none | gone |']),
    });
    // no --since: the round reviews no change, only the debt items
    await next(ws, ['tool', 'agent', 'merge', '--debt', ...mergeDefinitions(ws)], env);
    const start = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect(inputSection(ws.harness, 'agent merge', 1, 'commit range')).toBe(`${start}..${start}`);
    expect(inputSection(ws.harness, 'agent merge', 1, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    // a review file without a row for the given item is not judged
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 1\nreview file lists: ## debt rows none do not answer the debt items D1\n');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('review debt added: agent merge D2: src/d.ts:4: medium an odd name\n');
    commitAll(ws.harness, 'fix');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    // D2 was added during this review: not its scope
    expect(inputSection(ws.harness, 'agent merge', 2, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\nreview debt removed: agent merge D1\n');
    expect(ids(ws.harness, 'debt', 'agent-merge.json')).toEqual(['D2']);
  });

  it('moves a debt item whose location is found again as high to the must-fix list, and raises a must-fix item to critical', async () => {
    const ws = makeWorkspace();
    seedList(ws.harness, 'debt', 'agent-merge.json', { target: 'agent merge', nextId: 2, items: [d1] });
    const env = reviewer(ws, {
      1: reviewFile([], [], ['- src/b.ts:9: high a slow loop that hangs']),
      2: reviewFile([], [], ['- src/b.ts:9: critical it hangs every user'], [], ['| M1 | open | R2-1 | still |']).replace('## findings\n\nnone', `## findings\n\n| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|\n${finding('R2-1', 'no')}`),
    });
    await next(ws, ['tool', 'agent', 'merge', ...mergeOptions(ws)], env);
    const moved = await wait(ws, ['tool', 'agent', 'merge']);
    expect(moved.stdout).toContain('review debt removed: agent merge D1\nreview must fix added: agent merge M1: src/b.ts:9: high a slow loop that hangs (was D1)\n');
    expect(ids(ws.harness, 'debt', 'agent-merge.json')).toEqual([]);
    commitAll(ws.harness, 'change');
    await next(ws, ['tool', 'agent', 'merge', '--reopen', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('review must fix raised: agent merge M1 critical\n');
    expect(readList(ws.harness, 'must fix', 'agent-merge.json')?.items.map((item) => [item.id, item.severity])).toEqual([['M1', 'critical']]);
  });

  it('adds no item for a location the lists already have, unless a must-fix item becomes critical', async () => {
    const ws = makeWorkspace();
    seedList(ws.harness, 'debt', 'agent-merge.json', { target: 'agent merge', nextId: 2, items: [d1] });
    seedList(ws.harness, 'must fix', 'agent-merge.json', { target: 'agent merge', nextId: 2, items: [{ id: 'M1', severity: 'high', location: 'src/c.ts:2', problem: 'an old crash', foundBy: 'agent merge round 1' }] });
    const again = ['- src/b.ts:9: medium a slow loop again', '- src/c.ts:2: medium an old crash again', '- src/c.ts:2: high an old crash again'];
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')], [], again, [], ['| M1 | open | R1-1 | still |']) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeOptions(ws)], env);
    const before = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const judged = await wait(ws, ['tool', 'agent', 'merge']);
    expect(judged.stdout).toMatch(/^result: fix\n/);
    expect(judged.stdout).not.toContain('review debt');
    expect(judged.stdout).not.toContain('review must fix');
    expect(sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readList(ws.harness, 'debt', 'agent-merge.json')?.items).toEqual([d1]);
    expect(readList(ws.harness, 'must fix', 'agent-merge.json')?.items.map((item) => [item.id, item.severity])).toEqual([['M1', 'high']]);
  });

  it('keeps a location in the tool review agent\'s worktree as a harness path', async () => {
    const ws = makeWorkspace();
    const file = reviewFile([], [], ['- CWD/tools/src/x.ts:3: medium an odd name']);
    const { env } = fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(file)}.replace('CWD', process.cwd()));`);
    await next(ws, ['tool', 'agent', 'merge', ...mergeOptions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('review debt added: agent merge D1: tools/src/x.ts:3: medium an odd name\n');
  });

  it('takes no --full for a tool target', async () => {
    const ws = makeWorkspace();
    const refused = await next(ws, ['tool', 'agent', 'merge', '--full', '--definition', join(ws.harness, 'tools', 'ogw.md')], ws.env);
    expect(refused.stderr).toContain('usage: ogw review next core <target> [--since <commit>|--full|--debt]');
  });
});

describe('ogw review run --full and --debt', () => {
  it('starts a round of the whole target, or of the debt items, after a done round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- src/b.ts:9: medium a slow loop']), 2: reviewFile([], [], [], ['| D1 | open | R3-1 | x |']), 3: reviewFile([], [], [], ['| D1 | fixed | none | gone |']) });
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env })).stdout).toContain('result: done\nround: 1\n');
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env })).stdout).toContain('result: done\nround: 1\n');
    // round 2: its `## debt` row names a finding the file does not have, so it is invalid and runs again as round 2
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--debt'], { env });
    expect(run.stdout).toBe('result: done\nround: 2\nround 1: review debt added: routing D1: src/b.ts:9: medium a slow loop\nround 2: review debt removed: routing D1\n');
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toMatch(/^([0-9a-f]+)\.\.\1$/);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing', '--debt'], { env })).stderr).toContain('--debt of routing: its debt list has no item');
    expect((await ogw(ws, ['review', 'run', 'core', 'routing', '--full'], { env: reviewer(ws, { 4: reviewFile([]) }) })).stdout).toMatch(/^result: done\nround: 3\n/);
    expect(inputSection(ws.coreImpl, 'routing', 3, 'commit range')).toBe('none');
  });
});
