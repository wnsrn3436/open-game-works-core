import { regeneration } from './generated-diff.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * contract: `ogw contract` reports a violation (stdout line `<file>:<line>:<column> ERROR <message>`, `contract`
 * skill `tool.md` `## CLI`) for HEAD plus the staged changes. It reads the run of `generated diff` (`regeneration`),
 * which runs the contract tool in a temporary worktree because the tool writes generated code.
 */
export const NAME = 'contract';

const VIOLATION = /^(.+):([0-9]+):([0-9]+) ERROR (.*)$/;

/** Findings of contract tool stdout lines. */
export function violationFindings(lines: readonly string[]): Finding[] {
  return lines.map((line) => {
    const m = VIOLATION.exec(line.trim());
    return m ? finding(NAME, at(m[1] as string, Number(m[2])), (m[4] as string).trim()) : finding(NAME, at('contract', 1), line.trim());
  });
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const r = await regeneration(sc);
  if (r.contractError !== null) return [finding(NAME, at('contract', 1), `ogw contract failed: ${r.contractError}`)];
  // An earlier step (generate, data) failed, or the contract tool failed to run (exit code 2): `generated diff` reports it.
  if (r.contract === null || r.contract.exitCode === 2) return [];
  const result = r.contract;
  const found = violationFindings(result.violations);
  if (result.exitCode !== 0 && found.length === 0) found.push(finding(NAME, at('contract', 1), `ogw contract ended with ${String(result.exitCode)}`));
  return found;
}
