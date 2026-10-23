import { dirname, posix } from 'node:path';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { classIndex } from './lib/gd-shared.ts';
import { lineOf, stringText, ts, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * DEV reference (client-content engines/godot `## boot and DEV code`): code outside DEV code references DEV code.
 * Godot: a `class_name` of `client/dev/` (`client/dev/generated/` included) or `client/core/*\/dev/`, or a `res://dev/`
 * or `res://core/*\/dev/` string, in a file outside DEV code (`client/dev/`, `client/core/*\/dev/`) and regression tests
 * (`client/tests/`). Server: an import that resolves into `server/dev/` or `server/core/*\/dev/`, in a file outside
 * them and the regression tests (`server/tests/`, which import the test helpers of `server/core/testing/dev/`:
 * `testing` `### test run`). Core files are compared with the core release by `core diff` and are not read here.
 */
export const NAME = 'DEV reference';

const CLIENT_SKIP = ['client/dev/', 'client/tests/', 'client/core/', 'client/addons/', 'client/.godot/', 'client/build/', 'client/android/', 'client/ios/', 'client/resource/'];

function isClientNonDev(path: string): boolean {
  const inProject = path.startsWith('client/') || path.startsWith('resource/');
  return inProject && /\.(gd|tscn|tres)$/.test(path) && !CLIENT_SKIP.some((p) => path.startsWith(p));
}

function isServerNonDev(path: string): boolean {
  const skip = ['server/dev/', 'server/core/', 'server/tests/', 'server/node_modules/', 'server/build/'];
  return path.startsWith('server/') && /\.(ts|mts|cts)$/.test(path) && !skip.some((p) => path.startsWith(p));
}

/** A client DEV code folder: `client/dev/` or `client/core/<module>/dev/`. */
export function isClientDevCode(path: string): boolean {
  return path.startsWith('client/dev/') || /^client\/core\/[^/]+\/dev\//.test(path);
}

/** A `res://` path into client DEV code (`res://dev/`, `res://core/<module>/dev/`) in a text. */
const DEV_RES_PATH = /res:\/\/(dev\/|core\/[^/"'\s]+\/dev\/)/;

/** A game repo path in server DEV code: `server/dev/` or `server/core/<module>/dev/` (or the folder itself). */
function isServerDevCode(path: string): boolean {
  return /^server\/(dev|core\/[^/]+\/dev)(\/|$)/.test(path);
}

async function clientFile(sc: StaticContext, path: string, devClasses: Set<string>): Promise<Finding[]> {
  const out: Finding[] = [];
  if (path.endsWith('.gd')) {
    const file = await sc.gd(path);
    for (const t of file.tokens) {
      if (t.type === 'name' && devClasses.has(t.text)) out.push(finding(NAME, at(path, t.line), `uses DEV class \`${t.text}\``));
      if (t.type === 'str' && DEV_RES_PATH.test(t.value)) out.push(finding(NAME, at(path, t.line), 'uses a DEV code `res://` path'));
    }
    return out;
  }
  const lines = (await sc.text(path)).split('\n');
  lines.forEach((text, i) => {
    if (DEV_RES_PATH.test(text)) out.push(finding(NAME, at(path, i + 1), 'uses a DEV code `res://` path'));
    const cls = /script_class="([^"]+)"/.exec(text);
    if (cls && devClasses.has(cls[1] as string)) out.push(finding(NAME, at(path, i + 1), `uses DEV class \`${cls[1] as string}\``));
  });
  return out;
}

function moduleSpecifiers(source: ts.SourceFile): { spec: string; node: ts.Node }[] {
  const out: { spec: string; node: ts.Node }[] = [];
  walkTs(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = stringText(node.moduleSpecifier);
      if (spec !== null) out.push({ spec, node });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = stringText(node.moduleReference.expression);
      if (spec !== null) out.push({ spec, node });
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      const spec = arg ? stringText(arg) : null;
      if (spec !== null) out.push({ spec, node });
    }
  });
  return out;
}

async function serverFile(sc: StaticContext, path: string): Promise<Finding[]> {
  const source = await tsSource(sc, path);
  const out: Finding[] = [];
  for (const { spec, node } of moduleSpecifiers(source)) {
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join(dirname(path), spec));
    if (isServerDevCode(target)) out.push(finding(NAME, at(path, lineOf(source, node)), `imports DEV code \`${spec}\``));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  const devClasses = new Set(index.classNames().filter((name) => isClientDevCode(index.pathOf(name) ?? '')));
  const jobs = [
    ...sc.filter(isClientNonDev).map((p) => clientFile(sc, p, devClasses)),
    ...sc.filter(isServerNonDev).map((p) => serverFile(sc, p)),
  ];
  return (await Promise.all(jobs)).flat();
}
