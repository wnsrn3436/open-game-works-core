import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { privateTempPath } from '../../../lib/secret-files.ts';

/** Host platform names of harness settings `tools` downloads and `engine.json` `hosts`. */
export type HostPlatform = 'macos-arm64' | 'linux-x64' | 'windows-x64';

export function hostPlatformOf(platform: string, arch: string): HostPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  return null;
}

/** This host, or null when it is none of the harness platforms. Tests set `OGW_HOST_PLATFORM`. */
export function hostPlatform(env: NodeJS.ProcessEnv): HostPlatform | null {
  const override = env.OGW_HOST_PLATFORM;
  if (override === 'macos-arm64' || override === 'linux-x64' || override === 'windows-x64') return override;
  return hostPlatformOf(process.platform, process.arch);
}


/** Result files `ogw env propose` reads: `ogw-env/<name>.json` in the temp folder of ogw (`privateTempDir`). */
export type EnvResultName = 'env-check' | 'generation-install' | 'generation-measure' | 'instance-measure';

export async function envResultPath(env: NodeJS.ProcessEnv, name: EnvResultName): Promise<string> {
  return privateTempPath('ogw-env', `${name}.json`, env);
}

/**
 * Folder where ogw installs engines, build tools, harness settings `tools` programs and generation
 * methods: `.ogw/` in the workspace root.
 */
export async function dataDir(ctx: Context): Promise<string> {
  return join((await ctx.workspace()).root, '.ogw');
}

/** A path segment made from a free text such as a version. */
export function safeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

/** Finds a program on the PATH of `env`. */
export async function whichIn(env: NodeJS.ProcessEnv, program: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '');
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${program}${ext}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}
