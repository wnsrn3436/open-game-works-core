import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { callerRole, gameCheckErrors, writeHarnessSettings } from '../../../src/commands/settings/api.ts';
import { mayChange } from '../../../src/commands/settings/lib/change.ts';
import { agentContext, type AgentContext } from '../../../src/lib/agentctx.ts';
import { createContext } from '../../../src/lib/command.ts';
import { withGameSettingsLock, type Role } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, sh, TEST_HOST_ID, type TestWorkspace } from '../../helpers/workspace.ts';
import { writeCoreImpl } from './core-impl.ts';
import { readGameSettingsFile, readHarnessSettingsFile, validGameSettings, writeRelease, type GameSettingsFixture } from './fixtures.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

vi.mock('../../../src/lib/agentctx.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/agentctx.ts')>()),
  agentContext: vi.fn(),
}));

type Settings = GameSettingsFixture;

let ws: TestWorkspace;
let gameFile: string;

beforeEach(() => {
  ws = makeWorkspace();
  vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release')));
  vi.mocked(agentContext).mockResolvedValue(null);
  makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
  gameFile = join(ws.games, 'mygame', 'settings.json');
});

function asRole(role: Role): void {
  const agent = { job: { id: 'job1' }, meta: { role, cliPid: null, output: join(ws.root, 'out.md'), runLog: join(ws.root, 'out-runs.json') } };
  vi.mocked(agentContext).mockResolvedValue(agent as unknown as AgentContext);
}

function readGame(): Settings {
  return readGameSettingsFile(gameFile);
}

function writeGame(settings: Record<string, unknown>): void {
  writeFileSync(gameFile, `${JSON.stringify(settings, null, 2)}\n`);
}

const set = (...argv: string[]) => ogw(ws, ['settings', 'set', ...argv]);
const unset = (...argv: string[]) => ogw(ws, ['settings', 'unset', ...argv]);

describe('ogw settings set', () => {
  it('writes the value keeping key order with 2-space indent', async () => {
    expect(await set('game', 'mygame', 'appId', '"com.example.other"')).toEqual({ code: 0, stdout: 'set appId\n', stderr: '' });
    const expected = validGameSettings();
    expected.appId = 'com.example.other';
    expect(readFileSync(gameFile, 'utf8')).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it('adds a new key at the end and creates missing parents by the schema', async () => {
    expect((await set('game', 'mygame', 'gamepadSupported', 'true')).code).toBe(0);
    expect(Object.keys(readGame()).at(-1)).toBe('gamepadSupported');
    expect((await set('game', 'mygame', 'environments.DEV.containerLog.maxBytes', '2097152')).code).toBe(0);
    expect(readGame().environments.DEV.containerLog).toEqual({ maxBytes: 2097152 });
    expect((await set('game', 'mygame', 'environments.DEV.devAllowedCidrs.0', '"10.0.0.0/8"')).code).toBe(0);
    expect(readGame().environments.DEV.devAllowedCidrs).toEqual(['10.0.0.0/8']);
    expect((await set('game', 'mygame', 'environments.DEV.devAllowedCidrs.1', '"10.1.0.0/16"')).code).toBe(0);
    expect(readGame().environments.DEV.devAllowedCidrs).toEqual(['10.0.0.0/8', '10.1.0.0/16']);
    expect((await set('game', 'mygame', 'environments.DEV.devAllowedCidrs.0', '"10.2.0.0/16"')).code).toBe(0);
    expect(readGame().environments.DEV.devAllowedCidrs).toEqual(['10.2.0.0/16', '10.1.0.0/16']);
  });

  it('gives JSON', async () => {
    const run = await ogw(ws, ['settings', 'set', 'game', 'mygame', 'nicknameUnique', 'false', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ path: 'nicknameUnique', value: false });
  });

  it('refuses a bad path or value and leaves the file as it was', async () => {
    const before = readFileSync(gameFile, 'utf8');
    expect(await set('game', 'mygame', 'appId', 'com.x')).toEqual({ code: 1, stdout: '', stderr: 'not a JSON value: com.x\n' });
    expect((await set('game', 'mygame', 'baseResolution.5', '1')).stderr).toBe('baseResolution.5: index 5 is past the end of the array\n');
    expect((await set('game', 'mygame', 'baseResolution.x', '1')).stderr).toBe('baseResolution.x: x is not an array index\n');
    expect((await set('game', 'mygame', 'appId.x', '1')).stderr).toBe('appId is not an object or array\n');
    expect((await set('game', 'mygame', 'appId.x.y', '1')).stderr).toBe('appId is not an object or array\n');
    expect(await set('game', 'mygame', 'appId', '"Bad"')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'appId: must match pattern "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$"\n',
    });
    expect((await set('game', 'mygame', 'environments.PROD.adminOperators.0.name', '"ops"')).stderr).toBe(
      'environments.PROD.adminOperators: operator ogw is missing\n',
    );
    expect((await set('game', 'mygame', 'appId')).stderr).toBe('usage: ogw settings set <harness|game <game>|core> <path> <JSON value> [<path> <JSON value>]...\n');
    expect(readFileSync(gameFile, 'utf8')).toBe(before);
  });

  it('lets settings with missing required values be filled one value at a time', async () => {
    writeGame({ coreVersion: '1.2.0', postgresqlMajor: 18 });
    expect((await set('game', 'mygame', 'appId', '"com.example.mygame"')).code).toBe(0);
    expect((await set('game', 'mygame', 'buildPlatforms', '["android"]')).code).toBe(0);
    expect(readGame()).toEqual({ coreVersion: '1.2.0', postgresqlMajor: 18, appId: 'com.example.mygame', buildPlatforms: ['android'] });
    expect((await set('game', 'mygame', 'coreModules', '{"client": ["auth"], "server": []}')).stderr).toBe(
      'coreModules.client.0: must match pattern "^[A-Z][A-Za-z]*Core$"\ncoreModules.client: auth is not a client module of core 1.2.0\n',
    );
  });

  it('writes core settings keys of game settings', async () => {
    expect((await set('game', 'mygame', 'core.UICore.theme.color', '"red"')).code).toBe(0);
    expect(readGame().core).toEqual({ 'UICore.theme': { color: 'red' } });
    expect((await set('game', 'mygame', 'core.NetworkCore.requestTimeoutMs', '20000')).stderr).toBe(
      'core.NetworkCore.requestTimeoutMs × 2 must be at most core.InputBlockCore.maxDurationMs\n',
    );
  });

  it('reads a core. key of game settings by the coreVersion an earlier pair of the same call writes', async () => {
    writeGame({ postgresqlMajor: 18 });
    expect((await set('game', 'mygame', 'core.UICore.theme.color', '"red"')).stderr).toBe('game settings have no coreVersion\n');
    const both = await set('game', 'mygame', 'coreVersion', '"1.2.0"', 'core.UICore.theme.color', '"red"');
    expect(both.stderr).toBe('');
    expect(both).toMatchObject({ code: 0, stdout: 'set coreVersion\nset core.UICore.theme.color\n' });
    expect(readGame()).toMatchObject({ coreVersion: '1.2.0', core: { 'UICore.theme': { color: 'red' } } });
  });

  it('reads core. keys and their owners by the coreVersion the call writes, whatever the pair order', async () => {
    // release 1.3.0 adds a key that only the human owns
    vi.mocked(coreRelease).mockImplementation((_ctx, version) => {
      const release = writeRelease(join(ws.root, `release-${version}`), version);
      if (version === '1.3.0') {
        const file = join(release.dir, 'core-settings.schema.json');
        const schema = JSON.parse(readFileSync(file, 'utf8')) as { properties: Record<string, unknown> };
        schema.properties['NewCore.limit'] = { type: 'integer', minimum: 0, 'x-owner': 'human' };
        writeFileSync(file, JSON.stringify(schema));
      }
      return Promise.resolve(release);
    });
    writeGame({ coreVersion: '1.2.0', postgresqlMajor: 18 });
    expect((await set('game', 'mygame', 'core.NewCore.limit', '5')).stderr).toBe('no core settings key in core.NewCore.limit\n');
    const later = await set('game', 'mygame', 'core.NewCore.limit', '5', 'coreVersion', '"1.3.0"');
    expect(later).toMatchObject({ code: 0, stdout: 'set coreVersion\nset core.NewCore.limit\n' });
    expect(readGame()).toMatchObject({ coreVersion: '1.3.0', core: { 'NewCore.limit': 5 } });
    writeGame({ coreVersion: '1.2.0', postgresqlMajor: 18 });
    asRole('content');
    expect((await set('game', 'mygame', 'coreVersion', '"1.3.0"', 'core.NewCore.limit', '5')).stderr).toContain('role content cannot change core.NewCore.limit (x-owner human)');
  });

  it('writes harness settings', async () => {
    expect((await set('harness', 'jobWaitTimeoutMs', '1000')).code).toBe(0);
    const harness = readHarnessSettingsFile(join(ws.harness, 'settings.json'));
    expect(harness.jobWaitTimeoutMs).toBe(1000);
    expect((await set('harness', 'jobWaitTimeoutMs', '"x"')).stderr).toBe('jobWaitTimeoutMs: must be integer\n');
  });

  it('writes core settings and checks the settings constraints of core-spec/', async () => {
    writeCoreImpl(ws);
    const file = join(ws.coreImpl, 'settings', 'core-settings.json');
    expect((await set('core', 'InputBlockCore.maxDurationMs', '20000')).code).toBe(0);
    expect((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['InputBlockCore.maxDurationMs']).toBe(20000);
    expect((await set('core', 'InputBlockCore.maxDurationMs', '19999')).stderr).toBe(
      'NetworkCore.requestTimeoutMs × 2 must be at most InputBlockCore.maxDurationMs\n',
    );
    expect((await set('core', 'UICore.theme.size', '0')).stderr).toBe('UICore.theme.size: must be >= 1\n');
    expect((await set('core', 'Nope.key', '1')).stderr).toBe('no core settings key in Nope.key\n');
    // a constraint whose other key has no value yet does not block the first value
    const values = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete values['NetworkCore.requestTimeoutMs'];
    writeFileSync(file, JSON.stringify(values));
    expect((await set('core', 'InputBlockCore.maxDurationMs', '1')).code).toBe(0);
  });

  it('writes several values in one call and checks the constraints once, on the result', async () => {
    writeCoreImpl(ws);
    const file = join(ws.coreImpl, 'settings', 'core-settings.json');
    const read = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect((await set('core', 'InputBlockCore.maxDurationMs', '20000')).code).toBe(0);
    // alone, the larger timeout breaks the constraint with the old maximum duration
    expect((await set('core', 'NetworkCore.requestTimeoutMs', '15000')).stderr).toBe('NetworkCore.requestTimeoutMs × 2 must be at most InputBlockCore.maxDurationMs\n');
    const both = await set('core', 'NetworkCore.requestTimeoutMs', '15000', 'InputBlockCore.maxDurationMs', '30000');
    expect(both).toMatchObject({ code: 0, stdout: 'set NetworkCore.requestTimeoutMs\nset InputBlockCore.maxDurationMs\n' });
    expect([read()['NetworkCore.requestTimeoutMs'], read()['InputBlockCore.maxDurationMs']]).toEqual([15000, 30000]);
    // a result that still breaks a constraint writes none of the values
    const before = readFileSync(file, 'utf8');
    expect((await set('core', 'InputBlockCore.maxDurationMs', '40000', 'NetworkCore.requestTimeoutMs', '25000')).stderr).toBe(
      'NetworkCore.requestTimeoutMs × 2 must be at most InputBlockCore.maxDurationMs\n',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await set('core', 'InputBlockCore.maxDurationMs')).stderr).toContain('usage: ogw settings set');
    expect((await set('core', 'InputBlockCore.maxDurationMs', '1', 'NetworkCore.requestTimeoutMs')).stderr).toContain('usage: ogw settings set');
  });

  it('writes the core settings of a worktrees/_core/ worktree when run inside it', async () => {
    writeCoreImpl(ws);
    const tree = join(ws.worktrees, '_core', 'w1');
    mkdirSync(join(ws.worktrees, '_core'), { recursive: true });
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', tree, '-b', 'w1']);
    const run = await ogw(ws, ['settings', 'set', 'core', 'InputBlockCore.maxDurationMs', '25000'], { cwd: join(tree, 'settings') });
    expect(run.code).toBe(0);
    expect((JSON.parse(readFileSync(join(tree, 'settings', 'core-settings.json'), 'utf8')) as Record<string, unknown>)['InputBlockCore.maxDurationMs']).toBe(25000);
    expect((JSON.parse(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), 'utf8')) as Record<string, unknown>)['InputBlockCore.maxDurationMs']).toBe(30000);
  });
});

describe('caller role', () => {
  it('lets the content agent change only content paths of game settings', async () => {
    asRole('content');
    expect((await set('game', 'mygame', 'titleScene', '"scene_title2"')).code).toBe(0);
    expect(readGame().titleScene).toBe('scene_title2');
    expect((await set('game', 'mygame', 'coreModules.client', '["UICore","NetworkCore"]')).code).toBe(0);
    expect((await set('game', 'mygame', 'core.InputBlockCore.maxDurationMs', '40000')).code).toBe(0);
    expect(await set('game', 'mygame', 'appId', '"com.example.x"')).toEqual({ code: 1, stdout: '', stderr: 'role content cannot change appId\n' });
    expect((await set('game', 'mygame', 'core.NetworkCore.requestTimeoutMs', '1')).stderr).toBe(
      'role content cannot change core.NetworkCore.requestTimeoutMs (x-owner human)\n',
    );
    expect((await set('game', 'mygame', 'core', '{"NetworkCore.requestTimeoutMs": 1}')).stderr).toBe(
      'role content cannot change core.NetworkCore.requestTimeoutMs (x-owner human)\n',
    );
    expect((await set('harness', 'jobWaitTimeoutMs', '1')).stderr).toBe('role content cannot change jobWaitTimeoutMs\n');
    expect(readFileSync(join(ws.root, 'out-runs.json'), 'utf8')).toContain('ogw settings set harness jobWaitTimeoutMs 1');
  });

  it('lets the core agent change only core settings', async () => {
    writeCoreImpl(ws);
    asRole('core');
    expect((await set('core', 'NetworkCore.requestTimeoutMs', '100')).code).toBe(0);
    expect((await set('game', 'mygame', 'titleScene', '"x"')).stderr).toBe('role core cannot change titleScene (x-owner content)\n');
  });

  it('lets no other sub-agent change settings', async () => {
    asRole('play');
    expect((await set('game', 'mygame', 'titleScene', '"x"')).stderr).toBe('role play cannot change titleScene (x-owner content)\n');
    expect((await unset('game', 'mygame', 'titleScene')).stderr).toBe('role play cannot change titleScene (x-owner content)\n');
  });

  it('lets no role change a tool path', async () => {
    const run = await set('harness', 'measured.flux2-klein', '[]');
    expect(run).toEqual({ code: 1, stdout: '', stderr: `role lead cannot change hosts.${TEST_HOST_ID}.measured (x-owner tool)\n` });
    const hosts = { [TEST_HOST_ID]: { name: 'h', measured: { 'flux2-klein': [{ result: 'ok' }] } } };
    expect((await set('harness', 'hosts', JSON.stringify(hosts))).stderr).toBe(`role lead cannot change hosts.${TEST_HOST_ID}.measured (x-owner tool)\n`);
    const harness = readHarnessSettingsFile(join(ws.harness, 'settings.json'));
    const methods = structuredClone(harness.resourceGeneration);
    methods[0].safetyTimeoutMs = 1234;
    expect((await set('harness', 'resourceGeneration', JSON.stringify(methods))).code).toBe(0);
  });

  it('gives the role through callerRole', async () => {
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await callerRole(ctx)).toBe('lead');
    asRole('judge');
    expect(await callerRole(ctx)).toBe('judge');
  });

  it('decides each role', () => {
    expect(mayChange('lead', 'harness', undefined, false)).toBe(true);
    expect(mayChange('lead', 'harness', 'tool', false)).toBe(false);
    expect(mayChange('lead', 'harness', 'tool', true)).toBe(true);
    expect(mayChange('content', 'game', 'content', false)).toBe(true);
    expect(mayChange('content', 'game', 'human', false)).toBe(false);
    expect(mayChange('content', 'core', 'content', false)).toBe(false);
    expect(mayChange('core', 'core', undefined, false)).toBe(true);
    expect(mayChange('core', 'game', 'content', false)).toBe(false);
    expect(mayChange('review', 'core', undefined, false)).toBe(false);
  });
});

describe('writeHarnessSettings', () => {
  it('writes tool paths only with allowTool, with the name of this host', async () => {
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const path = join(ws.harness, 'settings.json');
    const harness = readHarnessSettingsFile(path);
    harness.hosts = { [TEST_HOST_ID]: { name: 'old', measured: { 'flux2-klein': [{ result: 'failed' }] } } };
    await expect(writeHarnessSettings(ctx, harness)).rejects.toThrow(`role lead cannot change hosts.${TEST_HOST_ID}.measured (x-owner tool)`);
    await writeHarnessSettings(ctx, harness, { allowTool: true });
    // a host entry is a local-scope path: it goes to settings.local.json
    expect(readHarnessSettingsFile(path).hosts).toBeUndefined();
    expect(readHarnessSettingsFile(join(ws.harness, 'settings.local.json')).hosts).toEqual({ [TEST_HOST_ID]: { name: hostname(), measured: { 'flux2-klein': [{ result: 'failed' }] } } });
    harness.jobWaitTimeoutMs = -1;
    await expect(writeHarnessSettings(ctx, harness, { allowTool: true })).rejects.toThrow('jobWaitTimeoutMs: must be >= 1');
  });
});

describe('gameCheckErrors', () => {
  it('checks the file or the given settings', async () => {
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const game = await ctx.game('mygame');
    expect(await gameCheckErrors(ctx, game)).toEqual([]);
    const settings = validGameSettings();
    settings.sourceLanguage = 'fr';
    expect(await gameCheckErrors(ctx, game, settings)).toEqual(['sourceLanguage: fr is not in supportedLanguages']);
  });
});

describe('ogw settings unset', () => {
  it('removes a value', async () => {
    expect((await set('game', 'mygame', 'gamepadSupported', 'true')).code).toBe(0);
    expect(await unset('game', 'mygame', 'gamepadSupported')).toEqual({ code: 0, stdout: 'unset gamepadSupported\n', stderr: '' });
    expect(readFileSync(gameFile, 'utf8')).toBe(`${JSON.stringify(validGameSettings(), null, 2)}\n`);
  });

  it('removes an array element', async () => {
    const settings = validGameSettings();
    settings.environments.DEV.adminOperators.push({ name: 'alice', roles: ['read'], secret: 'admin-alice' });
    settings.environments.DEV.adminOperators.push({ name: 'bob', roles: ['read'], secret: 'admin-bob' });
    writeGame(settings);
    expect((await unset('game', 'mygame', 'environments.DEV.adminOperators.1')).code).toBe(0);
    expect(readGame().environments.DEV.adminOperators.map((op) => op.name)).toEqual(['ogw', 'bob']);
  });

  it('does nothing for a value that is not set', async () => {
    const run = await ogw(ws, ['settings', 'unset', 'game', 'mygame', 'gamepadSupported', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ path: 'gamepadSupported', changed: false });
    expect((await unset('game', 'mygame', 'gamepadSupported')).stdout).toBe('gamepadSupported is not set\n');
  });

  it('refuses to remove a required value', async () => {
    expect(await unset('game', 'mygame', 'appId')).toEqual({ code: 1, stdout: '', stderr: 'appId: missing\n' });
    expect(readGame().appId).toBe('com.example.mygame');
  });

  it('checks the arguments', async () => {
    expect((await unset('game', 'mygame')).stderr).toBe('usage: ogw settings unset <harness|game <game>|core> <path>\n');
  });
});

describe('game settings lock', () => {
  /** Runs `argv` while another holder of the game settings lock reads, makes `change` and writes the file. */
  async function runWhileLocked(argv: string[], change: (settings: Settings) => void): Promise<number> {
    const held = await withGameSettingsLock(join(ws.games, 'mygame'), ws.env, async () => {
      const settings = readGame();
      const running = ogw(ws, argv);
      await sleep(500);
      change(settings);
      writeGame(settings);
      return { running };
    });
    return (await held.running).code;
  }

  it('reads and writes game settings in the game settings lock, so a change made by another command keeps', async () => {
    const setCode = await runWhileLocked(['settings', 'set', 'game', 'mygame', 'nicknameUnique', 'false'], (settings) => {
      settings.environments.DEV.devAllowedCidrs = ['10.0.0.0/8'];
    });
    expect(setCode).toBe(0);
    expect(readGame().nicknameUnique).toBe(false);
    expect(readGame().environments.DEV.devAllowedCidrs).toEqual(['10.0.0.0/8']);

    const unsetCode = await runWhileLocked(['settings', 'unset', 'game', 'mygame', 'environments.DEV.devAllowedCidrs'], (settings) => {
      settings.nicknameUnique = true;
    });
    expect(unsetCode).toBe(0);
    expect(readGame().environments.DEV.devAllowedCidrs).toBeUndefined();
    expect(readGame().nicknameUnique).toBe(true);
  });
});
