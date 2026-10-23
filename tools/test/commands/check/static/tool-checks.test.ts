import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as coreDiff from '../../../../src/commands/check/static/core-diff.ts';
import * as contractCheck from '../../../../src/commands/check/static/contract.ts';
import * as generatedDiff from '../../../../src/commands/check/static/generated-diff.ts';
import { godotExecutable, godotKeyNames } from '../../../../src/commands/check/static/lib/engine.ts';
import { StaticContext } from '../../../../src/commands/check/static/lib/context.ts';
import * as lint from '../../../../src/commands/check/static/lint.ts';
import * as typeCheck from '../../../../src/commands/check/static/type-check.ts';
import { repoPath } from '../../../../src/commands/check/static/lib/files.ts';
import { gdlintConfig, godotErrors } from '../../../../src/commands/code/gdscript-checks.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { bothModes, type OneProcessFault } from '../../../helpers/godot.ts';
import { makeGame, makeWorkspace, sh } from '../../../helpers/workspace.ts';
import { absentLines, lines, memContext, sorted, testContext, writeFiles } from './helpers.ts';

interface Mocks {
  releaseDir: string;
  assets: Record<string, string>;
  engine: string | null;
  engineAsks: string[];
  gdlint: string | null;
  generate: (root: string) => void;
  data: string[];
  dataOptions: unknown[];
  contract: string[];
  contractOptions: unknown[];
  contractResult: (root: string) => Promise<{ exitCode: number; violations: string[]; stderr: string }>;
  dataExit: number;
}

const mocks = vi.hoisted(
  (): Mocks => ({
    releaseDir: '',
    assets: {},
    engine: null,
    engineAsks: [],
    gdlint: null,
    generate: () => undefined,
    data: [],
    dataOptions: [],
    contract: [],
    contractOptions: [],
    contractResult: () => Promise.resolve({ exitCode: 0, violations: [], stderr: '' }),
    dataExit: 0,
  }),
);

vi.mock('../../../../src/commands/core/api.ts', () => ({
  coreReleaseOfGame: () => Promise.resolve({ version: '1.2.3', dir: mocks.releaseDir, local: false }),
  extractedAsset: (_ctx: unknown, _release: unknown, asset: string) => Promise.resolve(mocks.assets[asset] ?? ''),
}));

vi.mock('../../../../src/commands/env/api.ts', () => ({
  requireEngine: (_ctx: unknown, engine: string, version: string) => {
    mocks.engineAsks.push(`${engine} ${version}`);
    if (mocks.engine === null) return Promise.reject(new OgwError(`${engine} ${version} is not installed; run ogw env install-engines`));
    return Promise.resolve(mocks.engine);
  },
  toolProgram: () => Promise.resolve(mocks.gdlint),
}));

vi.mock('../../../../src/commands/generate/api.ts', () => ({
  runGenerate: (_ctx: unknown, game: GameRepo) => {
    mocks.generate(game.root);
    return Promise.resolve();
  },
}));

vi.mock('../../../../src/commands/data/api.ts', () => ({
  runData: (_ctx: unknown, game: GameRepo, options?: unknown) => {
    mocks.data.push(game.root);
    mocks.dataOptions.push(options);
    return Promise.resolve({ exitCode: mocks.dataExit, lines: [], stderr: 'boom' });
  },
}));

vi.mock('../../../../src/commands/contract/api.ts', () => ({
  runContract: (_ctx: unknown, game: GameRepo, options?: unknown) => {
    mocks.contract.push(game.root);
    mocks.contractOptions.push(options);
    return mocks.contractResult(game.root);
  },
}));

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-static-tool-')));
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('core diff', () => {
  it('compares client/core with the core/ folder of the client zip and server/core with the server asset', async () => {
    const client = tempDir();
    const server = tempDir();
    // the client zip holds `core/` and `engine.json`; `ogw generate` mirrors only `core/` to `client/core/`
    writeFiles(client, { 'engine.json': '{}', 'core/ui_core/ui_core.gd': 'a', 'core/ui_core/ui_core.gd.uid': 'uid', 'core/net/x.gd': 'release' });
    writeFiles(server, { 'routing/index.ts': 's', 'Dockerfile': 'FROM x' });
    mocks.assets = { 'client-godot.zip': client, 'server.tgz': server };
    const sc = memContext({
      'settings.json': '{"engine": "godot"}',
      'client/core/ui_core/ui_core.gd': 'a',
      'client/core/net/x.gd': 'changed',
      'client/core/extra.gd': 'x',
      'server/core/routing/index.ts': 's',
      'server/core/Dockerfile': 'FROM x',
    });
    const core = await coreDiff.run(sc);
    expect(absentLines(core)).toEqual(['client/core/ui_core:1 | core diff: client/core/ui_core/ui_core.gd.uid missing; core 1.2.3 has it']);
    expect(lines(core)).toEqual(sorted([
      'client/core/extra.gd:1 | core diff: not in core 1.2.3',
      'client/core/net/x.gd:1 | core diff: differs from core 1.2.3',
      'client/core/ui_core:1 | core diff: client/core/ui_core/ui_core.gd.uid missing; core 1.2.3 has it',
    ]));
    expect(await coreDiff.walk(join(client, 'nope'))).toEqual([]);
  });
});

describe('generated diff', () => {
  beforeEach(() => {
    mocks.data = [];
    mocks.dataOptions = [];
    mocks.contract = [];
    mocks.contractOptions = [];
    mocks.dataExit = 0;
    mocks.contractResult = () => Promise.resolve({ exitCode: 0, violations: [], stderr: '' });
  });

  async function game(files: Record<string, string>): Promise<{ sc: StaticContext; root: string; worktrees: string; fresh: () => Promise<StaticContext> }> {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', files);
    const ctx = testContext(root, ws.env);
    const repo = await ctx.game('g');
    return { sc: await StaticContext.create(ctx, repo), root, worktrees: ws.worktrees, fresh: () => StaticContext.create(ctx, repo) };
  }

  it('passes when regenerating HEAD plus staged changes gives the same files, and removes the worktree', async () => {
    const { sc, root, worktrees } = await game({ 'contract/a.proto': 'v1', 'client/generated/a.gd': 'v1', 'data/simulation_tables.csv': 'table\n' });
    writeFiles(root, { 'contract/a.proto': 'v2', 'client/generated/a.gd': 'v2' });
    sh(root, 'git', ['add', 'contract/a.proto', 'client/generated/a.gd']);
    writeFiles(root, { 'client/generated/a.gd': 'unstaged' });
    const seen: string[] = [];
    mocks.generate = (wt) => {
      seen.push(wt);
      writeFiles(wt, { 'client/generated/a.gd': readFileSync(join(wt, 'contract/a.proto'), 'utf8') });
    };
    const [generated, contract] = await Promise.all([generatedDiff.run(sc), contractCheck.run(sc)]);
    expect(generated).toEqual([]);
    expect(contract).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^${worktrees}/g/check-`));
    expect(mocks.data).toEqual(seen);
    expect(mocks.contract).toEqual(seen);
    expect(mocks.dataOptions).toEqual([{ generate: false }]);
    expect(mocks.contractOptions).toEqual([{ generate: false }]);
    expect(existsSync(seen[0] as string)).toBe(false);
    expect(readdirSync(join(worktrees, 'g'))).toEqual([]);
    expect(sh(root, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('reads the staged changes while another git holds the index lock of the checkout', async () => {
    const { sc, root } = await game({ 'contract/a.proto': 'v1', 'client/generated/a.gd': 'v1', 'data/simulation_tables.csv': 'table\n' });
    writeFiles(root, { 'contract/a.proto': 'v2', 'client/generated/a.gd': 'v2' });
    sh(root, 'git', ['add', 'contract/a.proto', 'client/generated/a.gd']);
    writeFiles(root, { '.git/index.lock': '' });
    mocks.generate = (wt) => {
      writeFiles(wt, { 'client/generated/a.gd': readFileSync(join(wt, 'contract/a.proto'), 'utf8') });
    };
    expect(await generatedDiff.run(sc)).toEqual([]);
    expect(existsSync(join(root, '.git/index.lock'))).toBe(true);
  });

  it('reports changed, missing and extra generated files', async () => {
    const { sc } = await game({ 'client/generated/a.gd': 'old', 'server/dev/generated/x.ts': 'x', 'data/simulation_tables.csv': 'table\n' });
    mocks.generate = (wt) => {
      writeFiles(wt, { 'client/generated/a.gd': 'new', 'client/dev/generated/r.gd': 'r', 'data/simulation_tables.csv': 'table\nlevel\n' });
      rmSync(join(wt, 'server/dev/generated/x.ts'));
    };
    const generated = await generatedDiff.run(sc);
    expect(absentLines(generated)).toEqual([
      'client/dev/generated:1 | generated diff: client/dev/generated/r.gd is missing; `ogw generate`, `ogw data`, `ogw contract` produce it',
    ]);
    expect(lines(generated)).toEqual(sorted([
      'client/dev/generated:1 | generated diff: client/dev/generated/r.gd is missing; `ogw generate`, `ogw data`, `ogw contract` produce it',
      'client/generated/a.gd:1 | generated diff: differs from the output of `ogw generate`, `ogw data`, `ogw contract`',
      'data/simulation_tables.csv:1 | generated diff: differs from the output of `ogw generate`, `ogw data`, `ogw contract`',
      'server/dev/generated/x.ts:1 | generated diff: is not produced by `ogw generate`, `ogw data`, `ogw contract`',
    ]));
  });

  it('reports a failed generate, data tool or ogw contract as a finding, removing the worktree', async () => {
    const { sc, worktrees, fresh } = await game({ 'a.txt': 'a' });
    mocks.generate = () => {
      throw new OgwError('project_settings.cfg has key x');
    };
    expect(lines(await generatedDiff.run(sc))).toEqual(['client/generated:1 | generated diff: ogw generate failed: project_settings.cfg has key x']);
    mocks.generate = () => undefined;
    mocks.dataExit = 2;
    const dataFailed = await fresh();
    expect(lines(await generatedDiff.run(dataFailed))).toEqual(['data:1 | generated diff: ogw data failed: data tool failed: boom']);
    expect(await contractCheck.run(dataFailed)).toEqual([]);
    mocks.dataExit = 0;
    mocks.contractResult = () => Promise.reject(new OgwError('no server/generated/contract/contract_version at prod-1.0.0'));
    const contractFailed = await fresh();
    expect(lines(await generatedDiff.run(contractFailed))).toEqual([
      'contract:1 | generated diff: ogw contract failed: no server/generated/contract/contract_version at prod-1.0.0',
    ]);
    expect(lines(await contractCheck.run(contractFailed))).toEqual([
      'contract:1 | contract: ogw contract failed: no server/generated/contract/contract_version at prod-1.0.0',
    ]);
    expect(readdirSync(join(worktrees, 'g'))).toEqual([]);
  });
});

describe('contract', () => {
  beforeEach(() => {
    mocks.contract = [];
    mocks.contractResult = () => Promise.resolve({ exitCode: 0, violations: [], stderr: '' });
  });

  async function game(files: Record<string, string>): Promise<{ sc: StaticContext; root: string; worktrees: string; fresh: () => Promise<StaticContext> }> {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', files);
    const ctx = testContext(root, ws.env);
    const repo = await ctx.game('g');
    return { sc: await StaticContext.create(ctx, repo), root, worktrees: ws.worktrees, fresh: () => StaticContext.create(ctx, repo) };
  }

  it('reports the ogw contract violations of HEAD plus staged changes and removes the worktree', async () => {
    const { sc, root, worktrees } = await game({ 'contract/game.proto': 'v1' });
    writeFiles(root, { 'contract/game.proto': 'v2' });
    sh(root, 'git', ['add', 'contract/game.proto']);
    writeFiles(root, { 'contract/game.proto': 'unstaged' });
    let seen = '';
    mocks.contractResult = (wt) => {
      seen = readFileSync(join(wt, 'contract/game.proto'), 'utf8');
      return Promise.resolve({ exitCode: 1, violations: ['contract/game.proto:3:5 ERROR missing (ogw.errors)', 'odd line'], stderr: '' });
    };
    expect(await contractCheck.run(sc)).toEqual([
      { where: 'contract/game.proto:3', message: 'contract: missing (ogw.errors)' },
      { where: 'contract:1', message: 'contract: odd line' },
    ]);
    expect(seen).toBe('v2');
    expect(mocks.contract[0]).toMatch(new RegExp(`^${worktrees}/g/check-`));
    expect(readdirSync(join(worktrees, 'g'))).toEqual([]);
  });

  it('passes without violations, reports an exit without lines and a failed ogw contract, leaves a tool failure to generated diff, and stops on a crash', async () => {
    const { sc, worktrees, fresh } = await game({ 'a.txt': 'a' });
    expect(await contractCheck.run(sc)).toEqual([]);
    mocks.contractResult = () => Promise.resolve({ exitCode: 1, violations: [], stderr: '' });
    expect(lines(await contractCheck.run(await fresh()))).toEqual(['contract:1 | contract: ogw contract ended with 1']);
    mocks.contractResult = () => Promise.reject(new OgwError('no settings'));
    expect(lines(await contractCheck.run(await fresh()))).toEqual(['contract:1 | contract: ogw contract failed: no settings']);
    mocks.contractResult = () => Promise.resolve({ exitCode: 2, violations: [], stderr: ' bad args \n' });
    const toolFailed = await fresh();
    expect(await contractCheck.run(toolFailed)).toEqual([]);
    expect(lines(await generatedDiff.run(toolFailed))).toEqual(['contract:1 | generated diff: ogw contract failed: contract tool failed: bad args']);
    mocks.contractResult = () => Promise.reject(new Error('crash'));
    await expect(contractCheck.run(await fresh())).rejects.toThrow('crash');
    expect(readdirSync(join(worktrees, 'g'))).toEqual([]);
  });
});

describe('godot helpers', () => {
  beforeEach(() => {
    mocks.engineAsks = [];
    mocks.releaseDir = tempDir();
    const zip = tempDir();
    writeFiles(zip, { 'engine.json': '{"godot": "4.5.1.stable"}' });
    mocks.assets = { 'client-godot.zip': zip };
  });

  it('asks for the engine version of the release and checks key names', async () => {
    const bin = tempDir();
    mocks.engine = script(bin, 'godot', 'shift 4\nout=""\nfor n in "$@"; do if [ "$n" = "Space" ]; then out="$out,true"; else out="$out,false"; fi; done\necho "noise"\necho "OGW_KEYS [${out#,}]"');
    const sc = memContext({ 'settings.json': '{}' });
    expect(await godotExecutable(sc)).toBe(mocks.engine);
    expect(mocks.engineAsks).toEqual(['godot 4.5.1.stable']);
    expect([...(await godotKeyNames(sc, ['Space', 'Spcae']))]).toEqual([['Space', true], ['Spcae', false]]);
    expect((await godotKeyNames(sc, [])).size).toBe(0);
  });

  it('fails when the engine is missing or prints nothing', async () => {
    mocks.engine = null;
    await expect(godotExecutable(memContext({}))).rejects.toThrow('godot 4.5.1.stable is not installed; run ogw env install-engines');
    mocks.engine = script(tempDir(), 'godot', 'echo nothing');
    await expect(godotKeyNames(memContext({}), ['A'])).rejects.toThrow('godot could not check key names');
    writeFiles(mocks.assets['client-godot.zip'] as string, { 'engine.json': '{}' });
    await expect(godotExecutable(memContext({}))).rejects.toThrow('engine.json of the core release has no `godot` version');
  });
});

describe('type check', () => {
  beforeEach(() => {
    mocks.releaseDir = tempDir();
    const zip = tempDir();
    writeFiles(zip, { 'engine.json': '{"godot": "4.5.1.stable"}' });
    mocks.assets = { 'client-godot.zip': zip };
  });

  it('runs godot import then check-only per content file under the import lock and reads its errors', async () => {
    const bin = tempDir();
    const log = join(bin, 'log');
    mocks.engine = script(
      bin,
      'godot',
      `echo "$@" >> ${log}\n[ -d "$3/../.ogw-import.lock" ] || echo "$@" >> ${log}.unlocked\n${bothModes(`case "$*" in\n  *res://features/a/bad.gd*) echo "SCRIPT ERROR: Parse Error: Identifier \\"x\\" not declared."; echo "   at: GDScript::reload (res://features/a/bad.gd:3)"; echo "ERROR: Failed to load script"; exit 1;;\n  *res://features/a/odd.gd*) echo "ERROR: something"; exit 0;;\n  *res://features/a/exit.gd*) exit 2;;\nesac\nexit 0`)}`,
    );
    const sc = memContext({
      'client/features/a/bad.gd': 'x',
      'client/features/a/odd.gd': 'x',
      'client/features/a/exit.gd': 'x',
      'client/features/a/good.gd': 'x',
      'client/core/a.gd': 'x',
    });
    expect(lines(await typeCheck.run(sc))).toEqual(sorted([
      'client/features/a/bad.gd:3 | type check: Parse Error: Identifier "x" not declared.',
      'client/features/a/exit.gd:1 | type check: the script is not valid',
      'client/features/a/odd.gd:1 | type check: ERROR: something',
    ]));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe(`--headless --path ${join(sc.root, 'client')} --import`);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(new RegExp(`^--headless --path ${join(sc.root, 'client')} -s \\S+/ogw_check\\.gd -- \\S+/files\\.txt$`));
    // the import and the check-only runs hold the lock the runner's import takes; it is gone after the check
    expect(existsSync(`${log}.unlocked`)).toBe(false);
    expect(existsSync(join(sc.root, '.ogw-import.lock'))).toBe(false);
  });

  it('fails on an engine error line before the first script, as a project setting\'s missing resource, and keeps no pass', async () => {
    const bin = tempDir();
    const log = join(bin, 'log');
    // Godot prints the error of the missing theme in every process, before it loads any script
    const theme = `echo "ERROR: Cannot open file 'res://missing_theme.tres'." >&2`;
    mocks.engine = script(bin, 'godot', `echo "$@" >> ${log}\n${bothModes(`case "$*" in\n  *--check-only*) ${theme};;\nesac\nexit 0`, { before: theme })}`);
    const sc = memContext({ 'client/features/a/good.gd': 'x', 'client/features/a/other.gd': 'x' });
    const failure = sorted([
      "client/features/a/good.gd:1 | type check: ERROR: Cannot open file 'res://missing_theme.tres'.",
      "client/features/a/other.gd:1 | type check: ERROR: Cannot open file 'res://missing_theme.tres'.",
    ]);
    expect(lines(await typeCheck.run(sc))).toEqual(failure);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((call) => call.includes('--check-only --script')).map((call) => call.replace(/^.* --script /, '')).sort()).toEqual([
      'res://features/a/good.gd', 'res://features/a/other.gd',
    ]);
    // the check is not taken from a cached pass
    expect(lines(await typeCheck.run(memContext({ 'client/features/a/good.gd': 'x', 'client/features/a/other.gd': 'x' })))).toEqual(failure);
  });

  const faults: [string, OneProcessFault][] = [
    ['an error line after the last script', { after: 'echo "ERROR: 1 resources still in use at exit." >&2' }],
    ['an exit code other than 0', { code: 2 }],
  ];
  it.each(faults)('checks each content file in its own process when the one process run has %s', async (_name, fault) => {
    const bin = tempDir();
    const log = join(bin, 'log');
    const body = `case "$*" in\n  *--check-only*res://features/a/bad.gd*) echo "SCRIPT ERROR: Parse Error: x"; echo "   at: GDScript::reload (res://features/a/bad.gd:3)"; exit 1;;\n  *--check-only*res://features/a/good.gd*) [ -z "$ONE_PROCESS" ] && { echo "ERROR: only in its own process"; exit 1; };;\nesac\nexit 0`;
    mocks.engine = script(bin, 'godot', `echo "$@" >> ${log}\n${bothModes(body, fault)}`);
    const sc = memContext({ 'client/features/a/bad.gd': 'x', 'client/features/a/good.gd': 'x' });
    expect(lines(await typeCheck.run(sc))).toEqual(sorted([
      'client/features/a/bad.gd:3 | type check: Parse Error: x',
      'client/features/a/good.gd:1 | type check: ERROR: only in its own process',
    ]));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((call) => / -s /.test(call))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('--check-only --script')).map((call) => call.replace(/^.* --script /, '')).sort()).toEqual([
      'res://features/a/bad.gd', 'res://features/a/good.gd',
    ]);
  });

  it('does not import again a client the caller just imported', async () => {
    const bin = tempDir();
    const log = join(bin, 'log');
    mocks.engine = script(bin, 'godot', `echo "$@" >> ${log}\n${bothModes('exit 0')}`);
    const sc = memContext({ 'client/features/a/good.gd': 'x' });
    sc.imported = true;
    expect(lines(await typeCheck.run(sc))).toEqual([]);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`^--headless --path ${join(sc.root, 'client')} -s `));
  });

  it('reports the caller\'s failed import and does not run godot', async () => {
    mocks.engine = null;
    mocks.engineAsks = [];
    const sc = memContext({ 'client/features/a/good.gd': 'x' });
    sc.importFailure = 'godot --import failed (1)';
    expect(lines(await typeCheck.run(sc))).toEqual(['client/project.godot:1 | type check: godot --import failed (1)']);
    expect(mocks.engineAsks).toEqual([]);
  });

  it('type checks server content code with tsc strict', () => {
    const root = tempDir();
    writeFiles(root, {
      'server/handlers/A.ts': "import { add } from '../common/math.ts';\nexport const x: number = add(1, 2);\nexport const y: string = add(1, 2);\n",
      'server/common/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function loose(a) {\n  return a;\n}\n',
      'server/core/x.ts': 'export const z: number = "no";\n',
    });
    expect(lines(typeCheck.typescriptErrors(root, ['server/common/math.ts', 'server/handlers/A.ts']))).toEqual([
      "server/common/math.ts:4 | type check: TS7006 Parameter 'a' implicitly has an 'any' type.",
      "server/handlers/A.ts:3 | type check: TS2322 Type 'number' is not assignable to type 'string'.",
    ]);
    expect(typeCheck.typescriptErrors(root, [])).toEqual([]);
  });

  it('uses the ogw tsconfig options and sees server code as an ES module unless server/package.json says otherwise', () => {
    const root = tempDir();
    writeFiles(root, { 'server/common/list.ts': 'const a: number[] = [];\nexport const b: number = a[0];\n' });
    expect(lines(typeCheck.typescriptErrors(root, ['server/common/list.ts']))).toEqual([
      "server/common/list.ts:2 | type check: TS2322 Type 'number | undefined' is not assignable to type 'number'.   Type 'undefined' is not assignable to type 'number'.",
    ]);
    expect(typeCheck.SERVER_PACKAGE_JSON).toBe('{"type":"module"}');
    const cjs = tempDir();
    writeFiles(cjs, { 'server/package.json': '{"type":"commonjs"}', 'server/a.ts': 'export const c = 1;\n' });
    expect(lines(typeCheck.typescriptErrors(cjs, ['server/a.ts']))[0]).toMatch(/^server\/a\.ts:1 \| type check: TS1287 /);
  });

  it('type checks server regression tests with the vitest globals', () => {
    const root = tempDir();
    writeFiles(root, { 'server/tests/shop.test.ts': "describe('a', () => {\n  it('b', () => {\n    expect(1).toBe(1);\n  });\n});\n" });
    expect(lines(typeCheck.typescriptErrors(root, ['server/tests/shop.test.ts']))).toEqual([]);
  });

  it('reads godot output without locations', () => {
    expect(godotErrors('SCRIPT ERROR: bad\n   at: x (core/a.cpp:1)\n', 'client/a.gd', 1, repoPath)).toEqual([{ path: 'client/a.gd', line: 1, message: 'bad' }]);
    expect(godotErrors('fine\n', 'client/a.gd', 0, repoPath)).toEqual([]);
  });
});

describe('lint', () => {
  it('runs gdlint with only the name rules and reads its errors', async () => {
    const bin = tempDir();
    const log = join(bin, 'log');
    mocks.gdlint = script(bin, 'gdlint', `cat gdlintrc > ${log}\nfor f in "$@"; do case "$f" in *Bad*) echo "$f:2: Error: Function name \\"Foo\\" is not valid (function-name)";; esac; done\nexit 1`);
    const sc = memContext({ 'client/features/a/Bad.gd': 'x', 'client/features/a/good.gd': 'x' });
    expect(lines(await lint.run(sc))).toEqual(['client/features/a/Bad.gd:2 | lint: Function name "Foo" is not valid (function-name)']);
    const config = readFileSync(log, 'utf8');
    expect(config).toBe(gdlintConfig());
    expect(config).toContain('  - max-line-length\n');
    expect(config).not.toContain('function-name');
  });

  it('fails without gdlint or when gdlint fails without findings', async () => {
    mocks.gdlint = null;
    await expect(lint.run(memContext({ 'client/features/a/a.gd': 'x' }))).rejects.toThrow('harness settings tools.gdtoolkit (gdlint) is not installed on this host');
    mocks.gdlint = script(tempDir(), 'gdlint', 'echo crashed >&2\nexit 3');
    await expect(lint.run(memContext({ 'client/features/a/a.gd': 'x' }))).rejects.toThrow('gdlint failed: crashed');
    expect(await lint.run(memContext({ 'a.txt': 'x' }))).toEqual([]);
  });

  it('lints server content code with the code check ESLint config', async () => {
    mocks.gdlint = null;
    const sc = memContext({
      'server/handlers/A.ts': 'export function f(a: any): number {\n  return a;\n}\nexport const ok = 1;\n',
    });
    const found = lines(await lint.run(sc));
    expect(found.some((l) => l.startsWith('server/handlers/A.ts:1 | lint: @typescript-eslint/no-explicit-any'))).toBe(true);
    expect(found.every((l) => l.startsWith('server/handlers/A.ts:'))).toBe(true);
  }, 60_000);

  it('lints server regression tests with the vitest globals', async () => {
    mocks.gdlint = null;
    const sc = memContext({ 'server/tests/shop.test.ts': "describe('a', () => {\n  it('b', () => {\n    expect(1).toBe(1);\n  });\n});\n" });
    expect(lines(await lint.run(sc))).toEqual([]);
  }, 60_000);
});
