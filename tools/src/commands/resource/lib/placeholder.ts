import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { toolProgram } from '../../env/api.ts';
import { encodeOgg, silentWav } from './audio.ts';
import {
  engineType,
  placeholderAnimation3d,
  placeholderMaterial,
  placeholderParticle,
  placeholderRigScene,
  placeholderShader,
  placeholderSpriteFrames,
} from './godot.ts';
import { boxGlb, oneBoneRigGlb } from './gltf.ts';
import { keyColor, placeholderPng } from './image.ts';
import { keyPath, type ParsedKey } from './list.ts';
import { requireAnimations, requireLength, requireSize, type Spec } from './spec.ts';

export interface FileData {
  /** Path relative to the checkout. */
  path: string;
  data: Buffer;
}

/** harness settings `tools` programs, found on first use. */
export interface Tools {
  ffmpeg(): Promise<string>;
  placeholderFont(): Promise<string>;
  /** The environment the command runs with. */
  env: NodeJS.ProcessEnv;
}

function missingTool(name: string): OgwError {
  return new OgwError(`harness settings tools.${name} is not on this host: run update env`);
}

export function hostTools(ctx: Context): Tools {
  let ffmpeg: Promise<string> | null = null;
  let font: Promise<string> | null = null;
  return {
    env: ctx.env,
    ffmpeg: () =>
      (ffmpeg ??= toolProgram(ctx, 'ffmpeg').then((path) => {
        if (path === null) throw missingTool('ffmpeg');
        return path;
      })),
    placeholderFont: () =>
      (font ??= toolProgram(ctx, 'placeholderFont').then((path) => {
        if (path === null) throw missingTool('placeholderFont');
        return path;
      })),
  };
}

const PNG_TYPES = ['image', 'sprite_sheet', 'texture_atlas', 'icon', 'background', 'nine_slice', 'texture', 'skybox', 'tileset', 'app_icon', 'splash'];

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

async function soundFiles(key: string, type: string, spec: Spec, ext: string, tools: Tools): Promise<FileData[]> {
  const length = requireLength(key, spec);
  if (type === 'bgm') return [{ path: keyPath(key, ext), data: await encodeOgg(await tools.ffmpeg(), silentWav(length), tools.env) }];
  if (spec.variants < 2) return [{ path: keyPath(key, ext), data: silentWav(length) }];
  const files: FileData[] = [];
  for (let n = 1; n <= spec.variants; n++) files.push({ path: keyPath(key, ext, n), data: silentWav(length) });
  return files;
}

async function fontFile(key: string, tools: Tools): Promise<FileData> {
  const path = await tools.placeholderFont();
  const ext = extname(path).toLowerCase();
  if (ext !== '.ttf' && ext !== '.otf') throw new OgwError(`placeholder font is not .ttf or .otf: ${path}`);
  return { path: keyPath(key, ext), data: await readFile(path) };
}

function engineText(key: string, parsed: ParsedKey, spec: Spec): string {
  const color = keyColor(key);
  switch (parsed.type) {
    case 'material':
      return placeholderMaterial();
    case 'sprite_animation':
      return placeholderSpriteFrames(requireSize(key, spec), requireAnimations(key, spec), color);
    case 'rig_animation_2d':
      return placeholderRigScene(parsed.last, requireSize(key, spec), requireAnimations(key, spec), color);
    case 'animation_3d':
      return placeholderAnimation3d(requireLength(key, spec));
    case 'particle':
      return placeholderParticle(parsed.last, spec.space ?? '2D');
    case 'shader':
      return placeholderShader(spec.space ?? '2D');
    default:
      throw new OgwError(`${key}: type ${parsed.type} has no placeholder resource`);
  }
}

/** Placeholder resource files of a row (`resource` skill `## placeholder resource`). */
export async function placeholderFiles(engine: string, key: string, parsed: ParsedKey, spec: Spec, tools: Tools): Promise<FileData[]> {
  const ext = engineType(engine, parsed.type).extensions[0] as string;
  if (PNG_TYPES.includes(parsed.type)) return [{ path: keyPath(key, ext), data: await placeholderPng(key, parsed.last, requireSize(key, spec)) }];
  switch (parsed.type) {
    case 'sfx':
    case 'bgm':
    case 'voice':
      return soundFiles(key, parsed.type, spec, ext, tools);
    case 'model': {
      const [x, y, z] = spec.bounds ?? [1, 1, 1];
      return [{ path: keyPath(key, ext), data: boxGlb(x, y, z) }];
    }
    case 'rig':
      return [{ path: keyPath(key, ext), data: oneBoneRigGlb() }];
    case 'haptic': {
      const pattern = { segments: [{ delay_ms: 0, duration_ms: requireLength(key, spec), intensity: 1000 }] };
      return [{ path: keyPath(key, ext), data: text(`${JSON.stringify(pattern, null, 2)}\n`) }];
    }
    case 'font':
      return [await fontFile(key, tools)];
    default:
      return [{ path: keyPath(key, ext), data: text(engineText(key, parsed, spec)) }];
  }
}
