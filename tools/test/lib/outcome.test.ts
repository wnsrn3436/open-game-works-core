import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../src/commands/check/api.ts';
import { mergedResult } from '../../src/commands/check/api.ts';
import { gateOf } from '../../src/commands/check/lib/loop.ts';
import { blocksBuild, DEV_WARN_ONLY } from '../../src/commands/build/lib/settingschecks.ts';
import { ENVS } from '../../src/commands/build/lib/names.ts';
import { inheritedRenderPass, inKeyPaths } from '../../src/commands/core/lib/render-pass.ts';
import { readCoreSpecDir } from '../../src/commands/core/lib/impl.ts';
import { addTestRecord, clientCorePassed, recordOutcome } from '../../src/commands/core/lib/test-records.ts';
import { NOT_RECORDED, outcomeOf, passes, rerunHint, runOutcome, SCREEN_LOCKED } from '../../src/lib/outcome.ts';
import { commitAll, makeWorkspace, sh } from '../helpers/workspace.ts';
import { writeImpl } from '../commands/core/impl-fixture.ts';

describe('outcome', () => {
  it('keeps pass and fail and maps every other raw result to unknown with a reason', () => {
    expect(outcomeOf('pass')).toEqual({ result: 'pass', reason: null });
    expect(outcomeOf('fail', 'ignored')).toEqual({ result: 'fail', reason: null });
    expect(outcomeOf('unknown', SCREEN_LOCKED)).toEqual({ result: 'unknown', reason: SCREEN_LOCKED });
    expect(outcomeOf('unknown')).toEqual({ result: 'unknown', reason: 'not checked' });
    expect(outcomeOf('skipped')).toEqual({ result: 'unknown', reason: 'not checked' });
    expect(outcomeOf('skipped', 'godot round trip left out')).toEqual({ result: 'unknown', reason: 'godot round trip left out' });
    expect(outcomeOf(undefined)).toEqual({ result: 'unknown', reason: NOT_RECORDED });
    expect(outcomeOf(null)).toEqual({ result: 'unknown', reason: NOT_RECORDED });
    expect(outcomeOf('running')).toEqual({ result: 'unknown', reason: 'running' });
    expect(outcomeOf(3)).toEqual({ result: 'unknown', reason: '3' });
    expect(runOutcome(true, SCREEN_LOCKED)).toEqual({ result: 'fail', reason: null });
    expect(runOutcome(false, SCREEN_LOCKED)).toEqual({ result: 'unknown', reason: SCREEN_LOCKED });
    expect(runOutcome(false, undefined)).toEqual({ result: 'pass', reason: null });
    expect(rerunHint(SCREEN_LOCKED)).toBe('rerun with the screen unlocked');
    expect(rerunHint('other')).toBe('rerun');
  });

  it('reads a test record: its reasons, and the skipped of a locked screen as unknown (screen locked)', () => {
    const record = {
      commit: 'c', target: 'godot', recordedAt: 1,
      modules: { A: 'pass', B: 'unknown', C: 'skipped', D: 'skipped' } as const,
      reasons: { B: 'r' },
      skips: { C: 'render pass not run: the macOS screen is locked or the display sleeps', D: 'other' },
    };
    expect(['A', 'B', 'C', 'D', 'E'].map((m) => recordOutcome(record, m))).toEqual([
      { result: 'pass', reason: null },
      { result: 'unknown', reason: 'r' },
      { result: 'unknown', reason: SCREEN_LOCKED },
      { result: 'unknown', reason: 'other' },
      { result: 'unknown', reason: NOT_RECORDED },
    ]);
  });

  it('puts in the key paths of a module its folder, its dependencies, the shared folders and the engine files outside module folders', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const all = await readCoreSpecDir(ws.coreImpl);
    const inKey = (path: string): boolean => inKeyPaths(path, 'godot', 'UICore', all);
    expect(['client/godot/core/ui_core/tests/test_render_ui.gd', 'client/godot/core/log_core/log_core.gd', 'client/godot/core/core_settings.gd', 'client/godot/engine.json', 'core-spec/routing.json', 'settings/core-settings.json', 'test-data/settings.json', 'fixtures/a.json', 'proto/ogw/core.proto', 'tools/data-tool/src/a.ts'].filter((p) => !inKey(p))).toEqual([]);
    expect(['server/core/routing/a.ts', 'records/a.md', 'client/godot/core/other_core/a.gd', 'tools/tests/game/a.txt', 'benchmark/godot/a.gd'].filter(inKey)).toEqual(['client/godot/core/other_core/a.gd']);
    // a folder of no module of `core-spec/` is a file of the engine package: in the key of every module
    expect(inKeyPaths('client/godot/core/log_core/a.gd', 'godot', 'LogCore', all)).toBe(true);
    expect(inKeyPaths('client/godot/core/ui_core/a.gd', 'godot', 'LogCore', all)).toBe(false);
  });
});

describe('no gate maps unknown to pass', () => {
  const check = (name: string, result: CheckResult['result']): CheckResult => ({ name, platform: null, result, failures: [], warnings: [] });

  it('blocks a build on unknown wherever it blocks it on fail', () => {
    for (const env of ENVS) {
      for (const name of [...DEV_WARN_ONLY, 'secret', 'backward compatibility', 'native plugin']) {
        expect(blocksBuild({ name, result: 'unknown', details: [] }, env), `${name} ${env}`).toBe(env !== 'DEV' || !DEV_WARN_ONLY.has(name));
        expect(blocksBuild({ name, result: 'fail', details: [] }, env), `${name} ${env}`).toBe(true);
        expect(blocksBuild({ name, result: 'pass', details: [] }, env)).toBe(false);
      }
    }
    expect(blocksBuild({ name: 'device performance', result: 'unknown', details: [] }, 'STG')).toBe(true);
    expect(blocksBuild({ name: 'device performance', result: 'warn', details: [] }, 'DEV')).toBe(false);
  });

  it('gives the loop gate fail and a combined check unknown when a check is unknown', () => {
    const passing = ['regression test', 'static check', 'no blocker', 'full flow'].map((name) => check(name, 'pass'));
    expect(gateOf(passing)).toBe('pass');
    expect(gateOf([...passing.slice(1), check('regression test', 'unknown')])).toBe('fail');
    expect(mergedResult([check('UI quality', 'pass'), check('UI quality', 'unknown')])).toBe('unknown');
    expect(mergedResult([])).toBe('unknown');
  });

  it('counts a client core as compiled when a module is unknown only for a locked screen, and not for another unknown', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    commitAll(ws.coreImpl, 'impl');
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'unknown' }, reasons: { UICore: 'not recorded' }, recordedAt: 1 });
    expect(await clientCorePassed(ws.coreImpl, 'godot')).toBe(false);
    // the headless pass passed and only the render pass was left out: the client core compiles
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 2 });
    expect(await clientCorePassed(ws.coreImpl, 'godot')).toBe(true);
  });

  it('counts the legacy locked-screen skip as compiled too, and a fail as not compiled', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    commitAll(ws.coreImpl, 'impl');
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'fail' }, recordedAt: 1 });
    expect(await clientCorePassed(ws.coreImpl, 'godot')).toBe(false);
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'skipped' }, skips: { UICore: 'render pass not run: the macOS screen is locked or the display sleeps' }, recordedAt: 2 });
    expect(await clientCorePassed(ws.coreImpl, 'godot')).toBe(true);
  });

  it('takes no render pass for a locked screen when the last render pass that ran on that code failed', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    commitAll(ws.coreImpl, 'impl');
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const all = await readCoreSpecDir(ws.coreImpl);
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'pass' }, recordedAt: 1 });
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', head, all, ws.env)).toBe(head);
    // a locked-screen unknown after it does not hide the pass
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 2 });
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', head, all, ws.env)).toBe(head);
    // the render pass ran again and failed: a locked screen takes nothing
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'fail' }, recordedAt: 3 });
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', head, all, ws.env)).toBeNull();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 4 });
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', head, all, ws.env)).toBeNull();
  });

  it('passes over a render pass that failed on other code, such as a core agent run of a changed module', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    commitAll(ws.coreImpl, 'impl');
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const all = await readCoreSpecDir(ws.coreImpl);
    await addTestRecord(ws.coreImpl, { commit: main, target: 'godot', modules: { LogCore: 'pass', UICore: 'pass' }, recordedAt: 1 });
    // a later run on a commit whose UICore folder differs fails its render pass
    const uiFile = join(ws.coreImpl, 'client', 'godot', 'core', 'ui_core', 'ui_core.gd');
    writeFileSync(uiFile, `${readFileSync(uiFile, 'utf8')}# agent fix\n`);
    const agent = commitAll(ws.coreImpl, 'agent fix');
    await addTestRecord(ws.coreImpl, { commit: agent, target: 'godot', modules: { UICore: 'fail' }, recordedAt: 2 });
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', main, all, ws.env)).toBe(main);
    // on the agent's code the failed render pass is the last one: nothing to take
    expect(await inheritedRenderPass(ws.coreImpl, 'godot', 'UICore', agent, all, ws.env)).toBeNull();
  });

  it('reads a test, check or job result through outcomeOf only: no other source file compares a result with skipped', () => {
    const src = join(import.meta.dirname, '..', '..', 'src');
    const readers = new Set(['lib/outcome.ts', 'commands/core/lib/test-records.ts']);
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(src, f));
    const offenders = files.filter((file) => !readers.has(relative(src, file)) && /[!=]==\s*'skipped'|'skipped'\s*[!=]==/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(src, f))).toEqual([]);
    expect(passes(outcomeOf('skipped'))).toBe(false);
    expect(passes(outcomeOf('unknown'))).toBe(false);
  });
});
