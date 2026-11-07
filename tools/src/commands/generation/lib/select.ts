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

/** ogw.md `## generation methods`: the stage to use, or null for a method measured without stages. */
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
  /** The temporary method of the key (ogw.md `## generation methods`): its resource becomes `temporary`. */
  temporary?: true;
  /** The method lacks the install that `generation install` gives it on this host (`installedOnHost`). */
  notInstalled?: true;
}

export const IMAGE_METHOD = 'flux2-klein';
/**
 * The methods whose making calls `flux2-klein`: the part images of `rig-2d`, the source illustration of `trellis2`, and
 * the images `z-image-turbo` makes from reference images, as it draws from text alone (`production.md` `## method`).
 */
const NEEDS_IMAGE_METHOD = new Set(['rig-2d', 'trellis2', 'z-image-turbo']);
/** Image types: the image method of a game makes them (`production.md` `## method`). */
export const IMAGE_TYPES: readonly string[] = ['image', 'sprite_sheet', 'icon', 'background', 'nine_slice', 'texture', 'skybox', 'app_icon', 'splash'];

/** The method that letters the logo keys `image/logo/<language>` with a font file (`ogw resource logotype`), whose lettering the image method of the game draws again. */
export const LOGOTYPE_METHOD = 'logotype';
export const LOGO_PREFIX = 'image/logo/';
/** The catalog of the fonts that the logotype method letters with. */
export const FONT_CATALOG = 'font-catalog';

/**
 * The image method of a game: the method of the first `final` row of an image type made by a method of the image types,
 * else harness settings `imageMethod`. The attached row `sprite_sheet/<name>` of a `sprite_animation/<name>` in the list
 * (the sheet `ogw resource finalize` writes for that sprite animation) and a logo lettered with a font do not count.
 */
export function gameImageMethod(settings: HarnessSettings, rows: readonly ResourceRow[]): string {
  const imageMethods = new Set(settings.resourceGeneration.filter((m) => m.resourceTypes.includes('image') && m.name !== LOGOTYPE_METHOD).map((m) => m.name));
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
export async function keySpec(game: GameRepo, key: string): Promise<KeyedSpec> {
  return listedSpec(await readList(game.root), key);
}

/** The type, parsed `spec` and list rows of a key. */
export interface KeyedSpec {
  type: string;
  spec: Spec;
  rows: ResourceRow[];
}

/**
 * `keySpec`, or null for a key the list or its spec rejects (`listedSpec` throws an `OgwError` only for that); a list
 * that cannot be read is thrown.
 */
export async function keySpecIfListed(game: GameRepo, key: string): Promise<KeyedSpec | null> {
  const rows = await readList(game.root);
  try {
    return listedSpec(rows, key);
  } catch (error) {
    if (error instanceof OgwError) return null;
    throw error;
  }
}

/** `keySpec` for the rows of a list already read; it throws an `OgwError` only for a key the list or its spec rejects. */
function listedSpec(rows: ResourceRow[], key: string): KeyedSpec {
  const row = findRow(rows, key);
  if (!row) throw new OgwError(`resource key ${key} is not in resource/resources.csv`);
  const { type } = requireKey(key);
  return { type, spec: parseSpec(key, type, row.spec), rows };
}

/**
 * Methods a resource key can use and the stage of each (ogw.md `## generation methods`). A logo key `image/logo/<language>`
 * takes the image method of the game, which draws the lettering of the logotype method again in the world's hand, and
 * the logotype method, whose lettering is kept when no drawing keeps every character (`production.md` `## logo`); both
 * need the logotype method, as image generation does not letter text reliably without its lettering to follow.
 */
export async function chooseMethods(ctx: Context, settings: HarnessSettings, game: GameRepo, key: string): Promise<MethodChoice[]> {
  return keyChoices(ctx, settings, key, await keySpec(game, key));
}

/** `chooseMethods` for a key whose type, parsed `spec` and list rows were read already (`keySpec`). */
export async function keyChoices(ctx: Context, settings: HarnessSettings, key: string, keyed: KeyedSpec): Promise<MethodChoice[]> {
  if (key.startsWith(LOGO_PREFIX)) {
    const logotype = settings.resourceGeneration.find((m) => m.name === LOGOTYPE_METHOD);
    const fonts = settings.resourceGeneration.find((m) => m.name === FONT_CATALOG);
    if (!logotype || !usable(logotype) || !usable(fonts)) return [];
    const imageMethod = gameImageMethod(settings, keyed.rows);
    const image = settings.resourceGeneration.find((m) => m.name === imageMethod);
    const called = image && calledImageMethod(settings, image);
    const drawn = image && usable(image) && called !== null ? [await choiceOf(ctx, image, keyed.spec, called)] : [];
    return [...drawn, await choiceOf(ctx, logotype, keyed.spec, undefined)];
  }
  return methodChoices(ctx, settings, keyed.type, keyed.spec, gameImageMethod(settings, keyed.rows));
}

/**
 * The `flux2-klein` a method calls (`NEEDS_IMAGE_METHOD`): undefined for a method that calls none, and null when it
 * calls it and `flux2-klein` is not usable, so that the method is not usable either.
 */
function calledImageMethod(settings: HarnessSettings, method: GenerationMethod): GenerationMethod | null | undefined {
  if (!NEEDS_IMAGE_METHOD.has(method.name)) return undefined;
  const image = settings.resourceGeneration.find((m) => m.name === IMAGE_METHOD);
  return image && usable(image) ? image : null;
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
    const called = calledImageMethod(settings, method);
    if (!method.resourceTypes.includes(type) || !usable(method) || called === null) continue;
    if (imageType && method.name !== imageMethod) continue;
    choices.push(await choiceOf(ctx, method, spec, called));
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
  return !hasPins(method) || (await methodMarker(ctx, method)) !== null;
}

/**
 * The methods that block a resource key on this host: when none of its methods other than the temporary method is
 * installed (`installedOnHost`, and `flux2-klein` too for the methods that call it (`NEEDS_IMAGE_METHOD`), and for `logotype`
 * `font-catalog`, whose fonts it letters with), the methods of
 * those that are not installed, and the temporary method when it is not installed either, as the key is then made only
 * with the temporary method or with none (`production.md` `## method`). A logo key drawn with an image method needs
 * that method and `font-catalog`, whose lettering it draws, and its `logotype` counts only when it has no image method
 * (`production.md` `## logo`). Empty for a key with an installed method or with no method other than the temporary
 * method.
 */
export async function uninstalledMethods(ctx: Context, settings: HarnessSettings, key: string, keyed: KeyedSpec): Promise<string[]> {
  const choices = await keyChoices(ctx, settings, key, keyed);
  const names = choices.filter((c) => c.temporary !== true).map((c) => c.name);
  const missing: string[] = [];
  const drawn = key.startsWith(LOGO_PREFIX) && names.some((name) => name !== LOGOTYPE_METHOD);
  for (const method of settings.resourceGeneration.filter((m) => names.includes(m.name))) {
    // the lettering alone is the logo only on a host whose image method cannot draw it
    if (drawn && method.name === LOGOTYPE_METHOD) continue;
    const needs = methodNeeds(settings, method, key);
    const lacking: string[] = [];
    for (const m of needs) if (!(await installedOnHost(ctx, m))) lacking.push(m.name);
    if (lacking.length === 0) return [];
    for (const name of lacking) if (!missing.includes(name)) missing.push(name);
  }
  const temporary = choices.find((c) => c.temporary === true);
  if (missing.length > 0 && temporary?.notInstalled === true && !missing.includes(temporary.name)) missing.push(temporary.name);
  return missing;
}

/**
 * What a method of a key needs installed: the method, with `flux2-klein` for the methods that call it
 * (`NEEDS_IMAGE_METHOD`), and `font-catalog` for `logotype` and for an image method drawing a logo, which letter with
 * its fonts.
 */
function methodNeeds(settings: HarnessSettings, method: GenerationMethod, key: string): GenerationMethod[] {
  const calls = [
    ...(NEEDS_IMAGE_METHOD.has(method.name) ? [IMAGE_METHOD] : []),
    ...(method.name === LOGOTYPE_METHOD || key.startsWith(LOGO_PREFIX) ? [FONT_CATALOG] : []),
  ];
  return [method, ...settings.resourceGeneration.filter((m) => calls.includes(m.name))];
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
