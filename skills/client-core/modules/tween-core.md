# TweenCore

- purpose
- dependency
- API
- behavior
- hook
- event
- error
- settings
- data
- DEV
- test

## purpose

Handles the tween, which changes a property value of one object over time, and playback of the tween preset, which holds a tween definition. Code outside TweenCore does not use the tween feature of the engine.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `ResourceCore`, `PoolCore`, `InputBlockCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `play` | `TweenDefinition`, target object, `TweenOptions` | tween handle | invalid handle | core, content code |
| `play_preset` | tween preset resource key, resource scope, target object, `TweenOptions` | tween handle | invalid handle | core, content code |
| `play_value` | `TweenValueKind`, start value, end value, `TweenDefinition`, value receiver | tween handle | invalid handle | core, content code |
| `stop` | tween handle | none | none | core, content code |
| `skip_to_end` | tween handle | none | none | core, content code |
| `stop_target` | target object | number of tweens ended | `0` | core, content code |
| `skip_target_to_end` | target object | number of tweens ended | `0` | core, content code |
| `stop_tag` | tween tag | number of tweens ended | `0` | core, content code |
| `skip_tag_to_end` | tween tag | number of tweens ended | `0` | core, content code |
| `is_playing` | tween handle | whether it is playing | `false` | core, content code |
| `get_finite_playing_count` | none | number of playing tweens that do not repeat without end: every `play_value` tween, a `play_preset` tween waiting for loading, and a tween whose played definition has a repeat count other than 0 (the definition without steps played after a definition check failure has repeat count 1). does not allocate memory | `0` | `QACore` |
| `wait_end` | tween handle | async operation. `TweenEndReason` | `None` | core, content code |
| `copy_definition` | source `TweenDefinition`, copy `TweenDefinition` | success flag | `false` | core, content code |
| `get_preset_kind` | none | `ResourceCore` resource kind of the tween preset | invalid kind | core, content code |
| `check_definition` | `TweenDefinition`, target object | whether it passes the definition check | `false` | `ScreenEffectCore` |
| `evaluate_easing` | `Easing`, progress ratio (real number) | easing value at that progress ratio | `0` | `CameraCore` |

### type

| type | contents |
|---|---|
| `TweenDefinition` | `TweenStep` list (default empty list), repeat count (default 1). Repeat count `0` is infinite repeat |
| `TweenStep` | list of `TweenChange` that start at the same time (default empty list) |
| `TweenChange` | `TweenProperty` (default `Position`), target value (default 4-component value of 0), whether to use the start value (default `false`), start value (default 4-component value of 0), duration (ms, default 0), delay (ms, default 0), `Easing` (default `Linear`) |
| `TweenOptions` | `TimeBasis` (default `RealTime`), tween tag (default none), whether to block input (default `false`), `InputBlockCore` `BlockPassList` of the input block (default none), completion callback (default none) |
| `TweenProperty` | `Position`, `Rotation`, `Scale`, `Color`, `Opacity` |
| `TweenValueKind` | `Float`, `Vector2`, `Color` |
| `TweenEndReason` | `None`, `Completed`, `Skipped`, `Stopped`, `TargetDestroyed` |
| `Easing` | `Linear`, `QuadIn`, `QuadOut`, `QuadInOut`, `CubicIn`, `CubicOut`, `CubicInOut`, `SineIn`, `SineOut`, `SineInOut`, `BackIn`, `BackOut`, `BackInOut`, `ElasticOut`, `BounceOut` |
| `TimeBasis` | `RealTime` (progresses by the real elapsed time of `TimeCore`), `GameTime` (progresses by the game time of `TimeCore`) |

- Values are received as 4-component real-number vectors, and only the components the target property uses are used. `Position` and `Scale` are x, y in 2D and x, y, z in 3D. `Rotation` is in degrees, x in 2D and x, y, z (Euler) in 3D. `Color` is r, g, b, a and each component is at least 0 and at most 1. `Opacity` is x and is the same value as a of `Color`
- `Position` is in coordinates relative to the parent
- arranged element: a UI element whose parent sets the place and size of its children. A change decides whether its target is an arranged element when it starts and keeps that until it ends, even when the target moves to another parent. For an arranged element, `Position`, `Rotation` and `Scale` change only how it is drawn and where it takes input, not the place its parent gives it: `Position` is the offset from that place, `Rotation` and `Scale` turn and scale it about the same pivot as a UI element that is not arranged, and the values stay when the parent arranges its children again and after the change ends. The engine mapping is in the engine-specific implementation rules
- The `Easing` formulas are the Robert Penner easing formulas
- A value receiver is an object with one function that receives the frame value

## behavior

### progress

- Steps run one at a time in list order. A step ends when all changes in it end, and then the next step starts
- A change does not change the value during its delay. A change that does not use the start value starts from the property value at the end of the delay. When delay + duration has passed, the property value is the target value
- A cycle is one run of the step list from start to end. The cycle time is the sum over all steps of the largest delay + duration among the changes of that step
- A tween progresses by the chosen `TimeBasis`. A game time tween does not change the value during a game time pause
- A tween reads the values of the `TweenDefinition` at playback start. Changing the definition after playback start does not change that tween
- When a new tween starts playback while a tween that changes the same property of the same target is playing, TweenCore ends the earlier tween with `Stopped` and then starts the new tween. `Color` and `Opacity` count as the same property
- A `play_preset` tween waiting for loading ends with `Stopped`, regardless of property, when a later `play` or `play_preset` is requested on the same target. So a tween that starts after its loading finishes ends only tweens requested before it
- When the frame value of `Color` or `Opacity` is less than 0 or more than 1 because of easing, it is clamped to 0 or 1

### definition check

At playback start, when not all of the items below hold, leaves an error log and plays with a definition that has no steps. A tween with no steps does not change the value and ends with `Completed`.

- Every step has one or more changes
- The `Easing` of every change is a member of `Easing`
- Every duration and delay is at least 0 and at most `TweenCore.maxDurationMs`
- The repeat count is at least 0 and at most `TweenCore.maxRepeatCount`
- The target value and start value of the used components are finite numbers. The target value and start value of `Color` and `Opacity` are at least 0 and at most 1
- The target value and start value of the unused components (components that `### type` does not define for that property and the dimension of the target) are 0. e.g. y, z, w of `Opacity`, z, w of 2D `Position` and `Scale`
- The two items above also check the start value of a change that does not use the start value
- When the repeat is infinite, the cycle time is more than 0
- No step has two or more changes that change the same property
- The target object has the property of every change

`check_definition` checks the items above with the received definition and target object without playback, and returns `true` when all hold, otherwise `false`. It leaves no log for a definition that violates an item.

### tween preset

- A tween preset is a resource of resource type `tween` that holds one `TweenDefinition`
- TweenCore registers the tween preset kind with `ResourceCore.register_kind` in `init`. The fallback is a definition with no steps. A caller that loads a tween preset directly loads it from `ResourceCore` with the kind from `get_preset_kind`
- For values not known before the run (the position of another object, the screen size), the caller puts them into a copy made with `copy_definition` and calls `play`. The caller finds a change by step number (from 0) and property. It does not change other presentation values
- The definition of a loaded tween preset is not changed
- `play_preset` loads the tween preset from `ResourceCore` with the received resource scope, and starts playback when loading finishes. A loaded preset starts inside the operation, and for a preset not loaded, loading starts after the operation returns and before that frame ends. While waiting for loading, it is also playing
- A tween that ended before loading finished does not start playback even when loading finishes
- When the tween preset cannot be loaded, plays with the fallback, a definition with no steps
- A presentation that changes several objects together is made as an engine animation resource, not a tween, and content code plays it

### copy_definition

- Fills the copy with the values of the source. Reuses the step and change objects the copy has and creates more when they are not enough. After copying, the number of steps and the number of changes per step equal those of the source
- Changing the copy does not change the source

### evaluate_easing

- Returns the value of the formula of that `Easing` applied to the progress ratio. It is the same formula as the frame value of a tween. Progress ratio 0 gives 0, and 1 gives 1
- A progress ratio less than 0 is clamped to 0, and one more than 1 to 1, before applying

### handle and end

- A tween handle points to one `play`, `play_preset` or `play_value` request. An invalid handle points to no request. The handle of an ended tween points to no request. Handle values are not reused from `init` to `release`
- End happens once per tween. The end handling time is as below
  - When an end condition arises inside a playback operation for the tween that operation started (a definition with no steps, a definition whose cycle time is 0), the end handling of that tween runs after the operation returns and before the frame that called the operation ends
  - For any other end, the operation or the TweenCore frame handling that caused the end finishes the end handling inside it and then returns. e.g. `stop`, `skip_to_end`, per-target and per-tag operations, pool return, `Completed` from progress
  - When a new request ends an earlier tween (a new playback of the same property, a new request on the same target while waiting for loading), the new tween starts after the end handling of the earlier tween finishes

| `TweenEndReason` | ends when | property value |
|---|---|---|
| `Completed` | when the last step of the last cycle ends | target value |
| `Skipped` | `skip_to_end`, `skip_target_to_end`, `skip_tag_to_end` | end state |
| `Stopped` | `stop`, `stop_target`, `stop_tag`, a new playback of the same property, a new request on the same target while waiting for loading, pool return | the value at that time |
| `TargetDestroyed` | before the end of the frame after the frame in which the target object or the value receiver of `play_value` is destroyed | not changed |

- end state: the state with the target values of all changes applied in step order. It does not depend on the repeat count. A `play_preset` tween that ended before loading does not apply the end state
- end processing order: apply the end state, release the input block, invalidate the handle, call the completion callback, complete `wait_end`
- `stop` and `skip_to_end` of a handle that points to no request do nothing, without a log
- An infinitely repeating tween does not end with `Completed`

### input block

- A playback with input block on sets a block of reason tag `tween` with `InputBlockCore` from the operation call until the tween ends. The pass list is `BlockPassList` of `TweenOptions`, and when it is none, the block has no pass list
- When the definition repeats infinitely at playback start, leaves an error log and releases the block. The tween keeps progressing

### pool return

- TweenCore registers a return cleaner with `PoolCore` in `init`. It ends all tweens whose target is the returned object or one of its descendant objects with `Stopped`

### play_value

- Changes a value that is not a property (a displayed number, a progress bar ratio). The duration and easing are those of the first change of the first step of the definition, and other values of the definition are not used
- Each frame, calls the value receiver with the value of that frame. The end state is the state in which the receiver was called with the end value. `TimeBasis` is `RealTime`
- Per-tag operations, per-target operations, pool return, input block and the completion callback do not exist for a value tween
- When the value receiver is destroyed, the receiver is not called after that and the tween ends with `TargetDestroyed`. No log is left

### release

- Ends all playing tweens. Property values stay at their values at that time. Does not call completion callbacks, releases input blocks, and `wait_end` returns `None`
- A tween that was waiting for loading does not start even when loading finishes

## hook

none

## event

| event | when | payload |
|---|---|---|
| `TweenStartedEvent` | when a tween starts playback. For `play` and `play_value` inside the operation, for `play_preset` when loading finishes and playback starts. `QACore` counts it as feedback | none |

- Not emitted for a `play_preset` tween that ended before starting playback or for a request that returned an invalid handle

## error

| condition | failure value | log |
|---|---|---|
| the `TweenOptions` `TimeBasis` of `play` or `play_preset` is not a member | invalid handle. No callback and no input block | error |
| the `Easing` of `evaluate_easing` is not a member | `0` | error |
| the target object of `play` or `play_preset` is missing or destroyed | invalid handle. No callback and no input block | error |
| definition check failure | plays with a definition with no steps | error |
| the receiver or definition of `play_value` is missing, the `TweenValueKind` is not a member, there is no first change, the duration of the first change is out of range, the `Easing` of the first change is not a member, or the start value or end value is not a finite number | invalid handle | error |
| the object of `stop_target` or `skip_target_to_end` is missing or destroyed | `0` | error |
| the tag of `stop_tag` or `skip_tag_to_end` is an empty string | `0` | error |
| the handle of `wait_end` is not playing | `None` without waiting | none |
| the source and copy of `copy_definition` are the same object, or the copy is missing | `false`. Does not change the copy | error |
| the source of `copy_definition` is missing | `false`. Makes the copy a definition with no steps | error |
| the definition of `check_definition` is missing, or the target object is missing or destroyed | `false` | error |
| the progress ratio of `evaluate_easing` is not a finite number | `0` | error |
| infinitely repeating playback with input block on | releases the block and continues playback | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `TweenCore.maxDurationMs` | integer | core | content | maximum of the duration and the delay of one change |
| `TweenCore.maxRepeatCount` | integer | core | content | maximum of the repeat count |

## data

none

## DEV

none

## test

- `get_finite_playing_count` counts a playing tween of repeat count 1, a playing `play_value` tween whose definition has repeat count 0, a `play_preset` tween waiting for loading, and the tween of a definition that failed the definition check, does not count a tween of infinite repeat, and goes down by one in the frame a counted tween ends
- A `Position` change to (10, 0) of a UI element in a parent that lines up its children horizontally ends with the element drawn 10 to the right of the place the parent gives it. After the parent arranges its children again, it is still drawn there and the place the parent gives it is unchanged. A `Scale` change of that element to (1.2, 1.2) also stays after the parent arranges its children again
- In a definition with two changes of duration 100ms and 200ms in step 1 and one change in step 2, the two values of step 1 start changing in the same frame, the value of step 2 does not change before 200ms after the start, and after completion the three values are the target values
- A change that does not use the start value and has a delay starts from the property value changed during the delay
- A tween with repeat count 3 ends with `Completed` after three times the cycle time has passed, and the callback is not called before that. A tween with repeat count 0 is still playing after ten times the cycle time has passed
- For each definition check item, a definition that violates only that item does not change the value, with one error log, and the tween ends with `Completed` after the operation returns and before the frame that called the operation ends
- `play` of one change with duration and delay 0 is playing when the operation returns and the completion callback has not been called, and before that frame ends the property value is the target value and the tween ends with `Completed`
- For each of `Completed`, `Skipped`, `Stopped` and `TargetDestroyed`, the callback is called once and `wait_end` receives the same reason
- `stop` leaves the value at that time, and `skip_to_end` leaves the end state. When a tween that changes `Color` to opaque red in step 1 and `Opacity` to 0 in step 2 is skipped during step 1, the color is red and the opacity is 0
- When a new tween is played with `play` on the same property of the same target, the earlier tween ends with `Stopped`, and the completion callback of the earlier tween is called once, before the `TweenStartedEvent` of the new tween and before the new `play` returns
- When `stop`, `skip_to_end`, `stop_target` or `skip_tag_to_end` returns, the completion callback of the ended tween has already been called once
- `stop` and `skip_to_end` of an ended handle and of an invalid handle do not change other tweens, `is_playing` is `false`, and `wait_end` is `None`. The handle values of 1000 consecutive playbacks all differ
- While two tweens of object A and one tween of B are playing, `stop_target(A)` returns 2 and the tween of B is playing. The same holds for tags
- When the target object is destroyed, the tween ends with `TargetDestroyed` before the next frame ends
- When the value receiver of a playing `play_value` is destroyed, the receiver is not called again, `wait_end` receives `TargetDestroyed` before the next frame ends, and there is no log
- During a game time pause, the value of a game time tween stays the same and the value of a real elapsed time tween changes
- A definition with `Opacity` target value 1.5 leaves an error log, does not change the value and ends with `Completed`. A definition with `Opacity` target value (1, 1, 1, 0) and a definition with `Position` target value (10, 20, 5, 0) for a 2D target also leave an error log, do not change the value and end with `Completed`. A definition whose `Opacity` change that does not use the start value has start value (0, 0, 0, 1) or 1.5 also leaves an error log, does not change the value and ends with `Completed`. For `Opacity` tweens with `BackOut` and `ElasticOut`, every frame value is at least 0 and at most 1
- While a tween with input block on is playing, there is a block of reason tag `tween`, and after each of the four end reasons there is none. A `play_preset` waiting for loading also has the block
- While an input block tween with action A in `BlockPassList` is playing, `InputBlockCore.pass_action` of A is `true`, and while an input block tween whose `BlockPassList` is none is playing, it is `false`
- When a `play_preset` waiting for loading is ended with `stop`, the value does not change even after loading finishes. `play_preset` of a resource key that does not exist does not change the value and ends with `Completed`
- When `play` B of another property is requested on the same target after `play_preset` A that is waiting for loading, A ends with `Stopped` without changing the value, and B is playing even after the loading of A finishes. A request on another target does not end A
- Changing the copy of `copy_definition` leaves the source unchanged, and both a copy with more steps than the source and a copy with fewer steps have the same structure as the source after copying
- When an object whose tween is playing is returned to `PoolCore`, that tween ends with `Stopped`
- After `release`, callbacks are not called, `wait_end` is `None`, and there is no block of reason tag `tween`. After `init` again, a playback ends with `Completed`
- `TweenStartedEvent` is emitted once for each `play`, each `play_value` and each `play_preset` whose loading finished, and not for a `play_preset` ended with `stop` before loading or for a request with an invalid handle
- A `tween/<name>` resource loaded with the kind from `get_preset_kind` is a `TweenDefinition`, and a key that does not exist gives a definition with no steps
- For each `TweenValueKind`, `play_value` calls the receiver with values between the start value and end value, applies the end value after the duration and ends with `Completed`
- For each definition check item, `check_definition` of a definition that violates only that item is `false` without a log, a passing definition gives `true`, and in both cases the property values of the target object stay the same
- For every `Easing`, `evaluate_easing` returns 0 for progress ratio 0 and 1 for 1. `QuadIn` returns 0.25 for 0.5 and 1 for 1.5. A NaN progress ratio gives an error log and `0`
