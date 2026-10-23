import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNet, type RemoteRef } from '../../../src/commands/env/lib/net.ts';
import { parseRequirement } from '../../../src/commands/env/lib/pep440.ts';
import { pyprojectDependencies, tomlStrings } from '../../../src/commands/env/lib/proposals.ts';
import { changedParts, proposalParts } from '../../../src/commands/env/propose.ts';
import { hostOf, markerFits, WHEEL_PLATFORMS } from '../../../src/commands/env/lib/wheels.ts';
import { pipRequirements } from '../../../src/commands/generation/lib/install.ts';
import { NOT_INSTALLED } from '../../../src/commands/generation/measure.ts';
import { ogw, hostForm, makeWorkspace, realToolsWithout, TEST_HOST_ID, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet, type Route } from './fakes.ts';

const role = vi.hoisted(() => ({ value: 'lead' }));
vi.mock('../../../src/lib/agentctx.ts', async (actual) => ({
  ...(await actual<object>()),
  agentContext: async () => {
    const { join: joinPath } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const meta = { role: role.value, cliPid: null, output: joinPath(tmpdir(), 'out.md'), runLog: joinPath(tmpdir(), 'out-runs.json') };
    return role.value === 'lead' ? null : { job: { id: 'job1' }, meta };
  },
}));

const COMMIT = 'f'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;
const SPRITE = 'https://github.com/aldegad/sprite-gen.git';
/** The repository of the `x @ git+https://h/x@abc` dependency and its branch `abc`. */
const X_REPO = 'https://h/x';
const X_COMMIT = 'a'.repeat(40);
const X_REFS = [{ id: X_COMMIT, ref: 'refs/heads/abc' }];

const PYPROJECT = `[project]
name = "sprite-gen"
dependencies = [
  "pillow>=10,<12",
  'numpy',
  "pywin32; sys_platform == 'win32'",
  "rich[jupyter]~=13.0",
  "x @ git+https://h/x@abc",
]

[project.optional-dependencies]
dev = ["pytest"]
`;

function file(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { filename: name, url: `https://files/${name}`, digests: { sha256: name.length.toString(16).padStart(64, '0') }, ...extra };
}

function routes(): Record<string, Route> {
  return {
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull': { token: 'tkn' },
    'https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000': () => ({
      status: 200,
      headers: { link: '</v2/library/postgres/tags/list?last=18.2&n=1000>; rel="next"' },
      body: Buffer.from(JSON.stringify({ tags: ['18.2', '18.10-alpine', '17.9', 'latest'] })),
    }),
    'https://registry-1.docker.io/v2/library/postgres/tags/list?last=18.2&n=1000': { tags: ['18.7', '18.10', '19.0'] },
    'https://registry-1.docker.io/v2/library/postgres/manifests/18.10': (init) => ({
      status: init.method === 'HEAD' && init.headers?.Authorization === 'Bearer tkn' && (init.headers.Accept ?? '').includes('image.index') ? 200 : 400,
      headers: { 'docker-content-digest': DIGEST },
      body: Buffer.alloc(0),
    }),
    'https://pypi.org/pypi/pillow/json': { releases: { '10.0.0': [file('p10')], '11.3.0': [file('p11')], '12.0.0': [file('p12')], '11.4.0': [file('y', { yanked: true })], '11.5.0': [] } },
    'https://pypi.org/pypi/numpy/json': { releases: { '1.26.4': [file('n1', { requires_python: '>=3.9' })], '2.3.1': [file('n', { requires_python: '>=3.11' })], '2.4.0rc1': [file('nrc')] } },
    'https://pypi.org/pypi/tomli/json': { releases: { '2.2.1': [file('t')] } },
    'https://pypi.org/pypi/rich/json': { releases: { '13.9.4': [file('r')], '14.0.0': [file('r14')] } },
    'https://pypi.org/pypi/gdtoolkit/json': {
      releases: {
        '4.3.4': [file('gdtoolkit-4.3.4-py3-none-any.whl'), file('gdtoolkit-4.3.4.tar.gz')],
        '4.5.0rc1': [file('gdtoolkit-4.5.0rc1-py3-none-any.whl')],
        '4.4.0': [file('gdtoolkit-4.4.0.tar.gz')],
        '4.3.5': [file('gdtoolkit-4.3.5-py3-none-any.whl', { yanked: true })],
        '3.9.0': [file('gdtoolkit-3.9.0-py3-none-any.whl')],
        '4.1.0': [file('gdtoolkit-4.1.0-py3-none-any.whl')],
      },
    },
    'https://pypi.org/pypi/gdtoolkit/4.3.4/json': {
      info: { requires_dist: ['lark[regex]==1.2.2', 'pyyaml>=5.1', "pywin32>=1; sys_platform == 'win32'", "pytest; extra == 'dev'", "oldpkg; python_version < '3.5'"] },
      urls: [],
    },
    'https://pypi.org/pypi/lark/json': { releases: { '1.2.2': [file('lark-1.2.2-py3-none-any.whl')] } },
    'https://pypi.org/pypi/lark/1.2.2/json': { info: { requires_dist: ["regex; extra == 'regex'", "js2py; extra == 'nearley'"] }, urls: [] },
    'https://pypi.org/pypi/regex/json': { releases: { '2026.1.1': WHEELS('regex-2026.1.1', 'macosx_10_13_universal2') } },
    'https://pypi.org/pypi/regex/2026.1.1/json': { info: { requires_dist: null }, urls: [] },
    'https://pypi.org/pypi/pyyaml/json': { releases: { '6.0.3': WHEELS('pyyaml-6.0.3', 'macosx_11_0_arm64'), '7.0.0': [file('pyyaml-7.0.0.tar.gz')] } },
    'https://pypi.org/pypi/pyyaml/6.0.3/json': { info: { requires_dist: [] }, urls: [] },
    'https://pypi.org/pypi/pywin32/json': { releases: { '311': [file('pywin32-311-cp314-cp314-win_amd64.whl')] } },
    'https://pypi.org/pypi/pywin32/311/json': { info: {}, urls: [] },
    [FFMPEG_RELEASE]: {
      assets: [
        { name: 'ffmpeg-darwin-arm64', browser_download_url: 'https://gh/ffmpeg-darwin-arm64', digest: `sha256:${'a'.repeat(64)}` },
        { name: 'ffmpeg-linux-x64', browser_download_url: 'https://gh/ffmpeg-linux-x64', digest: `sha256:${'b'.repeat(64)}` },
        { name: 'ffmpeg-win32-x64', browser_download_url: 'https://gh/ffmpeg-win32-x64', digest: `sha256:${'c'.repeat(64)}` },
        { name: 'darwin-arm64.README', browser_download_url: 'https://gh/readme', digest: null },
      ],
    },
  };
}

const FFMPEG_RELEASE = 'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/tags/b6.1.1';

/** cp314 wheels of a release for macOS (with that platform tag), Linux and Windows. */
function WHEELS(prefix: string, mac: string): Record<string, unknown>[] {
  return [file(`${prefix}-cp314-cp314-${mac}.whl`), file(`${prefix}-cp314-cp314-manylinux_2_17_x86_64.whl`), file(`${prefix}-cp314-cp314-win_amd64.whl`)];
}

function entry(platform: string, name: string): Record<string, unknown> {
  return { platform, url: `https://files/${name}`, sha256: (file(name).digests as { sha256: string }).sha256 };
}

/** The entry of another host in `hosts`: no proposal of this host changes it. */
const OTHER_HOST = { ['f'.repeat(32)]: { name: 'other', maxConcurrentInstances: 6, playInstances: 2, measured: { 'flux2-klein': [{ resolution: 2048, result: 'ok' }] } } };

/** This host's entry of the harness settings file. */
function thisHost(path: string): { name: string; maxConcurrentInstances?: number; playInstances?: number; measured?: Record<string, unknown> } {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { hosts: Record<string, ReturnType<typeof thisHost>> };
  expect(file.hosts['f'.repeat(32)]).toEqual(OTHER_HOST['f'.repeat(32)]);
  const entry = file.hosts[TEST_HOST_ID];
  if (entry === undefined) throw new Error('no entry of this host');
  return entry;
}

const METHODS = [
  { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image', 'icon'], safetyTimeoutMs: 1, license: 'X', measured: [{ resolution: 512, jobMs: 1, result: 'ok' }] },
  { name: 'same', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', measured: [{ durationMs: 1000, jobMs: 5, result: 'ok' }] },
  { name: 'broken', kind: 'local-model', resourceTypes: ['sfx'], safetyTimeoutMs: 1, license: 'X' },
  { name: 'sprite', kind: 'external-service', provider: 'codex', resourceTypes: ['sprite_animation'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: SPRITE }] },
  { name: 'cat', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, pins: [{ kind: 'git', source: 'https://x/f.git', revision: COMMIT }] },
];

/** The `uv pip compile --python-platform` target of each host platform. */
const TARGETS = { 'macos-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'windows-x64': 'x86_64-pc-windows-msvc' } as const;

/** What the fake `uv pip compile` prints for each target of the PYPROJECT dependencies: transitive markdown-it-py, pywin32 only on Windows. */
const RESOLVED = `markdown-it-py==3.0.0\nnumpy==2.3.1\npillow==11.3.0\nrich==13.9.4\nx @ git+https://h/x@${X_COMMIT}\n`;
const MERGED = `markdown-it-py==3.0.0,numpy==2.3.1,pillow==11.3.0,pywin32==311 ; sys_platform == 'win32',rich==13.9.4,x @ git+https://h/x@${X_COMMIT}`;

/**
 * Sets what the fake `uv pip compile` gives for each host platform: the requirements file it writes, or `{ error }`,
 * which it prints to stderr and exits 1.
 */
function resolveTo(uv: string, outputs: Partial<Record<keyof typeof TARGETS, string | { error: string }>>): void {
  for (const [platform, output] of Object.entries(outputs)) {
    const target = TARGETS[platform as keyof typeof TARGETS];
    rmSync(join(uv, `${target}.txt`), { force: true });
    rmSync(join(uv, `${target}.err`), { force: true });
    if (typeof output === 'string') writeFileSync(join(uv, `${target}.txt`), output);
    else writeFileSync(join(uv, `${target}.err`), output.error);
  }
}

/** The last `uv pip compile` call of the fake for a target: its arguments (input `IN`, output `OUT`), folder, input path and input lines. */
interface CompileCall {
  args: string;
  cwd: string;
  input: string;
  lines: string[];
}

/** The last `uv pip compile` call for each target that had one, in TARGETS order. */
function compileCalls(uv: string): CompileCall[] {
  return Object.values(TARGETS).flatMap((target) => {
    const log = join(uv, `call-${target}.log`);
    if (!existsSync(log)) return [];
    const [args = '', cwd = '', input = '', ...lines] = readFileSync(log, 'utf8').split('\n').filter((l) => l !== '');
    return [{ args, cwd, input, lines }];
  });
}

function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv; uv: string } {
  const ws = makeWorkspace({ tools: realToolsWithout('ffmpeg', 'gdtoolkit'), resourceGeneration: METHODS, hosts: OTHER_HOST });
  mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
  // `uv python find --system` names the Python of the method environments (`uv venv`): CPython 3.<OGW_TEST_PY_MINOR or 12>.
  // Without `--system`, as uv does, it names the Python of the active virtual environment `$VIRTUAL_ENV` first.
  // `uv pip compile` logs each call to $OGW_TEST_UV/calls.log and gives the output resolveTo set for its target.
  const bin = join(ws.root, 'bin');
  const uv = join(ws.root, 'uv');
  mkdirSync(uv, { recursive: true });
  resolveTo(uv, { 'macos-arm64': RESOLVED, 'linux-x64': RESOLVED, 'windows-x64': `${RESOLVED}pywin32==311\n` });
  fakeBin(bin, {
    uv: [
      'if [ "$1 $2 $3" = "python find " ] && [ -n "$VIRTUAL_ENV" ]; then echo "$VIRTUAL_ENV/bin/python"; exit 0; fi',
      `if [ "$1 $2" = "python find" ]; then echo "${join(bin, 'venv-python')}"; exit 0; fi`,
      'if [ "$1 $2 $3" = "--no-config pip compile" ]; then',
      '  in="$4"; all="$*"',
      '  while [ $# -gt 0 ]; do case "$1" in --python-platform) p="$2";; --output-file) o="$2";; esac; shift; done',
      '  { echo "$all" | sed "s#$in#IN#; s#$o#OUT#"; pwd; echo "$in"; cat "$in"; } > "$OGW_TEST_UV/call-$p.log"',
      '  if [ -f "$OGW_TEST_UV/$p.err" ]; then cat "$OGW_TEST_UV/$p.err" >&2; exit 1; fi',
      '  cp "$OGW_TEST_UV/$p.txt" "$o"; exit 0',
      'fi',
      'exit 9',
    ].join('\n'),
    'venv-python': 'if [ "$1" = --version ]; then echo "Python 3.${OGW_TEST_PY_MINOR:-12}.4"; exit 0; fi\nexit 9',
  });
  const env = { ...ws.env, PATH: `${bin}:${ws.env.PATH ?? ''}`, TMPDIR: join(ws.root, 'tmp'), OGW_TEST_UV: uv };
  const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  };
  write('generation-measure', {
    measuredAt: 1,
    methods: {
      'flux2-klein': { kind: 'local-model', error: null, steps: [{ resolution: 512, jobMs: 9, result: 'ok', maxMemoryBytes: 5, output: '/o', blocked: [] }, { resolution: 1024, jobMs: 20, result: 'timeout', maxMemoryBytes: 7, output: '/o', blocked: [] }] },
      same: { kind: 'local-model', error: null, steps: [{ durationMs: 1000, jobMs: 5, result: 'ok', maxMemoryBytes: 1, output: '/o', blocked: [] }] },
      broken: { kind: 'local-model', error: 'not defined', steps: [] },
      cat: { kind: 'catalog', error: null, steps: [{ result: 'ok', maxMemoryBytes: null, output: null, blocked: [] }] },
    },
  });
  write('instance-measure', { measuredAt: 1, targets: [{ name: 'benchmark-godot 1.0.0', kind: 'benchmark', value: 4, detail: null }, { name: 'g', kind: 'game', value: 2, detail: null }] });
  write('generation-install', { installedAt: 1, methods: {}, tools: { postgresql: { installed: false, reason: 'x', mismatches: [] } } });
  write('env-check', {
    checkedAt: 1,
    programs: { docker: { found: true, version: 'd' }, dockerBuildx: { found: false, version: null } },
    gh: { loggedIn: true, scopes: ['repo'] },
    testDevices: [{ serial: 'emu1', connected: true, udp: false }, { serial: 'p', connected: true, udp: true }],
    agentClis: [{ cli: 'codex', model: 'gpt', effort: 'high', roles: ['translation'], installed: true, loggedIn: true, run: { ok: false, exitCode: 2, output: 'boom' } }, { cli: 'claude-code', roles: [], installed: true, loggedIn: true, run: { ok: true, exitCode: 0, output: 'ok' } }],
    providerClis: [
      { provider: 'grok', methods: ['g1', 'g2'], installed: false, loggedIn: false, detail: null },
      { provider: 'codex', methods: ['c'], installed: true, loggedIn: true, billing: 'per-call', detail: 'logged in using an API key' },
      { provider: 'other', methods: ['o'], installed: true, loggedIn: true, billing: 'subscription', detail: null },
    ],
  });
  setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: PYPROJECT } }));
  return { ws, env, uv };
}

afterEach(() => {
  setNet(null);
  role.value = 'lead';
});

describe('ogw env propose', () => {
  it('computes the proposals and notices from the last results and the harness settings', async () => {
    const { ws, env, uv } = setup();
    const run = await ogw(ws, ['env', 'propose', '--json'], { env });
    expect(run.stderr).toBe('');
    const { proposals, notices } = JSON.parse(run.stdout) as { proposals: { id: string; path: string; current: unknown; value: unknown }[]; notices: { id: string; detail: string }[] };
    expect(proposals.map((p) => p.id)).toEqual(['measured:flux2-klein', 'measured:cat', 'maxConcurrentInstances', 'playInstances', 'tools.postgresql', 'pin:sprite', 'tools.gdtoolkit', 'tools.ffmpeg']);
    expect(proposals[0]).toMatchObject({
      path: 'measured.flux2-klein',
      current: [{ resolution: 512, jobMs: 1, result: 'ok' }],
      value: [{ resolution: 512, jobMs: 9, result: 'ok' }, { resolution: 1024, jobMs: 20, result: 'timeout' }],
    });
    expect(proposals[1]).toMatchObject({ path: 'measured.cat', current: null, value: [{ result: 'ok' }] });
    expect(proposals[2]).toMatchObject({ path: 'maxConcurrentInstances', current: null, value: 2 });
    expect(proposals[3]).toMatchObject({ path: 'playInstances', current: 3, value: 2 });
    expect(proposals[4]).toMatchObject({ path: 'tools.postgresql', current: { tag: '18.6' }, value: { tag: '18.10', digest: DIGEST } });
    expect(proposals[5]).toMatchObject({
      path: 'resourceGeneration.3.pins',
      value: [
        { kind: 'git', source: SPRITE, revision: COMMIT },
        { kind: 'pip', source: MERGED },
      ],
    });
    // one uv pip compile per host platform, with the Python of the method environment, in a folder removed afterwards
    const calls = compileCalls(uv);
    expect(calls.map((c) => c.args)).toEqual(
      Object.values(TARGETS).map((target) => `--no-config pip compile IN --python-platform ${target} --python-version 3.12 --no-header --no-annotate --output-file OUT`),
    );
    for (const call of calls) {
      expect(call.lines).toEqual(['pillow>=10,<12', 'numpy', "pywin32 ; sys_platform == 'win32'", 'rich[jupyter]~=13.0', `x @ git+https://h/x@${X_COMMIT}`]);
      expect(call.input).toBe(join(call.cwd, 'requirements.in'));
      expect(existsSync(call.cwd)).toBe(false);
    }
    expect(proposals[6]).toMatchObject({
      path: 'tools.gdtoolkit',
      current: null,
    });
    expect(proposals[6]?.value).toEqual({
      version: '4.3.4',
      python: '3.14',
      downloads: [entry('any', 'gdtoolkit-4.3.4-py3-none-any.whl')],
      dependencies: [
        entry('any', 'lark-1.2.2-py3-none-any.whl'),
        entry('windows-x64', 'pywin32-311-cp314-cp314-win_amd64.whl'),
        entry('macos-arm64', 'pyyaml-6.0.3-cp314-cp314-macosx_11_0_arm64.whl'),
        entry('linux-x64', 'pyyaml-6.0.3-cp314-cp314-manylinux_2_17_x86_64.whl'),
        entry('windows-x64', 'pyyaml-6.0.3-cp314-cp314-win_amd64.whl'),
        entry('macos-arm64', 'regex-2026.1.1-cp314-cp314-macosx_10_13_universal2.whl'),
        entry('linux-x64', 'regex-2026.1.1-cp314-cp314-manylinux_2_17_x86_64.whl'),
        entry('windows-x64', 'regex-2026.1.1-cp314-cp314-win_amd64.whl'),
      ],
    });
    expect(proposals[7]).toEqual({
      id: 'tools.ffmpeg',
      path: 'tools.ffmpeg',
      current: null,
      value: {
        version: 'eugeneware/ffmpeg-static b6.1.1',
        downloads: [
          { platform: 'macos-arm64', url: 'https://gh/ffmpeg-darwin-arm64', sha256: 'a'.repeat(64) },
          { platform: 'linux-x64', url: 'https://gh/ffmpeg-linux-x64', sha256: 'b'.repeat(64) },
          { platform: 'windows-x64', url: 'https://gh/ffmpeg-win32-x64', sha256: 'c'.repeat(64) },
        ],
      },
      reason: 'tools.ffmpeg is missing; ffmpeg static build of eugeneware/ffmpeg-static b6.1.1',
    });
    expect(notices.map((n) => n.id)).toEqual(['no-method', 'docker', 'udp', 'agent-cli', 'provider-cli', 'provider-cli']);
    expect(notices[0]?.detail).toBe(
      'no method makes: sprite_sheet, texture_atlas, background, nine_slice, model, rig, material, texture, skybox, sprite_animation, rig_animation_2d, animation_3d, particle, shader, sfx, voice, haptic, tileset, app_icon, splash',
    );
    expect(notices[1]?.detail).toBe('docker buildx is missing; GitHub CLI login has no write:packages scope. Install them or log in with gh auth refresh --scopes write:packages');
    expect(notices[2]?.detail).toBe('UDP does not reach this host from: emu1. Put the devices on the same LAN as the host');
    expect(notices[3]?.detail).toBe('codex (model gpt, effort high) did not finish in an empty folder: boom');
    expect(notices[4]?.detail).toBe('grok CLI is not installed; used by g1, g2. Install it and log in');
    expect(notices[5]?.detail).toBe(
      'codex calls are billed per call (logged in using an API key); used by c. Tell the human before allowing those calls; a ChatGPT login (codex login) makes them use the subscription instead',
    );
    const text = await ogw(ws, ['env', 'propose'], { env });
    expect(text.stdout).toContain('proposal playInstances: playInstances\n  current 3\n  value 2\n  reason ');
    expect(text.stdout).toContain('notice udp: UDP does not reach');
  });

  it('says in provider-cli when provider calls are billed per call or may be', async () => {
    const { ws, env } = setup();
    const file = join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json');
    const check = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const providerClis = [
      { provider: 'grok', methods: ['g'], installed: false, loggedIn: false, billing: 'per-call', detail: 'no login file /h/auth.json; XAI_API_KEY is set' },
      { provider: 'codex', methods: ['c'], installed: true, loggedIn: true, billing: null, detail: 'logged in using workload identity' },
      { provider: 'other', methods: ['o'], installed: true, loggedIn: true, billing: 'subscription', detail: 'login file /h/auth.json' },
    ];
    writeFileSync(file, JSON.stringify({ ...check, providerClis }));
    const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { notices: { id: string; detail: string }[] };
    expect(out.notices.filter((n) => n.id === 'provider-cli').map((n) => n.detail)).toEqual([
      'grok CLI is not installed; grok calls are billed per call (no login file /h/auth.json; XAI_API_KEY is set); used by g. Install it and log in. Tell the human before allowing those calls; a Grok login (grok login) makes them use the subscription instead',
      'whether codex calls are billed per call is unknown (logged in using workload identity); used by c. A human has to check how this login bills calls before allowing them',
    ]);
  });

  it('gives only the benchmark notice and the no-loop notice from instance results', async () => {
    const { ws, env } = setup();
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    for (const name of ['generation-measure', 'generation-install', 'env-check']) writeFileSync(join(dir, `${name}.json`), 'null');
    writeFileSync(join(dir, 'instance-measure.json'), JSON.stringify({ measuredAt: 1, targets: [] }));
    const run = await ogw(ws, ['env', 'propose', '--json'], { env });
    const out = JSON.parse(run.stdout) as { proposals: { id: string }[]; notices: { id: string; detail: string }[] };
    expect(out.proposals.map((p) => p.id)).toEqual(['pin:sprite', 'tools.gdtoolkit', 'tools.ffmpeg']);
    expect(out.notices).toEqual([{ id: 'no-benchmark', detail: 'ogw instance measure had no target. Run update env again after create client core' }]);
    writeFileSync(join(dir, 'instance-measure.json'), JSON.stringify({ measuredAt: 1, targets: [{ name: 'g', kind: 'game', value: 1, detail: null }] }));
    const low = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as typeof out;
    expect(low.notices.map((n) => n.id)).toEqual(['no-loop']);
    expect(low.proposals.map((p) => p.id)).toEqual(['pin:sprite', 'tools.gdtoolkit', 'tools.ffmpeg']);
  });

  it('applies chosen proposals to the harness settings after the checks', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');
    expect(await ogw(ws, ['env', 'propose', '--apply', 'measured:flux2-klein'], { env })).toMatchObject({ code: 1, stderr: 'no proposal was shown: run ogw env propose first\n' });
    expect((await ogw(ws, ['env', 'propose'], { env })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-propose.json'), 'utf8'))).toHaveLength(8);
    expect(await ogw(ws, ['env', 'propose', '--apply', 'measured:flux2-klein,nothing'], { env })).toMatchObject({ code: 1, stderr: 'no proposal with id: nothing\n' });
    role.value = 'content';
    expect(await ogw(ws, ['env', 'propose', '--apply', 'playInstances'], { env })).toMatchObject({ code: 1, stderr: `role content cannot change hosts.${TEST_HOST_ID}.playInstances\n` });
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    role.value = 'lead';
    const run = await ogw(ws, ['env', 'propose', '--apply', 'measured:flux2-klein, maxConcurrentInstances,pin:sprite'], { env });
    expect(run).toMatchObject({ code: 0, stdout: 'applied: measured:flux2-klein, maxConcurrentInstances, pin:sprite\n' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { $schema: string; maxConcurrentInstances?: number; resourceGeneration: { measured?: unknown; pins?: unknown[] }[] };
    expect(Object.keys(after)[0]).toBe('$schema');
    expect(after.maxConcurrentInstances).toBeUndefined();
    expect(thisHost(settingsPath)).toEqual({
      name: hostname(),
      maxConcurrentInstances: 2,
      measured: { 'flux2-klein': [{ resolution: 512, jobMs: 9, result: 'ok' }, { resolution: 1024, jobMs: 20, result: 'timeout' }], same: [{ durationMs: 1000, jobMs: 5, result: 'ok' }] },
    });
    expect(after.resourceGeneration[0]?.measured).toBeUndefined();
    expect(after.resourceGeneration[3]?.pins).toHaveLength(2);
  });

  it('applies the measured steps of a method whose name has a .', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    settings.resourceGeneration.push({ name: 'sd.xl', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X' });
    writeFileSync(settingsPath, JSON.stringify(settings));
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    const step = { resolution: 512, jobMs: 3, result: 'ok', maxMemoryBytes: 1, output: '/o', blocked: [] };
    writeFileSync(join(dir, 'generation-measure.json'), JSON.stringify({ measuredAt: 1, methods: { 'sd.xl': { kind: 'local-model', error: null, steps: [step] } } }));
    expect((await ogw(ws, ['env', 'propose'], { env })).stdout).toContain('proposal measured:sd.xl: measured.sd.xl\n');
    expect(await ogw(ws, ['env', 'propose', '--apply', 'measured:sd.xl'], { env })).toMatchObject({ code: 0, stdout: 'applied: measured:sd.xl\n' });
    expect(thisHost(settingsPath).measured).toEqual({ 'flux2-klein': [{ resolution: 512, jobMs: 1, result: 'ok' }], same: [{ durationMs: 1000, jobMs: 5, result: 'ok' }], 'sd.xl': [{ resolution: 512, jobMs: 3, result: 'ok' }] });
  });

  it('writes nothing when the result would not pass the schema', async () => {
    const { ws, env } = setup();
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    writeFileSync(
      join(dir, 'generation-measure.json'),
      JSON.stringify({ measuredAt: 1, methods: { same: { kind: 'local-model', error: null, steps: [{ durationMs: 0, result: 'ok', maxMemoryBytes: 1, output: null, blocked: [] }] } } }),
    );
    const settingsPath = join(ws.harness, 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');
    await ogw(ws, ['env', 'propose'], { env });
    const run = await ogw(ws, ['env', 'propose', '--apply', 'measured:same'], { env });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`hosts.${TEST_HOST_ID}.measured.same.0.durationMs`);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('applies a proposal while an unrelated required value is missing, as ogw settings set does', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    delete settings.resourceGeneration[2]?.license;
    writeFileSync(settingsPath, JSON.stringify(settings));
    await ogw(ws, ['env', 'propose'], { env });
    expect(await ogw(ws, ['env', 'propose', '--apply', 'measured:flux2-klein'], { env })).toMatchObject({ code: 0, stdout: 'applied: measured:flux2-klein\n' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    expect(thisHost(settingsPath).measured?.['flux2-klein']).toEqual([{ resolution: 512, jobMs: 9, result: 'ok' }, { resolution: 1024, jobMs: 20, result: 'timeout' }]);
    expect(after.resourceGeneration[2]?.license).toBeUndefined();
  });

  it('reads the Godot major of a version without a patch number', async () => {
    for (const godot of ['4.5.stable', '4.5.1.stable']) {
      const { ws, env } = setup();
      writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ godot }));
      const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { proposals: { id: string; value: { version?: string } }[] };
      expect(out.proposals.find((p) => p.id === 'tools.gdtoolkit')?.value.version).toBe('4.3.4');
    }
  });

  it('resolves with the Python of the method environment and leaves out dependencies that hold on no host platform', async () => {
    const pyproject = `[project]\ndependencies = ["numpy<2; python_version<'3.10'", "numpy>=2; python_version>='3.10'", "tomli; python_version<'3.11'", "appnope; sys_platform == 'cygwin'"]\n`;
    const calls = async (minor: string, activeVenv = false): Promise<CompileCall[]> => {
      const { ws, env, uv } = setup();
      // an active virtual environment with CPython 3.9, which uv venv does not use
      const venv = join(ws.root, 'active-venv');
      fakeBin(join(venv, 'bin'), { python: 'if [ "$1" = --version ]; then echo "Python 3.9.18"; exit 0; fi\nexit 9' });
      setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: pyproject } }));
      const run = await ogw(ws, ['env', 'propose', '--json'], { env: { ...env, OGW_TEST_PY_MINOR: minor, ...(activeVenv ? { VIRTUAL_ENV: venv } : {}) } });
      expect(run.stderr).toBe('');
      return compileCalls(uv);
    };
    const at12 = await calls('12');
    expect(at12.map((c) => [c.args.includes('--python-version 3.12 '), c.lines])).toEqual(Array(3).fill([true, ["numpy>=2 ; python_version>='3.10'"]]));
    const active = await calls('12', true);
    expect(active.map((c) => [c.args.includes('--python-version 3.12 '), c.lines])).toEqual(Array(3).fill([true, ["numpy>=2 ; python_version>='3.10'"]]));
    const at9 = await calls('9');
    expect(at9.map((c) => [c.args.includes('--python-version 3.9 '), c.lines])).toEqual(Array(3).fill([true, ["numpy<2 ; python_version<'3.10'", "tomli ; python_version<'3.11'"]]));
  });

  it('merges the resolution of each host platform into one pip pin, transitive packages included', async () => {
    const { ws, env, uv } = setup();
    const pyproject = `[project]\ndependencies = ["numpy", "rich", "torch>=2.9"]\n`;
    setNet(fakeNet({ ...routes(), 'https://pypi.org/pypi/torch/json': { releases: {} } }, { lsRemote: { [SPRITE]: COMMIT }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: pyproject } }));
    resolveTo(uv, {
      'macos-arm64': '# a comment\nnumpy==2.3.1\nrich==14.0.0\n\ntorch==2.9.1\n',
      'linux-x64': 'numpy==2.3.1\nnvidia-cublas==12.0    # via torch\nrich==14.0.0\ntorch==2.10.0\n',
      'windows-x64': 'numpy==2.3.1\nrich==13.9.4\ntorch==2.10.0\npywin32==311\n',
    });
    const run = await ogw(ws, ['env', 'propose', '--json'], { env });
    expect(run.stderr).toBe('');
    const proposal = (JSON.parse(run.stdout) as { proposals: { id: string; value: { source: string }[]; reason: string }[] }).proposals.find((p) => p.id === 'pin:sprite');
    const source = proposal?.value.at(-1)?.source ?? '';
    expect(pipRequirements(source)).toEqual([
      'numpy==2.3.1',
      "nvidia-cublas==12.0 ; sys_platform == 'linux'",
      "pywin32==311 ; sys_platform == 'win32'",
      "rich==14.0.0 ; sys_platform == 'darwin' or sys_platform == 'linux'",
      "rich==13.9.4 ; sys_platform == 'win32'",
      "torch==2.9.1 ; sys_platform == 'darwin'",
      "torch==2.10.0 ; sys_platform == 'linux' or sys_platform == 'win32'",
    ]);
    // pip on each host platform sees exactly the packages uv resolved for it
    const onEachPlatform = Object.fromEntries(
      WHEEL_PLATFORMS.map((platform) => [
        platform,
        pipRequirements(source).flatMap((text) => {
          const r = parseRequirement(text);
          return r && markerFits(r.marker, hostOf(platform), 12, new Set()) ? [`${r.name}${r.specifiers.join(',')}`] : [];
        }),
      ]),
    );
    expect(onEachPlatform).toEqual({
      'macos-arm64': ['numpy==2.3.1', 'rich==14.0.0', 'torch==2.9.1'],
      'linux-x64': ['numpy==2.3.1', 'nvidia-cublas==12.0', 'rich==14.0.0', 'torch==2.10.0'],
      'windows-x64': ['numpy==2.3.1', 'pywin32==311', 'rich==13.9.4', 'torch==2.10.0'],
    });
    expect(proposal?.reason).toBe(
      `git pins without revision (${SPRITE}): HEAD of the default branch; pip pins with the pyproject.toml dependencies (numpy, rich, torch), which win over pip pin items of the same project, resolved with uv pip compile for macos-arm64, linux-x64, windows-x64 CPython 3.12`,
    );
  });

  it('fails with the message of uv for the host platform it cannot resolve', async () => {
    const { ws, env, uv } = setup();
    const conflict = '  × No solution found when resolving dependencies:\n  ╰─▶ Because torch==2.14.1 depends on setuptools>=77.0.3 and you require setuptools==71.1.0, we can conclude that your requirements are unsatisfiable.\n';
    // a host platform that cannot resolve gets no packages and is named in the reason
    resolveTo(uv, { 'linux-x64': { error: conflict }, 'windows-x64': { error: 'other' } });
    const partly = await ogw(ws, ['env', 'propose', '--json'], { env });
    expect(partly.code).toBe(0);
    const reason = (JSON.parse(partly.stdout) as { proposals: { id: string; reason: string }[] }).proposals.find((p) => p.id.startsWith('pin:'))?.reason ?? '';
    expect(reason).toContain('no packages where the dependencies cannot be resolved: linux-x64: ');
    expect(reason).toContain('windows-x64: other');
    // no host platform resolves: the command fails with uv's message of the first
    resolveTo(uv, { 'macos-arm64': { error: conflict }, 'linux-x64': { error: conflict }, 'windows-x64': { error: 'other' } });
    expect(await ogw(ws, ['env', 'propose'], { env })).toMatchObject({ code: 1, stderr: `uv pip compile for macos-arm64 CPython 3.12 failed: ${conflict.trim()}\n` });
  });

  it('pins only a git+https:// or git+ssh:// repository of a dependency and gives git no other URL', async () => {
    const C = 'c'.repeat(40);
    const proposal = async (dependency: string): Promise<{ code: number; stderr: string; calls: string[]; leftOut: boolean }> => {
      const { ws, env } = setup();
      const fake = fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, 'ssh://git@h/clip.git': C }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: `[project]\ndependencies = ["${dependency}"]\n` } });
      setNet(fake);
      const run = await ogw(ws, ['env', 'propose', '--json'], { env });
      const reason = run.code === 0 ? ((JSON.parse(run.stdout) as { proposals: { id: string; reason: string }[] }).proposals.find((p) => p.id.startsWith('pin:'))?.reason ?? '') : '';
      const leftOut = reason.endsWith(`direct URL that is not a git+https:// or git+ssh:// repository, left out: ${dependency}`);
      return { code: run.code, stderr: run.stderr, calls: fake.calls.filter((c) => c.startsWith('ls-remote ') && !c.startsWith(`ls-remote ${SPRITE}`)), leftOut };
    };
    for (const url of [`--upload-pack=sh -c 'touch pwned'`, `--upload-pack=x@${C}`, 'file:///tmp/clip', '/tmp/clip', 'ext::sh -c x', 'ssh://-oProxyCommand=x/clip', 'ssh://-u@h/clip', 'https://h/a b', 'git://h/clip']) {
      expect(await proposal(`clip @ git+${url}`)).toEqual({ code: 0, stderr: '', calls: [], leftOut: true });
    }
    expect(await proposal('clip @ git+ssh://git@h/clip.git')).toEqual({ code: 0, stderr: '', calls: ['ls-remote ssh://git@h/clip.git HEAD'], leftOut: false });
  });

  it('pins each git direct reference to a commit and leaves out any other direct URL', async () => {
    // pip: the requirement uv pip compile gets
    const proposal = async (dependency: string, lsRemote: Record<string, string | RemoteRef[]> = {}): Promise<{ code: number; stderr: string; pip: string | undefined; calls: string[] }> => {
      const { ws, env, uv } = setup();
      const fake = fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, ...lsRemote }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: `[project]\ndependencies = ["${dependency}"]\n` } });
      setNet(fake);
      const run = await ogw(ws, ['env', 'propose', '--json'], { env });
      const pip = compileCalls(uv)[0]?.lines.join(',');
      return { code: run.code, stderr: run.stderr, pip, calls: fake.calls.filter((c) => c.startsWith('ls-remote https://h/')) };
    };
    const C = 'c'.repeat(40);
    expect(await proposal(`clip @ git+https://h/clip.git@${C}`)).toMatchObject({ code: 0, pip: `clip @ git+https://h/clip.git@${C}`, calls: [] });
    expect(await proposal('clip @ git+https://h/clip.git', { 'https://h/clip.git': C })).toMatchObject({ code: 0, pip: `clip @ git+https://h/clip.git@${C}`, calls: ['ls-remote https://h/clip.git HEAD'] });
    const T = 'e'.repeat(40);
    const D = 'd'.repeat(40);
    const F = 'f'.repeat(40);
    const v1 = { 'https://h/clip.git': [{ id: C, ref: 'refs/tags/v1' }] };
    expect(await proposal('clip @ git+https://h/clip.git@v1#subdirectory=py', v1)).toMatchObject({
      code: 0,
      pip: `clip @ git+https://h/clip.git@${C}#subdirectory=py`,
      calls: ['ls-remote https://h/clip.git refs/heads/v1 refs/tags/v1 refs/tags/v1^{}'],
    });
    // an annotated tag pins its commit (the peeled line), not the tag object
    const annotated = { 'https://h/clip.git': [{ id: T, ref: 'refs/tags/v1' }, { id: C, ref: 'refs/tags/v1^{}' }] };
    expect(await proposal('clip @ git+https://h/clip.git@v1', annotated)).toMatchObject({ code: 0, pip: `clip @ git+https://h/clip.git@${C}` });
    // a ref whose tail another ref shares: git lists refs/heads/feature/main first
    const tails = { 'https://h/clip.git': [{ id: F, ref: 'refs/heads/feature/main' }, { id: D, ref: 'refs/heads/main' }, { id: F, ref: 'refs/tags/x/main' }] };
    expect(await proposal('clip @ git+https://h/clip.git@main', tails)).toMatchObject({ code: 0, pip: `clip @ git+https://h/clip.git@${D}` });
    const both = { 'https://h/clip.git': [{ id: D, ref: 'refs/heads/v2' }, { id: F, ref: 'refs/tags/v2' }] };
    expect(await proposal('clip @ git+https://h/clip.git@v2', both)).toMatchObject({
      code: 1,
      stderr: 'dependency clip @ git+https://h/clip.git@v2: v2 names both the branch refs/heads/v2 and the tag refs/tags/v2\n',
    });
    // the extras stay on a direct reference, and a comma inside them does not split the pip pin
    expect(await proposal(`clip[train, eval] @ git+https://h/clip.git@${C}`)).toMatchObject({ code: 0, pip: `clip[train,eval] @ git+https://h/clip.git@${C}` });
    expect(await proposal('clip[train] @ git+https://h/clip.git@v1', v1)).toMatchObject({ code: 0, pip: `clip[train] @ git+https://h/clip.git@${C}` });
    expect(await proposal('clip @ git+https://h/clip.git@v9')).toMatchObject({ code: 1, stderr: 'dependency clip @ git+https://h/clip.git@v9: git ls-remote https://h/clip.git v9 found no commit\n' });
    const wheel = await proposal('w @ https://h/w-1.0-py3-none-any.whl');
    expect(wheel).toMatchObject({ code: 0, stderr: '' });
    expect(wheel.pip ?? '').not.toContain('w-1.0');
  });

  it('proposes the sha256 of installed hf pins and notices missing hf pin secrets', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    const D1 = '1'.repeat(64);
    const D2 = '2'.repeat(64);
    const gated = { kind: 'hf', source: 'o/gated', revision: COMMIT, files: 'model.safetensors,LICENSE.md', secret: 'huggingface' };
    const pinned = { kind: 'hf', source: 'o/pinned', revision: COMMIT, files: '*', sha256: D2 };
    const pins = [{ kind: 'git', source: 'https://x/m.git', revision: COMMIT }, gated, pinned];
    const lone = [{ kind: 'hf', source: 'o/lone', revision: COMMIT, files: '*' }];
    settings.resourceGeneration = [
      ...METHODS.slice(0, 3),
      { name: 'm3d', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins },
      { name: 'stale', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: lone },
      { name: 'absent', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: lone },
    ];
    writeFileSync(settingsPath, JSON.stringify(hostForm(settings)));
    const marker = (name: string, from: unknown[], hf: { source: string; sha256: string }[]): void => {
      const dir = join(ws.root, '.ogw', 'generation', name);
      mkdirSync(dir, { recursive: true });
      const entries = hf.map((h, i) => ({ ...h, dir: join(dir, 'hf', String(i)) }));
      writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name, pins: JSON.stringify(from), git: [], hf: entries, files: null, python: null, cli: null, skill: null }));
    };
    marker('m3d', pins, [{ source: 'o/gated', sha256: D1 }, { source: 'o/pinned', sha256: D2 }]);
    marker('stale', [{ ...lone[0], files: 'other' }], [{ source: 'o/lone', sha256: D1 }]);
    const check = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'), 'utf8')) as Record<string, unknown>;
    check.agentLoginToken = { needed: true, stored: false };
    check.pinSecrets = [
      { secret: 'huggingface', method: 'm3d', source: 'o/gated', stored: false },
      { secret: 'hf2', method: 'x', source: 'o/x', stored: true },
    ];
    writeFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'), JSON.stringify(check));

    const resultDir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    const installResult = (methods: Record<string, boolean> | null): void => {
      const path = join(resultDir, 'generation-install.json');
      const entries = Object.fromEntries(Object.entries(methods ?? {}).map(([name, installed]) => [name, { kind: 'local-model', installed, reason: installed ? null : 'x', mismatches: [] }]));
      writeFileSync(path, methods === null ? 'null' : JSON.stringify({ installedAt: 1, methods: entries, tools: {} }));
    };
    type Out = { proposals: { id: string }[]; notices: { id: string; detail: string }[] };
    const sha256Ids = async (): Promise<string[]> => (JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out).proposals.map((p) => p.id).filter((id) => id.startsWith('sha256:'));
    // A marker from an earlier install gives no proposal: only a method this run's install result lists as installed does.
    installResult(null);
    expect(await sha256Ids()).toEqual([]);
    installResult({ m3d: false, stale: true });
    expect(await sha256Ids()).toEqual([]);
    installResult({ m3d: true, stale: true });
    const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
    expect(out.proposals.filter((p) => p.id.startsWith('sha256:'))).toEqual([
      {
        id: 'sha256:m3d',
        path: 'resourceGeneration.3.pins',
        current: pins,
        value: [pins[0], { ...gated, sha256: D1 }, pinned],
        reason: 'hf pin has no sha256: SHA-256 of the files ogw generation install got',
      },
    ]);
    const store = "make a long-lived token with `claude setup-token` and store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness claude-code-oauth-token";
    expect(out.notices.filter((n) => n.id === 'agent-login-token')).toEqual([
      {
        id: 'agent-login-token',
        detail: `harness secret claude-code-oauth-token is not in the host secret store (missing): ${store}. Without it ogw loop start and ogw build start do not start`,
      },
    ]);
    const tokenNotices = async (agentLoginToken: unknown): Promise<Out['notices']> => {
      writeFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'), JSON.stringify({ ...check, agentLoginToken }));
      const again = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
      return again.notices.filter((n) => n.id === 'agent-login-token');
    };
    const tokenRun = { role: 'judge', exitCode: 1, output: 'Failed to authenticate. API Error: 401 Invalid bearer token' };
    expect(await tokenNotices({ needed: true, stored: true, run: { ...tokenRun, ok: false, authFailed: true } })).toEqual([
      {
        id: 'agent-login-token',
        detail: `Claude Code failed to authenticate with harness secret claude-code-oauth-token in the judge agent sandbox (invalid): Failed to authenticate. API Error: 401 Invalid bearer token. ${store}`,
      },
    ]);
    expect(await tokenNotices({ needed: true, stored: true, run: { ...tokenRun, ok: false, authFailed: false, output: 'connect ECONNREFUSED' } })).toEqual([
      {
        id: 'agent-login-token',
        detail:
          'the Claude Code run with harness secret claude-code-oauth-token in the judge agent sandbox failed without an authentication failure (unverified): connect ECONNREFUSED. Check this error',
      },
    ]);
    expect(await tokenNotices({ needed: true, stored: true, valueProblem: 'character 4 is a whitespace', run: null })).toEqual([
      {
        id: 'agent-login-token',
        detail: `harness secret claude-code-oauth-token is not an HTTP Authorization Bearer value: character 4 is a whitespace (invalid). ${store}`,
      },
    ]);
    // no notice when the token passed its run, when a result of an older ogw has no run, or when no play or judge agent uses Claude Code
    for (const agentLoginToken of [{ needed: true, stored: true, run: { ...tokenRun, ok: true, authFailed: false, output: 'ok' } }, { needed: true, stored: true }, { needed: false, stored: false }]) {
      expect(await tokenNotices(agentLoginToken)).toEqual([]);
    }
    writeFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-check.json'), JSON.stringify(check));
    expect(out.notices.filter((n) => n.id === 'pin-secret')).toEqual([
      {
        id: 'pin-secret',
        detail:
          'harness secret huggingface of hf pin o/gated (m3d) is not in the host secret store: accept the license on https://huggingface.co/o/gated with a Hugging Face account, then put an access token of that account in the host secret store: ogw secret set --harness huggingface',
      },
    ]);

    expect(await ogw(ws, ['env', 'propose', '--apply', 'sha256:m3d'], { env })).toMatchObject({ code: 0, stdout: 'applied: sha256:m3d\n' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: { pins: Record<string, unknown>[] }[] };
    expect(after.resourceGeneration[3]?.pins[1]).toEqual({ ...gated, sha256: D1 });
    expect(await sha256Ids()).toEqual([]);
  });

  it('applies pin: and sha256: of one method together and keeps both changes', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    const REPO = 'https://x/m.git';
    const D1 = '1'.repeat(64);
    const git = { kind: 'git', source: REPO, revision: COMMIT };
    const hf = { kind: 'hf', source: 'o/m', revision: COMMIT, files: '*' };
    const pins = [git, hf];
    settings.resourceGeneration = [...METHODS.slice(0, 3), { name: 'm3d', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins }];
    writeFileSync(settingsPath, JSON.stringify(hostForm(settings)));
    const dir = join(ws.root, '.ogw', 'generation', 'm3d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: 'm3d', pins: JSON.stringify(pins), git: [], hf: [{ source: 'o/m', dir: join(dir, 'hf', '1'), sha256: D1 }], files: null, python: null, cli: null, skill: null }));
    const resultDir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    writeFileSync(join(resultDir, 'generation-install.json'), JSON.stringify({ installedAt: 1, methods: { m3d: { kind: 'local-model', installed: true, reason: null, mismatches: [] } }, tools: {} }));
    setNet(fakeNet(routes(), { lsRemote: { [X_REPO]: X_REFS }, files: { [`${REPO} ${COMMIT} pyproject.toml`]: PYPROJECT } }));
    type Out = { proposals: { id: string; path: string; value: unknown[] }[] };
    const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
    const pin = out.proposals.find((p) => p.id === 'pin:m3d');
    const sha = out.proposals.find((p) => p.id === 'sha256:m3d');
    // both proposals have the same path
    expect([pin?.path, sha?.path]).toEqual(['resourceGeneration.3.pins', 'resourceGeneration.3.pins']);
    const pip = pin?.value[2];
    expect(pip).toMatchObject({ kind: 'pip' });
    expect(sha?.value).toEqual([git, { ...hf, sha256: D1 }]);

    expect(await ogw(ws, ['env', 'propose', '--apply', 'pin:m3d,sha256:m3d'], { env })).toMatchObject({ code: 0, stdout: 'applied: pin:m3d, sha256:m3d\n' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: { pins: unknown[] }[] };
    expect(after.resourceGeneration[3]?.pins).toEqual([git, { ...hf, sha256: D1 }, pip]);
  });

  it('fails when a lookup fails', async () => {
    const { ws, env } = setup();
    setNet(fakeNet({}, {}));
    const run = await ogw(ws, ['env', 'propose'], { env });
    expect(run).toMatchObject({ code: 1, stderr: expect.stringContaining('answered 404') as unknown });
  });

  it('applies the shown values, looks up only the chosen proposals, and writes nothing when one changed', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    expect((await ogw(ws, ['env', 'propose'], { env })).code).toBe(0);
    const offline = fakeNet({}, {});
    setNet(offline);
    expect(await ogw(ws, ['env', 'propose', '--apply', 'measured:flux2-klein,playInstances'], { env })).toMatchObject({ code: 0, stdout: 'applied: measured:flux2-klein, playInstances\n' });
    expect(offline.calls).toEqual([]);
    const after = thisHost(settingsPath);
    expect(after.playInstances).toBe(2);
    expect(after.measured?.['flux2-klein']).toEqual([{ resolution: 512, jobMs: 9, result: 'ok' }, { resolution: 1024, jobMs: 20, result: 'timeout' }]);

    const online = fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: PYPROJECT } });
    setNet(online);
    expect(await ogw(ws, ['env', 'propose', '--apply', 'tools.ffmpeg'], { env })).toMatchObject({ code: 0, stdout: 'applied: tools.ffmpeg\n' });
    expect(online.calls).toEqual([`GET ${FFMPEG_RELEASE}`]);

    const before = readFileSync(settingsPath, 'utf8');
    const moved = 'e'.repeat(40);
    setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: moved, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${moved} pyproject.toml`]: PYPROJECT } }));
    const changed = await ogw(ws, ['env', 'propose', '--apply', 'tools.postgresql,pin:sprite,measured:flux2-klein'], { env });
    expect(changed).toMatchObject({ code: 1, stderr: 'proposal changed since ogw env propose showed it: pin:sprite, measured:flux2-klein. Run ogw env propose again\n' });
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('reads only the results of this update env run: none older than the env-check result', async () => {
    const { ws, env } = setup();
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    const write = (name: string, value: unknown): void => {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
    };
    const check = JSON.parse(readFileSync(join(dir, 'env-check.json'), 'utf8')) as Record<string, unknown>;
    write('env-check', { ...check, checkedAt: 2 });
    type Out = { proposals: { id: string }[]; notices: { id: string }[] };
    const old = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
    expect(old.proposals.map((p) => p.id)).toEqual(['pin:sprite', 'tools.gdtoolkit', 'tools.ffmpeg']);
    expect(old.notices.map((n) => n.id)).toEqual(['docker', 'udp', 'agent-cli', 'provider-cli', 'provider-cli']);

    write('instance-measure', { measuredAt: 2, targets: [{ name: 'g', kind: 'game', value: 3, detail: null }] });
    write('generation-install', { installedAt: 2, methods: {}, tools: { postgresql: { installed: true, reason: null, mismatches: [] } } });
    write('generation-measure', { measuredAt: 3, methods: { same: { kind: 'local-model', error: null, steps: [{ durationMs: 1000, jobMs: 6, result: 'ok', maxMemoryBytes: 1, output: '/o', blocked: [] }] } } });
    const now = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { proposals: { id: string; value: unknown }[]; notices: { id: string }[] };
    expect(now.proposals.map((p) => [p.id, p.value])).toEqual([
      ['measured:same', [{ durationMs: 1000, jobMs: 6, result: 'ok' }]],
      ['maxConcurrentInstances', 3],
      ['pin:sprite', expect.anything()],
      ['tools.gdtoolkit', expect.anything()],
      ['tools.ffmpeg', expect.anything()],
    ]);
    expect(now.notices.map((n) => n.id)).toEqual(['no-method', 'docker', 'udp', 'agent-cli', 'provider-cli', 'provider-cli']);
  });

  it('reads the result file a generation measure of one method merged: the measured method and the kept ones', async () => {
    const { ws, env } = setup();
    const cat = METHODS[4] as { name: string; pins: unknown };
    mkdirSync(join(ws.root, '.ogw', 'generation', cat.name), { recursive: true });
    const marker = { name: cat.name, pins: JSON.stringify(cat.pins), git: [], hf: [], files: null, python: null, cli: null, skill: null, ffmpeg: null };
    writeFileSync(join(ws.root, '.ogw', 'generation', cat.name, 'installed.json'), JSON.stringify(marker));
    expect((await ogw(ws, ['generation', 'measure', 'cat'], { env })).code).toBe(0);
    const run = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { proposals: { id: string; value: unknown }[] };
    expect(run.proposals.filter((p) => p.id.startsWith('measured:')).map((p) => [p.id, p.value])).toEqual([
      ['measured:flux2-klein', [{ resolution: 512, jobMs: 9, result: 'ok' }, { resolution: 1024, jobMs: 20, result: 'timeout' }]],
      ['measured:cat', [{ result: 'ok' }]],
    ]);
  });

  it('proposes tools.gdtoolkit and tools.ffmpeg again only when generation install could not get them', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { tools: Record<string, unknown> };
    const gdtoolkit = { version: '4.0.0', python: '3.12', downloads: [entry('any', 'gdtoolkit-4.0.0-py3-none-any.whl')], dependencies: [] };
    const ffmpeg = { version: 'old', downloads: [{ platform: 'macos-arm64', url: 'https://gh/old', sha256: 'd'.repeat(64) }] };
    settings.tools = { ...settings.tools, gdtoolkit, ffmpeg };
    writeFileSync(settingsPath, JSON.stringify(settings));
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    const install = (installed: boolean): void => {
      const entryOf = (ok: boolean) => ({ installed: ok, reason: null, mismatches: [] });
      writeFileSync(join(dir, 'generation-install.json'), JSON.stringify({ installedAt: 1, methods: {}, tools: { postgresql: entryOf(true), gdtoolkit: entryOf(installed), ffmpeg: entryOf(installed) } }));
    };
    type Out = { proposals: { id: string; current: unknown; reason: string }[] };
    install(false);
    const failed = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
    expect(failed.proposals.map((p) => p.id)).toEqual(['measured:flux2-klein', 'measured:cat', 'maxConcurrentInstances', 'playInstances', 'pin:sprite', 'tools.gdtoolkit', 'tools.ffmpeg']);
    expect(failed.proposals.slice(-2)).toMatchObject([
      { current: gdtoolkit, reason: 'ogw generation install could not get tools.gdtoolkit; highest gdtoolkit 4.x any wheel and its dependency wheels' },
      { current: ffmpeg, reason: 'ogw generation install could not get tools.ffmpeg; ffmpeg static build of eugeneware/ffmpeg-static b6.1.1' },
    ]);
    install(true);
    const got = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as Out;
    expect(got.proposals.map((p) => p.id)).toEqual(['measured:flux2-klein', 'measured:cat', 'maxConcurrentInstances', 'playInstances', 'pin:sprite']);
  });

  it('proposes playInstances only when the smallest measured value is below it', async () => {
    const { ws, env } = setup();
    const dir = join(ws.harness, '.git', 'ogw-temp', 'ogw-env');
    const ids = async (value: number): Promise<string[]> => {
      writeFileSync(join(dir, 'instance-measure.json'), JSON.stringify({ measuredAt: 1, targets: [{ name: 'g', kind: 'game', value, detail: null }] }));
      const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { proposals: { id: string }[] };
      return out.proposals.map((p) => p.id).filter((id) => id.endsWith('Instances'));
    };
    expect(await ids(3)).toEqual(['maxConcurrentInstances']);
    expect(await ids(4)).toEqual(['maxConcurrentInstances']);
    expect(await ids(2)).toEqual(['maxConcurrentInstances', 'playInstances']);
  });

  it('uses the harness settings measured steps only for methods generation measure did not call', async () => {
    const { ws, env } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    const ok = [{ result: 'ok' }];
    settings.resourceGeneration = [
      METHODS[0] as Record<string, unknown>,
      { ...METHODS[2], measured: ok },
      { name: 'ext-off', kind: 'external-service', provider: 'codex', resourceTypes: ['voice'], safetyTimeoutMs: 1, license: 'X', measured: ok },
      { name: 'ext-missing', kind: 'external-service', provider: 'codex', resourceTypes: ['haptic'], safetyTimeoutMs: 1, license: 'X', measured: ok },
      { name: 'later', kind: 'local-model', resourceTypes: ['tileset'], safetyTimeoutMs: 1, license: 'X', measured: ok },
      { name: 'ext-ran', kind: 'external-service', provider: 'codex', resourceTypes: ['splash'], safetyTimeoutMs: 1, license: 'X', measured: ok },
    ];
    writeFileSync(settingsPath, JSON.stringify(hostForm(settings)));
    const failed = (kind: string, error: string) => ({ kind, error, steps: [] });
    writeFileSync(
      join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-measure.json'),
      JSON.stringify({
        measuredAt: 1,
        methods: {
          'flux2-klein': failed('local-model', NOT_INSTALLED),
          broken: failed('local-model', 'not defined'),
          'ext-off': failed('external-service', 'not called: the human did not allow it (ogw generation measure --allow ext-off)'),
          'ext-missing': failed('external-service', NOT_INSTALLED),
          'ext-ran': { kind: 'external-service', error: null, steps: [{ jobMs: 1, result: 'failed', maxMemoryBytes: null, output: null, blocked: [], costUsd: 0 }] },
        },
      }),
    );
    const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { notices: { id: string; detail: string }[] };
    const missing = (out.notices.find((n) => n.id === 'no-method')?.detail ?? '').replace('no method makes: ', '').split(', ');
    expect(missing).toEqual(expect.arrayContaining(['image', 'icon', 'sfx', 'haptic', 'splash']));
    expect(missing).not.toContain('voice');
    expect(missing).not.toContain('tileset');
  });

  it('resolves the pip pins with the pyproject.toml dependencies a local-model git pin with revision needs and its pip pins do not name', async () => {
    const MUSIC = 'https://x/music.git';
    const M = 'd'.repeat(40);
    const pyproject = `[project]
dependencies = [
  # local version labels are not on PyPI
  "torch==2.7.1+cu128; sys_platform == 'win32'",
  "torch>=2.9.1; sys_platform == 'darwin' and platform_machine == 'arm64'",
  "torch==2.10.0+cu130; sys_platform == 'linux' and platform_machine == 'aarch64'",
  "Numpy>=2",
  "rich",
  "pillow<12",
  "nano-vllm; sys_platform != 'darwin'",
]
`;
    const resolved = 'numpy==1.26.4\npillow==11.3.0\nrich==13.9.4\nsetuptools==80.9.0\n';
    const merged = 'numpy==1.26.4,pillow==11.3.0,rich==13.9.4,setuptools==80.9.0';
    type Out = { id: string; current: unknown; value: unknown; reason: string };
    const proposalFor = async (pins: unknown[], kind = 'local-model'): Promise<{ proposal: Out | undefined; calls: string[]; input: string[] | undefined }> => {
      const { ws, env, uv } = setup();
      resolveTo(uv, { 'macos-arm64': resolved, 'linux-x64': resolved, 'windows-x64': resolved });
      const settingsPath = join(ws.harness, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
      settings.resourceGeneration = [{ name: 'music', kind, ...(kind === 'external-service' ? { provider: 'codex' } : {}), resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins }];
      writeFileSync(settingsPath, JSON.stringify(settings));
      const torch = { releases: { '2.7.1': [file('t271')], '2.9.1': [file('t291')], '2.10.0': [file('t2100')] } };
      const fake = fakeNet({ ...routes(), 'https://pypi.org/pypi/torch/json': torch }, { files: { [`${MUSIC} ${M} pyproject.toml`]: pyproject } });
      setNet(fake);
      const run = await ogw(ws, ['env', 'propose', '--json'], { env });
      expect(run.stderr).toBe('');
      const out = JSON.parse(run.stdout) as { proposals: Out[] };
      return { proposal: out.proposals.find((p) => p.id.startsWith('pin:')), calls: fake.calls, input: compileCalls(uv)[0]?.lines };
    };
    const git = { kind: 'git', source: MUSIC, revision: M };
    const hf = { kind: 'hf', source: 'org/m', revision: M };
    const pip = { kind: 'pip', source: 'numpy==1.26.4,rich[jupyter]==13.9.4' };
    // the torch requirement of linux aarch64 holds on no host platform
    const torch = ["torch==2.7.1 ; sys_platform == 'win32'", "torch>=2.9.1 ; sys_platform == 'darwin' and platform_machine == 'arm64'"];
    const { proposal, calls, input } = await proposalFor([git, pip, hf]);
    expect(proposal).toEqual({
      id: 'pin:music',
      path: 'resourceGeneration.0.pins',
      current: [git, pip, hf],
      value: [git, { kind: 'pip', source: merged }, hf],
      reason: 'pip pins with the pyproject.toml dependencies (torch, Numpy, rich, pillow), which win over pip pin items of the same project, resolved with uv pip compile for macos-arm64, linux-x64, windows-x64 CPython 3.12; not on PyPI, left out: nano-vllm',
    });
    expect(input).toEqual([...torch, 'Numpy>=2', 'rich', 'pillow<12']);
    expect(calls).toContain(`git-file ${MUSIC} ${M} pyproject.toml`);
    expect(calls.filter((c) => c.startsWith('ls-remote '))).toEqual([]);
    // without a pip pin, a new pip pin at the end
    const bare = await proposalFor([git, hf]);
    expect(bare.proposal?.value).toEqual([git, hf, { kind: 'pip', source: merged }]);
    expect(bare.input).toEqual([...torch, 'Numpy>=2', 'rich', 'pillow<12']);
    // a git pin with `pyproject` reads that file
    expect((await proposalFor([{ ...git, pyproject: 'sub/pyproject.toml' }, hf])).calls).toContain(`git-file ${MUSIC} ${M} sub/pyproject.toml`);
    // several pip pins become the first one
    expect((await proposalFor([git, { kind: 'pip', source: 'Torch==2.9.0' }, hf, { kind: 'pip', source: 'numpy==2.3.1' }])).proposal?.value).toEqual([git, { kind: 'pip', source: merged }, hf]);
    // a pip pin that is the resolution already, and git pins of methods that install their checkout: no proposal
    const settled = await proposalFor([git, { kind: 'pip', source: merged }]);
    expect(settled.input).toEqual(['setuptools==80.9.0', ...torch, 'Numpy>=2', 'rich', 'pillow<12']);
    expect(settled.proposal).toBeUndefined();
    expect((await proposalFor([git, pip], 'external-service')).proposal).toBeUndefined();
  });

  it('resolves pip pin items without their local version labels', async () => {
    const MUSIC = 'https://x/music.git';
    const M = 'd'.repeat(40);
    const { ws, env, uv } = setup();
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    const pins = [{ kind: 'git', source: MUSIC, revision: M }, { kind: 'pip', source: "torch==2.7.1+cu128 ; sys_platform == 'win32',torchaudio[x]==2.7.1+cpu,numpy==1.26.4" }];
    settings.resourceGeneration = [{ name: 'music', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins }];
    writeFileSync(settingsPath, JSON.stringify(settings));
    setNet(fakeNet(routes(), { files: { [`${MUSIC} ${M} pyproject.toml`]: '[project]\ndependencies = ["rich"]\n' } }));
    const run = await ogw(ws, ['env', 'propose', '--json'], { env });
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(compileCalls(uv).map((c) => c.lines)).toEqual(Array(3).fill(["torch==2.7.1 ; sys_platform == 'win32'", 'torchaudio[x]==2.7.1', 'numpy==1.26.4', 'rich']));
  });

  it('pins every git pin without revision and the dependencies of all their pyproject.toml files', async () => {
    const { ws, env, uv } = setup();
    const OTHER = 'https://x/other.git';
    const BARE = 'https://x/bare.git';
    const settingsPath = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
    const fixed = { kind: 'git', source: 'https://x/f.git', revision: COMMIT };
    settings.resourceGeneration = [
      { ...METHODS[3], pins: [{ kind: 'git', source: SPRITE }, fixed, { kind: 'git', source: OTHER, files: 'src' }, { kind: 'git', source: BARE }] },
      { name: 'solo', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: BARE }] },
    ];
    writeFileSync(settingsPath, JSON.stringify(settings));
    const OTHER_PYPROJECT = `[project]\ndependencies = ["pillow<11.3", "rich[markdown, jupyter]>=13", "x @ git+https://h/x@abc", "numpy; sys_platform == 'win32'", "Numpy>=2"]\n`;
    const E = 'e'.repeat(40);
    const B = 'b'.repeat(40);
    setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [OTHER]: E, [BARE]: B, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: PYPROJECT, [`${OTHER} ${E} pyproject.toml`]: OTHER_PYPROJECT } }));
    const out = JSON.parse((await ogw(ws, ['env', 'propose', '--json'], { env })).stdout) as { proposals: { id: string }[] };
    expect(out.proposals.filter((p) => p.id.startsWith('pin:'))).toEqual([
      {
        id: 'pin:sprite',
        path: 'resourceGeneration.0.pins',
        current: settings.resourceGeneration[0]?.pins,
        value: [
          { kind: 'git', source: SPRITE, revision: COMMIT },
          fixed,
          { kind: 'git', source: OTHER, files: 'src', revision: E },
          { kind: 'git', source: BARE, revision: B },
          { kind: 'pip', source: MERGED },
        ],
        reason: `git pins without revision (${SPRITE}, ${OTHER}, ${BARE}): HEAD of the default branch; pip pins with the pyproject.toml dependencies (pillow, numpy, pywin32, rich, x), which win over pip pin items of the same project, resolved with uv pip compile for macos-arm64, linux-x64, windows-x64 CPython 3.12`,
      },
      {
        id: 'pin:solo',
        path: 'resourceGeneration.1.pins',
        current: [{ kind: 'git', source: BARE }],
        value: [{ kind: 'git', source: BARE, revision: B }],
        reason: `git pins without revision (${BARE}): HEAD of the default branch`,
      },
    ]);
    // the pyproject.toml dependencies of every git pin go to uv together
    expect(compileCalls(uv)[0]?.lines).toEqual([
      'pillow>=10,<12',
      'numpy',
      "pywin32 ; sys_platform == 'win32'",
      'rich[jupyter]~=13.0',
      `x @ git+https://h/x@${X_COMMIT}`,
      'pillow<11.3',
      'rich[markdown,jupyter]>=13',
      `x @ git+https://h/x@${X_COMMIT}`,
      "numpy ; sys_platform == 'win32'",
      'Numpy>=2',
    ]);
    setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [X_REPO]: X_REFS }, files: { [`${SPRITE} ${COMMIT} pyproject.toml`]: PYPROJECT } }));
    expect(await ogw(ws, ['env', 'propose'], { env })).toMatchObject({ code: 1, stderr: `git ls-remote ${OTHER} HEAD found no commit\n` });
    setNet(fakeNet(routes(), { lsRemote: { [SPRITE]: COMMIT, [OTHER]: E, [BARE]: B, [X_REPO]: X_REFS }, files: { [`${OTHER} ${E} pyproject.toml`]: '[project]\ndependencies = ["!!"]\n' } }));
    expect(await ogw(ws, ['env', 'propose'], { env })).toMatchObject({ code: 1, stderr: 'cannot read dependency: !!\n' });
  });
});

describe('propose helpers', () => {
  it('reads project dependencies', () => {
    expect(pyprojectDependencies(PYPROJECT)).toEqual(['pillow>=10,<12', 'numpy', "pywin32; sys_platform == 'win32'", 'rich[jupyter]~=13.0', 'x @ git+https://h/x@abc']);
    expect(pyprojectDependencies('[tool]\nx = 1\n')).toEqual([]);
  });

  it('skips TOML comments and fails on an array or a string that is not closed', () => {
    const deps = (body: string): string[] => pyprojectDependencies(`[project]\ndependencies = [${body}\n[tool.x]\ny = 1\n`);
    expect(deps(`\n  "torch>=2", # it's pinned upstream\n  "numpy", # see [docs]\n  'a#b', # "x"\n  "c\\"d",\n]`)).toEqual(['torch>=2', 'numpy', 'a#b', 'c"d']);
    expect(deps(`"a"] # ["b"]`)).toEqual(['a']);
    const unclosed = 'pyproject.toml [project] dependencies: the array or a string is not closed';
    expect(() => pyprojectDependencies('[project]\ndependencies = [\n  "a",\n')).toThrow(unclosed);
    expect(() => pyprojectDependencies('[project]\ndependencies = ["a", "b')).toThrow(unclosed);
    expect(() => pyprojectDependencies('[project]\ndependencies = ["a" # ]')).toThrow(unclosed);
    expect(() => pyprojectDependencies('[project]\ndependencies = ["a\\')).toThrow(unclosed);
    expect(tomlStrings('[]')).toEqual([]);
    expect(tomlStrings(`['a\\b', "x"]`)).toEqual(['a\\b', 'x']);
  });

  it('splits a proposal into the parts where its value differs and refuses two proposals that change the same part', () => {
    expect(changedParts([{ a: 1 }, { b: 2 }], [{ a: 1, c: 3 }, { b: 4 }, { d: 5 }])).toEqual([
      { segments: ['0', 'c'], value: 3 },
      { segments: ['1', 'b'], value: 4 },
      { segments: ['2'], value: { d: 5 } },
    ]);
    // a removed key or a shorter array is replaced whole
    expect(changedParts({ a: 1, b: 2 }, { a: 1 }, ['x'])).toEqual([{ segments: ['x'], value: { a: 1 } }]);
    expect(changedParts([1, 2], [1], [])).toEqual([{ segments: [], value: [1] }]);
    expect(changedParts(null, [1])).toEqual([{ segments: [], value: [1] }]);
    const current = [{ kind: 'hf', source: 's' }];
    const a = { id: 'a', path: 'resourceGeneration.0.pins', current, value: [{ kind: 'hf', source: 's', sha256: 'x' }], reason: '' };
    const b = { id: 'b', path: 'resourceGeneration.0.pins', current, value: [{ kind: 'hf', source: 's', revision: 'r' }], reason: '' };
    const c = { id: 'c', path: 'resourceGeneration.0.pins.0', current: current[0], value: { kind: 'hf', source: 's', sha256: 'y' }, reason: '' };
    expect(proposalParts([a, b]).map((p) => p.parts)).toEqual([
      [{ segments: ['resourceGeneration', '0', 'pins', '0', 'sha256'], value: 'x' }],
      [{ segments: ['resourceGeneration', '0', 'pins', '0', 'revision'], value: 'r' }],
    ]);
    expect(() => proposalParts([a, b, c])).toThrow('proposals a and c both change resourceGeneration.0.pins.0.sha256: apply one, run ogw env propose again, then apply the other');
  });

});
