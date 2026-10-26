// The review lists, definitions and fake review agent of the `ogw review` debt tests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewList } from '../../../src/commands/review/lib/debt.ts';
import { createContext } from '../../../src/lib/command.ts';
import { commitAll, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { agentsByCall } from './helpers.ts';

/** `--definition` options naming the documents that define `agent merge`. */
export function mergeDefinitions(ws: TestWorkspace): string[] {
  return ['tools/ogw.md', 'skills/core/command.md'].flatMap((path) => ['--definition', join(ws.harness, path)]);
}

/** `--since` of the harness HEAD and the `--definition` options of `agent merge`. */
export function mergeOptions(ws: TestWorkspace): string[] {
  return ['--since', sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim(), ...mergeDefinitions(ws)];
}

/** A review agent that writes `files[n]` on its n-th call (no core agent is called). */
export function reviewer(ws: TestWorkspace, files: Record<number, string>): NodeJS.ProcessEnv {
  return agentsByCall(ws, files, '').env;
}

export const LIST_DIRS = { debt: 'review-debt', 'must fix': 'review-must-fix' } as const;

export function readList(repo: string, kind: keyof typeof LIST_DIRS, file: string): ReviewList | null {
  try {
    return JSON.parse(readFileSync(join(repo, 'records', LIST_DIRS[kind], file), 'utf8')) as ReviewList;
  } catch {
    return null;
  }
}

export function ids(repo: string, kind: keyof typeof LIST_DIRS, file: string): string[] | undefined {
  return readList(repo, kind, file)?.items.map((item) => item.id);
}

/** Writes and commits a list file in `repo`. */
export function seedList(repo: string, kind: keyof typeof LIST_DIRS, file: string, list: ReviewList): void {
  mkdirSync(join(repo, 'records', LIST_DIRS[kind]), { recursive: true });
  writeFileSync(join(repo, 'records', LIST_DIRS[kind], file), JSON.stringify(list));
  commitAll(repo, `seed ${file}`);
}

/** A section of a round's review agent input. */
export function inputSection(repo: string, target: string, round: number, heading: 'debt' | 'must fix' | 'commit range'): string {
  const input = readFileSync(join(repo, '.git', 'ogw-review', target, `round-${String(round)}-input.md`), 'utf8');
  return new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)\\n(?:\\n## |$)`).exec(input)?.[1] ?? '';
}

export const ctxOf = (ws: TestWorkspace) => createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
export const d1 = { id: 'D1', location: 'src/b.ts:9', problem: 'a slow loop', foundBy: 'agent merge round 1' };
export const low = (id: string) => `| ${id} | \`structure\` | low | src/a.ts:3 | dead code | remove | no | 90 |`;
