import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../../lib/command.ts';
import { OgwError } from '../../../../lib/errors.ts';
import type { GameRepo } from '../../../../lib/game.ts';
import { git } from '../../../../lib/git.ts';
import { harnessRoot } from '../../../../lib/paths.ts';
import type { GameSettings } from '../../../../lib/settings.ts';
import type { CsvTable } from '../../../data/lib/csv.ts';
import { translationTable } from '../../../data/lib/translation-state.ts';
import { gameModules } from '../../../generate/api.ts';
import { parseDataTable, type DataTable } from './csv.ts';
import type { GdFile } from './gd-ast.ts';
import { parseGd } from './gd-parser.ts';
import { parseTextScene, type TextScene } from './tscn.ts';

/** One violation found by a static check. */
export interface Finding {
  where: string;
  message: string;
  /** An absence failure: something required is missing. The pre-commit hook blocks it whatever its `where` is. */
  absent?: true;
}

export function finding(check: string, where: string, detail: string): Finding {
  return { where, message: `${check}: ${detail}` };
}

/**
 * An absence failure. `where` is the file:line that made the requirement (a settings key line, a CSV row) when
 * there is one, else `<folder>:1` of the folder where the missing thing belongs.
 */
export function absence(check: string, where: string, detail: string): Finding {
  return { ...finding(check, where, detail), absent: true };
}

/** `<folder>:1` of the folder of a repo-relative path. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return at(slash === -1 ? '.' : path.slice(0, slash), 1);
}

/** `file:line`. */
export function at(path: string, line: number): string {
  return `${path}:${String(line)}`;
}

/** A file a static check could not parse; `staticCheckDetail` reports it as a finding of that check at `<path>:1`. */
export class UnreadableFile extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/** `parse()`, with a `OgwError` it throws (malformed file) turned into {@link UnreadableFile} of `path`. */
function parsed<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof OgwError) throw new UnreadableFile(path, error.message);
    throw error;
  }
}

function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () => {
    value ??= fn();
    return value;
  };
}

function cached<T>(map: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  let value = map.get(key);
  if (!value) {
    value = fn();
    map.set(key, value);
  }
  return value;
}

/** Working tree files (tracked and untracked, not ignored) that exist as regular files. */
export async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(out.split('\0').filter((p) => p.length > 0))].sort();
  const files: string[] = [];
  await Promise.all(
    paths.map(async (p) => {
      const stat = await lstat(join(root, p)).catch(() => null);
      if (stat?.isFile()) files.push(p);
    }),
  );
  return files.sort();
}

/** Shared, cached reads of the checkout for the static checks. */
export class StaticContext {
  readonly ctx: Context;
  readonly game: GameRepo;
  readonly root: string;
  readonly files: readonly string[];
  private readonly fileSet: Set<string>;
  private readonly texts = new Map<string, Promise<string>>();
  private readonly gds = new Map<string, Promise<GdFile>>();
  private readonly scenes = new Map<string, Promise<TextScene>>();
  private readonly tables = new Map<string, Promise<DataTable | null>>();
  private readonly headerTables = new Map<string, Promise<CsvTable | null>>();
  private readonly docs = new Map<string, Promise<string>>();

  /** Environment of the git call that reads the staged changes of the checkout; undefined uses `process.env`. */
  readonly stagedEnv: NodeJS.ProcessEnv | undefined;
  /** The check's caller imported `client/` just before (`StaticCheckOptions.imported`). */
  imported = false;
  /** The caller's import of `client/` failed with this message (`StaticCheckOptions.importFailure`). */
  importFailure: string | null = null;

  constructor(ctx: Context, game: GameRepo, files: readonly string[], stagedEnv?: NodeJS.ProcessEnv) {
    this.ctx = ctx;
    this.game = game;
    this.root = game.root;
    this.files = files;
    this.fileSet = new Set(files);
    this.stagedEnv = stagedEnv;
  }

  static async create(ctx: Context, game: GameRepo, stagedEnv?: NodeJS.ProcessEnv): Promise<StaticContext> {
    return new StaticContext(ctx, game, await listFiles(game.root), stagedEnv);
  }

  has(path: string): boolean {
    return this.fileSet.has(path);
  }

  filter(fn: (path: string) => boolean): string[] {
    return this.files.filter(fn);
  }

  text(path: string): Promise<string> {
    return cached(this.texts, path, () => readFile(join(this.root, path), 'utf8'));
  }

  bytes(path: string): Promise<Buffer> {
    return readFile(join(this.root, path));
  }

  gd(path: string): Promise<GdFile> {
    return cached(this.gds, path, async () => parseGd(path, await this.text(path)));
  }

  scene(path: string): Promise<TextScene> {
    return cached(this.scenes, path, async () => parseTextScene(path, await this.text(path)));
  }

  /** A data table by game-repo path, or null when the file does not exist. Malformed CSV throws {@link UnreadableFile}. */
  table(path: string): Promise<DataTable | null> {
    return cached(this.tables, path, async () => {
      if (!this.has(path)) return null;
      const text = await this.text(path);
      return parsed(path, () => parseDataTable(path, text));
    });
  }

  /**
   * A header-1-row CSV (`resources.csv`, translation files, glossary) by game-repo path through the one reader of
   * `ogw check` and `ogw translation` (`translationTable`), or null when the file does not exist. Malformed CSV
   * throws {@link UnreadableFile}.
   */
  headerTable(path: string): Promise<CsvTable | null> {
    return cached(this.headerTables, path, async () => {
      if (!this.has(path)) return null;
      const text = await this.text(path);
      return parsed(path, () => translationTable(text, path));
    });
  }

  /** A harness document by harness-relative path. */
  doc(rel: string): Promise<string> {
    return cached(this.docs, rel, () => readFile(join(harnessRoot(this.ctx.env), rel), 'utf8'));
  }

  readonly settings = memo(async (): Promise<GameSettings> => {
    if (!this.has('settings.json')) throw new OgwError(`game settings not found: ${join(this.root, 'settings.json')}`);
    const parsed = JSON.parse(await this.text('settings.json')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new OgwError('game settings is not a JSON object');
    return parsed as GameSettings;
  });

  readonly modules = memo(() => gameModules(this.ctx, this.game));
}
