import { keyFilesIn, LIST_PATH, listSha } from '../../resource/lib/list.ts';
import { absence, at, finding, type Finding, type StaticContext } from './lib/context.ts';

/** resource hash: the SHA-256 of a resource file differs from `resources.csv` `sha256` (`resource` `## resource list`). */
export const NAME = 'resource hash';

/**
 * `variants` of a `spec` cell; 1 when absent or not a positive integer. Lenient: an invalid `spec` is
 * `ogw resource sync`'s failure, and this check still compares the files it can find.
 */
export function variantsOf(spec: string): number {
  for (const item of spec.split(';')) {
    const m = /^variants=([0-9]+)$/.exec(item.trim());
    if (m) return Math.max(1, Number(m[1]));
  }
  return 1;
}

/** Files of a resource key in order (`keyFilesIn`): one file, or one per variant. Null entries are missing files. */
export function filesOf(files: readonly string[], key: string, variants: number): (string | null)[] {
  const found = keyFilesIn(key, files);
  if (variants < 2) return [found.find((f) => f.variant === null)?.path ?? null];
  return Array.from({ length: variants }, (_, i) => found.find((f) => f.variant === i + 1)?.path ?? null);
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const list = await sc.headerTable(LIST_PATH);
  if (list === null) return [];
  const out: Finding[] = [];
  for (const row of list.rows) {
    const key = row.values.key ?? '';
    if (key === '') continue;
    const expected = (row.values.sha256 ?? '').toLowerCase();
    const files = filesOf(sc.files, key, variantsOf(row.values.spec ?? ''));
    if (files.some((f) => f === null)) {
      out.push(absence(NAME, at(LIST_PATH, row.line), `file of \`${key}\` is missing`));
      continue;
    }
    const actual = listSha(await Promise.all((files as string[]).map((f) => sc.bytes(f))));
    if (actual !== expected) out.push(finding(NAME, at(LIST_PATH, row.line), `SHA-256 of \`${key}\` is ${actual}, not \`${expected}\`; run \`ogw resource sync\``));
  }
  return out;
}
