import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { commands } from '../../src/commands/index.ts';
import { runCli } from '../../src/lib/cli.ts';
import type { CommandDef } from '../../src/lib/command.ts';

/** The real harness repo this code lives in. */
export const realHarness = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const gitEnv: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'ogw-test',
  GIT_AUTHOR_EMAIL: 'ogw-test@example.com',
  GIT_COMMITTER_NAME: 'ogw-test',
  GIT_COMMITTER_EMAIL: 'ogw-test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // no automatic maintenance after a commit: its detached run packs the loose objects and removes their folders while a
  // test reads the repo, and it takes CPUs of the run
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

export interface TestWorkspace {
  root: string;
  harness: string;
  games: string;
  worktrees: string;
  coreImpl: string;
  coreReleases: string;
  env: NodeJS.ProcessEnv;
}

export function sh(cwd: string, cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...gitEnv }, input, encoding: 'utf8' });
}

export function gitInit(dir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '--quiet', '--initial-branch', branch]);
}

export function commitAll(dir: string, message = 'commit'): string {
  sh(dir, 'git', ['add', '--all']);
  sh(dir, 'git', ['commit', '--quiet', '--allow-empty', '-m', message]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
}

let gitOnlyHarnessRoot: string | null = null;

/**
 * An empty git repo in the test's temp folder to stand for the harness repo where a test needs only its git common dir
 * (the temp folder of ogw), so that no test writes in the git dir of the real harness repo.
 */
export function gitOnlyHarness(): string {
  if (gitOnlyHarnessRoot === null) {
    gitOnlyHarnessRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-harness-')));
    gitInit(gitOnlyHarnessRoot);
  }
  return gitOnlyHarnessRoot;
}

/** Points `OGW_HARNESS_ROOT` of this process at `gitOnlyHarness` while the tests of the file run. */
export function useGitOnlyHarness(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.OGW_HARNESS_ROOT;
    process.env.OGW_HARNESS_ROOT = gitOnlyHarness();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.OGW_HARNESS_ROOT;
    else process.env.OGW_HARNESS_ROOT = saved;
  });
}

/** The host id of every test (`OGW_HOST_ID`, set by tmp-setup.ts). */
export const TEST_HOST_ID = '0123456789abcdef0123456789abcdef';

const HOST_KEYS = ['maxConcurrentInstances', 'playInstances', 'reviewRunConcurrency', 'testDevices', 'imageMethod'];

/**
 * Harness settings in the file form: top-level host keys (`maxConcurrentInstances`, `playInstances`, `reviewRunConcurrency`, `testDevices`) and
 * method `measured` move into the `hosts` entry of `TEST_HOST_ID`, where ogw reads this host's values. A null
 * `maxConcurrentInstances` is a value not measured, so it is left out.
 */
export function hostForm(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const hosts = { ...((settings.hosts ?? {}) as Record<string, Record<string, unknown>>) };
  const entry: Record<string, unknown> = { name: 'test-host', ...(hosts[TEST_HOST_ID] ?? {}) };
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'hosts') continue;
    if (HOST_KEYS.includes(key)) {
      if (value !== null) entry[key] = value;
    } else {
      out[key] = value;
    }
  }
  const measured: Record<string, unknown> = { ...((entry.measured ?? {}) as Record<string, unknown>) };
  if (Array.isArray(settings.resourceGeneration)) {
    out.resourceGeneration = (settings.resourceGeneration as Record<string, unknown>[]).map((method) => {
      const { measured: steps, ...rest } = method;
      if (steps !== undefined) measured[method.name as string] = steps;
      return rest;
    });
  }
  if (Object.keys(measured).length > 0) entry.measured = measured;
  if (Object.keys(entry).length > 1) hosts[TEST_HOST_ID] = entry;
  if (Object.keys(hosts).length > 0) out.hosts = hosts;
  return out;
}

/** The real harness settings `tools` without the given entries, for tests that need a tool to be missing. */
export function realToolsWithout(...names: string[]): Record<string, unknown> {
  const settings = JSON.parse(readFileSync(join(realHarness, 'settings.json'), 'utf8')) as { tools: Record<string, unknown> };
  return Object.fromEntries(Object.entries(settings.tools).filter(([name]) => !names.includes(name)));
}

/**
 * The harness settings keys the tests take from the real settings: the pins `update env` keeps current. Every other
 * key comes from `harness-settings.json` next to this file, so a value the human changes does not change a test.
 */
export const REAL_SETTINGS_KEYS: readonly string[] = ['$schema', 'tools', 'resourceGeneration', 'hosts'];

/** The fixed harness settings of the tests: every key of the real settings outside `REAL_SETTINGS_KEYS`. */
export function testSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'harness-settings.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * A temporary workspace: a copy of the harness docs, schemas and settings (a git repo; the settings are the real pins
 * of `REAL_SETTINGS_KEYS` and `testSettings()`, with `settingsPatch` merged over them in the form `hostForm` takes),
 * empty `games/`, `worktrees/`, `open-game-works-core-releases/`, and a git repo `open-game-works-core-impl/`.
 */
let templates: { harness: string; coreImpl: string } | null = null;

/**
 * The folders each workspace of this test file copies: the harness docs in a git repo with them staged, and an empty
 * git repo for `open-game-works-core-impl/`. They are made once per file, in its temporary folder (tmp-setup.ts), so a
 * workspace runs no `git init` and does not stage the docs again.
 */
function workspaceTemplates(): { harness: string; coreImpl: string } {
  if (templates !== null && existsSync(templates.harness) && existsSync(templates.coreImpl)) return templates;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-template-')));
  const harness = join(root, 'open-game-works-core');
  mkdirSync(harness);
  for (const entry of ['AGENTS.md', 'agents', 'skills', 'schemas']) {
    cpSync(join(realHarness, entry), join(harness, entry), { recursive: true });
  }
  mkdirSync(join(harness, 'tools'));
  cpSync(join(realHarness, 'tools', 'ogw.md'), join(harness, 'tools', 'ogw.md'));
  gitInit(harness);
  sh(harness, 'git', ['add', '--all']);
  const coreImpl = join(root, 'open-game-works-core-impl');
  gitInit(coreImpl);
  templates = { harness, coreImpl };
  return templates;
}

export function makeWorkspace(settingsPatch: Record<string, unknown> = {}): TestWorkspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-test-')));
  const harness = join(root, 'open-game-works-core');
  const template = workspaceTemplates();
  cpSync(template.harness, harness, { recursive: true });
  // the host entries of the real settings belong to the hosts that ran update env, not to the test host
  const real = JSON.parse(readFileSync(join(realHarness, 'settings.json'), 'utf8')) as Record<string, unknown>;
  const pins = Object.fromEntries(REAL_SETTINGS_KEYS.filter((key) => key !== 'hosts' && key in real).map((key) => [key, real[key]]));
  writeFileSync(join(harness, 'settings.json'), `${JSON.stringify(hostForm({ ...pins, ...testSettings(), ...settingsPatch }), null, 2)}\n`);
  sh(harness, 'git', ['add', '--all']);
  sh(harness, 'git', ['commit', '--quiet', '-m', 'harness']);
  const ws: TestWorkspace = {
    root,
    harness,
    games: join(root, 'games'),
    worktrees: join(root, 'worktrees'),
    coreImpl: join(root, 'open-game-works-core-impl'),
    coreReleases: join(root, 'open-game-works-core-releases'),
    env: {
      ...process.env,
      ...gitEnv,
      OGW_HARNESS_ROOT: harness,
      OGW_TEST_SECRET_FILE: join(root, 'secrets.json'),
      // `ogw agent` copies the login file of these for play and judge: never the real ones in tests
      CLAUDE_CONFIG_DIR: join(root, 'agent-home', 'claude'),
      CODEX_HOME: join(root, 'agent-home', 'codex'),
    },
  };
  mkdirSync(ws.games);
  mkdirSync(ws.worktrees);
  mkdirSync(ws.coreReleases);
  cpSync(template.coreImpl, ws.coreImpl, { recursive: true });
  sh(ws.coreImpl, 'git', ['commit', '--quiet', '--allow-empty', '-m', 'core']);
  return ws;
}

/** A game repo `games/<name>/` with `files` committed on main. */
export function makeGame(ws: TestWorkspace, name: string, files: Record<string, string | object> = {}): string {
  const dir = join(ws.games, name);
  gitInit(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  commitAll(dir, 'init');
  return dir;
}

export interface OgwRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs ogw in this process. */
export async function ogw(
  ws: TestWorkspace,
  argv: string[],
  options: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv; commands?: readonly CommandDef[]; terminal?: boolean } = {},
): Promise<OgwRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(options.commands ?? commands, argv, {
    cwd: options.cwd ?? ws.root,
    env: { ...ws.env, ...options.env },
    stdin: () => Promise.resolve(options.stdin ?? ''),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    terminal: () => options.terminal === true,
  });
  return { code, stdout, stderr };
}
