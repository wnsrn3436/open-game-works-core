import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutLine, coreDebtTarget, gameLocation, scopeDebt, specDebtTargetOf, type ReviewList } from '../../../src/commands/review/lib/debt.ts';
import { createContext } from '../../../src/lib/command.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';
import { agentsByCall, finding, reviewFile } from './helpers.ts';

/** `--definition` options naming the documents that define `agent merge`. */
function mergeDefinitions(ws: TestWorkspace): string[] {
  return ['tools/ogw.md', 'skills/core/command.md'].flatMap((path) => ['--definition', join(ws.harness, path)]);
}

/** `--since` of the harness HEAD and the `--definition` options of `agent merge`. */
function mergeOptions(ws: TestWorkspace): string[] {
  return ['--since', sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim(), ...mergeDefinitions(ws)];
}

/** A review agent that writes `files[n]` on its n-th call (no core agent is called). */
function reviewer(ws: TestWorkspace, files: Record<number, string>): NodeJS.ProcessEnv {
  return agentsByCall(ws, files, '').env;
}

const LIST_DIRS = { debt: 'review-debt', 'must fix': 'review-must-fix' } as const;

function readList(repo: string, kind: keyof typeof LIST_DIRS, file: string): ReviewList | null {
  try {
    return JSON.parse(readFileSync(join(repo, 'records', LIST_DIRS[kind], file), 'utf8')) as ReviewList;
  } catch {
    return null;
  }
}

function ids(repo: string, kind: keyof typeof LIST_DIRS, file: string): string[] | undefined {
  return readList(repo, kind, file)?.items.map((item) => item.id);
}

/** Writes and commits a list file in `repo`. */
function seedList(repo: string, kind: keyof typeof LIST_DIRS, file: string, list: ReviewList): void {
  mkdirSync(join(repo, 'records', LIST_DIRS[kind]), { recursive: true });
  writeFileSync(join(repo, 'records', LIST_DIRS[kind], file), JSON.stringify(list));
  commitAll(repo, `seed ${file}`);
}

/** A section of a round's review agent input. */
function inputSection(repo: string, target: string, round: number, heading: 'debt' | 'must fix' | 'commit range'): string {
  const input = readFileSync(join(repo, '.git', 'ogw-review', target, `round-${String(round)}-input.md`), 'utf8');
  return new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)\\n(?:\\n## |$)`).exec(input)?.[1] ?? '';
}

async function next(ws: TestWorkspace, args: string[], env: NodeJS.ProcessEnv) {
  return ogw(ws, ['review', 'next', ...args], { env });
}

async function wait(ws: TestWorkspace, args: string[]) {
  return ogw(ws, ['review', 'wait', ...args, '--timeout', '120000']);
}

const ctxOf = (ws: TestWorkspace) => createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
const d1 = { id: 'D1', location: 'src/b.ts:9', problem: 'a slow loop', foundBy: 'agent merge round 1' };
const low = (id: string) => `| ${id} | \`structure\` | low | src/a.ts:3 | dead code | remove | no | 90 |`;

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
    // a later round that answers the game finding open does not count it either
    await next(ws, ['core', 'routing', '--reopen'], env);
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
    // a round that is not done takes no --full
    expect((await next(ws, ['core', 'routing', '--full'], env)).stderr).toContain('--full of routing needs no review state or a last round that is done');
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { whole?: boolean; chain: number; fixBase: string | null; paysDebt?: boolean }[]; full?: boolean };
    // the option is used once its round is judged; the reviews of the whole target pay debt
    expect(state.rounds.map((r) => [r.whole, r.chain, r.fixBase, r.paysDebt])).toEqual([[true, 1, null, true], [true, 2, null, true]]);
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

  it('lets an option given after an invalid --debt round decide the next round, and pays no debt in a --reopen round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([], [], ['- src/b.ts:9: medium a slow loop']),
      2: reviewFile([]),
      3: reviewFile([], [], [], ['| D1 | open | R3-1 | x |']),
      4: reviewFile([]),
    });
    await next(ws, ['core', 'routing'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('review debt added: routing D1');
    // a --debt round whose review file does not answer D1 is dropped as invalid
    await next(ws, ['core', 'routing', '--debt'], env);
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    // --full given now decides: the whole target, which pays the debt
    await next(ws, ['core', 'routing', '--full'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toBe('none');
    expect(inputSection(ws.coreImpl, 'routing', 2, 'debt')).toBe('- D1: src/b.ts:9: medium a slow loop');
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: invalid\n/);
    // --reopen given now decides: the changes since the done round, with no debt
    const round1 = (JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] }).rounds[0]?.startCommit as string;
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    // the review agent jobs put the ogw pre-commit hook in open-game-works-core-impl: the test commits without it
    sh(ws.coreImpl, 'git', ['add', '--all']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', 'routing change']);
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await next(ws, ['core', 'routing', '--reopen'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'commit range')).toBe(`${round1}..${main}`);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'debt')).toBe('none');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\n');
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

  it('takes --reopen after done with no change when the target has a must-fix item, and gives it to that round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- server/lib/x.ts:4: high an old crash']), 2: reviewFile([], [], [], [], ['| M1 | fixed | none | gone |']) });
    await next(ws, ['core', 'routing'], env);
    await wait(ws, ['core', 'routing']);
    await next(ws, ['core', 'routing', '--reopen'], env);
    expect(inputSection(ws.coreImpl, 'routing', 2, 'must fix')).toBe('- M1: server/lib/x.ts:4: high an old crash');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\nreview must fix removed: routing M1\n');
    // nothing left to confirm and nothing changed
    expect((await next(ws, ['core', 'routing', '--reopen'], env)).stderr).toContain('--reopen of routing: nothing of routing changed since round 2');
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

describe('ogw review spec: scope and lists', () => {
  /** Starts a spec review and waits for it; returns the job's input text and the wait output. */
  async function specReview(ws: TestWorkspace, args: string[], env: NodeJS.ProcessEnv): Promise<{ input: string; waited: Awaited<ReturnType<typeof ogw>> }> {
    const started = await ogw(ws, ['review', 'spec', 'core', 'routing', ...args], { env });
    expect(started.stderr).toBe('');
    const id = started.stdout.trim();
    const input = readFileSync(((await readJob(id, ws.env)).meta as { input: string }).input, 'utf8');
    return { input, waited: await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']) };
  }

  it('needs one of --since, --full, --debt, gives the spec diff since --since, and refuses a spec that did not change', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]), 2: reviewFile([]), 3: reviewFile([]) });
    for (const args of [[], ['--full', '--since', 'HEAD'], ['--full', '--debt']]) {
      expect((await ogw(ws, ['review', 'spec', 'core', 'routing', ...args], { env })).stderr).toContain('usage: ogw review spec core <module> <--since <commit>|--full|--debt>');
    }
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--debt'], { env })).stderr).toContain('--debt of routing: its spec debt list has no item');
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--since', head], { env })).stderr).toContain('the spec skills/server-core/modules/routing.md did not change since');
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'routing.md');
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n- changed rule\n`);
    const changed = await specReview(ws, ['--since', head], env);
    const diff = /## spec changes\n\n(\S+)\n/.exec(changed.input)?.[1] ?? '';
    expect(readFileSync(diff, 'utf8')).toContain('+- changed rule');
    const full = await specReview(ws, ['--full'], env);
    expect(full.input).toContain('## spec changes\n\nnone\n');
    // a spec not in the --since commit is new: the whole spec, which pays its spec debt
    seedList(ws.coreImpl, 'debt', 'spec-routing.json', { target: 'spec routing', nextId: 2, items: [{ ...d1, location: 'skills/server-core/modules/routing.md:9', foundBy: 'spec routing' }] });
    rmSync(spec);
    const without = commitAll(ws.harness, 'no routing spec');
    sh(ws.harness, 'git', ['checkout', '--quiet', head, '--', 'skills/server-core/modules/routing.md']);
    expect((await specReview(ws, ['--since', without], env)).input).toContain('## spec changes\n\nnone\n\n## debt\n\n- D1: skills/server-core/modules/routing.md:9: medium a slow loop\n');
  });

  it('writes out of scope items to the spec lists at agent wait once, pays the debt only with --full or --debt, and gives must-fix items to every spec review', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([], [], ['- skills/server-core/modules/storage.md:4: medium two names for one error', '- skills/server-core/modules/routing.md:9: medium an unused key', '- skills/server-core/modules/routing.md:12: high two orders']),
      2: reviewFile([], [], [], [], ['| M1 | open | R1-1 | still |']).replace('## findings\n\nnone', `## findings\n\n| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|\n${finding('R1-1', 'yes')}`),
      3: reviewFile([], [], [], ['| D1 | fixed | none | gone |'], ['| M1 | fixed | none | gone |']),
    });
    const first = await specReview(ws, ['--full'], env);
    expect(first.waited.code).toBe(0);
    expect(first.waited.stdout).toContain('review debt added: spec storage D1: skills/server-core/modules/storage.md:4: medium two names for one error\n');
    expect(first.waited.stdout).toContain('review debt added: spec routing D1: skills/server-core/modules/routing.md:9: medium an unused key\n');
    expect(first.waited.stdout).toContain('review must fix added: spec routing M1: skills/server-core/modules/routing.md:12: high two orders\n');
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s', 'main']).trim()).toBe('ogw: review lists of spec routing');
    // a review of a change gives the must-fix items, not the debt; with no change the must-fix item lets it start
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const confirm = await specReview(ws, ['--since', head], env);
    expect(readFileSync(/## spec changes\n\n(\S+)\n/.exec(confirm.input)?.[1] ?? '', 'utf8')).toBe('');
    expect(confirm.input).toContain('## debt\n\nnone\n\n## must fix\n\n- M1: skills/server-core/modules/routing.md:12: high two orders\n');
    expect(confirm.waited.code).toBe(0);
    // --debt: an empty diff, the debt items and the must-fix items
    const paying = await specReview(ws, ['--debt'], env);
    expect(readFileSync(/## spec changes\n\n(\S+)\n/.exec(paying.input)?.[1] ?? '', 'utf8')).toBe('');
    expect(paying.input).toContain('## debt\n\n- D1: skills/server-core/modules/routing.md:9: medium an unused key\n\n## must fix\n\n- M1: ');
    expect(paying.waited.stdout).toContain('review debt removed: spec routing D1\nreview must fix removed: spec routing M1\n');
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
    expect(ids(ws.coreImpl, 'debt', 'spec-storage.json')).toEqual(['D1']);
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--since', head], { env })).stderr).toContain('did not change since');
  });

  it('keeps a location in the spec review agent\'s worktree or the harness as a harness path, in the lists of the module whose spec holds it', async () => {
    const ws = makeWorkspace();
    const file = reviewFile([], [], ['- CWD/skills/server-core/modules/storage.md:9: medium two names']);
    const { waited } = await specReview(ws, ['--full'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(file)}.replace('CWD', process.cwd()));`).env);
    expect(waited.stdout).toContain('review debt added: spec storage D1: skills/server-core/modules/storage.md:9: medium two names\n');
    const harnessFile = reviewFile([], [], [`- ${join(ws.harness, 'skills/server-core/modules/mailbox.md')}:3: medium an unused key`]);
    const second = await specReview(ws, ['--full'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(harnessFile)});`).env);
    expect(second.waited.stdout).toContain('review debt added: spec mailbox D1: skills/server-core/modules/mailbox.md:3: medium an unused key\n');
  });

  it('writes once per job: a second agent wait prints the same lines and changes nothing', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- skills/server-core/modules/routing.md:9: medium an unused key']), 2: reviewFile([], [], [], ['| D1 | fixed | none | gone |']) });
    const id = (await ogw(ws, ['review', 'spec', 'core', 'routing', '--full'], { env })).stdout.trim();
    const first = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
    expect(first.stdout).toContain('review debt added: spec routing D1');
    await specReview(ws, ['--full'], env);
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
    const again = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
    expect(again.stdout).toBe(first.stdout);
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
  });

  it('fails at agent wait and writes nothing for a review file not in the form, with a low finding in a review of the changes, or not answering the items', async () => {
    const ws = makeWorkspace();
    const lowSpec = '| R1-1 | `spec` | low | skills/server-core/modules/routing.md:3 | two words | one | yes | 90 |';
    const env = reviewer(ws, {
      1: '## findings\n\nnone\n',
      2: reviewFile([lowSpec], [], ['- skills/server-core/modules/routing.md:9: medium x']),
      3: reviewFile([lowSpec], [], ['- skills/server-core/modules/routing.md:9: medium x']),
      4: reviewFile([]),
    });
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const broken = await specReview(ws, ['--full'], env);
    expect(broken.waited.code).toBe(1);
    expect(broken.waited.stdout).toContain(': not in the review file format');
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'routing.md');
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n- changed rule\n`);
    const since = await specReview(ws, ['--since', head], env);
    expect(since.waited.code).toBe(1);
    expect(since.waited.stdout).toContain(': not in the review file format');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim()).toBe(before);
    // a review of the whole spec takes it
    const full = await specReview(ws, ['--full'], env);
    expect(full.waited.code).toBe(0);
    expect(full.waited.stdout).toContain('review debt added: spec routing D1');
    const after = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const unanswered = await specReview(ws, ['--full'], env);
    expect(unanswered.waited.code).toBe(1);
    expect(unanswered.waited.stdout).toContain('## debt rows none do not answer the debt items D1');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim()).toBe(after);
  });
});
