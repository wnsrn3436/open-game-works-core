import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { GenerationMethod, HarnessSettings, MeasuredStep } from '../../../lib/settings.ts';
import { findRow, parseKey, readList, requireKey, type ResourceRow } from '../../resource/lib/list.ts';
import { parseSpec, type Spec } from '../../resource/lib/spec.ts';
import { hasPins, methodMarker } from './install.ts';

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
  /** The temporary method of the key (`production.md` `## method`): its resource becomes `temporary`. */
  temporary?: true;
  /** The method lacks the install that `generation install` gives it on this host (`installedOnHost`). */
  notInstalled?: true;
}

export const IMAGE_METHOD = 'flux2-klein';
const NEEDS_IMAGE_METHOD = new Set(['rig-2d', 'trellis2']);
/** Image types: the image method of a game makes them (`production.md` `## method`). */
export const IMAGE_TYPES: readonly string[] = ['image', 'sprite_sheet', 'icon', 'background', 'nine_slice', 'texture', 'skybox', 'app_icon', 'splash'];

/**
 * The image method of a game: the method of the first `final` row of an image type made by a method of the image types,
 * else harness settings `imageMethod`. The attached row `sprite_sheet/<name>` of a `sprite_animation/<name>` in the list
 * (the sheet `ogw resource finalize` writes for that sprite animation) does not count.
 */
export function gameImageMethod(settings: HarnessSettings, rows: readonly ResourceRow[]): string {
  const imageMethods = new Set(settings.resourceGeneration.filter((m) => m.resourceTypes.includes('image')).map((m) => m.name));
  const keys = rows.map((r) => parseKey(r.key));
  const animations = new Set(keys.flatMap((k) => (k?.type === 'sprite_animation' ? [k.name] : [])));
  const first = rows.find((r, i) => {
    const key = keys[i];
    if (key === null || key === undefined || !IMAGE_TYPES.includes(key.type)) return false;
    if (key.type === 'sprite_sheet' && animations.has(key.name)) return false;
    return r.status === 'final' && imageMethods.has(r.method);
  });
  return first?.method ?? settings.imageMethod;
}

/**
 * The parsed `spec` of a resource key of `resource/resources.csv` and the rows of the list; fails when the row is
 * missing or its spec breaks the rules.
 */
export async function keySpec(game: GameRepo, key: string): Promise<{ type: string; spec: Spec; rows: ResourceRow[] }> {
  const rows = await readList(game.root);
  const row = findRow(rows, key);
  if (!row) throw new OgwError(`resource key ${key} is not in resource/resources.csv`);
  const { type } = requireKey(key);
  return { type, spec: parseSpec(key, type, row.spec), rows };
}

/** Methods a resource key can use and the stage of each (`production.md` `## method`). */
export async function chooseMethods(ctx: Context, settings: HarnessSettings, game: GameRepo, key: string): Promise<MethodChoice[]> {
  const { type, spec, rows } = await keySpec(game, key);
  return methodChoices(ctx, settings, type, spec, gameImageMethod(settings, rows));
}

/**
 * `chooseMethods` for a resource type, the parsed `spec` of its key (`keySpec`) and the image method of the game: an
 * image type takes only that method, and a usable `flux2-klein` is added as the temporary method of an image type it
 * lists that another method makes, and of `sprite_animation` (the type condition excepted).
 */
export async function methodChoices(ctx: Context, settings: HarnessSettings, type: string, spec: Spec, imageMethod: string): Promise<MethodChoice[]> {
  const image = settings.resourceGeneration.find((m) => m.name === IMAGE_METHOD);
  const imageType = IMAGE_TYPES.includes(type);
  const choices: MethodChoice[] = [];
  for (const method of settings.resourceGeneration) {
    const needsImage = NEEDS_IMAGE_METHOD.has(method.name);
    if (!method.resourceTypes.includes(type) || !usable(method) || (needsImage && !usable(image))) continue;
    if (imageType && method.name !== imageMethod) continue;
    choices.push(await choiceOf(ctx, method, spec, needsImage ? image : undefined));
  }
  if (image && takesTemporary(type, imageMethod, image)) choices.push({ ...(await choiceOf(ctx, image, spec, undefined)), temporary: true });
  return choices;
}

/** Whether `flux2-klein` is the temporary method of the type: usable, and an image type it lists that another method makes, or `sprite_animation`. */
export function takesTemporary(type: string, imageMethod: string, image: GenerationMethod): boolean {
  if (!usable(image)) return false;
  if (type === 'sprite_animation') return true;
  return IMAGE_TYPES.includes(type) && imageMethod !== IMAGE_METHOD && image.resourceTypes.includes(type);
}

/** Whether a method has what `generation install` gives it on this host: the install marker of a method with pins. */
export async function installedOnHost(ctx: Context, method: GenerationMethod): Promise<boolean> {
  return !hasPins(method) || method.pins === undefined || (await methodMarker(ctx, method)) !== null;
}

/**
 * The methods that block a resource key on this host: when none of its methods other than the temporary method is
 * installed (`installedOnHost`, and for `rig-2d` and `trellis2` `flux2-klein` too, which they call), the methods of
 * those that are not installed, as the key is then made with none of them (`production.md` `## method`). Empty for a
 * key with an installed method or with no method other than the temporary method.
 */
export async function uninstalledMethods(ctx: Context, settings: HarnessSettings, game: GameRepo, key: string): Promise<string[]> {
  const names = (await chooseMethods(ctx, settings, game, key)).filter((c) => c.temporary !== true).map((c) => c.name);
  const image = settings.resourceGeneration.find((m) => m.name === IMAGE_METHOD);
  const missing: string[] = [];
  for (const method of settings.resourceGeneration.filter((m) => names.includes(m.name))) {
    const needs = NEEDS_IMAGE_METHOD.has(method.name) && image !== undefined ? [method, image] : [method];
    const lacking: string[] = [];
    for (const m of needs) if (!(await installedOnHost(ctx, m))) lacking.push(m.name);
    if (lacking.length === 0) return [];
    for (const name of lacking) if (!missing.includes(name)) missing.push(name);
  }
  return missing;
}

async function choiceOf(ctx: Context, method: GenerationMethod, spec: Spec, image: GenerationMethod | undefined): Promise<MethodChoice> {
  const choice: MethodChoice = { name: method.name, kind: method.kind, stage: chooseStage(method.measured, spec) };
  if (method.kind === 'external-service' && method.pins !== undefined) {
    const marker = await methodMarker(ctx, method);
    choice.skill = marker?.skill ?? null;
    choice.cli = marker?.cli ?? null;
  }
  if (image) choice.flux2Klein = chooseStage(image.measured, spec);
  if (!(await installedOnHost(ctx, method)) || (image !== undefined && !(await installedOnHost(ctx, image)))) choice.notInstalled = true;
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
