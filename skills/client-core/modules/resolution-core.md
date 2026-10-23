# ResolutionCore

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

Calculates game area and scale from the base resolution and the maximum resolution and applies them to the window, and handles the fill area outside the game area and the screen mode.

## dependency

`LogCore`, `EventCore`, `LocalDataCore`, `ResourceCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_orientation` | none | `Landscape`, `Portrait` | `Landscape` | core, content code |
| `get_base_resolution` | none | width and height | all 0 | core, content code |
| `get_window_size` | none | window size used in the last recalculation (window pixels) | all 0 | core, content code |
| `get_game_area` | none | game area (game coordinates rectangle) | empty rectangle | core, content code |
| `get_visible_game_area` | none | visible game area (game coordinates rectangle) | empty rectangle | core, content code |
| `get_scale` | none | scale | 0 | core, content code |
| `get_fill_mode` | none | `Crop`, `Letterbox` | `Letterbox` | core, content code |
| `window_to_game` | window pixel position | game coordinates position | game coordinates origin | core, content code |
| `game_to_window` | game coordinates position | window pixel position | window pixel origin | core, `QACore` |
| `is_screen_mode_supported` | none | whether supported | `false` | content code |
| `get_screen_mode` | none | `Windowed`, `Fullscreen` | `Fullscreen` | content code |
| `set_screen_mode` | `Windowed`, `Fullscreen` | success flag | `false` | content code |
| `apply_saved_screen_mode` | none | none | none | `BootstrapCore`(`InitModules` stage) |
| `load_fill_image` | none | none | none | `BootstrapCore`(`InitModules` stage) |

- `get_*`, `window_to_game`, `game_to_window`, `is_screen_mode_supported` do not allocate memory

## behavior

### base resolution and orientation

- base resolution: the width and height pixel counts of the reference screen that game screens and UI are made for. It is game settings `baseResolution`
- The orientation is set from the base resolution. `Landscape` when the width is larger than the height, `Portrait` when the height is larger. It does not change during the run. A screen with the device turned 180 degrees has the same orientation. When the platform is `android` or `ios`, the app's screen direction is locked to this orientation. How to lock it is in the engine-specific implementation rules. Other platforms (`web`, `windows`, `macos`, `linux`) do not lock the window direction. Even when the longer of the window's width and height differs from the orientation, the orientation and the game area calculation are the same, and the outside of the game area is the fill area of `Letterbox`

### game area

- window size: the width and height pixel counts of the window the OS gave the game. In split screen it is smaller than the device screen
- game coordinates: 1 is 1 pixel of the base resolution, and the origin is the top left of the window
- empty rectangle: a rectangle whose position is the game coordinates origin and whose size is 0x0. When the width or height of the overlap rectangle of two rectangles is 0 or less, that overlap rectangle is the empty rectangle
- scale: the number of window pixels that game coordinates 1 occupies
- The game area size is calculated in the order below. The maximum resolution is game settings `maxResolution`

  | order | value | calculation |
  |---|---|---|
  | 1 | fit scale | the smaller of window width ÷ base width and window height ÷ base height |
  | 2 | extended size | window size ÷ fit scale |
  | 3 | game area size | per axis, the smaller of the extended size and the maximum resolution |

- At each recalculation, when one axis of the maximum resolution is smaller than the base resolution, that axis uses the base resolution value. One error log is left at `init` and at each `set_test_screen` that sets a base resolution violating this condition
- fill mode: `Crop` when the platform is `ios`, otherwise `Letterbox`

  | fill mode | scale |
  |---|---|
  | `Crop` | the larger of window width ÷ game area width and window height ÷ game area height |
  | `Letterbox` | the smaller of the same two values |

- window area: the rectangle that expresses the whole window in game coordinates. Its position is the origin and its size is window size ÷ scale
- The center of the game area is the center of the window area
- visible game area: the overlap rectangle of the game area and the window area. In `Crop`, the edges of the game area outside the window area are not visible
- `window_to_game`: per axis, window pixel position × window area size ÷ window size
- When the engine must round the window area size down to an integer, this is written in the engine-specific implementation rules, and calculations that use the window area then use the rounded-down value. `get_scale` is the value of the fill mode table regardless of rounding down

### fill area

- fill area: in `Letterbox`, the part of the window area outside the game area. It is two bands of the same size on both sides of the game area or above and below it. There is none when the game area size equals the extended size or in `Crop`
- Only the fill color and the fill image are visible in the fill area
- The fill color is `ResolutionCore.fillColor` (R, G, B 0 to 255). The fill image is the resource key of `ResolutionCore.fillImage`; there is none when it is an empty string
- The fill area is painted with the fill color, and the fill image is drawn over it when there is one. The fill image keeps its aspect ratio, has the smallest size that covers the whole window area, and is placed at the center of the window area. Only the part that overlaps the fill area is visible
- `load_fill_image` starts the load of the fill image in the global scope of `ResourceCore` and does not wait. It starts only once per `init`. Before `load_fill_image` and until the load ends, only the fill color is visible. When `release` comes before the load ends, the result is not used

### recalculation

- recalculation: calculating game area, scale, window area, visible game area and fill area again from the window size
- recalculation times: `init`, window size change (PC window resizing, screen mode switch, folding and unfolding a foldable device), `set_test_screen` of DEV code
- Window size changes are received through engine notifications. The window size is not checked each frame
- When the width or height of the window size is 0, no recalculation runs and the previous result stays. When it is 0 at `init`, the result has all values 0
- When the recalculation changes at least one of window size, fill mode, game area, visible game area, scale, the result is applied again to the window and the fill area. Rectangles are compared by both position and size
- When at least one of window size, game area, visible game area, scale changes, `GameAreaChangedEvent` is raised after applying again. The recalculation of `init` does not raise it
- The game area drawn in the window before `init` and after `release` is the extended size

### screen mode

- The screen modes are `Windowed`, `Fullscreen`. The supported platforms are `windows`, `macos`, `linux`
- The screen mode is saved to `ResolutionCore.screen_mode`. Window size and window position are not saved
- `apply_saved_screen_mode` is called after `LocalDataCore.load_device_file`. When there is no saved value, it is `Windowed`. When the saved value is not `0` or `1`, it leaves a warn log and uses `Windowed`. On an unsupported platform it does nothing, without log
- `set_screen_mode` applies to the window and then saves. The success flag is whether it requested the apply to the window; whether the window reached that mode is read with `get_screen_mode`. A screen mode changed outside `set_screen_mode` (the OS full-screen button) is not saved
- `get_screen_mode` returns the current screen mode of the window, not the saved value. The same holds after a change outside `set_screen_mode`
- `set_screen_mode` received before a window screen mode switch the module requested during the current `init` (`set_screen_mode`, `apply_saved_screen_mode`) ends is rejected: `false` without error log, and the window and the saved value do not change. How to know that the switch ended is in the engine-specific implementation rules
- `set_screen_mode` received during a switch the OS started (the OS full-screen button) or a switch started in a previous `init` is applied to the window at once. When the engine discards that request, the window follows the result of that switch, and `get_screen_mode` is the current screen mode of the window
- `release` does not change the screen mode of the window

## hook

none

## event

| event | when | payload |
|---|---|---|
| `GameAreaChangedEvent` | a recalculation changed one of window size, game area, visible game area, scale | none. New values are read with the `get_*` operations |

## error

| condition | failure value | log |
|---|---|---|
| the width and height of the base resolution are equal or one is less than 1 | `init` fails. Passed to the fatal error handling of `BootstrapCore` | error |
| one axis of the maximum resolution is smaller than the base resolution | that axis uses the base resolution value | error at `init` and at each `set_test_screen` that sets that base resolution |
| a fill color element is outside 0 to 255 | the nearest end value | error |
| `get_screen_mode`, `set_screen_mode` on an unsupported platform | failure value | error |
| the saved screen mode is not `0` or `1` | `Windowed` | warn |
| a second `load_fill_image` in one `init` | does nothing | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `baseResolution` | array<integer> | game | none | base resolution. Width, height |
| `maxResolution` | array<integer> | game | none | maximum resolution. Width, height. In game coordinates units |
| `ResolutionCore.fillColor` | array<integer> | core | content | fill color. R, G, B |
| `ResolutionCore.fillImage` | string | core | content | resource key of the fill image. There is no fill image when it is an empty string |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `ResolutionCore.screen_mode` | `int64` | screen mode. 0 is `Windowed`, 1 is `Fullscreen` |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_screen` | base resolution, window size, fill mode, whether screen mode is supported | none | `QACore`, core test, client regression test |

- Uses the given values instead of the base resolution of settings, the actual window size, and the fill mode and screen mode support decided by platform, and runs recalculation. After they are given, actual window size changes are not used for recalculation. The orientation is set from the given base resolution
- The width and height of the base resolution are equal or one is less than 1, or the window size has a negative value: leaves an error log and does nothing. When the window size has a 0, does nothing without log
- One window pixel of the given window size is the actual window pixel multiplied per axis by (given window size ÷ actual window size). Input positions the engine gives and positions `InputCore.inject_device_input` puts into the engine are converted with this ratio
- `release` clears the given values

## test

Common conditions: base resolution 1920x1080 of `set_test_screen`, screen mode supported, game settings `maxResolution` 2400x1440, fill color 0, 0, 0, fill image empty string. When an item has other conditions, those conditions are used

- In both fill modes, a 1920x1080 window gives game area (0, 0) 1920x1080, scale 1, visible game area equal to the game area, and orientation `Landscape`
- A 3840x2160 window gives game area size 1920x1080 and scale 2, and `window_to_game` of (100, 50) is (50, 25)
- In both fill modes, a 2340x1080 window gives game area size 2340x1080 and scale 1
- `Letterbox` with a 2560x1080 window gives game area (80, 0) 2400x1080, and the fill area is the 80-pixel-wide bands at the left and right of the window
- `Crop` with a 2560x1080 window gives game area size 2400x1080, scale 2560 ÷ 2400, visible game area (0, 0) 2400x1012.5, and no fill area. On an engine that rounds down, it is 2400x1012
- `Letterbox` with a 1920x1600 window gives game area (0, 80) 1920x1440, and the fill area is the 80-pixel-high bands at the top and bottom
- With base resolution 1080x1920, maximum resolution 1440x2400, `Letterbox` and a 1080x2520 window, the orientation is `Portrait` and the game area is (0, 60) 1080x2400
- With game settings `maxResolution` 1800x1440, each `set_test_screen` with base resolution 1920x1080 leaves one error log, and `Letterbox` with a 2560x1080 window gives game area size 1920x1080. When game settings `baseResolution` is 1920x1080, `init` also leaves one error log
- With game settings `maxResolution` 2400x1440, `set_test_screen` with base resolution 1080x1920, `Letterbox` and a 1080x2520 window leaves one error log, and the game area is (0, 300) 1080x1920
- `set_test_screen` that changes the game area raises `GameAreaChangedEvent` once, and calling it again with the same input does not raise it
- `set_test_screen` with a 0x1080 window changes neither the results of the `get_*` operations nor events, even when other values are given with it
- With fill color -1, 128, 300, an error log is left and the fill area color is 0, 128, 255
- A fill image with a missing resource key leaves the error log of `ResourceCore`, and after the load the fallback resource of `ResourceCore` is visible in the fill area with the fill image placement
- Before `load_fill_image`, the fill image is not loaded and the fill area is the fill color. When `load_fill_image` is called after a bundle holding the fill image key is applied with `ResourceCore.apply_bundles`, the bundle's resource is visible in the fill area after the load. A second `load_fill_image` leaves an error log and does not start the load again
- When the saved screen mode is `2`, `apply_saved_screen_mode` leaves a warn log and `get_screen_mode` is `Windowed`
- In a run on a platform that supports screen mode, `set_screen_mode(Fullscreen)` succeeds and the saved value is `1`. After `release`, `init`, `apply_saved_screen_mode`, `get_screen_mode` is `Fullscreen`
- Without screen mode support, `set_screen_mode` gives an error log and `false`, and the saved value does not change
- In a run on a platform that supports screen mode, calling `set_screen_mode(Fullscreen)`, `set_screen_mode(Windowed)` in one frame makes the second `false`, and after the switch ends the window is `Fullscreen`, `get_screen_mode` is `Fullscreen` and the saved value is `1`
- In a run on a platform that supports screen mode, when the saved value is `0` and the window is changed to `Fullscreen` through the engine outside `set_screen_mode`, `get_screen_mode` is `Fullscreen` and the saved value is `0`
- Without `set_test_screen`, `get_fill_mode` and `is_screen_mode_supported` give the values of the platform rules
