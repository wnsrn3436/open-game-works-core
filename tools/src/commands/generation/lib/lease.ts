import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withReader } from '../../../lib/rwlock.ts';
import { dataDir } from '../../env/lib/host.ts';

/**
 * The reader/writer lock of the performance lease (ogw.md `### performance lease`), beside the lock that keeps one
 * `generation run` at a time on this host: `generation run` reads it, the performance measurement of `ogw check` writes it.
 */
export async function performanceLeaseBase(ctx: Context): Promise<string> {
  return join(await dataDir(ctx), 'generation', 'performance-lease');
}

/**
 * Runs the calls of a `generation run` holding the performance lease shared. While a performance measurement holds or
 * waits for the lease, it waits, at most the time limit of its background job.
 */
export async function withGenerationLease<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  return withReader({ base: await performanceLeaseBase(ctx), waitMs: LIMITS.jobMs }, fn);
}
