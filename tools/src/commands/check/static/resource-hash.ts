import { keyFilesIn, LIST_PATH, listSha } from '../../resource/lib/list.ts';
import { absence, at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * resource hash: the SHA-256 of a resource file differs from `resources.csv` `sha256` (`resource` `## resource list`),
 * and a file under `resource/` other than `resources.csv` and the engine meta files is no file of a row
 * (`resource` `## resource key`).
 */
export const NAME = 'resource hash';

/** The engine meta files of Godot (`client-core` Godot `## engine meta file`). */
const META_EXTENSIONS = ['.import', '.uid'];

/** A row of `resources.csv` with a key, and the `variants` of its `spec`. */
interface KeyRow {
  key: string;
  variants: number;
  line: number;
  sha256: string;
}

/** The key of `keys` whose file name a `resource/` path has (`resource/<key>.<extension>` or `resource/<key>.<n>.<extension>`), or null. */
function keyOfFile(path: string, keys: ReadonlyMap<string, number>): string | null {
  const m = /^resource\/(.+)\.[A-Za-z0-9]+$/.exec(path);
  if (!m) return null;
  const base = m[1] as string;
  if (keys.has(base)) return base;
  const variant = /^(.+)\.[0-9]+$/.exec(base)?.[1];
  return variant !== undefined && keys.has(variant) ? variant : null;
}

/**
 * Files under `resource/` that are not `resources.csv`, an engine meta file or a file of a row (`filesOf`): one file of a
 * row without `variants` of 2 or more, one file per `<n>` from 1 to `variants` of a row with them.
 */
function strayFiles(sc: StaticContext, rows: readonly KeyRow[]): Finding[] {
  const own = new Set(rows.flatMap((row) => filesOf(sc.files, row.key, row.variants)).filter((f): f is string => f !== null));
  const variants = new Map(rows.map((row) => [row.key, row.variants]));
  return sc
    .filter((p) => p.startsWith('resource/') && p !== LIST_PATH && !META_EXTENSIONS.some((ext) => p.endsWith(ext)) && !own.has(p))
    .map((p) => {
      const key = keyOfFile(p, variants);
      if (key === null) return finding(NAME, at(p, 1), `\`${p}\` is no file of a row of ${LIST_PATH}; add its row or delete the file`);
      const n = variants.get(key) as number;
      const expected = n < 2 ? `one file \`resource/${key}.<extension>\`` : `one file \`resource/${key}.<n>.<extension>\` per \`<n>\` from 1 to ${String(n)}`;
      return finding(NAME, at(p, 1), `\`${p}\` is a file of \`${key}\` beyond the ${expected} of its row in ${LIST_PATH}; delete the file or change the row`);
    });
}

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
  const rows = list.rows.flatMap((row): KeyRow[] => {
    const key = row.values.key ?? '';
    return key === '' ? [] : [{ key, variants: variantsOf(row.values.spec ?? ''), line: row.line, sha256: (row.values.sha256 ?? '').toLowerCase() }];
  });
  const out: Finding[] = strayFiles(sc, rows);
  for (const { key, variants, line, sha256: expected } of rows) {
    const files = filesOf(sc.files, key, variants);
    if (files.some((f) => f === null)) {
      out.push(absence(NAME, at(LIST_PATH, line), `file of \`${key}\` is missing`));
      continue;
    }
    const actual = listSha(await Promise.all((files as string[]).map((f) => sc.bytes(f))));
    if (actual !== expected) out.push(finding(NAME, at(LIST_PATH, line), `SHA-256 of \`${key}\` is ${actual}, not \`${expected}\`; run \`ogw resource sync\``));
  }
  return out;
}
