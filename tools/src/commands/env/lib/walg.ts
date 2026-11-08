import { chmod } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { archiveKind, extractArchive, findFile } from './files.ts';
import { dataDir, safeSegment } from './host.ts';
import { installItem, readMarker } from './install.ts';

/** The `tools.walg` download platform of a Docker platform (`serverImage.platform`, the OS/arch of a Docker server). */
export function walgPlatform(dockerPlatform: string): 'linux-x64' | 'linux-arm64' | null {
  if (dockerPlatform === 'linux/amd64') return 'linux-x64';
  if (dockerPlatform === 'linux/arm64') return 'linux-arm64';
  return null;
}

/** The WAL-G program in a download: the file itself, or the `wal-g*` file of an archive. */
async function placeWalg(file: string, dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  let program: string | null = file;
  if (archiveKind(file) !== null) {
    const files = join(dir, 'files');
    await extractArchive(file, files, env);
    program = await findFile(files, (name) => name.startsWith('wal-g') && archiveKind(name) === null && !name.endsWith('.sha256'));
  }
  if (program !== null) await chmod(program, 0o755);
  return program;
}

/**
 * The WAL-G binary of harness settings `tools.walg` for a Docker platform (`build` `## deploy` DB backup rule), fetched
 * once into `.ogw/tools/walg/<version>/<platform>/` and checked against its SHA-256. It runs inside Linux containers,
 * never on this host, so it is not the download of this host's platform.
 */
export async function walgProgram(ctx: Context, dockerPlatform: string): Promise<string> {
  const pin = (await ctx.settings()).tools.walg;
  if (!pin) throw new OgwError('harness settings tools.walg is missing');
  const platform = walgPlatform(dockerPlatform);
  if (platform === null) throw new OgwError(`tools.walg has no platform for Docker platform ${dockerPlatform}`);
  const download = pin.downloads.find((d) => d.platform === platform);
  if (!download) throw new OgwError(`harness settings tools.walg has no ${platform} download`);
  const dir = join(await dataDir(ctx), 'tools', 'walg', safeSegment(pin.version), platform);
  const result = await installItem({
    dir,
    name: 'walg',
    version: pin.version,
    downloads: [download],
    mismatchReason: 'SHA-256 differs from the pin',
    notFoundReason: `program of walg not found in ${basename(download.url)}`,
    place: (files) => placeWalg((files[0] as { file: string }).file, dir, ctx.env),
  });
  if (!result.installed) throw new OgwError(`harness settings tools.walg ${platform}: ${result.reason ?? 'not installed'}`);
  const marker = await readMarker(dir);
  if (!marker) throw new OgwError(`harness settings tools.walg ${platform}: ${dir} has no installed.json`);
  return join(dir, marker.program);
}
