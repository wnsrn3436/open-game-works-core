import { isDeepStrictEqual } from 'node:util';
import { expectPositionals, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../lib/fsx.ts';
import { writeHarnessSettings } from '../settings/api.ts';
import { isPlainObject, setAt } from '../settings/lib/json-path.ts';
import { containerKinds, filePath, harnessTarget } from '../settings/lib/target.ts';
import { computeNotices, computeProposals, proposalSegments, readInputs, shownProposalsPath, type Proposal } from './lib/proposals.ts';

/** The part of a proposal the human accepts, as JSON. */
function shownPart(p: Proposal): unknown {
  return JSON.parse(JSON.stringify([p.path, p.current, p.value])) as unknown;
}

/** A part of a proposal: the path below the proposal path and the value it gets. */
interface Part {
  segments: string[];
  value: unknown;
}

/**
 * The parts where `value` differs from `current`. An object that keeps every key and an array that keeps or grows its
 * length differ by their children; anything else is replaced whole.
 */
export function changedParts(current: unknown, value: unknown, at: string[] = []): Part[] {
  if (isDeepStrictEqual(current, value)) return [];
  if (isPlainObject(current) && isPlainObject(value) && Object.keys(current).every((key) => Object.hasOwn(value, key))) {
    return Object.keys(value).flatMap((key) => changedParts(current[key], value[key], [...at, key]));
  }
  if (Array.isArray(current) && Array.isArray(value) && value.length >= current.length) {
    return value.flatMap((item: unknown, index) => changedParts(current[index], item, [...at, String(index)]));
  }
  return [{ segments: at, value }];
}

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((segment, i) => segment === b[i]);
}

/** Each chosen proposal with the parts it changes, as full settings paths; fails when two proposals change the same part. */
export function proposalParts(chosen: readonly Proposal[]): { proposal: Proposal; parts: Part[] }[] {
  const all = chosen.map((proposal) => ({
    proposal,
    parts: changedParts(proposal.current, proposal.value).map((part) => ({ segments: [...proposalSegments(proposal), ...part.segments], value: part.value })),
  }));
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      const overlap = a.parts.find((p) => b.parts.some((q) => isPrefix(p.segments, q.segments) || isPrefix(q.segments, p.segments)));
      if (overlap !== undefined) {
        throw new OgwError(`proposals ${a.proposal.id} and ${b.proposal.id} both change ${overlap.segments.join('.')}: apply one, run ogw env propose again, then apply the other`);
      }
    }
  }
  return all;
}

/**
 * Applies the chosen proposals the last `ogw env propose` showed. Each is computed again from the
 * same inputs, and nothing is written when one differs from what was shown. Each proposal writes only the parts
 * where its value differs from the current value, so proposals with the same path apply together. The write has the
 * checks of `ogw settings set` and may also change paths whose `x-owner` is `tool`.
 */
async function apply(ctx: Context, ids: string[]): Promise<string[]> {
  const shown = await readJsonIfExists<Proposal[]>(await shownProposalsPath(ctx.env));
  if (shown === null) throw new OgwError('no proposal was shown: run ogw env propose first');
  const unknown = ids.filter((id) => !shown.some((p) => p.id === id));
  if (unknown.length > 0) throw new OgwError(`no proposal with id: ${unknown.join(', ')}`);
  const now = await computeProposals(ctx, await readInputs(ctx), new Set(ids));
  const chosen = ids.map((id) => shown.find((p) => p.id === id) as Proposal);
  const changed = chosen.filter((p) => {
    const again = now.find((n) => n.id === p.id);
    return again === undefined || !isDeepStrictEqual(shownPart(again), shownPart(p));
  });
  if (changed.length > 0) {
    throw new OgwError(`proposal changed since ogw env propose showed it: ${changed.map((p) => p.id).join(', ')}. Run ogw env propose again`);
  }
  const target = await harnessTarget(ctx);
  let next = target.value;
  for (const { parts } of proposalParts(chosen)) {
    for (const part of parts) {
      const segments = await filePath(target, part.segments, { create: true });
      next = setAt(next, segments, part.value, await containerKinds(target, segments));
    }
  }
  await writeHarnessSettings(ctx, next, { allowTool: true });
  return ids;
}

function proposalText(p: Proposal): string {
  return `proposal ${p.id}: ${p.path}\n  current ${JSON.stringify(p.current)}\n  value ${JSON.stringify(p.value)}\n  reason ${p.reason}`;
}

export const proposeCommand: CommandDef = {
  name: ['env', 'propose'],
  usage: 'ogw env propose [--apply <id,...>]',
  options: { apply: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const applyText = str(args, 'apply');
    if (applyText !== undefined) {
      const applied = await apply(ctx, [...new Set(applyText.split(',').map((id) => id.trim()))]);
      return { text: `applied: ${applied.join(', ')}`, data: { applied } };
    }
    const inputs = await readInputs(ctx);
    const proposals = await computeProposals(ctx, inputs);
    const notices = await computeNotices(ctx, inputs);
    await writeJsonAtomic(await shownProposalsPath(ctx.env), proposals);
    const text = [...proposals.map(proposalText), ...notices.map((n) => `notice ${n.id}: ${n.detail}`)];
    return { text: text.length === 0 ? 'no proposal and no notice' : text.join('\n'), data: { proposals, notices } };
  },
};
