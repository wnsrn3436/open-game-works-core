/**
 * The worker thread of `offThread`: it runs one job of the TypeScript compiler or of type-aware ESLint, whose work is
 * synchronous, and posts its findings, so that the JS thread of `ogw check` keeps serving its instances meanwhile.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { TsJob } from './off-thread.ts';

const job = workerData as TsJob;
try {
  const findings = job.kind === 'tsc'
    ? (await import('../type-check.ts')).typescriptErrors(job.root, job.files)
    : await (await import('../lint.ts')).typescriptLintFindings(job.root, job.files, job.maxComplexity, job.dir);
  parentPort?.postMessage({ ok: true, findings });
} catch (error) {
  parentPort?.postMessage({ ok: false, message: (error as Error).message, stack: (error as Error).stack ?? '' });
}
