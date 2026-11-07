import { Worker } from 'node:worker_threads';
import { OgwError } from '../../../../lib/errors.ts';
import type { Finding } from './context.ts';

/** A job of the TypeScript compiler (`typescriptErrors`) or of type-aware ESLint (`typescriptLintFindings`) on server files. */
export type TsJob =
  | { kind: 'tsc'; root: string; files: string[] }
  | { kind: 'eslint'; root: string; files: string[]; maxComplexity: number; dir: string };

type Answer = { ok: true; findings: Finding[] } | { ok: false; message: string; stack: string };

/**
 * The findings of `job`, worked out in a worker thread (`ts-worker.ts`): that work is synchronous and takes seconds on
 * the server code of a game, which on the JS thread would stop the other checks and the instance work of `ogw check`.
 * An error the job threw is thrown with its message.
 */
export function offThread(job: TsJob): Promise<Finding[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ts-worker.ts', import.meta.url), { workerData: job });
    let answered = false;
    worker.once('message', (answer: Answer) => {
      answered = true;
      if (answer.ok) resolve(answer.findings);
      else reject(Object.assign(new Error(answer.message), { stack: answer.stack }));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!answered) reject(new OgwError(`the ${job.kind} worker ended with exit code ${String(code)} and no answer`));
    });
  });
}
