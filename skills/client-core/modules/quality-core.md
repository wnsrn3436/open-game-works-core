# QualityCore

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

Sets the graphics quality level, applies render scale, shadow and frame limit of that level's quality profile (render scale, shadow, effect density, frame limit) to the engine, and gives effect density through `get_profile`. The level of the first run is set by the device class, and the level the user picks is saved on the device.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `apply_saved_level` | none | none | none | `BootstrapCore`(`InitModules` stage) |
| `get_level` | none | current `QualityLevel` | `Medium` | core, content code |
| `get_profile` | none | `QualityProfile` of the current level | `QualityProfile` with `render_scale_permille` and `effect_density_permille` 1000, `shadow` `High`, `frame_limit_fps` 0 | core, content code |
| `is_override` | none | whether the level the user picked is in use | `false` | content code |
| `set_level` | `QualityLevel` | success flag | `false` | content code |
| `clear_override` | none | none | none | content code |

### type

| type | contents |
|---|---|
| `QualityLevel` | `Low`, `Medium`, `High`. Higher in this order |
| `ShadowQuality` | `Off`, `Low`, `High` |
| `QualityProfile` | `render_scale_permille`, `shadow`(`ShadowQuality`), `effect_density_permille`, `frame_limit_fps` |

## behavior

### quality profile

- The profile values per level are read from core settings `QualityCore.levels`. `frame_limit_fps` is game settings `targetFps` × that level's `frameLimitPermille` ÷ 1000, rounded down, and is 1 when that is less than 1
- Applying does the following in the same frame. How the engine maps each one is in the engine-specific implementation rules
  - render scale: sets the resolution at which the 3D world is drawn to window resolution × `render_scale_permille` ÷ 1000. The UI layer and the 2D world are always drawn at window resolution
  - shadow: maps the engine's shadow option to `ShadowQuality`. `Off` draws no shadow
  - frame limit: sets the engine's maximum frame rate to `frame_limit_fps`
- Effect density is not applied to the engine. Code that makes repeated effects (particles, debris, damage text) reduces the count it makes to `effect_density_permille` ÷ 1000 times. An effect whose reduced count becomes 0 makes 1. e.g. an effect of 40 particles makes 20 at density 500
- When `set_level`, `clear_override` or auto downgrade changes the level, the module applies it and then raises `QualityChangedEvent`. For the same level it does not apply and raises no event

### initial level

`apply_saved_level` is called after `LocalDataCore.load_device_file` and applies the profile of the first matching level below, even when it equals the current level. It does not raise `QualityChangedEvent`.

1. That level when `QualityCore.override_level` in the `device` file is a `QualityLevel` element name. The module enters the override state
2. That level when `QualityCore.auto_level` in the `device` file is a `QualityLevel` element name
3. The level of device class detection. It is saved to `QualityCore.auto_level`

- device class detection: looks at core settings `QualityCore.deviceClasses` in the order `High`, `Medium`, and is the level of the first item where the device's system memory bytes are at least that item's `minMemoryBytes` and the logical processor count is at least `minProcessorCount`. When no item matches, it is `Low`
- A value the engine cannot read from the device (e.g. system memory on web) counts as passing that condition. How to read it is in the engine-specific implementation rules
- The level before `apply_saved_level` is `Medium` and is not applied to the engine

### user choice

- `set_level` applies the level, saves it to `QualityCore.override_level` and enters the override state
- `clear_override` deletes `QualityCore.override_level` and applies the level of `QualityCore.auto_level` (when there is none, the level of device class detection). Outside the override state it does nothing

### auto downgrade

- When `QualityCore.autoDowngradeEnabled` is `true`, the module is not in the override state and the level is not `Low`, the module measures frame duration
- measured frame: a frame that is not in background and whose frame duration in real elapsed time is at most `QualityCore.hitchFrameMs`. A frame over it (a stall from scene loading) is discarded
- When the sum of real elapsed time of measured frames reaches `QualityCore.autoDowngradeWindowMs`, the module calculates the average FPS (measured frame count ÷ summed seconds) and clears the measurement. When the average FPS is less than base FPS × `QualityCore.autoDowngradeFpsPermille` ÷ 1000, it lowers the level by one step and saves it to `QualityCore.auto_level`
- base FPS: the smaller of `frame_limit_fps` and the refresh rate (integer Hz) of the device screen read when the average FPS is calculated. When the engine cannot read the refresh rate, it is `frame_limit_fps`. How to read it is in the engine-specific implementation rules
- When the level changes or `AppForegroundReturnedEvent` is received, the measurement is cleared
- There is no automatic judgement that raises the level

### release

- Clears the measurement and returns the engine's render scale, shadow and frame limit to the values before `init`. Saved values are not deleted

## hook

none

## event

| event | when | payload |
|---|---|---|
| `QualityChangedEvent` | after `set_level`, `clear_override` or auto downgrade changes the level and the profile is applied | `level`: `QualityLevel` |

## error

| condition | failure value | log |
|---|---|---|
| `set_level` with a value outside `QualityLevel` | `false`. Level unchanged | error |
| saved `QualityCore.override_level` or `QualityCore.auto_level` is not a `QualityLevel` element name | goes to the next in order | warn |
| `QualityCore.levels` lacks one of the items `Low`, `Medium`, `High`, `shadow` is not a `ShadowQuality` element name, `renderScalePermille` or `frameLimitPermille` is not from 1 to 1000, `effectDensityPermille` is not from 0 to 1000, a `QualityCore.deviceClasses` item lacks one of the fields `level`, `minMemoryBytes`, `minProcessorCount`, an item's `level` is not `Medium` or `High`, `minMemoryBytes` or `minProcessorCount` is not an integer of 0 or more | `init` fails | error |
| the engine does not support the shadow option or render scale (e.g. a renderer without a 3D world) | only that value is not applied | none |
| `set_test_device_info` with a value less than −1, processor count 0, refresh rate 0 | ignored | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `targetFps` | integer | game | none | target FPS. The criterion for the `frame_limit_fps` calculation |
| `QualityCore.levels` | object | core | content | per `Low`, `Medium`, `High`: `renderScalePermille`, `shadow` (`ShadowQuality` element name), `effectDensityPermille`, `frameLimitPermille`. The core settings schema checks the three items and the value ranges of the error table |
| `QualityCore.deviceClasses` | array<object> | core | content | device class detection items. An item is `level` (`Medium`, `High`), `minMemoryBytes`, `minProcessorCount`. The core settings schema checks the three fields of an item and the value ranges of the error table |
| `QualityCore.autoDowngradeEnabled` | boolean | core | content | whether to run auto downgrade |
| `QualityCore.autoDowngradeWindowMs` | integer | core | content | sum of measured frame duration at which the average FPS is calculated |
| `QualityCore.autoDowngradeFpsPermille` | integer | core | content | the level is lowered when the average FPS is less than this permille of base FPS |
| `QualityCore.hitchFrameMs` | integer | core | content | lower bound of the frame duration discarded from measurement |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `QualityCore.override_level` | `string` | `QualityLevel` element name the user picked |
| `device` | `QualityCore.auto_level` | `string` | `QualityLevel` element name from device class detection or auto downgrade |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_level` | `QualityLevel` | none | `QACore`, core test |
| `set_test_device_info` | system memory bytes, logical processor count, refresh rate of the device screen (integer Hz). A value that cannot be read is −1 | none | core test |

- `set_test_level` applies the level and does not save it. No auto downgrade runs until `release`
- `set_test_device_info` is called after `init` and before `apply_saved_level`. After it, device class detection and base FPS use these values instead of the values read from the engine. `release` deletes them
- STG and PROD builds do not have these operations

## test

- With no saved value, the device class detection level from `deviceClasses` is applied and saved to `QualityCore.auto_level`. For each memory and processor count given with `set_test_device_info`, the level is the level of the first matching item in `deviceClasses`, and `Low` when no item matches. Memory −1 passes the memory condition
- When `override_level` exists, it is used before `auto_level` and `is_override` is `true`. A saved value that is not a `QualityLevel` element name goes to the next in order after a warn log
- `release`, `init`, `apply_saved_level` after `set_level` give the same level, and after `clear_override` the level is that of `auto_level`
- With `targetFps` 60 and `frameLimitPermille` 500, `frame_limit_fps` is 30 and the engine maximum frame rate is 30
- When the saved level is `Medium`, after `apply_saved_level` the engine maximum frame rate is the `frame_limit_fps` of `Medium` and there is no `QualityChangedEvent`
- `QualityChangedEvent` comes once only when the level changes, and not for `set_level` with the same level
- When a measurement window whose average FPS is less than base FPS × `autoDowngradeFpsPermille` ÷ 1000 ends, the level goes down one step and is saved; at `Low` and in the override state it does not go down. A frame over `hitchFrameMs` is not in the average
- With refresh rate 60 from `set_test_device_info` and `frame_limit_fps` 120, a measurement window whose average FPS is at least 60 × `autoDowngradeFpsPermille` ÷ 1000 does not lower the level. With refresh rate −1, the judgement uses `frame_limit_fps`
- After `set_test_level`, the device file is unchanged and there is no auto downgrade
- Each condition of the error table gives the failure value and log of the table
- When a `deviceClasses` item's `level` is `Low`, `minProcessorCount` is missing or `minMemoryBytes` is negative, `init` fails with an error log
- After `release`, the engine's render scale, shadow and frame limit are the values before `init`
- `get_profile` before `init` gives an error log and returns the failure value `QualityProfile`
