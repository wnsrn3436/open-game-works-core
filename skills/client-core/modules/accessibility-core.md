# AccessibilityCore

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

Saves the user options for text size scale, color vision correction, voice subtitles, reduced screen shake and reduced flashing on the device and applies each to its module.

## dependency

`LogCore`, `EventCore`, `LocalDataCore`, `LocalizationCore`, `ResourceCore`, `SoundCore`, `SafeAreaCore`, `UICore`, `CameraCore`, `ScreenEffectCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `apply_saved_settings` | none | none | none | `BootstrapCore`(`InitModules` stage) |
| `get_settings` | none | `AccessibilitySettings` | default `AccessibilitySettings` | core, content code |
| `set_text_scale` | permille | success flag | `false` | content code |
| `set_color_mode` | `ColorMode` | success flag | `false` | content code |
| `set_subtitles` | on flag | none | none | content code |
| `set_reduce_shake` | on flag | none | none | content code |
| `set_reduce_flash` | on flag | none | none | content code |
| `play_voice` | resource key, resource scope, subtitle translation key, `FormatArgs`(optional) | play handle of `SoundCore` | invalid handle | content code |

### type

| type | contents |
|---|---|
| `ColorMode` | `None`, `Protanopia`, `Deuteranopia`, `Tritanopia` |
| `AccessibilitySettings` | `text_scale_permille`, `color_mode`, `subtitles`, `reduce_shake`, `reduce_flash` |
| default `AccessibilitySettings` | `text_scale_permille` 1000, `color_mode` `None`, `subtitles` `AccessibilityCore.subtitlesDefault`, `reduce_shake` `false`, `reduce_flash` `false` |

## behavior

### save and apply

- The option values are kept in the `device` file of `LocalDataCore` under the keys `AccessibilityCore.text_scale`, `AccessibilityCore.color_mode`, `AccessibilityCore.subtitles`, `AccessibilityCore.reduce_shake`, `AccessibilityCore.reduce_flash`
- `apply_saved_settings` is called after `LocalDataCore.load_device_file`. It reads the saved values and applies them all. When a key is missing, the type of a saved value differs from the type in `## data`, or a value is outside the allowed values, it uses the default. AccessibilityCore then leaves no log. Before it is called, the settings are the default and are not applied
- `set_*` applies the value at once and saves it. When the value changes, it emits `AccessibilityChangedEvent`. With the same value it does nothing

| option | applies to |
|---|---|
| text scale | `LocalizationCore.set_text_scale`(permille) |
| color mode | color filter. Follows the color mode rules |
| subtitles | whether `play_voice` shows subtitles |
| reduce shake | `CameraCore.set_shake_scale`(`AccessibilityCore.reducedShakePermille` when on, 1000 when off) |
| reduce flash | `ScreenEffectCore.set_flash_opacity_limit`(`AccessibilityCore.reducedFlashMaxOpacity` when on, 1 when off) |

### text scale

- The allowed values are the permille values in core settings `AccessibilityCore.textScales`
- Content code makes its UI so that text is not cut off or overlapped even at the largest allowed text scale. The UI quality check checks this

### color mode

- When `AccessibilityCore.colorFilterEnabled` is `true` and the color mode is not `None`, it applies that mode's color vision correction color matrix to the whole visible game area except the `Fatal` layer and the debug layer. The matrix values are that mode's item in core settings `AccessibilityCore.colorMatrices` (3x3, row-major). The filter is a shader made in code and is drawn in `UICore.get_layer(LoadingIcon)` above the other elements of that layer. It is also above elements added to that layer after the filter. How each engine does this is in the per-engine implementation rules
- When `AccessibilityCore.colorFilterEnabled` is `false`, it applies no filter. Content code then changes its palette from `AccessibilityChangedEvent` and the `color_mode` of `get_settings`

### subtitles

- `play_voice` calls `SoundCore.play`(resource key, `Voice`, resource scope) and returns its handle
- When subtitles are on, it shows the subtitle in the frame that requested playback. The text is the result of `LocalizationCore.get_text` when there are no `FormatArgs`, otherwise the result of `LocalizationCore.format`
- A `voice` resource played with `play_voice` is a subtitled voice as defined in [`resource`](../../resource/SKILL.md)
- The subtitle box is a black rectangle made in code (opacity `AccessibilityCore.subtitleBoxOpacity`) holding white text (the size set on that element is `AccessibilityCore.subtitleFontSize`, and the font size follows the text scale rules of `LocalizationCore`) with a padding of `AccessibilityCore.subtitlePadding`. It is placed in `UICore.get_layer(Message)`; its horizontal center is the horizontal center of the safe area of `SafeAreaCore`, and its bottom edge is `AccessibilityCore.subtitleBottomMargin` above the bottom edge of the safe area. Its width is safe area width × `AccessibilityCore.subtitleWidthPermille` ÷ 1000, and the text wraps
- One subtitle is shown at a time. The subtitle of a new `play_voice` replaces the previous subtitle
- Each frame, when `SoundCore.is_playing`(that handle) is `false`, it hides the subtitle. A request whose playback did not start (invalid handle) shows no subtitle
- Turning subtitles off hides the visible subtitle at once
- Cutscene lines do not use `play_voice`, because `CutsceneCore` shows the line text

### release

- Deletes the color filter, the subtitle box and the tracking of `SoundCore` playback. The values passed to `LocalizationCore`, `CameraCore` and `ScreenEffectCore` are reverted by the `release` of that module. It does not delete saved values

## hook

none

## event

| event | when | payload |
|---|---|---|
| `AccessibilityChangedEvent` | after an option value changed by `set_*` is applied | none. The new values are read with `get_settings` |

## error

| condition | failure value | log |
|---|---|---|
| value of `set_text_scale` not in `AccessibilityCore.textScales` | `false`. Value unchanged | error |
| value outside `ColorMode` passed to `set_color_mode` | `false`. Value unchanged | error |
| value less than 1000 passed to `set_test_text_scale` | ignored. Text scale unchanged | error |
| subtitle translation key of `play_voice` is empty | plays, and shows no subtitle | error |
| `AccessibilityCore.textScales` has no 1000, or has an element less than 1 or duplicate elements; `colorMatrices` has no item for one of `Protanopia`, `Deuteranopia`, `Tritanopia`, or an item's elements are not 9 real numbers; `reducedShakePermille` is not from 0 to 1000; `subtitleWidthPermille` is not from 1 to 1000; `reducedFlashMaxOpacity` or `subtitleBoxOpacity` is not from 0 to 1; `subtitleFontSize` is less than 1; `subtitlePadding` or `subtitleBottomMargin` is less than 0 | `init` fails | error |
| engine does not support a full-screen shader | applies no filter | warn once per `init` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `AccessibilityCore.textScales` | array<integer> | core | human | list of allowed text scale permille values |
| `AccessibilityCore.subtitlesDefault` | boolean | core | content | subtitles when there is no saved value |
| `AccessibilityCore.colorFilterEnabled` | boolean | core | content | whether to use the color filter of core |
| `AccessibilityCore.colorMatrices` | object | core | content | 3x3 color matrix (9 real numbers, row-major) for each of `Protanopia`, `Deuteranopia`, `Tritanopia` |
| `AccessibilityCore.reducedShakePermille` | integer | core | content | camera shake scale permille when reduce shake is on |
| `AccessibilityCore.reducedFlashMaxOpacity` | number | core | content | maximum opacity of a flash when reduce flash is on |
| `AccessibilityCore.subtitleWidthPermille` | integer | core | content | subtitle box width as permille of the safe area width |
| `AccessibilityCore.subtitleBoxOpacity` | number | core | content | opacity of the black rectangle of the subtitle box |
| `AccessibilityCore.subtitleFontSize` | integer | core | content | size set on the subtitle text element. Value before multiplying by the text scale. game coordinates |
| `AccessibilityCore.subtitlePadding` | number | core | content | inner padding of the subtitle box. game coordinates |
| `AccessibilityCore.subtitleBottomMargin` | number | core | content | distance between the bottom edge of the safe area and the bottom edge of the subtitle box. game coordinates |

- The core settings schema checks the value ranges in the error table

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `AccessibilityCore.text_scale` | `int64` | text scale permille |
| `device` | `AccessibilityCore.color_mode` | `string` | `ColorMode` element name |
| `device` | `AccessibilityCore.subtitles` | `bool` | subtitles |
| `device` | `AccessibilityCore.reduce_shake` | `bool` | reduce shake |
| `device` | `AccessibilityCore.reduce_flash` | `bool` | reduce flash |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_text_scale` | permille(1000 or more) | none | `QACore`, core test |

- Applies the text scale and does not save it. On `release` it returns to the saved value
- The `QACore` command `set_text_scale` calls this operation
- STG and PROD builds do not have this operation

## test

- With no saved values, `get_settings` is the default; after `set_*` and then `release`, `init`, `apply_saved_settings`, it is the same value. A saved value of the same type but outside the allowed values becomes the default without a log
- After `set_text_scale`, `LocalizationCore.get_text_scale` is that value. A value not in the list gives `false` and an error log, and `get_text_scale` is unchanged
- With the same `CameraCore.set_shake_seed` and the same `shake` call, the shake offset in each frame with reduce shake on is the offset with it off × `reducedShakePermille` ÷ 1000. With reduce flash on, in a `flash` with maximum opacity 1 the opacity of `ScreenEffectCore.get_overlay_state` is not more than `reducedFlashMaxOpacity` in any frame; with it off, it reaches 1
- When `colorFilterEnabled` is `true` and the mode is `Deuteranopia`, a pure red screen pixel is the color multiplied by that matrix (tolerance 1/255 per component); with `None` it is unchanged. When it is `false`, the pixel is unchanged in every mode
- After the color filter is on, the pixels of a loading icon shown with `UICore.show_loading_icon` are also filtered colors
- With subtitles on, calling `play_voice` shows a subtitle, which hides in the frame where playback ends. With subtitles off there is no subtitle and playback happens. The subtitle of a second `play_voice` replaces the previous subtitle
- The horizontal center of the subtitle box is the horizontal center of the safe area, and its bottom edge is `AccessibilityCore.subtitleBottomMargin` above the bottom edge of the safe area
- The font size of the subtitle text, both for a subtitle shown after `set_test_text_scale`(1500) and for a subtitle that is visible when `set_test_text_scale`(1500) is called (after that call), is `subtitleFontSize` × 1500 ÷ 1000 rounded down
- Each `set_*` that changes a value emits `AccessibilityChangedEvent` once, and the same value emits none
- After `set_test_text_scale`, the device file is unchanged
- `set_test_text_scale`(999) leaves an error log, and `LocalizationCore.get_text_scale` is unchanged
- After `release`, there is no color filter and no subtitle box
