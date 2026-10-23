// Test setup for commands that need a running instance: a workspace, a game, fake Godot and server processes.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecords } from '../../../src/commands/instance/lib/records.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { mockState, resetMocks } from './mocks/state.ts';

const fakes = join(dirname(fileURLToPath(import.meta.url)), 'fakes');

export interface Runner {
  ws: TestWorkspace;
  game: string;
  root: string;
  logDir: string;
  config: (value: Record<string, unknown>) => void;
  requests: (client: string) => { command: string; args: string[] }[];
  clientArgs: (client: string) => string[];
  /** The launch values the client read from its launch value file. */
  clientValues: (client: string) => Record<string, string>;
  serverArgs: () => string[];
  /** The content of the server's `--secret-file`. */
  serverSecrets: () => Record<string, string>;
}

export const MATCH_MODE_HEADER = ',,,,,\nAll,All,All,All,All,All\nid(key),int,int,int,bool,bool\nid,min_players,max_players,max_party_size,allow_queue,allow_room\n';

export function setupRunner(
  options: { files?: Record<string, string | object>; settings?: Record<string, unknown>; harness?: Record<string, unknown> } = {},
): Runner {
  resetMocks();
  const ws = makeWorkspace({ maxConcurrentInstances: 4, instanceWaitTimeoutMs: 1500, playInstances: 1, ...options.harness });
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-fake-')));
  const bin = join(logDir, 'bin');
  mkdirSync(bin);
  const godot = join(bin, 'godot');
  writeFileSync(godot, `#!/bin/sh\nexec "${process.execPath}" "${join(fakes, 'fake-godot.mjs')}" "$@"\n`);
  chmodSync(godot, 0o755);
  mockState.enginePath = godot;
  const configPath = join(logDir, 'config.json');
  writeFileSync(configPath, '{}');
  ws.env.FAKE_LOG_DIR = logDir;
  ws.env.FAKE_GODOT_CONFIG = configPath;
  const settings = { engine: 'godot', coreVersion: '1.0.0', buildPlatforms: ['android', 'ios'], ...options.settings };
  const root = makeGame(ws, 'g', { 'settings.json': settings, 'design.md': '# design\n', ...options.files });
  const read = (file: string): string => (existsSync(join(logDir, file)) ? readFileSync(join(logDir, file), 'utf8') : '');
  return {
    ws,
    game: 'g',
    root,
    logDir,
    config: (value) => {
      writeFileSync(configPath, JSON.stringify(value));
    },
    requests: (client) =>
      read(`${client}.jsonl`)
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { command: string; args: string[] }),
    clientArgs: (client) => JSON.parse(read(`${client}.args.json`) || '[]') as string[],
    clientValues: (client) => JSON.parse(read(`${client}.values.json`) || '{}') as Record<string, string>,
    serverArgs: () => JSON.parse(read('server.args.json') || '[]') as string[],
    serverSecrets: () => JSON.parse(read('server.secrets.json') || '{}') as Record<string, string>,
  };
}

/** Starts an instance with `ogw instance start --json` and returns its id. */
export async function startFor(runner: Runner, extra: string[] = []): Promise<string> {
  const run = await ogw(runner.ws, ['instance', 'start', runner.game, ...extra, '--json']);
  if (run.code !== 0) throw new Error(`instance start failed: ${run.stderr}`);
  return (JSON.parse(run.stdout) as { id: string }).id;
}

/** Stops every instance the test left. */
export async function stopAll(runner: Runner): Promise<void> {
  for (const record of await listRecords(runner.ws.env)) {
    await ogw(runner.ws, ['instance', 'stop', record.id]);
  }
}
