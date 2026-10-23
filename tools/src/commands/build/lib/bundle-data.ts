import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { showFile } from '../../../lib/git.ts';
import { LIST_PATH } from '../../resource/lib/list.ts';
import { protocolHash, type DataVersions } from './atcommit.ts';
import { builtRecords, parseCsvRecords } from '../../../lib/datatable.ts';
import { headerRows } from './csv.ts';

const RESKEY = /^(?:array<)*reskey\??>*$/;
const DATA_DIRS = ['data/system', 'data/tables'];

const clientTarget = (target: string): boolean => target === 'Client' || target === 'All';
const keysOf = (cell: string): string[] => cell.split('\n').map((k) => k.trim()).filter((k) => k.length > 0);
/** Keys of a cell of column type `type`; the `null` of a nullable `reskey?` (`data` skill `## type`) is no key. */
const columnKeysOf = (cell: string, type: string): string[] =>
  type.includes('reskey?') ? keysOf(cell).filter((k) => k !== 'null') : keysOf(cell);

/** Resource keys named in one data table's `reskey` cells of build target `Client` or `All`. */
export function tableResourceKeys(text: string): string[] {
  const records = parseCsvRecords(text);
  const table = builtRecords(records);
  if (!table) return [];
  const [targets, types] = [records[1]?.cells ?? [], records[2]?.cells ?? []];
  const columns = table.names.flatMap((name, i) =>
    !name.startsWith('#') && RESKEY.test((types[i] ?? '').trim()) && clientTarget(targets[i] ?? '') ? [i] : [],
  );
  return table.rows.flatMap((row) => columns.flatMap((i) => columnKeysOf(row.cells[i] ?? '', (types[i] ?? '').trim())));
}

/**
 * Resource keys named in `data/system/game_setting.csv` (`data` skill `### game_setting.csv`): the `value` cells of
 * rows whose `data_type` is `reskey` or `array<reskey>` and whose `target` (the row's build target) is `Client` or `All`.
 */
export function gameSettingResourceKeys(text: string): string[] {
  const table = builtRecords(parseCsvRecords(text));
  if (!table) return [];
  const { names } = table;
  const at = (cells: string[], column: string): string => (names.includes(column) ? (cells[names.indexOf(column)] ?? '') : '');
  return table.rows.flatMap(({ cells }) =>
    RESKEY.test(at(cells, 'data_type').trim()) && clientTarget(at(cells, 'target').trim()) ? keysOf(at(cells, 'value')) : [],
  );
}

/** Resource keys the data of a checkout names (`reskey` cells and `game_setting` values the client reads). */
export async function dataResourceKeys(root: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const dir of DATA_DIRS) {
    const path = join(root, dir);
    if (!exists(path)) continue;
    for (const name of (await readdir(path)).filter((n) => n.endsWith('.csv')).sort()) {
      const text = await readFile(join(path, name), 'utf8');
      const settingKeys = dir === 'data/system' && name === 'game_setting.csv' ? gameSettingResourceKeys(text) : [];
      for (const key of [...tableResourceKeys(text), ...settingKeys]) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Keys of `resource/resources.csv` at a commit. */
export async function resourceKeysAt(root: string, commit: string): Promise<Set<string>> {
  const text = (await showFile(root, commit, LIST_PATH))?.toString('utf8') ?? '';
  return new Set(headerRows(text).map((r) => r.key ?? '').filter((k) => k.length > 0));
}

export interface DataBundleInput {
  appVersion: string;
  /** Data versions of the app version's `<env>-<app version>` tag commit. */
  app: DataVersions;
  /** Data versions of this build. */
  build: DataVersions;
  /** Resource keys this build's data names. */
  dataKeys: readonly string[];
  /** Resource keys the app version has with its bundle. */
  appKeys: ReadonlySet<string>;
}

/**
 * Bundle check items of this build's data on an app version (`build` `## bundle patch`): the data is client data whose
 * protocol hash is the app version's, and every resource key it names is one the app version has with its bundle.
 */
export function dataBundleFailures(input: DataBundleInput): string[] {
  const failures: string[] = [];
  const [now, then] = [protocolHash(input.build.client), protocolHash(input.app.client)];
  if (now !== then) failures.push(`data protocol hash ${now} differs from app version ${input.appVersion} (${then})`);
  for (const key of input.dataKeys) {
    if (!input.appKeys.has(key)) failures.push(`data names resource key ${key}, which app version ${input.appVersion} with its bundle lacks`);
  }
  return failures;
}
