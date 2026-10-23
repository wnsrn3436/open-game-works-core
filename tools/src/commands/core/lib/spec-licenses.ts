// SPDX license IDs and texts for `ogw core licenses` (`skills/core/command.md` `## license manifest`).
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OgwError } from '../../../lib/errors.ts';
import { byteCompare } from '../../../lib/order.ts';
import { codeSpans, mdLines, section } from './spec-md.ts';

/**
 * Full texts by SPDX license ID and SPDX exception ID: licenses from the SPDX license list data pinned by
 * `package-lock.json`, exceptions from the vendored `spdx/license-list-data` `json/exceptions`.
 */
export type LicenseTexts = ReadonlyMap<string, string>;

/** Tag of `spdx/license-list-data` whose `json/exceptions` is vendored in `tools/vendor/`. */
export const SPDX_EXCEPTIONS_TAG = 'v3.27.0';

/** The vendored `json/exceptions` folder. */
export const SPDX_EXCEPTIONS_DIR = fileURLToPath(
  new URL(`../../../../vendor/spdx-license-list-data/${SPDX_EXCEPTIONS_TAG}/json/exceptions/`, import.meta.url),
);

let cached: LicenseTexts | null = null;

/** `licenseExceptionId` → `licenseExceptionText` of every file of an SPDX `json/exceptions` folder. */
export function spdxExceptionTexts(dir: string): Map<string, string> {
  const texts = new Map<string, string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { licenseExceptionId?: unknown; licenseExceptionText?: unknown };
    if (typeof entry.licenseExceptionId !== 'string' || typeof entry.licenseExceptionText !== 'string') {
      throw new OgwError(`${join(dir, name)}: no licenseExceptionId or licenseExceptionText`);
    }
    texts.set(entry.licenseExceptionId, entry.licenseExceptionText);
  }
  return texts;
}

/** The SPDX license list data of the `spdx-license-list` package and the vendored SPDX exceptions. */
export function spdxLicenseTexts(): LicenseTexts {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const full = require('spdx-license-list/full') as Record<string, { licenseText: string }>;
  const texts = new Map(Object.entries(full).map(([id, entry]) => [id, entry.licenseText]));
  for (const [id, text] of spdxExceptionTexts(SPDX_EXCEPTIONS_DIR)) texts.set(id, text);
  cached = texts;
  return cached;
}

/**
 * License IDs of an SPDX license expression, including the exception IDs after `WITH`.
 * A trailing `+` is not part of the ID.
 */
export function expressionIds(expression: string): string[] {
  const tokens = expression.replace(/[()]/g, ' ').split(/\s+/).filter((t) => t !== '');
  const ids: string[] = [];
  for (const token of tokens) {
    if (/^(AND|OR|WITH)$/i.test(token)) continue;
    ids.push(token.endsWith('+') ? token.slice(0, -1) : token);
  }
  return ids;
}

/**
 * Whether an ID of an SPDX expression is a license reference (`LicenseRef-`, `DocumentRef-`): not an SPDX license
 * ID, so it has no `texts` entry; its full text is in the component's `notice`.
 */
export function isLicenseRef(id: string): boolean {
  return /^(LicenseRef|DocumentRef)-/.test(id);
}

/** IDs of an SPDX expression that need a `licenses.json` `texts` entry: `expressionIds` without license references. */
export function textIds(expression: string): string[] {
  return expressionIds(expression).filter((id) => !isLicenseRef(id));
}

/**
 * Keys `licenses.json` `texts` must have, in byte order: `textIds` of every component `license` and the
 * `## resource rights` code spans that are in the SPDX license list.
 */
export async function requiredTextIds(licenses: readonly string[], harness: string): Promise<string[]> {
  const texts = spdxLicenseTexts();
  const ids = new Set(licenses.flatMap(textIds));
  for (const span of await resourceRightsSpans(harness)) if (texts.has(span)) ids.add(span);
  return [...ids].sort(byteCompare);
}

/** Code spans of `skills/resource/SKILL.md` `## resource rights`. */
export async function resourceRightsSpans(harness: string): Promise<string[]> {
  const rel = 'skills/resource/SKILL.md';
  let text: string;
  try {
    text = await readFile(join(harness, rel), 'utf8');
  } catch {
    throw new OgwError(`file not found: ${rel}`);
  }
  const lines = mdLines(text);
  const sec = section(lines, 2, 'resource rights');
  if (!sec) throw new OgwError(`${rel}: no "## resource rights" section`);
  return lines
    .slice(sec.start + 1, sec.end)
    .filter((line) => !line.fenced)
    .flatMap((line) => codeSpans(line.text).map((span) => span.text));
}
