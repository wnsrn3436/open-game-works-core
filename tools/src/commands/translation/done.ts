import { join } from 'node:path';
import { expectPositionals, list, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import { showFile } from '../../lib/git.ts';
import { rewriteRows, type CsvRow, type CsvTable } from '../data/lib/csv.ts';
import { translationTable } from '../data/lib/translation-state.ts';
import { dataOrFail } from './todo.ts';
import { checkLanguage, formatTodo, GLOSSARY_PATH, isStale, linesAbout, readTable, todoOf, translationPath } from './lib/files.ts';

/** `--keep` keys that are not stale translation rows of the file. */
function notStale(table: CsvTable | null, keep: readonly string[]): string[] {
  const stale = new Set((table?.rows ?? []).filter((row) => isStale(row.values)).map((row) => row.values.key));
  return keep.filter((key) => !stale.has(key));
}

function checkKeep(table: CsvTable | null, keep: readonly string[], path: string): void {
  const bad = notStale(table, keep);
  if (bad.length > 0) throw new OgwError(`not stale translation rows of ${path}: ${bad.join(', ')}`);
}

/**
 * Sets `source_hash` to `current_hash` on rows whose `text` is not empty and differs from HEAD's row of
 * the same key (a key HEAD lacks differs), and on kept stale rows. Returns the rows it changed.
 */
function markDone(table: CsvTable, headText: ReadonlyMap<string, string>, keep: ReadonlySet<string>): CsvRow[] {
  const changedRows: CsvRow[] = [];
  for (const row of table.rows) {
    const { values } = row;
    const key = values.key ?? '';
    const changed = values.text !== '' && headText.get(key) !== values.text;
    if (!changed && !keep.has(key)) continue;
    if (values.source_hash === values.current_hash) continue;
    values.source_hash = values.current_hash ?? '';
    changedRows.push(row);
  }
  return changedRows;
}

export const done: CommandDef = {
  name: ['translation', 'done'],
  usage: 'ogw translation done <game> <language> [--keep <key>...]',
  options: { keep: { type: 'string', multiple: true } },
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const language = positional(args, 1, 'language');
    const path = translationPath(language);
    const keep = list(args, 'keep');
    await checkLanguage(ctx, game, language);
    checkKeep(await readTable(game.root, path), keep, path);
    const data = await dataOrFail(ctx, game);
    const table = await readTable(game.root, path);
    checkKeep(table, keep, path);
    if (table === null) throw new OgwError(`${path} does not exist after ogw data`);
    const head = await showFile(game.root, 'HEAD', path, { env: ctx.env });
    const headRows = head === null ? [] : translationTable(head.toString('utf8'), path).rows;
    const changed = markDone(table, new Map(headRows.map((row) => [row.values.key ?? '', row.values.text ?? ''])), new Set(keep));
    if (changed.length > 0) await writeFileAtomic(join(game.root, path), rewriteRows(table, changed));
    const left = todoOf(table, await readTable(game.root, GLOSSARY_PATH), language);
    const lines = linesAbout(data.lines, [path, GLOSSARY_PATH]);
    const text = [formatTodo(left), ...lines.map((line) => line.text)].filter((part) => part !== '').join('\n');
    return { text, data: { ...left, lines } };
  },
};
