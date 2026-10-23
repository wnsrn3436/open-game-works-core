import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { youtubeId } from '../../../src/commands/game/reference.ts';
import { ogw, makeGame, makeWorkspace } from '../../helpers/workspace.ts';
import { validGameSettings } from '../settings/fixtures.ts';

describe('youtubeId', () => {
  it('reads watch, shorts, live, embed and youtu.be URLs and nothing else', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=8OGpa3lDbto&t=10')).toBe('8OGpa3lDbto');
    expect(youtubeId('https://youtu.be/8OGpa3lDbto')).toBe('8OGpa3lDbto');
    expect(youtubeId('https://m.youtube.com/shorts/abcDEF_123')).toBe('abcDEF_123');
    expect(youtubeId('https://www.youtube.com/live/8OGpa3lDbto?si=x')).toBe('8OGpa3lDbto');
    expect(youtubeId('https://www.youtube.com/embed/8OGpa3lDbto')).toBe('8OGpa3lDbto');
    for (const bad of ['http://www.youtube.com/watch?v=8OGpa3lDbto', 'https://example.com/watch?v=8OGpa3lDbto', 'https://www.youtube.com/playlist?list=x', 'https://youtu.be/a b', 'not a url']) {
      expect(youtubeId(bad)).toBeNull();
    }
  });
});

describe('ogw game reference', () => {
  it('downloads the video with yt-dlp into records/setup/reference/', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
    const bin = join(ws.root, 'bin');
    mkdirSync(bin);
    const args = join(ws.root, 'yt-dlp-args');
    // a fake yt-dlp: writes its arguments and the file -o names with ext mp4
    writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${args}"\nout=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\nprintf video > "$(printf '%s' "$out" | sed 's/%(ext)s/mp4/')"\n`);
    chmodSync(join(bin, 'yt-dlp'), 0o755);
    const env = { ...ws.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const out = await ogw(ws, ['game', 'reference', 'mygame', 'https://youtu.be/8OGpa3lDbto'], { env });
    expect(out).toEqual({ code: 0, stdout: 'records/setup/reference/8OGpa3lDbto.mp4\n', stderr: '' });
    expect(readFileSync(join(root, 'records/setup/reference/8OGpa3lDbto.mp4'), 'utf8')).toBe('video');
    const passed = readFileSync(args, 'utf8').trim().split('\n');
    expect(passed.at(-1)).toBe('https://www.youtube.com/watch?v=8OGpa3lDbto');
    // H.264 first, capped at 1080 on the shorter side
    expect(passed[passed.indexOf('-S') + 1]).toBe('res:1080');
    expect(passed[passed.indexOf('-f') + 1]).toBe('bv*[vcodec^=avc1]+ba[ext=m4a]/b[vcodec^=avc1]/bv*+ba/b');
  });

  it('removes the partial files of a failed download', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
    const bin = join(ws.root, 'bin');
    mkdirSync(bin);
    const dir = join(root, 'records/setup/reference');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'other.mp4'), 'kept');
    writeFileSync(join(bin, 'yt-dlp'), `#!/bin/sh\nprintf part > "${dir}/8OGpa3lDbto.f137.mp4.part"\nexit 1\n`);
    chmodSync(join(bin, 'yt-dlp'), 0o755);
    const env = { ...ws.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    expect((await ogw(ws, ['game', 'reference', 'mygame', 'https://youtu.be/8OGpa3lDbto'], { env })).code).toBe(1);
    expect(readdirSync(dir)).toEqual(['other.mp4']);
  });

  it('refuses another URL and a host without yt-dlp', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
    expect((await ogw(ws, ['game', 'reference', 'mygame', 'https://example.com/v.mp4'])).stderr).toBe('not a YouTube video URL: https://example.com/v.mp4\n');
    const run = await ogw(ws, ['game', 'reference', 'mygame', 'https://youtu.be/8OGpa3lDbto'], { env: { ...ws.env, PATH: '/usr/bin:/bin' } });
    expect(run).toMatchObject({ code: 1, stderr: expect.stringContaining('yt-dlp is not on this host') as unknown });
    expect(existsSync(join(root, 'records/setup/reference/8OGpa3lDbto.mp4'))).toBe(false);
  });
});
