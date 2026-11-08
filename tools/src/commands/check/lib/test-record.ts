/**
 * The coverage of a server regression test run of all test files (`testing` `### test run`): what its test record says
 * the tests sent and received, against the content admin operations they registered and the `GameError`s of the contract.
 */
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';

/** A request name and the member name of a `GameError` that a response to it can hold. */
export interface ErrorPair {
  request: string;
  error: string;
}

/**
 * The program that prints, as a JSON list of `[request name, GameError member name]`, the pairs of
 * `GameContract.RPCS` (`(ogw.errors)` of each `rpc` of `service Game`) and then of `GameContract.CORE_ERRORS`
 * (`(ogw.core_errors)` of each core `rpc`), in their order. A value without a member name is its decimal string.
 */
const CONTRACT_ERRORS_SCRIPT = [
  "const { pathToFileURL } = await import('node:url');",
  "const contract = await import(pathToFileURL('generated/contract/game_contract.ts').href);",
  'const names = new Map(Object.entries(contract.GameError).map(([name, value]) => [value, name]));',
  'const name = (value) => names.get(value) ?? String(value);',
  'const pairs = [];',
  'for (const rpc of contract.RPCS) for (const error of rpc.errors) pairs.push([rpc.name, name(error)]);',
  'for (const [request, errors] of contract.CORE_ERRORS) for (const error of errors) pairs.push([request, name(error)]);',
  'process.stdout.write(JSON.stringify(pairs));',
].join('\n');

function isPairList(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string');
}

/**
 * The pairs of a request name and a `GameError` that the tests of the game checkout `root` must receive, read from the
 * generated server contract code (`GameContract.RPCS`, `GameContract.CORE_ERRORS`) in a `node` process in its `server/`.
 */
export async function contractErrorPairs(root: string, env: NodeJS.ProcessEnv): Promise<ErrorPair[]> {
  const result = await run(process.execPath, ['--input-type=module', '-e', CONTRACT_ERRORS_SCRIPT], { cwd: join(root, 'server'), env, timeoutMs: LIMITS.programMs });
  const why = result.timedOut ? `it did not end within ${String(LIMITS.programMs)} ms` : `exit code ${String(result.code)}: ${(result.stderr || result.stdout).trim()}`;
  if (result.timedOut || result.code !== 0) throw new OgwError(`the GameError lists of server/generated/contract/game_contract.ts could not be read: ${why}`);
  const pairs: unknown = JSON.parse(result.stdout);
  if (!isPairList(pairs)) throw new OgwError('the GameError lists of server/generated/contract/game_contract.ts are not lists of names');
  return pairs.map(([request, error]) => ({ request, error }));
}

/** One line of the test record (`testing` `### test run`). */
type RecordLine =
  | { kind: 'admin_operation'; operation: string }
  | { kind: 'admin'; operation: string; status: number }
  | { kind: 'game_error'; request: string; error: string };

/** The fields of each kind of line, `kind` included, and the type of each. */
const LINE_FIELDS: Record<RecordLine['kind'], Record<string, 'string' | 'integer'>> = {
  admin_operation: { kind: 'string', operation: 'string' },
  admin: { kind: 'string', operation: 'string', status: 'integer' },
  game_error: { kind: 'string', request: 'string', error: 'string' },
};

/** A line read as a JSON object of one of the three kinds, with exactly the fields of its kind; null otherwise. */
function recordLine(text: string): RecordLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // a line that is not JSON is malformed, a run failure of its own (the caller says so)
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isPlainObject(value) || typeof value.kind !== 'string' || !Object.hasOwn(LINE_FIELDS, value.kind)) return null;
  const fields = LINE_FIELDS[value.kind as RecordLine['kind']];
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(fields).length) return null;
  for (const key of keys) {
    const type = fields[key];
    const field = value[key];
    if (type === undefined || (type === 'string' ? typeof field !== 'string' : !Number.isInteger(field))) return null;
  }
  return value as unknown as RecordLine;
}

/**
 * The run failures of the coverage of a test record (`testing` `### test run`): each malformed line, then each content
 * admin operation of an `admin_operation` line that no `admin` line names, in the order of their first line, then each
 * pair of `pairs` that no `game_error` line holds, in the order of `pairs`.
 */
export function testRecordCoverage(record: string, pairs: readonly ErrorPair[]): string[] {
  const failures: string[] = [];
  const registered: string[] = [];
  const sent = new Set<string>();
  const received = new Set<string>();
  const texts = record.split('\n');
  // the line end of the last line leaves an empty text after it
  if (texts.at(-1) === '') texts.pop();
  texts.forEach((text, i) => {
    const line = recordLine(text);
    if (line === null) {
      failures.push(`test record line ${String(i + 1)} is malformed`);
      return;
    }
    if (line.kind === 'admin_operation' && !registered.includes(line.operation)) registered.push(line.operation);
    if (line.kind === 'admin') sent.add(line.operation);
    if (line.kind === 'game_error') received.add(JSON.stringify([line.request, line.error]));
  });
  for (const operation of registered) if (!sent.has(operation)) failures.push(`admin operation ${operation} is sent by no test`);
  for (const pair of pairs) {
    if (!received.has(JSON.stringify([pair.request, pair.error]))) failures.push(`${pair.request} ${pair.error} is received by no test`);
  }
  return failures;
}
