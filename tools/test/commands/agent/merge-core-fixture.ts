// The core job helpers of the `ogw agent merge` core worktree tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { commitAll, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli, runAgent } from './helpers.ts';

export function coreSpec(ws: TestWorkspace, specs: Record<string, string[]>): void {
  mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
  for (const [name, dependencies] of Object.entries(specs)) {
    writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, dependencies }));
  }
  commitAll(ws.coreImpl, 'spec');
}

export const PASSED = { command: 'ogw core test server', startedAt: 1, exitCode: 0, summary: { tests: 2, passed: 2 } };

export async function coreJob(ws: TestWorkspace, module: string, runs: unknown[] = [PASSED], file = `server/${module}.ts`): Promise<string> {
  writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
  const fake = fakeAgentCli(
    ws,
    `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(file.endsWith('.json') ? JSON.stringify({ name: module, dependencies: ['routing'] }) : 'x')}); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: ${JSON.stringify(runs)} }));`,
  );
  const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
  expect(waited.code).toBe(0);
  return id;
}

/** A fake agent CLI line that writes `text` to `file` of its worktree. */
export function writeScript(file: string, text: string): string {
  return `fs.mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)});`;
}

/** A core job for `module` whose agent runs `change`, commits, runs `after` and leaves a passing core test run log. */
export async function scriptJob(ws: TestWorkspace, module: string, change: string, after = ''): Promise<string> {
  writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
  const fake = fakeAgentCli(ws, `${change} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); ${after} fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
  const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
  expect(waited.code).toBe(0);
  return id;
}

