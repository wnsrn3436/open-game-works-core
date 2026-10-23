import type { ErrorObject } from 'ajv/dist/2020.js';
import { validateStructured } from '../../../lib/settings.ts';
import { display } from './json-path.ts';

/** One reason settings do not pass. `missing` is set when the reason is that the value at that path is missing. */
export interface Issue {
  message: string;
  missing?: string;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Path of a JSON pointer, with `prefix` in front; `(root)` for the empty path. */
export function pointerPath(pointer: string, prefix: readonly string[] = []): string {
  const segments = [...prefix, ...pointerSegments(pointer)];
  return segments.length === 0 ? '(root)' : display(segments);
}

function detail(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'additionalProperties') return ` (${String(params.additionalProperty)})`;
  if (error.keyword === 'enum' && Array.isArray(params.allowedValues)) {
    return ` (${params.allowedValues.map((v) => JSON.stringify(v)).join(', ')})`;
  }
  return '';
}

function toIssue(error: ErrorObject, prefix: readonly string[]): Issue {
  if (error.keyword === 'required') {
    const property = String((error.params as { missingProperty?: unknown }).missingProperty);
    const path = display([...prefix, ...pointerSegments(error.instancePath), property]);
    return { message: `${path}: missing`, missing: path };
  }
  return { message: `${pointerPath(error.instancePath, prefix)}: ${error.message ?? error.keyword}${detail(error)}` };
}

/**
 * Validates `value` against `schema`. `if` errors are left out because the errors of the failed
 * `then` are reported themselves. Paths get `prefix` in front.
 */
export function schemaIssues(schema: object, value: unknown, prefix: readonly string[] = []): Issue[] {
  const issues = validateStructured(schema, value)
    .filter((e) => e.keyword !== 'if')
    .map((e) => toIssue(e, prefix));
  const seen = new Set<string>();
  return issues.filter((issue) => !seen.has(issue.message) && seen.add(issue.message));
}
