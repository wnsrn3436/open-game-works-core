import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCliCommand } from '../../../src/commands/agent/lib/cli-command.ts';
import { safeSegment } from '../../../src/commands/env/lib/host.ts';
import { lanAddress, setUdpWaitMs } from '../../../src/commands/env/lib/hostcheck.ts';
import type { EnvCheckResult } from '../../../src/commands/env/lib/results.ts';
import { pinFiles } from '../../../src/commands/env/lib/tools.ts';
import type { ToolPin } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, realToolsWithout, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin } from './fakes.ts';

const releaseDir = vi.hoisted(() => ({ value: '' }));
vi.mock('../../../src/commands/core/api.ts', () => ({
  publishedRelease: (_ctx: unknown, version: string) =>
    version === '9.9.9' ? Promise.reject(new Error('cannot reach GitHub')) : Promise.resolve({ version, dir: releaseDir.value, local: false }),
  extractedAsset: (_ctx: unknown, release: { dir: string }, asset: string) => Promise.resolve(join(release.dir, asset.replace('.zip', ''))),
}));

const SANDBOX =
  'if [ -n "$FAKE_SANDBOX_FAIL" ]; then echo "sandbox: operation not permitted" >&2; exit 71; fi\n' +
  'if [ "$1" = -p ] || [ "$1" = -f ]; then shift 2; else while [ "$1" != -- ]; do shift; done; shift; fi\n' +
  'printf "sandboxed "\nexec "$@"';

const SCRIPTS: Record<string, string> = {
  git: 'echo "git version 2.50.0"',
  node: 'echo v26.0.0',
  uv: 'echo "uv 0.9.0"',
  python3: 'echo "Python 3.13.1"',
  docker: 'if [ "$1" = buildx ]; then exit 1; fi\nif [ "$1" = image ]; then [ -n "$OGW_TEST_PG" ]; exit $?; fi\necho "Docker version 27.0.1"',
  gh: 'if [ "$1" = auth ]; then echo "  - Token scopes: \'gist\', \'read:org\', \'repo\'" >&2; exit 0; fi\necho "gh version 2.80.0"',
  claude:
    'if [ "$1" = auth ]; then exit 0; fi\nif [ "$1" = -p ]; then if [ "$3" = bad ]; then echo "model bad not found" >&2; exit 1; fi\necho "ok $(/bin/ls -A | /usr/bin/tr "\\n" " ")$([ "$TMPDIR" = "$PWD/tmp" ] && [ -d "$TMPDIR" ] && echo own-tmp || echo os-tmp) [$*] $(/bin/cat)"; exit 0; fi\nexit 9',
  codex: 'if [ "$1" = login ]; then exit 1; fi\necho "boom [$*] $(/bin/cat)" >&2\nexit 2',
  // the play and judge sandbox: macOS `sandbox-exec -f <profile>` or `-p <profile>`, Linux `bwrap ... -- <command>`
  'sandbox-exec': SANDBOX,
  bwrap: SANDBOX,
  xcodebuild: 'echo "26.0.1"\necho "Build version 17A1"',
  oldtool: 'echo "1.9.0"',
  // the device shell: the device programs of `device/` next to adb; it writes `adb-ended` when the shell command ends
  adb:
    'if [ "$1" = devices ]; then printf "List of devices attached\\nemu1\\tdevice\\nold\\toffline\\n"; exit 0; fi\n' +
    'dir=$(/usr/bin/dirname "$0")\nPATH="$dir/device:/usr/bin:/bin" /bin/sh -c "$4"; code=$?\necho "$code" > "$dir/adb-ended"\nexit "$code"',
};

/**
 * toybox `nc`: `-u` sends stdin as a datagram, and only `-q <s>` ends it <s> after stdin ends; `-w` is the connect
 * timeout. FAKE_NC_UNREACHABLE: the datagram does not reach the host. FAKE_NC_HANG: it does not end even with `-q`.
 */
const DEVICE_NC = [
  'q=',
  'while [ $# -gt 2 ]; do case "$1" in -q) q=$2; shift 2;; -w|-W|-p|-s) shift 2;; *) shift;; esac; done',
  `if [ -z "$FAKE_NC_UNREACHABLE" ]; then "${process.execPath}" -e 'const s = require("dgram").createSocket("udp4"); const b = []; process.stdin.on("data", (c) => b.push(c)).on("end", () => s.send(Buffer.concat(b), Number(process.argv[2]), process.argv[1], () => s.close()));' "$1" "$2"; else cat > /dev/null; fi`,
  'if [ -n "$q" ] && [ -z "$FAKE_NC_HANG" ]; then sleep "$q"; exit 0; fi',
  'while :; do sleep 1; done',
].join('\n');

function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv } {
  const ws = makeWorkspace({
    tools: realToolsWithout('ffmpeg', 'chromium', 'gdtoolkit'),
    agents: {
      content: { cli: 'claude-code', model: 'm', effort: 'high' },
      resource: { model: 'm', effort: 'high' },
      translation: { cli: 'codex', model: 'm', effort: 'high' },
      play: { cli: 'claude-code', model: 'm', effort: 'high' },
      judge: { cli: 'claude-code', model: 'm', effort: 'high' },
      'server-hardening': { cli: 'claude-code', model: 'm', effort: 'high' },
      'client-hardening': { cli: 'claude-code', model: 'm', effort: 'high' },
      core: { cli: 'claude-code', model: 'm', effort: 'high' },
      review: { cli: 'claude-code', model: 'bad', effort: 'high' },
    },
    testDevices: [
      { platform: 'android', serial: 'emu1' },
      { platform: 'android', serial: 'phone2' },
    ],
  });
  const bin = fakeBin(join(ws.root, 'bin'), SCRIPTS);
  fakeBin(join(bin, 'device'), { nc: DEVICE_NC });
  mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
  releaseDir.value = join(ws.root, 'release');
  mkdirSync(join(releaseDir.value, 'client-godot'), { recursive: true });
  writeFileSync(
    join(releaseDir.value, 'client-godot', 'engine.json'),
    JSON.stringify({
      godot: '4.4.0.stable',
      buildTools: [
        { platform: 'windows', hosts: ['macos-arm64'], name: 'jsign', version: '7.1', versionCommand: 'jsign --version', downloads: [{ platform: 'any', url: 'https://x/j', sha256: 'a'.repeat(64) }] },
        { platform: 'ios', hosts: ['macos-arm64'], name: 'xcodebuild', version: '26.0', versionCommand: 'xcodebuild -version' },
        { platform: 'ios', hosts: ['macos-arm64'], name: 'missing-tool', version: '1', versionCommand: 'missing-tool --version' },
        { platform: 'ios', hosts: ['macos-arm64'], name: 'oldtool', version: '2.0', versionCommand: 'oldtool --version' },
        { platform: 'windows', hosts: ['macos-arm64'], name: 'signer', version: '3.1', versionCommand: 'signer --version', downloads: [{ platform: 'any', url: 'https://x/s', sha256: 'b'.repeat(64) }] },
        { platform: 'windows', hosts: ['macos-arm64'], name: 'stale', version: '5', versionCommand: 'stale --version', downloads: [{ platform: 'any', url: 'https://x/t', sha256: 'c'.repeat(64) }] },
        { platform: 'ios', hosts: ['linux-x64'], name: 'linux-only', version: '1', versionCommand: 'x' },
        { platform: 'android', hosts: ['macos-arm64'], name: 'sdk', version: '1', versionCommand: 'x' },
      ],
    }),
  );
  makeGame(ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.0.0', buildPlatforms: ['windows', 'ios'] } });
  // never the grok login and the xAI key of the host
  return { ws, env: { ...ws.env, PATH: bin, TMPDIR: join(ws.root, 'tmp'), OGW_HOST_PLATFORM: 'macos-arm64', GROK_HOME: join(ws.root, 'grok-home'), XAI_API_KEY: '' } };
}

/** An install folder of `ogw env install-engines` or `ogw generation install`: `installed.json` and a program printing `output`. */
function installed(dir: string, sha256: string[], output: string): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'program'), `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: 'x', version: 'x', sha256, program: 'bin/program' }));
}

function toolPin(ws: TestWorkspace, name: string): ToolPin {
  return (JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as { tools: Record<string, ToolPin> }).tools[name] as ToolPin;
}

afterEach(() => {
  setUdpWaitMs(null);
});

describe('ogw env check', () => {
  it('checks the host and writes env-check.json', async () => {
    const { ws, env: base } = setup();
    const env = { ...base, OGW_TEST_PG: '1' };
    makeGame(ws, 'g0', { 'settings.json': { engine: 'godot', coreVersion: '9.9.9', buildPlatforms: ['ios'] } });
    const data = join(ws.root, '.ogw');
    installed(join(data, 'build-tools', 'signer', '3.1'), ['b'.repeat(64)], '3.1.4');
    installed(join(data, 'build-tools', 'stale', '5'), ['c'.repeat(64)], '4.2');
    const blender = toolPin(ws, 'blender');
    installed(join(data, 'tools', 'blender', safeSegment(blender.version)), (pinFiles(blender, 'macos-arm64') ?? []).map((f) => f.sha256), 'Blender');
    installed(join(data, 'tools', 'placeholderFont', safeSegment(toolPin(ws, 'placeholderFont').version)), ['d'.repeat(64)], 'font');
    const run = await ogw(ws, ['env', 'check', '--json'], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as EnvCheckResult & { resultFile: string };
    expect(result.resultFile).toBe(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'));
    const saved = JSON.parse(readFileSync(result.resultFile, 'utf8')) as EnvCheckResult;
    expect(saved.programs).toEqual(result.programs);
    expect(result.host.platform).toBe('macos-arm64');
    expect(result.host.memoryBytes).toBeGreaterThan(0);
    expect(result.host.freeDiskBytes).toBeGreaterThan(0);
    expect(result.programs).toEqual({
      git: { found: true, version: 'git version 2.50.0' },
      node: { found: true, version: 'v26.0.0' },
      uv: { found: true, version: 'uv 0.9.0' },
      python: { found: true, version: 'Python 3.13.1' },
      docker: { found: true, version: 'Docker version 27.0.1' },
      dockerBuildx: { found: false, version: null },
      gh: { found: true, version: 'gh version 2.80.0' },
    });
    expect(result.gh).toEqual({ loggedIn: true, scopes: ['gist', 'read:org', 'repo'] });
    expect(result.engines).toEqual([
      { engine: 'godot', version: '4.4.0.stable', from: 'game g1', installed: false },
      { engine: 'godot', version: '4.5.1.stable', from: 'open-game-works-core-impl', installed: false },
    ]);
    // The release of g0 cannot be read: the other game and open-game-works-core-impl are still checked.
    expect(result.engineErrors).toEqual([{ from: 'game g0', reason: 'cannot reach GitHub' }]);
    // Installed with the SHA-256 of the pin (blender), with other SHA-256 (placeholderFont), and the postgres image.
    expect(result.tools).toEqual({
      blender: { pinned: true, installed: true },
      placeholderFont: { pinned: true, installed: false },
      chromium: { pinned: false, installed: false },
      gdtoolkit: { pinned: false, installed: false },
      ffmpeg: { pinned: false, installed: false },
      postgresql: { pinned: true, installed: true },
    });
    expect(result.buildTools).toEqual([
      { from: 'game g1', platform: 'windows', name: 'jsign', version: '7.1', downloadable: true, ok: false, output: null },
      { from: 'game g1', platform: 'ios', name: 'xcodebuild', version: '26.0', downloadable: false, ok: true, output: '26.0.1' },
      { from: 'game g1', platform: 'ios', name: 'missing-tool', version: '1', downloadable: false, ok: false, output: null },
      { from: 'game g1', platform: 'ios', name: 'oldtool', version: '2.0', downloadable: false, ok: false, output: '1.9.0' },
      { from: 'game g1', platform: 'windows', name: 'signer', version: '3.1', downloadable: true, ok: true, output: '3.1.4' },
      { from: 'game g1', platform: 'windows', name: 'stale', version: '5', downloadable: true, ok: false, output: '4.2' },
    ]);
    // Each CLI, model, effort and sandbox runs the prompt on stdin with the command of `ogw agent`: play and judge in a
    // new agent folder that holds only the `tmp/` they get as TMPDIR, the others in an empty folder with the OS TMPDIR.
    const args = (cli: 'claude-code' | 'codex', model: string): string => agentCliCommand({ cli, model, effort: 'high' }).args.join(' ');
    const prompt = 'Reply with the single word ok.';
    expect(result.agentClis).toEqual([
      {
        cli: 'claude-code',
        model: 'm',
        effort: 'high',
        sandboxed: false,
        roles: ['content', 'resource', 'server-hardening', 'client-hardening', 'core'],
        installed: true,
        loggedIn: true,
        run: { ok: true, exitCode: 0, output: `ok os-tmp [${args('claude-code', 'm')}] ${prompt}` },
      },
      { cli: 'codex', model: 'm', effort: 'high', sandboxed: false, roles: ['translation'], installed: true, loggedIn: false, run: { ok: false, exitCode: 2, output: `boom [${args('codex', 'm')}] ${prompt}` } },
      {
        cli: 'claude-code',
        model: 'm',
        effort: 'high',
        sandboxed: true,
        roles: ['play', 'judge'],
        installed: true,
        loggedIn: true,
        run: { ok: true, exitCode: 0, output: `sandboxed ok tmp own-tmp [${args('claude-code', 'm')} --no-session-persistence] ${prompt}` },
      },
      { cli: 'claude-code', model: 'bad', effort: 'high', sandboxed: false, roles: ['review'], installed: true, loggedIn: true, run: { ok: false, exitCode: 1, output: 'model bad not found' } },
    ]);
    const grokLogin = join(ws.root, 'grok-home', 'auth.json');
    expect(result.providerClis).toEqual([
      { provider: 'codex', methods: ['sprite-gen-codex'], installed: true, loggedIn: false, billing: null, detail: null },
      { provider: 'grok', methods: ['sprite-gen-grok'], installed: false, loggedIn: false, billing: null, detail: `no login file ${grokLogin}; XAI_API_KEY is not set` },
    ]);
    expect(result.testDevices).toEqual([
      { serial: 'emu1', connected: true, udp: lanAddress() === null ? null : true },
      { serial: 'phone2', connected: false, udp: null },
    ]);
    const text = await ogw(ws, ['env', 'check'], { env });
    expect(text.stdout).toContain('program dockerBuildx: missing\n');
    expect(text.stdout).toContain('gh login: yes, scopes: gist, read:org, repo\n');
    expect(text.stdout).toContain('engine godot 4.5.1.stable (open-game-works-core-impl): missing\n');
    expect(text.stdout).toContain('tools.chromium: not pinned\n');
    expect(text.stdout).toContain('build tool jsign 7.1 for windows (game g1): missing (ogw env install-engines)\n');
    expect(text.stdout).toContain('build tool missing-tool 1 for ios (game g1): install missing-tool 1\n');
    expect(text.stdout).toContain('build tool xcodebuild 26.0 for ios (game g1): ok\n');
    expect(text.stdout).toContain('agent CLI codex (model m, effort high): installed yes, login no, prompt run failed: boom');
    expect(text.stdout).toContain('agent CLI claude-code (model bad, effort high): installed yes, login yes, prompt run failed: model bad not found\n');
    expect(text.stdout).toContain('engine.json (game g0): cannot reach GitHub\n');
    expect(text.stdout).toContain('build tool oldtool 2.0 for ios (game g1): install oldtool 2.0\n');
    expect(text.stdout).toContain('build tool signer 3.1 for windows (game g1): ok\n');
    expect(text.stdout).toContain('tools.blender: installed\n');
    expect(text.stdout).toContain(`provider CLI grok (sprite-gen-grok): installed no, login no, billing unknown (no login file ${grokLogin}; XAI_API_KEY is not set)\n`);
    expect(text.stdout).toContain('test device phone2: connected no, UDP unknown\n');
  });

  it('fails the prompt run of play and judge when the sandbox does not run on this host', async () => {
    const { ws, env } = setup();
    const run = await ogw(ws, ['env', 'check', '--json'], { env: { ...env, FAKE_SANDBOX_FAIL: '1' } });
    const result = JSON.parse(run.stdout) as EnvCheckResult;
    expect(result.agentClis.map((c) => [c.roles, c.sandboxed, c.run?.ok])).toEqual([
      [['content', 'resource', 'server-hardening', 'client-hardening', 'core'], false, true],
      [['translation'], false, false],
      [['play', 'judge'], true, false],
      [['review'], false, false],
    ]);
    expect(result.agentClis[2]?.run).toEqual({ ok: false, exitCode: 71, output: 'sandbox: operation not permitted' });
    const text = await ogw(ws, ['env', 'check'], { env: { ...env, FAKE_SANDBOX_FAIL: '1' } });
    expect(text.stdout).toContain('agent CLI claude-code (model m, effort high, sandboxed): installed yes, login yes, prompt run failed: sandbox: operation not permitted\n');
  });

  it('runs the play and judge prompt with the default config folder and its login, and removes the sandbox profile', async () => {
    const { ws, env } = setup();
    const home = env.CLAUDE_CONFIG_DIR as string;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'settings.json'), '{"apiKeyHelper": "x"}');
    writeFileSync(join(home, '.credentials.json'), '{}');
    // a claude that needs the login and the settings of the default config folder
    fakeBin(join(ws.root, 'bin'), {
      ...SCRIPTS,
      claude:
        'if [ "$1" = auth ]; then exit 0; fi\n' +
        'if [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] || [ ! -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then echo "no login in $CLAUDE_CONFIG_DIR" >&2; exit 1; fi\n' +
        '/bin/cat > /dev/null; echo "ok config $CLAUDE_CONFIG_DIR args $*"',
    });
    const run = await ogw(ws, ['env', 'check', '--json'], { env });
    const result = JSON.parse(run.stdout) as EnvCheckResult;
    expect(result.agentClis.map((c) => [c.roles, c.sandboxed, c.run?.ok])).toEqual([
      [['content', 'resource', 'server-hardening', 'client-hardening', 'core'], false, true],
      [['translation'], false, false],
      [['play', 'judge'], true, true],
      [['review'], false, true],
    ]);
    const output = result.agentClis[2]?.run?.output ?? '';
    expect(output).toContain(`sandboxed ok config ${home} args `);
    expect(output).toContain('--no-session-persistence');
    expect(result.agentClis[0]?.run?.output).not.toContain('--no-session-persistence');
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('ogw-play-sandbox-'))).toEqual([]);
  });

  it('records the grok login file, XAI_API_KEY without it, and engine errors', async () => {
    const { ws, env: base } = setup();
    const env = { ...base, XAI_API_KEY: 'xai-secret-value' };
    fakeBin(join(ws.root, 'bin'), { grok: 'exit 0' });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const login = join(ws.root, 'grok-home', 'auth.json');
    const run = await ogw(ws, ['env', 'check', '--json'], { env });
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toContain('xai-secret-value');
    const result = JSON.parse(run.stdout) as EnvCheckResult;
    expect(result.providerClis[1]).toEqual({ provider: 'grok', methods: ['sprite-gen-grok'], installed: true, loggedIn: false, billing: 'per-call', detail: `no login file ${login}; XAI_API_KEY is set` });
    // the login file is used even with XAI_API_KEY set
    mkdirSync(join(ws.root, 'grok-home'));
    writeFileSync(login, '{}');
    const loggedIn = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(loggedIn.providerClis[1]).toEqual({ provider: 'grok', methods: ['sprite-gen-grok'], installed: true, loggedIn: true, billing: 'subscription', detail: `login file ${login}` });
    // sprite-gen refuses a blank GROK_HOME and a login path it cannot inspect, without falling back to XAI_API_KEY
    const blank = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env: { ...env, GROK_HOME: ' ' } })).stdout) as EnvCheckResult;
    expect(blank.providerClis[1]).toEqual({ provider: 'grok', methods: ['sprite-gen-grok'], installed: true, loggedIn: false, billing: null, detail: 'GROK_HOME is set but empty' });
    const notDir = join(login, 'home');
    const blocked = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env: { ...env, GROK_HOME: notDir } })).stdout) as EnvCheckResult;
    expect(blocked.providerClis[1]).toEqual({
      provider: 'grok',
      methods: ['sprite-gen-grok'],
      installed: true,
      loggedIn: false,
      billing: null,
      detail: `cannot inspect login file ${join(notDir, 'auth.json')}`,
    });
    expect(result.engines).toEqual([{ engine: 'godot', version: '4.4.0.stable', from: 'game g1', installed: false }]);
    expect(result.engineErrors).toEqual([{ from: 'open-game-works-core-impl/client/godot', reason: 'engine.json of godot has no godot version' }]);
    expect(result.buildTools.map((t) => t.name)).toEqual(['jsign', 'xcodebuild', 'missing-tool', 'oldtool', 'signer', 'stale']);
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('engine.json (open-game-works-core-impl/client/godot): engine.json of godot has no godot version\n');
  });

  it('records the GitHub CLI login as no when gh auth status fails or gh is missing', async () => {
    const { ws, env } = setup();
    fakeBin(join(ws.root, 'bin'), { gh: 'if [ "$1" = auth ]; then echo "  - Token scopes: \'repo\'" >&2; echo "not logged in" >&2; exit 1; fi\necho "gh version 2.80.0"' });
    const failed = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(failed.programs.gh).toEqual({ found: true, version: 'gh version 2.80.0' });
    expect(failed.gh).toEqual({ loggedIn: false, scopes: [] });
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('gh login: no, scopes: \n');
    rmSync(join(ws.root, 'bin', 'gh'));
    const missing = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(missing.programs.gh).toEqual({ found: false, version: null });
    expect(missing.gh).toEqual({ loggedIn: false, scopes: [] });
  });

  it('checks only the active github.com account when another gh host fails', async () => {
    const { ws, env } = setup();
    const gh = [
      'if [ "$1" = auth ]; then',
      '  if [ "$3 $4 $5" = "--hostname github.com --active" ]; then',
      '    printf "github.com\\n  - Logged in to github.com account a\\n  - Token scopes: \'repo\', \'write:packages\'\\n" >&2; exit 0',
      '  fi',
      '  printf "ghe.example.com\\n  X Failed to log in to ghe.example.com\\n  - Token scopes: \'gist\'\\ngithub.com\\n  - Token scopes: \'repo\', \'write:packages\'\\n" >&2; exit 1',
      'fi',
      'echo "gh version 2.80.0"',
    ].join('\n');
    fakeBin(join(ws.root, 'bin'), { gh });
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(result.gh).toEqual({ loggedIn: true, scopes: ['repo', 'write:packages'] });
  });

  it('records an agent CLI that is not installed without running the prompt', async () => {
    const { ws, env } = setup();
    rmSync(join(ws.root, 'bin', 'codex'));
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(result.agentClis[1]).toEqual({
      cli: 'codex',
      model: 'm',
      effort: 'high',
      sandboxed: false,
      roles: ['translation'],
      installed: false,
      loggedIn: false,
      run: { ok: false, exitCode: null, output: 'codex is not installed' },
    });
    expect(result.providerClis[0]).toEqual({ provider: 'codex', methods: ['sprite-gen-codex'], installed: false, loggedIn: false, billing: null, detail: null });
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain(
      'agent CLI codex (model m, effort high): installed no, login no, prompt run failed: codex is not installed\n',
    );
  });

  it('records how codex calls are paid from the login kind of codex login status, without the key', async () => {
    const { ws, env } = setup();
    const codex = (line: string): string => `if [ "$1" = login ]; then echo "${line}" >&2; exit 0; fi\nexit 2`;
    const cases: [string, string | null, string][] = [
      ['Logged in using an API key - sk-proj-***ABCDE', 'per-call', 'logged in using an API key'],
      ['Logged in using ChatGPT', 'subscription', 'logged in using ChatGPT'],
      ['Logged in using workload identity', null, 'logged in using workload identity'],
      ['ok', null, 'codex login status names no login kind'],
    ];
    for (const [line, billing, detail] of cases) {
      fakeBin(join(ws.root, 'bin'), { codex: codex(line) });
      const run = await ogw(ws, ['env', 'check', '--json'], { env });
      expect(run.stdout).not.toContain('sk-proj');
      const result = JSON.parse(run.stdout) as EnvCheckResult;
      expect(result.providerClis[0]).toEqual({ provider: 'codex', methods: ['sprite-gen-codex'], installed: true, loggedIn: true, billing, detail });
    }
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('provider CLI codex (sprite-gen-codex): installed yes, login yes, billing unknown (codex login status names no login kind)\n');
  });

  it('records UDP no for a connected device whose datagram does not arrive', async () => {
    const { ws, env } = setup();
    fakeBin(join(ws.root, 'bin'), { adb: 'if [ "$1" = devices ]; then printf "List of devices attached\\nemu1\\tdevice\\n"; fi\nexit 0' });
    setUdpWaitMs(200);
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(result.testDevices).toEqual([
      { serial: 'emu1', connected: true, udp: lanAddress() === null ? null : false },
      { serial: 'phone2', connected: false, udp: null },
    ]);
    if (lanAddress() !== null) expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('test device emu1: connected yes, UDP no\n');
  });

  it('records UDP unknown when adb shell fails and nothing arrives', async () => {
    const { ws, env } = setup();
    fakeBin(join(ws.root, 'bin'), { adb: 'if [ "$1" = devices ]; then printf "List of devices attached\\nemu1\\tdevice\\n"; exit 0; fi\necho "nc: unknown option u" >&2\nexit 1' });
    setUdpWaitMs(200);
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(result.testDevices).toEqual([
      { serial: 'emu1', connected: true, udp: null },
      { serial: 'phone2', connected: false, udp: null },
    ]);
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('test device emu1: connected yes, UDP unknown\n');
  });

  it('ends the device send on its own: UDP no when the datagram does not arrive', async () => {
    const { ws, env } = setup();
    // longer than the 1 s `nc -q 1` waits after its stdin ends
    setUdpWaitMs(3000);
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env: { ...env, FAKE_NC_UNREACHABLE: '1' } })).stdout) as EnvCheckResult;
    if (lanAddress() === null) return;
    expect(result.testDevices[0]).toEqual({ serial: 'emu1', connected: true, udp: false });
    expect(readFileSync(join(ws.root, 'bin', 'adb-ended'), 'utf8')).toBe('0\n');
  });

  it('records UDP yes when the datagram arrives and UDP no when it does not, while adb shell has not ended', async () => {
    const { ws, env } = setup();
    // room for a datagram that a loaded host delivers late
    setUdpWaitMs(2000);
    for (const [extra, udp] of [[{}, true], [{ FAKE_NC_UNREACHABLE: '1' }, false]] as const) {
      const started = Date.now();
      const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env: { ...env, FAKE_NC_HANG: '1', ...extra } })).stdout) as EnvCheckResult;
      // well within the 60 s limit of adb shell
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.testDevices[0]).toEqual({ serial: 'emu1', connected: true, udp: lanAddress() === null ? null : udp });
    }
    // the adb shell runs still going were killed
    expect(existsSync(join(ws.root, 'bin', 'adb-ended'))).toBe(false);
  });

  it('reports the hf pin secrets the host secret store lacks', async () => {
    const { ws, env } = setup();
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    const hf = (source: string, secret?: string): Record<string, unknown> => ({ kind: 'hf', source, revision: 'a'.repeat(40), files: '*', ...(secret === undefined ? {} : { secret }) });
    settings.resourceGeneration = [
      { name: 'm1', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, pins: [hf('o/open'), hf('o/gated', 'huggingface')] },
      { name: 'm2', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, pins: [hf('o/other', 'hf2')] },
      { name: 'm3', kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1 },
    ];
    writeFileSync(settingsFile, JSON.stringify(settings));
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/hf2': 'token' }));
    const result = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(result.pinSecrets).toEqual([
      { secret: 'huggingface', method: 'm1', source: 'o/gated', stored: false },
      { secret: 'hf2', method: 'm2', source: 'o/other', stored: true },
    ]);
    const text = (await ogw(ws, ['env', 'check'], { env })).stdout;
    expect(text).toContain('pin secret huggingface (m1 o/gated): missing\n');
    expect(text).toContain('pin secret hf2 (m2 o/other): stored\n');
  });

  it('reports the agent login token when the play or judge agent CLI is Claude Code', async () => {
    const { ws, env } = setup();
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { agents: Record<string, { cli?: string }> };
    const missing = JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult;
    expect(missing.agentLoginToken).toEqual({ needed: true, stored: false, valueProblem: null, run: null });
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('agent login token claude-code-oauth-token: missing\n');
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'token' }));
    // the token check run: the play prompt run with the token and stream-json output
    const stored = (JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult).agentLoginToken;
    expect(stored).toMatchObject({ needed: true, stored: true, run: { role: 'play', ok: true, authFailed: false, exitCode: 0 } });
    expect(stored?.run?.output).toBe(`sandboxed ok tmp own-tmp [${agentCliCommand({ model: 'm', effort: 'high' }).args.join(' ')} --no-session-persistence --output-format stream-json --verbose] Reply with the single word ok.`);
    // Claude Code with stream-json output: `token` passes, `offline` fails otherwise, any other token fails to authenticate
    fakeBin(join(ws.root, 'bin'), {
      claude: [
        'if [ "$1" = auth ]; then exit 0; fi',
        '/bin/cat > /dev/null',
        'case "$*" in *"--output-format stream-json --verbose") ;; *) echo ok; exit 0;; esac',
        // the fake sandbox prints before the CLI: the first line is not a message
        'echo \'{"type":"system","subtype":"init"}\'',
        'case "$CLAUDE_CODE_OAUTH_TOKEN" in',
        '  token) echo \'{"type":"result","is_error":false,"result":"ok"}\'; exit 0;;',
        '  offline) echo "connect ECONNREFUSED" >&2; exit 1;;',
        '  blank) echo \'{"type":"result","is_error":true,"result":""}\'; echo "rate limited" >&2; exit 1;;',
        'esac',
        'echo \'{"type":"assistant","error":"authentication_failed","message":{"content":[]}}\'',
        'echo \'{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}\'',
        'exit 1',
      ].join('\n'),
    });
    const tokenText = async (token: string): Promise<string> => {
      writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': token }));
      return (await ogw(ws, ['env', 'check'], { env })).stdout;
    };
    expect(await tokenText('token')).toContain('agent login token claude-code-oauth-token: valid\n');
    expect(await tokenText('expired')).toContain('agent login token claude-code-oauth-token: invalid: Failed to authenticate. API Error: 401 Invalid bearer token\n');
    expect(await tokenText('blank')).toContain('agent login token claude-code-oauth-token: unverified: rate limited\n');
    expect(await tokenText('offline')).toContain('agent login token claude-code-oauth-token: unverified: connect ECONNREFUSED\n');
    const unverified = (JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult).agentLoginToken;
    expect(unverified).toEqual({ needed: true, stored: true, valueProblem: null, run: { role: 'play', ok: false, authFailed: false, exitCode: 1, output: 'connect ECONNREFUSED' } });
    // a stored value that cannot be a Bearer value is invalid without a run (a run would fail as `offline`)
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'off\nline' }));
    const wrapped = (JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult).agentLoginToken;
    expect(wrapped).toEqual({ needed: true, stored: true, valueProblem: 'character 4 is a whitespace', run: null });
    expect((await ogw(ws, ['env', 'check'], { env })).stdout).toContain('agent login token claude-code-oauth-token: invalid: not an HTTP Authorization Bearer value: character 4 is a whitespace\n');
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'token' }));
    // one Claude Code role is enough
    for (const [play, judge] of [['claude-code', 'codex'], ['codex', 'claude-code']]) {
      settings.agents.play = { ...settings.agents.play, cli: play };
      settings.agents.judge = { ...settings.agents.judge, cli: judge };
      writeFileSync(settingsFile, JSON.stringify(settings));
      expect((JSON.parse((await ogw(ws, ['env', 'check', '--json'], { env })).stdout) as EnvCheckResult).agentLoginToken?.needed).toBe(true);
    }
    for (const role of ['play', 'judge']) settings.agents[role] = { ...settings.agents[role], cli: 'codex' };
    writeFileSync(settingsFile, JSON.stringify(settings));
    const codex = await ogw(ws, ['env', 'check'], { env });
    expect(codex.stdout).not.toContain('agent login token');
  });

  it('with --for, only checks the tools items of that core command', async () => {
    const { ws, env } = setup();
    expect(await ogw(ws, ['env', 'check', '--for', 'create-server-core'], { env })).toMatchObject({ code: 1, stdout: 'missing: tools.postgresql\nRun update env first.\n' });
    const pg = { ...env, OGW_TEST_PG: '1' };
    expect(await ogw(ws, ['env', 'check', '--for', 'create-server-core'], { env: pg })).toMatchObject({ code: 0, stdout: 'all present\n' });
    expect(await ogw(ws, ['env', 'check', '--for', 'create-client-core'], { env: pg })).toMatchObject({ code: 1, stdout: 'missing: tools.chromium\nRun update env first.\n' });
    expect(await ogw(ws, ['env', 'check', '--for', 'update-core', '--json'], { env })).toMatchObject({ code: 1, stdout: expect.stringContaining('"tools.postgresql",\n    "tools.chromium",\n    "tools.gdtoolkit"') as unknown });
    for (const target of ['build', 'toString', 'constructor', 'hasOwnProperty']) {
      expect(await ogw(ws, ['env', 'check', '--for', target], { env })).toMatchObject({ code: 1, stderr: '--for must be create-server-core, create-client-core or update-core\n' });
    }
    expect(existsSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'))).toBe(false);
  });

  it('with --for, finds chromium and gdtoolkit once they are pinned and installed', async () => {
    const { ws, env: base } = setup();
    const env = { ...base, OGW_TEST_PG: '1' };
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { tools: Record<string, unknown> };
    const download = (name: string, sha: string): Record<string, string> => ({ platform: 'any', url: `https://x/${name}`, sha256: sha.repeat(64) });
    settings.tools.chromium = { version: '155.0.1', downloads: [download('chromium.zip', 'e')] };
    settings.tools.gdtoolkit = { version: '4.3.4', python: '3.13', downloads: [download('gdtoolkit.whl', 'f')], dependencies: [download('lark.whl', '1')] };
    writeFileSync(settingsFile, JSON.stringify(settings));
    // pinned, not installed
    expect(await ogw(ws, ['env', 'check', '--for', 'create-client-core'], { env })).toMatchObject({ code: 1, stdout: 'missing: tools.chromium\nRun update env first.\n' });
    const tools = join(ws.root, '.ogw', 'tools');
    installed(join(tools, 'chromium', '155.0.1'), ['e'.repeat(64)], 'chrome');
    expect(await ogw(ws, ['env', 'check', '--for', 'create-client-core'], { env })).toMatchObject({ code: 0, stdout: 'all present\n' });
    expect(await ogw(ws, ['env', 'check', '--for', 'update-core'], { env })).toMatchObject({ code: 1, stdout: 'missing: tools.gdtoolkit\nRun update env first.\n' });
    // the gdtoolkit wheel without its dependency wheel is not the pin
    installed(join(tools, 'gdtoolkit', '4.3.4'), ['f'.repeat(64)], 'gdlint');
    expect(await ogw(ws, ['env', 'check', '--for', 'update-core'], { env })).toMatchObject({ code: 1, stdout: 'missing: tools.gdtoolkit\nRun update env first.\n' });
    installed(join(tools, 'gdtoolkit', '4.3.4'), ['f'.repeat(64), '1'.repeat(64)], 'gdlint');
    expect(await ogw(ws, ['env', 'check', '--for', 'update-core'], { env })).toMatchObject({ code: 0, stdout: 'all present\n' });
    expect(await ogw(ws, ['env', 'check', '--for', 'update-core'], { env: base })).toMatchObject({ code: 1, stdout: 'missing: tools.postgresql\nRun update env first.\n' });
  });
});
