/**
 * The core code static check `ogw core test` runs before the tests.
 *
 * Godot (`godot` `## test`): `## GDScript`, frame code node finding and `await`, resource loading, DEV code
 * references, engine random functions, the `log_debug` call form (`## engine behavior` `LogCore` row), game data
 * changes outside generated code and `DataCore` (`data-core` "changes containers or rows"), and `_` names of a class
 * of another module folder (`## API`).
 * Server (`server-time`): system clock reads outside the clock adapter and timers outside `schedule_job` and `sleep`.
 */
import type { Context } from '../../../lib/command.ts';
import * as dataMutation from '../../check/static/data-mutation.ts';
import * as engineRandom from '../../check/static/engine-random.ts';
import { at, finding, type Finding } from '../../check/static/lib/context.ts';
import type { GdFile, Stmt } from '../../check/static/lib/gd-ast.ts';
import type { Token } from '../../check/static/lib/gd-lexer.ts';
import { callsOf, classIndex } from '../../check/static/lib/gd-shared.ts';
import type { ClassIndex } from '../../check/static/lib/gd-types.ts';
import { chainText, visitClass } from '../../check/static/lib/gd-walk.ts';
import { frameFindings } from './core-frame-check.ts';
import { gdscriptFindings } from './core-gdscript-check.ts';
import { devClassNames, devReferenceFindings, loadFindings, resourceFileFindings } from './core-load-check.ts';
import { CoreStaticContext, findingLine, isCoreGd, moduleFolderOf } from './core-static-context.ts';
import { moduleFolder } from './impl.ts';

export const LOG_DEBUG = 'log_debug';
export const DATA = 'data change';
export const PRIVATE = 'private name';

/** The line form STG and PROD builds replace with `pass` (`build` Godot step 2). */
const LOG_DEBUG_LINE = /^[ \t]*LogCore\.log_debug\(.*\)[ \t]*$/;
const DATA_CORE = moduleFolder('DataCore');
const CONTAINER_CHANGES = new Set(['GameData.load_tables', 'GameData.clear']);

/** True when a statement is alone on one line that matches the `log_debug` removal form. */
function isRemovableLine(file: GdFile, s: Stmt, lines: readonly string[]): boolean {
  const first = file.tokens[s.t0] as Token;
  const last = file.tokens[s.t1] as Token;
  if (first.line !== last.endLine) return false;
  const others = file.tokens.some((t) => t.line === first.line && (t.index < s.t0 || t.index > s.t1) && t.type !== 'newline' && t.type !== 'eof');
  return !others && LOG_DEBUG_LINE.test(lines[first.line - 1] ?? '');
}

/** `log_debug` references that are not a one-line statement `LogCore.log_debug(...)` of the removal form. */
export function logDebugFindings(file: GdFile): Finding[] {
  const lines = file.source.split('\n');
  const removable = new Set<number>();
  visitClass(file.top, {
    stmt(s) {
      if (s.k !== 'expr' || s.expr.k !== 'call') return;
      const callee = s.expr.callee;
      if (callee.k === 'member' && callee.name === LOG_DEBUG && chainText(callee.obj) === 'LogCore' && isRemovableLine(file, s, lines)) removable.add(callee.t1);
    },
  });
  return file.tokens
    .filter((t) => t.type === 'name' && t.text === LOG_DEBUG && !removable.has(t.index) && file.tokens[t.index - 1]?.text !== 'func')
    .map((t) => finding(LOG_DEBUG, at(file.path, t.line), '`log_debug` is not a one-line statement `LogCore.log_debug(...)` that STG and PROD builds replace with `pass`'));
}

/** Game data changes outside `DataCore`: rows and lists (the static group's `data mutation`) and container loads and clears. */
async function dataFindings(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  if (moduleFolderOf(file.path) === DATA_CORE) return [];
  const rows = await dataMutation.checkFile(file, index);
  const containers = callsOf(file).flatMap(({ call }) => {
    const chain = chainText(call.callee);
    return chain !== null && CONTAINER_CHANGES.has(chain) ? [finding(DATA, at(file.path, call.line), `\`${chain}()\` changes game data containers outside DataCore`)] : [];
  });
  return [...rows.map((f) => ({ where: f.where, message: f.message.replace(/^data mutation: /, `${DATA}: `) })), ...containers];
}

/**
 * `<Class>._name` where `<Class>` is a class of a module folder other than the file's (`## API`: a name that starts with
 * `_` is used only in its module class, its `<Module>Dev` and its core test, all inside its module folder).
 */
export function privateFindings(file: GdFile, index: ClassIndex): Finding[] {
  const own = moduleFolderOf(file.path);
  const findings: Finding[] = [];
  file.tokens.forEach((t, i) => {
    const cls = file.tokens[i - 1];
    const name = file.tokens[i + 1];
    if (t.text !== '.' || cls?.type !== 'name' || name?.type !== 'name' || !name.text.startsWith('_')) return;
    const folder = moduleFolderOf(index.pathOf(cls.text) ?? '');
    if (folder === null || folder === own) return;
    findings.push(finding(PRIVATE, at(file.path, name.line), `\`${cls.text}.${name.text}\` is a \`_\` name of module folder \`${folder}\` used outside it`));
  });
  return findings;
}

async function fileFindings(file: GdFile, index: ClassIndex, devClasses: ReadonlySet<string>): Promise<Finding[]> {
  const [gdscript, load, data] = await Promise.all([gdscriptFindings(file, index), loadFindings(file, index), dataFindings(file, index)]);
  return [...gdscript, ...load, ...data, ...devReferenceFindings(file, devClasses), ...engineRandom.checkFile(file), ...logDebugFindings(file), ...privateFindings(file, index)];
}

function order(a: Finding, b: Finding): number {
  return a.where.localeCompare(b.where, 'en', { numeric: true }) || a.message.localeCompare(b.message);
}

/** Findings as preflight lines `client/godot/<file>:<line>: <check>: <reason>`, sorted, without repeats. */
export function findingLines(findings: readonly Finding[]): string[] {
  return [...new Set([...findings].sort(order).map(findingLine))];
}

/** Godot core code static check of `open-game-works-core-impl/client/godot/`. */
export async function godotCoreStaticCheck(ctx: Context, implDir: string): Promise<string[]> {
  const sc = await CoreStaticContext.open(ctx, implDir);
  const index = await classIndex(sc);
  const files = await Promise.all(sc.filter(isCoreGd).map((p) => sc.gd(p)));
  const devClasses = devClassNames(index);
  const perFile = await Promise.all(files.map((f) => fileFindings(f, index, devClasses)));
  return findingLines([...perFile.flat(), ...(await frameFindings(files, index)), ...resourceFileFindings(sc.files)]);
}
