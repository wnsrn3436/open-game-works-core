import { dirname, join } from 'node:path';
import { exists, readText } from '../../../lib/fsx.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { section } from '../../../lib/markdown.ts';
import { readContentAgentFixes } from '../../loop/lib/findings.ts';
import { readReportRows } from '../../loop/lib/record.ts';
import { judgeResultErrors, playFeedbackErrors } from '../../loop/lib/results.ts';
import { hypothesisMomentName, judgeMoments } from '../../loop/lib/setup.ts';
import { reviewFileAgainst } from '../../review/lib/review-file.ts';
import { specReviewAgainst } from '../../review/lib/spec-debt.ts';
import type { AgentMeta } from './meta.ts';

/** The first line of the section `heading` of `text` that is not blank, trimmed; null without one. */
function firstLine(text: string, heading: string): string | null {
  return (section(text, heading) ?? []).map((line) => line.trim()).find((line) => line !== '') ?? null;
}

/**
 * content: the `## defects` of `ogw loop record`, and in a fun iteration the `## hypothesis` moment of `ogw loop
 * evaluate`, a moment of `## judge moments` of the run's `request.md` (beside the report) or `none`.
 */
async function contentErrors(text: string, meta: AgentMeta, output: string): Promise<string[]> {
  const errors = readReportRows(text).errors;
  if (firstLine(await readText(meta.input), 'kind') !== 'fun') return errors;
  const name = hypothesisMomentName(text);
  const request = join(dirname(output), 'request.md');
  const moments = exists(request) ? judgeMoments(await readText(request)).map((moment) => moment.name) : [];
  if (name === null) errors.push('`## hypothesis` has no `- moment: <name>` line');
  else if (name !== 'none' && !moments.includes(name)) {
    errors.push(`\`## hypothesis\` moment \`${name}\` is neither \`none\` nor a moment of \`## judge moments\` of ${request} (${moments.join(', ') || 'none'})`);
  }
  return errors;
}

/** review: the review file against its input, as `ogw review wait` judges a round, and `ogw agent wait` a spec review. */
async function reviewErrors(text: string, meta: AgentMeta): Promise<string[]> {
  const input = await readText(meta.input);
  return (meta.review?.side === 'spec' ? await specReviewAgainst(text, input) : reviewFileAgainst(text, input)).errors;
}

/** judge: the tables `ogw loop evaluate` reads, as the judge input sets them: `## vs baseline` with `B`, `## vs reference` with `reference`. */
async function judgeErrors(text: string, meta: AgentMeta): Promise<string[]> {
  const input: unknown = JSON.parse(await readText(meta.agentInput));
  if (!isPlainObject(input)) return [];
  const elements = Array.isArray(input.elements) ? input.elements.filter((e): e is string => typeof e === 'string') : [];
  return judgeResultErrors(text, { withBaseline: input.B !== null && input.B !== undefined, withReference: input.reference !== null && input.reference !== undefined, elements });
}

/**
 * The format errors of the result file `output` of an `ogw agent` job (ogw.md `### result format` of `## agent`), read
 * by the readers of the commands that read it; [] for a role without a check.
 */
export async function resultFormatErrors(meta: AgentMeta, output: string): Promise<string[]> {
  const text = await readText(output);
  switch (meta.role) {
    case 'content':
      return contentErrors(text, meta, output);
    case 'server-hardening':
    case 'client-hardening':
      return readContentAgentFixes(text).errors;
    case 'review':
      return reviewErrors(text, meta);
    case 'play':
      return playFeedbackErrors(text);
    case 'judge':
      return judgeErrors(text, meta);
    default:
      return [];
  }
}

/** The prompt of a fix round (ogw.md `### result format` of `## agent`). */
export function fixRoundPrompt(output: string, errors: readonly string[]): string {
  return [`The result file ${output} is not in its format. Fix only these format errors in it, commit it when your procedure commits it, and end:`, ...errors.map((error) => `- ${error}`)].join('\n') + '\n';
}
