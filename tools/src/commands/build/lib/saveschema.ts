/**
 * Save schema check (`build` `### save schema check`, ogw.md `## save schema check`): PROD samples through the admin
 * API, one at a time through `migration` `migrate_snapshot` on a test server of the build checkout on a throwaway
 * PostgreSQL.
 */
import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { git, gitRaw, showFile } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { killTree, spawnTracked } from '../../../lib/proc.ts';
import { adminCall, type AdminTarget } from '../../admin/api.ts';
import { regressionInputs } from '../../check/lib/regression.ts';
import { startPostgres } from '../../core/lib/postgres.ts';
import { runEnv } from '../../core/lib/server-tests.ts';
import { mergedCoreSettings } from '../../generate/api.ts';
import { changedKinds, contractDefs, kindColumn, type Kind } from './kinds.ts';

export const RESULT_PREFIX = 'ogw-result ';

/** The program of the migration test process (ogw.md `## save schema check`). */
export const SAVE_SCHEMA_SCRIPT = [
  "const { pathToFileURL } = await import('node:url');",
  "const { createInterface } = await import('node:readline');",
  "const testing = await import(pathToFileURL('core/testing/dev/index.ts').href);",
  'const server = await testing.start_test_server();',
  'try {',
  '  for await (const line of createInterface({ input: process.stdin })) {',
  "    if (line === '') continue;",
  "    const output = await testing.call_dev(server, 'migration', 'migrate_snapshot', JSON.parse(line));",
  "    process.stdout.write('ogw-result ' + JSON.stringify(output, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\\n');",
  '  }',
  '} finally {',
  '  await testing.stop_test_server(server);',
  '}',
].join('\n');

/** One sample: a snapshot or game state snapshot and where it came from. */
export interface Sample {
  source: string;
  snapshot: unknown;
}

export interface SaveSchemaOutcome {
  failures: string[];
  /** Changed kinds no sampled record had below the current contract version. */
  unknownKinds: string[];
}

const PROD: AdminTarget = { env: 'PROD' };

async function contractFiles(read: (file: string) => Promise<string | null>, names: readonly string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of names) {
    const text = await read(name);
    if (text !== null) files.set(name, text);
  }
  return files;
}

/** The changed kinds of the build checkout against the last PROD tag commit. */
export async function changedKindsAt(root: string, prodCommit: string): Promise<Kind[]> {
  // a checkout or a PROD commit without `contract/` has no contract; any other read or git error is not "no contract"
  const nowNames = (await readdir(join(root, 'contract')).catch((error: unknown) => {
    if (isNotFound(error)) return [];
    throw error;
  })).filter((f) => f.endsWith('.proto'));
  await git(root, ['cat-file', '-e', `${prodCommit}^{commit}`]);
  const prodHasContract = (await gitRaw(root, ['cat-file', '-e', `${prodCommit}:contract`])).code === 0;
  const prodNames = prodHasContract ? (await git(root, ['ls-tree', '--name-only', `${prodCommit}:contract`])).split('\n').filter((f) => f.endsWith('.proto')) : [];
  const now = await contractFiles((f) => readFile(join(root, 'contract', f), 'utf8'), nowNames);
  const prod = await contractFiles(async (f) => (await showFile(root, prodCommit, `contract/${f}`))?.toString('utf8') ?? null, prodNames);
  return changedKinds(contractDefs(now), contractDefs(prod));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Takes the PROD samples one at a time and hands each to `use` (step 1). */
export async function forEachSample(ctx: Context, game: string, count: number, gameStateKinds: readonly string[], use: (sample: Sample) => Promise<void>): Promise<void> {
  const ids = record(await adminCall(ctx, game, PROD, 'sample_user_ids', { count })).user_ids;
  for (const id of Array.isArray(ids) ? ids : []) {
    const userId = String(id);
    await use({ source: `user ${userId}`, snapshot: await adminCall(ctx, game, PROD, 'export_user_snapshot', { user_id: userId }) });
  }
  for (const kind of gameStateKinds) {
    await use({ source: `game state ${kind}`, snapshot: await adminCall(ctx, game, PROD, 'sample_game_state', { kind, count }) });
  }
}

/** Table and kind column of the records of a snapshot whose contract version is below `current`. */
export function oldKinds(snapshot: unknown, current: number): Set<string> {
  const out = new Set<string>();
  const records = record(snapshot).records;
  for (const entry of Array.isArray(records) ? records : []) {
    const r = record(entry);
    if (typeof r.table !== 'string' || typeof r.key !== 'string' || typeof r.contract_version !== 'number') continue;
    if (r.contract_version < current) out.add(`${r.table}:${r.key.split('/')[0] ?? ''}`);
  }
  return out;
}

/** Failures of one `migrate_snapshot` output (step 3). */
export function outputFailures(source: string, output: unknown): string[] {
  if (!Array.isArray(output)) return [`save schema: ${source}: migrate_snapshot returned ${JSON.stringify(output)}`];
  return output.map(record).filter((r) => r.result === 'FAILED').map((r) =>
    `save schema: ${source}: ${String(r.table)} ${String(r.key)} from_version ${String(r.from_version)}: ${String(r.error)}`);
}

/** The migration test process: writes one sample line and reads one result line at a time. */
export class MigrationProcess {
  private readonly child: ChildProcess;
  private readonly lines: Interface;
  private readonly pending: ((line: string | null) => void)[] = [];
  private readonly queued: (string | null)[] = [];
  private stderr = '';

  constructor(root: string, env: NodeJS.ProcessEnv) {
    this.child = spawnTracked(process.execPath, ['--input-type=module', '-e', SAVE_SCHEMA_SCRIPT], { cwd: join(root, 'server'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    this.lines = createInterface({ input: this.child.stdout as NodeJS.ReadableStream });
    this.lines.on('line', (line) => {
      if (line.startsWith(RESULT_PREFIX)) this.push(line.slice(RESULT_PREFIX.length));
    });
    this.lines.on('close', () => {
      this.push(null);
    });
  }

  private push(line: string | null): void {
    const waiter = this.pending.shift();
    if (waiter) waiter(line);
    else this.queued.push(line);
  }

  private next(timeoutMs: number): Promise<string | null> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift() ?? null);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new OgwError(`save schema: the migration test process did not answer within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.push((line) => {
        clearTimeout(timer);
        resolvePromise(line);
      });
    });
  }

  /** Sends one sample and returns the `migrate_snapshot` output. */
  async migrate(snapshot: unknown, timeoutMs: number): Promise<unknown> {
    this.child.stdin?.write(`${JSON.stringify(snapshot)}\n`);
    const line = await this.next(timeoutMs);
    if (line === null) throw new OgwError(`save schema: the migration test process ended: ${this.stderr.trim().split('\n').slice(-5).join('\n')}`);
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new OgwError(`save schema: the migration test process wrote a result that is not JSON: ${line.slice(0, 200)}`);
    }
  }

  /** Ends stdin and waits for the process to stop the test server and end; kills it after `timeoutMs`. */
  async close(timeoutMs: number): Promise<void> {
    this.child.stdin?.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        killTree(this.child, 'SIGKILL');
        resolvePromise();
      }, timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

export interface SaveSchemaInput {
  ctx: Context;
  game: GameRepo;
  prodCommit: string;
  currentVersion: number;
}

async function sampleCount(ctx: Context, game: GameRepo): Promise<number> {
  const value = (await mergedCoreSettings(ctx, game))['migration.testSampleCount'];
  if (typeof value !== 'number') throw new OgwError('save schema: merged core settings have no migration.testSampleCount');
  return value;
}

/** Runs the save schema check of the build checkout. */
export async function saveSchemaCheck(input: SaveSchemaInput): Promise<SaveSchemaOutcome> {
  const { ctx, game } = input;
  const changed = await changedKindsAt(game.root, input.prodCommit);
  const count = await sampleCount(ctx, game);
  const container = await startPostgres(ctx, (await ctx.settings()).tools.postgresql);
  const failures: string[] = [];
  const seen = new Set<string>();
  let proc: MigrationProcess | null = null;
  try {
    const url = await container.createDatabase('ogw_save_schema');
    const migration = new MigrationProcess(game.root, runEnv(ctx.env, regressionInputs(game.root, url)));
    proc = migration;
    const gameStates = changed.filter((k) => k.table === 'game_state').map((k) => k.name);
    await forEachSample(ctx, game.name, count, gameStates, async (sample) => {
      for (const key of oldKinds(sample.snapshot, input.currentVersion)) seen.add(key);
      failures.push(...outputFailures(sample.source, await migration.migrate(sample.snapshot, LIMITS.programMs)));
    }).catch((error: unknown) => {
      if (!(error instanceof OgwError)) throw error;
      failures.push(error.message.startsWith('save schema:') ? error.message : `save schema: PROD admin API: ${error.message}`);
    });
  } finally {
    await proc?.close(LIMITS.shortMs);
    await container.remove();
  }
  const unknownKinds = changed.filter((k) => !seen.has(`${k.table}:${kindColumn(k.name)}`)).map((k) => k.name);
  return { failures, unknownKinds };
}

