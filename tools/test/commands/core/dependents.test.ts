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

  it('lists the modules and tools with a changed file, and no module without one that depends on a changed module', async () => {
    const ws = workspace();
    appendFileSync(join(ws.harness, 'skills', 'server-core', 'modules', 'storage.md'), '\n- shared는 `storage/db/shared.ts`다\n');
    commitFiles(ws, {});
    const first = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    // item-ledger, routing, UserStateCore, QACore and BadgeCore depend on the changed modules and have no changed file
    const cases: [Record<string, string>, string][] = [
      [{ 'server/core/storage/tx.ts': 'a', 'server/core/storage/tests/tx.test.ts': 'a', 'tools/data-tool/src/a.ts': 'a' }, 'server: storage\nclient: \ntools: data-tool\n'],
      [{ 'server/core/storage/index.ts': 'a' }, 'server: storage\nclient: \ntools: \n'],
      [{ 'server/core/storage/dev/index.ts': 'a' }, 'server: storage\nclient: \ntools: \n'],
      [{ 'server/core/storage/db/shared.ts': 'a' }, 'server: storage\nclient: \ntools: \n'],
      [{ 'core-spec/cheat.json': JSON.stringify({ name: 'cheat', side: 'server', dependencies: [], optionalDependencies: [], devDependencies: [], settings: [] }) }, 'server: cheat\nclient: \ntools: \n'],
      [{ 'client/godot/core/user_state_core/user_state_core.gd': 'a' }, 'server: \nclient: UserStateCore\ntools: \n'],
      [{ 'client/godot/core/user_state_core/dev/user_state_core_dev.gd': 'a' }, 'server: \nclient: UserStateCore\ntools: \n'],
      [{ 'client/godot/core/user_state_core/events/changed.gd': 'a' }, 'server: \nclient: UserStateCore\ntools: \n'],
      // files of no module or tool
      [{ 'server/core/Dockerfile': 'a', 'server/core/gone/a.ts': 'a', 'client/godot/core/core_settings.gd': 'a', 'client/godot/core/gone_core/a.gd': 'a', 'tools/other-tool/a.ts': 'a' }, 'server: \nclient: \ntools: \n'],
    ];
    for (const [files, expected] of cases) {
      const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      commitFiles(ws, files);
      expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout, Object.keys(files).join(' ')).toBe(expected);
    }
    expect(JSON.parse((await ogw(ws, ['core', 'review-targets', '--since', first, '--json'])).stdout)).toEqual({ server: ['cheat', 'storage'], client: ['UserStateCore'], tools: ['data-tool'] });
  });

  it('classifies both the old and the new path of a moved file', async () => {
    const ws = workspace();
    const text = 'the same text, so that git sees a rename\n'.repeat(5);
    commitFiles(ws, { 'client/godot/core/user_state_core/cache.gd': text, 'server/core/storage/a.ts': text });
    const since = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    mkdirSync(join(ws.coreImpl, 'client/godot/core/qa_core'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'server/core/cheat'), { recursive: true });
    sh(ws.coreImpl, 'git', ['mv', 'client/godot/core/user_state_core/cache.gd', 'client/godot/core/qa_core/cache.gd']);
    sh(ws.coreImpl, 'git', ['mv', 'server/core/storage/a.ts', 'server/core/cheat/a.ts']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', 'move']);
    expect((await ogw(ws, ['core', 'review-targets', '--since', since])).stdout).toBe('server: cheat storage\nclient: QACore UserStateCore\ntools: \n');
  });

  it('fails without --since', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'review-targets'])).stderr).toBe('usage: ogw core review-targets --since <commit>\n');
  });
});
