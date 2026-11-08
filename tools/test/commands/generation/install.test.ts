import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolProgram } from '../../../src/commands/env/api.ts';
import { sha256Text } from '../../../src/commands/env/lib/files.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { cliWrapper, globMatch, hfDigest, installedFrom, installKey, methodMarker, pipRequirements, projectScript, withMethodLock, type MethodMarker } from '../../../src/commands/generation/lib/install.ts';
import { loadSchema, validateAgainst } from '../../../src/lib/settings.ts';
import { sourceUrl } from '../../../src/commands/generation/list.ts';
import { createContext } from '../../../src/lib/command.ts';
import { writeJsonAtomic } from '../../../src/lib/fsx.ts';
import { jobPaths, readJob, type JobRecord } from '../../../src/lib/jobs.ts';
import { commitAll, ogw, gitInit, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from '../env/fakes.ts';
import { installFolder, type MethodLike } from './install-folder.ts';

const REV = 'c'.repeat(40);

/** A fake ffmpeg whose `-encoders` lists `encoder`. */
function ffmpegScript(encoder: string): string {
  return `#!/bin/sh\necho " A....D ${encoder}            Vorbis"\n`;
}

function sha(body: string | Buffer): string {
  return sha256Text(body as string);
}

function fontRepo(ws: TestWorkspace): { dir: string; commit: string } {
  const dir = join(ws.root, 'fonts-repo');
  gitInit(dir);
  mkdirSync(join(dir, 'ofl', 'notosans'), { recursive: true });
  mkdirSync(join(dir, 'ofl', 'other'), { recursive: true });
  mkdirSync(join(dir, 'apache', 'x'), { recursive: true });
  writeFileSync(join(dir, 'ofl', 'notosans', 'NotoSans[wght].ttf'), 'font');
  writeFileSync(join(dir, 'ofl', 'notosans', 'Plain.otf'), 'font2');
  writeFileSync(
    join(dir, 'ofl', 'notosans', 'METADATA.pb'),
    [
      'name: "Noto Sans"',
      'license: "OFL"',
      'category: "SANS_SERIF"',
      'classifications: "DISPLAY"',
      'fonts {',
      '  name: "Noto Sans"',
      '  filename: "NotoSans[wght].ttf"',
      '  copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)"',
      '}',
      'subsets: "latin"',
      'subsets: "menu"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'ofl', 'other', 'Other.ttf'), 'other');
  writeFileSync(join(dir, 'apache', 'x', 'X.ttf'), 'x');
  writeFileSync(join(dir, 'apache', 'x', 'METADATA.pb'), 'license: "APACHE2"\n');
  return { dir, commit: commitAll(dir) };
}

function spriteRepo(ws: TestWorkspace): { dir: string; commit: string } {
  const dir = join(ws.root, 'sprite-repo');
  gitInit(dir);
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "sprite-gen"\n\n[project.scripts]\nsprite-gen = "sprite_gen.cli:main"\n\n[tool.x]\ny = 1\n');
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# skill');
  writeFileSync(join(dir, 'patched.txt'), 'old\n');
  return { dir, commit: commitAll(dir) };
}

const UV = [
  'echo "uv $*" >> "$OGW_TEST_LOG"',
  'if [ "$1" = venv ]; then for last; do :; done; mkdir -p "$last/bin"; touch "$last/bin/python"; exit 0; fi',
  'if [ "$1" = pip ]; then',
  '  for a in "$@"; do echo "arg<$a>" >> "$OGW_TEST_LOG"; done',
  '  for a in "$@"; do case "$a" in *gdtoolkit*.whl) touch "$(dirname "$6")/gdlint";; esac; done',
  '  for a in "$@"; do case "$a" in *fail-install*) exit 3;; esac; done',
  '  if [ -n "$OGW_TEST_UV_FAIL" ]; then exit 3; fi',
  'fi',
].join('\n');

function workspace(extra: Record<string, unknown> = {}): { ws: TestWorkspace; env: NodeJS.ProcessEnv; log: string } {
  const ws = makeWorkspace(extra);
  const log = join(ws.root, 'calls.log');
  writeFileSync(log, '');
  const bin = fakeBin(join(ws.root, 'bin'), {
    uv: UV,
    docker: 'echo "docker $*" >> "$OGW_TEST_LOG"\nif [ "$1" = image ]; then exit 1; fi\nif [ "$2" = "postgres:18.6@sha256:bad" ]; then echo "manifest unknown" >&2; exit 1; fi',
  });
  return { ws, env: { ...ws.env, PATH: `${bin}:/usr/bin:/bin`, OGW_TEST_LOG: log, TMPDIR: join(ws.root, 'tmp'), OGW_HOST_PLATFORM: 'macos-arm64' }, log };
}

afterEach(() => {
  setNet(null);
});

/** The methods of the harness settings of `ws`. */
function settingsMethods(ws: TestWorkspace): MethodLike[] {
  return (JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as { resourceGeneration: MethodLike[] }).resourceGeneration;
}

describe('ogw generation install', () => {
  it('installs catalog, local-model and provider methods and tools as pinned, and records the result', async () => {
    const base = makeWorkspace();
    const fonts = fontRepo(base);
    const sprite = spriteRepo(base);
    const blender = join(base.root, 'blender-src');
    mkdirSync(join(blender, 'blender-5.2.2'), { recursive: true });
    writeFileSync(join(blender, 'blender-5.2.2', 'blender'), '#!/bin/sh\n');
    sh(blender, 'tar', ['-czf', join(base.root, 'blender.tar.gz'), 'blender-5.2.2']);
    const blenderTar = readFileSync(join(base.root, 'blender.tar.gz'));
    const hfFiles: Record<string, string> = { 'a.json': '{}', 'sub/b.bin': 'bbb' };
    const hfSha = hfDigest(Object.entries(hfFiles).map(([path, body]) => ({ path, sha256: sha(body) })));
    const patch = 'diff --git a/patched.txt b/patched.txt\n--- a/patched.txt\n+++ b/patched.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const methods: MethodLike[] = [
        { name: 'font-catalog', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1000, pins: [{ kind: 'git', source: fonts.dir, revision: fonts.commit, files: 'ofl/notosans,apache/x' }] },
        {
          name: 'img',
          kind: 'local-model',
          resourceTypes: ['image'],
          safetyTimeoutMs: 1000,
          license: 'MIT',
          pins: [
            { kind: 'pip', source: "mflux==0.20.0,rembg[cpu,cli]==2.0.85,torch==2.9.0 ; sys_platform == 'darwin' and platform_machine == 'arm64'" },
            { kind: 'hf', source: 'org/model', revision: REV, files: '*', exclude: 'big.bin', sha256: hfSha },
            { kind: 'file', source: 'birefnet-general', url: 'https://dl/birefnet.onnx', files: 'birefnet-general.onnx', sha256: sha('onnx') },
          ],
        },
        {
          name: 'sprite',
          kind: 'external-service',
          resourceTypes: ['sprite_animation'],
          provider: 'codex',
          safetyTimeoutMs: 1000,
          license: 'X',
          pins: [
            { kind: 'git', source: sprite.dir, revision: sprite.commit },
            { kind: 'patch', source: 'patches/p.patch', sha256: sha(patch) },
          ],
        },
        { name: 'ext', kind: 'external-service', resourceTypes: ['image'], model: 'm-1', secret: 'extKey', safetyTimeoutMs: 1000, license: 'X' },
        { name: 'proc', kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1000, license: 'X' },
      ];
    const { ws, env, log } = workspace({
      resourceGeneration: methods,
      tools: {
        blender: { version: '5.2.2', downloads: [{ platform: 'macos-arm64', url: 'https://dl/blender.tar.gz', sha256: sha(blenderTar) }] },
        placeholderFont: { version: 'Noto Sans KR x', downloads: [{ platform: 'any', url: 'https://dl/Noto%5Bw%5D.ttf', sha256: sha('ttf') }] },
        postgresql: { tag: '18.6', digest: `sha256:${'d'.repeat(64)}` },
        ffmpeg: { version: '7', downloads: [{ platform: 'macos-arm64', url: 'https://dl/ffmpeg', sha256: sha(ffmpegScript('libvorbis')) }] },
        gdtoolkit: {
          version: '4.3.4',
          python: '3.12',
          downloads: [{ platform: 'any', url: 'https://dl/gdtoolkit-4.3.4-py3-none-any.whl', sha256: sha('whl') }],
          dependencies: [
            { platform: 'any', url: 'https://dl/lark-1.2.2-py3-none-any.whl', sha256: sha('lark') },
            { platform: 'macos-arm64', url: 'https://dl/PyYAML-6.0.2-cp312-cp312-macosx_11_0_arm64.whl', sha256: sha('yaml-mac') },
            { platform: 'linux-x64', url: 'https://dl/PyYAML-6.0.2-cp312-cp312-manylinux_2_17_x86_64.whl', sha256: sha('yaml-linux') },
          ],
        },
      },
    });
    mkdirSync(join(ws.harness, 'patches'), { recursive: true });
    writeFileSync(join(ws.harness, 'patches', 'p.patch'), patch);
    const net = fakeNet({
      [`https://huggingface.co/api/models/org/model/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'a.json' }, { rfilename: 'sub/b.bin' }, { rfilename: 'big.bin' }] },
      [`https://huggingface.co/org/model/resolve/${REV}/a.json`]: hfFiles['a.json'] as string,
      [`https://huggingface.co/org/model/resolve/${REV}/sub/b.bin`]: hfFiles['sub/b.bin'] as string,
      'https://dl/birefnet.onnx': 'onnx',
      'https://dl/blender.tar.gz': blenderTar,
      'https://dl/Noto%5Bw%5D.ttf': 'ttf',
      'https://dl/ffmpeg': ffmpegScript('libvorbis'),
      'https://dl/ffmpeg8': ffmpegScript('libvorbis'),
      'https://dl/gdtoolkit-4.3.4-py3-none-any.whl': 'whl',
      'https://dl/lark-1.2.2-py3-none-any.whl': 'lark',
      'https://dl/PyYAML-6.0.2-cp312-cp312-macosx_11_0_arm64.whl': 'yaml-mac',
    });
    setNet(net);
    const run = await ogw(ws, ['generation', 'install'], { env });
    expect(run.stdout).toContain('method font-catalog: installed');
    expect(run.stdout).toContain('method img: installed');
    expect(run.stdout).toContain('method sprite: installed');
    expect(run.stdout).toContain('method ext: failed: secret extKey is not in the host secret store');
    expect(run.stdout).toContain('method proc: installed');
    expect(run.stdout).toContain('put the secret in the host secret store: ogw secret set --harness extKey');
    for (const tool of ['blender', 'placeholderFont', 'gdtoolkit', 'ffmpeg', 'postgresql']) expect(run.stdout).toContain(`tools ${tool}: installed`);
    expect(run.code).toBe(1);
    expect(net.calls).not.toContain(`GET https://huggingface.co/org/model/resolve/${REV}/big.bin`);

    const folder = async (name: string): Promise<string> => installFolder(ws, methods.find((m) => m.name === name) as MethodLike, env);
    const [fontsDir, imgDir, spriteDir] = [await folder('font-catalog'), await folder('img'), await folder('sprite')];
    // `.ogw/generation-install/<method>/<install key>/`
    expect(fontsDir).toMatch(new RegExp(`^${join(ws.root, '.ogw', 'generation-install', 'font-catalog')}/[0-9a-f]{16}$`));
    expect(existsSync(join(fontsDir, 'git', '0', 'ofl', 'notosans', 'NotoSans[wght].ttf'))).toBe(true);
    expect(existsSync(join(fontsDir, 'git', '0', 'ofl', 'other'))).toBe(false);
    expect(readFileSync(join(imgDir, 'hf', '1', 'sub', 'b.bin'), 'utf8')).toBe('bbb');
    expect(readFileSync(join(imgDir, 'files', 'birefnet-general.onnx'), 'utf8')).toBe('onnx');
    expect(readFileSync(join(spriteDir, 'git', '0', 'patched.txt'), 'utf8')).toBe('new\n');
    const marker = JSON.parse(readFileSync(join(spriteDir, 'installed.json'), 'utf8')) as MethodMarker & { cli: string };
    expect(marker.skill).toBe(join(spriteDir, 'git', '0', 'skill', 'SKILL.md'));
    expect(marker.cli).toBe(join(spriteDir, 'bin', 'sprite-gen'));
    // installed.json holds only paths inside the install folder: the ffmpeg the cli puts on PATH is part of the install key
    expect(Object.keys(marker).sort()).toEqual(['cli', 'files', 'git', 'hf', 'name', 'pins', 'python', 'skill']);
    const paths = [marker.cli, marker.skill, marker.python, marker.files, ...marker.git.map((g) => g.dir), ...marker.hf.map((h) => h.dir)];
    expect(paths.filter((path) => path !== null && !path.startsWith(`${spriteDir}/`))).toEqual([]);
    const wrapper = readFileSync(marker.cli, 'utf8');
    expect(wrapper).toContain(`PATH='${join(ws.root, '.ogw', 'tools', 'ffmpeg', '7', 'download')}':"$PATH"`);
    expect(wrapper).toContain(`exec '${join(spriteDir, 'venv', 'bin', 'sprite-gen')}' "$@"`);

    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`uv pip install --quiet --python ${join(imgDir, 'venv', 'bin', 'python')} mflux==0.20.0 rembg[cpu,cli]==2.0.85 torch==2.9.0`);
    // each requirement is one argument, with its extras and marker
    expect(calls).toContain("arg<rembg[cpu,cli]==2.0.85>\narg<torch==2.9.0 ; sys_platform == 'darwin' and platform_machine == 'arm64'>\n");
    expect(calls).toContain(`uv pip install --quiet --no-deps --python ${join(spriteDir, 'venv', 'bin', 'python')} ${join(spriteDir, 'git', '0')}`);
    expect(calls).toContain('--no-deps --python');
    const gdtoolkit = join(ws.root, '.ogw', 'tools', 'gdtoolkit', '4.3.4');
    expect(calls).toContain(`uv venv --quiet --python 3.12 ${join(gdtoolkit, 'venv')}`);
    const wheels = ['gdtoolkit-4.3.4-py3-none-any.whl', 'lark-1.2.2-py3-none-any.whl', 'PyYAML-6.0.2-cp312-cp312-macosx_11_0_arm64.whl'].map((w) => join(gdtoolkit, 'download', w));
    expect(calls).toContain(`uv pip install --quiet --no-deps --python ${join(gdtoolkit, 'venv', 'bin', 'python')} ${wheels.join(' ')}\n`);
    expect(net.calls).not.toContain('GET https://dl/PyYAML-6.0.2-cp312-cp312-manylinux_2_17_x86_64.whl');
    expect((JSON.parse(readFileSync(join(gdtoolkit, 'installed.json'), 'utf8')) as { sha256: string[] }).sha256).toEqual([sha('whl'), sha('lark'), sha('yaml-mac')]);
    expect(calls).toContain(`docker pull postgres:18.6@sha256:${'d'.repeat(64)}`);

    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await toolProgram(ctx, 'blender')).toBe(join(ws.root, '.ogw', 'tools', 'blender', '5.2.2', 'files', 'blender-5.2.2', 'blender'));
    expect(await toolProgram(ctx, 'placeholderFont')).toBe(join(ws.root, '.ogw', 'tools', 'placeholderFont', 'Noto_Sans_KR_x', 'download', 'Noto[w].ttf'));
    expect(await toolProgram(ctx, 'gdtoolkit')).toBe(join(ws.root, '.ogw', 'tools', 'gdtoolkit', '4.3.4', 'venv', 'bin', 'gdlint'));
    expect(await toolProgram(ctx, 'chromium')).toBeNull();

    const result = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-install.json'), 'utf8')) as {
      methods: Record<string, { installed: boolean; secretMissing?: string }>;
      tools: Record<string, { installed: boolean }>;
    };
    expect(result.methods.ext).toMatchObject({ installed: false, secretMissing: 'extKey' });
    expect(result.methods.img).toMatchObject({ installed: true, kind: 'local-model' });
    expect(result.tools.postgresql).toMatchObject({ installed: true });

    // A local-directory repository has no source URL; `ogw generation list` below covers GitHub repositories.
    expect(await ogw(ws, ['generation', 'list', 'font-catalog'], { env })).toMatchObject({
      code: 1,
      stderr: `no source URL for a file of git repository ${fonts.dir}: only https://github.com/<owner>/<repo> repositories have one\n`,
    });

    // A second run downloads nothing again; one method updates only its own entry.
    const before = net.calls.length;
    writeFileSync(log, '');
    const one = await ogw(ws, ['generation', 'install', 'img'], { env });
    expect(one).toMatchObject({ code: 0, stdout: expect.stringContaining('method img: installed') as unknown });
    expect(net.calls.length).toBe(before);
    expect(readFileSync(log, 'utf8')).toBe('');
    const merged = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-install.json'), 'utf8')) as typeof result;
    expect(Object.keys(merged.methods)).toEqual(['font-catalog', 'img', 'sprite', 'ext', 'proc']);
    expect(merged.tools.blender).toMatchObject({ installed: true });

    // A new tools.ffmpeg is another install key: the provider method installs into a new install folder whose CLI puts
    // the new ffmpeg on PATH, and the install folder of the earlier ffmpeg stays as it is.
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { tools: Record<string, unknown> };
    settings.tools.ffmpeg = { version: '8', downloads: [{ platform: 'macos-arm64', url: 'https://dl/ffmpeg8', sha256: sha(ffmpegScript('libvorbis')) }] };
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect((await ogw(ws, ['generation', 'install'], { env })).stdout).toContain('method sprite: installed');
    const spriteAgain = await folder('sprite');
    expect(spriteAgain).not.toBe(spriteDir);
    const again = JSON.parse(readFileSync(join(spriteAgain, 'installed.json'), 'utf8')) as { cli: string };
    expect(readFileSync(again.cli, 'utf8')).toContain(`PATH='${join(ws.root, '.ogw', 'tools', 'ffmpeg', '8', 'download')}':"$PATH"`);
    expect(readFileSync(marker.cli, 'utf8')).toBe(wrapper);
  });

  it('fails methods whose pins are not met and leaves no method folder', async () => {
    const base = makeWorkspace();
    const sprite = spriteRepo(base);
    const { ws, env } = workspace({
      resourceGeneration: [
        { name: 'norev', kind: 'external-service', resourceTypes: ['sprite_animation'], provider: 'grok', safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir }] },
        { name: 'badrev', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: 'e'.repeat(40) }] },
        // a branch name fetches, so the checked-out commit is what fails it
        { name: 'branchrev', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: 'main' }] },
        { name: 'badhf', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'hf', source: 'o/m', revision: REV, files: '*', sha256: 'f'.repeat(64) }] },
        { name: 'nomatch', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'hf', source: 'o/e', revision: REV, files: 'ckpt/*' }] },
        { name: 'allexcluded', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'hf', source: 'o/e', revision: REV, exclude: '*.bin' }] },
        { name: 'hfrev', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'hf', source: 'o/r', revision: REV, files: '*' }] },
        { name: 'nohfrev', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'hf', source: 'o/m', files: '*' }] },
        { name: 'badfile', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'file', source: 'unknown-model', files: 'x.onnx' }] },
        { name: 'badfilesha', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'file', source: 'birefnet-general', url: 'https://dl/birefnet.onnx', files: 'b.onnx', sha256: 'f'.repeat(64) }] },
        { name: 'nopatchgit', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'patch', source: 'p.patch' }] },
        { name: 'nopatchfile', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: sprite.commit }, { kind: 'patch', source: 'missing.patch' }] },
        { name: 'badpatch', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: sprite.commit }, { kind: 'patch', source: 'p.patch', sha256: 'f'.repeat(64) }] },
        { name: 'noffmpeg', kind: 'external-service', resourceTypes: ['sprite_animation'], provider: 'codex', safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: sprite.commit }] },
        { name: 'nogitprovider', kind: 'external-service', resourceTypes: ['sprite_animation'], provider: 'codex', safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'pip', source: 'a==1' }] },
        { name: 'pipfail', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'pip', source: 'fail-install==1' }] },
      ],
      tools: {
        blender: { version: '1', downloads: [{ platform: 'linux-x64', url: 'https://dl/b', sha256: 'a'.repeat(64) }] },
        placeholderFont: { version: '1', downloads: [{ platform: 'any', url: 'https://dl/f.ttf', sha256: 'a'.repeat(64) }] },
        postgresql: { tag: '18.6', digest: 'sha256:bad' },
        chromium: { version: '1', downloads: [{ platform: 'macos-arm64', url: 'https://dl/chrome.zip', sha256: sha('notzip') }] },
        ffmpeg: { version: '7', downloads: [{ platform: 'macos-arm64', url: 'https://dl/ffmpeg-aac', sha256: sha(ffmpegScript('aac')) }] },
        gdtoolkit: {
          version: '4',
          python: '3.12',
          downloads: [{ platform: 'any', url: 'https://dl/gdtoolkit.whl', sha256: sha('whl') }],
          dependencies: [{ platform: 'any', url: 'https://dl/lark.whl', sha256: 'f'.repeat(64) }],
        },
      },
    });
    writeFileSync(join(ws.harness, 'p.patch'), 'x');
    setNet(
      fakeNet({
        [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'w.bin' }] },
        [`https://huggingface.co/o/m/resolve/${REV}/w.bin`]: 'w',
        [`https://huggingface.co/api/models/o/e/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'ckpts/x.bin' }] },
        [`https://huggingface.co/api/models/o/r/revision/${REV}?blobs=true`]: { sha: 'other', siblings: [] },
        'https://dl/birefnet.onnx': 'onnx',
        'https://dl/f.ttf': 'ttf',
        'https://dl/chrome.zip': 'notzip',
        'https://dl/ffmpeg-aac': ffmpegScript('aac'),
        'https://dl/gdtoolkit.whl': 'whl',
        'https://dl/lark.whl': 'lark',
      }),
    );
    const run = await ogw(ws, ['generation', 'install', '--json'], { env });
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { methods: Record<string, { installed: boolean; reason: string; mismatches: { what: string }[] }>; tools: Record<string, { installed: boolean; reason: string }> };
    const reason = (name: string): string => result.methods[name]?.reason ?? '';
    expect(reason('norev')).toBe(`git pin ${sprite.dir} has no revision`);
    expect(reason('badrev')).toContain('git fetch --quiet --depth 1 origin');
    expect(reason('branchrev')).toBe(`git ${sprite.dir} is at ${sprite.commit}, not main`);
    expect(result.methods.branchrev?.mismatches[0]).toMatchObject({ what: sprite.dir, expected: 'main', actual: sprite.commit });
    expect(reason('badhf')).toBe('hf o/m SHA-256 differs');
    expect(result.methods.badhf?.mismatches[0]?.what).toBe('o/m');
    expect(reason('nomatch')).toBe('hf o/e has no file that matches files ckpt/*');
    expect(reason('allexcluded')).toBe('hf o/e has no file that matches files * without exclude *.bin');
    expect(reason('hfrev')).toBe('hf o/r revision differs');
    expect(reason('nohfrev')).toBe('hf pin o/m has no revision');
    expect(reason('badfile')).toBe('file pin unknown-model has no url');
    expect(reason('badfilesha')).toBe('file birefnet-general SHA-256 differs');
    expect(reason('nopatchgit')).toBe('patch p.patch has no git pin before it');
    expect(reason('nopatchfile')).toBe(`patch file not found: ${join(ws.harness, 'missing.patch')}`);
    expect(reason('badpatch')).toBe('patch p.patch SHA-256 differs');
    expect(reason('noffmpeg')).toBe('tools.ffmpeg is not installed');
    expect(reason('nogitprovider')).toBe('a provider method needs a git pin');
    expect(reason('pipfail')).toContain('uv pip install');
    for (const method of settingsMethods(ws)) expect(existsSync(await installFolder(ws, method, env)), method.name).toBe(false);
    expect(result.tools.blender).toMatchObject({ installed: false, reason: 'no download for this host' });
    expect(result.tools.placeholderFont).toMatchObject({ installed: false, reason: 'SHA-256 differs from the pin' });
    expect(result.tools.chromium).toMatchObject({ installed: false });
    expect(result.tools.ffmpeg).toMatchObject({ installed: false, reason: 'ffmpeg has no libvorbis encoder' });
    expect(result.tools.gdtoolkit).toMatchObject({ installed: false, reason: 'SHA-256 differs from the pin', mismatches: [{ path: 'https://dl/lark.whl', expected: 'f'.repeat(64) }] });
    expect(existsSync(join(ws.root, '.ogw', 'tools', 'ffmpeg', '7'))).toBe(false);
    expect(result.tools.postgresql).toMatchObject({ installed: false, reason: 'manifest unknown' });
  });

  it('makes an isolated environment for a local-model method with a git pin and no pip pin, and none for a catalog', async () => {
    const base = makeWorkspace();
    const repo = spriteRepo(base);
    const { ws, env, log } = workspace({
      resourceGeneration: [
        {
          name: 'music',
          kind: 'local-model',
          resourceTypes: ['bgm'],
          safetyTimeoutMs: 1,
          license: 'X',
          pins: [
            { kind: 'git', source: repo.dir, revision: repo.commit },
            { kind: 'hf', source: 'o/whole', revision: REV },
          ],
        },
        { name: 'cat', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, pins: [{ kind: 'git', source: repo.dir, revision: repo.commit }] },
      ],
    });
    setNet(
      fakeNet({
        [`https://huggingface.co/api/models/o/whole/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'a.json' }, { rfilename: 'ckpts/b.bin' }] },
        [`https://huggingface.co/o/whole/resolve/${REV}/a.json`]: '{}',
        [`https://huggingface.co/o/whole/resolve/${REV}/ckpts/b.bin`]: 'b',
      }),
    );
    for (const name of ['music', 'cat']) expect(await ogw(ws, ['generation', 'install', name], { env })).toMatchObject({ code: 0, stdout: expect.stringContaining(`method ${name}: installed`) as unknown });
    const [musicDir, catDir] = settingsMethods(ws).map((m) => installFolder(ws, m, env));
    const musicFolder = (await musicDir) as string;
    const catFolder = (await catDir) as string;
    expect(readFileSync(log, 'utf8')).toBe(`uv venv --quiet ${join(musicFolder, 'venv')}\n`);
    const music = JSON.parse(readFileSync(join(musicFolder, 'installed.json'), 'utf8')) as MethodMarker;
    expect(music.python).toBe(join(musicFolder, 'venv', 'bin', 'python'));
    expect(music.git).toEqual([{ source: repo.dir, dir: join(musicFolder, 'git', '0'), revision: repo.commit }]);
    // Without `files` the hf pin gets the whole repository.
    expect(readFileSync(join(musicFolder, 'hf', '1', 'ckpts', 'b.bin'), 'utf8')).toBe('b');
    const cat = JSON.parse(readFileSync(join(catFolder, 'installed.json'), 'utf8')) as MethodMarker;
    expect(cat.python).toBeNull();
    expect(existsSync(join(catFolder, 'venv'))).toBe(false);
  });

  it('checks an hf pin SHA-256 with the published LFS SHA-256 before downloading the LFS files, and each LFS file as it arrives', async () => {
    const hfPin = (source: string, sha256?: string): Record<string, unknown> => ({ kind: 'hf', source, revision: REV, ...(sha256 === undefined ? {} : { sha256 }) });
    const method = (name: string, pin: Record<string, unknown>): Record<string, unknown> => ({ name, kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [pin] });
    const right = hfDigest([{ path: 'a.json', sha256: sha('{}') }, { path: 'big.bin', sha256: sha('big') }]);
    const { ws, env } = workspace({ resourceGeneration: [method('prebad', hfPin('o/pre', 'a'.repeat(64))), method('filebad', hfPin('o/file')), method('good', hfPin('o/good', right))] });
    const siblings = [{ rfilename: 'a.json' }, { rfilename: 'big.bin', lfs: { sha256: sha('big') } }];
    const net = fakeNet({
      [`https://huggingface.co/api/models/o/pre/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/pre/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/pre/resolve/${REV}/big.bin`]: 'big',
      [`https://huggingface.co/api/models/o/file/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/file/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/file/resolve/${REV}/big.bin`]: 'tampered',
      [`https://huggingface.co/api/models/o/good/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/good/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/good/resolve/${REV}/big.bin`]: 'big',
    });
    setNet(net);
    const reasons: Record<string, string> = {};
    for (const name of ['prebad', 'filebad', 'good']) {
      const run = await ogw(ws, ['generation', 'install', name, '--json'], { env });
      reasons[name] = (JSON.parse(run.stdout) as { methods: Record<string, { installed: boolean; reason: string | null }> }).methods[name]?.reason ?? 'installed';
    }
    expect(reasons.prebad).toBe('hf o/pre SHA-256 differs (checked with the published SHA-256 of its LFS files, before downloading them)');
    expect(net.calls).not.toContain(`GET https://huggingface.co/o/pre/resolve/${REV}/big.bin`);
    expect(reasons.filebad).toBe('hf o/file file big.bin SHA-256 differs from the published one');
    expect(reasons.good).toBe('installed');
  });

  it('takes the LFS files of an hf pin from another install of the method with the same source and revision, and keeps that install', async () => {
    const REV2 = 'd'.repeat(40);
    const hf = (revision: string): Record<string, unknown> => ({ kind: 'hf', source: 'o/m', revision });
    const { ws, env } = workspace({ resourceGeneration: [{ name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [hf(REV)] }] });
    const siblings = [{ rfilename: 'a.json' }, { rfilename: 'w/big.bin', lfs: { sha256: sha('big') } }];
    const net = fakeNet({
      [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/m/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/m/resolve/${REV}/w/big.bin`]: 'big',
      [`https://huggingface.co/api/models/o/m/revision/${REV2}?blobs=true`]: { sha: REV2, siblings },
      [`https://huggingface.co/o/m/resolve/${REV2}/a.json`]: '{}',
      [`https://huggingface.co/o/m/resolve/${REV2}/w/big.bin`]: 'big',
    });
    setNet(net);
    const settingsFile = join(ws.harness, 'settings.json');
    const method = (pins: Record<string, unknown>[]): MethodLike => ({ name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins });
    const install = async (pins: Record<string, unknown>[], extra: NodeJS.ProcessEnv = {}): Promise<{ installed: boolean; reason: string | null }> => {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: unknown[] }[] };
      (settings.resourceGeneration[0] as { pins: unknown[] }).pins = pins;
      writeFileSync(settingsFile, JSON.stringify(settings));
      const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env: { ...env, ...extra } });
      return (JSON.parse(run.stdout) as { methods: Record<string, { installed: boolean; reason: string | null }> }).methods.m as { installed: boolean; reason: string | null };
    };
    const gets = (revision: string, path: string): number => net.calls.filter((c) => c === `GET https://huggingface.co/o/m/resolve/${revision}/${path}`).length;
    const folder = (pins: Record<string, unknown>[]): Promise<string> => installFolder(ws, method(pins), env);
    const files = (dir: string): string[] => sh(dir, 'find', ['.', '-type', 'f']).split('\n').filter((f) => f !== '').sort();
    /** Puts another file at `path`, so that the file another install links to stays as it is. */
    const replace = (path: string, body: string): void => {
      rmSync(path);
      writeFileSync(path, body);
    };

    const first = await folder([hf(REV)]);
    expect(await install([hf(REV)])).toMatchObject({ installed: true });
    expect([gets(REV, 'w/big.bin'), gets(REV, 'a.json')]).toEqual([1, 1]);
    const fresh = files(first);

    // Other pins are another install folder: the LFS file comes from the first install without a download, the small
    // file is downloaded again, and the first install keeps every file.
    const withPip = [{ kind: 'pip', source: 'x==1' }, hf(REV)];
    const second = await folder(withPip);
    expect(second).not.toBe(first);
    expect(await install(withPip)).toMatchObject({ installed: true });
    expect([gets(REV, 'w/big.bin'), gets(REV, 'a.json')]).toEqual([1, 2]);
    expect(readFileSync(join(second, 'hf', '1', 'w', 'big.bin'), 'utf8')).toBe('big');
    expect(files(second)).toEqual([...fresh.map((f) => f.replace('./hf/0/', './hf/1/')), './venv/bin/python'].sort());
    expect(files(first)).toEqual(fresh);
    expect(readFileSync(join(first, 'hf', '0', 'w', 'big.bin'), 'utf8')).toBe('big');
    const marker = JSON.parse(readFileSync(join(second, 'installed.json'), 'utf8')) as MethodMarker;
    expect(marker.pins).toBe(JSON.stringify(withPip));

    // A file of another install whose SHA-256 differs from the published one is not taken: the file is downloaded again.
    replace(join(first, 'hf', '0', 'w', 'big.bin'), 'tampered');
    replace(join(second, 'hf', '1', 'w', 'big.bin'), 'tampered');
    const third = [{ kind: 'pip', source: 'x==2' }, hf(REV)];
    expect(await install(third)).toMatchObject({ installed: true });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(readFileSync(join(await folder(third), 'hf', '1', 'w', 'big.bin'), 'utf8')).toBe('big');

    // An install that fails after the hf download keeps only the checked LFS files of its folder, under `.reuse`, and no
    // marker; the next install of that folder takes them from there and leaves no `.reuse`.
    const later = [{ kind: 'pip', source: 'y==1' }, hf(REV)];
    const laterDir = await folder(later);
    expect(await install(later, { OGW_TEST_UV_FAIL: '1' })).toMatchObject({ installed: false });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(files(laterDir)).toEqual(['./.reuse/1/w/big.bin', './.reuse/pins.json']);
    for (const dir of [first, second, await folder(third)]) rmSync(dir, { recursive: true });
    expect(await install(later)).toMatchObject({ installed: true });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(readFileSync(join(laterDir, 'hf', '1', 'w', 'big.bin'), 'utf8')).toBe('big');
    expect(files(laterDir).some((f) => f.startsWith('./.reuse/'))).toBe(false);

    // A failed install whose hf pins got nothing leaves no install folder.
    const failing = [{ kind: 'pip', source: 'fail-install==1' }];
    expect(await install(failing)).toMatchObject({ installed: false });
    expect(existsSync(await folder(failing))).toBe(false);

    // A changed revision downloads every file.
    expect(await install([hf(REV2)])).toMatchObject({ installed: true });
    expect([gets(REV2, 'w/big.bin'), gets(REV2, 'a.json')]).toEqual([1, 1]);
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(files(await folder([hf(REV2)]))).toEqual(fresh);
  });

  it('takes the LFS files of an hf pin from an install in the method folder itself, and keeps that install', async () => {
    const pins = [{ kind: 'hf', source: 'o/m', revision: REV }];
    const method: MethodLike = { name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins };
    const { ws, env } = workspace({ resourceGeneration: [method] });
    const siblings = [{ rfilename: 'a.json' }, { rfilename: 'w/big.bin', lfs: { sha256: sha('big') } }];
    const net = fakeNet({
      [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/m/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/m/resolve/${REV}/w/big.bin`]: 'big',
    });
    setNet(net);
    // another install of the method: `.ogw/generation/<method>/` itself, with its files of pin 0 in `hf/0/`
    const methodFolder = join(ws.root, '.ogw', 'generation', 'm');
    mkdirSync(join(methodFolder, 'hf', '0', 'w'), { recursive: true });
    writeFileSync(join(methodFolder, 'hf', '0', 'w', 'big.bin'), 'big');
    writeFileSync(join(methodFolder, 'hf', '0', 'a.json'), '{}');
    const other = { name: 'm', pins: JSON.stringify(pins), git: [], hf: [{ source: 'o/m', dir: join(methodFolder, 'hf', '0') }], files: null, python: null, cli: null, skill: null };
    writeFileSync(join(methodFolder, 'installed.json'), JSON.stringify(other));
    const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env });
    expect((JSON.parse(run.stdout) as { methods: Record<string, unknown> }).methods.m).toMatchObject({ installed: true });
    // the LFS file is taken without a download, by a hard link; the small file is downloaded
    const gets = (path: string): number => net.calls.filter((c) => c === `GET https://huggingface.co/o/m/resolve/${REV}/${path}`).length;
    expect([gets('w/big.bin'), gets('a.json')]).toEqual([0, 1]);
    const taken = join(await installFolder(ws, method, env), 'hf', '0', 'w', 'big.bin');
    expect(readFileSync(taken, 'utf8')).toBe('big');
    expect(statSync(taken).ino).toBe(statSync(join(methodFolder, 'hf', '0', 'w', 'big.bin')).ino);
    // the other install keeps its marker and files
    expect(readFileSync(join(methodFolder, 'installed.json'), 'utf8')).toBe(JSON.stringify(other));
    expect(readFileSync(join(methodFolder, 'hf', '0', 'a.json'), 'utf8')).toBe('{}');
  });

  it('keeps its install when a harness before the install keys empties .ogw/generation/<method>/ to install that method', async () => {
    const method: MethodLike = { name: 'p', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'pip', source: 'p==1' }] };
    const { ws, env, log } = workspace({ resourceGeneration: [method] });
    expect((await ogw(ws, ['generation', 'install', 'p'], { env })).stdout).toContain('method p: installed');
    const folder = await installFolder(ws, method, env);
    expect(folder.startsWith(`${join(ws.root, '.ogw', 'generation-install', 'p')}/`)).toBe(true);
    const marker = readFileSync(join(folder, 'installed.json'), 'utf8');
    // the install of that harness: every entry of its method folder but `.reuse` removed, then its own install written there
    const older = join(ws.root, '.ogw', 'generation', 'p');
    mkdirSync(older, { recursive: true });
    for (const name of readdirSync(older)) if (name !== '.reuse') rmSync(join(older, name), { recursive: true, force: true });
    writeFileSync(join(older, 'installed.json'), JSON.stringify({ name: 'p', pins: JSON.stringify([{ kind: 'pip', source: 'p==0' }]), git: [], hf: [], files: null, python: null, cli: null, skill: null }));
    expect(readFileSync(join(folder, 'installed.json'), 'utf8')).toBe(marker);
    // this checkout still has its install: a second install runs nothing
    writeFileSync(log, '');
    expect((await ogw(ws, ['generation', 'install', 'p'], { env })).stdout).toContain('method p: installed');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('takes an install folder of .ogw/generation/<method>/<install key>/ only as another install to link hf files from', async () => {
    const pins = [{ kind: 'hf', source: 'o/m', revision: REV }];
    const method: MethodLike = { name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins };
    const { ws, env } = workspace({ resourceGeneration: [method] });
    const siblings = [{ rfilename: 'a.json' }, { rfilename: 'w/big.bin', lfs: { sha256: sha('big') } }];
    const net = fakeNet({
      [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings },
      [`https://huggingface.co/o/m/resolve/${REV}/a.json`]: '{}',
      [`https://huggingface.co/o/m/resolve/${REV}/w/big.bin`]: 'big',
    });
    setNet(net);
    // a complete install of these pins under `.ogw/generation/<method>/`, in the folder of the same install key
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const generationMethod = settingsMethods(ws)[0] as unknown as Parameters<typeof methodMarker>[1];
    const older = join(ws.root, '.ogw', 'generation', 'm', await installKey(ctx, generationMethod));
    mkdirSync(join(older, 'hf', '0', 'w'), { recursive: true });
    writeFileSync(join(older, 'hf', '0', 'w', 'big.bin'), 'big');
    writeFileSync(join(older, 'hf', '0', 'a.json'), '{}');
    const marker = JSON.stringify({ name: 'm', pins: JSON.stringify(pins), git: [], hf: [{ source: 'o/m', dir: join(older, 'hf', '0') }], files: null, python: null, cli: null, skill: null });
    writeFileSync(join(older, 'installed.json'), marker);
    // it is not the install of this checkout
    expect(await methodMarker(ctx, generationMethod)).toBeNull();
    const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env });
    expect((JSON.parse(run.stdout) as { methods: Record<string, unknown> }).methods.m).toMatchObject({ installed: true });
    const folder = await installFolder(ws, method, env);
    expect(folder).toBe(join(ws.root, '.ogw', 'generation-install', 'm', basename(older)));
    expect(await methodMarker(ctx, generationMethod)).toMatchObject({ name: 'm', hf: [{ source: 'o/m', dir: join(folder, 'hf', '0') }] });
    // its LFS file is linked, the small file is downloaded, and its folder keeps every file
    const gets = (path: string): number => net.calls.filter((c) => c === `GET https://huggingface.co/o/m/resolve/${REV}/${path}`).length;
    expect([gets('w/big.bin'), gets('a.json')]).toEqual([0, 1]);
    expect(statSync(join(folder, 'hf', '0', 'w', 'big.bin')).ino).toBe(statSync(join(older, 'hf', '0', 'w', 'big.bin')).ino);
    expect(readFileSync(join(older, 'installed.json'), 'utf8')).toBe(marker);
    expect(readFileSync(join(older, 'hf', '0', 'a.json'), 'utf8')).toBe('{}');
  });

  it('sends the token of an hf pin secret, installs an hf pin without sha256 and records its SHA-256', async () => {
    const DINO = 'facebook/dinov3';
    const files: Record<string, string> = { 'model.safetensors': 'weights', 'LICENSE.md': 'license', 'README.md': 'readme' };
    const digest = hfDigest(['model.safetensors', 'LICENSE.md'].map((path) => ({ path, sha256: sha(files[path] as string) })));
    const pin = { kind: 'hf', source: DINO, revision: REV, files: 'model.safetensors,LICENSE.md', secret: 'huggingface' };
    const method = { name: 'm3d', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: [pin] };
    const { ws, env } = workspace({ resourceGeneration: [method] });
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/huggingface': 'hf_token' }));
    const authorized = (body: string | object) => (init: { headers?: Record<string, string> }) => {
      const ok = init.headers?.Authorization === 'Bearer hf_token';
      return { status: ok ? 200 : 401, headers: {}, body: Buffer.from(ok ? (typeof body === 'string' ? body : JSON.stringify(body)) : 'no') };
    };
    const net = fakeNet({
      [`https://huggingface.co/api/models/${DINO}/revision/${REV}?blobs=true`]: authorized({ sha: REV, siblings: Object.keys(files).map((rfilename) => ({ rfilename })) }),
      ...Object.fromEntries(Object.entries(files).map(([path, body]) => [`https://huggingface.co/${DINO}/resolve/${REV}/${path}`, authorized(body)])),
    });
    setNet(net);
    const run = await ogw(ws, ['generation', 'install', 'm3d'], { env });
    expect(run).toMatchObject({ code: 0, stdout: expect.stringContaining('method m3d: installed') as unknown });
    expect(run.stdout).not.toContain('hf_token');
    const dir = await installFolder(ws, method, env);
    expect(readFileSync(join(dir, 'hf', '0', 'model.safetensors'), 'utf8')).toBe('weights');
    expect(existsSync(join(dir, 'hf', '0', 'README.md'))).toBe(false);
    const marker = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as MethodMarker;
    expect(marker.hf).toEqual([{ source: DINO, dir: join(dir, 'hf', '0'), sha256: digest }]);

    // The sha256 the install got, added to the pin, keeps the install in the same install folder; another sha256 fails,
    // naming both values, and changes nothing in that folder.
    const calls = net.calls.length;
    const settingsFile = join(ws.harness, 'settings.json');
    const pinsOf = (pins: Record<string, unknown>[]): void => {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: Record<string, unknown>[] }[] };
      (settings.resourceGeneration[0] as { pins: Record<string, unknown>[] }).pins = pins;
      writeFileSync(settingsFile, JSON.stringify(settings));
    };
    pinsOf([{ ...pin, sha256: digest }]);
    expect(await installFolder(ws, { ...method, pins: [{ ...pin, sha256: digest }] }, env)).toBe(dir);
    expect((await ogw(ws, ['generation', 'install', 'm3d'], { env })).code).toBe(0);
    expect(net.calls.length).toBe(calls);
    const wrong = 'f'.repeat(64);
    pinsOf([{ ...pin, sha256: wrong }]);
    const before = sh(dir, 'find', ['.', '-type', 'f']);
    const refused = JSON.parse((await ogw(ws, ['generation', 'install', 'm3d', '--json'], { env })).stdout) as { methods: Record<string, { installed: boolean; reason: string; mismatches: unknown[] }> };
    expect(refused.methods.m3d).toMatchObject({
      installed: false,
      reason: `${dir} holds an install whose hf files have another SHA-256 than the pin (hf ${DINO} sha256 ${wrong}, installed ${digest}); it is kept as it is`,
      mismatches: [{ what: DINO, path: join(dir, 'hf', '0'), expected: wrong, actual: digest }],
    });
    expect(net.calls.length).toBe(calls);
    expect(sh(dir, 'find', ['.', '-type', 'f'])).toBe(before);
    expect(installedFrom(marker, [{ ...pin, sha256: wrong } as never])).toBe(false);
    expect(installedFrom(marker, [{ ...pin, files: '*', sha256: digest } as never])).toBe(false);
    expect(installedFrom(marker, [pin as never])).toBe(true);
    // an install whose pins had the sha256 is also the install of the pins without it
    expect(installedFrom({ ...marker, pins: JSON.stringify([{ ...pin, sha256: digest }]) }, [pin as never])).toBe(true);
  });

  it('fails an hf pin whose secret is missing or whose token is refused', async () => {
    const pin = { kind: 'hf', source: 'facebook/gated', revision: REV, files: '*', secret: 'huggingface' };
    const { ws, env } = workspace({ resourceGeneration: [{ name: 'm3d', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: [pin] }] });
    const net = fakeNet({ [`https://huggingface.co/api/models/facebook/gated/revision/${REV}?blobs=true`]: () => ({ status: 403, headers: {}, body: Buffer.from('gated') }) });
    setNet(net);
    const action = 'accept the license on https://huggingface.co/facebook/gated with a Hugging Face account, then put an access token of that account in the host secret store: ogw secret set --harness huggingface';
    const missing = await ogw(ws, ['generation', 'install', 'm3d', '--json'], { env });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      methods: { m3d: { installed: false, secretMissing: 'huggingface', reason: `harness secret huggingface of hf pin facebook/gated is not in the host secret store: ${action}` } },
    });
    expect(net.calls).toEqual([]);
    const text = await ogw(ws, ['generation', 'install', 'm3d'], { env });
    expect(text.stdout).toContain('put the secret in the host secret store: ogw secret set --harness huggingface');

    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/huggingface': 'hf_token' }));
    const refused = await ogw(ws, ['generation', 'install', 'm3d', '--json'], { env });
    const entry = (JSON.parse(refused.stdout) as { methods: Record<string, Record<string, unknown>> }).methods.m3d;
    expect(entry).toEqual({ kind: 'local-model', installed: false, reason: `hf facebook/gated answered 403 to the token in harness secret huggingface: ${action}`, mismatches: [] });
    expect(existsSync(await installFolder(ws, settingsMethods(ws)[0] as MethodLike, env))).toBe(false);
  });

  it('waits for the method folder lock and keeps the result entries of installs that run together', async () => {
    const pip = (name: string): Record<string, unknown> => ({ name, kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'pip', source: `${name}==1` }] });
    const { ws, env, log } = workspace({ resourceGeneration: [pip('p1'), pip('p2')] });
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    let release = (): void => undefined;
    let acquired = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const p1 = settingsMethods(ws).find((m) => m.name === 'p1') as unknown as Parameters<typeof withMethodLock>[1];
    const holding = withMethodLock(ctx, p1, () => {
      acquired();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await held;
    const first = ogw(ws, ['generation', 'install', 'p1'], { env });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(existsSync(await installFolder(ws, p1 as unknown as MethodLike, env))).toBe(false);
    const second = ogw(ws, ['generation', 'install', 'p2'], { env });
    release();
    await holding;
    expect((await Promise.all([first, second])).map((r) => r.code)).toEqual([0, 0]);
    expect(readFileSync(log, 'utf8')).toContain('p1==1');
    const result = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-install.json'), 'utf8')) as { methods: Record<string, unknown> };
    expect(Object.keys(result.methods).sort()).toEqual(['p1', 'p2']);
  });

  it('records the install folder of each method in the job record of its job before it installs that method', async () => {
    const pip = (name: string): MethodLike => ({ name, kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'pip', source: `${name}==1` }] });
    const { ws, env, log } = workspace({ resourceGeneration: [pip('p1'), pip('p2')], tools: { postgresql: { tag: '18.6', digest: `sha256:${'d'.repeat(64)}` } } });
    const record: JobRecord = { id: 'mwinstall1', argv: ['generation', 'install', 'p2'], cwd: ws.root, command: 'generation install', game: null, startedAt: 1, endedAt: null, status: 'running', exitCode: null, supervisorPid: null, pid: null, timeLimitMs: 1000, agentJob: null, summary: null, meta: {} };
    await writeJsonAtomic((await jobPaths(record.id, env)).record, record);
    // the install of p2 waits at the lock of its install folder, which the test holds
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const p2 = settingsMethods(ws).find((m) => m.name === 'p2') as unknown as Parameters<typeof withMethodLock>[1];
    const folder = await installFolder(ws, pip('p2'), env);
    let release = (): void => undefined;
    let acquired = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = withMethodLock(ctx, p2, () => {
      acquired();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await held;
    const install = ogw(ws, ['generation', 'install', 'p2'], { env: { ...env, OGW_JOB_ID: record.id } });
    const deadline = Date.now() + 30_000;
    let installs: unknown;
    while (installs === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      installs = (await readJob(record.id, env)).meta.installs;
    }
    // the job record names the install folder while nothing of the install has run
    expect(installs).toEqual({ p2: folder });
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(existsSync(folder)).toBe(false);
    release();
    await holding;
    expect((await install).code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('p2==1');
    expect((await readJob(record.id, env)).meta.installs).toEqual({ p2: folder });
  });

  it('refuses an unknown method', async () => {
    const { ws, env } = workspace();
    const run = await ogw(ws, ['generation', 'install', 'nothing'], { env });
    expect(run).toMatchObject({ code: 1, stderr: 'no method nothing in harness settings resourceGeneration\n' });
  });

  it('splits a pip pin source on the commas outside extras and quoted marker values', () => {
    expect(pipRequirements(`a[x,y]==1,b==2 ; platform_machine in "x86_64,AMD64",c @ git+https://h/c@${REV} ; sys_platform == 'win32'`)).toEqual([
      'a[x,y]==1',
      'b==2 ; platform_machine in "x86_64,AMD64"',
      `c @ git+https://h/c@${REV} ; sys_platform == 'win32'`,
    ]);
  });
});

describe('ogw generation list', () => {
  it('lists every installed file of a catalog method with license, source URL, attribution and character set', async () => {
    const pins = [
      { kind: 'git', source: 'https://github.com/google/fonts.git', revision: REV, files: 'ofl/notosans,apache/x' },
      { kind: 'hf', source: 'org/sfx', revision: REV, files: '*' },
      { kind: 'file', source: 'pack', url: 'https://dl/pack.zip', files: 'pack.zip', sha256: 'a'.repeat(64) },
    ];
    const method = { name: 'cat', kind: 'catalog', resourceTypes: ['font', 'sfx'], safetyTimeoutMs: 1, license: 'CC0-1.0', attribution: 'by someone', pins };
    const { ws, env } = workspace({ resourceGeneration: [method] });
    const dir = await installFolder(ws, method, env);
    const git = join(dir, 'git', '0');
    const fonts = fontRepo(ws);
    mkdirSync(join(dir, 'git'), { recursive: true });
    sh(ws.root, 'cp', ['-R', fonts.dir, git]);
    writeFileSync(join(git, 'README.md'), 'readme');
    mkdirSync(join(dir, 'hf', '1', 'boom'), { recursive: true });
    writeFileSync(join(dir, 'hf', '1', 'boom', 'a b.wav'), 'wav');
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'pack.zip'), 'zip');
    const marker: MethodMarker = {
      name: 'cat',
      pins: JSON.stringify(pins),
      git: [{ source: 'https://github.com/google/fonts.git', dir: git, revision: REV }],
      hf: [{ source: 'org/sfx', dir: join(dir, 'hf', '1') }],
      files: join(dir, 'files'),
      python: null,
      cli: null,
      skill: null,
    };
    writeFileSync(join(dir, 'installed.json'), JSON.stringify(marker));
    const list = await ogw(ws, ['generation', 'list', 'cat', '--json'], { env });
    expect(list.code).toBe(0);
    const blob = `https://github.com/google/fonts/blob/${REV}`;
    const plain = { license: 'CC0-1.0', attribution: 'by someone', charset: [], style: [] };
    expect((JSON.parse(list.stdout) as { files: unknown[] }).files).toEqual([
      { path: join(git, 'README.md'), source: `${blob}/README.md`, ...plain },
      { path: join(git, 'apache', 'x', 'X.ttf'), license: 'Apache-2.0', source: `${blob}/apache/x/X.ttf`, attribution: '', charset: [], style: [] },
      {
        path: join(git, 'ofl', 'notosans', 'NotoSans[wght].ttf'),
        license: 'OFL-1.1',
        source: `${blob}/ofl/notosans/NotoSans%5Bwght%5D.ttf`,
        attribution: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)',
        charset: ['latin', 'menu'],
        style: ['SANS_SERIF', 'DISPLAY'],
      },
      { path: join(git, 'ofl', 'notosans', 'Plain.otf'), license: 'OFL-1.1', source: `${blob}/ofl/notosans/Plain.otf`, attribution: '', charset: ['latin', 'menu'], style: ['SANS_SERIF', 'DISPLAY'] },
      { path: join(git, 'ofl', 'other', 'Other.ttf'), source: `${blob}/ofl/other/Other.ttf`, ...plain },
      { path: join(dir, 'hf', '1', 'boom', 'a b.wav'), source: `https://huggingface.co/org/sfx/blob/${REV}/boom/a%20b.wav`, ...plain },
      { path: join(dir, 'files', 'pack.zip'), source: 'https://dl/pack.zip', ...plain },
    ]);
  });

  it('makes GitHub file URLs with the revision', () => {
    for (const repository of ['https://github.com/google/fonts.git', 'https://github.com/google/fonts']) {
      expect(sourceUrl(repository, REV, 'ofl/a/A.ttf')).toBe(`https://github.com/google/fonts/blob/${REV}/ofl/a/A.ttf`);
    }
    expect(() => sourceUrl('https://gitlab.com/a/b.git', REV, 'x')).toThrow('no source URL for a file of git repository https://gitlab.com/a/b.git');
  });
});

describe('install helpers', () => {
  it('matches fnmatch patterns', () => {
    expect(globMatch('*', 'a/b/c.bin')).toBe(true);
    expect(globMatch('ckpts/*', 'ckpts/x/y')).toBe(true);
    expect(globMatch('ckpts/*', 'other/x')).toBe(false);
    expect(globMatch('model.safetensors', 'model.safetensors')).toBe(true);
    expect(globMatch('model?.bin', 'model1.bin')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
  });

  it('allows secret only on hf pins', async () => {
    const schema = await loadSchema(join(import.meta.dirname, '..', '..', '..', '..', 'schemas', 'harness-settings.schema.json'));
    const settings = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'settings.json'), 'utf8')) as { resourceGeneration: { pins?: Record<string, unknown>[] }[] };
    expect(validateAgainst(schema, settings)).toEqual([]);
    const pins = settings.resourceGeneration.find((m) => m.pins?.some((p) => p.kind === 'git'))?.pins ?? [];
    const git = pins.find((p) => p.kind === 'git') as Record<string, unknown>;
    git.secret = 'huggingface';
    expect(validateAgainst(schema, settings)).not.toEqual([]);
  });

  it('digests hf files in path order with one line each', () => {
    expect(hfDigest([{ path: 'b', sha256: '2' }, { path: 'a', sha256: '1' }])).toBe(sha256Text('a 1\nb 2\n'));
  });

  it('reads the one project script', () => {
    expect(projectScript('[project.scripts]\n"tool-x" = "m:f"\n')).toBe('tool-x');
    expect(() => projectScript('[project]\nname = "x"\n')).toThrow('one [project.scripts] entry, found 0');
    expect(() => projectScript('[project.scripts]\na = "m:f"\nb = "m:g"\n')).toThrow('found 2');
  });

  it('writes a provider cli that runs from a path with a quote and a percent sign', () => {
    const ws = makeWorkspace();
    const root = join(ws.root, "o'neil %PATH% $HOME");
    const ffmpegDir = join(root, 'ffmpeg');
    const target = join(root, 'venv', 'bin', 'sprite-gen');
    mkdirSync(join(root, 'venv', 'bin'), { recursive: true });
    writeFileSync(target, '#!/bin/sh\necho "$PATH" | cut -d: -f1\nfor a in "$@"; do echo "<$a>"; done\n');
    chmodSync(target, 0o755);
    const cli = join(root, 'cli');
    writeFileSync(cli, cliWrapper(ffmpegDir, target, false));
    chmodSync(cli, 0o755);
    expect(sh(root, cli, ['a b', "c'd"])).toBe(`${ffmpegDir}\n<a b>\n<c'd>\n`);
    expect(cliWrapper('C:\\u\\100%\\ff', 'C:\\u\\100%\\gen.exe', true)).toBe('@echo off\r\nset "PATH=C:\\u\\100%%\\ff;%PATH%"\r\n"C:\\u\\100%%\\gen.exe" %*\r\n');
  });
});
