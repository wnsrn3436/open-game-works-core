import { LIST_PATH, parseKey } from '../../resource/lib/list.ts';
import { MIN_NINE_SLICE_SIDE, smallNineSlice } from '../../resource/lib/spec.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/** nine slice size: a `nine_slice` row still to be made whose `size` long side is under 256 (`resource` `## placeholder resource`). */
export const NAME = 'nine slice size';

export async function run(sc: StaticContext): Promise<Finding[]> {
  const list = await sc.headerTable(LIST_PATH);
  if (list === null) return [];
  const out: Finding[] = [];
  for (const row of list.rows) {
    const key = row.values.key ?? '';
    const status = row.values.status ?? '';
    if (status !== 'placeholder' && status !== 'requested') continue;
    if (!smallNineSlice(parseKey(key)?.type ?? '', row.values.spec ?? '')) continue;
    out.push(finding(NAME, at(LIST_PATH, row.line), `the long side of the size of \`${key}\` is under ${String(MIN_NINE_SLICE_SIDE)}; make it ${String(MIN_NINE_SLICE_SIDE)} or more`));
  }
  return out;
}
