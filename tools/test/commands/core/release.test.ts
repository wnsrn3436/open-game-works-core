import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodeCheck } from '../../../src/commands/code/api.ts';
import { readCoreSpecDir } from '../../../src/commands/core/lib/impl.ts';
import { baseProtoViolations, constraintViolations, coreSpecViolations, coreTestCommand, implementedConstraints, releaseBrowserRuns, requiredTargets, testRecordViolations } from '../../../src/commands/core/lib/release-conditions.ts';
import type { Context } from '../../../src/lib/command.ts';
import { addTestRecord, mergedResults } from '../../../src/commands/core/lib/test-records.ts';
import { SCREEN_LOCKED } from '../../../src/lib/outcome.ts';
import { baseProtoBreaks } from '../../../src/commands/core/lib/base-proto-compat.ts';
import { benchmarkDataViolations } from '../../../src/commands/core/lib/benchmark-data.ts';
import { buildCoreSpec } from '../../../src/commands/core/spec-api.ts';
import { clearReviews, lastReviewResults } from '../../../src/commands/review/api.ts';
import { checkoutLock } from '../../../src/lib/git.ts';
import { withWriterLock } from '../../../src/lib/rwlock.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeGh, makeReleaseDir, readJsonFile, writeFiles } from './helpers.ts';
import { writeImpl } from './impl-fixture.ts';

vi.mock('../../../src/commands/core/spec-api.ts', () => ({ buildCoreSpec: vi.fn(), writeCoreSpec: vi.fn() }));
vi.mock('../../../src/commands/code/api.ts', () => ({ runCodeCheck: vi.fn() }));
vi.mock('../../../src/commands/review/api.ts', () => ({ lastReviewResults: vi.fn(), clearReviews: vi.fn(() => Promise.resolve({ notRemoved: [] as string[], discarded: [] as string[] })) }));
// the browser runs of the release start `ogw core test --web` processes: `release-browser.test.ts` tests them
vi.mock('../../../src/commands/core/lib/release-conditions.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  releaseBrowserRuns: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../src/commands/core/lib/undefined.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isServerCoreTest: (rel: string) => rel.includes('/tests/'),
}));
vi.mock('../../../src/commands/core/lib/tools.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  return {
    ...original,
    stageToolPackage: (_env: unknown, _impl: string, tool: string, stage: string) => {
      (globalThis as { onStageTool?: () => void }).onStageTool?.();
      mkdir(joinPath(stage, 'bin'), { recursive: true });
      write(joinPath(stage, 'bin', `${tool}.js`), '');
      return Promise.resolve();
    },
  };
});
vi.mock('../../../src/commands/core/lib/github.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/commands/core/lib/github.ts')>();
  return {
    ...original,
    createRelease: async (...args: Parameters<typeof original.createRelease>) => {
      await (globalThis as { onCreateRelease?: () => Promise<void> }).onCreateRelease?.();
      return original.createRelease(...args);
    },
    releaseExists: async (...args: Parameters<typeof original.releaseExists>) => {
      const fails = (globalThis as { releaseExistsFails?: string }).releaseExistsFails;
      if (fails !== undefined) throw new Error(fails);
      return original.releaseExists(...args);
    },
  };
});
vi.mock('../../../src/commands/core/lib/base-proto-compat.ts', () => ({ baseProtoBreaks: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../../src/commands/core/lib/benchmark-data.ts', () => ({ benchmarkDataViolations: vi.fn(() => Promise.resolve([])) }));

const NOTES_TEXT = '## Summary\n\nA release.\n';
/** The release notes file the releases of these tests get. */
const NOTES = join(mkdtempSync(join(tmpdir(), 'ogw-notes-')), 'notes.md');
writeFileSync(NOTES, NOTES_TEXT);

function specFiles(impl: string): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const name of ['LogCore', 'UICore', 'routing']) map.set(name, readJsonFile(join(impl, 'core-spec', `${name}.json`)));
  return map;
}

async function recordAllPass(impl: string): Promise<string> {
  const commit = sh(impl, 'git', ['rev-parse', 'HEAD']).trim();
  const at = Date.now();
  await addTestRecord(impl, { commit, target: 'server', modules: { routing: 'fail' }, recordedAt: at - 10 });
  await addTestRecord(impl, { commit, target: 'server', modules: { routing: 'pass' }, recordedAt: at });
  await addTestRecord(impl, { commit, target: 'godot', modules: { UICore: 'pass', LogCore: 'pass' }, recordedAt: at });
  await addTestRecord(impl, { commit, target: 'godot --web', modules: { UICore: 'pass', LogCore: 'pass' }, recordedAt: at });
  await addTestRecord(impl, { commit, target: 'tools', modules: { 'contract-tool': 'pass', 'data-tool': 'pass' }, recordedAt: at });
  return commit;
}

/** The bare repo of the core release repository of these tests. */
function remotePath(ws: TestWorkspace): string {
  return join(ws.root, 'remotes', 'wnsrn3436', 'open-game-works-core-impl.git');
}

/** A bare repo that `https://github.com/<repo>.git` pushes go to. */
function remoteEnv(ws: TestWorkspace): NodeJS.ProcessEnv {
  const remotes = join(ws.root, 'remotes');
  sh(ws.root, 'git', ['init', '--quiet', '--bare', remotePath(ws)]);
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
}

/** Puts a commit that the checkout does not have on main of the core release repository, as a push from elsewhere; returns it. */
function commitOnRemoteMain(ws: TestWorkspace, name: string): string {
  const clone = join(ws.root, `clone-${name}`);
  sh(ws.root, 'git', ['clone', '--quiet', '--branch', 'main', remotePath(ws), clone]);
  writeFileSync(join(clone, `${name}.txt`), name);
  commitAll(clone, `${name} from elsewhere`);
  sh(clone, 'git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  return sh(clone, 'git', ['rev-parse', 'HEAD']).trim();
}

async function setup(): Promise<{ ws: TestWorkspace; env: NodeJS.ProcessEnv; gh: ReturnType<typeof fakeGh> }> {
  const ws = makeWorkspace();
  writeImpl(ws.coreImpl);
  // the tag of the release below the versions these tests release, which the review targets are counted from
  sh(ws.coreImpl, 'git', ['tag', 'v1.1.0']);
  await recordAllPass(ws.coreImpl);
  const gh = fakeGh(ws, { 'v1.1.0': makeReleaseDir(join(ws.root, 'r110'), '1.1.0', { 'a.json': '1' }) });
  vi.mocked(buildCoreSpec).mockResolvedValue({ modules: specFiles(ws.coreImpl), settingTypes: new Map(), gameSettings: new Map(), errors: [] });
  return { ws, gh, env: { ...gh.env, ...remoteEnv(ws) } };
}

beforeEach(() => {
  vi.mocked(runCodeCheck).mockReset().mockResolvedValue([{ name: 'type check', result: 'pass', failures: [] }]);
  vi.mocked(lastReviewResults).mockReset().mockResolvedValue(new Map([['UICore', 'done']]));
  vi.mocked(releaseBrowserRuns).mockReset().mockResolvedValue([]);
  vi.mocked(clearReviews).mockClear();
  vi.mocked(baseProtoBreaks).mockReset().mockResolvedValue([]);
  vi.mocked(benchmarkDataViolations).mockReset().mockResolvedValue([]);
});

describe('ogw core release', () => {
  it('releases when every condition holds', async () => {
    const { ws, env, gh } = await setup();
    // what the clear of the core reviews could not remove is in the output
    const left = { notRemoved: ['/w/_core/agent-x', 'agent/x'], discarded: ['agent/y: 2 commits not in main, last abc'] };
    vi.mocked(clearReviews).mockResolvedValueOnce(left);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const harnessHead = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect(run.stdout).toBe(`released 1.2.0: tag v1.2.0 at ${head}\nharness tag core-v1.2.0 at ${harnessHead}\nnot removed: /w/_core/agent-x\nnot removed: agent/x\ndiscarded: agent/y: 2 commits not in main, last abc\n`);
    // the harness commit whose specs the core was made from
    expect(sh(ws.harness, 'git', ['rev-parse', 'core-v1.2.0^{commit}']).trim()).toBe(harnessHead);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s']).trim()).toBe('core release 1.2.0: plugin URLs and SHA-256');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(head);
    const engine = readJsonFile(join(ws.coreImpl, 'client/godot/engine.json')) as { plugins: { url: string; sha256: string }[] };
    expect(engine.plugins[0]?.url).toBe('https://github.com/wnsrn3436/open-game-works-core-impl/releases/download/v1.2.0/client-godot-plugins.zip');
    expect(engine.plugins[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sh(remotePath(ws), 'git', ['tag']).trim()).toBe('v1.2.0');
    // main goes to the core release repository with the tag: the tagged commit is on its main
    expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(head);
    expect(gh.created()['v1.2.0']?.sort()).toEqual([
      'benchmark-godot.zip', 'client-godot-plugins.zip', 'client-godot.zip', 'contract-tool.tgz', 'core-settings-constraints.json', 'core-settings.json',
      'core-settings.schema.json', 'core-spec.json', 'data-tool.tgz', 'licenses.json', 'manifest.json', 'server.tgz',
    ]);
    const create = gh.calls().find((c) => c[1] === 'create') ?? [];
    expect(create.slice(-7)).toEqual(['--repo', 'wnsrn3436/open-game-works-core-impl', '--verify-tag', '--title', 'v1.2.0', '--notes', NOTES_TEXT]);
    expect(gh.notes()['v1.2.0']).toBe(NOTES_TEXT);
    expect(clearReviews).toHaveBeenCalledWith(expect.anything(), 'core');
    expect(runCodeCheck).toHaveBeenCalledWith(expect.anything(), 'core', ws.coreImpl);
    expect(releaseBrowserRuns).toHaveBeenCalledWith(expect.anything(), ws.coreImpl);
    expect(baseProtoBreaks).toHaveBeenCalledWith(expect.anything(), ws.coreImpl, '1.1.0');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('carries what the clear of the core reviews left in --json', async () => {
    const { ws, env } = await setup();
    const left = { notRemoved: ['/w/_core/agent-x', 'agent/x'], discarded: ['agent/y: 2 commits not in main, last abc'] };
    vi.mocked(clearReviews).mockResolvedValueOnce(left);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject(left);
  });

  it('names in each review line the command that goes on from the result of that target', async () => {
    const { ws, env } = await setup();
    vi.mocked(lastReviewResults).mockResolvedValue(new Map([['UICore', 'fixed'], ['LogCore', 'fix'], ['data-tool', 'blocked'], ['contract-tool', 'running'], ['routing', 'done']]));
    const item = { id: 'M1', severity: 'high', location: 'a.ts:1', problem: 'p', foundBy: 'x' };
    writeFiles(ws.coreImpl, {
      'records/review-must-fix/routing.json': { target: 'routing', nextId: 2, items: [item] },
      'records/review-must-fix/spec-UICore.json': { target: 'spec UICore', nextId: 2, items: [item] },
    });
    commitAll(ws.coreImpl, 'lists');
    await recordAllPass(ws.coreImpl);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env });
    const { violations } = (JSON.parse(run.stdout) as { data: { violations: string[] } }).data;
    // a review that ended (done, fixed) is no violation
    expect(violations.filter((v) => v.startsWith('review UICore'))).toEqual([]);
    expect(violations).toEqual(expect.arrayContaining([
      'review LogCore: last round result is fix; run ogw review run core LogCore',
      'review data-tool: last round result is blocked; run ogw review run core data-tool --respec',
      'review contract-tool: last round result is running; run ogw review run core contract-tool',
      'review must fix routing: M1 high a.ts:1: p; fix it, then run ogw review run core routing',
      'review must fix spec UICore: M1 high a.ts:1: p; fix it, then run ogw review spec core UICore --since <harness commit before the fix>',
    ]));
  });

  it('lists every violated condition and changes nothing', async () => {
    const { ws, env, gh } = await setup();
    writeFiles(ws.coreImpl, { 'settings/core-settings.json': { 'UICore.fadeMs': 200, 'LogCore.maxLines': 300 }, 'core-spec/notes.md': 'x', 'server/core/routing/routing.ts': 'export const x = 1;\n' });
    sh(ws.coreImpl, 'rm', ['-r', 'client/godot/plugins/ogw-secure-storage/dist/linux']);
    commitAll(ws.coreImpl, 'change');
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { UICore: 'pass', LogCore: 'skipped' }, recordedAt: Date.now() });
    const modules = specFiles(ws.coreImpl);
    modules.set('UICore', { changed: true });
    modules.set('NewCore', {});
    modules.delete('routing');
    vi.mocked(buildCoreSpec).mockResolvedValue({ modules, settingTypes: new Map(), gameSettings: new Map(), errors: ['skills/x.md:3: bad dependency line'] });
    vi.mocked(lastReviewResults).mockResolvedValue(new Map([['UICore', 'done'], ['LogCore', 'fix'], ['data-tool', null], ['contract-tool', 'running']]));
    vi.mocked(runCodeCheck).mockResolvedValue([{ name: 'lint', result: 'fail', failures: ['a.gd:1 x', 'b.gd:2 y'] }, { name: 'secret', result: 'fail', failures: [] }]);
    vi.mocked(baseProtoBreaks).mockResolvedValue(['CoreError.X removed']);
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env });
    expect(run.code).toBe(1);
    const { data } = JSON.parse(run.stdout) as { data: { violations: string[] } };
    expect(data.violations).toEqual([
      `core test server: routing is unknown at ${before}: not recorded; rerun: ogw core test server routing`,
      `core test godot: LogCore is unknown at ${before}: not checked; rerun: ogw core test godot LogCore`,
      `core test godot --web: LogCore is unknown at ${before}: not recorded; rerun: ogw core test godot LogCore --web`,
      `core test godot --web: UICore is unknown at ${before}: not recorded; rerun: ogw core test godot UICore --web`,
      `core test tools: contract-tool is unknown at ${before}: not recorded; rerun: ogw core test tools contract-tool`,
      `core test tools: data-tool is unknown at ${before}: not recorded; rerun: ogw core test tools data-tool`,
      'core spec: skills/x.md:3: bad dependency line',
      'core-spec/UICore.json differs from ogw core spec',
      'core-spec/NewCore.json is missing',
      'core-spec/notes.md is not a module',
      'core-spec/routing.json is not a module',
      'review LogCore: last round result is fix; run ogw review run core LogCore',
      'review data-tool: last round result is none; run ogw review run core data-tool',
      'review contract-tool: last round result is running; run ogw review run core contract-tool',
      'review routing: changed since v1.1.0 and has no review state; run ogw review run core routing --since v1.1.0',
      'ogw code check core: lint fail\n  a.gd:1 x\n  b.gd:2 y',
      'ogw code check core: secret fail',
      'settings constraint UICore.fadeMs × 2 ≤ LogCore.maxLines: 200 × 2 > 300',
      'plugin ogw-secure-storage of godot: no build result in client/godot/plugins/ogw-secure-storage/dist/linux/',
      'base proto breaks backward compatibility with 1.1.0 but the major version is not higher:\n  CoreError.X removed',
    ]);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
    expect(gh.created()).toEqual({});
    expect(clearReviews).not.toHaveBeenCalled();

    vi.mocked(buildCoreSpec).mockResolvedValue({ modules: specFiles(ws.coreImpl), settingTypes: new Map(), gameSettings: new Map(), errors: [] });
    const major = await ogw(ws, ['core', 'release', '2.0.0', '--notes', NOTES, '--json'], { env });
    expect((JSON.parse(major.stdout) as { data: { violations: string[] } }).data.violations.some((v) => v.startsWith('base proto'))).toBe(false);
  });

  it('refuses a must-fix item, and releases with items in the debt lists', async () => {
    const { ws, env } = await setup();
    const item = (id: string) => ({ id, location: 'server/core/routing/a.ts:3', problem: 'p', foundBy: 'routing round 1' });
    writeFiles(ws.coreImpl, {
      'records/review-debt/routing.json': { target: 'routing', nextId: 4, items: [item('D1'), item('D3')] },
      'records/review-debt/spec-UICore.json': { target: 'spec UICore', nextId: 2, items: [item('D1')] },
      'records/review-debt/LogCore.json': { target: 'LogCore', nextId: 2, items: [] },
      'records/review-must-fix/routing.json': { target: 'routing', nextId: 2, items: [{ ...item('M1'), severity: 'high' }] },
    });
    commitAll(ws.coreImpl, 'lists');
    await recordAllPass(ws.coreImpl);
    const refused = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env });
    expect(refused.code).toBe(1);
    expect((JSON.parse(refused.stdout) as { data: { violations: string[] } }).data.violations).toEqual(['review must fix routing: M1 high server/core/routing/a.ts:3: p; fix it, then run ogw review run core routing --since <main commit before the fix>']);
    writeFiles(ws.coreImpl, { 'records/review-must-fix/routing.json': { target: 'routing', nextId: 2, items: [] } });
    commitAll(ws.coreImpl, 'fixed');
    await recordAllPass(ws.coreImpl);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const harnessHead = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect(run.stdout).toBe(`released 1.2.0: tag v1.2.0 at ${head}\nharness tag core-v1.2.0 at ${harnessHead}\n`);
  });

  it('refuses a review target of the changes since the release below without review state, and a missing tag of that release', async () => {
    const { ws, env } = await setup();
    // the module class of LogCore is its public face: UICore, which depends on it, is a review target too
    writeFiles(ws.coreImpl, { 'client/godot/core/log_core/log_core.gd': 'class_name LogCore\nvar x = 1\n', 'tools/data-tool/src/a.ts': 'export {};\n' });
    commitAll(ws.coreImpl, 'change');
    await recordAllPass(ws.coreImpl);
    const violations = async (): Promise<string[]> => (JSON.parse((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env })).stdout) as { data: { violations: string[] } }).data.violations;
    expect(await violations()).toEqual([
      'review LogCore: changed since v1.1.0 and has no review state; run ogw review run core LogCore --since v1.1.0',
      'review data-tool: changed since v1.1.0 and has no review state; run ogw review run core data-tool --since v1.1.0',
    ]);
    vi.mocked(lastReviewResults).mockResolvedValue(new Map([['UICore', 'done'], ['LogCore', 'done'], ['data-tool', 'done']]));
    sh(ws.coreImpl, 'git', ['tag', '--delete', 'v1.1.0']);
    expect(await violations()).toEqual(['review targets since v1.1.0: tag v1.1.0 is not in open-game-works-core-impl/; fetch it, then run ogw review run core <target> --since v1.1.0 for each target of ogw core review-targets --since v1.1.0']);
    sh(ws.coreImpl, 'git', ['tag', 'v1.1.0', 'HEAD~1']);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).code).toBe(0);
  });

  it('refuses a release without a notes file, with a missing one or with an empty one, before it checks anything', async () => {
    const { ws, env, gh } = await setup();
    const empty = join(ws.root, 'empty.md');
    writeFileSync(empty, ' \n');
    expect((await ogw(ws, ['core', 'release', '1.2.0'], { env })).stderr).toContain('--notes <file> is required: the release notes of the GitHub release');
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', join(ws.root, 'none.md')], { env })).stderr).toContain('cannot read the release notes file');
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', empty], { env })).stderr).toContain(`the release notes file ${empty} is empty`);
    expect(gh.calls()).toEqual([]);
    expect(sh(ws.coreImpl, 'git', ['tag']).trim()).toBe('v1.1.0');
  });

  it('refuses a release while the harness has uncommitted spec changes or already has the harness tag', async () => {
    const { ws, env, gh } = await setup();
    writeFileSync(join(ws.harness, 'skills', 'core', 'SKILL.md'), `${readFileSync(join(ws.harness, 'skills', 'core', 'SKILL.md'), 'utf8')}\nchanged\n`);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).stderr).toContain('the harness has uncommitted spec changes');
    sh(ws.harness, 'git', ['checkout', '--quiet', '--', 'skills']);
    sh(ws.harness, 'git', ['tag', 'core-v1.2.0']);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).stderr).toContain('tag core-v1.2.0 already exists in the harness');
    expect(gh.calls().filter((c) => c[1] === 'create')).toEqual([]);
  });

  it('refuses a dirty checkout, another branch, an existing tag or release', async () => {
    const { ws, env } = await setup();
    expect((await ogw(ws, ['core', 'release', '1.x', '--notes', NOTES], { env })).stderr).toContain('invalid core version: 1.x');
    writeFileSync(join(ws.coreImpl, 'dirty.txt'), '');
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).stderr).toContain('open-game-works-core-impl/ has uncommitted changes:\n?? dirty.txt');
    sh(ws.coreImpl, 'rm', ['dirty.txt']);
    sh(ws.coreImpl, 'git', ['checkout', '--quiet', '-b', 'agent/x']);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).stderr).toContain('must have main checked out to release (now agent/x)');
    sh(ws.coreImpl, 'git', ['checkout', '--quiet', 'main']);
    sh(ws.coreImpl, 'git', ['tag', 'v1.2.0']);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).stderr).toContain('tag v1.2.0 already exists in open-game-works-core-impl/');
    // a release that this checkout has no tag of
    sh(ws.coreImpl, 'git', ['tag', '--delete', 'v1.1.0']);
    expect((await ogw(ws, ['core', 'release', '1.1.0', '--notes', NOTES], { env })).stderr).toContain('release v1.1.0 already exists in wnsrn3436/open-game-works-core-impl');
  });

  it('pushes main of open-game-works-core-impl/ to the core release repository whose main is behind it', async () => {
    const { ws, env } = await setup();
    // main here has a commit that the core release repository does not have yet
    sh(ws.coreImpl, 'git', ['push', '--quiet', remotePath(ws), 'HEAD~1:refs/heads/main']);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(sh(remotePath(ws), 'git', ['rev-parse', 'main', 'v1.2.0^{commit}']).trim().split('\n')).toEqual([head, head]);
  });

  it('refuses, before anything else, a core release repository whose main has commits that main here does not contain', async () => {
    for (const remoteKnown of [false, true]) {
      const { ws, env, gh } = await setup();
      const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      let theirs: string;
      if (remoteKnown) {
        // a commit this checkout has, on another branch: main here does not contain it
        sh(ws.coreImpl, 'git', ['checkout', '--quiet', '-b', 'side', 'HEAD~1']);
        writeFiles(ws.coreImpl, { 'side.txt': 'side' });
        commitAll(ws.coreImpl, 'side');
        theirs = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
        sh(ws.coreImpl, 'git', ['push', '--quiet', remotePath(ws), 'side:refs/heads/main']);
        sh(ws.coreImpl, 'git', ['checkout', '--quiet', 'main']);
      } else {
        sh(ws.coreImpl, 'git', ['push', '--quiet', remotePath(ws), 'HEAD:refs/heads/main']);
        theirs = commitOnRemoteMain(ws, 'elsewhere');
      }
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
      expect(run.code).toBe(1);
      const remote = 'https://github.com/wnsrn3436/open-game-works-core-impl.git';
      expect(run.stderr).toContain(`main of ${remote} is at ${theirs}, which main of open-game-works-core-impl/ (${before}) does not contain: ${remote} has commits that are not on main here`);
      // nothing checked, built, committed, tagged, pushed or released
      expect(runCodeCheck).not.toHaveBeenCalled();
      expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
      expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(theirs);
      expect(sh(remotePath(ws), 'git', ['tag'])).toBe('');
      expect(gh.created()).toEqual({});
      vi.mocked(runCodeCheck).mockClear();
    }
  });

  it('pushes main and the tag in one atomic push: neither when main of the core release repository moved during the release', async () => {
    const { ws, env, gh } = await setup();
    sh(ws.coreImpl, 'git', ['push', '--quiet', remotePath(ws), 'HEAD:refs/heads/main']);
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const hook = globalThis as { onStageTool?: () => void };
    let theirs = '';
    hook.onStageTool = () => {
      hook.onStageTool = undefined;
      // after the check of main of the core release repository, a push from elsewhere
      theirs = commitOnRemoteMain(ws, 'meanwhile');
    };
    try {
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('push');
      expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(theirs);
      expect(sh(remotePath(ws), 'git', ['tag'])).toBe('');
      expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
      expect(gh.created()).toEqual({});
    } finally {
      hook.onStageTool = undefined;
    }
  });

  it('runs the code check on open-game-works-core-impl/ also from inside a core worktree', async () => {
    const { ws, env } = await setup();
    const worktree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '-b', 'w1', worktree]);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env, cwd: worktree })).code).toBe(0);
    expect(runCodeCheck).toHaveBeenCalledWith(expect.anything(), 'core', ws.coreImpl);
    expect(releaseBrowserRuns).toHaveBeenCalledWith(expect.anything(), ws.coreImpl);
  });

  it('reads main HEAD again after its browser runs, which may commit generated files and record on that commit', async () => {
    const { ws, env } = await setup();
    vi.mocked(releaseBrowserRuns).mockImplementation(async () => {
      writeFiles(ws.coreImpl, { 'generated.txt': 'written by the browser run' });
      commitAll(ws.coreImpl, 'generated');
      await recordAllPass(ws.coreImpl);
      return [];
    });
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(sh(ws.coreImpl, 'git', ['log', '-2', '--format=%s']).trim().split('\n')).toEqual(['core release 1.2.0: plugin URLs and SHA-256', 'generated']);
  });

  it('fails without a commit, tag or reset when main moves while the release runs', async () => {
    const { ws, env, gh } = await setup();
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(runCodeCheck).mockImplementation(() => {
      writeFiles(ws.coreImpl, { 'merged.txt': 'from an agent merge' });
      commitAll(ws.coreImpl, 'merge');
      return Promise.resolve([{ name: 'type check', result: 'pass', failures: [] }]);
    });
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.code).toBe(1);
    const moved = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(run.stderr).toContain(`open-game-works-core-impl/ main moved from ${before} to ${moved} during the release`);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s']).trim()).toBe('merge');
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
    expect(gh.created()).toEqual({});
  });

  it('reports a core-spec file that is not a module as a condition and still checks the others', async () => {
    const { ws, env } = await setup();
    writeFiles(ws.coreImpl, { 'core-spec/Old.json': '{"name":"Old"}', 'settings/core-settings.json': '{}' });
    commitAll(ws.coreImpl, 'stale');
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('core-spec/Old.json is not a module');
    expect(run.stderr).toContain(': not recorded; rerun: ogw core test');
    expect(run.stderr).not.toContain('not a core-spec module object');
  });

  it('fails without a commit, tag or release when main moves while the assets are built', async () => {
    const { ws, env, gh } = await setup();
    const hook = globalThis as { onStageTool?: () => void };
    hook.onStageTool = () => {
      hook.onStageTool = undefined;
      writeFiles(ws.coreImpl, { 'merged.txt': 'from an agent merge' });
      commitAll(ws.coreImpl, 'merge');
    };
    try {
      const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
      expect(run.code).toBe(1);
      const moved = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      expect(run.stderr).toContain(`open-game-works-core-impl/ main moved from ${before} to ${moved} during the release`);
      expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s']).trim()).toBe('merge');
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
      expect(gh.created()).toEqual({});
    } finally {
      hook.onStageTool = undefined;
    }
  });

  it('holds the main checkout lock from the last check of main to the release', async () => {
    const { ws, env } = await setup();
    const hook = globalThis as { onCreateRelease?: () => Promise<void> };
    let held: boolean | null = null;
    hook.onCreateRelease = async () => {
      hook.onCreateRelease = undefined;
      // a main writer (an agent merge, a debt list commit) gets the lock only after the release
      const lock = { base: await checkoutLock(ws.coreImpl, 'ogw-core-main.lock'), waitMs: 300 };
      held = await withWriterLock(lock, () => Promise.resolve(false)).catch(() => true);
    };
    try {
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
      expect(run.code).toBe(0);
      expect(held).toBe(true);
    } finally {
      hook.onCreateRelease = undefined;
    }
  });

  it('undoes the tag and the commit when the GitHub release fails', async () => {
    const { ws, env } = await setup();
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env: { ...env, FAKE_GH_FAIL: 'create' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('gh release create v1.2.0');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
    expect(existsSync(join(ws.coreImpl, 'client/godot/engine.json'))).toBe(true);
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toContain('"url": ""');
    expect(clearReviews).not.toHaveBeenCalled();
    const remote = remotePath(ws);
    expect(sh(remote, 'git', ['tag'])).toBe('');
    // main of the core release repository is set back with the tag: main here no longer has the release commit
    expect(sh(remote, 'git', ['rev-parse', 'main']).trim()).toBe(before);
    // The same version can be released again: no tag is left on the remote.
    const again = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(sh(remote, 'git', ['tag']).trim()).toBe('v1.2.0');
    expect(sh(remote, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
  });

  it('sets main of the core release repository back only while it is the release commit: a commit pushed there meanwhile stays', async () => {
    const { ws, env } = await setup();
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const hook = globalThis as { onCreateRelease?: () => Promise<void> };
    let theirs = '';
    // after the atomic push of the release commit and the tag, a push from elsewhere onto main
    hook.onCreateRelease = () => {
      hook.onCreateRelease = undefined;
      theirs = commitOnRemoteMain(ws, 'meanwhile');
      return Promise.resolve();
    };
    try {
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env: { ...env, FAKE_GH_FAIL: 'create' } });
      expect(run.code).toBe(1);
      const remote = 'https://github.com/wnsrn3436/open-game-works-core-impl.git';
      expect(run.stderr).toContain(`could not delete the pushed tag v1.2.0 and set main back to ${before} in ${remote}: `);
      expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(theirs);
      // one atomic push: the tag stays with main
      expect(sh(remotePath(ws), 'git', ['tag']).trim()).toBe('v1.2.0');
      expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
    } finally {
      hook.onCreateRelease = undefined;
    }
  });

  it('does not set main of the core release repository back when the release made no commit', async () => {
    const { ws, env } = await setup();
    // no `ogw-` plugin: the release writes no engine.json and makes no commit
    const engineJson = readJsonFile(join(ws.coreImpl, 'client/godot/engine.json')) as Record<string, unknown>;
    writeFiles(ws.coreImpl, { 'client/godot/engine.json': { ...engineJson, plugins: [] } });
    commitAll(ws.coreImpl, 'no plugin');
    const before = await recordAllPass(ws.coreImpl);
    const hook = globalThis as { onCreateRelease?: () => Promise<void> };
    let theirs = '';
    hook.onCreateRelease = () => {
      hook.onCreateRelease = undefined;
      expect(sh(remotePath(ws), 'git', ['rev-parse', 'main', 'v1.2.0^{commit}']).trim().split('\n')).toEqual([before, before]);
      theirs = commitOnRemoteMain(ws, 'meanwhile');
      return Promise.resolve();
    };
    try {
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env: { ...env, FAKE_GH_FAIL: 'create' } });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('gh release create v1.2.0');
      expect(run.stderr).not.toContain('could not');
      // the tag is gone, and main keeps the commit pushed there meanwhile
      expect(sh(remotePath(ws), 'git', ['tag'])).toBe('');
      expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(theirs);
      expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('v1.1.0\n');
    } finally {
      hook.onCreateRelease = undefined;
    }
  });

  it('keeps the tag and the commit when gh fails after it made the release', async () => {
    const { ws, env, gh } = await setup();
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env: { ...env, FAKE_GH_CREATE_THEN_FAIL: '1' } });
    expect(run.code).toBe(1);
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(head).not.toBe(before);
    expect(run.stderr).toContain(`release v1.2.0 exists in wnsrn3436/open-game-works-core-impl; kept tag v1.2.0 (pushed) and commit ${head}`);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(head);
    expect(sh(remotePath(ws), 'git', ['tag']).trim()).toBe('v1.2.0');
    expect(sh(remotePath(ws), 'git', ['rev-parse', 'main']).trim()).toBe(head);
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toContain('releases/download/v1.2.0/client-godot-plugins.zip');
    expect(Object.keys(gh.created())).toEqual(['v1.2.0']);
  });

  it('keeps the tag and the commit when gh fails after create and cannot tell whether the release exists, with the reason', async () => {
    const { ws, env } = await setup();
    const hook = globalThis as { onCreateRelease?: () => Promise<void>; releaseExistsFails?: string };
    // the release view before the release answers; the one after the failed create cannot
    hook.onCreateRelease = () => {
      hook.onCreateRelease = undefined;
      hook.releaseExistsFails = 'gh release view v1.2.0 timed out';
      return Promise.resolve();
    };
    try {
      const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env: { ...env, FAKE_GH_CREATE_THEN_FAIL: '1' } });
      expect(run.code).toBe(1);
      const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
      expect(run.stderr).toContain(`could not tell whether release v1.2.0 exists in wnsrn3436/open-game-works-core-impl (gh release view v1.2.0 timed out); kept tag v1.2.0 (pushed) and commit ${head}`);
      expect(sh(ws.coreImpl, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(head);
    } finally {
      hook.onCreateRelease = undefined;
      hook.releaseExistsFails = undefined;
    }
  });

  it('compares the base proto with the highest release below the version', async () => {
    const { ws, env: base } = await setup();
    const gh = fakeGh(ws, {
      'v3.0.0': makeReleaseDir(join(ws.root, 'r300'), '3.0.0', { 'a.json': '3' }),
      'v1.0.0': makeReleaseDir(join(ws.root, 'r100'), '1.0.0', { 'a.json': '0' }),
      'v1.1.0': makeReleaseDir(join(ws.root, 'r110'), '1.1.0', { 'a.json': '1' }),
    });
    const env = { ...base, ...gh.env };
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env })).code).toBe(0);
    expect(baseProtoBreaks).toHaveBeenCalledTimes(1);
    expect(baseProtoBreaks).toHaveBeenCalledWith(expect.anything(), ws.coreImpl, '1.1.0');
  });

  it('refuses a release whose benchmark game data does not pass the data tool binary build', async () => {
    const { ws, env } = await setup();
    vi.mocked(benchmarkDataViolations).mockResolvedValue(['benchmark godot: the data tool binary build failed (1)\n  the data is not matched']);
    const run = await ogw(ws, ['core', 'release', '0.1.0', '--notes', NOTES], { env });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('benchmark godot: the data tool binary build failed (1)');
    expect(benchmarkDataViolations).toHaveBeenCalledWith(expect.anything(), ws.coreImpl);
  });

  it('skips the base proto comparison when no release is below the version', async () => {
    const { ws, env } = await setup();
    expect((await ogw(ws, ['core', 'release', '0.1.0', '--notes', NOTES], { env })).code).toBe(0);
    expect(baseProtoBreaks).not.toHaveBeenCalled();
  });
});

describe('release condition parts', () => {
  it('takes a base proto break with a higher major, or, while the major is 0, a higher minor', async () => {
    vi.mocked(baseProtoBreaks).mockResolvedValue(['CoreError.X removed']);
    const violations = (lower: string, version: string): Promise<string[]> => baseProtoViolations({} as Context, '/impl', version, [lower]);
    expect(await violations('0.9.0', '0.10.0')).toEqual([]);
    expect(await violations('0.9.0', '0.9.1')).toEqual(['base proto breaks backward compatibility with 0.9.0 but the minor version is not higher (major 0):\n  CoreError.X removed']);
    expect(await violations('0.10.0', '1.0.0')).toEqual([]);
    expect(await violations('1.2.0', '1.3.0')).toEqual(['base proto breaks backward compatibility with 1.2.0 but the major version is not higher:\n  CoreError.X removed']);
    expect(await violations('1.2.0', '2.0.0')).toEqual([]);
    // the highest lower release is the one compared with
    expect(await baseProtoViolations({} as Context, '/impl', '0.10.0', ['0.8.0', '0.10.0', '0.9.0', '0.11.0'])).toEqual([]);
    expect(vi.mocked(baseProtoBreaks).mock.calls.at(-1)?.[2]).toBe('0.9.0');
    // no break: any higher version
    vi.mocked(baseProtoBreaks).mockResolvedValue([]);
    expect(await violations('1.2.0', '1.2.1')).toEqual([]);
  });

  it('reads a core-spec file that is not JSON as differing from ogw core spec, and fails on one that cannot be read', async () => {
    const impl = mkdtempSync(join(tmpdir(), 'ogw-core-spec-'));
    writeFiles(impl, { 'core-spec/A.json': 'not json' });
    vi.mocked(buildCoreSpec).mockResolvedValue({ modules: new Map([['A', {}]]), settingTypes: new Map(), gameSettings: new Map(), errors: [] });
    expect(await coreSpecViolations({} as Context, impl)).toEqual(['core-spec/A.json differs from ogw core spec']);
    mkdirSync(join(impl, 'core-spec', 'B.json'));
    vi.mocked(buildCoreSpec).mockResolvedValue({ modules: new Map([['A', {}], ['B', {}]]), settingTypes: new Map(), gameSettings: new Map(), errors: [] });
    await expect(coreSpecViolations({} as Context, impl)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('requires only the targets that have an implementation', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const modules = await readCoreSpecDir(ws.coreImpl);
    const all = await requiredTargets(ws.coreImpl, modules);
    expect(Object.fromEntries(all)).toEqual({
      server: ['routing'], godot: ['LogCore', 'UICore'], 'godot --web': ['LogCore', 'UICore'], tools: ['contract-tool', 'data-tool'],
    });
    sh(ws.coreImpl, 'rm', ['-r', 'server', 'client', 'tools/data-tool']);
    expect(Object.fromEntries(await requiredTargets(ws.coreImpl, modules))).toEqual({ tools: ['contract-tool'] });
    sh(ws.coreImpl, 'rm', ['-r', 'tools']);
    expect(Object.fromEntries(await requiredTargets(ws.coreImpl, modules))).toEqual({});
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual([]);
  });

  it('refuses a module whose result is unknown, with its reason and the command to run again', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const modules = await readCoreSpecDir(ws.coreImpl);
    const pass = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'pass' as const]));
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'server', modules: pass(['routing']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'tools', modules: { 'contract-tool': 'pass', 'data-tool': 'unknown' }, reasons: { 'data-tool': 'godot round trip left out: x' }, recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { LogCore: 'pass', UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 1 });
    // a record an earlier tool wrote: `skipped` with the reason of a locked screen, or another one
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot --web', modules: { LogCore: 'skipped', UICore: 'pass' }, skips: { LogCore: 'other' }, recordedAt: 1 });
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual([
      'core test godot: UICore is unknown at c1: screen locked; rerun with the screen unlocked: ogw core test godot UICore',
      'core test godot --web: LogCore is unknown at c1: other; rerun: ogw core test godot LogCore --web',
      'core test tools: data-tool is unknown at c1: godot round trip left out: x; rerun: ogw core test tools data-tool',
    ]);
    await addTestRecord(ws.coreImpl, { commit: 'c2', target: 'server', modules: pass(['routing']), recordedAt: 2 });
    await addTestRecord(ws.coreImpl, { commit: 'c2', target: 'tools', modules: pass(['contract-tool', 'data-tool']), recordedAt: 2 });
    await addTestRecord(ws.coreImpl, { commit: 'c2', target: 'godot --web', modules: pass(['LogCore', 'UICore']), recordedAt: 2 });
    await addTestRecord(ws.coreImpl, { commit: 'c2', target: 'godot', modules: { LogCore: 'pass', UICore: 'skipped' }, skips: { UICore: 'render pass not run: the macOS screen is locked or the display sleeps' }, recordedAt: 2 });
    expect(await testRecordViolations(ws.coreImpl, 'c2', modules)).toEqual(['core test godot: UICore is unknown at c2: screen locked; rerun with the screen unlocked: ogw core test godot UICore']);
    expect(coreTestCommand('godot --web', 'UICore')).toBe('ogw core test godot UICore --web');
  });

  it('keeps an earlier fail or pass of a module over a later unknown, and lets a later pass replace a fail', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const modules = await readCoreSpecDir(ws.coreImpl);
    const pass = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'pass' as const]));
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'server', modules: pass(['routing']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'tools', modules: pass(['contract-tool', 'data-tool']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot --web', modules: pass(['LogCore', 'UICore']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { LogCore: 'pass', UICore: 'fail' }, recordedAt: 2 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 3 });
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual(['core test godot: UICore is fail at c1']);
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { UICore: 'pass' }, recordedAt: 4 });
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual([]);
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { UICore: 'unknown' }, reasons: { UICore: SCREEN_LOCKED }, recordedAt: 5 });
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual([]);
  });

  it('checks only settings constraints between modules of a side with an implementation', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const base = await readCoreSpecDir(ws.coreImpl);
    const constraint = (left: string, right: string) => ({ left, factor: 1, right });
    const modules = base.map((m) =>
      m.name === 'routing'
        ? { ...m, settingsConstraints: [constraint('routing.a', 'routing.b'), constraint('LogCore.x', 'routing.b')] }
        : m.name === 'LogCore'
          ? { ...m, settingsConstraints: [constraint('LogCore.x', 'LogCore.y'), constraint('unknown.k', 'LogCore.y')] }
          : { ...m, settingsConstraints: [] },
    );
    expect(await implementedConstraints(ws.coreImpl, modules)).toHaveLength(4);
    sh(ws.coreImpl, 'rm', ['-r', 'client']);
    expect(await implementedConstraints(ws.coreImpl, modules)).toEqual([constraint('routing.a', 'routing.b')]);
    sh(ws.coreImpl, 'rm', ['-r', 'server']);
    expect(await implementedConstraints(ws.coreImpl, modules)).toEqual([]);
  });

  it('evaluates settings constraints', () => {
    expect(constraintViolations({ a: 2, b: 4 }, [{ left: 'a', factor: 2, right: 'b' }])).toEqual([]);
    expect(constraintViolations({ a: 3, b: 4 }, [{ left: 'a', factor: 2, right: 'b' }])).toEqual(['settings constraint a × 2 ≤ b: 3 × 2 > 4']);
    expect(constraintViolations(null, [{ left: 'a', factor: 1, right: 'b' }])).toEqual(['settings constraint a × 1 ≤ b: a value is missing or not a number']);
    expect(constraintViolations({ a: '1', b: 2 }, [{ left: 'a', factor: 1, right: 'b' }])).toHaveLength(1);
  });

  it('blocks the release when a later record of the same commit and target fails a module that passed before', async () => {
    const ws = makeWorkspace();
    const commit = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { a: 'pass' }, recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { a: 'fail' }, recordedAt: 2 });
    expect(Object.fromEntries((await mergedResults(ws.coreImpl, commit)).get('server') ?? [])).toEqual({ a: 'fail' });
    // a later unknown keeps the fail: it is no run of the whole module
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { a: 'unknown' }, reasons: { a: 'not recorded' }, recordedAt: 3 });
    expect(Object.fromEntries((await mergedResults(ws.coreImpl, commit)).get('server') ?? [])).toEqual({ a: 'fail' });
  });

  it('merges records of a commit, later ones winning', async () => {
    const ws = makeWorkspace();
    const commit = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { a: 'pass', b: 'fail' }, recordedAt: 2 });
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { b: 'pass' }, recordedAt: 3 });
    await addTestRecord(ws.coreImpl, { commit, target: 'server', modules: { a: 'fail' }, recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'other', target: 'server', modules: { c: 'pass' }, recordedAt: 4 });
    const merged = await mergedResults(ws.coreImpl, commit);
    expect(Object.fromEntries(merged.get('server') ?? [])).toEqual({ a: 'pass', b: 'pass' });
    expect([...merged.keys()]).toEqual(['server']);
  });
});
