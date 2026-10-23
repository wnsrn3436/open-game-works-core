import { rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expectPositionals, flag, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import { git, gitRaw, revParse } from '../../lib/git.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { startAgent } from '../agent/lib/prepare.ts';
import { debtRepo, itemLine, readList, specDebtTarget } from './lib/debt.ts';
import { coreDefinitions, moduleSpecs } from './lib/definitions.ts';
import { formatSpecReviewInput, targetSlug } from './lib/input.ts';

const USAGE = 'ogw review spec core <module> <--since <commit>|--full|--debt>';

/**
 * `--since <commit>` of a spec review: the diff of the module's spec file from that harness commit to the working
 * tree, written to `folder`; null (the whole spec) when the spec file is not in that commit, a module new since it.
 * Refused when the spec did not change since it and the module's spec must-fix list is empty: there is nothing to
 * review.
 */
async function specChanges(harness: string, spec: string, since: string, folder: string, env: NodeJS.ProcessEnv, mustFix: boolean): Promise<string | null> {
  const commit = await revParse(harness, since, { env });
  if (commit === null) throw new OgwError(`--since: commit ${since} not found in ${harness}`);
  const rel = relative(harness, spec);
  if ((await gitRaw(harness, ['cat-file', '-e', `${commit}:${rel}`], { env })).code !== 0) return null;
  const diff = await git(harness, ['diff', commit, '--', rel], { env });
  // with no change, the review confirms the fix of a must-fix item made elsewhere
  if (diff.trim() === '' && !mustFix) throw new OgwError(`the spec ${rel} did not change since ${since} and its spec must-fix list is empty: nothing to review`);
  const file = join(folder, 'spec-changes.diff');
  await writeFileAtomic(file, diff);
  return file;
}

/** Writes an empty diff file: a `--debt` spec review reviews no change of the spec, only the debt items. */
async function noChanges(folder: string): Promise<string> {
  const file = join(folder, 'spec-changes.diff');
  await writeFileAtomic(file, '');
  return file;
}

/**
 * `ogw review spec core <module> <--since <commit>|--full|--debt>`: starts one review agent that checks the module's
 * definition documents against each other before the module is implemented (`core` command.md `## spec review`). With
 * `--since` it reviews the changes of the module's spec since that harness commit, the whole spec for a spec new since
 * it; with `--full` the whole spec; with `--debt` the items of the module's spec debt list, which must have one. The
 * input gives every item of the module's spec must-fix list, and the items of its spec debt list in a review of the
 * whole spec or with `--debt`. Prints the agent job id; the result file is what `ogw agent wait <id>` prints. The input goes in an owner-only folder of `ogw-temp/`
 * (ogw.md `## temp folder`), removed when the review does not start.
 */
export const spec: CommandDef = {
  name: ['review', 'spec'],
  usage: USAGE,
  options: { since: { type: 'string' }, full: { type: 'boolean' }, debt: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    if (positional(args, 0, 'side') !== 'core') throw new OgwError(`usage: ${this.usage}`);
    const target = positional(args, 1, 'module');
    if (target === 'contract-tool' || target === 'data-tool') throw new OgwError(`usage: ${this.usage}`);
    const since = str(args, 'since');
    // one of them: the changes of the spec since a commit, the whole spec, or its debt
    const paying = flag(args, 'debt');
    if ([since !== undefined, flag(args, 'full'), paying].filter(Boolean).length !== 1) throw new OgwError(`usage: ${this.usage}`);
    // the dependencies come from the specs under review, which `core-spec/` on main does not have yet
    const definitions = await coreDefinitions(ctx, target, 'spec');
    const ws = await ctx.workspace();
    const specFile = (await moduleSpecs(ws.harness)).find((s) => s.module === target)?.spec as string;
    const repo = await debtRepo(ctx, 'core');
    const debt = (await readList(repo, 'debt', specDebtTarget(target))).items.map(itemLine);
    const mustFix = (await readList(repo, 'must fix', specDebtTarget(target))).items.map(itemLine);
    if (paying && debt.length === 0) throw new OgwError(`--debt of ${target}: its spec debt list has no item`);
    const folder = await newPrivateTempFolder('ogw-review-spec-', ctx.env);
    try {
      const changes = paying ? await noChanges(folder) : since === undefined ? null : await specChanges(ws.harness, specFile, since, folder, ctx.env, mustFix.length > 0);
      const input = join(folder, `${targetSlug(target)}-input.md`);
      // a review of the whole spec, and a `--debt` review, pay the spec debt
      const items = { debt: changes === null || paying ? debt : [], mustFix };
      await writeFileAtomic(input, formatSpecReviewInput(target, definitions, changes, items));
      const id = await startAgent(ctx, { role: 'review', input });
      return { text: id, data: { job: id } };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  },
};
