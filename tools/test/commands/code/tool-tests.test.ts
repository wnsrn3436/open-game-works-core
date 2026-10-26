import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAILURE_KEPT_MS, reportFailures, toolTestsCheck } from '../../../src/commands/code/lib/tool-tests.ts';
import { createContext } from '../../../src/lib/command.ts';
import { commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

/**
 * A harness whose `tools/` has a package and a fake vitest in `tools/node_modules`: each run appends to `runs`, waits
 * 300 ms and writes a report with one failed test when the file `fail` is in the tools folder.
 */
function harness(): { ws: TestWorkspace; runs: string } {
  const ws = makeWorkspace();
  const tools = join(ws.harness, 'tools');
  writeFileSync(join(tools, 'package.json'), '{"name":"t"}\n');
  writeFileSync(join(ws.harness, '.gitignore'), 'tools/node_modules\n');
  const runs = join(ws.root, 'runs');
  mkdirSync(join(tools, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(
    join(tools, 'node_modules', 'vitest', 'vitest.mjs'),
    `import fs from 'node:fs';
import { execSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(runs)}, 'x');
fs.writeFileSync(${JSON.stringify(runs)} + '.git', execSync('git rev-parse --path-format=absolute --git-common-dir').toString().trim());
const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const failed = fs.existsSync('fail');
await new Promise((r) => setTimeout(r, 300));
fs.writeFileSync(out, JSON.stringify({ testResults: [{ name: process.cwd() + '/test/a.test.ts', status: failed ? 'failed' : 'passed', assertionResults: [{ fullName: 'a works', status: failed ? 'failed' : 'passed' }] }] }));
process.exit(failed ? 1 : 0);
`,
  );
  commitAll(ws.harness, 'tools package');
  return { ws, runs };
}

describe('tool tests of ogw code check tool', () => {
  it('runs the suite of a commit once for code checks at the same time and keeps a pass', async () => {
    const { ws, runs } = harness();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const both = await Promise.all([toolTestsCheck(ctx, ws.harness, 'HEAD'), toolTestsCheck(ctx, ws.harness, 'HEAD')]);
    expect(both).toEqual([[], []]);
    expect(await toolTestsCheck(ctx, ws.harness, 'HEAD')).toEqual([]);
    expect(readFileSync(runs, 'utf8')).toBe('x');
  });

  it('reports the failed tests once for the code checks of a round, and runs a failing commit again after FAILURE_KEPT_MS', async () => {
    const { ws, runs } = harness();
    writeFileSync(join(ws.harness, 'tools', 'fail'), '');
    const sha = commitAll(ws.harness, 'failing');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const failed = ['test/a.test.ts: a works'];
    expect(await Promise.all([toolTestsCheck(ctx, ws.harness, 'HEAD'), toolTestsCheck(ctx, ws.harness, 'HEAD')])).toEqual([failed, failed]);
    expect(readFileSync(runs, 'utf8')).toBe('x');
    // a failure older than one round is run again
    const record = join(ws.harness, '.git', 'ogw-cache', 'tool-tests', `${sha}.json`);
    writeFileSync(record, JSON.stringify({ at: Date.now() - FAILURE_KEPT_MS - 1, failures: failed }));
    expect(await toolTestsCheck(ctx, ws.harness, 'HEAD')).toEqual(failed);
    expect(readFileSync(runs, 'utf8')).toBe('xx');
  });

  it('runs the suite in a checkout with a git dir of its own, not in the git dir of the harness repo', async () => {
    const { ws, runs } = harness();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await toolTestsCheck(ctx, ws.harness, 'HEAD');
    expect(readFileSync(`${runs}.git`, 'utf8')).not.toBe(join(ws.harness, '.git'));
  });

  it('passes a commit without the tools package', async () => {
    const ws = makeWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(sh(ws.harness, 'git', ['ls-files', 'tools/package.json']).trim()).toBe('');
    expect(await toolTestsCheck(ctx, ws.harness, 'HEAD')).toEqual([]);
  });

  it('gives a file that failed outside its tests, and counts the lines past the most it gives', () => {
    expect(reportFailures({ testResults: [{ name: '/r/test/b.test.ts', status: 'failed', message: 'SyntaxError: x\nmore', assertionResults: [] }] }, '/r')).toEqual(['test/b.test.ts: SyntaxError: x']);
    const many = { testResults: [{ name: '/r/t.test.ts', status: 'failed', assertionResults: Array.from({ length: 25 }, (_, i) => ({ fullName: `t${String(i)}`, status: 'failed' })) }] };
    const lines = reportFailures(many, '/r');
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe('5 more');
  });
});
