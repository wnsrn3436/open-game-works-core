import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from './errors.ts';
import { writeFileAtomic } from './fsx.ts';

/**
 * The Web preset options of every Godot Web export (`client-core` Godot `## folder`, `build` Godot export table): a
 * threaded PWA build whose service worker gives the page cross-origin isolation, with client core's web shell.
 */
export const WEB_EXPORT_OPTIONS: Readonly<Record<string, boolean | string>> = {
  'variant/thread_support': true,
  'progressive_web_app/enabled': true,
  'progressive_web_app/ensure_cross_origin_isolation_headers': true,
  'html/custom_html_shell': 'res://core/web/ogw-shell.html',
};

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
