import { git, revParse } from '../../../lib/git.ts';
import { lastProdTagName, parseBuildTag } from '../../build/lib/names.ts';

/** A tag that can be the PROD data tag (`data` skill `## data version`). */
export interface ProdTagCandidate {
  tag: string;
  /** Set for a bundle patch tag `prod-<app version>-bundle-<n>`: the tag `prod-<app version>`. */
  appTag: string | null;
}

function candidateOf(tag: string): (ProdTagCandidate & { order: number }) | null {
  const build = parseBuildTag(tag);
  if (build?.env !== 'PROD') return null;
  if (build.bundle === null) return { tag, appTag: null, order: 0 };
  return { tag, appTag: `prod-${build.version}`, order: build.bundle };
}

/**
 * `prod-<version>` and `prod-<app version>-bundle-<n>` tags on commits of `main`, the latest commit first.
 * On one commit an app tag comes before bundle tags, and bundle tags go by `<n>` from high to low.
 * Empty when the game has no `prod-<version>` tag.
 */
export async function prodTagCandidates(root: string, tags: readonly string[]): Promise<ProdTagCandidate[]> {
  if (lastProdTagName(tags) === null) return [];
  if ((await revParse(root, 'refs/heads/main')) === null) return [];
  const history = (await git(root, ['rev-list', 'refs/heads/main'])).split('\n').filter((line) => line !== '');
  const position = new Map(history.map((commit, i) => [commit, i]));
  const found: { candidate: ProdTagCandidate & { order: number }; index: number }[] = [];
  for (const tag of tags) {
    const candidate = candidateOf(tag);
    if (!candidate) continue;
    const index = position.get((await revParse(root, `refs/tags/${tag}`)) ?? '');
    if (index !== undefined) found.push({ candidate, index });
  }
  found.sort((a, b) => a.index - b.index || compareOrder(a.candidate.order, b.candidate.order));
  return found.map(({ candidate }) => ({ tag: candidate.tag, appTag: candidate.appTag }));
}

/** App tags (order 0) first, then bundle tags with the highest `<n>` first. */
function compareOrder(a: number, b: number): number {
  if (a === 0 || b === 0) return a - b;
  return b - a;
}
