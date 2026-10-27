import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tweenPreset from '../../../../src/commands/check/static/tween-preset.ts';
import { lines, memContext } from './helpers.ts';

const state = vi.hoisted((): { core: Record<string, unknown> } => ({ core: {} }));

vi.mock('../../../../src/commands/generate/api.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/commands/generate/api.ts')>()),
  mergedCoreSettings: () => Promise.resolve(state.core),
}));

const CORE = [
  'class_name TweenCore',
  'extends RefCounted',
  '',
  'enum TweenProperty { POSITION, ROTATION, SCALE, COLOR, OPACITY }',
  'enum Easing {',
  '\tLINEAR,',
  '\tQUAD_IN,',
  '\tQUAD_OUT,',
  '}',
  '',
].join('\n');

const HEAD = [
  '[gd_resource type="Resource" script_class="TweenDefinition" format=3]',
  '',
  '[ext_resource type="Script" path="res://core/tween_core/tween_definition.gd" id="1_def"]',
  '[ext_resource type="Script" path="res://core/tween_core/tween_step.gd" id="2_step"]',
  '[ext_resource type="Script" path="res://core/tween_core/tween_change.gd" id="3_change"]',
  '',
];

/** A preset text: `changes` are the property lines of each change sub-resource, `steps` the change ids of each step. */
function preset(changes: Record<string, string[]>, steps: string[][], resource: string[]): string {
  const out = [...HEAD];
  for (const [id, props] of Object.entries(changes)) out.push(`[sub_resource type="Resource" id="${id}"]`, 'script = ExtResource("3_change")', ...props, '');
  steps.forEach((ids, s) => {
    const list = ids.map((id) => (id === 'null' ? 'null' : `SubResource("${id}")`)).join(', ');
    out.push(`[sub_resource type="Resource" id="step_${String(s)}"]`, 'script = ExtResource("2_step")', `changes = Array[ExtResource("3_change")]([${list}])`, '');
  });
  const stepList = steps.map((_, s) => `SubResource("step_${String(s)}")`).join(', ');
  out.push('[resource]', 'script = ExtResource("1_def")', `steps = Array[ExtResource("2_step")]([${stepList}])`, ...resource, '');
  return out.join('\n');
}

beforeEach(() => {
  state.core = { 'TweenCore.maxDurationMs': 1000, 'TweenCore.maxRepeatCount': 10 };
});

describe('tween preset', () => {
  it('passes a preset that keeps the definition check items, including default values left out', async () => {
    const ok = preset(
      {
        a: ['property = 2', 'target_value = Vector4(1.2, 1.2, 0.5, 0)', 'use_start_value = true', 'start_value = Vector4(1, 1, 1, 0)', 'duration = 1000', 'easing = 2'],
        b: ['property = 3', 'target_value = Vector4(1, 0.5, 0, 1)', 'duration = 100'],
        c: ['property = 4', 'target_value = Vector4(0.5, 0, 0, 0)', 'delay = 100'],
      },
      [['a', 'b'], ['c']],
      ['repeat_count = 0'],
    );
    const sc = memContext({ 'client/core/tween_core/tween_core.gd': CORE, 'resource/tween/lobby/pop.tres': ok, 'resource/scene/lobby/main.tscn': '[gd_scene format=3]\n' });
    expect(await tweenPreset.run(sc)).toEqual([]);
    expect(await tweenPreset.run(memContext({ 'resource/scene/lobby/main.tscn': '[gd_scene format=3]\n' }))).toEqual([]);
  });

  it('fails each definition check item that does not depend on the target object', async () => {
    const bad = preset(
      {
        color: ['property = 3', 'target_value = Vector4(1.2, 1, 1, 1)'],
        opacity: ['property = 4', 'target_value = Vector4(1, 1, 0, 0)'],
        position: ['property = 0', 'target_value = Vector4(10, 0, 0, 2)', 'start_value = Vector4(0, nan, 0, 0)', 'duration = 1001', 'delay = -1', 'easing = 3'],
        member: ['property = 5'],
      },
      [['color', 'opacity'], ['position', 'member'], [], ['null']],
      ['repeat_count = 11'],
    );
    const sc = memContext({ 'client/core/tween_core/tween_core.gd': CORE, 'resource/tween/play/glow.tres': bad });
    expect(lines(await tweenPreset.run(sc))).toEqual([
      'resource/tween/play/glow.tres:10 | tween preset: change 0 of step 0 has a COLOR target_value out of 0..1',
      'resource/tween/play/glow.tres:12 | tween preset: step 0 changes one property twice',
      'resource/tween/play/glow.tres:15 | tween preset: change 1 of step 0 has a target_value whose components no target of OPACITY uses are not 0',
      'resource/tween/play/glow.tres:20 | tween preset: change 0 of step 1 has a target_value whose components no target of POSITION uses are not 0',
      'resource/tween/play/glow.tres:21 | tween preset: change 0 of step 1 has a start_value that is not 4 finite numbers',
      'resource/tween/play/glow.tres:22 | tween preset: change 0 of step 1 has duration 1001 out of 0..TweenCore.maxDurationMs',
      'resource/tween/play/glow.tres:23 | tween preset: change 0 of step 1 has delay -1 out of 0..TweenCore.maxDurationMs',
      'resource/tween/play/glow.tres:24 | tween preset: change 0 of step 1 has an easing that is not a member of Easing',
      'resource/tween/play/glow.tres:28 | tween preset: change 1 of step 1 has a property that is not a member of TweenProperty',
      'resource/tween/play/glow.tres:40 | tween preset: step 2 has no change',
      'resource/tween/play/glow.tres:44 | tween preset: change 0 of step 3 is missing',
      'resource/tween/play/glow.tres:49 | tween preset: repeat count 11 is out of 0..TweenCore.maxRepeatCount',
    ]);
  });

  it('fails an infinite repeat with cycle time 0 and reads no bound when the core settings have none', async () => {
    const zero = preset({ a: ['property = 1', 'target_value = Vector4(90, 0, 0, 0)', 'duration = 5000'], b: ['property = 2'] }, [['b']], ['repeat_count = 0']);
    const long = preset({ a: ['property = 1', 'target_value = Vector4(90, 0, 0, 0)', 'duration = 5000'] }, [['a']], ['repeat_count = 50']);
    state.core = {};
    const sc = memContext({ 'client/core/tween_core/tween_core.gd': CORE, 'resource/tween/run/spin.tres': zero, 'resource/tween/run/long.tres': long });
    expect(lines(await tweenPreset.run(sc))).toEqual(['resource/tween/run/spin.tres:24 | tween preset: the preset repeats forever with cycle time 0']);
  });

  it('fails when the TweenCore enums cannot be read', async () => {
    const sc = memContext({ 'resource/tween/run/a.tres': preset({}, [], []) });
    expect(lines(await tweenPreset.run(sc))).toEqual([
      'client/core/tween_core/tween_core.gd:1 | tween preset: the enums TweenProperty and Easing could not be read, so the 1 tween presets are not checked',
    ]);
  });
});
