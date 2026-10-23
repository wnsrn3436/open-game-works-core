import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolProgram } from '../../../src/commands/env/api.ts';
import { sha256Text } from '../../../src/commands/env/lib/files.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { cliWrapper, globMatch, hfDigest, installedFrom, pipRequirements, projectScript, withMethodLock, type MethodMarker } from '../../../src/commands/generation/lib/install.ts';
import { loadSchema, validateAgainst } from '../../../src/lib/settings.ts';
import { sourceUrl } from '../../../src/commands/generation/list.ts';
import { createContext } from '../../../src/lib/command.ts';
import { commitAll, ogw, gitInit, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from '../env/fakes.ts';

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
    const { ws, env, log } = workspace({
      resourceGeneration: [
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
      ],
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

    const gen = join(ws.root, '.ogw', 'generation');
    expect(existsSync(join(gen, 'font-catalog', 'git', '0', 'ofl', 'notosans', 'NotoSans[wght].ttf'))).toBe(true);
    expect(existsSync(join(gen, 'font-catalog', 'git', '0', 'ofl', 'other'))).toBe(false);
    expect(readFileSync(join(gen, 'img', 'hf', '1', 'sub', 'b.bin'), 'utf8')).toBe('bbb');
    expect(readFileSync(join(gen, 'img', 'files', 'birefnet-general.onnx'), 'utf8')).toBe('onnx');
    expect(readFileSync(join(gen, 'sprite', 'git', '0', 'patched.txt'), 'utf8')).toBe('new\n');
    const marker = JSON.parse(readFileSync(join(gen, 'sprite', 'installed.json'), 'utf8')) as { cli: string; skill: string };
    expect(marker.skill).toBe(join(gen, 'sprite', 'git', '0', 'skill', 'SKILL.md'));
    expect(marker.cli).toBe(join(gen, 'sprite', 'bin', 'sprite-gen'));
    const wrapper = readFileSync(marker.cli, 'utf8');
    expect(wrapper).toContain(`PATH='${join(ws.root, '.ogw', 'tools', 'ffmpeg', '7', 'download')}':"$PATH"`);
    expect(wrapper).toContain(`exec '${join(gen, 'sprite', 'venv', 'bin', 'sprite-gen')}' "$@"`);

    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`uv pip install --quiet --python ${join(gen, 'img', 'venv', 'bin', 'python')} mflux==0.20.0 rembg[cpu,cli]==2.0.85 torch==2.9.0`);
    // each requirement is one argument, with its extras and marker
    expect(calls).toContain("arg<rembg[cpu,cli]==2.0.85>\narg<torch==2.9.0 ; sys_platform == 'darwin' and platform_machine == 'arm64'>\n");
    expect(calls).toContain(`uv pip install --quiet --no-deps --python ${join(gen, 'sprite', 'venv', 'bin', 'python')} ${join(gen, 'sprite', 'git', '0')}`);
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

    // A new tools.ffmpeg makes the provider method install again, so its CLI puts the new ffmpeg on PATH.
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { tools: Record<string, unknown> };
    settings.tools.ffmpeg = { version: '8', downloads: [{ platform: 'macos-arm64', url: 'https://dl/ffmpeg8', sha256: sha(ffmpegScript('libvorbis')) }] };
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect((await ogw(ws, ['generation', 'install'], { env })).stdout).toContain('method sprite: installed');
    const again = JSON.parse(readFileSync(join(gen, 'sprite', 'installed.json'), 'utf8')) as { cli: string };
    expect(readFileSync(again.cli, 'utf8')).toContain(`PATH='${join(ws.root, '.ogw', 'tools', 'ffmpeg', '8', 'download')}':"$PATH"`);
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
    for (const name of Object.keys(result.methods)) expect(existsSync(join(ws.root, '.ogw', 'generation', name))).toBe(false);
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
    const gen = join(ws.root, '.ogw', 'generation');
    expect(readFileSync(log, 'utf8')).toBe(`uv venv --quiet ${join(gen, 'music', 'venv')}\n`);
    const music = JSON.parse(readFileSync(join(gen, 'music', 'installed.json'), 'utf8')) as MethodMarker;
    expect(music.python).toBe(join(gen, 'music', 'venv', 'bin', 'python'));
    expect(music.git).toEqual([{ source: repo.dir, dir: join(gen, 'music', 'git', '0'), revision: repo.commit }]);
    // Without `files` the hf pin gets the whole repository.
    expect(readFileSync(join(gen, 'music', 'hf', '1', 'ckpts', 'b.bin'), 'utf8')).toBe('b');
    const cat = JSON.parse(readFileSync(join(gen, 'cat', 'installed.json'), 'utf8')) as MethodMarker;
    expect(cat.python).toBeNull();
    expect(existsSync(join(gen, 'cat', 'venv'))).toBe(false);
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

  it('keeps the LFS files of an hf pin whose source and revision are unchanged when other pins change', async () => {
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
    const install = async (pins: Record<string, unknown>[]): Promise<{ installed: boolean; reason: string | null }> => {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: unknown[] }[] };
      (settings.resourceGeneration[0] as { pins: unknown[] }).pins = pins;
      writeFileSync(settingsFile, JSON.stringify(settings));
      const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env });
      return (JSON.parse(run.stdout) as { methods: Record<string, { installed: boolean; reason: string | null }> }).methods.m as { installed: boolean; reason: string | null };
    };
    const gets = (revision: string, path: string): number => net.calls.filter((c) => c === `GET https://huggingface.co/o/m/resolve/${revision}/${path}`).length;
    const dir = join(ws.root, '.ogw', 'generation', 'm');
    const files = (): string[] => sh(dir, 'find', ['.', '-type', 'f']).split('\n').filter((f) => f !== '').sort();

    expect(await install([hf(REV)])).toMatchObject({ installed: true });
    expect([gets(REV, 'w/big.bin'), gets(REV, 'a.json')]).toEqual([1, 1]);
    const fresh = files();

    // A pip pin added before the hf pin: the LFS file moves to the new pin index without a download; the small file is downloaded again.
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'stray'), 'x');
    writeFileSync(join(dir, 'hf', '0', 'stray.txt'), 'x');
    expect(await install([{ kind: 'pip', source: 'x==1' }, hf(REV)])).toMatchObject({ installed: true });
    expect([gets(REV, 'w/big.bin'), gets(REV, 'a.json')]).toEqual([1, 2]);
    expect(readFileSync(join(dir, 'hf', '1', 'w', 'big.bin'), 'utf8')).toBe('big');
    // the folder is as a fresh install leaves it: no file of the earlier install, no reuse folder
    expect(files()).toEqual([...fresh.map((f) => f.replace('./hf/0/', './hf/1/')), './venv/bin/python'].sort());
    const marker = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as MethodMarker;
    expect(marker.pins).toBe(JSON.stringify([{ kind: 'pip', source: 'x==1' }, hf(REV)]));

    // A kept file whose SHA-256 differs from the published one is downloaded again.
    writeFileSync(join(dir, 'hf', '1', 'w', 'big.bin'), 'tampered');
    expect(await install([{ kind: 'pip', source: 'x==2' }, hf(REV)])).toMatchObject({ installed: true });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(readFileSync(join(dir, 'hf', '1', 'w', 'big.bin'), 'utf8')).toBe('big');

    // A pip step that fails after the hf download keeps only the checked LFS files, under `.reuse`, and no marker.
    expect(await install([{ kind: 'pip', source: 'fail-install==1' }, hf(REV)])).toMatchObject({ installed: false });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(files()).toEqual(['./.reuse/1/w/big.bin', './.reuse/pins.json']);
    // A second failure keeps them again without downloading the LFS file.
    expect(await install([{ kind: 'pip', source: 'fail-install==2' }, hf(REV)])).toMatchObject({ installed: false });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(files()).toEqual(['./.reuse/1/w/big.bin', './.reuse/pins.json']);
    // The next install reuses them at the new pin index and leaves no `.reuse`.
    expect(await install([hf(REV)])).toMatchObject({ installed: true });
    expect(gets(REV, 'w/big.bin')).toBe(2);
    expect(readFileSync(join(dir, 'hf', '0', 'w', 'big.bin'), 'utf8')).toBe('big');
    expect(files()).toEqual(fresh);

    // A failed install whose hf pins got nothing leaves no folder.
    expect(await install([{ kind: 'pip', source: 'fail-install==1' }])).toMatchObject({ installed: false });
    expect(existsSync(dir)).toBe(false);
    expect(await install([hf(REV)])).toMatchObject({ installed: true });
    expect(gets(REV, 'w/big.bin')).toBe(3);

    // A changed revision downloads every file.
    expect(await install([hf(REV2)])).toMatchObject({ installed: true });
    expect([gets(REV2, 'w/big.bin'), gets(REV2, 'a.json')]).toEqual([1, 1]);
    expect(gets(REV, 'w/big.bin')).toBe(3);
    expect(files()).toEqual(fresh);
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
    const dir = join(ws.root, '.ogw', 'generation', 'm3d');
    expect(readFileSync(join(dir, 'hf', '0', 'model.safetensors'), 'utf8')).toBe('weights');
    expect(existsSync(join(dir, 'hf', '0', 'README.md'))).toBe(false);
    const marker = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as MethodMarker;
    expect(marker.hf).toEqual([{ source: DINO, dir: join(dir, 'hf', '0'), sha256: digest }]);

    // The sha256 the install got, added to the pin, keeps the install; another sha256 does not.
    const calls = net.calls.length;
    const settingsFile = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: Record<string, unknown>[] }[] };
    (settings.resourceGeneration[0] as { pins: Record<string, unknown>[] }).pins = [{ ...pin, sha256: digest }];
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect((await ogw(ws, ['generation', 'install', 'm3d'], { env })).code).toBe(0);
    expect(net.calls.length).toBe(calls);
    expect(installedFrom(marker, [{ ...pin, sha256: 'f'.repeat(64) } as never])).toBe(false);
    expect(installedFrom(marker, [{ ...pin, files: '*', sha256: digest } as never])).toBe(false);
    expect(installedFrom(marker, [pin as never])).toBe(true);
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
    expect(existsSync(join(ws.root, '.ogw', 'generation', 'm3d'))).toBe(false);
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
    const holding = withMethodLock(ctx, 'p1', () => {
      acquired();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await held;
    const first = ogw(ws, ['generation', 'install', 'p1'], { env });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(existsSync(join(ws.root, '.ogw', 'generation', 'p1'))).toBe(false);
    const second = ogw(ws, ['generation', 'install', 'p2'], { env });
    release();
    await holding;
    expect((await Promise.all([first, second])).map((r) => r.code)).toEqual([0, 0]);
    expect(readFileSync(log, 'utf8')).toContain('p1==1');
    const result = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-install.json'), 'utf8')) as { methods: Record<string, unknown> };
    expect(Object.keys(result.methods).sort()).toEqual(['p1', 'p2']);
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
    const dir = join(ws.root, '.ogw', 'generation', 'cat');
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
    const plain = { license: 'CC0-1.0', attribution: 'by someone', charset: [] };
    expect((JSON.parse(list.stdout) as { files: unknown[] }).files).toEqual([
      { path: join(git, 'README.md'), source: `${blob}/README.md`, ...plain },
      { path: join(git, 'apache', 'x', 'X.ttf'), license: 'Apache-2.0', source: `${blob}/apache/x/X.ttf`, attribution: '', charset: [] },
      {
        path: join(git, 'ofl', 'notosans', 'NotoSans[wght].ttf'),
        license: 'OFL-1.1',
        source: `${blob}/ofl/notosans/NotoSans%5Bwght%5D.ttf`,
        attribution: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)',
        charset: ['latin', 'menu'],
      },
      { path: join(git, 'ofl', 'notosans', 'Plain.otf'), license: 'OFL-1.1', source: `${blob}/ofl/notosans/Plain.otf`, attribution: '', charset: ['latin', 'menu'] },
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
