import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

const workspaces: TestWorkspace[] = [];
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Mod {
  name: string;
  side: 'client' | 'server';
  dependencies?: string[];
  optionalDependencies?: string[];
  devDependencies?: string[];
}

function writeModules(coreImpl: string, modules: readonly Mod[]): void {
  const dir = join(coreImpl, 'core-spec');
  mkdirSync(dir, { recursive: true });
  for (const m of modules) {
    const full = { dependencies: [], optionalDependencies: [], devDependencies: [], settings: [], ...m };
    writeFileSync(join(dir, `${m.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
  }
}

const MODULES: Mod[] = [
  { name: 'storage', side: 'server' },
  { name: 'item-ledger', side: 'server', dependencies: ['storage'] },
  { name: 'cheat', side: 'server' },
  { name: 'routing', side: 'server', devDependencies: ['cheat'] },
  { name: 'UserStateCore', side: 'client', optionalDependencies: ['item-ledger'] },
  { name: 'QACore', side: 'client', devDependencies: ['UserStateCore'] },
  { name: 'BadgeCore', side: 'client', dependencies: ['UserStateCore', 'QACore'] },
  { name: 'aCore', side: 'client' },
];

function workspace(): TestWorkspace {
  const ws = makeWorkspace();
  workspaces.push(ws);
  writeModules(ws.coreImpl, MODULES);
  return ws;
}

describe('ogw core dependents', () => {
  it('lists the given modules and their direct and indirect dependents by side in byte order', async () => {
    const ws = workspace();
    const run = await ogw(ws, ['core', 'dependents', 'storage']);
    expect(run).toMatchObject({ code: 0, stdout: 'server: item-ledger storage\nclient: BadgeCore QACore UserStateCore\n' });
    const json = await ogw(ws, ['core', 'dependents', 'cheat', 'aCore', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ server: ['cheat', 'routing'], client: ['aCore'] });
    // Byte order puts uppercase before lowercase, where locale order would put aCore first.
    expect((await ogw(ws, ['core', 'dependents', 'aCore', 'BadgeCore'])).stdout).toBe('server: \nclient: BadgeCore aCore\n');
  });

  it('lists only the module when nothing depends on it', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'dependents', 'BadgeCore'])).stdout).toBe('server: \nclient: BadgeCore\n');
  });

  it('names modules that are not in core-spec and fails', async () => {
    const ws = workspace();
    const run = await ogw(ws, ['core', 'dependents', 'storage', 'nope', 'Zap', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ unknown: ['nope', 'Zap'] });
    expect((await ogw(ws, ['core', 'dependents', 'nope'])).stdout).toBe('not in core-spec: nope\n');
  });

  it('reads core-spec of the core worktree the command runs in', async () => {
    const ws = workspace();
    const tree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '-b', 'agent/w1', tree]);
    writeModules(tree, [{ name: 'only', side: 'server' }]);
    expect((await ogw(ws, ['core', 'dependents', 'only'], { cwd: tree })).stdout).toBe('server: only\nclient: \n');
  });

  it('fails without arguments, without core-spec, and on a broken file', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'dependents'])).stderr).toBe('usage: ogw core dependents <module>...\n');
    writeFileSync(join(ws.coreImpl, 'core-spec', 'bad.json'), '{"name": "bad", "side": "web"}\n');
    const bad = await ogw(ws, ['core', 'dependents', 'storage']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toBe(`${join(ws.coreImpl, 'core-spec', 'bad.json')}: not a core-spec module object\n`);
    rmSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    expect((await ogw(ws, ['core', 'dependents', 'storage'])).stderr).toBe(`core-spec folder not found: ${join(ws.coreImpl, 'core-spec')}\n`);
  });
});

describe('ogw core review-targets', () => {
  function commitFiles(ws: TestWorkspace, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(ws.coreImpl, path, '..'), { recursive: true });
      writeFileSync(join(ws.coreImpl, path), text);
    }
    sh(ws.coreImpl, 'git', ['add', '-A']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'change']);
  }

  it('reviews a module with a changed file, and its dependents only when its public face changed', async () => {
    const ws = workspace();
    commitFiles(ws, { 'server/core/storage/index.ts': 'a', 'server/core/storage/tx.ts': 'a', 'client/godot/core/user_state_core/user_state_core.gd': 'a', 'client/godot/core/user_state_core/cache.gd': 'a' });
    const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    // inside storage and UserStateCore only: no dependent is reviewed
    commitFiles(ws, { 'server/core/storage/tx.ts': 'b', 'server/core/storage/tests/tx.test.ts': 'b', 'client/godot/core/user_state_core/cache.gd': 'b', 'tools/data-tool/src/a.ts': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: storage\nclient: UserStateCore\ntools: data-tool\n');
    // the entry file of storage changed: its dependents are reviewed too
    commitFiles(ws, { 'server/core/storage/index.ts': 'c' });
    expect(JSON.parse((await ogw(ws, ['core', 'review-targets', '--since', since, '--json'])).stdout)).toEqual({
      server: ['item-ledger', 'storage'],
      client: ['BadgeCore', 'QACore', 'UserStateCore'],
      tools: ['data-tool'],
    });
  });

  it('counts the module class, DEV classes, events and the core-spec file as the public face', async () => {
    const ws = workspace();
    commitFiles(ws, {});
    const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'client/godot/core/user_state_core/events/changed.gd': 'x' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: \nclient: BadgeCore QACore UserStateCore\ntools: \n');
    const ws2 = workspace();
    commitFiles(ws2, {});
    const since2 = sh(ws2.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws2, { 'core-spec/cheat.json': JSON.stringify({ name: 'cheat', side: 'server', dependencies: [], optionalDependencies: [], devDependencies: [], settings: [] }) });
    expect((await ogw(ws2, ['core', 'review-targets', '--since', since2])).stdout).toBe('server: cheat routing\nclient: \ntools: \n');
  });

  it('counts each file of the public face alone: module class, DEV classes, server dev/index.ts', async () => {
    const ws = workspace();
    commitFiles(ws, {});
    const client = 'server: \nclient: BadgeCore QACore UserStateCore\ntools: \n';
    const cases: [string, string][] = [
      ['client/godot/core/user_state_core/user_state_core.gd', client],
      ['client/godot/core/user_state_core/dev/user_state_core.gd', client],
      ['client/godot/core/user_state_core/dev/user_state_core_dev.gd', client],
      ['server/core/storage/dev/index.ts', 'server: item-ledger storage\nclient: BadgeCore QACore UserStateCore\ntools: \n'],
    ];
    for (const [file, expected] of cases) {
      const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      commitFiles(ws, { [file]: file });
      expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe(expected);
    }
  });

  it('counts the files that the server-core skill, a module spec or the engine implementation rules name as the public face', async () => {
    const ws = workspace();
    appendFileSync(join(ws.harness, 'skills', 'server-core', 'modules', 'storage.md'), '\n- shared는 `storage/db/shared.ts`다\n');
    appendFileSync(join(ws.harness, 'skills', 'client-core', 'engines', 'godot.md'), '\n- shared는 `core/user_state_core/internal/shared.gd`다\n');
    commitFiles(ws, { 'server/core/storage/db/shared.ts': 'a', 'server/core/storage/db/other.ts': 'a', 'client/godot/core/user_state_core/internal/shared.gd': 'a' });
    let since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'server/core/storage/db/other.ts': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: storage\nclient: \ntools: \n');
    since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'server/core/storage/db/shared.ts': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: item-ledger storage\nclient: BadgeCore QACore UserStateCore\ntools: \n');
    since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'client/godot/core/user_state_core/internal/shared.gd': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: \nclient: BadgeCore QACore UserStateCore\ntools: \n');
  });

  it('counts a named path relative to a module folder as that file of each module', async () => {
    const ws = workspace();
    appendFileSync(join(ws.harness, 'skills', 'server-core', 'SKILL.md'), '\n- fake adapter는 그 module의 `dev/adapters/fake.ts`다. game의 `server/main.ts`\n');
    commitFiles(ws, { 'server/core/storage/dev/adapters/fake.ts': 'a', 'server/core/storage/dev/adapters/other.ts': 'a' });
    let since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'server/core/storage/dev/adapters/other.ts': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: storage\nclient: \ntools: \n');
    since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    commitFiles(ws, { 'server/core/storage/dev/adapters/fake.ts': 'b' });
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: item-ledger storage\nclient: BadgeCore QACore UserStateCore\ntools: \n');
  });

  it('classifies both the old and the new path of a moved file', async () => {
    const ws = workspace();
    const text = 'the same text, so that git sees a rename\n'.repeat(5);
    commitFiles(ws, { 'client/godot/core/user_state_core/events/changed.gd': text, 'server/core/storage/a.ts': text });
    const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    mkdirSync(join(ws.coreImpl, 'client/godot/core/user_state_core/internal'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'server/core/cheat'), { recursive: true });
    sh(ws.coreImpl, 'git', ['mv', 'client/godot/core/user_state_core/events/changed.gd', 'client/godot/core/user_state_core/internal/changed.gd']);
    sh(ws.coreImpl, 'git', ['mv', 'server/core/storage/a.ts', 'server/core/cheat/a.ts']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', 'move']);
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: cheat storage\nclient: BadgeCore QACore UserStateCore\ntools: \n');
  });

  it('fails without --since', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'review-targets'])).stderr).toBe('usage: ogw core review-targets --since <commit>\n');
  });
});
