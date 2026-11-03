/** What `ogw review clear core` reports of the agent jobs that do not run. */
export interface LeftAgents {
  /** The agent worktrees and branches that could not be removed. */
  notRemoved: string[];
  /** Each removed branch with commits not in main: `<branch>: <n> commits not in main, last <sha>`. */
  discarded: string[];
}

/** The output lines of `left`. */
export function leftLines(left: LeftAgents): string[] {
  return [...left.notRemoved.map((what) => `not removed: ${what}`), ...left.discarded.map((what) => `discarded: ${what}`)];
}
