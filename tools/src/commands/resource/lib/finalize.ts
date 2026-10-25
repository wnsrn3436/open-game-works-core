import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { mergedCoreSettings } from '../../generate/api.ts';
import { catalogEntries, generationMethods } from '../../generation/api.ts';
import { processSound, type SoundShape } from './audio.ts';
import { FileChanges } from './files.ts';
import { engineOf, gameSettings, lineVoices, sourceLanguageOf, sourceTranslations } from './gamedata.ts';
import { engineType, rigSceneNames, sceneNodes, spriteFramesFromSheet } from './godot.ts';
import { alphaBox, coverCropped, crop, decodeRgba, encodePng, fitCentered, type Rgba } from './image.ts';
import { COLUMNS, emptyRow, findRow, formatList, keyFiles, keyPath, LIST_PATH, readList, requireKey, SOUND_TYPES, type ParsedKey, type ResourceRow } from './list.ts';
import { hostTools, type Tools } from './placeholder.ts';
import { readSplit, rigCheck, type RigSplit } from './rig.ts';
import { readSkeleton, type Point, type Skeleton, type SkeletonBone } from './skeleton.ts';
import { parseSpec, requireAnimations, requireLength, requireSize, type SfxLevel, type Spec } from './spec.ts';
import { buildSheet, layoutProblems, readFrameLayout } from './sprite.ts';
import { runSync, writeLineVoices } from './sync.ts';

export interface FinalizeOptions {
  key: string;
  method: string;
  files: string[];
  inputs: string[];
  bus: string | null;
  /** `music.json` of `ace-step`: the tempo of a looped `bgm`. */
  music: string | null;
  manifest: string | null;
  skeleton: string | null;
  split: string | null;
}

export interface Loudness {
  file: string;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
}

export interface FinalizeResult {
  key: string;
  changed: Partial<ResourceRow>;
  loudness: Loudness[] | null;
}

/** What a finalize writes: files, the row, and its dependent rows. */
interface Plan {
  changes: FileChanges;
  dependents: { key: string; description: string; spec: string }[];
  removedDependents: string[];
  loudness: Loudness[] | null;
}

interface Job {
  ctx: Context;
  game: GameRepo;
  options: FinalizeOptions;
  parsed: ParsedKey;
  spec: Spec;
  row: ResourceRow;
  rows: ResourceRow[];
  engine: string;
  tools: Tools;
  skeleton: Skeleton | null;
  split: RigSplit | null;
  /** `final`, or `temporary` when `ogw generation methods` gives the method as the temporary method of the key. */
  status: 'final' | 'temporary';
}

const IMAGE_POST = ['image', 'icon', 'background', 'texture', 'app_icon', 'splash'];

function fileProblems(job: Job): string[] {
  const { options, parsed, spec } = job;
  const problems: string[] = [];
  const want = spec.variants >= 2 ? spec.variants : 1;
  if (options.files.length !== want) problems.push(`--file needs ${String(want)} file(s), got ${String(options.files.length)}`);
  const engineExtensions = engineType(job.engine, parsed.type).extensions;
  // A sound may also be the WAV a generation method writes: step 2 encodes it to the engine format.
  const extensions =
    parsed.type === 'sprite_animation' ? ['.png'] : SOUND_TYPES.includes(parsed.type) ? [...new Set([...engineExtensions, '.wav'])] : engineExtensions;
  for (const file of options.files) {
    if (!exists(file)) problems.push(`--file ${file} does not exist`);
    if (!extensions.includes(extname(file).toLowerCase())) problems.push(`--file ${file} extension is not ${extensions.join(' or ')}`);
  }
  return problems;
}

/** `--music` is given for a looped `bgm` only, and exists. */
function musicProblems(job: Job): string[] {
  const loopBgm = job.parsed.type === 'bgm' && job.spec.loop;
  const music = job.options.music;
  if (loopBgm !== (music !== null)) return [loopBgm ? '--music is required for a bgm whose loop is true' : '--music is only for a bgm whose loop is true'];
  return music !== null && !exists(music) ? [`--music ${music} does not exist`] : [];
}

function optionProblems(job: Job): string[] {
  const { options, parsed } = job;
  const problems = fileProblems(job);
  const type = parsed.type;
  if (type === 'sfx' && options.bus !== 'Sfx' && options.bus !== 'Ui') problems.push('--bus Sfx or --bus Ui is required for sfx');
  if (type !== 'sfx' && options.bus !== null) problems.push('--bus is only for sfx');
  problems.push(...musicProblems(job));
  if ((type === 'sprite_animation') !== (options.manifest !== null)) problems.push(type === 'sprite_animation' ? '--manifest is required for sprite_animation' : '--manifest is only for sprite_animation');
  const rig = type === 'rig_animation_2d';
  if (rig && (options.skeleton === null || options.split === null)) problems.push('--skeleton and --split are required for rig_animation_2d');
  if (!rig && (options.skeleton !== null || options.split !== null)) problems.push('--skeleton and --split are only for rig_animation_2d');
  return problems;
}

function rowProblems(job: Job, methods: readonly string[]): string[] {
  // a temporary row was requested again: its new resource replaces the temporary one
  const problems: string[] = [];
  if (job.row.status !== 'requested' && job.row.status !== 'temporary') problems.push(`${job.row.key} status is ${job.row.status}, not requested`);
  const kit = findRow(job.rows, UI_KIT);
  if ((job.parsed.type === 'nine_slice' || job.parsed.type === 'icon') && kit?.status === 'final' && !job.options.inputs.includes(UI_KIT)) {
    problems.push(`--inputs needs ${UI_KIT}: ${job.parsed.type} keys are made from the UI kit sheet`);
  }
  if (!methods.includes(job.options.method)) problems.push(`method ${job.options.method} is not in ogw generation methods for ${job.row.key}: ${methods.join(', ') || 'none'}`);
  for (const key of job.options.inputs) {
    const input = findRow(job.rows, key);
    if (!input) problems.push(`--inputs ${key} is not in ${LIST_PATH}`);
    else if (input.status !== 'final') problems.push(`--inputs ${key} is not final`);
  }
  return problems;
}

function dependentKeys(job: Job): { key: string; description: string }[] {
  const { parsed, row } = job;
  if (parsed.type === 'sprite_animation') return [{ key: `sprite_sheet/${parsed.name}`, description: `${row.key} sheet` }];
  if (parsed.type === 'rig_animation_2d' && job.skeleton) {
    return job.skeleton.parts.map((p) => ({ key: `image/${parsed.name}/${p.name}`, description: `${row.key} part ${p.name}` }));
  }
  return [];
}

function dependentProblems(job: Job): string[] {
  const problems: string[] = [];
  for (const dep of dependentKeys(job)) {
    const existing = findRow(job.rows, dep.key);
    if (existing && existing.description !== dep.description) problems.push(`${dep.key} is in ${LIST_PATH} but is not a dependent row of ${job.row.key}`);
  }
  return problems;
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

/** `position = Vector2(x, y)` of the `[node]` block that starts at `header`; [0, 0] when the node does not set it. */
function nodePosition(text: string, header: RegExpExecArray): Point {
  const rest = text.slice(header.index + header[0].length);
  const end = rest.search(/^\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const match = /^position = Vector2\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)/m.exec(body);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

/** Position in the root node of the root `Bone2D` `bone`: its `position` plus that of its `Skeleton2D` parent, a root child. */
function rootBonePosition(text: string, bone: string): Point | null {
  const headers = [...text.matchAll(/^\[node\b[^\]]*\]/gm)];
  const nodes = sceneNodes(text);
  const skeleton = nodes.findIndex((n) => n.type === 'Skeleton2D' && n.parent === '.');
  const root = nodes.findIndex((n) => n.type === 'Bone2D' && n.name === bone && n.parent === nodes[skeleton]?.name);
  if (skeleton === -1 || root === -1) return null;
  const a = nodePosition(text, headers[skeleton] as RegExpExecArray);
  const b = nodePosition(text, headers[root] as RegExpExecArray);
  return [a[0] + b[0], a[1] + b[1]];
}

/** The canvas is `size` of `spec` and its center is the root node origin (`client-core` `engines/godot.md`). */
function rigCanvasProblems(job: Job, scene: string): string[] {
  const skeleton = job.skeleton as Skeleton;
  const split = job.split as RigSplit;
  const problems: string[] = [];
  const size = requireSize(job.row.key, job.spec);
  const [width, height] = split.canvas;
  if (width !== size[0] || height !== size[1]) problems.push(`--split canvas ${String(width)}x${String(height)} is not spec size ${String(size[0])}x${String(size[1])}`);
  if (split.source !== resolve(skeleton.source)) problems.push(`--split source ${split.source} is not the skeleton spec source ${skeleton.source}`);
  const rootBone = skeleton.bones.find((b) => b.parent === null) as SkeletonBone;
  const pivot = rootBone.pivot as Point;
  const want: Point = [pivot[0] - width / 2, pivot[1] - height / 2];
  const found = rootBonePosition(scene, rootBone.name);
  if (found === null) problems.push(`rig scene has no Bone2D ${rootBone.name} under a Skeleton2D child of the root`);
  else if (found[0] !== want[0] || found[1] !== want[1]) {
    problems.push(`rig scene root Bone2D ${rootBone.name} is at (${found.join(', ')}) of the root node, not its pivot minus half the canvas (${want.join(', ')})`);
  }
  return problems;
}

async function rigProblems(job: Job): Promise<string[]> {
  const skeleton = job.skeleton as Skeleton;
  const split = job.split as RigSplit;
  const problems: string[] = [];
  for (const part of skeleton.parts) {
    if (part.image !== `image/${job.parsed.name}/${part.name}`) problems.push(`part ${part.name} image is not image/${job.parsed.name}/${part.name}`);
  }
  const animations = requireAnimations(job.row.key, job.spec);
  const same = animations.length === skeleton.animations.length && animations.every((a, i) => {
    const s = skeleton.animations[i];
    return s !== undefined && s.name === a.name && s.duration_ms === a.lengthMs && s.loop === a.loop;
  });
  if (!same) problems.push('skeleton spec animations are not the spec animations in order, name, length and repeat');
  if (split.parts.map((p) => p.name).join(',') !== skeleton.parts.map((p) => p.name).join(',')) problems.push('--split parts are not the skeleton spec parts');
  else {
    const settings = await job.ctx.settings();
    const recompose = await rigCheck(job.options.split as string, settings.rigCheck);
    if (recompose.status !== 'pass') problems.push(`ogw resource rig-check is fail: alphaIou ${String(recompose.alphaIou)}, colorDiff ${String(recompose.colorDiff)}`);
  }
  const scene = await readFile(job.options.files[0] as string, 'utf8');
  const names = rigSceneNames(scene);
  if (!sameNames(names.bones, skeleton.bones.map((b) => b.name))) problems.push('rig scene Bone2D names are not the skeleton spec bones');
  if (!sameNames(names.parts, skeleton.parts.map((p) => p.name))) problems.push('rig scene part node names are not the skeleton spec parts');
  if (!sameNames(names.animations, skeleton.animations.map((a) => a.name))) problems.push('rig scene AnimationPlayer animations are not the skeleton spec animations');
  return [...problems, ...rigCanvasProblems(job, scene)];
}

/** An image of a type with `alpha` in `spec` (every such type is an image type) whose `alpha` is `true` has a pixel with alpha under 255; a fully opaque file has its background baked in. */
async function alphaProblems(job: Job): Promise<string[]> {
  if (!job.spec.alpha) return [];
  const file = job.options.files[0] as string;
  return hasTransparency(await decodeRgba(file, file)) ? [] : [`${file}: every pixel is opaque; the background is baked in`];
}

async function typeProblems(job: Job): Promise<string[]> {
  if (job.parsed.type === 'sprite_animation') {
    return layoutProblems(await readFrameLayout(job.options.manifest as string), requireAnimations(job.row.key, job.spec));
  }
  if (job.parsed.type === 'rig_animation_2d') return rigProblems(job);
  return [];
}

async function busTarget(job: Job, bus: string): Promise<{ lufs: number; peak: number }> {
  const core = await mergedCoreSettings(job.ctx, job.game);
  const lufs = (core['SoundCore.busLoudnessLufs'] as Record<string, unknown> | undefined)?.[bus];
  const peak = (core['SoundCore.busPeakMaxDbtp'] as Record<string, unknown> | undefined)?.[bus];
  if (typeof lufs !== 'number' || typeof peak !== 'number') throw new OgwError(`core settings SoundCore.busLoudnessLufs and SoundCore.busPeakMaxDbtp have no number for bus ${bus}`);
  return { lufs, peak };
}

function soundBus(job: Job): string {
  if (job.parsed.type === 'bgm') return 'Bgm';
  if (job.parsed.type === 'voice') return 'Voice';
  return job.options.bus as string;
}

/** Gain over the bus loudness per `sfx` `level` (`production.md` `## finalize`). */
const LEVEL_OFFSET_DB: Record<SfxLevel, number> = { quiet: -8, normal: 0, loud: 4 };
/** Longest seam of a looped `sfx`: the crossfade is this or a quarter of the `spec` length. */
const SFX_SEAM_MS = 500;

/** Bar length in ms from the `bpm` and `beatsPerBar` of `--music`. */
async function barMs(file: string): Promise<number> {
  const music = await readJson<{ bpm?: unknown; beatsPerBar?: unknown }>(file);
  const { bpm, beatsPerBar } = music;
  if (typeof bpm !== 'number' || !(bpm > 0) || typeof beatsPerBar !== 'number' || !Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    throw new OgwError(`--music ${file}: bpm must be a number over 0 and beatsPerBar an integer of 1 or more`);
  }
  return (beatsPerBar * 60000) / bpm;
}

/** How step 2 shapes a sound of `key` with `spec`; `music` is the `--music` file of a looped `bgm`. */
export async function soundShape(key: string, spec: Spec, music: string | null): Promise<SoundShape> {
  const type = requireKey(key).type;
  if (!spec.loop) return { kind: 'once', trim: type !== 'bgm', maxMs: type === 'sfx' ? spec.lengthMs : null };
  const lengthMs = requireLength(key, spec);
  if (type === 'bgm') {
    const bar = await barMs(music as string);
    return { kind: 'loop', lengthMs, seamMs: bar, barMs: bar };
  }
  return { kind: 'loop', lengthMs, seamMs: Math.min(SFX_SEAM_MS, lengthMs / 4), barMs: null };
}

async function soundPlan(job: Job, plan: Plan): Promise<void> {
  const ffmpeg = await job.tools.ffmpeg();
  const target = await busTarget(job, soundBus(job));
  const shape = await soundShape(job.row.key, job.spec, job.options.music);
  const ext = engineType(job.engine, job.parsed.type).extensions[0] as string;
  const variants = job.options.files.length > 1;
  plan.loudness = [];
  for (const [i, file] of job.options.files.entries()) {
    const result = await processSound(ffmpeg, file, {
      shape,
      loudnessLufs: target.lufs + LEVEL_OFFSET_DB[job.spec.level],
      peakMaxDbtp: target.peak,
      ogg: ext === '.ogg',
    }, job.ctx.env);
    const path = keyPath(job.row.key, ext, variants ? i + 1 : null);
    plan.changes.write(path, result.bytes);
    plan.loudness.push({ file: path, integratedLufs: result.integratedLufs, truePeakDbtp: result.truePeakDbtp });
  }
}

function hasTransparency(image: Rgba): boolean {
  for (let i = 3; i < image.data.length; i += 4) if ((image.data[i] as number) < 255) return true;
  return false;
}

/** The UI kit sheet that every `nine_slice` and `icon` key is made from (`production.md` `## making`). */
const UI_KIT = 'image/ui_kit';

async function imagePlan(job: Job, plan: Plan): Promise<void> {
  const file = job.options.files[0] as string;
  const size = requireSize(job.row.key, job.spec);
  let image = await decodeRgba(file, file);
  if (job.spec.alpha) {
    const box = alphaBox(image, 0);
    if (!box) throw new OgwError(`${file}: every pixel has alpha 0`);
    image = await fitCentered(crop(image, box[0], box[1], box[2] - box[0], box[3] - box[1]), size[0], size[1]);
  } else {
    image = await coverCropped(image, size[0], size[1]);
  }
  plan.changes.write(keyPath(job.row.key, '.png'), await encodePng(image));
}

async function spritePlan(job: Job, plan: Plan): Promise<void> {
  const file = job.options.files[0] as string;
  const layout = await readFrameLayout(job.options.manifest as string);
  const sheet = await buildSheet(await decodeRgba(file, file), layout, requireAnimations(job.row.key, job.spec), requireSize(job.row.key, job.spec));
  const sheetKey = `sprite_sheet/${job.parsed.name}`;
  const sheetPath = keyPath(sheetKey, '.png');
  plan.changes.write(sheetPath, await encodePng(sheet.image));
  plan.changes.write(keyPath(job.row.key, '.tres'), spriteFramesFromSheet(sheetPath, sheet.animations));
  plan.dependents.push({ key: sheetKey, description: `${job.row.key} sheet`, spec: `size=${String(sheet.image.width)}x${String(sheet.image.height)};alpha=true` });
}

async function rigPlan(job: Job, plan: Plan): Promise<void> {
  const split = job.split as RigSplit;
  plan.changes.write(keyPath(job.row.key, '.tscn'), await readFile(job.options.files[0] as string));
  for (const part of split.parts) {
    const key = `image/${job.parsed.name}/${part.name}`;
    const image = await decodeRgba(part.file, part.file);
    plan.changes.write(keyPath(key, '.png'), await readFile(part.file));
    plan.dependents.push({ key, description: `${job.row.key} part ${part.name}`, spec: `size=${String(image.width)}x${String(image.height)};alpha=true` });
  }
  const prefix = `image/${job.parsed.name}/`;
  for (const row of job.rows) {
    const part = row.key.startsWith(prefix) ? row.key.slice(prefix.length) : null;
    if (part === null || row.description !== `${job.row.key} part ${part}` || split.parts.some((p) => p.name === part)) continue;
    plan.removedDependents.push(row.key);
    for (const f of await keyFiles(job.game.root, row.key)) plan.changes.delete(f.path);
  }
}

async function filePlan(job: Job): Promise<Plan> {
  const plan: Plan = { changes: new FileChanges(), dependents: [], removedDependents: [], loudness: null };
  const type = job.parsed.type;
  if (SOUND_TYPES.includes(type)) await soundPlan(job, plan);
  else if (IMAGE_POST.includes(type)) await imagePlan(job, plan);
  else if (type === 'sprite_animation') await spritePlan(job, plan);
  else if (type === 'rig_animation_2d') await rigPlan(job, plan);
  else {
    const file = job.options.files[0] as string;
    plan.changes.write(keyPath(job.row.key, extname(file).toLowerCase()), await readFile(file));
  }
  for (const f of await keyFiles(job.game.root, job.row.key)) if (!plan.changes.planned(f.path)) plan.changes.delete(f.path);
  return plan;
}

/** `license` of combined resources: distinct values in byte order joined by ` AND `; `unknown` when any is unknown. */
export function combinedLicense(values: readonly string[]): string {
  const distinct = [...new Set(values)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (distinct.includes('unknown')) return 'unknown';
  return distinct.map((v) => (v.includes(' OR ') ? `(${v})` : v)).join(' AND ');
}

/** Distinct non-empty values in byte order joined by `separator`. */
function joinDistinct(values: readonly string[], separator: string): string {
  return [...new Set(values.filter((v) => v !== ''))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join(separator);
}

export function combinedAttribution(values: readonly string[]): string {
  return joinDistinct(values, '; ');
}

interface Rights {
  source: string;
  license: string;
  attribution: string;
}

/** Source URL, license and attribution `ogw generation list <method>` gives for each `--file` path. */
async function catalogRights(job: Job): Promise<Rights[]> {
  const entries = await catalogEntries(job.ctx, job.options.method);
  const problems: string[] = [];
  const found: Rights[] = [];
  for (const path of job.options.files) {
    const file = resolve(job.ctx.cwd, path);
    const entry = entries.find((e) => e.path === file);
    if (!entry) problems.push(`--file ${file} is not a path ogw generation list ${job.options.method} gives`);
    else found.push({ source: entry.source, license: entry.license, attribution: entry.attribution });
  }
  if (problems.length > 0) throw new OgwError(problems.join('\n'));
  return found;
}

async function rights(job: Job): Promise<Rights> {
  const settings = await job.ctx.settings();
  const method = settings.resourceGeneration.find((m) => m.name === job.options.method);
  const bases = method?.kind === 'catalog'
    ? await catalogRights(job)
    : [{ source: '', license: method?.license ?? '', attribution: typeof method?.attribution === 'string' ? method.attribution : '' }];
  const source = joinDistinct(bases.map((b) => b.source), ' ');
  if (bases.length === 1 && job.options.inputs.length === 0) return { ...(bases[0] as Rights), source };
  const inputs = job.options.inputs.map((key) => findRow(job.rows, key) as ResourceRow);
  return {
    source,
    license: combinedLicense([...bases.map((b) => b.license), ...inputs.map((r) => r.license)]),
    attribution: combinedAttribution([...bases.map((b) => b.attribution), ...inputs.map((r) => r.attribution)]),
  };
}

async function textHash(job: Job): Promise<string> {
  if (job.parsed.type !== 'voice' || job.row.text_key === '') return '';
  const language = sourceLanguageOf(await gameSettings(job.ctx, job.game));
  const translation = (await sourceTranslations(job.game.root, language)).get(job.row.text_key);
  if (!translation) throw new OgwError(`${job.row.key}: text_key ${job.row.text_key} is not in data/translations/${language}.csv`);
  return translation.currentHash;
}

function writeRows(job: Job, plan: Plan, cells: { source: string; license: string; attribution: string; textHash: string }): ResourceRow[] {
  const rows = job.rows.filter((r) => !plan.removedDependents.includes(r.key));
  const row = findRow(rows, job.row.key) as ResourceRow;
  Object.assign(row, { status: job.status, method: job.options.method, source: cells.source, license: cells.license, attribution: cells.attribution });
  if (job.parsed.type === 'voice' && row.text_key !== '') row.text_hash = cells.textHash;
  for (const dep of plan.dependents) {
    let depRow = findRow(rows, dep.key);
    if (!depRow) {
      depRow = emptyRow(dep.key);
      rows.push(depRow);
    }
    Object.assign(depRow, { description: dep.description, spec: dep.spec, status: job.status, method: row.method, source: row.source, license: row.license, attribution: row.attribution });
  }
  return rows;
}

async function prepare(ctx: Context, game: GameRepo, options: FinalizeOptions, tools: Tools): Promise<Job> {
  const settings = await gameSettings(ctx, game);
  const rows = await readList(game.root);
  const row = findRow(rows, options.key);
  if (!row) throw new OgwError(`${options.key} is not in ${LIST_PATH}`);
  const parsed = requireKey(options.key);
  const job: Job = { ctx, game, options, parsed, spec: parseSpec(row.key, parsed.type, row.spec), row, rows, engine: engineOf(settings), tools, skeleton: null, split: null, status: 'final' };
  const choices = await generationMethods(ctx, game, options.key);
  const methods = choices.map((m) => m.name);
  if (choices.find((m) => m.name === options.method)?.temporary === true) job.status = 'temporary';
  const problems = [...rowProblems(job, methods), ...optionProblems(job)];
  if (problems.length > 0) throw new OgwError(problems.join('\n'));
  if (parsed.type === 'rig_animation_2d') {
    job.skeleton = await readSkeleton(options.skeleton as string, true);
    job.split = await readSplit(options.split as string);
  }
  const more = [...dependentProblems(job), ...(await alphaProblems(job)), ...(await typeProblems(job))];
  if (more.length > 0) throw new OgwError(more.join('\n'));
  if (SOUND_TYPES.includes(parsed.type)) await tools.ffmpeg();
  return job;
}

/** `ogw resource finalize` (`production.md` `## finalize`). Changes nothing when a check fails. */
export async function finalizeResource(ctx: Context, game: GameRepo, options: FinalizeOptions, tools: Tools = hostTools(ctx)): Promise<FinalizeResult> {
  const job = await prepare(ctx, game, options, tools);
  const before = { ...job.row };
  // a line voice row gets its text_key from cutscene_step as sync writes it in step 5, so text_hash is of that text
  writeLineVoices(job.rows, await lineVoices(game.root));
  const hash = await textHash(job);
  const cells = { ...(await rights(job)), textHash: hash };
  const plan = await filePlan(job);
  plan.changes.write(LIST_PATH, formatList(writeRows(job, plan, cells)));
  const { undo } = await plan.changes.apply(game.root);
  let after: ResourceRow;
  try {
    const synced = await runSync(ctx, game, tools);
    after = findRow(await readList(game.root), options.key) as ResourceRow;
    if (after.status !== job.status) {
      await synced.undo();
      throw new OgwError(`${options.key}: ogw resource sync made the row ${after.status}, not ${job.status}`);
    }
  } catch (error) {
    await undo();
    throw error;
  }
  const changed: Partial<ResourceRow> = {};
  for (const column of COLUMNS) if (before[column] !== after[column]) changed[column] = after[column];
  return { key: options.key, changed, loudness: plan.loudness };
}
