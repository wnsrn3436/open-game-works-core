import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteReleaseVersions } from '../../../src/commands/core/api.ts';
import { writeTgz } from '../../../src/commands/core/lib/archive.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { sha256, writeFiles } from '../core/helpers.ts';
import { specJson, storedZip } from '../generate/helpers.ts';
import { CORE_VERSION, writeRelease } from '../settings/fixtures.ts';

vi.mock('../../../src/commands/core/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/core/api.ts')>()),
  remoteReleaseVersions: vi.fn(),
}));

/** A data tool and a contract tool that find nothing and write nothing: a fresh game has no data and no contract. */
const QUIET_TOOL = 'process.exit(0);\n';

/**
 * The cached release of `CORE_VERSION` with the assets that the static check of a fresh game reads: the settings and
 * spec files, the client and server core (without core files), the data tool and the contract tool.
 */
async function cacheRelease(ws: TestWorkspace): Promise<void> {
  const dir = join(ws.coreReleases, CORE_VERSION);
  writeRelease(dir, CORE_VERSION);
  writeFiles(dir, { 'core-spec.json': specJson(CORE_VERSION) });
  const src = join(ws.root, 'release-src');
  writeFiles(src, { 'bin/data-tool.js': QUIET_TOOL, 'bin/contract-tool.js': QUIET_TOOL, 'proto/ogw/core.proto': 'syntax = "proto3";\n', 'server/README.md': 'server core\n' });
  await writeTgz(join(dir, 'data-tool.tgz'), src, ['bin/data-tool.js']);
  await writeTgz(join(dir, 'contract-tool.tgz'), src, ['bin/contract-tool.js', 'proto/ogw/core.proto']);
  await writeTgz(join(dir, 'server.tgz'), join(src, 'server'), ['README.md']);
  writeFileSync(join(dir, 'client-godot.zip'), storedZip({ 'engine.json': JSON.stringify({ godot: '4.5.1.stable' }) }));
  const assets = Object.fromEntries(readdirSync(dir).map((name) => [name, sha256(readFileSync(join(dir, name)))]));
  writeFiles(dir, { 'manifest.json': { version: CORE_VERSION, assets, coreSchemaVersion: 1 } });
}

/** The game settings values that `ogw settings list --missing` gives after `ogw game init`, with two supported languages. */
const SETUP_VALUES: Record<string, unknown> = {
  engine: 'godot',
  supportedLanguages: ['en', 'ko'],
  coreModules: { client: ['UICore'], server: ['storage'] },
  buildPlatforms: ['web'],
  baseResolution: [1280, 720],
  maxResolution: [1920, 1080],
  uiCheckScreens: [{ name: 'desktop', window: [1280, 720], fillMode: 'Letterbox', notch: [0, 0, 0, 0], pixelRatio: 1 }],
  titleScene: 'scene_title',
  firstScene: 'scene_lobby',
  loadingScreen: 'prefab_loading',
  termsPopup: 'prefab_terms',
  termsDocuments: { TERMS: { version: 1, url: 'https://example.com/terms' }, PRIVACY: { version: 1, url: 'https://example.com/privacy' } },
  nicknameUnique: true,
  consent: { ageConfirmation: false, privacyChoices: false, version: 1, trackingRequest: false },
};

let ws: TestWorkspace;
let root: string;

beforeEach(async () => {
  ws = makeWorkspace();
  root = join(ws.games, 'mygame');
  vi.mocked(remoteReleaseVersions).mockResolvedValue([CORE_VERSION]);
  await cacheRelease(ws);
});

/** `git commit` in the game repo, through the pre-commit hook that `ogw game init` installed. */
function gitCommit(message: string): { code: number; stderr: string } {
  const run = spawnSync('git', ['commit', '--quiet', '-m', message], { cwd: root, env: ws.env, encoding: 'utf8' });
  return { code: run.status ?? -1, stderr: run.stderr };
}

describe('the commits of setup game step 11', () => {
  it('commits game settings that the hook refuses with ogw settings commit, then the setup records with git through the hook', { timeout: 180_000 }, async () => {
    expect((await ogw(ws, ['game', 'init', 'mygame'])).code).toBe(0);
    const set = await ogw(ws, ['settings', 'set', 'game', 'mygame', ...Object.entries(SETUP_VALUES).flatMap(([path, value]) => [path, JSON.stringify(value)])]);
    expect(set.code).toBe(0);
    expect((await ogw(ws, ['settings', 'list', 'game', 'mygame', '--missing'])).stdout).toBe('');
    // the hook would refuse the game settings: two supported languages need the language option entry, which no content code has yet
    const languages = `settings.json:${String(readFileSync(join(root, 'settings.json'), 'utf8').split('\n').findIndex((l) => l.includes('"supportedLanguages"')) + 1)}: option entry: `;
    sh(root, 'git', ['add', 'settings.json']);
    const refused = gitCommit('game settings by git');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`\n${languages}`);
    sh(root, 'git', ['reset', '--quiet']);
    // the tool commits them and prints those failures, from the real static check of the fresh game
    const settings = await ogw(ws, ['settings', 'commit', 'game', 'mygame']);
    expect(settings.code).toBe(0);
    expect(settings.stdout).toBe(`commit: ${sh(root, 'git', ['rev-parse', 'HEAD']).trim()}\n`);
    expect(settings.stderr).toContain(languages);
    expect(sh(root, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual(['game settings', '', 'settings.json']);
    // the other setup files go through the hook, whose static check runs on the fresh game and refuses nothing of them
    mkdirSync(join(root, 'records', 'setup'), { recursive: true });
    writeFileSync(join(root, 'records', 'setup', 'request.md'), 'make a runner\n');
    writeFileSync(join(root, 'records', 'setup', 'name.md'), 'en: Runner\nko: Runner\n');
    sh(root, 'git', ['add', '--all']);
    expect(gitCommit('setup')).toEqual({ code: 0, stderr: 'no staged engine resource\n' });
    expect(sh(root, 'git', ['log', '--format=%s']).trim().split('\n')).toEqual(['setup', 'game settings']);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });
});
