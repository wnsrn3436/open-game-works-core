import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneCopyRepo, makeCopyRepo } from '../../../src/commands/regress/lib/copy.ts';
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

  it('makes a fix repo in its reserved folder only when that folder is there and empty', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws);
    const source = join(ws.games, 'src');
    const ctx = ctxOf(ws);
    const registry = sh(source, 'git', ['rev-parse', 'id-registry']).trim();
    const make = (name: string): Promise<string> => makeCopyRepo(ctx, name, { repo: source, commit, registry }, { kind: 'fix', state: 's' }, 'fix repo', true);
    await expect(make('ogw-regress-fix-1')).rejects.toThrow('is not an empty folder');
    mkdirSync(join(ws.games, 'ogw-regress-fix-1'));
    const main = await make('ogw-regress-fix-1');
    const repo = join(ws.games, 'ogw-regress-fix-1');
    expect(sh(repo, 'git', ['rev-parse', 'main']).trim()).toBe(main);
    expect(readFileSync(join(repo, 'client/a.gd'), 'utf8')).toBe('var x = 1\n');
    expect(await readMark(join(repo, '.git'))).toEqual({ kind: 'fix', state: 's' });
    await expect(make('ogw-regress-fix-1')).rejects.toThrow('is not an empty folder');
    expect(existsSync(join(repo, 'client/a.gd'))).toBe(true);
  });

  it('clones a fix repo into a reserved, empty folder with the same history and mark and a hook of its own', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws);
    const source = join(ws.games, 'src');
    const ctx = ctxOf(ws);
    const registry = sh(source, 'git', ['rev-parse', 'id-registry']).trim();
    mkdirSync(join(ws.games, 'ogw-regress-fix-1'));
    const main = await makeCopyRepo(ctx, 'ogw-regress-fix-1', { repo: source, commit, registry }, { kind: 'fix', state: 's' }, 'fix repo', true);
    const from = join(ws.games, 'ogw-regress-fix-1');
    await expect(cloneCopyRepo(ctx, from, 'ogw-regress-fix-2')).rejects.toThrow('is not an empty folder');
    mkdirSync(join(ws.games, 'ogw-regress-fix-2'));
    const clone = await cloneCopyRepo(ctx, from, 'ogw-regress-fix-2');
    expect(clone).toBe(join(ws.games, 'ogw-regress-fix-2'));
    for (const ref of ['main', 'id-registry']) expect(sh(clone, 'git', ['rev-parse', ref]).trim()).toBe(sh(from, 'git', ['rev-parse', ref]).trim());
    expect(sh(clone, 'git', ['rev-parse', 'main']).trim()).toBe(main);
    expect(sh(clone, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(await readMark(join(clone, '.git'))).toEqual({ kind: 'fix', state: 's' });
    expect(sh(clone, 'git', ['config', 'core.hooksPath']).trim()).toBe(join(clone, '.git', 'hooks'));
    expect(readFileSync(join(clone, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('# ogw pre-commit hook of game ogw-regress-fix-2\n');
    // a change in the clone leaves the fix repo it was cloned from as it was
    write(clone, 'client/a.gd', 'var x = 2\n');
    expect(readFileSync(join(from, 'client/a.gd'), 'utf8')).toBe('var x = 1\n');
    expect(readFileSync(join(from, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('# ogw pre-commit hook of game ogw-regress-fix-1\n');
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
