import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutLock } from '../../../src/lib/git.ts';
import { withWriter } from '../../../src/lib/rwlock.ts';
import { ogw, commitAll, makeWorkspace, realHarness, sh, type TestWorkspace } from '../../helpers/workspace.ts';

/** The text of a code check whose four checks pass; each line may end with the check's wall time. */
const ALL_PASS = /^type check: pass( \(\d+ s\))?\nlint: pass( \(\d+ s\))?\ndependency: pass( \(\d+ s\))?\nsecret: pass( \(\d+ s\))?\n$/;
/** `ALL_PASS` of a `--commit` run of `ogw code check tool`, which also runs the tool test suite of that commit. */
const ALL_PASS_AT = /^type check: pass( \(\d+ s\))?\nlint: pass( \(\d+ s\))?\ndependency: pass( \(\d+ s\))?\nsecret: pass( \(\d+ s\))?\ntool tests: pass( \(\d+ s\))?\n$/;

function checksOf(stdout: string): Map<string, { name: string; result: string; failures: string[] }> {
  const checks = (JSON.parse(stdout) as { checks: { name: string; result: string; failures: string[] }[] }).checks;
  return new Map(checks.map((c) => [c.name, c]));
}

const FILES: Record<string, string> = {
  'tools/package.json': '{ "name": "fixture", "type": "module", "private": true }\n',
  'tools/package-lock.json': '{ "lockfileVersion": 3 }\n',
  'tools/src/commands/demo/run.ts': "import { note } from './lib/util.ts';\n\nexport function double(n: number, log: (s: string) => void): number {\n  note(log);\n  return n * 2;\n}\n",
  'tools/src/commands/demo/stop.ts': "export function stop(flag: boolean): string {\n  if (flag) return 'yes';\n  return 'no';\n}\n",
  'tools/src/commands/demo/lib/util.ts': "export function note(log: (s: string) => void): void {\n  log('message text');\n}\n",
  'tools/src/commands/other/other.ts': 'export const other = 1;\n',
  'tools/test/commands/demo/run.test.ts':
    "import { describe, expect, it } from 'vitest';\nimport { double } from '../../../src/commands/demo/run.ts';\n\ndescribe('double', () => {\n  it('doubles', () => {\n    const lines: string[] = [];\n    expect(double(3, (s) => lines.push(s))).toBe(6);\n    expect(lines).toHaveLength(1);\n  });\n});\n",
};

/** The harness copy gets a small ogw `tools/` with its own package, linked to the real node_modules. */
function fixture(ws: TestWorkspace, extra: Record<string, string> = {}): void {
  const files: Record<string, string> = { ...FILES, ...extra };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws.harness, path)), { recursive: true });
    writeFileSync(join(ws.harness, path), text);
  }
  writeFileSync(join(ws.harness, '.gitignore'), 'tools/node_modules\n');
  symlinkSync(resolve(realHarness, 'tools', 'node_modules'), join(ws.harness, 'tools', 'node_modules'));
  commitAll(ws.harness, 'fixture');
}

/** A fake `npm`: `ci` passes unless the package has a `ci-fails` file; `audit` prints `audit` and fails when it is set. */
function fakeNpm(ws: TestWorkspace, audit = ''): NodeJS.ProcessEnv {
  const bin = join(ws.root, 'npm-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'npm');
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = ci ]; then if [ -f ci-fails ]; then echo 'ci broke' >&2; exit 1; fi; [ -f package-lock.json ] && exit 0; exit 1; fi\nif [ -n '${audit}' ]; then printf '%s' '${audit}'; exit 1; fi\necho '{}'\n`,
  );
  chmodSync(script, 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? ''}` };
}

describe('ogw code check tool', () => {
  it('passes clean code', async () => {
    const ws = makeWorkspace();
    fixture(ws);
    const run = await ogw(ws, ['code', 'check', 'tool'], { env: fakeNpm(ws) });
    expect(run).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
  });

  it('reports type, lint, dependency and secret failures with locations', async () => {
    const ws = makeWorkspace({
      resourceGeneration: [{ name: 'svc', kind: 'external-service', resourceTypes: ['image'], safetyTimeoutMs: 1000, secret: 'svcKey' }],
    });
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/svcKey': 'sk-very-secret-value' }));
    fixture(ws, {
      'tools/src/commands/demo/bad.ts': "export const n: number = 'text';\n",
      'tools/src/commands/demo/leak.ts': `export const where = '${ws.root}/x';\nexport const key = 'sk-very-secret-value';\n`,
      'tools/src/commands/demo/lint.ts': 'export function f(a: number | null): number {\n  return a!;\n}\n',
      'tools/sub/package.json': '{ "name": "sub" }\n',
    });
    const audit = JSON.stringify({ vulnerabilities: { leftpad: { severity: 'high' }, minor: { severity: 'low' } } });
    const run = await ogw(ws, ['code', 'check', 'tool', '--json'], { env: fakeNpm(ws, audit) });
    expect(run.code).toBe(1);
    const checks = (JSON.parse(run.stdout) as { checks: { name: string; result: string; failures: string[] }[] }).checks;
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('type check')?.failures).toEqual([expect.stringMatching(/^src\/commands\/demo\/bad\.ts:1:14 TS2322 /) as string]);
    expect(byName.get('lint')?.failures.some((f) => f.startsWith('src/commands/demo/lint.ts:2:10 @typescript-eslint/no-non-null-assertion'))).toBe(true);
    expect(byName.get('dependency')?.failures.sort()).toEqual(['.: npm audit: leftpad high', 'sub: package-lock.json is missing']);
    expect(byName.get('secret')?.failures).toEqual(['src/commands/demo/leak.ts:1: workspace path', 'src/commands/demo/leak.ts:2: secret svcKey']);
    expect(run.stdout).not.toContain('"sk-very');
  });

  it('fails a function above codeCheck.maxComplexity and a package whose npm ci fails', async () => {
    const ws = makeWorkspace({ codeCheck: { maxComplexity: 2 } });
    fixture(ws, {
      'tools/src/commands/demo/complex.ts':
        "export function pick(a: number): string {\n  if (a > 2) return 'c';\n  if (a > 1) return 'b';\n  return 'a';\n}\n",
      'tools/sub/package.json': '{ "name": "sub" }\n',
      'tools/sub/package-lock.json': '{ "lockfileVersion": 3 }\n',
      'tools/sub/ci-fails': '',
    });
    const run = await ogw(ws, ['code', 'check', 'tool', '--json'], { env: fakeNpm(ws) });
    expect(run.code).toBe(1);
    const checks = (JSON.parse(run.stdout) as { checks: { name: string; result: string; failures: string[] }[] }).checks;
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('lint')?.failures).toEqual([expect.stringMatching(/^src\/commands\/demo\/complex\.ts:1:8 complexity /) as string]);
    expect(byName.get('dependency')?.failures).toEqual(['sub: npm ci failed: ci broke']);
  });

  it('loads ambient declaration files and checks .mts, .cts and .tsx files', async () => {
    const ws = makeWorkspace();
    fixture(ws, {
      'tools/src/env.d.ts': 'declare global {\n  var ogwFlag: number;\n}\nexport {};\n',
      'tools/src/flag.ts': 'export const v: number = globalThis.ogwFlag;\n',
    });
    expect(await ogw(ws, ['code', 'check', 'tool'], { env: fakeNpm(ws) })).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(ALL_PASS) as string,
    });
    writeFileSync(join(ws.harness, 'tools/src/bad.mts'), "export const n: number = 'text';\n");
    writeFileSync(join(ws.harness, 'tools/src/bad.cts'), 'export function f(a: number | null): number {\n  return a!;\n}\n');
    writeFileSync(join(ws.harness, 'tools/src/bad.tsx'), 'export const t: string = 1;\n');
    commitAll(ws.harness, 'more');
    const run = await ogw(ws, ['code', 'check', 'tool', '--json'], { env: fakeNpm(ws) });
    const byName = checksOf(run.stdout);
    expect(byName.get('type check')?.failures).toEqual([
      expect.stringMatching(/^src\/bad\.cts:1:1 TS1287 /) as string,
      expect.stringMatching(/^src\/bad\.mts:1:14 TS2322 /) as string,
      expect.stringMatching(/^src\/bad\.tsx:1:14 TS2322 /) as string,
    ]);
    expect(byName.get('lint')?.failures.some((f) => f.startsWith('src/bad.cts:2:10 @typescript-eslint/no-non-null-assertion'))).toBe(true);
  });

  it("ignores the target's own tsconfig.json and eslint.config.js", async () => {
    const ws = makeWorkspace();
    fixture(ws, {
      'tools/tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false }, include: ['src'] }),
      'tools/eslint.config.js': "export default [{ rules: { '@typescript-eslint/no-non-null-assertion': 'off' } }];\n",
      'tools/src/commands/demo/loose.ts': 'export function g(a): number {\n  return a;\n}\n',
      'tools/src/commands/demo/lint.ts': 'export function f(a: number | null): number {\n  return a!;\n}\n',
    });
    const run = await ogw(ws, ['code', 'check', 'tool', '--json'], { env: fakeNpm(ws) });
    expect(run.code).toBe(1);
    const byName = checksOf(run.stdout);
    expect(byName.get('type check')?.failures).toEqual([expect.stringMatching(/^src\/commands\/demo\/loose\.ts:1:19 TS7006 /) as string]);
    expect(byName.get('lint')?.failures.some((f) => f.startsWith('src/commands/demo/lint.ts:2:10 @typescript-eslint/no-non-null-assertion'))).toBe(true);
  });

  it('checks the files at --commit, not later commits or changes of the checkout, with the checkout node_modules', async () => {
    const ws = makeWorkspace();
    fixture(ws);
    const at = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(ws.harness, 'tools/src/later.ts'), "export const n: number = 'text';\n");
    commitAll(ws.harness, 'later');
    writeFileSync(join(ws.harness, 'tools/src/uncommitted.ts'), "export const m: number = 'text';\n");
    const fixed = await ogw(ws, ['code', 'check', 'tool', '--commit', at], { env: fakeNpm(ws) });
    expect(fixed).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS_AT) as string });
    const live = await ogw(ws, ['code', 'check', 'tool', '--json'], { env: fakeNpm(ws) });
    expect(checksOf(live.stdout).get('type check')?.failures).toEqual([
      expect.stringMatching(/^src\/later\.ts:1:14 TS2322 /) as string,
      expect.stringMatching(/^src\/uncommitted\.ts:1:14 TS2322 /) as string,
    ]);
    expect(sh(ws.harness, 'git', ['status', '--porcelain'])).toBe('?? tools/src/uncommitted.ts\n');
    expect(sh(ws.harness, 'git', ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(join(ws.harness, '.git', 'ogw-temp')).filter((name) => name.startsWith('ogw-code-check-'))).toEqual([]);
    expect((await ogw(ws, ['code', 'check', 'tool', '--commit', 'nope'])).stderr).toContain(`commit nope not found in ${ws.harness}`);
  });

  it('rejects other sides and extra arguments', async () => {
    const ws = makeWorkspace();
    fixture(ws);
    expect((await ogw(ws, ['code', 'check', 'tool', 'demo'])).stderr).toContain('usage: ogw code check <core|tool>');
    expect((await ogw(ws, ['code', 'check', 'game'])).stderr).toContain('usage: ogw code check <core|tool>');
  });
});

describe('ogw code check core', () => {
  it('checks server core code and its core tests with vitest globals', async () => {
    const ws = makeWorkspace();
    const files: Record<string, string> = {
      'server/package.json': '{ "name": "server", "type": "module" }\n',
      'server/package-lock.json': '{}\n',
      'server/core/routing/index.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'server/core/routing/tests/add.test.ts': "import { add } from '../index.ts';\n\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(ws.coreImpl, path)), { recursive: true });
      writeFileSync(join(ws.coreImpl, path), text);
    }
    commitAll(ws.coreImpl, 'server');
    const run = await ogw(ws, ['code', 'check', 'core'], { env: fakeNpm(ws) });
    expect(run).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
  });

  it('does not type check or lint the benchmark game, whose server code needs the server core of a core release', async () => {
    const ws = makeWorkspace();
    const files: Record<string, string> = {
      'server/package.json': '{ "name": "server", "type": "module" }\n',
      'server/package-lock.json': '{}\n',
      'server/core/routing/index.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      // the server core the benchmark imports is not in open-game-works-core-impl/
      'benchmark/godot/server/main.ts': "import { open } from './core/storage/index.ts';\n\nexport const s = open;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(ws.coreImpl, path)), { recursive: true });
      writeFileSync(join(ws.coreImpl, path), text);
    }
    commitAll(ws.coreImpl, 'server and a benchmark game');
    const run = await ogw(ws, ['code', 'check', 'core'], { env: fakeNpm(ws) });
    expect(run).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
  });

  it('checks open-game-works-core-impl/ from the workspace and the core worktree from inside it', async () => {
    const ws = makeWorkspace();
    const write = (root: string, path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(ws.coreImpl, 'server/package.json', '{ "name": "server", "type": "module" }\n');
    write(ws.coreImpl, 'server/package-lock.json', '{}\n');
    write(ws.coreImpl, 'server/core/routing/index.ts', 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'server');
    const worktree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '-q', '-b', 'w1', worktree]);
    write(worktree, 'server/core/routing/index.ts', "export const n: number = 'text';\n");
    commitAll(worktree, 'broken');
    const fromRoot = await ogw(ws, ['code', 'check', 'core'], { env: fakeNpm(ws) });
    expect(fromRoot).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
    const inside = await ogw(ws, ['code', 'check', 'core', '--json'], { env: fakeNpm(ws), cwd: join(worktree, 'server') });
    expect(inside.code).toBe(1);
    expect(checksOf(inside.stdout).get('type check')?.failures).toEqual([expect.stringMatching(/^server\/core\/routing\/index\.ts:1:14 TS2322 /) as string]);
  });

  it('gives a core worktree package without node_modules the main checkout node_modules when the lock file is the same', async () => {
    const ws = makeWorkspace();
    const write = (root: string, path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(ws.coreImpl, '.gitignore', 'node_modules\n');
    write(ws.coreImpl, 'tools/data-tool/package.json', '{ "name": "data-tool", "type": "module" }\n');
    write(ws.coreImpl, 'tools/data-tool/package-lock.json', '{"v":1}\n');
    write(ws.coreImpl, 'tools/data-tool/src/index.ts', "import { size } from 'dep';\n\nexport const n: number = size;\n");
    write(ws.coreImpl, 'tools/data-tool/node_modules/dep/package.json', '{ "name": "dep", "types": "index.d.ts" }\n');
    write(ws.coreImpl, 'tools/data-tool/node_modules/dep/index.d.ts', 'export declare const size: number;\n');
    commitAll(ws.coreImpl, 'tool');
    const worktree = join(ws.worktrees, '_core', 'w2');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '-q', '-b', 'w2', worktree]);
    expect(existsSync(join(worktree, 'tools/data-tool/node_modules'))).toBe(false);
    const head = sh(worktree, 'git', ['rev-parse', 'HEAD']).trim();
    const same = await ogw(ws, ['code', 'check', 'core', '--commit', head], { env: fakeNpm(ws), cwd: worktree });
    expect(same).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
    // the live check of the worktree too; while its checks run (npm audit waits on a gate), nothing is in the worktree
    const gate = join(ws.root, 'audit-gate');
    mkdirSync(gate);
    const gated = join(ws.root, 'gated-npm-bin');
    mkdirSync(gated);
    writeFileSync(join(gated, 'npm'), `#!/bin/sh\ntouch '${gate}/started'\nwhile [ ! -f '${gate}/go' ]; do sleep 0.05; done\necho '{}'\n`);
    chmodSync(join(gated, 'npm'), 0o755);
    const liveRun = ogw(ws, ['code', 'check', 'core'], { env: { PATH: `${gated}:${process.env.PATH ?? ''}` }, cwd: worktree });
    for (let i = 0; i < 2000 && !existsSync(join(gate, 'started')); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(join(gate, 'started'))).toBe(true);
    expect(() => lstatSync(join(worktree, 'tools/data-tool/node_modules'))).toThrow();
    writeFileSync(join(gate, 'go'), '');
    expect(await liveRun).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
    expect(existsSync(join(worktree, 'tools/data-tool/node_modules'))).toBe(false);
    // the main checkout's tool packages are read while no tool build replaces them: a build waits for the check
    const lock = { base: await checkoutLock(ws.coreImpl, 'ogw-data-tool-build.lock', { env: ws.env }), waitMs: 60_000 };
    let built = 0;
    const checking = ogw(ws, ['code', 'check', 'core'], { env: fakeNpm(ws), cwd: worktree }).then((r) => ({ r, at: Date.now() }));
    // the check is a reader of the tool folder: its entry is there while it runs
    const readers = `${lock.base}-readers`;
    for (let i = 0; i < 400 && !(existsSync(readers) && readdirSync(readers).length > 0); i++) await new Promise((r) => setTimeout(r, 5));
    expect(readdirSync(readers).length).toBeGreaterThan(0);
    // and while it runs, nothing is put into the worktree's tool folder
    expect(() => lstatSync(join(worktree, 'tools/data-tool/node_modules'))).toThrow();
    await withWriter(lock, () => {
      built = Date.now();
      return Promise.resolve();
    });
    const { r: whileBuilt, at } = await checking;
    expect(whileBuilt.code).toBe(0);
    expect(built).toBeGreaterThanOrEqual(at - 50);
    // a link to the main packages that an earlier check left in the worktree is not the worktree's own
    symlinkSync(join(ws.coreImpl, 'tools/data-tool/node_modules'), join(worktree, 'tools/data-tool/node_modules'), 'dir');
    // another lock file: the main checkout packages are not the code's, so they are not used
    write(worktree, 'tools/data-tool/package-lock.json', '{"v":2}\n');
    commitAll(worktree, 'lock');
    const other = await ogw(ws, ['code', 'check', 'core', '--json', '--commit', sh(worktree, 'git', ['rev-parse', 'HEAD']).trim()], { env: fakeNpm(ws), cwd: worktree });
    expect(checksOf(other.stdout).get('type check')?.failures).toEqual([expect.stringMatching(/^tools\/data-tool\/src\/index\.ts:1:\d+ TS2307 /) as string]);
    const otherLive = await ogw(ws, ['code', 'check', 'core', '--json'], { env: fakeNpm(ws), cwd: worktree });
    expect(checksOf(otherLive.stdout).get('type check')?.failures).toEqual([expect.stringMatching(/^tools\/data-tool\/src\/index\.ts:1:\d+ TS2307 /) as string]);
  });

  it('runs as a background job', async () => {
    const ws = makeWorkspace();
    const started = await ogw(ws, ['code', 'check', 'core', '--background'], { env: fakeNpm(ws) });
    expect(started.code).toBe(0);
    const waited = await ogw(ws, ['job', 'wait', started.stdout.trim(), '--timeout', '60000']);
    expect(waited).toMatchObject({ code: 0, stdout: expect.stringMatching(ALL_PASS) as string });
  });
});
