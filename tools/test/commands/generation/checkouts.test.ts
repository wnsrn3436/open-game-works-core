// Two checkouts of the harness on one host that share the install root .ogw/generation-install (ogw.md `## generation install`): through
// one workspace root, or through a symbolic link to another workspace's folder. The tests use only ogw commands and
// the files the install leaves.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Text } from '../../../src/commands/env/lib/files.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { commitAll, gitInit, makeGame, makeWorkspace, ogw, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from '../env/fakes.ts';

const FFMPEG = '#!/bin/sh\necho " A....D libvorbis            Vorbis"\n';
const UV = [
  'if [ "$1" = venv ]; then for last; do :; done; mkdir -p "$last/bin"; touch "$last/bin/python"; exit 0; fi',
  'echo "uv $*" >> "$OGW_TEST_LOG"',
].join('\n');
const RESOURCES = 'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash\nsprite_animation/fx,fx,size=64x64;animations=play:300:once,placeholder,,,,,,,,\n';

afterEach(() => {
  setNet(null);
});

function repo(root: string, name: string, files: Record<string, string>): { dir: string; commit: string } {
  const dir = join(root, name);
  gitInit(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return { dir, commit: commitAll(dir) };
}

function ffmpegPin(version: string): Record<string, unknown> {
  return { version, downloads: [{ platform: 'macos-arm64', url: `https://dl/ffmpeg-${version}`, sha256: sha256Text(FFMPEG) }] };
}

/** A catalog method and a provider method, and `tools.ffmpeg` of `version`. */
function settings(base: string, ffmpegVersion: string): Record<string, unknown> {
  const fonts = repo(base, 'fonts-repo', { 'ofl/a/A.ttf': 'font' });
  const sprite = repo(base, 'sprite-repo', { 'pyproject.toml': '[project]\nname = "sprite-gen"\n\n[project.scripts]\nsprite-gen = "sprite_gen.cli:main"\n', 'SKILL.md': '# skill' });
  return {
    resourceGeneration: [
      { name: 'cat', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, pins: [{ kind: 'git', source: fonts.dir, revision: fonts.commit }] },
      { name: 'sprite', kind: 'external-service', resourceTypes: ['sprite_animation'], provider: 'codex', safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: sprite.dir, revision: sprite.commit }], measured: [{ result: 'ok' }] },
    ],
    tools: {
      postgresql: { tag: '18.6', digest: `sha256:${'d'.repeat(64)}` },
      ffmpeg: ffmpegPin(ffmpegVersion),
    },
  };
}

/** The environment of the checkout `harness` of the workspace `ws`, with fake uv and docker. */
function checkoutEnv(ws: TestWorkspace, harness: string): NodeJS.ProcessEnv {
  const bin = fakeBin(join(ws.root, 'bin'), { uv: UV, docker: 'if [ "$1" = image ]; then exit 1; fi' });
  writeFileSync(join(ws.root, 'calls.log'), '', { flag: 'a' });
  return { ...ws.env, OGW_HARNESS_ROOT: harness, PATH: `${bin}:/usr/bin:/bin`, OGW_TEST_LOG: join(ws.root, 'calls.log'), TMPDIR: join(ws.root, 'tmp'), OGW_HOST_PLATFORM: 'macos-arm64' };
}

/** The `cli` line that `ogw generation methods` gives the provider method. */
async function cliLine(ws: TestWorkspace, env: NodeJS.ProcessEnv): Promise<string> {
  const run = await ogw(ws, ['generation', 'methods', 'g', 'sprite_animation/fx'], { env });
  return run.stdout.split('\n').find((line) => line.startsWith('  cli ')) ?? run.stderr;
}

describe('installs of two checkouts of the harness on one host', () => {
  it('keeps the install of one checkout when another checkout of the same workspace installs with another tools.ffmpeg', async () => {
    const ws = makeWorkspace(settings(sharedFolder(), '7'));
    setNet(fakeNet({ 'https://dl/ffmpeg-7': FFMPEG, 'https://dl/ffmpeg-8': FFMPEG }));
    makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
    // checkout B is a second checkout in the same workspace root: it shares `.ogw/` and has another tools.ffmpeg
    const b = join(ws.root, 'open-game-works-core-b');
    cpSync(ws.harness, b, { recursive: true });
    const bSettings = JSON.parse(readFileSync(join(b, 'settings.json'), 'utf8')) as { tools: { ffmpeg: Record<string, unknown> } };
    bSettings.tools.ffmpeg = ffmpegPin('8');
    writeFileSync(join(b, 'settings.json'), JSON.stringify(bSettings));
    const envA = checkoutEnv(ws, ws.harness);
    const envB = checkoutEnv(ws, b);

    expect((await ogw(ws, ['generation', 'install'], { env: envA })).stdout).toContain('method sprite: installed');
    const cliA = await cliLine(ws, envA);
    expect(cliA).toMatch(/^ {2}cli \//);
    const wrapperA = readFileSync(cliA.slice('  cli '.length), 'utf8');
    expect(wrapperA).toContain(join(ws.root, '.ogw', 'tools', 'ffmpeg', '7'));

    expect((await ogw(ws, ['generation', 'install'], { env: envB })).stdout).toContain('method sprite: installed');
    const cliB = await cliLine(ws, envB);
    expect(readFileSync(cliB.slice('  cli '.length), 'utf8')).toContain(join(ws.root, '.ogw', 'tools', 'ffmpeg', '8'));

    // checkout A still has its install: the same cli, which puts its own ffmpeg on PATH, and a second install changes nothing
    expect(await cliLine(ws, envA)).toBe(cliA);
    expect(readFileSync(cliA.slice('  cli '.length), 'utf8')).toBe(wrapperA);
    writeFileSync(join(ws.root, 'calls.log'), '');
    expect((await ogw(ws, ['generation', 'install', 'sprite'], { env: envA })).stdout).toContain('method sprite: installed');
    expect(readFileSync(join(ws.root, 'calls.log'), 'utf8')).toBe('');
  });

  it('keeps the install of one workspace when another workspace that links its install root .ogw/generation-install installs, and after that workspace is gone', async () => {
    const same = settings(sharedFolder(), '7');
    const one = makeWorkspace(same);
    const two = makeWorkspace(same);
    setNet(fakeNet({ 'https://dl/ffmpeg-7': FFMPEG }));
    for (const ws of [one, two]) makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
    // workspace two reaches the install root of workspace one through a symbolic link; each has its own tools
    mkdirSync(join(one.root, '.ogw', 'generation-install'), { recursive: true });
    mkdirSync(join(two.root, '.ogw'), { recursive: true });
    symlinkSync(join(one.root, '.ogw', 'generation-install'), join(two.root, '.ogw', 'generation-install'));
    const envOne = checkoutEnv(one, one.harness);
    const envTwo = checkoutEnv(two, two.harness);

    // workspace two installs first, through the link
    expect((await ogw(two, ['generation', 'install'], { env: envTwo })).stdout).toContain('method cat: installed');
    expect((await ogw(one, ['generation', 'install'], { env: envOne })).stdout).toContain('method sprite: installed');
    const cliOne = await cliLine(one, envOne);
    expect(readFileSync(cliOne.slice('  cli '.length), 'utf8')).toContain(join(one.root, '.ogw', 'tools', 'ffmpeg', '7'));
    // workspace two installs again: its own provider install, and the catalog install both use
    writeFileSync(join(two.root, 'calls.log'), '');
    expect((await ogw(two, ['generation', 'install'], { env: envTwo })).code).toBe(0);
    expect(await cliLine(one, envOne)).toBe(cliOne);

    // workspace two is gone: what workspace one uses has no path into it
    rmSync(two.root, { recursive: true, force: true });
    expect(await cliLine(one, envOne)).toBe(cliOne);
    expect(existsSync(cliOne.slice('  cli '.length))).toBe(true);
    const list = await ogw(one, ['generation', 'list', 'cat', '--json'], { env: envOne });
    // a local repository has no source URL: the list fails on that, after it found the installed files
    expect(list.stderr).toContain('no source URL for a file of git repository');
    const catFolder = join(one.root, '.ogw', 'generation-install', 'cat');
    const markers = readdirSync(catFolder).filter((name) => existsSync(join(catFolder, name, 'installed.json')));
    expect(markers).toHaveLength(1);
    expect(readFileSync(join(catFolder, markers[0] as string, 'installed.json'), 'utf8')).not.toContain(two.root);
    writeFileSync(join(one.root, 'calls.log'), '');
    expect((await ogw(one, ['generation', 'install'], { env: envOne })).code).toBe(0);
    expect(readFileSync(join(one.root, 'calls.log'), 'utf8')).toBe('');
  });
});

/** A new folder for the source repositories of the pins, outside the workspaces that use them. */
function sharedFolder(): string {
  const dir = join(makeWorkspace().root, 'repos');
  mkdirSync(dir, { recursive: true });
  return dir;
}
