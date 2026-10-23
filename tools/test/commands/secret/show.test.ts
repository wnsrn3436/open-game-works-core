import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentContext, type AgentContext } from '../../../src/lib/agentctx.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { readHarnessSettingsFile, validGameSettings } from '../settings/fixtures.ts';

vi.mock('../../../src/lib/agentctx.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/agentctx.ts')>()),
  agentContext: vi.fn(),
}));

let ws: TestWorkspace;

const VALUES = {
  'ogw/mygame/DEV/atk-dev': 'dev-secret-value',
  'ogw/mygame/signing/android-password': 'signing-secret-value',
  'ogw/harness/gen-api-key': 'harness-secret-value',
};

beforeEach(() => {
  vi.mocked(agentContext).mockResolvedValue(null);
  const harness = readHarnessSettingsFile(join(import.meta.dirname, '..', '..', '..', '..', 'settings.json'));
  const methods = structuredClone(harness.resourceGeneration);
  methods[0].secret = 'gen-api-key';
  ws = makeWorkspace({ resourceGeneration: methods });
  const settings = validGameSettings();
  settings.signing = { android: { keystore: 'android-keystore', password: 'android-password' } };
  makeGame(ws, 'mygame', { 'settings.json': settings });
  writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify(VALUES));
});

const REFUSAL = 'ogw secret show is for a human in a terminal: stdin and stdout must both be a terminal\n';

describe('ogw secret show', () => {
  it('refuses without a terminal and prints no value', async () => {
    for (const argv of [
      ['secret', 'show', 'mygame', 'DEV', 'atk-dev'],
      ['secret', 'show', 'mygame', 'signing', 'android-password'],
      ['secret', 'show', '--harness', 'gen-api-key', '--json'],
      ['secret', 'show', 'mygame', 'DEV', 'not-named'],
    ]) {
      const run = await ogw(ws, argv);
      expect(run).toMatchObject({ code: 1, stderr: REFUSAL });
      if (!argv.includes('--json')) expect(run.stdout).toBe('');
      for (const value of Object.values(VALUES)) expect(run.stdout + run.stderr).not.toContain(value);
    }
  });

  it('prints the value in a terminal', async () => {
    expect(await ogw(ws, ['secret', 'show', 'mygame', 'DEV', 'atk-dev'], { terminal: true })).toEqual({ code: 0, stdout: 'dev-secret-value\n', stderr: '' });
    expect((await ogw(ws, ['secret', 'show', 'mygame', 'signing', 'android-password'], { terminal: true })).stdout).toBe('signing-secret-value\n');
    const json = await ogw(ws, ['secret', 'show', '--harness', 'gen-api-key', '--json'], { terminal: true });
    expect(JSON.parse(json.stdout)).toEqual({ name: 'gen-api-key', value: 'harness-secret-value' });
  });

  it('fails for a secret that is not in the secret store or not named in settings', async () => {
    writeFileSync(join(ws.root, 'secrets.json'), '{}');
    expect(await ogw(ws, ['secret', 'show', 'mygame', 'DEV', 'atk-dev'], { terminal: true })).toEqual({
      code: 1,
      stdout: '',
      stderr: 'atk-dev is not in the secret store\n',
    });
    expect((await ogw(ws, ['secret', 'show', 'mygame', 'DEV', 'not-named'], { terminal: true })).stderr).toBe(
      'game settings environments.DEV has no secret named not-named\n',
    );
    expect((await ogw(ws, ['secret', 'show', '--harness', 'nope'], { terminal: true })).stderr).toBe(
      'harness settings resourceGeneration has no secret named nope\n',
    );
    expect((await ogw(ws, ['secret', 'show', 'mygame', 'DEV'], { terminal: true })).stderr).toMatch(/^usage: ogw secret show /);
  });

  it('writes the value to no run log and takes no --background', async () => {
    const runLog = join(ws.root, 'out-runs.json');
    const agent = { job: { id: 'job1' }, meta: { role: 'content', cliPid: null, output: join(ws.root, 'out.md'), runLog } };
    vi.mocked(agentContext).mockResolvedValue(agent as unknown as AgentContext);
    expect((await ogw(ws, ['secret', 'show', 'mygame', 'DEV', 'atk-dev'], { terminal: true })).stdout).toBe('dev-secret-value\n');
    const log = readFileSync(runLog, 'utf8');
    expect(JSON.parse(log)).toMatchObject({ runs: [{ command: 'ogw secret show mygame DEV atk-dev', exitCode: 0, summary: null }] });
    expect(log).not.toContain('dev-secret-value');
    const background = await ogw(ws, ['secret', 'show', 'mygame', 'DEV', 'atk-dev', '--background'], { terminal: true });
    expect(background).toMatchObject({ code: 1, stdout: '' });
    for (const file of readdirSync(ws.root, { recursive: true, encoding: 'utf8' })) {
      if (file === 'secrets.json') continue;
      let text = '';
      try {
        text = readFileSync(join(ws.root, file), 'utf8');
      } catch {
        continue;
      }
      expect(text, file).not.toContain('dev-secret-value');
    }
  });
});
