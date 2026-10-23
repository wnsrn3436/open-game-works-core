import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTgz } from '../../../src/commands/core/lib/archive.ts';
import { installEngines } from '../../../src/commands/env/api.ts';
import { generateCheckout } from '../../../src/commands/generate/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { changeRuns, listRuns, newRunState } from '../../../src/lib/runstate.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { specJson } from '../generate/helpers.ts';
import { fakeGh, readJsonFile, sha256, writeFiles } from './helpers.ts';

vi.mock('../../../src/commands/env/api.ts', () => ({ installEngines: vi.fn(() => Promise.resolve()) }));
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
`;

/** A release folder with a contract tool whose base proto holds `proto`. */
async function release(ws: TestWorkspace, version: string, proto: string, coreSettings: Record<string, unknown>): Promise<string> {
  const src = join(ws.root, `src-${version}`);
  writeFiles(src, { 'bin/contract-tool.js': CONTRACT_TOOL, 'proto/ogw/core.proto': proto });
  const dir = join(ws.root, `remote-${version}`);
  await writeTgz(join(dir, 'contract-tool.tgz'), src, ['bin/contract-tool.js', 'proto/ogw/core.proto']);
  writeFiles(dir, { 'core-settings.json': coreSettings, 'core-spec.json': specJson(version) });
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

beforeEach(() => {
  vi.mocked(installEngines).mockReset().mockResolvedValue(undefined);
  vi.mocked(generateCheckout).mockReset().mockImplementation(generateWrites);
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
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.2.0\n' });
    expect(readJsonFile(join(dir, 'settings.json'))).toEqual({ coreVersion: '1.2.0', engine: 'godot' });
    expect(sh(dir, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual(['core upgrade: 1.0.0 -> 1.2.0', '', 'generated.txt', 'settings.json']);
    expect(sh(dir, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual([' M records/request.md', '?? lead.md', '?? notes.txt']);
    expect(readdirSync(ws.coreReleases)).toContain('1.2.0');
    expect(installEngines).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installEngines).mock.calls[0]?.[1]).toBe('g');
    expect(generateCheckout).toHaveBeenCalledTimes(1);
    expect((await listRuns(await ctx.game('g')))[0]?.data['core upgrade']).toEqual({ version: '1.2.0', skipped: [] });

    const again = await ogw(ws, ['core', 'upgrade', 'g', '--json'], { env: gh.env });
    expect(JSON.parse(again.stdout)).toEqual({ from: '1.2.0', version: null, skipped: [], commit: null });
    expect((await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env })).stdout).toBe('coreVersion stays 1.2.0\n');
    expect((await listRuns(await ctx.game('g')))[0]?.data['core upgrade']).toEqual({ version: null, skipped: [] });
  });

  it('does not touch settings.json with uncommitted changes', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'b', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    writeFileSync(join(dir, 'settings.json'), '{"coreVersion":"1.0.0","x":1}');
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
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
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('core release 1.1.0 failed the hash check');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(installEngines).not.toHaveBeenCalled();

    const cached = join(ws.coreReleases, '1.1.0');
    mkdirSync(cached);
    for (const name of readdirSync(remote)) writeFileSync(join(cached, name), readFileSync(join(remote, name)));
    expect((await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env })).stderr).toContain(`core release 1.1.0 in ${cached} failed the hash check`);
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(generateCheckout).not.toHaveBeenCalled();
  });

  it('restores settings.json and the generated files when installing engines or ogw generate fails', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.1.0': await release(ws, '1.1.0', 'b', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'generated.txt': 'generated 1.0.0' });
    vi.mocked(installEngines).mockRejectedValueOnce(new Error('no engine download'));
    const engines = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
    expect(engines.stderr).toContain('no engine download');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
    expect(generateCheckout).not.toHaveBeenCalled();

    vi.mocked(generateCheckout).mockImplementationOnce((_c, game) => {
      writeFileSync(join(game.root, 'generated.txt'), 'half');
      return Promise.reject(new Error('generate broke'));
    });
    const generate = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
    expect(generate.stderr).toContain('generate broke');
    expect(generateCheckout).toHaveBeenCalledTimes(2);
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
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\nskipped: 1.3.0, 1.2.0\n' });
    expect(run.stderr).toContain('core 1.3.0 breaks backward compatibility with prod-1.0.0:\ncontract/service.proto:1:1 ERROR breaks');
    const calls = toolLog(log);
    expect(calls.map((c) => [c.proto, c.previous])).toEqual([
      ['BREAK again', true], ['BREAK again', false], ['BREAK', true], ['BREAK', false], ['ok proto', true],
    ]);
    expect(calls[4]).toMatchObject({
      previousContract: ['service.proto'],
      previousProto: 'prod proto',
      previousSettings: { 'NetworkCore.retryCount': 3, 'A.b': 2 },
      contractVersion: '4',
      coreSettings: { 'NetworkCore.retryCount': 5, 'A.b': 2 },
    });
    expect(calls[4]?.gameFiles.filter((f) => !f.endsWith('/') && f.includes('.'))).toEqual([
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
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion: 1.0.0 -> 1.1.0\nskipped: 1.2.0\n' });
    expect(run.stderr).toContain('core 1.2.0 breaks backward compatibility with prod-1.0.0:\ncontract/service.proto:1:1 ERROR breaks\n');
    expect(run.stderr).toContain('core 1.1.0 keeps backward compatibility with prod-1.0.0; its contract tool finds other violations:\ncontract/service.proto:2:1 ERROR rule');
  });

  it('with useLocalCore, compares with the contract tool of each published candidate release', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    const log = join(ws.root, 'tool-log.jsonl');
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod', {}),
      'v1.1.0': await release(ws, '1.1.0', 'BREAK', {}),
      'v1.2.0': await release(ws, '1.2.0', 'BREAK too', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: { ...gh.env, FAKE_TOOL_LOG: log } });
    expect(run).toMatchObject({ code: 0, stdout: 'coreVersion stays 1.0.0\nskipped: 1.2.0, 1.1.0\n' });
    expect(toolLog(log).filter((c) => c.previous).map((c) => c.proto)).toEqual(['BREAK too', 'BREAK']);
    expect(readdirSync(ws.coreReleases).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });

  it('stays when no higher version is compatible, and fails when the contract tool cannot run', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, {
      'v1.0.0': await release(ws, '1.0.0', 'prod', {}),
      'v1.1.0': await release(ws, '1.1.0', 'BREAK', {}),
    });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const env = { ...gh.env, FAKE_TOOL_LOG: join(ws.root, 'log') };
    expect((await ogw(ws, ['core', 'upgrade', 'g'], { env })).stdout).toBe('coreVersion stays 1.0.0\nskipped: 1.1.0\n');
    expect(generateCheckout).not.toHaveBeenCalled();

    const ws2 = makeWorkspace();
    const gh2 = fakeGh(ws2, { 'v1.0.0': await release(ws2, '1.0.0', 'prod', {}), 'v1.1.0': await release(ws2, '1.1.0', 'BAD', {}) });
    const dir2 = makeGame(ws2, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'server/generated/contract/contract_version': '1\n' });
    sh(dir2, 'git', ['tag', 'prod-1.0.0']);
    const failed = await ogw(ws2, ['core', 'upgrade', 'g'], { env: { ...gh2.env, FAKE_TOOL_LOG: join(ws2.root, 'log') } });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('contract tool of core 1.1.0 failed (2): bad input');
  });

  it('fails when the PROD tag lacks what the contract tool needs', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.0.0': await release(ws, '1.0.0', 'p', {}), 'v1.1.0': await release(ws, '1.1.0', 'q', {}) });
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    sh(dir, 'git', ['tag', 'prod-1.0.0']);
    const run = await ogw(ws, ['core', 'upgrade', 'g'], { env: gh.env });
    expect(run.stderr).toContain('no server/generated/contract/contract_version at prod-1.0.0');
    const ws2 = makeWorkspace();
    const gh2 = fakeGh(ws2, { 'v1.1.0': await release(ws2, '1.1.0', 'q', {}) });
    const dir2 = makeGame(ws2, 'g', { 'x.txt': '1', 'server/generated/contract/contract_version': '1\n' });
    sh(dir2, 'git', ['tag', 'prod-1.0.0']);
    writeFiles(dir2, { 'settings.json': { coreVersion: '1.0.0' } });
    commitAll(dir2);
    expect((await ogw(ws2, ['core', 'upgrade', 'g'], { env: gh2.env })).stderr).toContain('no settings.json at refs/tags/prod-1.0.0');
  });
});
