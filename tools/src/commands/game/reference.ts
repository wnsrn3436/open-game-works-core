import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { runOk, which } from '../../lib/proc.ts';

/** Folder of the reference game video in the game repo (`game-setup` 8). */
export const REFERENCE_DIR = 'records/setup/reference';

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

/** A download takes longer than a short command but has an end. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** The video id of a YouTube watch, shorts, live, embed or youtu.be URL; null for any other URL. */
export function youtubeId(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.includes(url.hostname)) return null;
  const id = url.hostname === 'youtu.be'
    ? url.pathname.slice(1)
    : url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
  return id !== null && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/** `ogw game reference <game> <YouTube URL>`: downloads the reference game video into `records/setup/reference/`. */
export const reference: CommandDef = {
  name: ['game', 'reference'],
  usage: 'ogw game reference <game> <YouTube URL>',
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => DOWNLOAD_TIMEOUT_MS,
  },
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const url = positional(args, 1, 'YouTube URL');
    const id = youtubeId(url);
    if (id === null) throw new OgwError(`not a YouTube video URL: ${url}`);
    const ytDlp = await which('yt-dlp', ctx.env);
    if (ytDlp === null) throw new OgwError('yt-dlp is not on this host: install it (macOS: brew install yt-dlp) and run again');
    const dir = join(game.root, REFERENCE_DIR);
    await mkdir(dir, { recursive: true });
    const name = `${id}.mp4`;
    const partial = async (): Promise<void> => {
      for (const file of await readdir(dir)) if (file.startsWith(`${id}.`) && file !== name) await rm(join(dir, file), { force: true });
    };
    try {
      await runOk(ytDlp, [
        '--no-playlist',
        '--no-progress',
        // H.264 plays on every Mac; YouTube's best mp4 is often AV1, which QuickTime opens only with AV1 hardware decode.
        // `res` is the shorter side, so a portrait video keeps its 1080x1920 stream
        '-S', 'res:1080',
        '-f', 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[vcodec^=avc1]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', join(dir, `${id}.%(ext)s`),
        `https://www.youtube.com/watch?v=${id}`,
      ], { env: ctx.env, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    } finally {
      // a failed or cut download leaves `<id>.*.part` and stream files in the reference folder
      await partial();
    }
    if (!(await readdir(dir)).includes(name)) throw new OgwError(`yt-dlp ended without ${REFERENCE_DIR}/${name}`);
    return { text: `${REFERENCE_DIR}/${name}`, data: { path: `${REFERENCE_DIR}/${name}`, file: name } };
  },
};
