import { markdownSection } from '../../agent/lib/prompt.ts';
import { OgwError } from '../../../lib/errors.ts';

export type Side = 'core' | 'tool';

/** The side of a review agent input: a round of `ogw review next` (`core`, `tool`), or a spec review (`spec`). */
export type ReviewSide = Side | 'spec';

export interface ReviewInput {
  side: Side;
  target: string;
  round: number;
  definitions: string[];
  previousReview: string | null;
  commitRange: string | null;
  coreReports: string[];
  /** The diff file of the definition documents since the last round, in a round started by `--respec`. */
  specChanges?: string | null;
  /** The debt items the round gives as scope, as `D<n>: <file:line>: medium <problem>` lines. */
  debt?: readonly string[];
  /** The must-fix items the round gives as scope, as `M<n>: <file:line>: <severity> <problem>` lines. */
  mustFix?: readonly string[];
}

function list(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.map((value) => `- ${value}`).join('\n');
}

/** The review agent input `ogw review next` writes. */
export function formatReviewInput(input: ReviewInput): string {
  return [
    '# review input',
    '',
    `- side: ${input.side}`,
    `- target: ${input.target}`,
    `- round: ${String(input.round)}`,
    '',
    '## definition',
    '',
    list(input.definitions),
    '',
    '## previous review',
    '',
    input.previousReview ?? 'none',
    '',
    '## commit range',
    '',
    input.commitRange ?? 'none',
    '',
    '## core agent reports',
    '',
    list(input.coreReports),
    '',
    '## spec changes',
    '',
    input.specChanges ?? 'none',
    '',
    '## debt',
    '',
    list(input.debt ?? []),
    '',
    '## must fix',
    '',
    list(input.mustFix ?? []),
    '',
  ].join('\n');
}

function field(text: string, name: string): string {
  const match = new RegExp(`^- ${name}: (.+)$`, 'm').exec(text);
  if (!match) throw new OgwError(`review input has no ${name}`);
  return (match[1] as string).trim();
}

/**
 * The review agent input of a spec review (`ogw review spec`): the module's definition documents, which the agent
 * checks against each other before the module is implemented, and the review file of the module's last spec review
 * (`## previous review`, `none` when there is none); its round is one more than that review's round, 1 without one.
 */
export function formatSpecReviewInput(
  target: string,
  definitions: readonly string[],
  specChanges: string | null,
  items: { debt: readonly string[]; mustFix: readonly string[] },
  previous: { file: string; round: number } | null = null,
): string {
  return [
    '# review input', '', '- side: spec', `- target: ${target}`, `- round: ${String(previous === null ? 1 : previous.round)}`, '',
    '## definition', '', list(definitions), '',
    '## spec changes', '', specChanges ?? 'none', '',
    '## previous review', '', previous?.file ?? 'none', '',
    '## debt', '', list(items.debt), '',
    '## must fix', '', list(items.mustFix), '',
  ].join('\n');
}

/** Whether the section `name` of a review input is `none` or absent. */
function noneSection(text: string, name: string): boolean {
  return (markdownSection(text, name) ?? `## ${name}\nnone\n`).split('\n').slice(1).join('\n').trim() === 'none';
}

/**
 * Whether the review file of a review input takes `low` findings (`agents/review.md`): its `## commit range` is `none`,
 * and for a spec review its `## spec changes`.
 */
export function takesLow(text: string): boolean {
  return noneSection(text, parseReviewInput(text).side === 'spec' ? 'spec changes' : 'commit range');
}

/** The ids of the review list items of a review input: `## debt` (`D<n>: ...` lines) and `## must fix` (`M<n>: ...`). */
export function inputListIds(text: string): { debt: string[]; mustFix: string[] } {
  const ids = (heading: string, prefix: string): string[] => [...(markdownSection(text, heading) ?? '').matchAll(new RegExp(`^- (${prefix}\\d+): `, 'gm'))].map((match) => match[1] as string);
  return { debt: ids('debt', 'D'), mustFix: ids('must fix', 'M') };
}

/** Side, target and round of a review input. */
export function parseReviewInput(text: string): { side: ReviewSide; target: string; round: number } {
  const side = field(text, 'side');
  if (side !== 'core' && side !== 'tool' && side !== 'spec') throw new OgwError(`review input has an invalid side: ${side}`);
  const round = Number(field(text, 'round'));
  if (!Number.isInteger(round) || round < 1) throw new OgwError('review input has an invalid round');
  return { side, target: field(text, 'target'), round };
}

/** A target name as one file name part: spaces become `-`. */
export function targetSlug(target: string): string {
  return target.replace(/[^A-Za-z0-9_.-]+/g, '-');
}
