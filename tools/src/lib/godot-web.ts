import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from './errors.ts';
import { writeFileAtomic } from './fsx.ts';
import { newId } from './ids.ts';

/**
 * The Web preset options of every Godot Web export (`client-core` Godot `## folder`, ogw.md `#### platform`): a
 * threaded PWA build whose service worker gives the page cross-origin isolation, with client core's web shell.
 */
export const WEB_EXPORT_OPTIONS: Readonly<Record<string, boolean | string>> = {
  'variant/thread_support': true,
  'progressive_web_app/enabled': true,
  'progressive_web_app/ensure_cross_origin_isolation_headers': true,
  'html/custom_html_shell': 'res://core/web/ogw-shell.html',
};

/**
 * `html/head_include` of a DEV Web export: the marker by which client core's web shell reads the launch value file of the
 * page (`ogw_launch_values`, `client-core` Godot `## module`). STG and PROD exports do not have it.
 */
export const WEB_DEV_HEAD_INCLUDE = '<script>window.ogwDevExport = true;</script>';

/** The Web preset options of an export of environment `env` (`#### platform` of ogw.md `## godot build`). */
export function webExportOptions(env: 'DEV' | 'STG' | 'PROD'): Record<string, boolean | string> {
  return env === 'DEV' ? { ...WEB_EXPORT_OPTIONS, 'html/head_include': WEB_DEV_HEAD_INCLUDE } : { ...WEB_EXPORT_OPTIONS };
}

/** Client core's service worker in a Godot project (`res://core/web/service-worker.js`). */
export const WEB_SERVICE_WORKER = join('core', 'web', 'service-worker.js');

const PLACEHOLDER = /___[A-Z0-9_]+___/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Client core's service worker with the values the Godot exporter filled into the exported one: each line of `template`
 * that holds placeholders matches exactly one line of `exported`, which gives their values.
 */
export function filledServiceWorker(template: string, exported: string): string {
  const values = new Map<string, string>();
  const exportedLines = exported.split('\n');
  for (const line of template.split('\n')) {
    const names = line.match(PLACEHOLDER);
    if (names === null) continue;
    const pattern = new RegExp(`^${line.split(PLACEHOLDER).map(escapeRegExp).join('(.*)')}$`);
    const matches = exportedLines.map((l) => pattern.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    if (matches.length !== 1) throw new OgwError(`the exported service worker has ${String(matches.length)} lines for the line ${JSON.stringify(line.trim())} of core/web/service-worker.js, not 1`);
    names.forEach((name, i) => {
      const value = (matches[0] as RegExpExecArray)[i + 1] as string;
      const known = values.get(name);
      if (known !== undefined && known !== value) throw new OgwError(`the exported service worker gives ${name} two values`);
      values.set(name, value);
    });
  }
  return template.replace(PLACEHOLDER, (name) => values.get(name) ?? name);
}

/** Replaces the exported `index.service.worker.js` of `outDir` with client core's of `project`, values carried over. */
export async function installServiceWorker(project: string, outDir: string): Promise<void> {
  const exportedFile = join(outDir, 'index.service.worker.js');
  const template = await readFile(join(project, WEB_SERVICE_WORKER), 'utf8');
  await writeFileAtomic(exportedFile, filledServiceWorker(template, await readFile(exportedFile, 'utf8')));
}

/** The page URL query parameter that gives the URL path of the launch value file of the page (`client-core` Godot `## module`). */
const LAUNCH_VALUES_PARAM = 'ogw_launch_values';

/**
 * Why `value` is not the content of a launch value file, a JSON object keyed by launch value name whose values are JSON
 * strings (`client-core` Godot `## module`); null when it is one.
 */
export function launchValueFileError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a JSON object';
  for (const [name, text] of Object.entries(value)) if (typeof text !== 'string') return `the value of ${name} is not a string`;
  return null;
}

/**
 * Writes `values` as the launch value file of a page into `dir`, the folder served at the URL path `urlDir` (ending in
 * `/`) on the origin of the page, under a name with a new random part, readable by the owner only (launch values may
 * hold secrets, `OGW_DEV_ACCESS`). Returns the page URL query parameter that names it.
 */
export async function writePageLaunchValues(dir: string, urlDir: string, values: Readonly<Record<string, string>>): Promise<string> {
  const name = `ogw-launch-values-${newId()}.json`;
  await writeFile(join(dir, name), JSON.stringify(values), { mode: 0o600, flag: 'wx' });
  return new URLSearchParams({ [LAUNCH_VALUES_PARAM]: `${urlDir}${name}` }).toString();
}
