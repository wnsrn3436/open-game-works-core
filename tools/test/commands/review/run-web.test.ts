import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Jobs from '../../../src/lib/jobs.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_TEST_PASSED } from '../agent/helpers.ts';
import { agents, coreSpec, reviewFile, spec } from './helpers.ts';
import { commitCore } from './round-fixture.ts';

/**
 * The `ogw core test` and `ogw code check` jobs of `ogw review run`, faked in this process: the code check passes (the
 * test host may have no Godot for the type check), and a core test passes each module except those in `failing`. Each
 * core test run records its argv.
 */
const fake = vi.hoisted(() => ({
  runs: [] as string[][],
  failing: [] as string[],
  results: new Map<string, Jobs.WaitResult>(),
}));

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof Jobs>();
  const output = (options: Jobs.StartJobOptions): { stdout: string; exitCode: number } => {
    if (options.command === 'code check') {
      return { stdout: JSON.stringify({ checks: ['type check', 'lint', 'dependency', 'secret'].map((name) => ({ name, result: 'pass', failures: [] })) }), exitCode: 0 };
    }
    const modules = options.argv.slice(3).filter((arg) => !arg.startsWith('--'));
    const failed = modules.filter((module) => fake.failing.includes(module));
    const results = Object.fromEntries(modules.map((module) => [module, failed.includes(module) ? 'fail' : 'pass']));
    const failures = Object.fromEntries(failed.map((module) => [module, [`${module} test broke`]]));
    return { stdout: JSON.stringify({ modules: results, failures }), exitCode: failed.length > 0 ? 1 : 0 };
  };
  return {
    ...original,
    startJob: (options: Jobs.StartJobOptions): Promise<string> => {
      if (options.command !== 'core test' && options.command !== 'code check') return original.startJob(options);
      if (options.command === 'core test') fake.runs.push(options.argv);
      const id = `fakejob${String(fake.results.size)}`;
      const { stdout, exitCode } = output(options);
      fake.results.set(id, { job: { id, status: 'done', exitCode } as Jobs.JobRecord, finished: true, stdout, stderr: '' });
      return Promise.resolve(id);
    },
    waitJob: (id: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Jobs.WaitResult> => {
      const result = fake.results.get(id);
      return result === undefined ? original.waitJob(id, timeoutMs, env) : Promise.resolve(result);
    },
  };
});

/** The client module `LogCore`, implemented for Godot on main of `open-game-works-core-impl/`. */
function workspace(): TestWorkspace {
  const ws = makeWorkspace();
  coreSpec(ws, { LogCore: spec('LogCore', 'client') });
  mkdirSync(join(ws.coreImpl, 'client', 'godot', 'core', 'log_core'), { recursive: true });
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'core', 'log_core', 'log_core.gd'), 'var x = 1\n');
  commitCore(ws, 'LogCore for Godot');
  return ws;
}

const FILES = { 1: reviewFile(['| R1-1 | `structure` | medium | client/godot/core/log_core/log_core.gd:1 | reaches into x | use y | no | 90 |']) };
const GODOT = 'core test godot LogCore --json';
const WEB = 'core test godot LogCore --web --json';

/** The core test runs from the `from`-th on, as command lines in sorted order: the runs after a fix run together. */
function runsFrom(from: number): string[] {
  return fake.runs.slice(from).map((argv) => argv.join(' ')).sort();
}

/** A core agent fix that writes `file` of `client/godot/` in its worktree and commits it. */
function fix(file: string, text: string): string {
  const path = join('client', 'godot', file);
  return `fs.mkdirSync(${JSON.stringify(dirname(path))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(text)}); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report'); ${CORE_TEST_PASSED}`;
}

/** Another module's fix that lands on main while the core agent works: it adds a web-specific file of Godot. */
function otherWebMerge(ws: TestWorkspace): string {
  const file = join('client', 'godot', 'core', 'web', 'ogw-shell.html');
  const repo = JSON.stringify(ws.coreImpl);
  return `fs.mkdirSync(${JSON.stringify(join(ws.coreImpl, 'client', 'godot', 'core', 'web'))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(ws.coreImpl, file))}, 'x'); execFileSync('git', ['-C', ${repo}, 'add', ${JSON.stringify(file)}]); execFileSync('git', ['-C', ${repo}, 'commit', '-qm', 'another module fix', '--no-verify']); `;
}

describe('ogw review run: the browser run after a fix of a Godot client module', () => {
  beforeEach(() => {
    fake.runs.length = 0;
    fake.failing = [];
    fake.results.clear();
  });

  it('runs the core tests of the engine with --web after a fix that changed a web-specific file of the engine', async () => {
    const ws = workspace();
    const run = await ogw(ws, ['review', 'run', 'core', 'LogCore'], { env: agents(ws, FILES, fix('core/log_core/web_x.gd', 'var w = 1\n')).env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 1\n' });
    expect(runsFrom(0)).toEqual([WEB, GODOT].sort());
  });

  it('reads what the fix changed from its merge commit, and from the round\'s start to main when that commit is not found', async () => {
    const ws = workspace();
    // the fix changes a plain .gd file; a web-specific file lands on main from another merge after the round started
    fake.failing = ['LogCore'];
    const fakeAgents = agents(ws, FILES, otherWebMerge(ws) + fix('core/log_core/log_core.gd', 'var x = 2\n'));
    const failed = await ogw(ws, ['review', 'run', 'core', 'LogCore'], { env: fakeAgents.env });
    expect(failed.stdout).toMatch(/^result: test fail\nround: 1\n/);
    // the merge commit of the fix: no browser run
    expect(runsFrom(0)).toEqual([GODOT]);
    // the merge commit is not found: the changes from the round's start to main hold the web-specific file
    const merge = sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s', 'main']).trim();
    expect(merge).toMatch(/^ogw agent merge \w+$/);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '--amend', '--no-verify', '-m', 'the fix merged']);
    fake.failing = [];
    const again = await ogw(ws, ['review', 'run', 'core', 'LogCore'], { env: fakeAgents.env });
    expect(again).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 1\n' });
    expect(runsFrom(1)).toEqual([WEB, GODOT].sort());
  });
});
