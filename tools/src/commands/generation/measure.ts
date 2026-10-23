import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withLock } from '../../lib/lock.ts';
import { run } from '../../lib/proc.ts';
import type { GenerationMethod, HarnessSettings } from '../../lib/settings.ts';
import { envResultPath } from '../env/lib/host.ts';
import { readEnvResult, writeEnvResult, type GenerationMeasureResult, type MeasuredRun } from '../env/lib/results.ts';
import { methodDir, methodMarker, withMethodLock } from './lib/install.ts';
import { rigFixtureProblem } from './lib/rig-fixture.ts';
import { callError } from './lib/sandbox.ts';
import { IMAGE_METHOD } from './lib/select.ts';
import { runStandardStage, standardJob } from './lib/standard.ts';

type MethodResult = GenerationMeasureResult['methods'][string];
type Results = GenerationMeasureResult['methods'];

/** The method `rig-2d` (`resource` skill `production.md` `## rig`). */
export const RIG_METHOD = 'rig-2d';
/** The prompt of the `provider` external-service standard test call. */
export const PROVIDER_PROMPT = 'A small red apple game item, centered, front view.';

export const NOT_INSTALLED = 'not installed as pinned: run ogw generation install';

function step(result: MeasuredRun['result'], extra: Partial<MeasuredRun> = {}): MeasuredRun {
  return { result, maxMemoryBytes: null, output: null, blocked: [], ...extra };
}

async function measureStages(ctx: Context, method: GenerationMethod): Promise<MeasuredRun[]> {
  const steps: MeasuredRun[] = [];
  for (const stage of standardJob(method.name).stages) {
    const result = await runStandardStage(ctx, method, stage);
    steps.push(result);
    if (result.result !== 'ok') break;
  }
  return steps;
}

/**
 * `rig-2d`: `ok` when `flux2-klein` has an `ok` stage and the rig tools pass the fixed fixture, which is made in the
 * method folder under its lock.
 */
async function measureRig(ctx: Context, settings: HarnessSettings, done: Results): Promise<MeasuredRun> {
  const measured = done[IMAGE_METHOD];
  const imageSteps = measured && measured.error === null ? measured.steps : (settings.resourceGeneration.find((m) => m.name === IMAGE_METHOD)?.measured ?? []);
  if (!imageSteps.some((s) => s.result === 'ok')) return step('failed', { detail: `${IMAGE_METHOD} has no ok stage` });
  return withMethodLock(ctx, RIG_METHOD, () => measureRigFixture(ctx, settings));
}

async function measureRigFixture(ctx: Context, settings: HarnessSettings): Promise<MeasuredRun> {
  const work = join(await methodDir(ctx, RIG_METHOD), 'measure', 'single');
  const started = Date.now();
  const problem = await rigFixtureProblem(work, settings);
  const extra = { jobMs: Date.now() - started, output: work, ...(problem === null ? {} : { detail: problem }) };
  return step(problem === null ? 'ok' : 'failed', extra);
}

/**
 * A `provider` external-service: one `gen` call of the method's CLI with the provider, outside the sandbox,
 * under the lock of the method folder.
 */
function measureProvider(ctx: Context, method: GenerationMethod): Promise<MethodResult> {
  return withMethodLock(ctx, method.name, () => measureProviderLocked(ctx, method));
}

async function measureProviderLocked(ctx: Context, method: GenerationMethod): Promise<MethodResult> {
  const base = { kind: method.kind, steps: [] as MeasuredRun[] };
  const marker = await methodMarker(ctx, method);
  if (!marker?.cli) return { ...base, error: NOT_INSTALLED };
  const work = join(await methodDir(ctx, method.name), 'measure', 'single');
  await rm(work, { recursive: true, force: true });
  const out = join(work, 'out');
  await mkdir(out, { recursive: true });
  const prompt = join(work, 'prompt.txt');
  await writeFile(prompt, PROVIDER_PROMPT);
  const image = join(out, 'image.png');
  const started = Date.now();
  const args = ['gen', '--provider', method.provider as string, '--prompt-file', prompt, '--out', image, '--transparent'];
  const result = await run(marker.cli, args, { env: ctx.env, timeoutMs: method.safetyTimeoutMs });
  const jobMs = Date.now() - started;
  const outcome: MeasuredRun['result'] = result.timedOut ? 'timeout' : result.code === 0 && exists(image) ? 'ok' : 'failed';
  // `tools/ogw.md` `## generation call`: a failed or timed out call gives the last lines of its stderr
  const error = outcome === 'ok' ? null : callError(result.stderr);
  const detail = outcome !== 'failed' || error !== null ? null : result.code === 0 ? `${image} was not written` : `exited with code ${String(result.code)}`;
  const extra = { jobMs, output: out, costUsd: 0, ...(error === null ? {} : { error }), ...(detail === null ? {} : { detail }) };
  return { ...base, steps: [step(outcome, extra)], error: null };
}

async function measureExternal(ctx: Context, method: GenerationMethod, allow: ReadonlySet<string>): Promise<MethodResult> {
  const base = { kind: method.kind, steps: [] as MeasuredRun[] };
  if (!allow.has(method.name)) return { ...base, error: `not called: the human did not allow it (ogw generation measure --allow ${method.name})` };
  if (method.provider === undefined) return { ...base, error: 'an external-service method without provider has no standard test call' };
  return measureProvider(ctx, method);
}

/** `host-env` 4 for one method. `done` holds the results of the methods measured before it in this run and the kept results. */
export async function measureMethod(ctx: Context, method: GenerationMethod, allow: ReadonlySet<string> = new Set(), done: Results = {}): Promise<MethodResult> {
  const base = { kind: method.kind, steps: [] as MeasuredRun[] };
  if (method.kind === 'catalog') {
    if (!(await methodMarker(ctx, method))) return { ...base, error: NOT_INSTALLED };
    return { ...base, steps: [step('ok')], error: null };
  }
  if (method.kind === 'external-service') return measureExternal(ctx, method, allow);
  try {
    if (method.kind === 'procedural' && method.name === RIG_METHOD) return { ...base, steps: [await measureRig(ctx, await ctx.settings(), done)], error: null };
    if (method.kind === 'procedural' && method.name !== 'blender') return { ...base, steps: [step('ok')], error: null };
    if (method.kind === 'local-model' && !(await methodMarker(ctx, method))) {
      standardJob(method.name);
      return { ...base, error: NOT_INSTALLED };
    }
    return { ...base, steps: await measureStages(ctx, method), error: null };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

/** The `--allow` method names; each must be an external-service method of harness settings. */
export function allowedMethods(settings: HarnessSettings, text: string | undefined): Set<string> {
  const names = (text ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  const wrong = names.filter((n) => settings.resourceGeneration.find((m) => m.name === n)?.kind !== 'external-service');
  if (wrong.length > 0) throw new OgwError(`--allow takes external-service methods of harness settings resourceGeneration: ${wrong.join(', ')}`);
  return new Set(names);
}

/** Each line of a call's stderr indented under its step. */
function indented(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}

function stepText(s: MeasuredRun): string {
  const stage = [
    ...(s.resolution === undefined ? [] : [`${String(s.resolution)}px`]),
    ...(s.durationMs === undefined ? [] : [`${String(s.durationMs)}ms`]),
  ].join(' ');
  const memory = s.maxMemoryBytes === null ? '' : ` memory ${String(s.maxMemoryBytes)} bytes`;
  const time = s.jobMs === undefined ? '' : ` ${String(s.jobMs)}ms`;
  const cost = s.costUsd === undefined ? '' : ` cost ${String(s.costUsd)} USD`;
  const blocked = s.blocked.length === 0 ? '' : `\n    blocked: ${s.blocked.join(' | ')}`;
  const output = s.output === null ? '' : ` output ${s.output}`;
  const detail = s.detail === undefined ? '' : `\n    ${s.detail}`;
  const error = s.error === undefined ? '' : `\n    stderr:\n${indented(s.error)}`;
  return `  ${stage || 'single'}: ${s.result}${time}${cost}${memory}${output}${blocked}${detail}${error}`;
}

/** The method names of the command; each must be a method of harness settings. Empty: every method. */
function onlyMethods(settings: HarnessSettings, names: readonly string[]): Set<string> {
  const unknown = names.filter((n) => !settings.resourceGeneration.some((m) => m.name === n));
  if (unknown.length > 0) throw new OgwError(`no method ${unknown.join(', ')} in harness settings resourceGeneration`);
  return new Set(names);
}

export const measureCommand: CommandDef = {
  name: ['generation', 'measure'],
  usage: 'ogw generation measure [<method>...] [--allow <method,...>]',
  options: { allow: { type: 'string' } },
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    const settings = await ctx.settings();
    const only = onlyMethods(settings, args.positionals);
    const allow = allowedMethods(settings, str(args, 'allow'));
    const measuredAt = Date.now();
    // With method names, the kept results stand for the methods not measured now (rig-2d reads flux2-klein from them).
    const kept = only.size === 0 ? {} : ((await readEnvResult(ctx, 'generation-measure'))?.methods ?? {});
    // rig-2d reads the flux2-klein result of this run, so it is measured after every other method
    const chosen = settings.resourceGeneration.filter((m) => only.size === 0 || only.has(m.name));
    const order = [...chosen.filter((m) => m.name !== RIG_METHOD), ...chosen.filter((m) => m.name === RIG_METHOD)];
    const measured: Results = {};
    for (const method of order) measured[method.name] = await measureMethod(ctx, method, allow, { ...kept, ...measured });
    const methods: Results = Object.fromEntries(chosen.map((m) => [m.name, measured[m.name] as MethodResult]));
    // Another measure job may write the result file meanwhile: read, merge and write it under one lock.
    const { result, path } = await withLock(`${await envResultPath(ctx.env, 'generation-measure')}.lock`, async () => {
      const previous = only.size === 0 ? null : await readEnvResult(ctx, 'generation-measure');
      const merged: GenerationMeasureResult = { measuredAt, methods: { ...(previous?.methods ?? {}), ...methods } };
      return { result: merged, path: await writeEnvResult(ctx, 'generation-measure', merged) };
    });
    const lines = Object.entries(methods).flatMap(([name, m]) => [`${name}: ${m.error ?? `${String(m.steps.length)} step(s)`}`, ...m.steps.map(stepText)]);
    return { text: [...lines, `result: ${path}`].join('\n'), data: { ...result, resultFile: path } };
  },
};
