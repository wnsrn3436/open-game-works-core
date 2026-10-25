import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodeCheck } from '../../../src/commands/code/api.ts';
import { readCoreSpecDir } from '../../../src/commands/core/lib/impl.ts';
import { constraintViolations, implementedConstraints, requiredTargets, testRecordViolations, untestedRenderPasses } from '../../../src/commands/core/lib/release-conditions.ts';
import { addTestRecord, mergedResults, SCREEN_LOCKED_SKIP } from '../../../src/commands/core/lib/test-records.ts';
import { baseProtoBreaks } from '../../../src/commands/core/lib/base-proto-compat.ts';
import { buildCoreSpec } from '../../../src/commands/core/spec-api.ts';
import { clearReviews, lastReviewResults } from '../../../src/commands/review/api.ts';
import { checkoutLock } from '../../../src/lib/git.ts';
import { withWriterLock } from '../../../src/lib/rwlock.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeGh, makeReleaseDir, readJsonFile, writeFiles } from './helpers.ts';
import { writeImpl } from './impl-fixture.ts';

vi.mock('../../../src/commands/core/spec-api.ts', () => ({ buildCoreSpec: vi.fn(), writeCoreSpec: vi.fn() }));
vi.mock('../../../src/commands/code/api.ts', () => ({ runCodeCheck: vi.fn() }));
vi.mock('../../../src/commands/review/api.ts', () => ({ lastReviewResults: vi.fn(), clearReviews: vi.fn(() => Promise.resolve([] as string[])) }));
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
  };
});
vi.mock('../../../src/commands/core/lib/base-proto-compat.ts', () => ({ baseProtoBreaks: vi.fn(() => Promise.resolve([])) }));

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

/** A bare repo that `https://github.com/<repo>.git` pushes go to. */
function remoteEnv(ws: TestWorkspace): NodeJS.ProcessEnv {
  const remotes = join(ws.root, 'remotes');
  sh(ws.root, 'git', ['init', '--quiet', '--bare', join(remotes, 'wnsrn3436', 'open-game-works-core-impl.git')]);
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
}

async function setup(): Promise<{ ws: TestWorkspace; env: NodeJS.ProcessEnv; gh: ReturnType<typeof fakeGh> }> {
  const ws = makeWorkspace();
  writeImpl(ws.coreImpl);
  await recordAllPass(ws.coreImpl);
  const gh = fakeGh(ws, { 'v1.1.0': makeReleaseDir(join(ws.root, 'r110'), '1.1.0', { 'a.json': '1' }) });
  vi.mocked(buildCoreSpec).mockResolvedValue({ modules: specFiles(ws.coreImpl), settingTypes: new Map(), errors: [] });
  return { ws, gh, env: { ...gh.env, ...remoteEnv(ws) } };
}

beforeEach(() => {
  vi.mocked(runCodeCheck).mockReset().mockResolvedValue([{ name: 'type check', result: 'pass', failures: [] }]);
  vi.mocked(lastReviewResults).mockReset().mockResolvedValue(new Map([['UICore', 'done']]));
  vi.mocked(clearReviews).mockClear();
  vi.mocked(baseProtoBreaks).mockReset().mockResolvedValue([]);
});

describe('ogw core release', () => {
  it('releases when every condition holds', async () => {
    const { ws, env, gh } = await setup();
    // what the clear of the core reviews could not remove is in the output
    vi.mocked(clearReviews).mockResolvedValueOnce(['/w/_core/agent-x', 'agent/x']);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(run.stdout).toBe(`released 1.2.0: tag v1.2.0 at ${head}\nnot removed: /w/_core/agent-x\nnot removed: agent/x\n`);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s']).trim()).toBe('core release 1.2.0: plugin URLs and SHA-256');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(head);
    const engine = readJsonFile(join(ws.coreImpl, 'client/godot/engine.json')) as { plugins: { url: string; sha256: string }[] };
    expect(engine.plugins[0]?.url).toBe('https://github.com/wnsrn3436/open-game-works-core-impl/releases/download/v1.2.0/client-godot-plugins.zip');
    expect(engine.plugins[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sh(join(ws.root, 'remotes', 'wnsrn3436', 'open-game-works-core-impl.git'), 'git', ['tag']).trim()).toBe('v1.2.0');
    expect(gh.created()['v1.2.0']?.sort()).toEqual([
      'benchmark-godot.zip', 'client-godot-plugins.zip', 'client-godot.zip', 'contract-tool.tgz', 'core-settings-constraints.json', 'core-settings.json',
      'core-settings.schema.json', 'core-spec.json', 'data-tool.tgz', 'licenses.json', 'manifest.json', 'server.tgz',
    ]);
    const create = gh.calls().find((c) => c[1] === 'create') ?? [];
    expect(create.slice(-7)).toEqual(['--repo', 'wnsrn3436/open-game-works-core-impl', '--verify-tag', '--title', 'v1.2.0', '--notes', NOTES_TEXT]);
    expect(gh.notes()['v1.2.0']).toBe(NOTES_TEXT);
    expect(clearReviews).toHaveBeenCalledWith(expect.anything(), 'core');
    expect(runCodeCheck).toHaveBeenCalledWith(expect.anything(), 'core', ws.coreImpl);
    expect(baseProtoBreaks).toHaveBeenCalledWith(expect.anything(), ws.coreImpl, '1.1.0');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('lists every violated condition and changes nothing', async () => {
    const { ws, env, gh } = await setup();
    writeFiles(ws.coreImpl, { 'settings/core-settings.json': { 'UICore.fadeMs': 200, 'LogCore.maxLines': 300 }, 'core-spec/notes.md': 'x' });
    sh(ws.coreImpl, 'rm', ['-r', 'client/godot/plugins/ogw-secure-storage/dist/linux']);
    commitAll(ws.coreImpl, 'change');
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { UICore: 'pass', LogCore: 'skipped' }, recordedAt: Date.now() });
    const modules = specFiles(ws.coreImpl);
    modules.set('UICore', { changed: true });
    modules.set('NewCore', {});
    modules.delete('routing');
    vi.mocked(buildCoreSpec).mockResolvedValue({ modules, settingTypes: new Map(), errors: ['skills/x.md:3: bad dependency line'] });
    vi.mocked(lastReviewResults).mockResolvedValue(new Map([['UICore', 'done'], ['LogCore', 'fix'], ['data-tool', null]]));
    vi.mocked(runCodeCheck).mockResolvedValue([{ name: 'lint', result: 'fail', failures: ['a.gd:1 x', 'b.gd:2 y'] }, { name: 'secret', result: 'fail', failures: [] }]);
    vi.mocked(baseProtoBreaks).mockResolvedValue(['CoreError.X removed']);
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES, '--json'], { env });
    expect(run.code).toBe(1);
    const { data } = JSON.parse(run.stdout) as { data: { violations: string[] } };
    expect(data.violations).toEqual([
      `core test server: routing is not recorded at ${before}`,
      `core test godot: LogCore is skipped at ${before}`,
      `core test godot --web: LogCore is not recorded at ${before}`,
      `core test godot --web: UICore is not recorded at ${before}`,
      `core test tools: contract-tool is not recorded at ${before}`,
      `core test tools: data-tool is not recorded at ${before}`,
      'core spec: skills/x.md:3: bad dependency line',
      'core-spec/UICore.json differs from ogw core spec',
      'core-spec/NewCore.json is missing',
      'core-spec/notes.md is not a module',
      'core-spec/routing.json is not a module',
      'review LogCore: last round result is fix',
      'review data-tool: last round result is none',
      'ogw code check core: lint fail\n  a.gd:1 x\n  b.gd:2 y',
      'ogw code check core: secret fail',
      'settings constraint UICore.fadeMs × 2 ≤ LogCore.maxLines: 200 × 2 > 300',
      'plugin ogw-secure-storage of godot: no build result in client/godot/plugins/ogw-secure-storage/dist/linux/',
      'base proto breaks backward compatibility with 1.1.0 but the major version is not higher:\n  CoreError.X removed',
    ]);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('');
    expect(gh.created()).toEqual({});
    expect(clearReviews).not.toHaveBeenCalled();

    vi.mocked(buildCoreSpec).mockResolvedValue({ modules: specFiles(ws.coreImpl), settingTypes: new Map(), errors: [] });
    const major = await ogw(ws, ['core', 'release', '2.0.0', '--notes', NOTES, '--json'], { env });
    expect((JSON.parse(major.stdout) as { data: { violations: string[] } }).data.violations.some((v) => v.startsWith('base proto'))).toBe(false);
  });

  it('refuses a must-fix item, and gives the item count of each debt list without refusing it', async () => {
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
    expect((JSON.parse(refused.stdout) as { data: { violations: string[] } }).data.violations).toEqual(['review must fix routing: M1 high server/core/routing/a.ts:3: p']);
    writeFiles(ws.coreImpl, { 'records/review-must-fix/routing.json': { target: 'routing', nextId: 2, items: [] } });
    commitAll(ws.coreImpl, 'fixed');
    await recordAllPass(ws.coreImpl);
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.stderr).toBe('');
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(run.stdout).toBe(`released 1.2.0: tag v1.2.0 at ${head}\nreview debt routing: 2\nreview debt spec UICore: 1\n`);
  });

  it('refuses a release without a notes file, with a missing one or with an empty one, before it checks anything', async () => {
    const { ws, env, gh } = await setup();
    const empty = join(ws.root, 'empty.md');
    writeFileSync(empty, ' \n');
    expect((await ogw(ws, ['core', 'release', '1.2.0'], { env })).stderr).toContain('--notes <file> is required: the release notes of the GitHub release');
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', join(ws.root, 'none.md')], { env })).stderr).toContain('cannot read the release notes file');
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', empty], { env })).stderr).toContain(`the release notes file ${empty} is empty`);
    expect(gh.calls()).toEqual([]);
    expect(sh(ws.coreImpl, 'git', ['tag']).trim()).toBe('');
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
    expect((await ogw(ws, ['core', 'release', '1.1.0', '--notes', NOTES], { env })).stderr).toContain('release v1.1.0 already exists in wnsrn3436/open-game-works-core-impl');
  });

  it('runs the code check on open-game-works-core-impl/ also from inside a core worktree', async () => {
    const { ws, env } = await setup();
    const worktree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '-b', 'w1', worktree]);
    expect((await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env, cwd: worktree })).code).toBe(0);
    expect(runCodeCheck).toHaveBeenCalledWith(expect.anything(), 'core', ws.coreImpl);
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
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('');
    expect(gh.created()).toEqual({});
  });

  it('reports a core-spec file that is not a module as a condition and still checks the others', async () => {
    const { ws, env } = await setup();
    writeFiles(ws.coreImpl, { 'core-spec/Old.json': '{"name":"Old"}', 'settings/core-settings.json': '{}' });
    commitAll(ws.coreImpl, 'stale');
    const run = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('core-spec/Old.json is not a module');
    expect(run.stderr).toContain('is not recorded at');
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
      expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('');
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
    expect(sh(ws.coreImpl, 'git', ['tag'])).toBe('');
    expect(existsSync(join(ws.coreImpl, 'client/godot/engine.json'))).toBe(true);
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toContain('"url": ""');
    expect(clearReviews).not.toHaveBeenCalled();
    const remote = join(ws.root, 'remotes', 'wnsrn3436', 'open-game-works-core-impl.git');
    expect(sh(remote, 'git', ['tag'])).toBe('');
    // The same version can be released again: no tag is left on the remote.
    const again = await ogw(ws, ['core', 'release', '1.2.0', '--notes', NOTES], { env });
    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(sh(remote, 'git', ['tag']).trim()).toBe('v1.2.0');
    expect(sh(remote, 'git', ['rev-parse', 'v1.2.0^{commit}']).trim()).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
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
    expect(sh(join(ws.root, 'remotes', 'wnsrn3436', 'open-game-works-core-impl.git'), 'git', ['tag']).trim()).toBe('v1.2.0');
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toContain('releases/download/v1.2.0/client-godot-plugins.zip');
    expect(Object.keys(gh.created())).toEqual(['v1.2.0']);
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

  it('skips the base proto comparison when no release is below the version', async () => {
    const { ws, env } = await setup();
    expect((await ogw(ws, ['core', 'release', '0.1.0', '--notes', NOTES], { env })).code).toBe(0);
    expect(baseProtoBreaks).not.toHaveBeenCalled();
  });
});

describe('release condition parts', () => {
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

  it('lets a render pass a locked screen left out through and reports it, and no other skip', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    const modules = await readCoreSpecDir(ws.coreImpl);
    const pass = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'pass' as const]));
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'server', modules: pass(['routing']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'tools', modules: pass(['contract-tool', 'data-tool']), recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot', modules: { LogCore: 'pass', UICore: 'skipped' }, skips: { UICore: SCREEN_LOCKED_SKIP }, recordedAt: 1 });
    await addTestRecord(ws.coreImpl, { commit: 'c1', target: 'godot --web', modules: { LogCore: 'skipped', UICore: 'pass' }, skips: { LogCore: 'other' }, recordedAt: 1 });
    expect(await testRecordViolations(ws.coreImpl, 'c1', modules)).toEqual(['core test godot --web: LogCore is skipped at c1']);
    expect(await untestedRenderPasses(ws.coreImpl, 'c1', modules)).toEqual([`core test godot: UICore: ${SCREEN_LOCKED_SKIP}`]);
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
