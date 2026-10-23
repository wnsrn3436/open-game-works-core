import type { ModuleResult } from './test-records.ts';

/**
 * Runs module tests (`ogw core test`), at most `concurrency` at once, in the given order. A module does not wait for
 * its dependencies: its result is that of its own run, so a run of many modules keeps the host's CPUs busy instead of
 * running the dependency chain one module after another.
 */
export async function runModulePool(
  modules: readonly string[],
  concurrency: number,
  run: (module: string) => Promise<ModuleResult>,
  onResult: (module: string, result: ModuleResult) => Promise<void>,
): Promise<Map<string, ModuleResult>> {
  const unique = [...new Set(modules)];
  const results = new Map<string, ModuleResult>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const module = unique[next] as string;
      next += 1;
      const result = await run(module).catch((): ModuleResult => 'fail');
      results.set(module, result);
      await onResult(module, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, worker));
  return new Map(unique.map((module) => [module, results.get(module) ?? 'fail']));
}
