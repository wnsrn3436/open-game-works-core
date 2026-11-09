import { Worker } from 'node:worker_threads';

/**
 * What the worker thread of `file` posts first for `data`, or a rejection once `limitMs` has passed without it, the worker
 * then ended. The time limit of a vitest test fires only while the test waits, so a test of synchronous code that may not
 * end on some code (the code before a fix included) runs that code here.
 */
export function inWorker(file: URL, data: unknown, limitMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: data });
    const timer = setTimeout(() => {
      reject(new Error(`the worker ${file.pathname} did not answer within ${String(limitMs)} ms`));
      void worker.terminate();
    }, limitMs);
    worker.once('message', (answer: unknown) => {
      clearTimeout(timer);
      resolve(answer);
      void worker.terminate();
    });
    worker.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the worker ${file.pathname} ended with exit code ${String(code)} and no answer`));
    });
  });
}
