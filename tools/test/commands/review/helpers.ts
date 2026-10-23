import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_TEST_PASSED, fakeAgentCli } from '../agent/helpers.ts';

/** Changes `skills/core/command.md`, a definition document of every core target: `--restart` and `--respec` need it. */
export function changeDefinition(ws: TestWorkspace): void {
  appendFileSync(join(ws.harness, 'skills', 'core', 'command.md'), '\n- changed\n');
}

const FINDING_HEAD = '| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|';
const PREVIOUS_HEAD = '| id | result | evidence |\n|---|---|---|';
const DEBT_HEAD = '| id | result | finding | evidence |\n|---|---|---|---|';

export function reviewFile(findings: string[], previous: string[] = [], outOfScope: string[] = [], debt: string[] = [], mustFix: string[] = []): string {
  const table = (head: string, rows: string[]): string => (rows.length === 0 ? 'none' : `${head}\n${rows.join('\n')}`);
  const scope = outOfScope.length === 0 ? 'none' : outOfScope.join('\n');
  return `## findings\n\n${table(FINDING_HEAD, findings)}\n\n## previous\n\n${table(PREVIOUS_HEAD, previous)}\n\n## out of scope\n\n${scope}\n\n## debt\n\n${table(DEBT_HEAD, debt)}\n\n## must fix\n\n${table(DEBT_HEAD, mustFix)}\n\n## unknown\n\nnone\n`;
}

export function finding(id: string, spec: 'yes' | 'no'): string {
  return `| ${id} | \`correctness\` | high | src/a.ts:3 | run x | check y | ${spec} | 90 |`;
}

/** A core agent fix that commits a change and writes a report and a run log with a passing core test. */
export const GOOD_FIX = "fs.writeFileSync('fixed.txt', String(Date.now())); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report'); " + CORE_TEST_PASSED;
/** A core agent fix without a core test in its run log: `ogw agent merge` refuses it. */
export const UNTESTED_FIX = "fs.writeFileSync('fixed.txt', String(Date.now())); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report');";

/** A fake agent CLI behavior that commits a change of the harness `tools/`: `ogw review run` goes on in a new process. */
export function toolsChange(ws: TestWorkspace): string {
  const ogwMd = join(ws.harness, 'tools', 'ogw.md');
  return `fs.appendFileSync(${JSON.stringify(ogwMd)}, 'x'); execFileSync('git', ['-C', ${JSON.stringify(ws.harness)}, 'commit', '-qam', 'tools change', '--no-verify']); `;
}

/** One fake agent CLI for both roles: the review agent writes `files[round]`, the core agent runs `fix`. */
export function agents(ws: TestWorkspace, files: Record<number, string>, fix: string): ReturnType<typeof fakeAgentCli> {
  return fakeAgentCli(ws, [
    "const text = fs.readFileSync(input, 'utf8');",
    "if (text.startsWith('command: review fix')) {",
    fix,
    '} else {',
    `  const files = ${JSON.stringify(files)};`,
    "  const round = Number(/^- round: (\\d+)$/m.exec(text)[1]);",
    '  if (files[round] !== undefined) fs.writeFileSync(output, files[round]);',
    '}',
  ].join('\n'));
}

/**
 * Like `agents`, but the review agent writes `files[n]` on its n-th call (from 1), whatever the round, and runs
 * `review[n]` when given.
 */
export function agentsByCall(ws: TestWorkspace, files: Record<number, string>, fix: string, review: Record<number, string> = {}): ReturnType<typeof fakeAgentCli> {
  const counter = join(ws.root, 'review-calls');
  return fakeAgentCli(ws, [
    "const text = fs.readFileSync(input, 'utf8');",
    "if (text.startsWith('command: review fix')) {",
    fix,
    '} else {',
    `  const files = ${JSON.stringify(files)};`,
    `  const review = ${JSON.stringify(review)};`,
    `  const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;`,
    `  fs.writeFileSync(${JSON.stringify(counter)}, String(n));`,
    '  if (review[n] !== undefined) eval(review[n]);',
    '  if (files[n] !== undefined) fs.writeFileSync(output, files[n]);',
    '}',
  ].join('\n'));
}

/** The `## commit range` of a round's review agent input. */
export function commitRange(ws: TestWorkspace, target: string, round: number): string {
  const input = readFileSync(join(ws.coreImpl, '.git', 'ogw-review', target, `round-${String(round)}-input.md`), 'utf8');
  return /## commit range\n\n(\S+)\n/.exec(input)?.[1] ?? '';
}

export function spec(name: string, side: 'server' | 'client', dependencies: string[] = []): string {
  return JSON.stringify({ name, side, lifecycle: false, dependencies, optionalDependencies: [], devDependencies: [] });
}

/** `core-spec/` of `modules` on main of `open-game-works-core-impl/`, with no implementation: no core test runs after a fix. */
export function coreSpec(ws: TestWorkspace, modules: Record<string, string>): void {
  mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
  for (const [name, text] of Object.entries(modules)) writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), text);
  commitAll(ws.coreImpl, 'core-spec');
}

/** Server modules of `open-game-works-core-impl/` main with an implementation: their core test runs after a fix. */
export function implementServer(ws: TestWorkspace, modules: readonly string[]): void {
  for (const module of modules) {
    mkdirSync(join(ws.coreImpl, 'server', 'core', module), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', module, 'index.ts'), '');
  }
  commitAll(ws.coreImpl, 'implemented');
}
