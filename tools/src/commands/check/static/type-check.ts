import { join, relative, sep } from 'node:path';
import { godotTypeCheck } from '../../code/gdscript-checks.ts';
import { vitestGlobals } from '../../code/lib/typescript.ts';
import { withClientImport } from '../lib/engine.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { godotExecutable } from './lib/engine.ts';
import { isClientContentGd, isServerContentTs, isServerTest, repoPath } from './lib/files.ts';
import { compilerOptions } from './lib/ts-options.ts';
import { ts } from './lib/ts-source.ts';

/**
 * type check: content code fails the type check of `ogw code check`. GDScript: `godot --headless --path client --import`,
 * then `godot --headless --path client --check-only --script <file>` per content `.gd` ends without an error
 * (`client-core` Godot `## GDScript`), under the import lock of the checkout (`withClientImport`). TypeScript: `tsc`
 * `strict` on server content code.
 */
export const NAME = 'type check';

async function gdscript(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter(isClientContentGd);
  if (files.length === 0) return [];
  if (sc.importFailure !== null) return [finding(NAME, at('client/project.godot', 1), sc.importFailure)];
  const godot = await godotExecutable(sc);
  const project = { root: sc.root, folder: 'client', repoPathOf: repoPath };
  // after the import of `ogw check --loop` the instance clients may run: no import may write `client/.godot/` again
  const errors = sc.imported
    ? await godotTypeCheck(godot, project, files, sc.ctx.env, { imported: true })
    : await withClientImport(sc.ctx, sc.root, () => godotTypeCheck(godot, project, files, sc.ctx.env));
  return errors.map((e) => finding(NAME, at(e.path, e.line), e.message));
}

/** `server/package.json` the check sees when the game has none: server code is an ES module (`server-content` `## folder`). */
export const SERVER_PACKAGE_JSON = '{"type":"module"}';

/** A compiler host that sees `server/package.json` as {@link SERVER_PACKAGE_JSON} when the game has none. */
function serverHost(root: string, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const packageJson = join(root, 'server', 'package.json');
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (name) => fileExists(name) || name === packageJson;
  host.readFile = (name) => readFile(name) ?? (name === packageJson ? SERVER_PACKAGE_JSON : undefined);
  return host;
}

/**
 * The absolute root files of the TypeScript program over the given server files: the vitest global types join when a
 * server regression test is among them (`testing` `### test run`: test files use `describe`, `it`, `expect` as globals).
 */
export function serverRootFiles(root: string, files: readonly string[]): string[] {
  const out = files.map((f) => join(root, f));
  if (files.some((f) => isServerTest(f) && f.endsWith('.test.ts'))) out.push(vitestGlobals());
  return out;
}

/** Findings of the shared TypeScript options on the given server files (diagnostics in other files are not reported). */
export function typescriptErrors(root: string, files: readonly string[]): Finding[] {
  if (files.length === 0) return [];
  const options = compilerOptions(root);
  const program = ts.createProgram(serverRootFiles(root, files), options, serverHost(root, options));
  const wanted = new Set(files);
  const out: Finding[] = [];
  for (const diag of ts.getPreEmitDiagnostics(program)) {
    if (!diag.file || diag.start === undefined) continue;
    const path = relative(root, diag.file.fileName).split(sep).join('/');
    if (!wanted.has(path)) continue;
    const line = diag.file.getLineAndCharacterOfPosition(diag.start).line + 1;
    out.push(finding(NAME, at(path, line), `TS${String(diag.code)} ${ts.flattenDiagnosticMessageText(diag.messageText, ' ')}`));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const server = typescriptErrors(sc.root, sc.filter(isServerContentTs));
  return [...(await gdscript(sc)), ...server];
}
