import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCopyRepo, resetFixRepo, rootOf } from '../../../src/commands/regress/lib/copy.ts';
import { guardViolations, testCount } from '../../../src/commands/regress/lib/guards.ts';
import { readMark } from '../../../src/commands/regress/lib/mark.ts';
import { commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { ctxOf, sourceGame, write } from './helpers.ts';

describe('copy repo (regression state, fix repo)', () => {
  it('is one root commit of the tree without records/loops, with an id-registry root commit, the hook and the mark', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws);
    const source = join(ws.games, 'src');
    const ctx = ctxOf(ws);
    const registry = sh(source, 'git', ['rev-parse', 'id-registry']).trim();
    const root = await makeCopyRepo(ctx, 'ogw-regress-s', { repo: source, commit, registry }, { kind: 'state', state: 's' }, 'regression state s');
    const copy = join(ws.games, 'ogw-regress-s');
    expect(sh(copy, 'git', ['rev-list', '--count', 'main']).trim()).toBe('1');
    expect(sh(copy, 'git', ['rev-parse', 'main']).trim()).toBe(root);
    expect(sh(copy, 'git', ['ls-tree', '-r', '--name-only', 'main']).split('\n')).not.toContain('records/loops/update-1/iteration-1.md');
    expect(sh(copy, 'git', ['ls-tree', '-r', '--name-only', 'main']).split('\n')).toContain('records/setup/request.md');
    expect(existsSync(join(copy, 'records', 'loops'))).toBe(false);
    expect(sh(copy, 'git', ['rev-list', '--count', 'id-registry']).trim()).toBe('1');
    expect(sh(copy, 'git', ['show', 'id-registry:id_registry.json'])).toBe('{"opp_a": 1}\n');
    expect(sh(copy, 'git', ['ls-tree', '-r', '--name-only', 'id-registry']).trim()).toBe('id_registry.json');
    // the history the fixer reads names no other commit of the source
    expect(sh(copy, 'git', ['log', '--all', '--format=%H']).trim().split('\n').sort()).toEqual([root, sh(copy, 'git', ['rev-parse', 'id-registry']).trim()].sort());
    expect(await readMark(join(copy, '.git'))).toEqual({ kind: 'state', state: 's' });
    const hook = readFileSync(join(copy, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('harness=${OGW_HARNESS_ROOT:-');
    expect(hook).toContain('"$harness/tools/src/commands/game/lib/pre-commit-main.ts"');
    expect(sh(copy, 'git', ['status', '--porcelain']).trim()).toBe('');
    // the source is only read
    expect(sh(source, 'git', ['status', '--porcelain']).trim()).toBe('');
    await expect(makeCopyRepo(ctx, 'ogw-regress-s', { repo: source, commit, registry }, { kind: 'state', state: 's' }, 'again')).rejects.toThrow('exists');
  });

  it('is put back by the reset: main and id-registry at their roots, other branches, tags, worktrees and untracked files gone', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws);
    const source = join(ws.games, 'src');
    const ctx = ctxOf(ws);
    const main = await makeCopyRepo(ctx, 'fix', { repo: source, commit, registry: sh(source, 'git', ['rev-parse', 'id-registry']).trim() }, { kind: 'fix', state: 's' }, 'fix repo');
    const repo = join(ws.games, 'fix');
    const registry = await rootOf(ctx, repo, 'id-registry');
    write(repo, 'client/a.gd', 'var x = 2\n');
    sh(repo, 'git', ['commit', '-qam', 'fix', '--no-verify']);
    sh(repo, 'git', ['branch', 'agent/x']);
    sh(repo, 'git', ['tag', 't1']);
    sh(repo, 'git', ['worktree', 'add', '--quiet', join(ws.worktrees, 'fix', 'agent-x'), 'agent/x']);
    write(repo, 'untracked.txt', 'x');
    await resetFixRepo(ctx, repo, { main, registry });
    expect(sh(repo, 'git', ['rev-parse', 'main']).trim()).toBe(main);
    expect(sh(repo, 'git', ['for-each-ref', '--format=%(refname:short)']).trim().split('\n').sort()).toEqual(['id-registry', 'main']);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'client/a.gd'), 'utf8')).toBe('var x = 1\n');
    expect(sh(repo, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });
});

describe('guards', () => {
  it('count the tests of GDScript and TypeScript test files', () => {
    expect(testCount('client/tests/a.gd', 'func test_a():\n\tpass\nfunc helper():\n  func test_b():\n')).toBe(2);
    expect(testCount('server/tests/a.test.ts', "describe('x', () => {\n  it('a', () => {});\n  test.each([1])('b', () => {});\n  it.only('c', () => {});\n  submit('d');\n});")).toBe(3);
  });

  it('name frozen paths, frozen cells, fewer tests and translation rows that were neither missing nor stale', async () => {
    const ws = makeWorkspace();
    sourceGame(ws);
    const repo = join(ws.games, 'src');
    const ctx = ctxOf(ws);
    const seeded = sh(repo, 'git', ['rev-parse', 'HEAD']).trim();
    expect(await guardViolations(ctx, repo, seeded, seeded, { frozen: [], frozenColumns: [] }, false)).toEqual([]);
    write(repo, 'records/setup/request.md', 'changed\n');
    write(repo, 'client/tests/test_a.gd', 'extends UnitTestCase\n\nfunc test_one() -> void:\n\tpass\n');
    write(repo, 'data/tables/opponent.csv', ['comment,,', 'All,All,All', 'id(key),int,int', 'id,hero_health,sim_turns_min', '[opp_a],14,5', '[opp_b],18,12', ''].join('\n'));
    write(repo, 'data/translations/en.csv', 'key,source,source_hash,current_hash,text\na,가,h1,h1,AA\nb,나,h3,h3,BB\nc,다,h4,h4,C\n');
    write(repo, 'client/a.gd', 'var x = 3\n');
    const final = commitAll(repo, 'fixer');
    const seed = { frozen: ['client/a.gd'], frozenColumns: [{ file: 'data/tables/opponent.csv', columns: ['sim_*'] }] };
    expect(await guardViolations(ctx, repo, seeded, final, seed, true)).toEqual([
      'frozen client/a.gd',
      'frozen records/setup/request.md',
      'frozen data/tables/opponent.csv [opp_b] sim_turns_min',
      'fewer tests client/tests/test_a.gd: 2 to 1',
      // b was stale and c missing: only a, which was translated and current, counts
      'translation data/translations/en.csv a',
    ]);
    // a change of a frozen table outside its frozen columns is no violation
    write(repo, 'data/tables/opponent.csv', ['comment,,', 'All,All,All', 'id(key),int,int', 'id,hero_health,sim_turns_min', '[opp_a],14,5', '[opp_b],30,12', ''].join('\n'));
    const next = commitAll(repo, 'health');
    expect(await guardViolations(ctx, repo, final, next, seed, false)).toEqual([]);
  });
});
