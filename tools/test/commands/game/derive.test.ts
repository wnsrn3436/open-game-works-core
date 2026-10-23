import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { deriveSettings } from '../../../src/commands/game/lib/derive.ts';
import { agentContext, type AgentContext } from '../../../src/lib/agentctx.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { validGameSettings, writeRelease } from '../settings/fixtures.ts';
import type { GameSettingsFixture } from '../settings/fixtures.ts';

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
let file: string;

beforeEach(() => {
  ws = makeWorkspace();
  vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release')));
  vi.mocked(agentContext).mockResolvedValue(null);
  makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
  file = join(ws.games, 'mygame', 'settings.json');
});

function write(settings: Settings): void {
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

const read = (): Settings => JSON.parse(readFileSync(file, 'utf8')) as Settings;
const r2 = (url: string) => ({ accountId: 'a', bucket: 'b', accessKeyId: 'k', publicBaseUrl: url });

describe('ogw game derive', () => {
  it('sets operator ogw, adapters.cdn and corsAllowedOrigins for web', async () => {
    const settings = validGameSettings();
    settings.buildPlatforms = ['web', 'linux'];
    settings.environments.DEV.adminOperators = [
      { name: 'alice', roles: ['read', 'privacy'], secret: 'admin-alice' },
      { name: 'ogw', roles: ['read'], secret: 'keep' },
    ];
    settings.environments.DEV.adapters = { cdn: 'fake' };
    settings.environments.DEV.cdnR2 = r2('https://cdn.dev.example.com/game');
    settings.environments.DEV.secrets.cdn = 'cdn-dev';
    settings.environments.DEV.devAllowedCidrs = ['10.0.0.0/8'];
    settings.environments.STG.cdnR2 = r2('https://cdn.stg.example.com');
    settings.environments.STG.secrets.cdn = 'cdn-stg';
    write(settings);
    const run = await ogw(ws, ['game', 'derive', 'mygame']);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split('\n')).toEqual([
      'set environments.DEV.corsAllowedOrigins.0',
      'set environments.DEV.adminOperators.1.roles.1',
      'set environments.DEV.adminOperators.1.roles.2',
      'set environments.DEV.adminOperators.1.secret',
      'set environments.DEV.adapters.cdn',
      'set environments.STG.corsAllowedOrigins.0',
      'set environments.STG.adapters.cdn',
      'set environments.PROD.corsAllowedOrigins.0',
    ]);
    const after = read();
    expect(after.environments.DEV.adminOperators).toEqual([
      { name: 'alice', roles: ['read', 'privacy'], secret: 'admin-alice' },
      { name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-dev' },
    ]);
    expect(after.environments.DEV.adapters).toEqual({ cdn: 'cdn-r2' });
    expect(after.environments.DEV.corsAllowedOrigins).toEqual(['https://cdn.dev.example.com']);
    expect(after.environments.STG.corsAllowedOrigins).toEqual(['https://cdn.stg.example.com']);
    expect(after.environments.PROD.corsAllowedOrigins).toEqual(['https://cdn.example.com']);
    expect((await ogw(ws, ['game', 'derive', 'mygame'])).stdout).toBe('no change\n');
  });

  it('empties corsAllowedOrigins without web and leaves DEV and STG cdn', async () => {
    const settings = validGameSettings();
    settings.environments.DEV.adapters = { cdn: 'fake' };
    settings.environments.PROD.corsAllowedOrigins = ['https://cdn.example.com'];
    write(settings);
    const run = await ogw(ws, ['game', 'derive', 'mygame', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ changed: ['environments.PROD.corsAllowedOrigins.0'] });
    expect(read().environments.DEV.adapters).toEqual({ cdn: 'fake' });
    expect(read().environments.PROD.corsAllowedOrigins).toEqual([]);
  });

  it('does not write when the result fails the check or the role', async () => {
    const settings = validGameSettings();
    settings.appId = 'Bad';
    settings.environments.PROD.corsAllowedOrigins = ['https://x.example.com'];
    write(settings);
    const before = readFileSync(file, 'utf8');
    const run = await ogw(ws, ['game', 'derive', 'mygame']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('appId: must match pattern "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$"\n');
    const agent = { job: { id: 'j' }, meta: { role: 'content', cliPid: null, output: join(ws.root, 'o.md'), runLog: join(ws.root, 'o-runs.json') } };
    vi.mocked(agentContext).mockResolvedValue(agent as unknown as AgentContext);
    expect((await ogw(ws, ['game', 'derive', 'mygame'])).stderr).toBe('role content cannot change environments.PROD.corsAllowedOrigins.0\n');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('checks the arguments', async () => {
    expect((await ogw(ws, ['game', 'derive'])).stderr).toBe('usage: ogw game derive <game>\n');
  });
});

describe('deriveSettings', () => {
  it('creates the environments of an empty draft', () => {
    expect(deriveSettings({ buildPlatforms: ['web'] })).toEqual({
      buildPlatforms: ['web'],
      environments: {
        DEV: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-dev' }], adapters: { cdn: 'cdn-r2' } },
        STG: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-stg' }], adapters: { cdn: 'cdn-r2' } },
        PROD: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read'], secret: 'admin-ogw-prod' }], adapters: { cdn: 'cdn-r2' } },
      },
    });
  });

  it('keeps the input as it was and ignores a bad publicBaseUrl', () => {
    const input = { buildPlatforms: ['web'], environments: { PROD: { cdnR2: { publicBaseUrl: 'not a url' } } } };
    const copy = structuredClone(input);
    expect((deriveSettings(input).environments as Settings['environments']).PROD.corsAllowedOrigins).toEqual([]);
    expect(input).toEqual(copy);
  });

  it('fails for values of the wrong shape', () => {
    expect(() => deriveSettings({ environments: [] })).toThrow('environments is not an object');
    expect(() => deriveSettings({ environments: { DEV: 1 } })).toThrow('environments.DEV is not an object');
    expect(() => deriveSettings({ environments: { STG: { adminOperators: {} } } })).toThrow('environments.STG.adminOperators is not an array');
    expect(() => deriveSettings({ environments: { PROD: { adapters: 'x' } } })).toThrow('environments.PROD.adapters is not an object');
  });
});
