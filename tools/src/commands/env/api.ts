import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { run } from '../../lib/proc.ts';
import type { ToolDownload } from '../../lib/settings.ts';
import {
  buildToolDir,
  downloadableBuildTools,
  engineAdapter,
  engineSources,
  hostDownloads,
  installBuildTool,
  installEngine,
  installedEngine,
} from './lib/engines.ts';
import { hostPlatform } from './lib/host.ts';
import { readMarker, type InstallResult } from './lib/install.ts';
import { dockerBuildx, firstLine, ghStatus } from './lib/probe.ts';
import { downloadFor, installedToolProgram, postgresPresent } from './lib/tools.ts';

export { buildToolDir, dockerBuildx, ghStatus, hostPlatform, postgresPresent };

/** Absolute path of the engine executable of that version on this host, or null when it is not installed. */
export function enginePath(ctx: Context, engine: string, version: string): Promise<string | null> {
  return installedEngine(ctx, engine, version);
}

/**
 * Fails (exit code not 0) naming the engine and version and telling to run `ogw env install-engines`
 * when the engine version is not on this host; otherwise returns its executable path. Also fails when the
 * executable reports another version.
 */
export async function requireEngine(ctx: Context, engine: string, version: string): Promise<string> {
  const path = await enginePath(ctx, engine, version);
  if (path === null) {
    throw new OgwError(`engine ${engine} ${version} is not on this host. Run ogw env install-engines`);
  }
  const result = await run(path, engineAdapter(engine).versionArgs, { env: ctx.env, timeoutMs: LIMITS.shortMs });
  const reported = result.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (result.code !== 0 || !reported.startsWith(version)) {
    throw new OgwError(`engine ${engine} at ${path} reports version "${reported}", not ${version}. Run ogw env install-engines`);
  }
  return path;
}

export interface InstallLine {
  /** `engine.json`: a source whose `engine.json` could not be read; its name and version are empty. */
  kind: 'engine' | 'build tool' | 'engine.json';
  name: string;
  version: string;
  from: string;
  result: InstallResult;
}

/** `<kind> <name> <version>` of an install line, without the empty parts. */
export function installLineLabel(line: InstallLine): string {
  return [line.kind, line.name, line.version].filter((part) => part !== '').join(' ');
}

/** SHA-256 list of the downloads of this host, which tells two `engine.json` entries of one version apart. */
function downloadKey(downloads: readonly ToolDownload[]): string {
  return downloads.map((d) => d.sha256).join(',');
}

interface InstallRun {
  lines: InstallLine[];
  /**
   * Lines of each source by `from`: its own lines, and for an item an earlier source named with the same downloads,
   * that source's line.
   */
  bySource: Map<string, InstallLine[]>;
}

async function installAll(ctx: Context): Promise<InstallRun> {
  const { sources, failures } = await engineSources(ctx);
  const lines: InstallLine[] = [];
  const bySource = new Map<string, InstallLine[]>();
  const add = (line: InstallLine, from = line.from): void => {
    if (from === line.from) lines.push(line);
    bySource.set(from, [...(bySource.get(from) ?? []), line]);
  };
  for (const f of failures) add({ kind: 'engine.json', name: '', version: '', from: f.from, result: { installed: false, mismatches: [], reason: f.reason } });
  const seen = new Map<string, { line: InstallLine; downloads: string }>();
  const platform = hostPlatform(ctx.env);
  const item = async (line: Omit<InstallLine, 'result'>, downloads: readonly ToolDownload[], install: () => Promise<InstallResult>): Promise<void> => {
    const key = `${line.kind} ${line.name} ${line.version}`;
    const first = seen.get(key);
    if (first === undefined) {
      const done: InstallLine = { ...line, result: await install() };
      seen.set(key, { line: done, downloads: downloadKey(downloads) });
      add(done);
    } else if ((bySource.get(line.from) ?? []).some((l) => `${l.kind} ${l.name} ${l.version}` === key)) {
      // a source that names an item again gets no second line
    } else if (first.downloads !== downloadKey(downloads)) {
      const reason = `engine.json of ${line.from} and of ${first.line.from} name ${line.version} with different downloads`;
      add({ ...line, result: { installed: false, mismatches: [], reason } });
    } else {
      add(first.line, line.from);
    }
  };
  for (const source of sources) {
    const engine = { kind: 'engine' as const, name: source.engine, version: source.version, from: source.from };
    const downloads = hostDownloads(source.json.downloads, platform);
    await item(engine, downloads, () => installEngine(ctx, source, downloads));
    for (const tool of downloadableBuildTools(source.json, platform)) {
      const download = downloadFor(tool.downloads ?? [], platform);
      const line = { kind: 'build tool' as const, name: tool.name, version: tool.version, from: source.from };
      await item(line, download === null ? [] : [download], () => installBuildTool(ctx, tool, download));
    }
  }
  return { lines, bySource };
}

/**
 * Installs every engine and downloadable build tool; returns one line per item. An item of a version an
 * earlier `engine.json` entry already named, in the same or an earlier source, is installed and reported once; when its
 * downloads differ from that entry's, it fails.
 */
export async function installEnginesReport(ctx: Context): Promise<InstallLine[]> {
  return (await installAll(ctx)).lines;
}

/**
 * `ogw env install-engines` for `ogw core upgrade <game>`: fails only on the lines of that game's `engine.json`
 * (`from` `game <game>`), counting an item an earlier source installed with the same downloads.
 */
export async function installEngines(ctx: Context, game: string): Promise<void> {
  const failed = ((await installAll(ctx)).bySource.get(`game ${game}`) ?? []).filter((line) => !line.result.installed);
  if (failed.length > 0) {
    throw new OgwError(failed.map((l) => `${installLineLabel(l)}: ${l.result.reason ?? 'failed'}`).join('\n'));
  }
}

/** Absolute path of a harness settings `tools` program on this host, or null. */
export async function toolProgram(ctx: Context, tool: 'blender' | 'chromium' | 'gdtoolkit' | 'ffmpeg' | 'placeholderFont'): Promise<string | null> {
  return installedToolProgram(ctx, tool, (await ctx.settings()).tools[tool]);
}

/** Absolute path of an installed build tool program (`engine.json` `buildTools` with `downloads`), or null. */
export async function buildToolProgram(ctx: Context, name: string, version: string): Promise<string | null> {
  const dir = await buildToolDir(ctx, name, version);
  const marker = await readMarker(dir);
  if (!marker) return null;
  return join(dir, marker.program);
}

/** An `engine.json` `buildTools` item, as far as its version probe needs it. */
export interface BuildToolSpec {
  name: string;
  version: string;
  versionCommand: string;
  downloads?: readonly ToolDownload[];
}

export interface BuildToolProbe {
  /** The item has `downloads`: `ogw env install-engines` installs it outside PATH. */
  downloadable: boolean;
  /** The version command ended with code 0 and its first output line starts with the version. */
  ok: boolean;
  /** First line of stdout, or of stderr when stdout is empty; null when the program did not run. */
  output: string | null;
}

/**
 * Runs a build tool's `versionCommand`. A tool with `downloads` runs the program `buildToolProgram` installed, with
 * the command's arguments; a tool without runs the command's program from PATH.
 */
export async function probeBuildTool(ctx: Context, tool: BuildToolSpec): Promise<BuildToolProbe> {
  const downloadable = (tool.downloads ?? []).length > 0;
  const program = downloadable ? await buildToolProgram(ctx, tool.name, tool.version) : null;
  if (downloadable && program === null) return { downloadable, ok: false, output: null };
  const [cmd, ...args] = tool.versionCommand.trim().split(/\s+/);
  const result = await run(program ?? (cmd as string), args, { env: ctx.env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  if (!result) return { downloadable, ok: false, output: null };
  const output = firstLine(result.stdout) || firstLine(result.stderr);
  return { downloadable, ok: result.code === 0 && output.startsWith(tool.version), output };
}
