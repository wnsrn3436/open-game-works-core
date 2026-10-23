/**
 * Server core code static check (`server-time`): core code reads the system clock only in the clock adapter, and
 * uses timers only in `server-time`'s scheduler (`schedule_job`, `sleep`) and `network_time_limit`. The files are
 * those of `server-core` `## folder` (`SERVER_CLOCK_LAYOUT`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clockRead } from '../../check/static/system-clock.ts';
import { lineOf, stringText, ts, tsChain, walkTs } from '../../check/static/lib/ts-source.ts';
import { filesUnder } from '../../../lib/fsx.ts';
import { SERVER_CLOCK_LAYOUT, type ServerClockLayout } from './server-layout.ts';

const TIMER_CALLS = new Set(['setTimeout', 'setInterval', 'globalThis.setTimeout', 'globalThis.setInterval', 'AbortSignal.timeout']);
const TIMER_MODULES = new Set(['timers', 'node:timers', 'timers/promises', 'node:timers/promises']);

function timerUse(node: ts.Node): string | null {
  if (ts.isCallExpression(node)) {
    const chain = tsChain(node.expression);
    return chain !== null && TIMER_CALLS.has(chain) ? `\`${chain}()\`` : null;
  }
  if (ts.isImportDeclaration(node)) {
    const spec = stringText(node.moduleSpecifier);
    return spec !== null && TIMER_MODULES.has(spec) ? `import of \`${spec}\`` : null;
  }
  return null;
}

/** Findings `server/core/<file>:<line>: <check>: <reason>` of one server core file. */
export function serverFileFindings(rel: string, text: string, layout: ServerClockLayout): string[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const clockAllowed = layout.isClockAdapter(rel);
  const timerAllowed = layout.isScheduler(rel);
  walkTs(source, (node) => {
    const clock = clockAllowed ? null : clockRead(node);
    if (clock) out.push(`${rel}:${String(lineOf(source, node))}: system clock: \`${clock}\` outside the clock adapter`);
    const timer = timerAllowed ? null : timerUse(node);
    if (timer) out.push(`${rel}:${String(lineOf(source, node))}: timer: ${timer} outside server-time schedule_job, sleep and network_time_limit`);
  });
  return out;
}

/** The check over `open-game-works-core-impl/server/core/` with a given module layout (core tests left out). */
export async function serverCoreFindings(implDir: string, layout: ServerClockLayout): Promise<string[]> {
  const files = (await filesUnder(implDir, 'server/core')).filter((f) => /\.(ts|mts|cts)$/.test(f) && !layout.isTest(f));
  const results = await Promise.all(files.map(async (f) => serverFileFindings(f, await readFile(join(implDir, f), 'utf8'), layout)));
  return results.flat();
}

/** Server core static check: system clock reads outside the clock adapter, timers outside `server-time`. */
export function serverCoreStaticCheck(implDir: string): Promise<string[]> {
  return serverCoreFindings(implDir, SERVER_CLOCK_LAYOUT);
}
