/**
 * The lines under the heading line `<level #s> <heading>` (compared without surrounding spaces) up to the next heading
 * of the same or a higher level; a line inside a ``` code fence is never a heading. Null when the heading is missing.
 */
export function section(text: string, heading: string, level = 2): string[] | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${'#'.repeat(level)} ${heading}`);
  if (start === -1) return null;
  const out: string[] = [];
  let fence = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith('```')) fence = !fence;
    const hashes = fence ? undefined : /^(#+) /.exec(line)?.[1];
    if (hashes !== undefined && hashes.length <= level) break;
    out.push(line);
  }
  return out;
}
