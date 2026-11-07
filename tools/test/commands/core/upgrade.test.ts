import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staticCheckDetail, type StaticCheckDetail } from '../../../src/commands/check/static-api.ts';
import { writeTgz } from '../../../src/commands/core/lib/archive.ts';
import { installEngines, requireEngine } from '../../../src/commands/env/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { generateCheckout } from '../../../src/commands/generate/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { changeRuns, listRuns, newRunState } from '../../../src/lib/runstate.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeProgram, specJson, storedZip } from '../generate/helpers.ts';
import { fakeGh, readJsonFile, sha256, writeFiles } from './helpers.ts';

vi.mock('../../../src/commands/env/api.ts', () => ({ installEngines: vi.fn(() => Promise.resolve()), requireEngine: vi.fn() }));
vi.mock('../../../src/commands/check/static-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/static-api.ts')>()),
  staticCheckDetail: vi.fn(),
}));
vi.mock('../../../src/commands/data/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/data/api.ts')>()),
  runData: vi.fn(),
}));
vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  generateCheckout: vi.fn(),
}));

/** The default fake `ogw generate`: writes `generated.txt` with the checkout's `coreVersion`. */
function generateWrites(_ctx: unknown, game: { root: string }): Promise<{ written: string[]; removed: string[] }> {
  const { coreVersion } = JSON.parse(readFileSync(join(game.root, 'settings.json'), 'utf8')) as { coreVersion: string };
  writeFileSync(join(game.root, 'generated.txt'), `generated ${coreVersion}`);
  return Promise.resolve({ written: ['generated.txt'], removed: [] });
}

/**
 * A fake contract tool: exit 2 when its base proto says BAD. A violation line for RULE in every run, and one for BREAK
 * only with `--previous` (a backward compatibility violation); exit 1 when it prints any. It logs what it saw.
 */
const CONTRACT_TOOL = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const opt = (n) => args[args.indexOf(n) + 1];
const proto = fs.readFileSync(path.join(opt('--base-proto'), 'ogw', 'core.proto'), 'utf8');
const prev = args.includes('--previous') ? opt('--previous') : null;
fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({
  args, proto: proto.trim(), previous: prev !== null,
  previousContract: prev && fs.readdirSync(path.join(prev, 'contract')),
  previousProto: prev && fs.readFileSync(path.join(prev, 'proto', 'ogw', 'core.proto'), 'utf8').trim(),
  previousSettings: prev && JSON.parse(fs.readFileSync(path.join(prev, 'core-settings.json'), 'utf8')),
  contractVersion: prev && fs.readFileSync(path.join(prev, 'contract_version'), 'utf8').trim(),
  gameFiles: fs.readdirSync(opt('--game'), { recursive: true }).sort(),
  coreSettings: JSON.parse(fs.readFileSync(opt('--core-settings'), 'utf8')),
}) + '\\n');
if (proto.includes('BAD')) { process.stderr.write('bad input'); process.exit(2); }
const lines = [];
if (proto.includes('RULE')) lines.push('contract/service.proto:2:1 ERROR rule');
if (prev && proto.includes('BREAK')) lines.push('contract/service.proto:1:1 ERROR breaks');
if (lines.length > 0) { process.stdout.write(lines.join('\\n')); process.exit(1); }
// A violation writes no file (\`contract\` skill \`tool.md\`): the code is written after them.
const out = path.join(opt('--game'), 'client', 'generated', 'contract');
fs.mkdirSync(out, { recursive: true });
const tables = path.join(opt('--game'), 'server', 'generated', 'data', 'game_data.proto');
fs.writeFileSync(path.join(out, 'core_contract.gd'), proto + (fs.existsSync(tables) ? ' ' + fs.readFileSync(tables, 'utf8') : ''));
`;

/**
 * A fake Godot whose `--import` writes a `.uid` for each `.gd` of the project that has none, as Godot does, and fails
 * while `<godot>.fail` exists.
 */
const IMPORT = `
if [ -f "$0.fail" ]; then echo "import broke" >&2; exit 3; fi
proj="$3"
find "$proj" -path "$proj/addons" -prune -o -path "$proj/.godot" -prune -o -name '*.gd' -print | while read f; do [ -f "$f.uid" ] || echo uid > "$f.uid"; done
`;

let godot = '';

/** A release folder with a contract tool whose base proto holds `proto`, and the Godot client whose `engine.json` meta sync reads. */
async function release(ws: TestWorkspace, version: string, proto: string, coreSettings: Record<string, unknown>): Promise<string> {
  const src = join(ws.root, `src-${version}`);
  writeFiles(src, { 'bin/contract-tool.js': CONTRACT_TOOL, 'proto/ogw/core.proto': proto });
  const dir = join(ws.root, `remote-${version}`);
  await writeTgz(join(dir, 'contract-tool.tgz'), src, ['bin/contract-tool.js', 'proto/ogw/core.proto']);
  writeFiles(dir, { 'core-settings.json': coreSettings, 'core-spec.json': specJson(version) });
  writeFileSync(join(dir, 'client-godot.zip'), storedZip({ 'engine.json': JSON.stringify({ godot: '4.5.1.stable' }) }));
  const assets: Record<string, string> = {};
  for (const name of readdirSync(dir)) assets[name] = sha256(readFileSync(join(dir, name)));
  writeFiles(dir, { 'manifest.json': { version, assets, coreSchemaVersion: 1 } });
  return dir;
}

interface ToolCall {
  args: string[];
  proto: string;
  previous: boolean;
  gameFiles: string[];
}

function toolLog(path: string): ToolCall[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ToolCall);
}

/** A static check result with `failures` at `where`, of which the `absent` ones are absence failures. */
function staticResult(failures: { where: string; message: string; absent?: true }[]): StaticCheckDetail {
  const all = failures.map(({ where, message }) => ({ where, message, evidence: [] }));
  return {
    result: { name: 'static check', platform: null, result: all.length > 0 ? 'fail' : 'pass', failures: all, warnings: [] },
    absent: all.filter((_f, i) => failures[i]?.absent === true),
  };
}

beforeEach(() => {
  godot = fakeProgram(mkdtempSync(join(tmpdir(), 'ogw-godot-')), 'godot', IMPORT);
  vi.mocked(requireEngine).mockReset().mockResolvedValue(godot);
  vi.mocked(staticCheckDetail).mockReset().mockResolvedValue(staticResult([]));
  vi.mocked(installEngines).mockReset().mockResolvedValue(undefined);
  vi.mocked(generateCheckout).mockReset().mockImplementation(generateWrites);
  vi.mocked(runData).mockReset().mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
});

describe('ogw core upgrade', () => {
  it('raises coreVersion to the highest release and commits only settings.json and what ogw generate wrote', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'a', {}),
      'v1.2.0': await release(ws, '1.2.0', 'c', {}),
      'v1.1.0': await release(ws, '1.1.0', 'b', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' }, 'records/request.md': 'start\n' });
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    // The lead agent edits the checkout while the job runs.
    vi.mocked(generateCheckout).mockImplementationOnce(async (c, game) => {
      writeFileSync(join(game.root, 'records/request.md'), 'start\nhalf written');
      writeFileSync(join(game.root, 'lead.md'), 'new');
      return generateWrites(c, game);
    });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await changeRuns(await ctx.game('g'), (runs) => {
      runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'x' }));
    });
    // only the version that --check prints now: not a lower one, and only with one of --check and --version
    const stale = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(stale).toMatchObject({ code: 1, stderr: '--version 1.1.0 is not the version ogw core upgrade g --check prints now (1.2.0); run --check again and ask the human\n' });
    for (const args of [[], ['--check', '--version', '1.2.0']]) {
      expect((await ogw(ws, ['core', 'upgrade', 'g', ...args], { env: gh.env })).stderr).toBe('give one of --check and --version\nusage: ogw core upgrade <game> (--check | --version <version>)\n');
    }
    expect(generateCheckout).not.toHaveBeenCalled();
    expect(sh(dir, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual(['?? notes.txt']);
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.2.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.2.0\n' });
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.2.0', engine: 'godot' });
    // the meta sync of the hook gives the new script of the commit its meta file
    expect(sh(dir, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual([
      'core upgrade: 1.0.0 -> 1.2.0', '', 'client/generated/contract/core_contract.gd', 'client/generated/contract/core_contract.gd.uid', 'generated.txt', 'settings.json',
    ]);
    expect(sh(dir, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual([' M records/request.md', '?? lead.md', '?? notes.txt']);
    // a game with no static check failure prints none
    expect(staticCheckDetail).toHaveBeenCalledTimes(1);
    expect(run.stderr).not.toMatch(/^(settings\.json|client\/)/m);
    expect(readdirSync(ws.coreReleases)).toContain('1.2.0');
    expect(installEngines).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installEngines).mock.calls[0]?.[1]).toBe('g');
    expect(generateCheckout).toHaveBeenCalledTimes(1);
    expect((await listRuns(await ctx.game('g')))[0]?.data['core upgrade']).toEqual({ version: '1.2.0', skipped: [] });

    const none = await ogw(ws, ['core', 'upgrade', 'g', '--check', '--json'], { env: gh.env });
    expect(JSON.parse(none.stdout)).toEqual({ from: '1.2.0', version: null, skipped: [], changes: [], proposals: [] });
    const again = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.2.0'], { env: gh.env });
    expect(again).toMatchObject({ code: 1, stderr: '--version 1.2.0 is not the version ogw core upgrade g --check prints now (none); run --check again and ask the human\n' });
    expect(generateCheckout).toHaveBeenCalledTimes(1);
  });

  it('with --check prints the version, the changes and the released proposals, and changes nothing', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(
      ws,
      { 'v1.0.0': await release(ws, '1.0.0', 'a', {}), 'v1.1.0': await release(ws, '1.1.0', 'b', {}) },
      { 'v1.0.0...v1.1.0': 'UICore: add theme\nogw agent m1: result file\nogw agent merge m1\nogw: review lists of UICore round 1\nSoundCore: duck music under voice\ncore release 1.1.0: plugin URLs and SHA-256\n' },
    );
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot' },
      'records/core-proposals/1-theme.md': 'status: released\nversion: 1.1.0\n',
      'records/core-proposals/2-old.md': 'status: released\nversion: 1.0.0\n',
    });
    const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await changeRuns(await ctx.game('g'), (runs) => {
      runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'x' }));
    });
    const runsBefore = await listRuns(await ctx.game('g'));
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--check'], { env: gh.env });
    expect(run).toMatchObject({ code: 0 });
    expect(run.stdout).toBe(
      [
        'coreVersion: 1.0.0',
        'would raise to: 1.1.0',
        `changes (${(JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as { coreReleaseRepository: string }).coreReleaseRepository} v1.0.0...v1.1.0):`,
        '- UICore: add theme',
        '- SoundCore: duck music under voice',
        'released core proposals: records/core-proposals/1-theme.md',
        '',
      ].join('\n'),
    );
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.0.0', engine: 'godot' });
    expect(sh(dir, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(await listRuns(await ctx.game('g'))).toEqual(runsBefore);
    expect(runsBefore[0]?.data['core upgrade']).toBeUndefined();
    expect(installEngines).not.toHaveBeenCalled();
    expect(generateCheckout).not.toHaveBeenCalled();
    const none = makeWorkspace();
    const ghNone = fakeGh(none, { 'v1.0.0': await release(none, '1.0.0', 'a', {}) });
    makeGame(none, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    expect((await ogw(none, ['core', 'upgrade', 'g', '--check'], { env: ghNone.env })).stdout).toBe('coreVersion: 1.0.0\nno version to raise to\n');
  });

  it('raises no higher than the core of the harness and not below minCoreVersion', async () => {
    const ws = makeWorkspace({ minCoreVersion: '1.1.0' });
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'a', {}),
      'v1.1.0': await release(ws, '1.1.0', 'b', {}),
      'v1.2.0': await release(ws, '1.2.0', 'c', {}),
    });
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' } });
    sh(ws.harness, 'git', ['tag', 'core-v1.1.0']);
    const check = await ogw(ws, ['core', 'upgrade', 'g', '--check', '--json'], { env: gh.env });
    expect((JSON.parse(check.stdout) as { version: string | null }).version).toBe('1.1.0');
    const higher = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.2.0'], { env: gh.env });
    expect(higher.stderr).toContain('--version 1.2.0 is not the version ogw core upgrade g --check prints now (1.1.0)');
  });

  it('with --check reads every page of the comparison, and fails when it lists fewer commits than the total', async () => {
    const ws = makeWorkspace();
    const releases = { 'v1.0.0': await release(ws, '1.0.0', 'a', {}), 'v1.1.0': await release(ws, '1.1.0', 'b', {}) };
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const paged = fakeGh(ws, releases, { 'v1.0.0...v1.1.0': { total: 3, pages: [['UICore: one', 'UICore: two'], ['UICore: three']] } });
    const all = await ogw(ws, ['core', 'upgrade', 'g', '--check', '--json'], { env: paged.env });
    expect((JSON.parse(all.stdout) as { changes: string[] }).changes).toEqual(['UICore: one', 'UICore: two', 'UICore: three']);
    const short = fakeGh(ws, releases, { 'v1.0.0...v1.1.0': { total: 3, pages: [['UICore: one', 'UICore: two']] } });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--check'], { env: short.env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('listed 2 of 3 commits');
  });

  it('does not touch settings.json with uncommitted changes', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'b', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    writeFileSync(join(dir, 'settings.json'), '{"coreVersion":"1.0.0","x":1}');
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('settings.json has uncommitted changes');
    expect(generateCheckout).not.toHaveBeenCalled();
  });

  it('leaves settings.json as committed when the release fails the hash check, also a cached one', async () => {
    const ws = makeWorkspace();
    const remote = await release(ws, '1.1.0', 'b', {});
    writeFileSync(join(remote, 'core-settings.json'), '{"changed":1}');
    const gh = fakeGh(ws, { 'v1.1.0': remote });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('core release 1.1.0 failed the hash check');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(installEngines).not.toHaveBeenCalled();

    const cached = join(ws.coreReleases, '1.1.0');
    mkdirSync(cached);
    for (const name of readdirSync(remote)) writeFileSync(join(cached, name), readFileSync(join(remote, name)));
    expect((await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env })).stderr).toContain(`core release 1.1.0 in ${cached} failed the hash check`);
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(generateCheckout).not.toHaveBeenCalled();
  });

  it('restores settings.json and the generated files when installing engines or ogw generate fails', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'b', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'generated.txt': 'generated 1.0.0' });
    vi.mocked(installEngines).mockRejectedValueOnce(new Error('no engine download'));
    const engines = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(engines.stderr).toContain('no engine download');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(generateCheckout).not.toHaveBeenCalled();

    vi.mocked(generateCheckout).mockImplementationOnce((_c, game) => {
      writeFileSync(join(game.root, 'generated.txt'), 'half');
      return Promise.reject(new Error('generate broke'));
    });
    const generate = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(generate.stderr).toContain('generate broke');
    expect(generateCheckout).toHaveBeenCalledTimes(2);
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('runs the data tool, then the contract tool on what it wrote, and commits their output, so that the commit holds the contract code of the new data', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot' },
      'client/generated/contract/core_contract.gd': 'old proto',
      'server/generated/data/game_data.proto': 'old tables',
      'data/translations/en.csv': 'old hash',
    });
    vi.mocked(runData).mockImplementationOnce((_c, game) => {
      writeFiles(game.root, { 'server/generated/data/game_data.proto': 'new tables', 'data/translations/en.csv': 'new hash' });
      return Promise.resolve({ exitCode: 0, lines: [], stderr: '' });
    });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\n' });
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')).toEqual(expect.arrayContaining(['client/generated/contract/core_contract.gd', 'server/generated/data/game_data.proto', 'data/translations/en.csv']));
    // what `client/core` reads and `generated diff` compares is committed, from the new data
    expect(sh(dir, 'git', ['show', 'HEAD:client/generated/contract/core_contract.gd'])).toBe('new proto new tables');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('prints data check errors, keeps what the failed data run put in data/ out of the commit, and generates the contract code from the old data', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot' },
      'client/generated/contract/core_contract.gd': 'old proto',
      'client/generated/contract/core_contract.gd.uid': 'uid',
      'server/generated/data/game_data.proto': 'old tables',
      'data/system/reserved_id.csv': 'key,id\n',
    });
    const text = 'data/system/reserved_id.csv:2:3 ERROR empty_required [iap_grant_mail]';
    vi.mocked(generateCheckout).mockImplementationOnce(async (c, game) => {
      writeFiles(game.root, { 'client/generated/core_settings.json': 'new settings' });
      const applied = await generateWrites(c, game);
      return { ...applied, written: [...applied.written, 'client/generated/core_settings.json'] };
    });
    vi.mocked(runData).mockImplementationOnce((_c, game) => {
      // A run with errors writes no generation target, and a required row of the new core goes into `data/`.
      writeFiles(game.root, { 'data/system/reserved_id.csv': 'key,id\n[iap_grant_mail],\n', 'data/made.csv': 'made' });
      return Promise.resolve({ exitCode: 1, lines: [{ level: 'ERROR', code: 'empty_required', where: 'data/system/reserved_id.csv:2:3', message: '[iap_grant_mail]', text }], stderr: '' });
    });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\n' });
    expect(run.stderr).toContain(text);
    const committed = sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    expect(committed).toContain('client/generated/contract/core_contract.gd');
    expect(committed.filter((path) => path.startsWith('data/'))).toEqual([]);
    expect(sh(dir, 'git', ['show', 'HEAD:client/generated/core_settings.json'])).toBe('new settings');
    expect(readFileSync(join(dir, 'client/generated/contract/core_contract.gd'), 'utf8')).toBe('new proto old tables');
    expect(readFileSync(join(dir, 'data/system/reserved_id.csv'), 'utf8')).toBe('key,id\n');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('prints a contract violation and goes on with the contract code of HEAD, which writes no file', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto RULE', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' }, 'client/generated/contract/core_contract.gd': 'old proto' });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\n' });
    expect(run.stderr).toContain('contract/service.proto:2:1 ERROR rule');
    expect(readFileSync(join(dir, 'client/generated/contract/core_contract.gd'), 'utf8')).toBe('old proto');
  });

  it('commits content that the pre-commit hook refuses, with the meta files of a new core script, and prints the failures the hook would refuse it for', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot', supportedLanguages: ['en', 'ko'] },
      'client/core/log_core/log_core.gd': 'class_name LogCore\n',
      'client/core/log_core/log_core.gd.uid': 'uid://log',
      'client/features/play/play.gd': 'class_name Play\n',
      'client/features/play/play.gd.uid': 'uid://play',
    });
    // the hook of a game made before the rules of the new core: its static check refuses the content of the upgrade
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "settings.json:1: game settings owner: refused" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    // a script the lead agent staged meanwhile stays out of the commit, with the meta file the sync stages for it
    writeFiles(dir, { 'client/features/lead/lead.gd': 'class_name Lead\n' });
    sh(dir, 'git', ['add', 'client/features/lead/lead.gd']);
    vi.mocked(generateCheckout).mockImplementationOnce(async (c, game) => {
      writeFiles(game.root, { 'client/core/new_core/new_core.gd': 'class_name NewCore\n' });
      const applied = await generateWrites(c, game);
      return { ...applied, written: [...applied.written, 'client/core/new_core/new_core.gd'] };
    });
    let checked = '';
    vi.mocked(staticCheckDetail).mockImplementationOnce((_c, game) => {
      checked = sh(game.root, 'git', ['log', '-1', '--format=%s']).trim();
      return Promise.resolve(staticResult([
        { where: 'settings.json:1', message: 'game settings owner: ogw game check: uiCheckScreens.0.pixelRatio: missing' },
        { where: 'settings.json:2', message: 'a failure at `coreVersion`, which the commit changes' },
        { where: 'settings.json:4', message: 'option entry: no `BootstrapCore.request_restart` call in client content code' },
        { where: 'client/core/new_core:1', message: 'an absence failure in a folder of the commit', absent: true },
        { where: 'client/core/new_core:1', message: 'a failure at a folder of the commit' },
        { where: 'client/features:1', message: 'option entry: no `AuthCore.open_terms_document` call in client content code', absent: true },
        { where: 'client/features/play/play.gd:1', message: 'a failure at a file the commit does not change' },
      ]));
    });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\n' });
    expect(sh(dir, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual([
      'core upgrade: 1.0.0 -> 1.1.0',
      '',
      'client/core/new_core/new_core.gd',
      'client/core/new_core/new_core.gd.uid',
      'client/generated/contract/core_contract.gd',
      'client/generated/contract/core_contract.gd.uid',
      'generated.txt',
      'settings.json',
    ]);
    expect(sh(dir, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual(['A  client/features/lead/lead.gd', 'A  client/features/lead/lead.gd.uid']);
    // the static check of the hook ran on the upgraded checkout, and what the hook would refuse the commit for is printed:
    // not the option entry at `supportedLanguages` (line 4), a value the commit does not change
    expect(checked).toBe('core upgrade: 1.0.0 -> 1.1.0');
    expect(readFileSync(join(dir, 'settings.json'), 'utf8').split('\n').slice(1, 4)).toEqual(['  "coreVersion": "1.1.0",', '  "engine": "godot",', '  "supportedLanguages": [']);
    expect(run.stderr.split('\n').filter((line) => /^(settings\.json|client\/)/.test(line))).toEqual([
      'settings.json:1: game settings owner: ogw game check: uiCheckScreens.0.pixelRatio: missing',
      'settings.json:2: a failure at `coreVersion`, which the commit changes',
      'client/core/new_core:1: an absence failure in a folder of the commit',
    ]);
  });

  it('stays committed and prints the reason when the static check of the upgraded checkout cannot run', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' } });
    vi.mocked(staticCheckDetail).mockRejectedValueOnce(new Error('godot 4.5.1.stable is not installed'));
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\n' });
    expect(run.stderr).toContain('static check after the commit could not run: godot 4.5.1.stable is not installed\n');
    expect(sh(dir, 'git', ['log', '-1', '--format=%s']).trim()).toBe('core upgrade: 1.0.0 -> 1.1.0');
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.1.0', engine: 'godot' });
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('changes nothing when what it regenerates from has uncommitted changes', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'contract/service.proto': 'a', 'data/a.csv': 'a', 'server/generated/data/game_data.proto': 'a' });
    for (const file of ['contract/service.proto', 'data/a.csv', 'server/generated/data/game_data.proto']) {
      writeFileSync(join(dir, file), 'edited');
      const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`the upgrade regenerates from these uncommitted changes; commit or revert them first:\n${file}`);
      expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.0.0' });
      sh(dir, 'git', ['checkout', '--', file]);
    }
    expect(generateCheckout).not.toHaveBeenCalled();
  });

  it('puts back settings.json, what the tools wrote and the index when the meta sync of the commit fails', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'new proto', {}) });
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot' },
      'client/generated/contract/core_contract.gd': 'old proto',
      'client/generated/contract/core_contract.gd.uid': 'uid',
      'generated.txt': 'generated 1.0.0',
    });
    writeFileSync(`${godot}.fail`, '');
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('godot --import failed (3): import broke');
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.0.0', engine: 'godot' });
    expect(readFileSync(join(dir, 'client/generated/contract/core_contract.gd'), 'utf8')).toBe('old proto');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    // a file the tools made that HEAD does not have goes too
    vi.mocked(runData).mockImplementationOnce((_c, game) => {
      writeFiles(game.root, { 'data/new_table.csv': 'made' });
      return Promise.resolve({ exitCode: 0, lines: [], stderr: '' });
    });
    expect((await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } })).code).toBe(1);
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(staticCheckDetail).not.toHaveBeenCalled();
  });

  it('on a failure puts back only coreVersion, and keeps a game settings value written while the upgrade ran', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'b', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'generated.txt': 'generated 1.0.0' });
    const path = join(dir, 'settings.json');
    // `ogw settings set` of the lead agent while the upgrade job runs
    vi.mocked(installEngines).mockImplementationOnce(() => {
      writeFileSync(path, `${JSON.stringify({ ...(readJsonFile(path) as object), appName: 'Lantern', humanDecided: ['appName'] }, null, 2)}\n`);
      return Promise.reject(new Error('no engine download'));
    });
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(run.stderr).toContain('no engine download');
    expect(readJsonFile(path)).toEqual({ coreVersion: '1.0.0', appName: 'Lantern', humanDecided: ['appName'] });
  });

  it('fails and restores when the contract tool itself fails, with exit code 2 or a crash with no violation line', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'BAD', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'generated.txt': 'generated 1.0.0' });
    const bad = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'tool-log.jsonl') } });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('contract tool of core 1.1.0 failed (2): bad input');
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.0.0' });
    // no FAKE_TOOL_LOG: the fake tool throws, with exit code 1 and nothing on stdout
    const crash = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(crash.code).toBe(1);
    expect(crash.stderr).toContain('contract tool of core 1.1.0 failed (1)');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    // the data tool failing to run stops it too, before the contract tool
    vi.mocked(runData).mockResolvedValueOnce({ exitCode: 2, lines: [], stderr: 'no tool' });
    const noData = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(noData.stderr).toContain('data tool of core 1.1.0 failed: no tool');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('with a PROD tag, takes the highest version compatible with the last PROD build and prints the skipped ones', async () => {
    const ws = makeWorkspace();
    const log = join(ws.root, 'tool-log.jsonl');
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod proto', { 'NetworkCore.retryCount': 3, 'A.b': 1 }),
      'v1.1.0': await release(ws, '1.1.0', 'ok proto', { 'NetworkCore.retryCount': 5 }),
      'v1.2.0': await release(ws, '1.2.0', 'BREAK', {}),
      'v1.3.0': await release(ws, '1.3.0', 'BREAK again', {}),
    });
    const dir = makeGame(ws, 'g', {
      'settings.json': { coreVersion: '1.0.0', engine: 'godot', core: { 'A.b': 2 } },
      'contract/service.proto': 'syntax = "proto3";',
      'server/generated/contract/contract_version': '4\n',
      'server/generated/data/game_data.proto': 'data',
      'server/content/big.ts': 'x',
      'client/core/log_core/log_core.gd': 'class_name LogCore',
      'client/scenes/big.tscn': 'x',
    });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    sh(dir, 'git', ['tag', 'prod-0.9.0']);
    sh(dir, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    writeFiles(dir, { 'contract/extra.proto': 'syntax = "proto3";' });
    commitAll(dir, 'more contract');
    const checked = await ogw(ws, ['core', 'upgrade', 'g', '--check'], { env: { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'check-log.jsonl') } });
    expect(checked.stdout.split('\n').slice(0, 3)).toEqual(['coreVersion: 1.0.0', 'skipped: 1.3.0, 1.2.0', 'would raise to: 1.1.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\nskipped: 1.3.0, 1.2.0\n' });
    expect(run.stderr).toContain('core 1.3.0 breaks backward compatibility with prod-1.0.0:\ncontract/service.proto:1:1 ERROR breaks');
    const calls = toolLog(log);
    expect(calls.map((c) => [c.proto, c.previous])).toEqual([
      ['BREAK again', true], ['BREAK again', false], ['BREAK', true], ['BREAK', false], ['ok proto', true], ['ok proto', true],
    ]);
    expect(calls[4]).toMatchObject({
      previousContract: ['service.proto'],
      previousProto: 'prod proto',
      previousSettings: { 'NetworkCore.retryCount': 3, 'A.b': 2 },
      contractVersion: '4',
      coreSettings: { 'NetworkCore.retryCount': 5, 'A.b': 2 },
    });
    // the compatibility runs share one copy of the game, in which an earlier run left its generated code
    expect(calls[4]?.gameFiles.filter((f) => !f.endsWith('/') && f.includes('.') && !f.startsWith('client/generated/'))).toEqual([
      'client/core/log_core/log_core.gd', 'contract/extra.proto', 'contract/service.proto', 'server/generated/data/game_data.proto',
    ]);
    expect(calls[4]?.args.slice(2, 4)).toEqual(['--engine', 'godot']);
    expect(calls[4]?.args).toContain('--modules');
    expect((readJsonFile(join(dir, 'settings.json')) as { coreVersion: string }).coreVersion).toBe('1.1.0');
  });

  it('does not skip a version whose contract tool finds only violations other than backward compatibility', async () => {
    const ws = makeWorkspace();
    const log = join(ws.root, 'tool-log.jsonl');
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod', {}),
      'v1.1.0': await release(ws, '1.1.0', 'RULE', {}),
      'v1.2.0': await release(ws, '1.2.0', 'RULE BREAK', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\nskipped: 1.2.0\n' });
    expect(run.stderr).toContain('core 1.2.0 breaks backward compatibility with prod-1.0.0:\ncontract/service.proto:1:1 ERROR breaks\n');
    expect(run.stderr).toContain('core 1.1.0 keeps backward compatibility with prod-1.0.0; its contract tool finds other violations:\ncontract/service.proto:2:1 ERROR rule');
  });

  it('with useLocalCore, --check compares with the contract tool of each published candidate release', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    const log = join(ws.root, 'tool-log.jsonl');
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod', {}),
      'v1.1.0': await release(ws, '1.1.0', 'BREAK', {}),
      'v1.2.0': await release(ws, '1.2.0', 'BREAK too', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--check'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0\nskipped: 1.2.0, 1.1.0\nno version to raise to\n' });
    expect(toolLog(log).filter((c) => c.previous).map((c) => c.proto)).toEqual(['BREAK too', 'BREAK']);
    expect(readdirSync(ws.coreReleases).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });

  it('prints no version when no higher version is compatible, and fails when the contract tool cannot run', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod', {}),
      'v1.1.0': await release(ws, '1.1.0', 'BREAK', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const env = { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'log') };
    expect((await ogw(ws, ['core', 'upgrade', 'g', '--check'], { env })).stdout).toBe('coreVersion: 1.0.0\nskipped: 1.1.0\nno version to raise to\n');
    expect((await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env })).stderr).toContain('--version 1.1.0 is not the version ogw core upgrade g --check prints now (none); run --check again and ask the human\n');
    expect(generateCheckout).not.toHaveBeenCalled();

    const ws2 = makeWorkspace();
    const gh2 = fakeGh(ws2, { 'v1.0.0': await release(ws2, '1.0.0', 'prod', {}), 'v1.1.0': await release(ws2, '1.1.0', 'BAD', {}) });
    const dir2 = makeGame(ws2, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir2, 'git', ['tag', 'prod-1.0.0']);
    const failed = await ogw(ws2, ['core', 'upgrade', 'g', '--check'], { env: { ...gh2.env, FAKE_TOOL_LOG: join(ws2.root, 'log') } });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('contract tool of core 1.1.0 failed (2): bad input');
  });

  it('fails when the PROD tag lacks what the contract tool needs', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.0.0': await release(ws, '1.0.0', 'p', {}), 'v1.1.0': await release(ws, '1.1.0', 'q', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh.env });
    expect(run.stderr).toContain('no server/generated/contract/contract_version at prod-1.0.0');
    const ws2 = makeWorkspace();
    const gh2 = fakeGh(ws2, { 'v1.1.0': await release(ws2, '1.1.0', 'q', {}) });
    const dir2 = makeGame(ws2, 'g', { 'x.txt': '1', 'server/generated/contract/contract_version': '1\n' });
    sh(dir2, 'git', ['tag', 'prod-1.0.0']);
    writeFiles(dir2, { 'settings.json': { coreVersion: '1.0.0' } });
    commitAll(dir2);
    expect((await ogw(ws2, ['core', 'upgrade', 'g', '--version', '1.1.0'], { env: gh2.env })).stderr).toContain('no settings.json at refs/tags/prod-1.0.0');
  });
});
