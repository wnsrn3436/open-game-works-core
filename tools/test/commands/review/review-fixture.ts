// The review files, fake review agent and round commands of the `ogw review` tests.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ogw, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';

/** `--definition` options naming the documents that define `agent merge`. */
export function mergeDefinitions(ws: TestWorkspace): string[] {
  const since = ['--since', sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim()];
  return [...since, ...['tools/ogw.md', 'skills/game-loop/SKILL.md', 'skills/core/command.md'].flatMap((path) => ['--definition', join(ws.harness, path)])];
}

/** Changes `skills/core/command.md`, a definition document of every core target and of `mergeDefinitions`: `--restart` needs it. */
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

/** Fake review agent writing `files[round]` (a missing round writes nothing). */
export function reviewer(ws: TestWorkspace, files: Record<number, string>): NodeJS.ProcessEnv {
  return fakeAgentCli(
    ws,
    [
      `const files = ${JSON.stringify(files)};`,
      "const round = Number(/^- round: (\\d+)$/m.exec(fs.readFileSync(input, 'utf8'))[1]);",
      'if (files[round] !== undefined) fs.writeFileSync(output, files[round]);',
    ].join('\n'),
  ).env;
}

export async function next(ws: TestWorkspace, args: string[], env: NodeJS.ProcessEnv) {
  return ogw(ws, ['review', 'next', ...args], { env });
}

export async function wait(ws: TestWorkspace, args: string[]) {
  return ogw(ws, ['review', 'wait', ...args, '--timeout', '120000']);
}

