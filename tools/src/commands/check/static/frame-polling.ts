import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientTest } from './lib/files.ts';
import type { Expr, GdFile, Stmt } from './lib/gd-ast.ts';
import { childBodies, exprChildren, stmtExprs, visitClass } from './lib/gd-walk.ts';

/**
 * frame polling: a client test waits with a polling loop limited by a frame count: a `for` or `while` loop
 * whose body awaits a frame (`wait_frames()`, `process_frame`, `physics_frame`).
 */
export const NAME = 'frame polling';

/** True for a frame wait: a `wait_frames()` call or a `process_frame`/`physics_frame` signal. */
function isFrameWait(e: Expr): boolean {
  if (e.k === 'call') return (e.callee.k === 'member' || e.callee.k === 'name') && e.callee.name === 'wait_frames';
  return e.k === 'member' && (e.name === 'process_frame' || e.name === 'physics_frame');
}

/** True when the expression awaits a frame (lambdas, which run later, are not entered). */
function awaitsFrame(e: Expr): boolean {
  if (e.k === 'lambda') return false;
  if (e.k === 'await' && hasFrameWait(e.expr)) return true;
  return exprChildren(e).some(awaitsFrame);
}

function hasFrameWait(e: Expr): boolean {
  return isFrameWait(e) || exprChildren(e).some(hasFrameWait);
}

function bodyAwaitsFrame(stmts: readonly Stmt[]): boolean {
  for (const s of stmts) {
    if (stmtExprs(s).some(awaitsFrame)) return true;
    if (childBodies(s).some(bodyAwaitsFrame)) return true;
  }
  return false;
}

export function checkFile(file: GdFile): Finding[] {
  const out: Finding[] = [];
  visitClass(file.top, {
    stmt(s) {
      if ((s.k === 'for' || s.k === 'while') && bodyAwaitsFrame(s.body)) {
        out.push(finding(NAME, at(file.path, s.line), `\`${s.k}\` loop waits for frames`));
      }
    },
  });
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  return (await Promise.all(sc.filter((p) => isClientContentGd(p) && isClientTest(p)).map(async (p) => checkFile(await sc.gd(p))))).flat();
}
