import { absence, at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isClientTest, isServerContentTs, isServerTest, snake } from './lib/files.ts';
import type { GdFile } from './lib/gd-ast.ts';
import { callsOf } from './lib/gd-shared.ts';
import { allClasses, chainText, classFuncs } from './lib/gd-walk.ts';
import { isRecord, JsonPosError, parseJsonWithLines } from './lib/json-pos.ts';
import { calledName, lineOf, stringText, ts, tsChain, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * shared formula (`client-content` `## role split with server`): a `ogw:shared <name>` mark is not exactly once in
 * `client/` and once in `server/` (test and DEV code excluded), `data/fixtures/<name>.json` is missing, malformed or
 * has no case, `client/tests/` or `server/tests/` has no `read_shared_fixture` call for the name, or a `RequirementType`
 * element content registers a judge hook for has no shared formula `requirement.<element snake_case>`. A mark whose
 * name is not `<feature>.<formula>` or `requirement.<element>` with snake_case parts, or that is not on the line right
 * above a function, is a failure too.
 */
export const NAME = 'shared formula';

const CLIENT_MARK = /^ogw:shared\s+(\S+)\s*$/;
const SERVER_MARK = /^\s*\/\/\s*ogw:shared\s+(\S+)\s*$/;
const NAME_FORM = /^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SERVER_ELEMENT = /(^|\.)RequirementType\.[A-Za-z0-9_]+$/;

function judgeName(element: string): string {
  return `requirement.${snake(element.split('.').pop() ?? '')}`;
}

/** What the code says about shared formulas. */
export class SharedFacts {
  readonly client = new Map<string, string[]>();
  readonly server = new Map<string, string[]>();
  readonly judges = new Map<string, string[]>();
  readonly clientTests = new Set<string>();
  readonly serverTests = new Set<string>();

  static add(map: Map<string, string[]>, name: string, where: string): void {
    map.set(name, [...(map.get(name) ?? []), where]);
  }

  /** Marks with a name of another form or not on the line right above a function. */
  readonly problems: Finding[] = [];

  private mark(map: Map<string, string[]>, name: string, path: string, line: number, functionLines: Set<number>): void {
    SharedFacts.add(map, name, at(path, line));
    if (!NAME_FORM.test(name)) {
      this.problems.push(finding(NAME, at(path, line), `name \`${name}\` is not \`<feature>.<formula>\` or \`requirement.<element>\` with snake_case parts`));
    }
    if (!functionLines.has(line + 1)) this.problems.push(finding(NAME, at(path, line), `\`${name}\` mark is not on the line right above a function`));
  }

  clientMarks(file: GdFile): void {
    const functionLines = new Set(allClasses(file.top).flatMap(classFuncs).map((fn) => fn.line));
    for (const c of file.comments) {
      const m = CLIENT_MARK.exec(c.text.trim());
      if (m && !c.trailing) this.mark(this.client, m[1] as string, file.path, c.line, functionLines);
    }
  }

  clientCalls(file: GdFile, isTest: boolean): void {
    for (const { call } of callsOf(file)) {
      const chain = chainText(call.callee) ?? '';
      const first = call.args[0];
      const element = first ? (chainText(first) ?? '') : '';
      if (isTest && /(^|\.)read_shared_fixture$/.test(chain) && first?.k === 'str') this.clientTests.add(first.value);
      if (!isTest && chain === 'RequirementCore.register_judge' && element.startsWith('GameData.RequirementType.')) {
        SharedFacts.add(this.judges, judgeName(element), at(file.path, call.line));
      }
    }
  }

  serverMarks(path: string, source: ts.SourceFile): void {
    const functionLines = new Set<number>();
    walkTs(source, (node) => {
      const isFunction =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((d) => d.initializer !== undefined && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))));
      if (isFunction) functionLines.add(lineOf(source, node));
    });
    source.text.split('\n').forEach((line, i) => {
      const m = SERVER_MARK.exec(line);
      if (m) this.mark(this.server, m[1] as string, path, i + 1, functionLines);
    });
  }

  serverCalls(path: string, source: ts.SourceFile, isTest: boolean): void {
    walkTs(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calledName(node);
      const first = node.arguments[0];
      const text = first ? stringText(first) : null;
      const element = first ? (tsChain(first) ?? '') : '';
      if (isTest && name === 'read_shared_fixture' && text !== null) this.serverTests.add(text);
      if (!isTest && name === 'register_requirement_judge' && SERVER_ELEMENT.test(element)) {
        SharedFacts.add(this.judges, judgeName(element), at(path, lineOf(source, node)));
      }
    });
  }
}

async function collect(sc: StaticContext): Promise<SharedFacts> {
  const facts = new SharedFacts();
  for (const path of sc.filter(isClientContentGd)) {
    const file = await sc.gd(path);
    if (!isClientTest(path) && !isClientDev(path)) facts.clientMarks(file);
    facts.clientCalls(file, isClientTest(path));
  }
  for (const path of sc.filter(isServerContentTs)) {
    if (!isServerTest(path)) facts.serverMarks(path, await tsSource(sc, path));
    facts.serverCalls(path, await tsSource(sc, path), isServerTest(path));
  }
  return facts;
}

/** Problems of a fixture file, as `[line, message]`. */
export function fixtureProblems(text: string): [number, string][] {
  let parsed;
  try {
    parsed = parseJsonWithLines(text);
  } catch (error) {
    return [[error instanceof JsonPosError ? error.line : 1, 'fixture is not JSON']];
  }
  const { value, lines } = parsed;
  if (!isRecord(value) || Object.keys(value).join(',') !== 'cases' || !Array.isArray(value.cases)) return [[1, 'fixture must be `{"cases": [...]}`']];
  if (value.cases.length === 0) return [[lines.get('/cases') ?? 1, 'fixture has no case']];
  const out: [number, string][] = [];
  value.cases.forEach((c: unknown, i: number) => {
    const keys = isRecord(c) ? Object.keys(c).sort().join(',') : '';
    if (!isRecord(c) || keys !== 'expected,input,name' || typeof c.name !== 'string') {
      out.push([lines.get(`/cases/${String(i)}`) ?? 1, `case ${String(i)} must be \`{"name": "<case>", "input": <JSON>, "expected": <JSON>}\``]);
    }
  });
  return out;
}

function markFindings(name: string, places: string[], anchor: string, side: string, mark: string): Finding[] {
  if (places.length === 1) return [];
  const detail = `\`${name}\` has ${String(places.length)} \`${mark}\` marks in ${side}, not 1`;
  if (places.length === 0) return [absence(NAME, anchor, detail)];
  return places.map((where) => finding(NAME, where, detail));
}

async function nameFindings(sc: StaticContext, facts: SharedFacts, name: string): Promise<Finding[]> {
  const c = facts.client.get(name) ?? [];
  const s = facts.server.get(name) ?? [];
  const anchor = c[0] ?? s[0] ?? facts.judges.get(name)?.[0] ?? at('data', 1);
  const out = [...markFindings(name, c, anchor, 'client/', '# ogw:shared'), ...markFindings(name, s, anchor, 'server/', '// ogw:shared')];
  const fixture = `data/fixtures/${name}.json`;
  if (!sc.has(fixture)) out.push(absence(NAME, anchor, `\`${fixture}\` is missing`));
  else for (const [line, message] of fixtureProblems(await sc.text(fixture))) out.push(finding(NAME, at(fixture, line), message));
  if (!facts.clientTests.has(name)) out.push(absence(NAME, c[0] ?? anchor, `no \`read_shared_fixture("${name}")\` call in client/tests/`));
  if (!facts.serverTests.has(name)) out.push(absence(NAME, s[0] ?? anchor, `no \`read_shared_fixture("${name}")\` call in server/tests/`));
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const facts = await collect(sc);
  const names = [...new Set([...facts.client.keys(), ...facts.server.keys(), ...facts.judges.keys()])].sort();
  return [...facts.problems, ...(await Promise.all(names.map((name) => nameFindings(sc, facts, name)))).flat()];
}
