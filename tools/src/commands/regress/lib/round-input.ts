/**
 * The round input of the seed agent (ogw.md `### seed agent` 5 of `## regress`): why the admission of the rebase of the
 * round before did not admit the seed, from what the checks and probes of that admission saw of this seed alone.
 */
import type { CheckResult } from '../../check/api.ts';
import { document } from '../../loop/lib/markdown.ts';
import { matches, targetChecks } from './keys.ts';
import type { AddedFailure, Seed } from './repo.ts';
import type { SeenAdmission, SeenCheck, SeenProbes } from './refresh.ts';
import type { ProbeResult } from './side.ts';

/** The file name of the round input of round `n` in the folder of the seed agent. */
export function roundInputName(n: number): string {
  return `round-${String(n)}.md`;
}

function itemName(check: Pick<CheckResult, 'name' | 'platform'>): string {
  return check.platform === null ? check.name : `${check.name} (${check.platform})`;
}

/**
 * The lines of one check of admission 3: for a seed with `expect` `caught`, each item of its target checks with its
 * result and failures, a failure of a `fail` item that matches the seed marked; for `missed`, the failures whose
 * finding key no base check has (`added`).
 */
function checkLines(seed: Seed, seen: SeenCheck, added: readonly AddedFailure[] | undefined): string[] {
  if ('error' in seen) return [`did not run: ${seen.error}`];
  if (seed.manifest.expect === 'missed') {
    const lines = (added ?? []).map((f) => `- ${itemName({ name: f.check, platform: f.platform })} ${f.where}: ${f.message}`);
    return lines.length === 0 ? ['none'] : lines;
  }
  const targets = targetChecks(seed.manifest);
  const lines: string[] = [];
  for (const item of seen.file.checks.filter((c) => targets.includes(c.name))) {
    lines.push(`- ${itemName(item)}: ${item.result}`);
    for (const f of item.failures) lines.push(`  - ${f.where}: ${f.message}${item.result === 'fail' && matches(seed.manifest, item.name, f) ? ' (matches the seed)' : ''}`);
  }
  return lines.length === 0 ? ['none'] : lines;
}

function probeLine(name: string, probe: ProbeResult): string {
  return `- ${name}: ${probe.result}${probe.reason === null ? '' : `: ${probe.reason}`}`;
}

function probeLines(probes: SeenProbes | null): string {
  return probes === null ? 'none' : [probeLine('seeded', probes.seeded), probeLine('reference', probes.reference)].join('\n');
}

/**
 * `round-<n>.md` (ogw.md `### seed agent` 5): `## round`, `## first input` (the path of `input.md`), `## stale reason`
 * (the reason of the admission), `## checks` (`### check <k>` per check of admission 3) and `## probes` (admission 4).
 */
export function roundInput(seed: Seed, round: number, first: string, seen: SeenAdmission): string {
  const checks = seen.checks === null ? 'none' : seen.checks.map((check, i) => [`### check ${String(i + 1)}`, '', ...checkLines(seed, check, seen.admission.added?.[i])].join('\n')).join('\n\n');
  return document([
    ['round', String(round)],
    ['first input', first],
    ['stale reason', seen.admission.reason ?? ''],
    ['checks', checks],
    ['probes', probeLines(seen.probes)],
  ]);
}
