// The round state, tool target options and core commits of the `ogw review --reopen` tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, type TestWorkspace } from '../../helpers/workspace.ts';

export interface State {
  reopenAfter?: number;
  rounds: { chain?: number; startCommit: string; codeCheckJob: string; input: string; reviewFile: string | null }[];
}

/** `--since` and `--definition` of the tool target `agent merge`. */
export function toolArgs(ws: TestWorkspace, since: string): string[] {
  return ['tool', 'agent', 'merge', '--since', since, ...['tools/ogw.md', 'skills/core/command.md'].flatMap((path) => ['--definition', join(ws.harness, path)])];
}

/**
 * Commits everything in `open-game-works-core-impl/` without its pre-commit hook: a merged review agent job leaves the core
 * worktree hook (`ogw meta sync core --staged`) in the repo, which these lead commits do not need.
 */
export function commitCore(ws: TestWorkspace, message: string): string {
  sh(ws.coreImpl, 'git', ['add', '--all']);
  sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', message]);
  return sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
}

export function readState(dir: string): State {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as State;
}

