import { OgwError } from '../../../lib/errors.ts';
import { runData, type DataLine } from '../../data/api.ts';
import { at, type Finding, type StaticContext } from './lib/context.ts';

/**
 * data check: the ERROR lines of the data tool are failures; WARN lines are warnings with `where` `<file>:<line>:<column>`
 * and `message` `data check <code> <message>` (`game-loop` `## loop iteration record`). The data tool runs as a binary
 * build without `ogw generate`, which does not change committed files.
 */
export const NAME = 'data check';

function message(line: DataLine): string {
  return `data check ${line.code} ${line.message}`;
}

/** `<file>:<line>` of a `<file>:<line>:<column>` location. */
function fileLine(where: string): string {
  const m = /^(.*):([0-9]+):([0-9]+)$/.exec(where);
  return m ? at(m[1] as string, Number(m[2])) : where;
}

export async function run(sc: StaticContext): Promise<{ failures: Finding[]; warnings: Finding[] }> {
  const result = await runData(sc.ctx, sc.game, { binary: true, generate: false });
  if (result.exitCode === 2) throw new OgwError(`data tool failed: ${result.stderr.trim()}`);
  const failures = result.lines.filter((l) => l.level === 'ERROR').map((l) => ({ where: fileLine(l.where), message: message(l) }));
  const warnings = result.lines.filter((l) => l.level === 'WARN').map((l) => ({ where: l.where, message: message(l) }));
  if (result.exitCode !== 0 && failures.length === 0) {
    const reason = result.stderr.trim().split('\n')[0] ?? '';
    failures.push({ where: at('data', 1), message: `data check binary build failed${reason ? `: ${reason}` : ''}; run \`ogw data ${sc.game.name}\` and commit` });
  }
  return { failures, warnings };
}
