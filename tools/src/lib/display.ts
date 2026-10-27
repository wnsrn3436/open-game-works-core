import { LIMITS } from './limits.ts';
import { runOk } from './proc.ts';

/** The refresh rate (Hz) of the main display in `system_profiler SPDisplaysDataType -json` output, or null. */
export function macosRefreshHz(json: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const gpus = (parsed as { SPDisplaysDataType?: { spdisplays_ndrvs?: Record<string, unknown>[] }[] } | null)?.SPDisplaysDataType ?? [];
  const displays = gpus.flatMap((gpu) => gpu.spdisplays_ndrvs ?? []);
  const main = displays.find((d) => d.spdisplays_main === 'spdisplays_yes') ?? displays[0];
  const resolution = main?._spdisplays_resolution;
  const match = typeof resolution === 'string' ? /@\s*([0-9.]+)\s*Hz/u.exec(resolution) : null;
  return match ? Number(match[1]) : null;
}

/** The refresh rate (Hz) of the current mode (`*`) of the primary output, else of the first output, in `xrandr --current` output, or null. */
export function xrandrRefreshHz(text: string): number | null {
  const blocks = text.split(/\n(?=\S)/u);
  const block = blocks.find((b) => / connected primary /u.test(b)) ?? blocks.find((b) => / connected /u.test(b));
  const match = block === undefined ? null : /([0-9.]+)\*/u.exec(block);
  return match ? Number(match[1]) : null;
}

/** The refresh rate (Hz) in the output of `Win32_VideoController.CurrentRefreshRate`, or null. */
export function windowsRefreshHz(text: string): number | null {
  const match = /^\s*([0-9]+)\s*$/mu.exec(text);
  return match ? Number(match[1]) : null;
}

async function readRefreshHz(env: NodeJS.ProcessEnv): Promise<number | null> {
  const options = { env, timeoutMs: LIMITS.shortMs };
  if (process.platform === 'darwin') return macosRefreshHz((await runOk('system_profiler', ['SPDisplaysDataType', '-json'], options)).stdout);
  if (process.platform === 'linux') return xrandrRefreshHz((await runOk('xrandr', ['--current'], options)).stdout);
  if (process.platform === 'win32') {
    const command = '(Get-CimInstance Win32_VideoController | Select-Object -First 1).CurrentRefreshRate';
    return windowsRefreshHz((await runOk('powershell', ['-NoProfile', '-Command', command], options)).stdout);
  }
  return null;
}

let cached: Promise<number | null> | null = null;

/**
 * The refresh rate of the main display of this host in whole Hz (rounded down, as `QualityCore` reads a device screen),
 * read once per process; null when it cannot be read.
 */
export function hostRefreshHz(env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  cached ??= readRefreshHz(env)
    .then((hz) => (hz !== null && Number.isFinite(hz) && hz >= 1 ? Math.floor(hz) : null))
    .catch(() => null);
  return cached;
}
