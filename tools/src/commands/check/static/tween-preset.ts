import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import type { Expr, Stmt } from './lib/gd-ast.ts';
import { numberValue } from './lib/gd-lexer.ts';
import type { Prop, Section, TextScene, Variant } from './lib/tscn.ts';

/**
 * tween preset: a tween preset `.tres` under `resource/tween/` passes the items of TweenCore `### definition check`
 * that do not depend on the target object (`client-content` Godot `## scene and prefab`): every step has a change,
 * property and easing are members, duration and delay are 0..`TweenCore.maxDurationMs` and the repeat count is
 * 0..`TweenCore.maxRepeatCount` of the merged core settings, every component is finite, the components no target uses
 * (w of `Position`, `Rotation` and `Scale`, y, z and w of `Opacity`) are 0, `Color` and `Opacity` values are 0..1, no
 * step changes one property twice (`Color` and `Opacity` are one), and an infinite repeat has a cycle time over 0.
 * The enum values are those of `client/core/tween_core/tween_core.gd`.
 */
export const NAME = 'tween preset';

const CORE_FILE = 'client/core/tween_core/tween_core.gd';

function isPreset(path: string): boolean {
  return path.startsWith('resource/tween/') && path.endsWith('.tres');
}

/** Member name to value of a top-level enum of the TweenCore script; null when the enum or a value cannot be read. */
function enumMembers(top: Stmt[], name: string): Map<string, number> | null {
  const decl = top.find((s) => s.k === 'enum' && s.name === name);
  if (decl?.k !== 'enum') return null;
  const out = new Map<string, number>();
  let next = 0;
  for (const m of decl.members) {
    const v = m.value === null ? next : constant(m.value);
    if (v === null) return null;
    out.set(m.name, v);
    next = v + 1;
  }
  return out;
}

function constant(e: Expr): number | null {
  if (e.k === 'num') return numberValue(e.text);
  if (e.k === 'unary' && e.op === '-' && e.expr.k === 'num') return -numberValue(e.expr.text);
  return null;
}

/** What the check reads from the TweenCore script and the merged core settings. */
interface Rules {
  properties: Map<number, string>;
  easings: Set<number>;
  maxDurationMs: number | null;
  maxRepeatCount: number | null;
}

/** Components no target of the property uses: they must be 0. */
const UNUSED: Record<string, readonly number[]> = { POSITION: [3], ROTATION: [3], SCALE: [3], OPACITY: [1, 2, 3], COLOR: [] };
/** Components that must be 0..1. */
const UNIT: Record<string, readonly number[]> = { COLOR: [0, 1, 2, 3], OPACITY: [0] };
/** Properties that one step changes once: `Color` and `Opacity` share one. */
const MASK: Record<string, string> = { COLOR: 'COLOR', OPACITY: 'COLOR' };

function numberOf(v: Variant | undefined, fallback: number): number | null {
  if (v === undefined) return fallback;
  return v.t === 'num' ? v.v : null;
}

/** The 4 components of `Vector4(...)`, or null when the value is something else. */
function vector4(v: Variant | undefined): number[] | null {
  if (v === undefined) return [0, 0, 0, 0];
  if (v.t !== 'call' || v.name !== 'Vector4' || v.args.length !== 4) return null;
  const out = v.args.map((a) => (a.t === 'num' ? a.v : null));
  return out.every((n): n is number => n !== null) ? out : null;
}

/** The items of a typed or untyped array value: `Array[T]([...])` or `[...]`. */
function items(v: Variant | undefined): Variant[] | null {
  if (v === undefined) return [];
  if (v.t === 'arr') return v.items;
  if (v.t === 'call' && v.name.startsWith('Array') && v.args.length === 1 && v.args[0]?.t === 'arr') return v.args[0].items;
  return null;
}

type Item = { section: Section } | { missing: true } | { unread: true };

/** The section of `SubResource("id")`; a `null` item is missing, anything else is not read. */
function item(scene: TextScene, v: Variant): Item {
  if (v.t === 'null') return { missing: true };
  const id = v.t === 'call' && v.name === 'SubResource' && v.args[0]?.t === 'str' ? v.args[0].v : null;
  const section = id === null ? undefined : scene.sub.get(id);
  return section === undefined ? { unread: true } : { section };
}

function lineOf(section: Section, prop: Prop | undefined): number {
  return prop?.line ?? section.line;
}

function inRange(n: number, max: number | null): boolean {
  return Number.isInteger(n) && n >= 0 && (max === null || n <= max);
}

/** Adds a finding of `change` at the line of its property `prop` (the section line when the property is left out). */
type Add = (prop: string, detail: string) => void;

/** The property name of the change, or undefined (with a finding) when it is not a member. */
function propertyOf(rules: Rules, p: Map<string, Prop>, add: Add): string | undefined {
  const value = numberOf(p.get('property')?.value, 0);
  const property = value === null ? undefined : rules.properties.get(value);
  if (property === undefined) add('property', 'has a property that is not a member of TweenProperty');
  return property;
}

/** delay + duration of the change, or null (with findings) when one of them is out of range. */
function lengthOf(rules: Rules, p: Map<string, Prop>, add: Add): number | null {
  let length: number | null = 0;
  for (const key of ['duration', 'delay']) {
    const n = numberOf(p.get(key)?.value, 0);
    if (n !== null && inRange(n, rules.maxDurationMs)) {
      length = length === null ? null : length + n;
      continue;
    }
    add(key, `has ${key} ${n === null ? 'that is not a number' : String(n)} out of 0..TweenCore.maxDurationMs`);
    length = null;
  }
  return length;
}

function valueProblems(property: string | undefined, p: Map<string, Prop>, add: Add): void {
  for (const key of ['target_value', 'start_value']) {
    const v = vector4(p.get(key)?.value);
    if (v === null || !v.every(Number.isFinite)) {
      add(key, `has a ${key} that is not 4 finite numbers`);
      continue;
    }
    if (property === undefined) continue;
    if ((UNUSED[property] ?? []).some((i) => v[i] !== 0)) add(key, `has a ${key} whose components no target of ${property} uses are not 0`);
    if ((UNIT[property] ?? []).some((i) => (v[i] as number) < 0 || (v[i] as number) > 1)) add(key, `has a ${property} ${key} out of 0..1`);
  }
}

/** Findings of one change; returns its mask name and delay + duration, each null when it cannot be read. */
function changeProblems(scene: TextScene, rules: Rules, change: Section, where: string, out: Finding[]): { mask: string | null; length: number | null } {
  const p = change.props;
  const add: Add = (prop, detail) => {
    out.push(finding(NAME, at(scene.path, lineOf(change, p.get(prop))), `${where} ${detail}`));
  };
  const property = propertyOf(rules, p, add);
  const easing = numberOf(p.get('easing')?.value, 0);
  if (easing === null || !rules.easings.has(easing)) add('easing', 'has an easing that is not a member of Easing');
  const length = lengthOf(rules, p, add);
  valueProblems(property, p, add);
  return { mask: property === undefined ? null : (MASK[property] ?? property), length };
}

/** Findings of one step; returns the largest delay + duration of its changes, or null when one cannot be read. */
function stepProblems(scene: TextScene, rules: Rules, step: Section, s: number, out: Finding[]): number | null {
  const changesProp = step.props.get('changes');
  const changes = items(changesProp?.value);
  if (changes === null || changes.length === 0) {
    out.push(finding(NAME, at(scene.path, lineOf(step, changesProp)), `step ${String(s)} has no change`));
    return 0;
  }
  const masks = new Set<string>();
  let longest: number | null = 0;
  for (const [c, changeValue] of changes.entries()) {
    const where = `change ${String(c)} of step ${String(s)}`;
    const change = item(scene, changeValue);
    if ('missing' in change) out.push(finding(NAME, at(scene.path, lineOf(step, changesProp)), `${where} is missing`));
    if (!('section' in change)) {
      longest = null;
      continue;
    }
    const { mask, length } = changeProblems(scene, rules, change.section, where, out);
    if (mask !== null && masks.has(mask)) out.push(finding(NAME, at(scene.path, change.section.line), `step ${String(s)} changes one property twice`));
    if (mask !== null) masks.add(mask);
    longest = longest === null || length === null ? null : Math.max(longest, length);
  }
  return longest;
}

function presetProblems(scene: TextScene, rules: Rules): Finding[] {
  const out: Finding[] = [];
  const resource = scene.sections.find((s) => s.tag === 'resource');
  if (resource === undefined) return [finding(NAME, at(scene.path, 1), 'the preset has no [resource] section')];
  const repeatProp = resource.props.get('repeat_count');
  const repeat = numberOf(repeatProp?.value, 1);
  if (repeat === null || !inRange(repeat, rules.maxRepeatCount)) {
    out.push(finding(NAME, at(scene.path, lineOf(resource, repeatProp)), `repeat count ${repeat === null ? 'that is not a number' : String(repeat)} is out of 0..TweenCore.maxRepeatCount`));
  }
  const stepsProp = resource.props.get('steps');
  const steps = items(stepsProp?.value);
  if (steps === null) return [...out, finding(NAME, at(scene.path, lineOf(resource, stepsProp)), 'steps is not an array')];
  // the cycle time, or null when a step or change could not be read
  let cycle: number | null = 0;
  for (const [s, stepValue] of steps.entries()) {
    const step = item(scene, stepValue);
    if ('missing' in step) out.push(finding(NAME, at(scene.path, lineOf(resource, stepsProp)), `step ${String(s)} is missing`));
    const longest = 'section' in step ? stepProblems(scene, rules, step.section, s, out) : null;
    cycle = cycle === null || longest === null ? null : cycle + longest;
  }
  if (repeat === 0 && cycle === 0) out.push(finding(NAME, at(scene.path, lineOf(resource, repeatProp)), 'the preset repeats forever with cycle time 0'));
  return out;
}

function limit(core: Record<string, unknown>, key: string): number | null {
  const v = core[key];
  return typeof v === 'number' ? v : null;
}

async function readRules(sc: StaticContext): Promise<Rules | null> {
  if (!sc.has(CORE_FILE)) return null;
  const top = (await sc.gd(CORE_FILE)).top.body;
  const properties = enumMembers(top, 'TweenProperty');
  const easings = enumMembers(top, 'Easing');
  if (properties === null || easings === null) return null;
  const core = await sc.coreSettings();
  return {
    properties: new Map([...properties].map(([name, value]) => [value, name])),
    easings: new Set(easings.values()),
    maxDurationMs: limit(core, 'TweenCore.maxDurationMs'),
    maxRepeatCount: limit(core, 'TweenCore.maxRepeatCount'),
  };
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const presets = sc.filter(isPreset);
  if (presets.length === 0) return [];
  const rules = await readRules(sc);
  if (rules === null) return [finding(NAME, at(CORE_FILE, 1), `the enums TweenProperty and Easing could not be read, so the ${String(presets.length)} tween presets are not checked`)];
  const results = await Promise.all(presets.map(async (path) => presetProblems(await sc.scene(path), rules)));
  return results.flat();
}
