import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixTestProof, sameDependencies } from '../../../../src/commands/code/lib/proof.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { ogw, commitAll, makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';

/** The result `ogw core test` gives per run on the proof worktree: set by each test. */
/** The `ogw core test` result the mock gives for the target: its module result and `counts`, each set on its own. */
const coreTest = vi.hoisted(() => ({
  module: 'pass',
  counts: { tests: 2, passed: 2, ran: true },
  failures: [] as string[],
  error: null as string | null,
  calls: [] as { args: string[]; cwd: string }[],
}));

vi.mock('../../../../src/lib/proc.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/lib/proc.ts')>();
  return {
    ...real,
    run: async (cmd: string, args: readonly string[], options: Parameters<typeof real.run>[2]) => {
      const at = args.indexOf('core');
      if (at < 0 || args[at + 1] !== 'test') return real.run(cmd, args, options);
      const rest = args.slice(at + 2, -1);
      coreTest.calls.push({ args: rest, cwd: options.cwd ?? '' });
      const module = rest[1] as string;
      const data = coreTest.error === null
        ? { modules: { [module]: coreTest.module }, counts: { [module]: coreTest.counts }, failures: { [module]: coreTest.failures } }
        : { error: coreTest.error };
      return { code: 0, signal: null, stdout: JSON.stringify(data), stderr: '', stdoutBytes: Buffer.alloc(0), timedOut: false };
    },
  };
});

function ctxOf(ws: TestWorkspace) {
  return createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('fix test proof: tool', () => {
  /** A harness repo whose `tools/` runs vitest with the node_modules of this ogw. */
  function toolRepo(): TestWorkspace {
    const ws = makeWorkspace();
    write(ws.harness, 'tools/package.json', '{ "type": "module" }\n');
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a - b;\n');
    write(ws.harness, 'tools/test/old.test.ts', "import { it } from 'vitest';\nit('runs', () => undefined);\n");
    symlinkSync(resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules'), join(ws.harness, 'tools', 'node_modules'), 'dir');
    write(ws.harness, '.gitignore', 'node_modules\n');
    return ws;
  }

  it('passes when the changed tests fail on the code before the fix, and fails when they pass there', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    write(ws.harness, 'tools/test/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add.ts';\nit('adds', () => expect(add(1, 2)).toBe(3));\n");
    const fixed = commitAll(ws.harness, 'fix');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined)).toEqual({ result: 'pass', failures: [] });
    // a passing test beside a describe that holds no test: no test failed
    write(ws.harness, 'tools/test/weak.test.ts', "import { describe, expect, it } from 'vitest';\nconst CASES: string[] = [];\nit('holds', () => expect(1).toBe(1));\ndescribe('cases', () => { for (const c of CASES) it(c, () => undefined); });\n");
    write(ws.harness, 'tools/src/add.ts', '// sums\nexport const add = (a: number, b: number): number => a + b;\n');
    const weak = commitAll(ws.harness, 'weak test');
    const proof = await fixTestProof(ctxOf(ws), 'tool', ws.harness, fixed, weak, undefined);
    expect(proof.result).toBe('fail');
    expect(proof.failures[0]).toContain(`the changed tests pass on ${fixed.slice(0, 12)}, the code before the fix`);
    expect(proof.failures[0]).toContain('test/weak.test.ts');
    // no worktree is left
    const worktrees = join(ws.harness, '.git', 'worktrees');
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
  });

  it('passes when a changed test file does not load on the code before the fix', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/src/sub.ts', 'export const sub = (a: number, b: number): number => a - b;\n');
    write(ws.harness, 'tools/test/sub.test.ts', "import { expect, it } from 'vitest';\nimport { sub } from '../src/sub.ts';\nit('subtracts', () => expect(sub(3, 2)).toBe(1));\n");
    const fixed = commitAll(ws.harness, 'fix');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined)).toEqual({ result: 'pass', failures: [] });
  });

  it('passes when the global setup of the changed tests does not load on the code before the fix', async () => {
    const ws = toolRepo();
    write(ws.harness, 'tools/vitest.config.ts', "export default { test: { globalSetup: ['./test/setup.ts'] } };\n");
    write(ws.harness, 'tools/test/setup.ts', 'export default (): void => undefined;\n');
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/src/mul.ts', 'export const mul = (a: number, b: number): number => a * b;\n');
    write(ws.harness, 'tools/test/setup.ts', "import { mul } from '../src/mul.ts';\nexport default (): void => void mul(1, 1);\n");
    write(ws.harness, 'tools/test/mul.test.ts', "import { expect, it } from 'vitest';\nit('multiplies', () => expect(2 * 3).toBe(6));\n");
    const fixed = commitAll(ws.harness, 'fix');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined)).toEqual({ result: 'pass', failures: [] });
  });

  it('is unknown when no test of the changed test files runs', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/test/empty.test.ts', 'export const x = 1;\n');
    // a describe with no test in it, and a test that is skipped: none of them runs
    write(ws.harness, 'tools/test/cases.test.ts', "import { describe, it } from 'vitest';\nconst CASES: string[] = [];\ndescribe('cases', () => { for (const c of CASES) it(c, () => undefined); });\n");
    write(ws.harness, 'tools/test/skipped.test.ts', "import { it } from 'vitest';\nit.skip('later', () => undefined);\n");
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    const fixed = commitAll(ws.harness, 'fix');
    const proof = await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined);
    expect(proof.result).toBe('unknown');
    expect(proof.failures[0]).toContain('no test ran:');
    expect(proof.failures[0]).toContain('test/empty.test.ts');
  });

  it('uses the repo node_modules for the fix base only when its tools dependencies are the same', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    expect(await sameDependencies(ws.harness, base, ws.env)).toBe(true);
    write(ws.harness, 'tools/package.json', '{ "type": "module", "dependencies": { "x": "1.0.0" } }\n');
    expect(await sameDependencies(ws.harness, base, ws.env)).toBe(false);
  });

  /** A fake `npm` on PATH: `ci` records its folder and whether node_modules was there, then links this ogw' node_modules, or fails. */
  function fakeNpm(ws: TestWorkspace, fails: boolean): { env: NodeJS.ProcessEnv; log: string } {
    const bin = join(ws.root, 'npm-bin');
    const log = join(ws.root, 'npm.log');
    const modules = resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npm'), [
      '#!/bin/sh',
      `echo "$1 $(pwd -P) $([ -e node_modules ] && echo had || echo none)" >> '${log}'`,
      fails ? "echo 'npm ERR! lock out of date' >&2; exit 1" : `ln -s '${modules}' node_modules`,
      '',
    ].join('\n'));
    chmodSync(join(bin, 'npm'), 0o755);
    return { env: { ...ws.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, log };
  }

  it('installs the fix base dependencies with npm ci in the proof worktree when they differ, and is unknown when that fails', async () => {
    for (const fails of [false, true]) {
      const ws = toolRepo();
      const base = commitAll(ws.harness, 'base');
      write(ws.harness, 'tools/package.json', '{ "type": "module", "dependencies": { "x": "1.0.0" } }\n');
      write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
      write(ws.harness, 'tools/test/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add.ts';\nit('adds', () => expect(add(1, 2)).toBe(3));\n");
      const fixed = commitAll(ws.harness, 'fix');
      const npm = fakeNpm(ws, fails);
      const ctx = createContext({ cwd: ws.root, env: npm.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
      const proof = await fixTestProof(ctx, 'tool', ws.harness, base, fixed, undefined);
      // npm ci ran once, in the proof worktree's tools/ (not the repo's), where the repo node_modules was not linked
      const lines = readFileSync(npm.log, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const [command, cwd, modules] = (lines[0] as string).split(' ');
      expect([command, modules]).toEqual(['ci', 'none']);
      expect(cwd?.endsWith('/repo/tools')).toBe(true);
      expect(cwd).not.toBe(realpathSync(join(ws.harness, 'tools')));
      expect(proof).toEqual(fails ? { result: 'unknown', failures: ['npm ci of the fix base failed: npm ERR! lock out of date'] } : { result: 'pass', failures: [] });
    }
  });

  it('runs the tests without the job id of the code check job', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/test/env.test.ts', "import { expect, it } from 'vitest';\nit('has no job', () => expect(process.env.OGW_JOB_ID).toBeUndefined());\n");
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    const fixed = commitAll(ws.harness, 'weak test');
    const ctx = createContext({ cwd: ws.root, env: { ...ws.env, OGW_JOB_ID: 'abc123' }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    // the test holds at the base too: a weak test, not a test that fails there because of the code check job's environment
    expect((await fixTestProof(ctx, 'tool', ws.harness, base, fixed, undefined)).result).toBe('fail');
  });

  it('is an item of ogw code check with --fix-base, run on --commit or HEAD', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    write(ws.harness, 'tools/test/add.test.ts', "import { expect, it } from 'vitest';\nimport { add } from '../src/add.ts';\nit('adds', () => expect(add(1, 2)).toBe(3));\n");
    const fixed = commitAll(ws.harness, 'fix');
    // the proof's line without its wall time
    const proofLine = (stdout: string): string => (stdout.split('\n').find((line) => line.startsWith('fix test proof: ')) ?? '').replace(/ \(\d+ s\)$/, '');
    const run = await ogw(ws, ['code', 'check', 'tool', '--commit', fixed, '--fix-base', base]);
    expect(proofLine(run.stdout)).toBe('fix test proof: pass');
    expect(proofLine((await ogw(ws, ['code', 'check', 'tool', '--fix-base', base])).stdout)).toBe('fix test proof: pass');
    // proved on the fixed code itself, the tests pass: not a proof
    const self = await ogw(ws, ['code', 'check', 'tool', '--commit', fixed, '--fix-base', fixed]);
    expect(proofLine(self.stdout)).toBe('fix test proof: unknown');
    expect((await ogw(ws, ['code', 'check', 'tool'])).stdout).not.toContain('fix test proof');
  });

  it('is unknown when the fix changed only test files: the code before it is the code after it', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/test/more.test.ts', "import { expect, it } from 'vitest';\nit('holds', () => expect(1).toBe(1));\n");
    const fixed = commitAll(ws.harness, 'stronger test');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined)).toEqual({ result: 'unknown', failures: ['the fix changed only test files of tools/: the code before it is the code after it'] });
  });

  it('keeps the no-test-file reason when the fix changed nothing of tools/', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'skills/x.md', 'a skill document\n');
    const docs = commitAll(ws.harness, 'docs only');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, docs, undefined)).toEqual({ result: 'unknown', failures: ['no test file of tools/test/ changed in the fix'] });
  });

  it('is unknown when the fix changed no test file', async () => {
    const ws = toolRepo();
    const base = commitAll(ws.harness, 'base');
    write(ws.harness, 'tools/src/add.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    const fixed = commitAll(ws.harness, 'fix');
    expect(await fixTestProof(ctxOf(ws), 'tool', ws.harness, base, fixed, undefined)).toEqual({ result: 'unknown', failures: ['no test file of tools/test/ changed in the fix'] });
  });
});

describe('fix test proof: core', () => {
  it('runs ogw core test of the target on a core worktree at the fix base with the changed tests over it', async () => {
    const ws = makeWorkspace();
    write(ws.coreImpl, 'server/core/routing/index.ts', 'export const x = 1;\n');
    write(ws.coreImpl, 'client/godot/engine.json', '{}\n');
    const base = commitAll(ws.coreImpl, 'base');
    write(ws.coreImpl, 'server/core/routing/tests/routing.test.ts', 'new test\n');
    write(ws.coreImpl, 'client/godot/core/log_core/tests/test_log.gd', 'new test\n');
    // the fix changes the code of both targets too: a proof runs only for a fix of code
    write(ws.coreImpl, 'server/core/routing/index.ts', 'export const x = 2;\n');
    write(ws.coreImpl, 'client/godot/core/log_core/log_core.gd', 'extends Node\n');
    const fixed = commitAll(ws.coreImpl, 'fix');
    coreTest.calls = [];
    coreTest.error = null;
    // a test of the target failed
    coreTest.module = 'fail';
    coreTest.counts = { tests: 2, passed: 1, ran: true };
    coreTest.failures = ['sqlite run: routing.test.ts::adds expected 3'];
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'routing')).toEqual({ result: 'pass', failures: [] });
    expect(coreTest.calls.map((c) => c.args)).toEqual([['server', 'routing']]);
    expect(coreTest.calls[0]?.cwd).toMatch(new RegExp(`^${ws.worktrees}/_core/proof-`));
    // a test file of the target did not load: every counted test passed, the report has a run failure
    coreTest.counts = { tests: 2, passed: 2, ran: true };
    coreTest.failures = ['sqlite run: run failure: routing.test.ts: SyntaxError: no export add'];
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'routing')).toEqual({ result: 'pass', failures: [] });
    // the runner crashed with no result once started: a failure all the same
    coreTest.counts = { tests: 0, passed: 0, ran: true };
    coreTest.failures = ['headless pass: no result'];
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'routing')).toEqual({ result: 'pass', failures: [] });
    // the run stopped before its test runner, as an install that failed: proves nothing
    coreTest.counts = { tests: 0, passed: 0, ran: false };
    coreTest.failures = ['server: npm ci failed (1)'];
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'routing')).toEqual({
      result: 'unknown',
      failures: ['ogw core test server routing: routing is fail and its test runner was not started: server: npm ci failed (1)'],
    });

    // a tool whose engine round trip was left out, every test that ran passed: not a proof
    coreTest.module = 'skipped';
    coreTest.counts = { tests: 2, passed: 2, ran: true };
    coreTest.failures = [];
    expect((await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'routing')).result).toBe('fail');

    const both = commitAll(ws.coreImpl, 'nothing');
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, fixed, both, 'routing')).toEqual({ result: 'unknown', failures: ['no test file of routing changed in the fix'] });
    // a fix of the target's tests only, on either side: no core test runs, the proof cannot tell
    coreTest.calls = [];
    write(ws.coreImpl, 'server/core/routing/tests/more.test.ts', 'another test\n');
    write(ws.coreImpl, 'client/godot/core/routing/tests/test_more.gd', 'another test\n');
    const testsOnly = commitAll(ws.coreImpl, 'tests only');
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, both, testsOnly, 'routing')).toEqual({ result: 'unknown', failures: ['the fix changed only test files of routing: the code before it is the code after it'] });
    expect(coreTest.calls).toEqual([]);
    coreTest.calls = [];
    coreTest.module = 'pass';
    coreTest.counts = { tests: 2, passed: 2, ran: true };
    coreTest.failures = [];
    const passing = await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'LogCore');
    expect(passing.result).toBe('fail');
    expect(coreTest.calls.map((c) => c.args)).toEqual([['godot', 'LogCore']]);
    coreTest.error = 'core-spec/ check: x';
    expect(await fixTestProof(ctxOf(ws), 'core', ws.coreImpl, base, fixed, 'LogCore')).toEqual({
      result: 'unknown',
      failures: ['ogw core test godot LogCore stopped before the tests: core-spec/ check: x'],
    });
    expect(readdirSync(join(ws.worktrees, '_core'))).toEqual([]);
  });
});
