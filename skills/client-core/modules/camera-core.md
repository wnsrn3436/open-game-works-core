# CameraCore

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

Owns following, camera shake, zoom, screen bounds, and the conversion between screen coordinates and world coordinates for the game camera that shows the world of a scene. The UI layer is not affected by the game camera.

## dependency

`LogCore`, `UtilCore`, `EventCore`, `TimeCore`, `ResourceCore`, `ResolutionCore`, `TweenCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `attach_camera` | engine camera object | success flag | `false` | content code |
| `detach_camera` | none | none | none | content code |
| `has_camera` | none | whether a camera is attached | `false` | core, content code |
| `is_3d_camera` | none | whether the attached camera is a 3D camera | `false` | core, content code |
| `follow` | target object, `FollowOptions` | success flag | `false` | content code |
| `stop_follow` | none | none | none | content code |
| `move_to` | world position, duration(ms), `Easing`, `TimeBasis` | async operation. Result `CameraMoveResult` | `Failed` | content code |
| `move_by_preset` | world position, tween preset resource key, resource scope | async operation. Result `CameraMoveResult` | `Failed` | content code, `CutsceneCore` |
| `stop_move` | none | none | none | content code, `CutsceneCore` |
| `snap_to` | world position | success flag | `false` | content code, `CutsceneCore` |
| `zoom_to` | zoom factor, duration(ms), `Easing`, `TimeBasis` | async operation. Result `CameraMoveResult` | `Failed` | content code |
| `get_zoom` | none | zoom factor | `1` | core, content code |
| `set_bounds` | world bounds(an x, y rectangle in 2D; in 3D, a rectangle over the two horizontal axes on the height-0 horizontal plane) | success flag | `false` | content code |
| `clear_bounds` | none | none | none | content code |
| `shake` | trauma amount | none | none | content code |
| `stop_shake` | none | none | none | content code |
| `set_shake_scale` | shake scale permille(at least 0, at most 1000) | none | none | `AccessibilityCore` |
| `get_view_center` | none | base position after bounds fitting (shake offset excluded). For a 2D camera, the world position at the screen center; for a 3D camera, the camera position | origin | core, content code |
| `screen_to_world` | position in game coordinates of `ResolutionCore` | world position | origin | core, content code |
| `world_to_screen` | world position | position in game coordinates of `ResolutionCore` | origin | core, content code |

### type

| type | contents |
|---|---|
| `FollowOptions` | offset(world units), smooth time(ms), dead zone size(world units. A length per axis) |
| `CameraMoveResult` | `Completed`, `Cancelled`, `Failed` |
| `Easing` | `Easing` of `TweenCore` |
| `TimeBasis` | `TimeBasis` of `TweenCore` |

- A world position and an offset are x, y for a 2D camera, and the values of the three axes of engine coordinates for a 3D camera. The up axis of a 3D camera is the world axis pointing up, and the other two axes are the horizontal axes. The height is the up axis value, and the height-0 horizontal plane is the plane where the height is 0. The engine-specific implementation rules decide which axis of engine coordinates is the up axis
- The zoom factor is a real number. At factor z, the length of each axis of the world range visible on screen is 1/z of that at factor 1. The engine-specific implementation rules decide how a 3D camera converts the factor to a field of view or an orthographic size
- The caller reads the values of `FollowOptions` from data and passes them
- `screen_to_world` of a 3D camera is the intersection of the camera ray through that screen point with the height-0 horizontal plane
- `world_to_screen` of a 3D camera is the screen point onto which the camera projects the world position. When the depth of the world position along the camera view direction is less than the near plane distance (on the camera side of the near plane, or behind the camera), it leaves an error log and returns the origin
- view range: for a 2D camera, the world rectangle visible on screen. For a 3D camera, the smallest rectangle over the two horizontal axes that holds all four points made by projecting the four corners of the visible game area of `ResolutionCore` onto the height-0 horizontal plane in the same way as `screen_to_world`

## behavior

### attach

- There is one game camera at a time. `attach_camera` detaches the previous camera the same way as `detach_camera`, then attaches the new camera
- It sets the position of the attached camera as the base position and the zoom factor to 1
- `detach_camera` deletes all of follow, `move_to`, `zoom_to`, shake and bounds. A `move_to` and a `zoom_to` in progress end with `Cancelled`
- When the attached camera object is destroyed, it cleans up the same way as `detach_camera`. It leaves no log
- Operations while no camera is attached follow the error table. Exception: `set_shake_scale` changes the shake scale without a log even while no camera is attached

### position calculation order

Each frame, it sets the camera position in the order below.

1. Set the base position: when a `move_to` is in progress, its value; when following, the follow value; when neither, unchanged
2. When there are bounds, fit the base position inside the bounds
3. Apply to the camera object the value with the shake offset and the shake rotation added

- Shake is added after bounds fitting. During a shake, the screen can show up to `CameraCore.shakeMaxOffset` outside the bounds
- `get_view_center` is the value of step 2. For a 3D camera, the point on the height-0 horizontal plane that the screen center shows is `screen_to_world`(center of the visible game area)

### follow

- The goal position is the target object position + offset
- dead zone: an axis-aligned box centered on the base position with the dead zone size as its length on each axis. When the goal position is inside the box, the base position does not change. When it is outside, for each axis on which it is outside, the position that puts the goal position on the box edge becomes the new goal. An axis of length 0 has no dead zone on that axis
- smoothing: each frame, the base position reduces its distance to the goal by the ratio `1 - e^(-dt / smooth time)`. dt is the game time elapsed in that frame. With smooth time 0, it goes to the goal position at once
- Follow progresses in game time. During a game time pause, the base position does not change
- A new `follow` replaces the previous follow. A `move_to` in progress ends with `Cancelled`
- When the target object is destroyed, it ends the follow and keeps the base position as it is. It leaves no log

### move_to, snap_to, zoom_to

- `move_to` moves from the current base position to the received position over the duration with `Easing`. It ends the follow when it starts. Duration 0 applies the end position inside the operation and ends with `Completed`
- `move_by_preset` loads the tween preset from `ResourceCore` with the kind of `TweenCore.get_preset_kind` and the received scope, and does `move_to` with the duration and easing of the first change of the first step of the definition. `TimeBasis` is `GameTime`. It does not use other values of the definition
- `move_by_preset` counts as a `move_to` in progress also while it waits for loading. When `stop_move`, `snap_to`, a new `move_to`, `follow` or `detach_camera` ends it with `Cancelled` in that time, it does not move the camera even when loading ends
- `stop_move` ends the `move_to` in progress with `Cancelled` and keeps the base position at its value at that time. It does not change the follow. When no `move_to` is in progress, it does nothing
- `snap_to` ends the follow and the `move_to` in progress and changes the base position at once. The ended `move_to` is `Cancelled`
- `zoom_to` changes the zoom factor from the current factor to the received factor over the duration with `Easing`. It clamps the received factor to at least `CameraCore.minZoom` and at most `CameraCore.maxZoom`. When a `zoom_to` is in progress, it ends that with `Cancelled` and starts from the current factor. Duration 0 applies the end factor inside the operation and ends with `Completed`
- A new `move_to` ends the `move_to` in progress with `Cancelled` and starts from the current base position
- A `move_to` and a `zoom_to` with a duration more than 0 progress by the elapsed time of the received `TimeBasis`. Each frame, with r the value that `TweenCore.evaluate_easing`(`Easing`, progress rate) makes from the progress rate (elapsed time since the start ÷ duration; 1 when it is more than 1), it sets start value + (end value − start value) × r. In the frame in which the progress rate becomes 1, it sets the end value and ends with `Completed`
- When the zoom changes, bounds fitting is done again with the changed view range

### screen bounds

- When there are bounds, it fits the base position so that the view range is inside the bounds. A 3D camera moves only the two horizontal axis values of the base position
- For a 3D camera, when one of the four corners has no intersection with the height-0 horizontal plane, it does no bounds fitting in that frame
- When the view range is longer than the bounds on an axis, it puts that axis at the center of the bounds
- When `ResolutionCore.GameAreaChangedEvent` occurs, the bounds fitting of the next frame uses the changed view range

### shake

- The trauma holds a value of at least 0 and at most 1. `shake` adds the received amount to trauma, clamps it to 1, then emits `CameraShakeStartedEvent`
- Each frame, it reduces trauma by `CameraCore.shakeDecayPerSecond` × elapsed seconds and stops at 0
- The shake intensity is trauma². Each offset axis is `CameraCore.shakeMaxOffset` × intensity × noise, and the 2D rotation is `CameraCore.shakeMaxRotationDeg` × intensity × noise. A 3D camera adds no rotation
- The noise holds a value of at least -1 and at most 1 made with the random of `UtilCore`; per axis it draws the next value at the frequency of `CameraCore.shakeFrequencyHz` and interpolates linearly between values
- Shake progresses in real elapsed time. It decreases even during a game time pause
- `stop_shake` sets trauma to 0 and removes the offset and rotation at once
- shake scale: 1000 at `init`, changed only by `set_shake_scale`. The applied offset and rotation are the values above × shake scale ÷ 1000. At 0 there is no shake offset or rotation, and trauma and `CameraShakeStartedEvent` stay as they are. Attaching and detaching a camera leaves the shake scale as it is, and `release` returns it to 1000

### release

- Cleans up the same way as `detach_camera` and discards the camera reference

## hook

none

## event

| event | when | payload |
|---|---|---|
| `CameraShakeStartedEvent` | After `shake` adds trauma. `QACore` counts it as feedback | none |

## error

| condition | failure value | log |
|---|---|---|
| the object of `attach_camera` is missing, destroyed or not an engine camera | `false`. Does not change the attached camera | error |
| `follow`, `move_to`, `move_by_preset`, `snap_to`, `zoom_to`, `get_zoom`, `set_bounds`, `shake`, `get_view_center`, `screen_to_world`, `world_to_screen` while no camera is attached | each failure value. `move_by_preset` does not load the tween preset | error |
| `has_camera`, `is_3d_camera`, `detach_camera`, `stop_follow`, `stop_move`, `stop_shake`, `clear_bounds` while no camera is attached | `false` for `has_camera` and `is_3d_camera`, none for the rest | none |
| the target of `follow` is missing or destroyed, smooth time is negative, any axis of the dead zone size is negative | `false`. Does not change the previous follow | error |
| the duration of `move_to`, `zoom_to` is less than 0 or more than `TweenCore.maxDurationMs` | `Failed` | error |
| the factor of `zoom_to` is 0 or less | `Failed` | error |
| the tween preset of `move_by_preset` cannot be loaded, there is no first change | `Failed` | error |
| the bounds size of `set_bounds` is 0 or less on any axis | `false`. Does not change the previous bounds | error |
| the amount of `shake` is 0 or less | none. Does not change trauma | error |
| the value of `set_shake_scale` is not at least 0 and at most 1000 | shake scale unchanged | error |
| in `screen_to_world` of a 3D camera, the ray has no intersection with the horizontal plane | origin | error |
| in `world_to_screen` of a 3D camera, the depth of the world position along the view direction is less than the near plane distance | origin | error |
| in bounds fitting of a 3D camera, a corner has no intersection with the horizontal plane | does no bounds fitting in that frame | error, the first time while the camera is attached |
| a real number input is NaN or infinity | failure value of the operation above | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `CameraCore.minZoom` | number | core | content | minimum zoom factor. More than 0 |
| `CameraCore.maxZoom` | number | core | content | maximum zoom factor |
| `CameraCore.shakeMaxOffset` | number | core | content | maximum offset per axis at trauma 1(world units) |
| `CameraCore.shakeMaxRotationDeg` | number | core | content | maximum rotation of a 2D camera at trauma 1(degree) |
| `CameraCore.shakeFrequencyHz` | number | core | content | times per second that the noise draws the next value |
| `CameraCore.shakeDecayPerSecond` | number | core | content | trauma amount reduced per second |
| `TweenCore.maxDurationMs` | integer | core | content | maximum duration of `move_to`, `zoom_to` |

settings constraint

| left | factor | right |
|---|---|---|
| `CameraCore.minZoom` | 1 | `CameraCore.maxZoom` |

## data

none

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_shake_seed` | seed | none. Sets the random seed of the shake noise. The same seed and the same input give the same offset | core test |

## test

- With a 2D camera attached, `is_3d_camera` is `false`; with a 3D camera attached, `true`; while no camera is attached, `false` without a log
- Attaching a new camera after `attach_camera` deletes the follow, bounds and shake of the previous camera, and the `move_to` in progress ends with `Cancelled`
- Destroying the attached camera object leaves no attached camera, without a log, and a `shake` after that leaves one error log
- While no camera is attached, `has_camera` is `false` without a log; after `attach_camera` it is `true`, and after the attached object is destroyed it is `false`
- While no camera is attached, `move_by_preset` is `Failed` and `get_zoom` is 1, with one error log each. `set_shake_scale`(500) in that time leaves no log, and on a camera attached after that, the offset of the same seed and the same `shake` is half that at 1000
- A follow with smooth time 0 reaches the goal position in the same frame, and for a follow with smooth time T, the remaining distance after game time T is e^-1 of the first distance (tolerance 1%)
- When the target moves inside the dead zone, the base position stays as it is; when it goes outside, the camera follows so that the target is on the dead zone edge
- During a game time pause, the base position stays as it is even when the follow target moves
- Destroying the follow target keeps the base position at its value just before the destruction, with no log
- A `move_to` with duration 0 applies the end position inside the operation and is `Completed`. Calling a new `move_to`, `snap_to` or `stop_move` while one is in progress makes the previous one `Cancelled`. After `stop_move`, the base position stays at its value at the time of the call
- `move_by_preset` ends with `Completed` at the received position after the duration of the first change of the preset
- For a `move_to` with `TimeBasis` `GameTime`, the base position stays as it is during a game time pause. For a `QuadIn` `move_to`, when half the duration has passed, the base position is at 1/4 of the distance from start to end (tolerance 0.01 world units)
- Calling `stop_move` or `snap_to` during a `move_by_preset` that waits for loading gives `Cancelled`, and even after loading ends, the base position is the value that `stop_move` or `snap_to` set
- When the factor of `zoom_to` is out of range, it stops at `CameraCore.minZoom` or `CameraCore.maxZoom`. At factor 2, the length of each axis of the view range is half that at factor 1
- A `zoom_to` with duration 0 applies the end factor inside the operation and is `Completed`. Calling a new `zoom_to` while one is in progress makes the previous one `Cancelled`, and the new one starts from the factor at that time
- With bounds, for any follow goal the view range based on `get_view_center` is inside the bounds, and an axis on which the view range is longer than the bounds is at the center of the bounds
- For a 3D perspective camera tilted down with bounds, for any follow goal and zoom, the `screen_to_world` points of the four corners of the visible game area are inside the range of the two horizontal axes of the bounds (tolerance 0.01 world units) and the height of the base position stays as it is. A camera looking above the horizon has no bounds fitting and one error log
- In the frame after `GameAreaChangedEvent`, bounds fitting uses the changed view range
- For both a 2D camera and a 3D camera, `get_view_center` is the base position after bounds fitting and does not add the shake offset even during a shake. For a 3D camera it equals the camera position
- Two `shake(0.5)` calls emit `CameraShakeStartedEvent` twice and make trauma 1, and without `shake` it is 0 after 1 / `CameraCore.shakeDecayPerSecond` seconds. When trauma is 0, offset and rotation are 0
- In every frame, the absolute value of each axis of the shake offset is at most `CameraCore.shakeMaxOffset` × trauma²
- With the same seed and the same `shake`, the offset with `set_shake_scale`(500) is half that at 1000, and at 0 the offset is 0 and `CameraShakeStartedEvent` is still emitted
- With the same `set_shake_seed` and the same order of `shake` calls, the offset of each frame is the same
- For a 2D camera, `screen_to_world(world_to_screen(p))` equals p (tolerance 0.01 world units). It is the same during zoom and shake. For a 3D camera, the same holds for a point p at height 0
- For a 3D camera, `world_to_screen` of a world position behind the camera and of a world position between the camera and the near plane is the origin, with one error log each
- A UI layer element at the same position does not change its screen position during camera movement, zoom and shake
- After `release` there is no camera reference, and after `init` again, `attach_camera` succeeds
