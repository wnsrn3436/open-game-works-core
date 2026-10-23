import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { GenerationMethod, HarnessSettings, MeasuredStep } from '../../../lib/settings.ts';
import { findRow, readList, requireKey } from '../../resource/lib/list.ts';
import { parseSpec, type Spec } from '../../resource/lib/spec.ts';
import { methodMarker } from './install.ts';

export interface Stage {
  resolution?: number;
  durationMs?: number;
  jobMs?: number;
  fallback: boolean;
}

function isOk(step: MeasuredStep): boolean {
  return step.result === 'ok';
}

export function usable(method: GenerationMethod | undefined): boolean {
  return method?.measured?.some(isOk) === true;
}

function stageOf(step: MeasuredStep, fallback: boolean): Stage {
  return {
    ...(step.resolution === undefined ? {} : { resolution: step.resolution }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    ...(step.jobMs === undefined ? {} : { jobMs: step.jobMs }),
    fallback,
  };
}

/** `production.md` `## method`: the stage to use, or null for a method measured without stages. */
export function chooseStage(measured: readonly MeasuredStep[] | undefined, spec: Pick<Spec, 'size' | 'lengthMs'>): Stage | null {
  const steps = measured ?? [];
  if (!steps.some((s) => s.resolution !== undefined || s.durationMs !== undefined)) return null;
  const ok = steps.filter(isOk);
  const needResolution = spec.size === null ? undefined : Math.max(...spec.size);
  const needDuration = spec.lengthMs ?? undefined;
  const fits = (s: MeasuredStep): boolean =>
    (needResolution === undefined || s.resolution === undefined || s.resolution >= needResolution) &&
    (needDuration === undefined || s.durationMs === undefined || s.durationMs >= needDuration);
  const chosen = ok.find(fits);
  if (chosen) return stageOf(chosen, false);
  const last = ok.at(-1);
  return last ? stageOf(last, true) : null;
}

export interface MethodChoice {
  name: string;
  kind: GenerationMethod['kind'];
  stage: Stage | null;
  skill?: string | null;
  cli?: string | null;
  flux2Klein?: Stage | null;
}

export const IMAGE_METHOD = 'flux2-klein';
const NEEDS_IMAGE_METHOD = new Set(['rig-2d', 'trellis2']);

/** The parsed `spec` of a resource key of `resource/resources.csv`; fails when the row is missing or its spec breaks the rules. */
export async function keySpec(game: GameRepo, key: string): Promise<{ type: string; spec: Spec }> {
  const row = findRow(await readList(game.root), key);
  if (!row) throw new OgwError(`resource key ${key} is not in resource/resources.csv`);
  const { type } = requireKey(key);
  return { type, spec: parseSpec(key, type, row.spec) };
}

/** Methods a resource key can use and the stage of each (`production.md` `## method`). */
export async function chooseMethods(ctx: Context, settings: HarnessSettings, game: GameRepo, key: string): Promise<MethodChoice[]> {
  const { type, spec } = await keySpec(game, key);
  return methodChoices(ctx, settings, type, spec);
}

/** `chooseMethods` for a resource type and the parsed `spec` of its key (`keySpec`). */
export async function methodChoices(ctx: Context, settings: HarnessSettings, type: string, spec: Spec): Promise<MethodChoice[]> {
  const image = settings.resourceGeneration.find((m) => m.name === IMAGE_METHOD);
  const choices: MethodChoice[] = [];
  for (const method of settings.resourceGeneration) {
    const needsImage = NEEDS_IMAGE_METHOD.has(method.name);
    if (!method.resourceTypes.includes(type) || !usable(method) || (needsImage && !usable(image))) continue;
    choices.push(await choiceOf(ctx, method, spec, needsImage ? image : undefined));
  }
  return choices;
}

async function choiceOf(ctx: Context, method: GenerationMethod, spec: Spec, image: GenerationMethod | undefined): Promise<MethodChoice> {
  const choice: MethodChoice = { name: method.name, kind: method.kind, stage: chooseStage(method.measured, spec) };
  if (method.kind === 'external-service' && method.pins !== undefined) {
    const marker = await methodMarker(ctx, method);
    choice.skill = marker?.skill ?? null;
    choice.cli = marker?.cli ?? null;
  }
  if (image) choice.flux2Klein = chooseStage(image.measured, spec);
  return choice;
}

export function stageText(stage: Stage | null): string {
  if (stage === null) return 'no stage';
  const parts = [
    ...(stage.resolution === undefined ? [] : [`resolution ${String(stage.resolution)}px`]),
    ...(stage.durationMs === undefined ? [] : [`duration ${String(stage.durationMs)}ms`]),
    ...(stage.fallback ? ['fallback'] : []),
  ];
  return parts.join(' ');
}
