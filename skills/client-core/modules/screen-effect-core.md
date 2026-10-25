# ScreenEffectCore

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

Handles the color overlay that covers the whole visible game area with a solid color, and the playback of fades, flashes and tween presets on it. Does not handle camera shake, blur, distortion or screen-reading shaders.

## dependency

`LogCore`, `EventCore`, `TweenCore`, `ResolutionCore`, `UICore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `fade` | `ScreenEffectChannel`, owner object, color, start opacity, target opacity, duration (ms), `TweenCore` `TimeBasis` (optional, `RealTime` when omitted) | effect handle | effect handle settled as `Failed` | caller per channel |
| `flash` | `ScreenEffectChannel`, owner object, color, maximum opacity, rise duration, hold duration, fall duration (ms), `TweenCore` `TimeBasis` (optional, `RealTime` when omitted) | effect handle | effect handle settled as `Failed` | caller per channel |
| `play_preset` | `ScreenEffectChannel`, owner object, loaded `TweenDefinition`, `TweenCore` `TimeBasis` (optional, `RealTime` when omitted) | effect handle | effect handle settled as `Failed` | caller per channel |
| `wait_result` | effect handle | async operation. `ScreenEffectResult` | `Failed` | code that has the effect handle |
| `skip_to_end` | effect handle | none | none | code that has the effect handle |
| `clear_handle` | effect handle | none | none | code that has the effect handle |
| `clear_owner` | owner object | none | none | core, content code |
| `set_flash_opacity_limit` | flash opacity limit (at least 0, at most 1) | none | none | `AccessibilityCore` |

### type

| type | contents |
|---|---|
| `ScreenEffectChannel` | `World`, `Cutscene`, `Transition` |
| `ScreenEffectResult` | `Completed`, `Cancelled`, `Failed` |

- A color is an opaque color (r, g, b), and opacity is received separately. Color components and opacity are finite numbers of at least 0 and at most 1
- The caller reads color, opacity and duration from data and passes them, or passes them through a tween preset

## behavior

### channel and overlay

| channel | caller | UI layer drawn on |
|---|---|---|
| `World` | content code, core | `WorldEffect` of `UICore` |
| `Cutscene` | `CutsceneCore` | `CutsceneEffect` of `UICore` |
| `Transition` | loading screen root of `SceneCore` | `TransitionEffect` of `UICore` |

- Code other than a channel's caller does not request that channel
- In `init`, ScreenEffectCore creates one overlay per channel and places it in the UI layer obtained with `UICore.get_layer`. An overlay is a solid-color rectangle created by code
- The position and size of an overlay are set equal to the visible game area at `init` and when `ResolutionCore.GameAreaChangedEvent` is received
- An overlay receives no pointer input. The caller sets blocks with `InputBlockCore`
- An overlay without an effect is black, opacity 0, hidden. When an overlay is cleared by `init`, `clear_handle`, `clear_owner` or `Failed`, it is set to these values
- Core and content code do not create separate screen covers for the same purpose. Panel dim, the loading screen and background images are not overlays

### effect handle

- An effect handle holds the result and the owner of one request. The owner is an object that the requester passes, and it ties the effect's lifetime to that object
- Each channel has one current handle. A new request that passes the input check ends the current handle of the same channel with `Cancelled` and replaces it. A request that fails the input check does not replace the current handle
- A replaced handle cannot control the overlay. `skip_to_end` and `clear_handle` on that handle do not change the state of the new handle
- The result of a handle is set only once. `wait_result` after it is set returns that result without waiting

### playback

- A fade sets the overlay to the received color and changes the opacity from the start to the target linearly over the duration
- flash opacity limit: 1 at `init`, and changed only by `set_flash_opacity_limit`. `flash` uses the smaller of the received maximum opacity and that limit as the maximum opacity. It applies from the `flash` started after the change. It does not apply to `fade` and `play_preset`. `release` resets it to 1
- A flash raises opacity from 0 to the maximum opacity over the rise duration, holds it for the hold duration, and lowers it to 0 over the fall duration
- The definition of `play_preset` must be a finite-repeat definition that changes only the overlay's `Color` and `Opacity`. A definition that does not change `Color` plays with the overlay's current color
- The input check of `play_preset` includes `TweenCore.check_definition` (the definition, that channel's overlay)
- A request that passes the input check sends `ScreenEffectStartedEvent` when playback starts
- Playback runs through `TweenCore` with the `TimeBasis` of the request. With `RealTime`, game time pause and time scale do not change the end time. With `GameTime`, playback holds during a game time pause and advances with game time, so in step mode it advances only with the steps
- A request whose durations are all 0 applies the end value to the overlay within the operation and ends with `Completed`
- `skip_to_end` applies the end value and ends with `Completed`
- A finished fade or preset keeps the end value. A finished flash is at opacity 0
- When `TweenCore` cannot start playback, the new handle ends with `Failed`, the replaced handle ends with `Cancelled`, and that channel goes to the state without an effect

### cleanup

- `clear_handle` clears the overlay when that handle currently has the overlay. When the handle is in progress, it ends with `Cancelled`
- `clear_owner` does `clear_handle` on that owner's handles of all channels
- When the owner object is destroyed, cleanup happens as with `clear_owner`. The overlay of a finished handle is also cleared
- `release` clears all channels, ends the handles in progress with `Cancelled`, and then destroys the overlays

## hook

none

## event

| event | when | payload |
|---|---|---|
| `ScreenEffectStartedEvent` | when a `fade`, `flash` or `play_preset` that passed the input check starts playback. `QACore` counts it as feedback | `channel`: `ScreenEffectChannel` |

## error

| condition | failure value | log |
|---|---|---|
| a `ScreenEffectChannel` or a `TimeBasis` that is not a member | effect handle settled as `Failed`. The effect in progress on every channel stays as it is, and there is no `ScreenEffectStartedEvent` | error |
| owner object missing or destroyed | `Failed` handle. Current handle kept | error |
| color component or opacity is not a finite number of at least 0 and at most 1 | `Failed` handle. Current handle kept | error |
| duration less than 0 or more than `TweenCore.maxDurationMs` | `Failed` handle. Current handle kept | error |
| definition of `play_preset` changes a property other than `Color`, `Opacity`, repeats infinitely, or `TweenCore.check_definition` is `false` | `Failed` handle. Current handle kept | error |
| value of `set_flash_opacity_limit` is not a finite number of at least 0 and at most 1 | limit unchanged | error |
| `skip_to_end`, `clear_handle` with a none handle, `clear_owner` with a none owner | none | none |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `TweenCore.maxDurationMs` | integer | core | content | largest value of the `fade` and `flash` durations |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_overlay_state` | `ScreenEffectChannel` | rectangle, color, opacity and whether displayed of that channel's overlay | empty rectangle, black, opacity 0, `false` | core test |

## test

- A new request on the same channel ends `wait_result` of the earlier handle with `Cancelled`, and `clear_handle` of the earlier handle does not delete the new effect
- In each of duration 0, normal completion, `skip_to_end`, replacement, owner destruction and `release`, `wait_result` is settled once, and `wait_result` after it is settled returns the same result without waiting
- The overlay of a fade that kept its end value is at opacity 0 and hidden after the owner is destroyed
- Requests with an out-of-range color, opacity or duration, and preset requests with infinite repeat, that change `Position`, or that have a step without a change, are `Failed`; the effect in progress stays as it is and there is no `ScreenEffectStartedEvent`. For each request that passes, the event of that channel comes once
- Even with game time pause and time scale 2000, a fade ends after its duration in real elapsed time
- With `GameTime`, a fade keeps its opacity over 1000 ms of real elapsed time after `TimeCore.set_paused`(true), and after `set_paused`(false) it ends after the rest of its duration in game time. A flash with `GameTime` in step mode changes opacity only in the frames of a step
- When the visible game area changes, the rectangles of the three channel overlays equal the new visible game area
- The three overlays are in the `WorldEffect`, `CutsceneEffect` and `TransitionEffect` layers obtained with `UICore.get_layer`
- While an overlay is visible, UI elements under it receive pointer input
- Playing a preset that changes only `Opacity` on a channel without an effect makes the overlay color black. For a preset whose durations are all 0, when the operation returns, the end value is on the overlay and the result is `Completed`
- After `release` there is no overlay, and after `init` again a fade ends with `Completed`
- After `set_flash_opacity_limit`(0.3), during a `flash` with maximum opacity 1 the overlay opacity does not exceed 0.3 in any frame, and a `fade` reaches the target opacity 1
