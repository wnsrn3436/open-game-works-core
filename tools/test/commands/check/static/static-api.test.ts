import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STATIC_CHECKS, staticCheck, staticCheckDetail } from '../../../../src/commands/check/static-api.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import { makeGame, makeWorkspace } from '../../../helpers/workspace.ts';
import { testContext, writeFiles } from './helpers.ts';

const mocks = vi.hoisted(() => ({ dir: '', dataLines: [] as unknown[], failCheck: false }));

vi.mock('../../../../src/commands/core/api.ts', () => ({
  coreReleaseOfGame: () => Promise.resolve({ version: '1.0.0', dir: mocks.dir, local: false }),
  extractedAsset: () => Promise.resolve(join(mocks.dir, 'empty')),
}));
vi.mock('../../../../src/commands/env/api.ts', () => ({
  requireEngine: () => Promise.resolve(join(mocks.dir, 'bin', 'ok')),
  toolProgram: () => Promise.resolve(join(mocks.dir, 'bin', 'ok')),
}));
vi.mock('../../../../src/commands/generate/api.ts', () => ({
  runGenerate: () => Promise.resolve(),
  gameModules: () => Promise.resolve({ client: [], server: [] }),
  gameCoreSpec: () => Promise.resolve({ version: '1.0.0', modules: [] }),
}));
vi.mock('../../../../src/commands/data/api.ts', () => ({
  runData: () => Promise.resolve({ exitCode: mocks.dataLines.some((l) => (l as { level: string }).level === 'ERROR') ? 1 : 0, lines: mocks.dataLines, stderr: '' }),
}));
vi.mock('../../../../src/commands/contract/api.ts', () => ({
  runContract: () => Promise.resolve({ exitCode: 0, violations: [], stderr: '' }),
}));
vi.mock('../../../../src/commands/settings/api.ts', () => ({
  gameCheckErrors: () => (mocks.failCheck ? Promise.reject(new OgwError('game check broke')) : Promise.resolve([])),
}));

const ALWAYS = ['AuthCore.open_terms_document', 'AuthCore.withdraw', 'AuthCore.get_user_id', 'NativeUiCore.copy_text', 'UICore.open_licenses', 'AuthCore.issue_deletion_code'];

async function setup(
  files: Record<string, string | object>,
): Promise<{ run: (debugText?: boolean) => ReturnType<typeof staticCheck>; detail: () => ReturnType<typeof staticCheckDetail> }> {
  mocks.dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-static-api-')));
  writeFiles(mocks.dir, { 'core-settings.schema.json': '{}', 'empty/engine.json': '{"godot": "4.5.1.stable"}', 'bin/ok': '#!/bin/sh\nexit 0\n' });
  chmodSync(join(mocks.dir, 'bin', 'ok'), 0o755);
  const ws = makeWorkspace();
  const root = makeGame(ws, 'g', files);
  const ctx = testContext(root, ws.env);
  const game = await ctx.game('g');
  return { run: (debugText) => staticCheck(ctx, game, debugText === undefined ? undefined : { debugText }), detail: () => staticCheckDetail(ctx, game) };
}

const GAME = {
  'settings.json': { engine: 'godot' },
  'client/dev/bot/scenario.json': {
    steps: [
      { kind: 'save', timeoutMs: 1 },
      { kind: 'setup', command: 'force_network_failure', args: ['connection_failed'], timeoutMs: 1 },
      { kind: 'setup', command: 'force_network_failure', args: ['none'], timeoutMs: 1 },
      { kind: 'setup', command: 'shop.open_main', until: { path: 'state.x', op: 'eq', value: 1 }, timeoutMs: 1 },
    ],
    goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 },
  },
  'client/features/options/options_panel.gd': `class_name OptionsPanel\nfunc f() -> void:\n${ALWAYS.map((c) => `\t${c}()`).join('\n')}\n`,
  // every release asset is `empty/`: the client zip's `core/` is absent, so `client/core/` is empty
  'server/core/engine.json': '{"godot": "4.5.1.stable"}',
};

describe('staticCheck', () => {
  it('lists the static checks except data check and debug text', () => {
    expect(STATIC_CHECKS.map((c) => c.NAME)).toEqual([
      'core diff', 'generated diff', 'contract', 'DEV reference', 'type check', 'lint', 'data literal', 'resource hash', 'block token', 'test input',
      'frame polling', 'haptic format', 'embedded script', 'theme only', 'scene links', 'system clock', 'game state lock', 'shared formula', 'bot scenario', 'option entry',
      'game settings owner', 'design target', 'simulation target', 'feature boundary', 'forbidden GDScript API', 'settings access',
      'resource load', 'engine random', 'data mutation', 'frame code', 'literal timing', 'object destroy', 'determinism',
      'virtual pad layout', 'format args', 'action reference', 'anchor reference',
    ]);
  });

  it('passes a clean game and carries data check warnings', async () => {
    mocks.dataLines = [{ level: 'WARN', code: 'banned_word_missing', where: 'records/setup/banned-words/ko.txt:1:1', message: 'no list', text: '' }];
    const { run } = await setup(GAME);
    const result = await run();
    expect(result).toEqual({
      name: 'static check',
      platform: null,
      result: 'pass',
      failures: [],
      warnings: [{ where: 'records/setup/banned-words/ko.txt:1:1', message: 'data check banned_word_missing no list', evidence: [] }],
    });
  });

  it('collects failures of every check in order and runs debug text only when asked', async () => {
    mocks.dataLines = [{ level: 'ERROR', code: 'structure', where: 'data/enums.csv:1:1', message: 'bad header', text: '' }];
    const { run } = await setup({ ...GAME, 'client/features/options/options_x.gd': 'class_name OptionsX\nvar a := 7\nfunc f() -> void:\n\tlabel.text = "Hi"\n' });
    const result = await run();
    expect(result.result).toBe('fail');
    expect(result.failures).toEqual([
      { where: 'client/features/options/options_x.gd:2', message: 'data literal: number literal `7` outside a constants file', evidence: [] },
      { where: 'data/enums.csv:1', message: 'data check structure bad header', evidence: [] },
    ]);
    const withDebug = await run(true);
    expect(withDebug.failures.map((f) => f.message)).toContain('debug text: string literal in UI text');
  });

  it('gives the absence failures apart', async () => {
    mocks.dataLines = [];
    const files: Record<string, string | object> = { ...GAME, 'client/features/options/options_x.gd': 'class_name OptionsX\nvar a := 7\n' };
    delete files['client/dev/bot/scenario.json'];
    const { detail } = await setup(files);
    const { result, absent } = await detail();
    expect(result.failures).toEqual([
      { where: 'client/dev/bot:1', message: 'bot scenario: scenario file is missing', evidence: [] },
      { where: 'client/features/options/options_x.gd:2', message: 'data literal: number literal `7` outside a constants file', evidence: [] },
    ]);
    expect(absent).toEqual([result.failures[0]]);
    expect(absent[0]).toBe(result.failures[0]);
  });

  it('reports a file a check could not parse at its line 1 and keeps the other findings', async () => {
    mocks.dataLines = [];
    const { run } = await setup({
      ...GAME,
      'client/features/options/options_x.gd': 'class_name OptionsX\nvar a := 7\n',
      'resource/resources.csv': 'key,description,spec,status,sha256\na,"b\n',
      'data/translations/en.csv': 'key,source,source_hash,current_hash,text\nt.a,"open,,1,A\n',
    });
    expect((await run()).failures).toEqual([
      { where: 'client/features/options/options_x.gd:2', message: 'data literal: number literal `7` outside a constants file', evidence: [] },
      { where: 'data/translations/en.csv:1', message: 'action reference: data/translations/en.csv could not be read: data/translations/en.csv:2: unclosed quote', evidence: [] },
      { where: 'resource/resources.csv:1', message: 'resource hash: resource/resources.csv could not be read: resource/resources.csv:2: unclosed quote', evidence: [] },
    ]);
  });

  it('fails when a check cannot run', async () => {
    mocks.dataLines = [];
    mocks.failCheck = true;
    const { run } = await setup(GAME);
    await expect(run()).rejects.toThrow('game check broke');
    mocks.failCheck = false;
  });
});
