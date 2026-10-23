import { OgwError } from '../../../lib/errors.ts';
import { isSnakeCase } from './list.ts';

export interface SpecAnimation {
  name: string;
  lengthMs: number;
  loop: boolean;
}

/** A parsed `spec` cell (`resource` skill `### spec`). Omitted optional items take their default. */
export interface Spec {
  size: [number, number] | null;
  alpha: boolean;
  slice: [number, number, number, number] | null;
  lengthMs: number | null;
  loop: boolean;
  animations: SpecAnimation[] | null;
  variants: number;
  bounds: [number, number, number] | null;
  space: '2D' | '3D' | null;
}

interface ItemRule {
  required: readonly string[];
  optional: readonly string[];
  apply(spec: Spec, value: string): boolean;
}

const POSITIVE = /^[1-9][0-9]*$/;
const NON_NEGATIVE = /^(?:0|[1-9][0-9]*)$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function parseBool(value: string): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseAnimations(value: string): SpecAnimation[] | null {
  const animations: SpecAnimation[] = [];
  for (const item of value.split(',')) {
    const [name, length, repeat, extra] = item.split(':');
    if (extra !== undefined || name === undefined || length === undefined || repeat === undefined) return null;
    if (!isSnakeCase(name) || !POSITIVE.test(length) || (repeat !== 'loop' && repeat !== 'once')) return null;
    if (animations.some((a) => a.name === name)) return null;
    animations.push({ name, lengthMs: Number(length), loop: repeat === 'loop' });
  }
  return animations;
}

const PIXEL_TYPES = ['image', 'sprite_sheet', 'texture_atlas', 'icon', 'background', 'nine_slice', 'texture', 'tileset'];

const ITEMS: Record<string, ItemRule> = {
  size: {
    required: [...PIXEL_TYPES, 'skybox', 'app_icon', 'splash', 'sprite_animation', 'rig_animation_2d'],
    optional: [],
    apply(spec, value) {
      const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(value);
      if (!match) return false;
      spec.size = [Number(match[1]), Number(match[2])];
      return true;
    },
  },
  alpha: {
    required: [],
    optional: PIXEL_TYPES,
    apply(spec, value) {
      const parsed = parseBool(value);
      if (parsed === null) return false;
      spec.alpha = parsed;
      return true;
    },
  },
  slice: {
    required: ['nine_slice'],
    optional: [],
    apply(spec, value) {
      const parts = value.split(',');
      if (parts.length !== 4 || !parts.every((p) => NON_NEGATIVE.test(p))) return false;
      spec.slice = parts.map(Number) as [number, number, number, number];
      return true;
    },
  },
  length: {
    required: ['sfx', 'bgm', 'voice', 'haptic', 'animation_3d'],
    optional: [],
    apply(spec, value) {
      if (!POSITIVE.test(value)) return false;
      spec.lengthMs = Number(value);
      return true;
    },
  },
  loop: {
    required: [],
    optional: ['sfx', 'bgm', 'animation_3d', 'particle'],
    apply(spec, value) {
      const parsed = parseBool(value);
      if (parsed === null) return false;
      spec.loop = parsed;
      return true;
    },
  },
  animations: {
    required: ['sprite_animation', 'rig_animation_2d'],
    optional: [],
    apply(spec, value) {
      spec.animations = parseAnimations(value);
      return spec.animations !== null;
    },
  },
  variants: {
    required: [],
    optional: ['sfx'],
    apply(spec, value) {
      if (!POSITIVE.test(value)) return false;
      spec.variants = Number(value);
      return true;
    },
  },
  bounds: {
    required: ['model'],
    optional: [],
    apply(spec, value) {
      const parts = value.split('x');
      if (parts.length !== 3 || !parts.every((p) => DECIMAL.test(p) && Number(p) > 0)) return false;
      spec.bounds = parts.map(Number) as [number, number, number];
      return true;
    },
  },
  space: {
    required: ['particle', 'shader'],
    optional: [],
    apply(spec, value) {
      if (value !== '2D' && value !== '3D') return false;
      spec.space = value;
      return true;
    },
  },
};

function emptySpec(): Spec {
  return { size: null, alpha: false, slice: null, lengthMs: null, loop: false, animations: null, variants: 1, bounds: null, space: null };
}

/** Problems of a `spec` cell against the `spec` item rules for a type. Empty when it follows them. */
export function specProblems(type: string, cell: string): string[] {
  const problems: string[] = [];
  const spec = emptySpec();
  const given = new Set<string>();
  for (const item of cell === '' ? [] : cell.split(';')) {
    const eq = item.indexOf('=');
    const name = eq === -1 ? item : item.slice(0, eq);
    const rule = ITEMS[name];
    if (eq === -1 || !rule) {
      problems.push(`unknown item ${item}`);
      continue;
    }
    if (given.has(name)) problems.push(`item ${name} given twice`);
    given.add(name);
    if (!rule.required.includes(type) && !rule.optional.includes(type)) problems.push(`item ${name} is not for type ${type}`);
    else if (!rule.apply(spec, item.slice(eq + 1))) problems.push(`invalid ${name} value ${item.slice(eq + 1)}`);
  }
  for (const [name, rule] of Object.entries(ITEMS)) {
    if (rule.required.includes(type) && !given.has(name)) problems.push(`missing item ${name}`);
  }
  return problems;
}

/** Parses a `spec` cell; fails naming the key when it breaks the `spec` item rules. */
export function parseSpec(key: string, type: string, cell: string): Spec {
  const problems = specProblems(type, cell);
  if (problems.length > 0) throw new OgwError(`${key}: spec ${cell === '' ? '(empty)' : cell}: ${problems.join('; ')}`);
  const spec = emptySpec();
  for (const item of cell === '' ? [] : cell.split(';')) {
    const eq = item.indexOf('=');
    (ITEMS[item.slice(0, eq)] as ItemRule).apply(spec, item.slice(eq + 1));
  }
  return spec;
}

export function requireSize(key: string, spec: Spec): [number, number] {
  if (!spec.size) throw new OgwError(`${key}: spec has no size`);
  return spec.size;
}

export function requireLength(key: string, spec: Spec): number {
  if (spec.lengthMs === null) throw new OgwError(`${key}: spec has no length`);
  return spec.lengthMs;
}

export function requireAnimations(key: string, spec: Spec): SpecAnimation[] {
  if (!spec.animations) throw new OgwError(`${key}: spec has no animations`);
  return spec.animations;
}
