# QACore

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

Provides, in DEV builds, the debug screen, cheats, the automation channel, bot connection (headless run, real input injection) and telemetry recording; the whole module is DEV code. Bot playtest, the play agent, the judge agent, completeness check and the bot client of an instance read QAState, the screen, logs and telemetry and put in input through it.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `ResourceCore`, `DataCore`, `LocalizationCore`, `SoundCore`, `NetworkCore`, `UserStateCore`, `AuthCore`, `ResolutionCore`, `SafeAreaCore`, `InputCore`, `InputBlockCore`, `TweenCore`, `ScreenEffectCore`, `PoolCore`, `UICore`, `SceneCore`, `BootstrapCore`

- optional dependency: `CutsceneCore`, `TutorialCore`, `RealtimeCore`, `QualityCore`, `AccessibilityCore`, `PushCore`, `CameraCore`. When one is missing, a command that calls that module fails. `CameraCore` is used only to subscribe to `CameraCore.CameraShakeStartedEvent`
- The only `BootstrapCore` operations QACore calls are `BootstrapCore.get_build_info`, `BootstrapCore.boot_stage`, `BootstrapCore.get_launch_value`. QACore requests a restart with `EventCore.RestartRequestedEvent`
- `BootstrapCore` runs `init` and `release` of QACore through the module list, and calls the DEV registration list when the init check of QACore is `true`. It calls no other QACore operation

## API

none

## behavior

### command

- command: one action received through the debug screen or the automation channel. It has a name, a string argument list and a result (`ok`, `result`, `bytes`)
- Commands are handled one at a time in the order received. The next starts only after the previous command ends. `capture_video` is the exception: it starts as soon as it is received, and the next command starts without waiting for it to end. A `capture_video` received while another `capture_video` runs fails
- Arguments are external input. An unknown name, a wrong argument count, and a format or range violation of a built-in command fail without calling the target operation
- A failed command leaves a warn log and no error log. It writes the reason in English in `result`
- When a command ends, an info log records its name and `ok`. Arguments are not written to the log
- A command that does not end within `QACore.commandTimeoutMs` fails. The limit of `drag`, `key`, `capture_video` is `QACore.commandTimeoutMs` plus the argument's ms. The limit of `step` is `QACore.commandTimeoutMs` plus ms × 1000 ÷ (`TimeCore.get_time_scale` at the start of `step`) rounded up, because game time in step mode grows with the time scale applied. The ms of `step` is game time, and the ms of other command arguments is measured in real elapsed time of `TimeCore`
- numeric argument syntax: integer `-?[0-9]{1,18}`, real number `-?[0-9]+(\.[0-9]+)?`. The whole string must match
- automation coordinates: window pixel coordinates. The window is the window whose width and height are `ResolutionCore.get_window_size`, and while `ResolutionCore.set_test_screen` has set a window size, the window of that window size. The origin is the top left of the window and matches the pixel coordinates of the `capture_screen` PNG. The width and height of the `capture_screen` PNG are those of this window. On input, coordinates are converted to game coordinates with `ResolutionCore.window_to_game`, and returned rectangles are converted with `ResolutionCore.game_to_window`
- content command: content code in `client/dev/` registers it with `register_command`. The name is `<feature>.<command>`, both parts snake_case. The handler is an async operation; it receives the argument list, returns (`ok`, `result`) and checks the arguments itself
- DEV registration list: the function list the harness tool generates from `client/dev/`. The registration functions call `register_command` and `set_content_state` and subscribe to events for telemetry marks

### built-in command

A command marked setup is not real input. Bot playtest records that step as setup. A command marked input is an input of telemetry. A command marked step is neither input nor setup, and `ogw step-mode`, `ogw step` of the harness tool call it.

| command | argument | work | `result` | `args` |
|---|---|---|---|---|
| `get_state` | none | state lookup | `QAState` JSON object | none |
| `get_stats` | none | performance stats lookup | stats JSON object | none |
| `get_telemetry` | none | telemetry lookup | telemetry JSON object | none |
| `clear_telemetry` | none | empties telemetry and sets its start time to now | none | none |
| `capture_screen` | format (`png` or `jpg`, `png` when omitted) | screen image without the debug layer: PNG, or JPEG of quality `QACore.captureJpgQuality` with `jpg`. Even when the engine does not draw the window (e.g. a window fully covered by other windows), draws one frame and captures it. Fails when headless or with another format | none. The image in `bytes` | `format` |
| `capture_video` | ms (integer from 1 to `QACore.videoMaxMs`), format (`png` or `jpg`, `png` when omitted) | captures ⌊ms × `QACore.videoFps` ÷ 1000⌋ images of that format, the same as `capture_screen`, and sends them as frame messages of the automation channel. Fails when headless or when there is no automation channel connection | `frame_count` (number of frame messages sent), `fps` (`QACore.videoFps`) | `ms` |
| `list_ui` | none | lookup of visible UI elements | JSON array | none |
| `get_anchor` | anchor name, anchor key (when omitted, finds without a key) | `UICore.get_anchor_rect` | `found`, `visible`, `rect` (window pixels) of `AnchorResult` | `anchor`, `key` |
| `tap` | x, y (real numbers) | input. touch press, release on the next frame | none | `x`, `y` |
| `tap_anchor` | anchor name, anchor key (when omitted, finds without a key) | input. `tap` at the center of the visible anchor rectangle. Fails when it does not exist or is not visible | none | `anchor`, `key` |
| `drag` | x1, y1, x2, y2 (real numbers), ms (integer 0 or more) | input. Press. After that, each frame moves to the position on the straight line at ratio (elapsed since the press ÷ ms), and on the first frame where the elapsed is ms or more, moves to the end position and releases. When ms is 0, moves to the end position and releases on the frame after the press | none | `x1`, `y1`, `x2`, `y2`, `ms` |
| `key` | key name, ms (integer 0 or more, 0 when omitted) | input. key press, release after `ms` (on the next frame when 0) | none | `key`, `ms` |
| `text` | string (from 1 to `QACore.textMaxChars` characters) | input. Puts in one text input per character, one per frame. A character is one Unicode code point, and both the range check and the text input use this unit | none | `text` |
| `touch_down` | touch index, x, y (real numbers) | input. Touch press of that touch index. Fails when that index is pressed | none | `index`, `x`, `y` |
| `touch_move` | touch index, x, y (real numbers) | input. Touch move of the pressed touch index. Fails when it is not pressed | none | `index`, `x`, `y` |
| `touch_up` | touch index | input. Touch release of the pressed touch index. The position is the last position. Fails when it is not pressed | none | `index` |
| `key_down` | key name | input. key press. Fails when that key is pressed | none | `key` |
| `key_up` | key name | input. Release of the pressed key. Fails when it is not pressed | none | `key` |
| `mouse_move` | x, y (real numbers) | input. mouse move | none | `x`, `y` |
| `mouse_down` | mouse button argument, x, y (real numbers) | input. Mouse move to that position and press of that button. Fails when that button is pressed | none | `button`, `x`, `y` |
| `mouse_up` | mouse button argument, x, y (real numbers) | input. Mouse move to that position and release of that button. Fails when it is not pressed | none | `button`, `x`, `y` |
| `pad_button_down` | gamepad button name | input. gamepad button press. Fails when it is pressed | none | `button` |
| `pad_button_up` | gamepad button name | input. Release of the pressed gamepad button. Fails when it is not pressed | none | `button` |
| `pad_axis` | gamepad axis name, value (real number) | input. gamepad axis value. Fails when the value is outside the range of that axis | none | `axis`, `value` |
| `go_to_scene` | scene key | setup. `SceneCore.change_scene`, scene param none | none | `scene` |
| `open_panel` | panel key | setup. `UICore.open_panel`(panel key, param none, clear stack `false`) | none | `panel` |
| `set_time_scale` | permille (integer from 1 to `QACore.timeScaleMaxPermille`) | `TimeCore.set_time_scale` | none | `permille` |
| `set_step_mode` | `on`, `off` | step. `TimeCore.set_step_mode`. Fails when `RealtimeCore` is in the module list and `RealtimeCore.match_state` is not `None` | none | `mode` |
| `leave_match` | none | step. Calls `RealtimeCore.leave` when `RealtimeCore.match_state` is not `None`. Fails when `RealtimeCore` is not in the module list, or when `RealtimeCore.match_state` is not `None` after the call | none | none |
| `step` | ms (integer from 1 to `QACore.stepMaxMs`) | step. In step mode, advances game time by ms and waits until it ends. In `Playing` of a lockstep match (the lockstep flag of `RealtimeCore.match_info` is `true`), the lockstep branch calls `RealtimeCore.request_step`; otherwise the budget branch waits after `TimeCore.add_step_budget` until `TimeCore.get_step_budget` becomes 0. Fails when not in step mode or when `RealtimeCore.request_step` is `false`. When `TimeCore.is_paused` is `true`, both branches fail without adding budget or calling `RealtimeCore.request_step` (`game time is paused`). While the budget branch waits, QACore reads `TimeCore.get_step_budget` and then `TimeCore.is_paused` once per frame: when the budget is 0 the `step` succeeds, and otherwise when `TimeCore.is_paused` is `true` the budget branch fails (`game time is paused`) without waiting for the command time limit. When the budget branch fails by game time being paused or by exceeding the command time limit, it sets the remaining budget to 0 with `TimeCore.set_step_mode`(true). When the lockstep branch fails by exceeding the command time limit, it does not change the budget or step mode, leaves the called `RealtimeCore.request_step` until it ends and discards its result. A lockstep branch that starts before the end of the `RealtimeCore.request_step` that the previous `step` called fails without calling `RealtimeCore.request_step` | none | `ms` |
| `set_language` | language `code` | setup. `LocalizationCore.select_language` with the row of the `language` table whose `code` equals the argument. When that result is `true`, emits `EventCore.RestartRequestedEvent` after sending the result; when `false`, fails and does not emit it | none | `code` |
| `set_server_time_offset` | ms integer | setup. core cheat `SetTimeOffset` | none | `ms` |
| `set_user_state` | kind name, item, value JSON | setup. core cheat `SetUserState`. Writes the value as is without adding | none | `kind`, `item`, `value` |
| `set_item_balance` | ID name of the item, balance (big integer 0 or more) | setup. core cheat `SetItemBalance`(item ID value, `balance`, `big_balance` holding the balance in the big encoding of the contract) | none | `item`, `balance` |
| `delete_user_state` | kind name, item | setup. core cheat `DeleteUserState` | none | `kind`, `item` |
| `set_mission_progress` | ID name of the mission, progress (integer 0 or more), claimed (`true`, `false`) | setup. core cheat `SetMissionProgress`(mission ID value, progress, claimed) | none | `mission`, `progress`, `claimed` |
| `set_reset_counter` | ID name of the reset counter, count (integer 0 or more) | setup. core cheat `SetResetCounter`(reset counter ID value, count) | none | `counter`, `count` |
| `set_quality_level` | `Low`, `Medium`, `High` | setup. `QualityCore.set_test_level` | none | `level` |
| `set_text_scale` | permille (integer 1000 or more) | setup. `AccessibilityCore.set_test_text_scale` | none | `permille` |
| `force_network_failure` | `timeout`, `connection_failed`, `none` | setup. `NetworkCore.force_failure` | none | `kind` |
| `set_network_delay` | ms (integer 0 or more. 0 clears) | setup. `NetworkCore.force_delay` | none | `ms` |
| `expire_access_token` | none | setup. `AuthCore.expire_access_token` | none | none |
| `set_social_account` | fake account name (snake_case) | setup. `AuthCore.set_fake_social_account`. The next social login and account link use that fake account | none | `account` |
| `simulate_push` | ID name of `push_message`, `received` or `opened` | setup. `PushCore.simulate_push`(message ID value, opened by a tap when `opened`) | none | `message`, `mode` |
| `set_push_permission` | `Undetermined`, `Granted`, `Denied`, `Unsupported` | setup. `PushCore.set_fake_permission` | none | `status` |
| `drop_peer` | participant index (integer 0 or more) or `other` | setup. `RealtimeCore.force_peer_lost`. `other` is the smallest index whose `RealtimeCore.peer_state` is `Connected`, among the indexes other than the own participant index of `RealtimeCore.match_info`. When there is no such index, fails without the target operation | none | `participant` |
| `drop_matchmaker` | none | setup. `RealtimeCore.force_matchmaker_lost` | none | none |
| `set_test_screen` | window width, height (integers 1 or more), `Crop` or `Letterbox` | setup. `ResolutionCore.set_test_screen`(game settings `baseResolution`, window size, fill mode, screen mode not supported). That operation has no result, so `ok` = `true` when the argument check passes | none | `width`, `height`, `fill_mode` |
| `set_virtual_notch` | left, top, right, bottom window pixels (integers 0 or more), or `none` | setup. `SafeAreaCore.set_virtual_notch`, and `SafeAreaCore.clear_virtual_notch` for `none` | none | `left`, `top`, `right`, `bottom` |
| `set_virtual_keyboard` | height in window pixels (integer 1 or more), or `none` | setup. `SafeAreaCore.set_virtual_keyboard`, and `SafeAreaCore.clear_virtual_keyboard` for `none` | none | `height` |
| `set_input_device` | `Touch`, `KeyboardMouse`, `Gamepad` | setup. Calls `InputCore.set_test_device` and ends when the next frame ends | none | `device` |
| `focus_ui` | `path` from `list_ui` | setup. Calls `UICore.set_test_focus` with the UI element of that path. Fails when that element does not exist or the result is `false` | none | `path` |
| `restart` | none | setup. `EventCore.RestartRequestedEvent` after sending the result | none | none |
| `quit` | none | After sending the result, requests from the engine an app exit, the same as an OS app exit request | none | none |
| `extract_logs` | none, or the text of a JSON object holding, per path, the byte offset to start reading at | For each file of `LogCore.list_log_files`: path, the byte offset where reading started, the content from that offset to the end, the file size in bytes. A path with no received offset is read from 0, and an offset larger than the file size (a file that shrank) is read from 0. When the byte at the offset is a UTF-8 continuation byte (`10xxxxxx`), the offset moves to the next byte that is not a continuation byte or to the end of the file. `offset` is the value after the move | JSON array. Per file `{"path": <path>, "offset": <offset>, "content": <content>, "size": <size>}` | `offsets` |
| `get_requests` | none | `NetworkCore.get_request_records` | JSON array. In order of completion, per item `name` (request name), `kind`, `ok`, `error_code`, `request`, `response`. The two bodies are base64 | none |
| `get_user_state` | kind name or `all` | `UserStateCore.export_json`. `all` is every kind | JSON object | `kind` |
| `get_resources` | none | `ResourceCore.list_loaded_resources`, `ResourceCore.list_scopes` | `resources` (per item `key`, `refs`), `scopes` (per item `kind`, `name`) | none |
| `get_sound` | none | `SoundCore.get_bgm_key`, `SoundCore.get_playing`, `SoundCore.get_haptic_log` | `bgm`, `playing` (per item `key`, `bus`, `priority`), `haptics` (per item `key`, `played`, `target`) | none |
| `list_commands` | none | Per built-in and content command: name, description, argument names. The argument names of a built-in command are `args` of the table, including the names of arguments that can be omitted. The description of a built-in command is one non-empty English sentence the implementation sets | JSON array. Per command `{"name": <name>, "description": <description>, "args": [<argument name>, ...]}` | none |
| `set_stats_visible` | `true`, `false` | display of performance stats on the debug layer | none | `visible` |

- The `result` of a successful command is `result` of the table. When `result` of the table is none, there is no `result`, and a `result` that lists several names is a JSON object with those names as keys
- Input commands put input in with `InputCore.inject_device_input`. The input goes from step 1 of the input processing order of `InputCore`, the same as input the engine received from the device, so `InputBlockCore` and UI elements receive it by the same path as human input
- Input commands put in device input at frame start, before the process callbacks of that frame run. So the process frame in which a UI element receives that input equals the pressed frame and released frame of that input in the `InputCore` action state. The method of putting it in is in the per-engine implementation rules
- `touch_down`, `touch_move`, `touch_up`, `key_down`, `key_up`, `mouse_move`, `mouse_down`, `mouse_up`, `pad_button_down`, `pad_button_up`, `pad_axis` end when the frame in which they put in one device input ends, and do not wait for a release. Concurrent input is made by putting in the next command while holding the press
- touch index: an integer of 0 or more and less than `QACore.touchIndexCount` that tells apart the touches QACore puts in. `tap`, `tap_anchor`, `drag` use the smallest touch index that is not pressed, and when there is no such index they fail without device input
- anchor key argument: an ID name, or an integer of 1 or more in the numeric argument syntax. An ID name is converted to an ID value with the DEV accessor of the data tool, and an integer is used as the anchor key as is. An ID name that does not exist and a string that is neither fail without the target operation
- `simulate_push` converts the ID name to an ID value with the DEV accessor of the data tool. An ID name that does not exist fails without the target operation
- The argument of `extract_logs` is a JSON object, each value an integer from 0 to 2^53 (a JSON number with no fractional part). Text that cannot be read as JSON, a JSON value that is not an object, and a value outside this range or not an integer fail without the target operation. The offset of a path not in `LogCore.list_log_files` is not used. `content` is the string read as UTF-8 from the bytes from the offset to the end of the file, and each byte that cannot be read as UTF-8 becomes one U+FFFD
- Capture of frame n (from 0) of `capture_video` starts on the first frame where real elapsed time of `TimeCore` since the start of `capture_video` is ⌊n × 1000 ÷ `QACore.videoFps`⌋ ms or more. When that time has already passed as the capture of the previous frame ends, capture starts at once. Late frames are not skipped, and no frame is sent twice
- `capture_video` sends every frame message in capture order and then sends the response
- When `set_step_mode`(`on`) succeeds, QACore calls `InputBlockCore.set_timer_hold`(`step`, `true`), and when `set_step_mode`(`off`) succeeds, `InputBlockCore.set_timer_hold`(`step`, `false`)
- mouse button argument: `left`, `right`, `middle`, which press and release, in order, the buttons of the `InputCore` mouse button names `mouse_left`, `mouse_right`, `mouse_middle`. The `InputCore` mouse button names are not accepted. Gamepad button names, gamepad axis names and ranges are those of `InputCore`
- When the automation channel connection drops outside `release`, QACore ends the commands received through that connection that are in handling or waiting with `ok` = `false`, puts in a release for the touches, keys, mouse buttons and gamepad buttons held by input commands, and puts 0 in gamepad axes that are not 0. An ended command puts in no device input after that
- A cheat command sends with `NetworkCore.send_cheat` and passes no success callback and no failure callback. So a failed cheat request goes through the `Interaction` default handling of `NetworkCore` (error popup, `ErrorDisplay`). ID names are converted to ID values with the DEV accessor of the data tool
- kind name: the UserState kind message name that `get_user_state`, `set_user_state`, `delete_user_state` receive. It equals `kind` of `UserStateEntry`. e.g. `QuestUserState`. An accepted name is a name in the list of core UserState kinds and `user_state.proto` kinds that the contract tool generates. A name not in the list fails without the target operation and without a request
- item: the item ID that `set_user_state`, `delete_user_state` send. The item of a list kind is an ID name or an integer of 0 or more in the numeric argument syntax, and an integer is used as the item ID as is. The item of a single kind is `[]` and is sent as item ID 0. `[]` for a list kind and any value other than `[]` for a single kind fail without a request
- `set_user_state` converts, inside the value JSON, every string whose whole value is an ID name to that ID value integer, and for a list kind fills `id` of the JSON with the item ID. An ID name that does not exist and a value JSON that cannot be decoded fail without a request
- The offset of `set_server_time_offset` does not enter the notice list selection of server `notice`. The server chooses notices by time without the offset, and `NoticeCore` judges active by server time with the offset, so while an offset is set, the active judgement of a notice can differ from the server evaluation. `start_at`, `end_at` of a notice are not tested with the offset
- `list_ui` element: `path` (node path of the element. The separator is `/`, and the `path` of an ancestor element followed by `/` is the leading part of the element's `path`), `rect` (window pixels `[x, y, w, h]`), `text` (when the element is a text element, the whole text the element draws with markup removed, otherwise an empty string), `font_size` (the character size the element draws text with, multiplied by the element's vertical scale and converted to window pixels. 0 when `text` is an empty string), `clipped` (whether `text` is not an empty string and is not fully drawn inside the element's own rectangle. It looks at lines beyond the visible line count, a visible character limit smaller than the character count, and overflow of the text area width by a line that does not wrap. It does not look at ancestor clipping, positions outside the window, or the scroll of a multi-line text input element), `anchor` (empty string when none), `anchor_key` (anchor key. 0 when none), `owner` (the key of the nearest popup, panel or system popup that holds the element. The key of a system popup is `system_popup_<n>`, where n is its sequence number counting visible system popups from the bottom starting at 0. The scene key when none of the three), `button` (whether a `UIButton` is attached), `pad_action` (whether `button` is `true`, `UIButton.get_action` is not an empty string, and `InputCore.get_pad_buttons` of that action is 1 or more), `modal_covered` (`UICore.is_modal_covered`), `text_input` (whether it is a text input element of `UICore`), `focused` (whether it has engine focus when it is a text input element, otherwise whether it has the focus of `UICore`). A visible element is a UI element whose own engine display state and those of all its ancestors are on, and modal covered elements are also included. Invisible elements and the debug layer are left out. All are returned with no count limit. The engine mapping of text element, visible element, `font_size` and `clipped` is in the per-engine implementation rules
- For UI quality check, the tool runs `capture_screen` and `list_ui` through the automation channel for each combination in the order below
  1. For each language of game settings `supportedLanguages`, calls `set_language` and waits until `boot_stage` becomes `Done`
  2. For each item of game settings `uiCheckScreens` whose orientation equals the orientation of game settings `baseResolution`, calls `set_test_screen`(`window`, `fillMode`) and `set_virtual_notch`(`notch`). The orientation is `Landscape` when the width is greater than the height, otherwise `Portrait`
  3. For each content command of `list_commands` whose name is `<feature>.open_<screen>`, calls that command and then reads `get_state` until `ui_flow` is `false` and `finite_tweens` is 0, at most `uiQuality.settleLimitMs` of game settings in real time, so that the opening presentation of the screen has ended. When it fails, the UI quality check of that screen fails
  4. For text scale 1000 and for the largest value of `AccessibilityCore.textScales`, calls `set_text_scale`. When `AccessibilityCore` is not in the module list, does not call it and captures once
- keyboard capture: when `keyboard` of the item of 2 is 1 or more, for each capture of 4, for each element of that `list_ui` whose `text_input` is `true` and `modal_covered` is `false`, in turn: puts in a `tap` at the center of the element's `rect`, calls `set_virtual_keyboard`(`keyboard`), runs `capture_screen` and `list_ui`, then calls `set_virtual_keyboard`(`none`) and the command of 3
- gamepad focus check: when game settings `gamepadSupported` is `true`, after all captures above end, with the first language of 1, the first item of 2 and text scale 1000, does the following for each screen of 3. Elements are told apart by `path`
  1. Calls the command of 3, `set_input_device`(`Gamepad`), `list_ui` in order. A target button is an element whose `button` is `true` and `modal_covered` is `false`. The reached buttons are initially the element whose `focused` is `true` and the target buttons whose `pad_action` is `true`
  2. Expands reached buttons b one at a time until no unexpanded reached button is left. Expanding: for each gamepad button `dpad_up`, `dpad_down`, `dpad_left`, `dpad_right`, calls `focus_ui`(`path` of b), `pad_button_down` and `pad_button_up` of that gamepad button, and `list_ui`, and adds the elements whose `button` and `focused` are `true` to the reached buttons. When `focus_ui` of b fails, b is not expanded
  3. When every target button is a reached button, that screen is `pass`; otherwise it is `fail`, and the `path` of each target button that is not a reached button goes in the result
- UI quality check is `pass` when all of the below hold
  - No capture has an element whose `clipped` is `true` or an overlap. An overlap is two elements whose `text` is not an empty string and whose `owner` is the same, whose `rect`s overlap with an area of 1 or more, and neither of whose `path` is an ancestor of the other's `path`
  - In each `list_ui` of a keyboard capture, there is one element whose `text_input` and `focused` are `true`, and its `rect` lies fully between the top edge of the window and the top edge of the keyboard (window height − `keyboard`)
  - When `gamepadSupported` is `true`, gamepad focus check is `pass` on every screen
  - In each capture of 4 at text scale 1000 that is not a keyboard capture, with the values of game settings `uiQuality`:
    - text sizes: the distinct `font_size` values, rounded to whole pixels, of the elements whose `text` is not an empty string number at most `maxFontSizes`
    - small text: no element whose `text` is not an empty string has `font_size` × 1080 ÷ window height under `minFontPx`
    - contrast: for each element whose `text` is not an empty string and whose `rect` is fully in the window, out of the relative luminances (sRGB) of the capture pixels in its `rect`, the background is the median and the text is the luminance whose distance from the median is at the 99.9th percentile of those distances. Their contrast ratio (lighter + 0.05) ÷ (darker + 0.05) is at least `minContrast`
    - panel body: an element whose `owner` is a popup, panel or system popup key, whose `text` is an empty string, whose `button` and `text_input` are `false`, whose `rect` is at most 90% of the window area and has a shorter side of at least 64 × window height ÷ 1080, that has a descendant element, and none of whose ancestors is such an element of the same `owner`
    - flat panel: in the `rect` of each panel body, out of the capture pixels outside the `rect`s of the elements whose `text` is not an empty string, less than `maxFlatShare` lie within 8 (each of R, G, B) of the most common color of those pixels
    - empty panel: in the `rect` of each panel body, less than `maxEmptyShare` of its area is outside the `rect`s of its descendant elements whose `rect` is smaller than 90% of the panel body `rect`

### QAState

QAState is a JSON object with the fields below as keys. A rectangle is a number array `[x, y, w, h]` in window pixels. `module or value missing` is the value when the module is not in the module list, has not run `init` yet, or before the value is set.

| field | source | JSON | module or value missing |
|---|---|---|---|
| `app_version`, `environment`, `platform` | `BootstrapCore.get_build_info` | string | empty string |
| `data_version` | `DataCore.get_data_version` when `DataCore.is_loaded` is `true` | string | empty string |
| `user_id` | `AuthCore.get_user_id` when `AuthCore.is_logged_in` is `true` | integer | 0 |
| `server_time` | `TimeCore.get_server_time` when `TimeCore.is_synced` is `true` | integer | 0 |
| `boot_stage` | `BootstrapCore.boot_stage` | element name string | |
| `scene_key` | `SceneCore.current_scene_key` | string | empty string |
| `in_transition` | `SceneCore.is_transitioning` | boolean | `false` |
| `ui_flow` | `UICore.is_flow_in_progress` | boolean | `false` |
| `finite_tweens` | `TweenCore.get_finite_playing_count` | integer | 0 |
| `panels` | `UICore.get_panel_stack` | array of panel key strings, from the bottom | `[]` |
| `popups` | `UICore.get_open_popups` | array of popup key strings, from the bottom | `[]` |
| `input_blocks` | `InputBlockCore.list_active` | array with `{"reason": <reason tag>, "caller_location": <caller location>, "elapsed_ms": <block elapsed time>}` per active block | `[]` |
| `language` | `LocalizationCore.get_language_code` when `boot_stage` is one of `Prepare`, `TitleScene`, `Update`, `ApplyUpdate`, `ContentInit`, `Login`, `AfterLogin`, `FirstScene`, `Done` | string | empty string |
| `time_scale` | `TimeCore.get_time_scale` | integer (permille) | 1000 |
| `step_mode` | `TimeCore.is_step_mode` | boolean | `false` |
| `step_budget_ms` | `TimeCore.get_step_budget` | integer | 0 |
| `window_size` | `ResolutionCore.get_window_size` | `[w, h]` integer array | `[0, 0]` |
| `game_area`, `visible_game_area` | `ResolutionCore.get_game_area`, `ResolutionCore.get_visible_game_area` converted to window pixels | rectangle | `[0, 0, 0, 0]` |
| `safe_area` | `SafeAreaCore.get_safe_area` converted to window pixels | rectangle | `[0, 0, 0, 0]` |
| `cutscene_playing` | `CutsceneCore.is_playing` | boolean | `null` |
| `tutorial` | `{"id": <tutorial ID name>, "step": <step>}` when `TutorialCore.current` is not (0, 0), `null` when it is (0, 0) | object or `null` | `null` |
| `completed_tutorials` | JSON object with, for each row of the `tutorial` table whose `TutorialCore.is_completed` is `true`, the tutorial ID name as key and `true` as value | object | `null` |
| `match_state` | `RealtimeCore.match_state` | element name string | `null` |
| `room_code`, `room_mode_id`, `room_mode` | room code, match mode ID value, match mode ID name of `RealtimeCore.room_info`. Empty string, 0, empty string when not in a room | string, integer, string | `null` |
| `content` | JSON object of the callback received through `set_content_state` | object | `{}` |
| `invariant_failures` | names of invariants that gave `false`, in the order they first gave it | string array | `[]` |
| `softlock` | softlock of `### invariant and softlock` | object or `null` | `null` |

- A game has one callback of `set_content_state`, and calling it again replaces the callback. So only one registration function of the game calls `set_content_state`, and that callback holds the values of several features with the feature name as key
- When the callback throws or returns a value that is not a JSON object, `content` is `{}`, and an error log is written the first time for each such callback
- `content` holds the values that the conditions of bot playtest and the metrics of design targets read (item, quantity, HP, progress). It does not hold values that change only by the passing of time (recovery amount grown with time, remaining duration); it holds the saved values those values are calculated from (saved amount, recovery start time). As an exception, it holds the values that decide when an input lands in a scene played in step mode (e.g. the position of a moving target)
- The tutorial ID names of `tutorial`, `completed_tutorials` and the match mode ID name of `room_mode` are found from ID values with `find_id_name`, the DEV accessor of the data tool
- stats: `fps`, `frame_ms`, `static_memory_bytes`, `video_memory_bytes`, `draw_calls`, `primitives`, `object_count`, `last_scene_load_ms` (`duration_ms` of the last `SceneCore.SceneStartedEvent`), `boot_ms` (`duration_ms` of `EventCore.BootCompletedEvent`), `quality_level` (element name of `QualityCore.get_level`. Empty string when the module is missing). The reading method is in the per-engine implementation rules

### invariant and softlock

- invariant: a name and judgement callback that content code in `client/dev/` registered with `register_invariant`. The name is `<feature>.<invariant>`, both parts snake_case
- Each frame, QACore calls the callbacks of the registered invariants. An invariant that returns `false` or throws has its name added to `invariant_failures`, with an error log the first time per name. An added name stays until `release`
- softlock is the first of the below that matches. `null` when none matches or step mode is on
  - `{"kind": "Block", "reason": <reason tag>, "elapsed_ms": <block elapsed time>}`: among the active blocks of `InputBlockCore.list_active`, a block whose reason tag is a key of `QACore.softlockBlockMs` has a block elapsed time of at least that key's value
  - `{"kind": "NoResponse", "elapsed_ms": <elapsed>}`: at least `QACore.softlockNoResponseMs` has passed since the last state event, and the number of inputs in between is at least `QACore.softlockNoResponseInputs`. The elapsed is counted from the last state event, or from `init` when there is no state event yet. The elapsed is measured in advanced ms of `### telemetry`. `clear_telemetry` does not change this start point or the input count
- The keys of `QACore.softlockBlockMs` are the reason tags that are not targets of forced release: `scene`, `cutscene`, `tutorial`, `ad`, `boot`. A block with another reason tag is caught by the error log that forced release of `InputBlockCore` leaves

### telemetry

The play record that the judge agent and performance check read. Times (`started_at`, `at`, `start_at`, `end_at`) are device time of `TimeCore` (Unix ms). `latency_ms`, `play_at`, `duration_ms` of `idle_spans` and `goal_intervals`, and the `QACore.feedbackWindowMs` and `QACore.idleThresholdMs` judgements are measured in advanced ms.

- advanced ms: while step mode is off, the passage of real elapsed time of `TimeCore`; while it is on, the game time that `step` advanced (including the steps of a lockstep match). So time that `step` did not advance while step mode is on, and time spent in the background, are not included

- input: one input command. Its time is when the first device input of that command was put in
- feedback event: the events below. The feedback kind column gives the feedback kind in telemetry

  | event | emitting module | feedback kind |
  |---|---|---|
  | `SoundCore.SoundPlayedEvent` | `SoundCore` | `Sound` |
  | `CameraCore.CameraShakeStartedEvent` | `CameraCore` | `CameraShake` |
  | `ScreenEffectCore.ScreenEffectStartedEvent` | `ScreenEffectCore` | `ScreenEffect` |
  | `TweenCore.TweenStartedEvent` | `TweenCore` | `Tween` |
  | `PoolCore.EffectSpawnedEvent` | `PoolCore` | `Effect` |

- response event: feedback event, `UICore.UIOpenedEvent`, `UICore.UIClosedEvent`, `SceneCore.SceneEndedEvent`, `Response` mark
- state event: response event, `UserStateCore.UserStateChangedEvent`, `SceneCore.SceneStartedEvent`, mark
- record items

  | item | rule |
  |---|---|
  | `inputs` | per input `at`, `command`, `latency_ms` (until the first response event after the input. `null` when there is none within `QACore.feedbackWindowMs`), `feedback` (count per feedback kind) |
  | `rewards` | For each `ItemChange` of `UserStateCore.ItemChangedEvent` whose change amount (the big encoding pair `delta`, `big_delta` of the contract) is 1 or more and whose `source` is not `Cheat` or `PlaySessionRefund`: `at`, `play_at`, `kind` (`Item`), `id` (item ID value), `amount` (the change amount; 2^53−1 when it exceeds 2^53−1). For each `Reward` mark: `at`, `play_at`, `kind` (`Mark`), `id` (ID value of the mark), `amount` (1) |
  | `marks` | per `mark` `at`, `play_at`, `kind` |
  | `idle_spans` | When a span with no input and no state event is longer than `QACore.idleThresholdMs`: `start_at`, `end_at`, `duration_ms` (advanced ms in that span). For a span still going on at `get_telemetry`, `end_at` and `duration_ms` are `null` |
  | `goal_intervals` | For each span from the telemetry start or the previous `Goal` mark to the next `Goal` mark: `start_at`, `end_at`, `duration_ms` (advanced ms in that span), `input_count` |
  | `scene_loads` | per `SceneCore.SceneStartedEvent` `at`, `scene_key`, `duration_ms` |

- A feedback event is counted in the `feedback` of the last input among the inputs whose time is within `QACore.feedbackWindowMs`
- `play_at` is the advanced ms from the telemetry start to that moment. `at` is device time, which also includes the time between steps
- Each item keeps up to `QACore.telemetryMaxRecords` records. Beyond that, the oldest are discarded first and added to `dropped`
- telemetry JSON: `started_at`, `inputs`, `rewards`, `marks`, `idle_spans`, `goal_intervals`, `scene_loads`, `dropped`
- Content reports the `Fail`, `Restart`, `Goal`, `Reward`, `Response` moments. Non-DEV content code emits a content event at that moment, and a registration function in `client/dev/` subscribes to that event and calls `mark`

### automation channel

- The runner listens as a WebSocket server on `127.0.0.1`, and QACore connects to that server. QACore does not listen on a socket. This keeps the same path on every platform without a listen socket, which browsers block
- QACore reads `OGW_AUTOMATION_PORT`, `OGW_AUTOMATION_TOKEN` with `BootstrapCore.get_launch_value` and connects to `ws://127.0.0.1:<port>`. When the port or token is an empty string, it does not connect and leaves no log. When it cannot connect, it leaves an error log and continues without a channel
- A message is one UTF-8 JSON in one WebSocket text message. A message QACore receives is at most `QACore.channelMessageMaxBytes`
  - hello: the first message QACore sends right after connecting, `{"token": "<token>"}`. The runner drops the connection when the token is wrong
  - request: `{"id": <int>, "command": "<name>", "args": ["<string>", ...]}`
  - response: `{"id": <int>, "ok": <bool>, "result": <JSON value>, "bytes": "<base64 or empty string>"}`. `result` is the `result` of the command, and `null` when there is no `result`. The English reason of a failed command is written as a JSON string
  - frame: `{"id": <id of the request>, "frame": <n>, "bytes": "<base64 PNG>"}`. One per frame `capture_video` captured, and `n` starts at 0
- On receiving a message over the length limit, QACore drops the connection and leaves a warn log. The token is not written to any log
- A request format violation is not handled as a command; QACore answers with `{"id": <id>, "ok": false, "result": "malformed request", "bytes": ""}` without a log. `<id>` is 0 for a message that cannot be read as JSON, is not a JSON object, or whose `id` is not a JSON number without a fractional part. For a message whose `id` is right but whose `command` is not a string or whose `args` is not an array of strings only, `<id>` is that `id`
- A dropped connection is not reconnected. A connection dropped by the reverse release of a restart is connected again by `init` of the new boot

### headless run and bot connection

- headless run: a run started so that the engine draws no screen and plays no sound. Whether it is headless is read from the engine; the method is in the per-engine implementation rules. Boot, modules and the automation channel are otherwise the same. `capture_screen`, `capture_video` fail. `get_stats` succeeds, and the stats that depend on screen drawing, `video_memory_bytes`, `draw_calls`, `primitives`, are 0
- bot connection: a tool reading `get_state` through the automation channel and putting in real input with input commands. Bot playtest and the bot client of an instance use the same path
- A client a bot drives runs `AuthCore.dev_login` with the dev account of launch value `OGW_DEV_ACCOUNT`, so it reaches `Done` without the terms popup. The bot waits with `get_state` until `boot_stage` becomes `Done`

### debug screen

- The debug layer is the `Debug` layer of `UICore.get_layer`. Time scale and pause do not affect it
- The per-engine implementation rules set the input that opens and closes the debug screen. It is received through `InputCore.set_debug_input_handler`, so it works during an input block too. Opening calls `InputCore.cancel_input`
- The debug screen shows `QAState`, the last command result, the command list and argument input. All text is English and uses no translation
- The performance stats display shows on the debug layer even while the debug screen is closed and refreshes every `QACore.statsRefreshMs`. It is off at first

### lifecycle

- `init`: leaves the debug screen closed, starts telemetry, subscribes to events and connects to the automation channel
- `release`: ends the commands in handling or waiting with `ok` = `false`, drops the connection, deletes the registered content commands, invariants, `invariant_failures`, the content state callback, telemetry, event subscriptions and the record of inputs held by input commands, and destroys the debug screen

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| Unknown command, argument count or format violation | `ok` = `false` | warn |
| content command handler failure, command time limit exceeded | `ok` = `false` | warn |
| Name format violation in `register_command`, a name that already exists | not registered | error |
| `mark` with an undefined kind | not recorded | error |
| Name format violation in `register_invariant`, a name that already exists | not registered | error |
| invariant gives `false` or throws | added to `invariant_failures` | error the first time per name |
| Received message exceeds the length limit | drops the connection | warn |
| Request format violation in a received message | `malformed request` response | none |
| content state callback throws or returns a value that is not a JSON object | `content` = `{}` | error the first time per callback |
| Cannot connect to the automation channel | continues without a channel | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `QACore.commandTimeoutMs` | integer | core | human | time limit of one command. 1 or more |
| `QACore.channelMessageMaxBytes` | integer | core | content | maximum bytes of one message QACore receives on the automation channel |
| `QACore.statsRefreshMs` | integer | core | content | refresh interval of the performance stats display. 1 or more |
| `QACore.textMaxChars` | integer | core | content | maximum number of characters of the `text` command string |
| `QACore.videoFps` | integer | core | human | frames per second of `capture_video`. 1 or more |
| `QACore.captureJpgQuality` | integer | core | human | quality of the JPEG of `capture_screen` and `capture_video` with `jpg`, in permille. 1 to 1000 |
| `QACore.videoMaxMs` | integer | core | human | maximum length of one `capture_video`. 1 or more |
| `QACore.feedbackWindowMs` | integer | core | human | duration after an input in which response and feedback are counted |
| `QACore.idleThresholdMs` | integer | core | human | minimum length that makes an idle span |
| `QACore.telemetryMaxRecords` | integer | core | human | maximum number of records per telemetry item |
| `QACore.softlockBlockMs` | object | core | human | block elapsed time that makes a softlock, per reason tag `scene`, `cutscene`, `tutorial`, `ad`, `boot` |
| `QACore.softlockNoResponseMs` | integer | core | human | elapsed time without a state event for input that makes a softlock |
| `QACore.softlockNoResponseInputs` | integer | core | human | number of inputs after the last state event that makes a `NoResponse` softlock. 1 or more |
| `QACore.stepMaxMs` | integer | core | content | maximum ms of one `step` command. 1 or more |
| `QACore.timeScaleMaxPermille` | integer | core | content | maximum permille of the `set_time_scale` command. 1000 or more |
| `QACore.touchIndexCount` | integer | core | content | number of touch indexes QACore uses. A touch index is 0 or more and less than this value |
| `AccessibilityCore.textScales` | array<integer> | core | human | list whose largest value UI quality check uses as text scale |
| `baseResolution` | array<integer> | game | none | base resolution that `set_test_screen` passes to `ResolutionCore.set_test_screen` |
| `uiCheckScreens` | array<object> | game | none | list of screens UI quality check captures. An item is `name` (snake_case), `window` (window width, height in pixels), `fillMode` (`Crop`, `Letterbox`), `notch` (left, top, right, bottom in integer window pixels), `keyboard` (on-screen keyboard height for keyboard capture, in window pixels. 0 means no keyboard capture) |
| `gamepadSupported` | boolean | game | none | When `true`, UI quality check runs gamepad focus check |
| `uiQuality` | object | game | none | the numbers of UI quality check: `settleLimitMs` and the presentation conditions `maxFontSizes`, `minFontPx`, `minContrast`, `maxFlatShare`, `maxEmptyShare`. The defaults are in the game settings schema |
| `supportedLanguages` | array<string> | game | none | list of languages UI quality check runs through |

## data

used table: `language`, `tutorial`. `set_language` reads the `language` table of `LocalizationCore`, and `completed_tutorials` reads the `tutorial` table of `TutorialCore`

## DEV

The whole module is DEV code. STG·PROD builds have no QACore, no DEV registration list and no cheat request type.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `run_command` | name, argument list | async operation. (`ok`, `result`, `bytes`) | `ok` = `false` | QACore, test |
| `register_command` | name, description, argument name list, handler | success flag | `false` | `client/dev/` content code |
| `set_content_state` | callback that returns a JSON object | none | none | `client/dev/` content code |
| `mark` | one of `Fail`, `Restart`, `Goal`, `Reward`, `Response`, ID value (`Reward` only. 0 when none) | none | none | `client/dev/` content code |
| `register_invariant` | name, callback that returns true or false | success flag | `false` | `client/dev/` content code |
| `is_headless` | none | whether it is a headless run | `false` | all DEV code |

## test

- `capture_screen` with `jpg` gives JPEG bytes (starting with `FF D8`) of the window size, with `png` and without an argument PNG bytes, and with another format fails. `capture_video` with `jpg` sends JPEG frames
- During the open tween of a popup, `get_state` has `ui_flow` `true` and `finite_tweens` 1 or more, and after the open flow ended with no other tween, `ui_flow` is `false` and `finite_tweens` is 0
- Of two commands put in one after another, handling of the second starts after the first ends. A `tap` put in right after `capture_video`(1000) ends before `capture_video` ends, and a second `capture_video` put in meanwhile is `ok` = `false`
- An unknown name, a wrong argument count, `0`·`-1`·`1e3`·`.5`·`QACore.timeScaleMaxPermille` + 1 for `set_time_scale`, `1.5`·`+5`·a leading space·19 digits for `set_server_time_offset`, `set_language` with a language that is not supported, `-1 0 0 0`·`NONE` for `set_virtual_notch`, `0`·`QACore.videoMaxMs` + 1 for `capture_video`, `-1`·`others` for `drop_peer` give `ok` = `false` and a warn log without the target operation
- Each command has one info log with the name and `ok`, and arguments are not in the log
- On the automation channel, the `tap` response `result` is `null`, and the `capture_video` response `result` is a JSON object with keys `frame_count`, `fps`
- For a non-JSON message, a JSON array and a message whose `id` is `1.5` received on the automation channel, a response with `id` 0, and for a message whose `id` is 7 and whose `command` is a number or whose `args` holds a number, a response with `id` 7, comes back with `ok` = `false` and `result` `malformed request`; no command is handled and there is no log
- `get_state` from `InitModules` until before login returns without an error log, and before those values are set, `data_version` and `language` are empty strings and `user_id` and `server_time` are 0. The fields of modules not in the module list are `null`
- Putting a `tap` at the window pixel at the center of a UI button rectangle that `list_ui` gave makes one click of that button. The same holds in a Letterbox window. A `tap` under a block with a reason is blocked the same as human input
- `tap_anchor` presses the center of the anchor, and fails for a missing anchor and for an anchor inside a panel under an open modal popup. When two anchors with the same name have as anchor key the ID value of an item and 9, `tap_anchor`(name, that item ID name) and `tap_anchor`(name, `9`) each press the center of the anchor with that key, and anchor keys of an ID name that does not exist, `0`, `-1`, `9.5` fail without the target operation. `rect` of `get_anchor` is the rectangle of `UICore.get_anchor_rect` converted to window pixels
- After every touch index is pressed with `touch_down`, `tap`, `tap_anchor`, `drag` are `ok` = `false` without device input, and `touch_down`(`QACore.touchIndexCount`) is `ok` = `false` without the target operation
- `drag`(x1, y1, x2, y2, `0`) puts in the move to (x2, y2) and the release on the frame after the press
- In the process frame in which a UI element that receives the press of an input command without consuming it receives that press, `InputCore.is_just_pressed` of the action bound to the same input is `true`. When a `UIButton` that clicks on an accept input press has focus, in the process frame in which `key` (the key of the accept input) clicks it, `InputCore.is_just_pressed` of the action bound to that key is `true`
- `drag` makes `Start`, `Move`, `End` of `InputCore.DragEvent`, `key` keeps the action pressed for `ms`, and `text` puts that string into the `UICore` text input element that has engine focus
- Putting in `key_down`, `touch_down`(0), `touch_down`(1) in order, each command ends on the next frame, and after the third ends, the action of that key is pressed and the two touches are pointers pressed at the same time. `touch_move`(0) makes `InputCore.DragEvent` of that pointer, and after `touch_up`, `key_up` they are released
- `mouse_down` changes `InputDevice` to `KeyboardMouse`, `pad_button_down` changes it to `Gamepad`, and after `pad_axis`(axis, `1`) the strength of the action bound to the `+` direction of that axis is 1, and after `pad_axis`(axis, `0`) it is 0
- `touch_down` of a pressed index, `touch_up` of an index not pressed, `key_down` of a pressed key, a `pad_axis` value out of range, an unknown gamepad button name, and `mouse_left` for `mouse_down` are `ok` = `false` without the target operation
- `mouse_down`(`left`, x, y), `mouse_down`(`right`, x, y), `mouse_down`(`middle`, x, y) press, in order, the actions bound to the `InputCore` names `mouse_left`, `mouse_right`, `mouse_middle`
- After `pad_button_down` and `pad_axis`, `InputCore.get_connected_gamepads` does not change and there is no `InputCore.GamepadConnectionChangedEvent`
- When `QACore.textMaxChars` is 1, `text` of a string made of U+1F44D and U+1F3FD is `ok` = `false` without the target operation, and when it is 2, the same `text` puts in two text inputs, one per frame over two frames
- Dropping the automation channel connection while input is held by input commands releases every pressed input and sets gamepad axes to 0. Dropping it while a `drag`(1000) received through that connection is in handling and a `touch_down` after it is waiting ends both commands with `ok` = `false`, and no device input comes in after that
- On a screen without motion, the PNG captured with the debug screen and performance stats on has the same pixels as the PNG captured with them off. In headless, `capture_screen`, `capture_video` fail, `get_stats` succeeds, and `video_memory_bytes`, `draw_calls`, `primitives` are 0
- A `capture_video`(1000) received on the automation channel sends as many frame messages as `QACore.videoFps` before the response, and `frame_count` of the response is that number. When `QACore.videoFps` is 30, `frame_count` of `capture_video`(1001) is 30, and the real elapsed time at which capture of frame n starts is at least ⌊n × 1000 ÷ 30⌋ ms from the start. Even when one capture takes longer than the frame interval, frame numbers 0 to 29 are each sent once. A `capture_video` called without an automation channel connection fails
- `list_ui` leaves out invisible elements, elements under a hidden ancestor and the debug layer, and includes modal covered elements. `clipped` is `true` for text that overflows the visible line count and for one-line text that does not wrap and overflows horizontally, and `clipped` is `false` for text cut by ancestor clipping, text outside the window and a multi-line text input element. Two texts with different font sizes get different `font_size`, and the `font_size` of an element with vertical scale 2 is twice that of a scale 1 element with the same character size. The `text` of rich text with markup is the string with markup removed. The `owner` of an element inside a panel opened over a scene is that panel key, and the `owner` of an element outside the panel is the scene key
- `go_to_scene`, `open_panel`, `drop_peer`, `drop_matchmaker` call the target operation once, and `ok` equals its result. The clear stack of `open_panel` is `false`. When `RealtimeCore` is not in the module list, `drop_peer`, `drop_matchmaker` fail
- `set_test_screen` calls `ResolutionCore.set_test_screen` once and `ok` = `true`. After `set_test_screen`(`800`, `600`, `Letterbox`), the `capture_screen` PNG is 800 wide and 600 high, and a `tap` put at the center of a UI button rectangle that `list_ui` gave is one click of that button
- In a `Playing` match with 3 participants, `drop_peer`(`other`) calls `RealtimeCore.force_peer_lost`(1) when the own index is 0, and `RealtimeCore.force_peer_lost`(2) when the own index is 1 and index 0 is `Disconnected`. When there is no other participant that is `Connected`, `ok` = `false` without the target operation
- `set_user_state` sends one `SetUserState` with ID names converted to ID values. For a decimal integer item, that value is the item ID; ID name strings inside the value JSON become ID value integers; and for a list kind, `id` of the JSON is the item ID. An ID name that does not exist and broken JSON fail without a request. `set_user_state`(kind, `[]`, value) and `delete_user_state`(kind, `[]`) of a single kind send a request with item ID 0, and `[]` and `-1` for a list kind, `0` for a single kind, and a kind name not in the list fail without a request. `set_item_balance` sends one `SetItemBalance`, and the balance of the response delta shows in `UserStateCore.get_item_balance`. `set_item_balance` with balance `12345678901234567890` sends `balance` 0 and its `big_balance`, and `-1` and `01` fail without a request
- `set_mission_progress`, `set_reset_counter` send one `SetMissionProgress`, `SetResetCounter` with ID values converted. `set_quality_level`, `set_text_scale` call the target DEV operation once, and `quality_level` of `get_stats` is that level. `low` for `set_quality_level` and `999` for `set_text_scale` fail without the target operation
- `set_language`, `restart` emit `EventCore.RestartRequestedEvent` once after sending the response
- `set_network_delay`, `expire_access_token`, `set_social_account`, `simulate_push`, `set_push_permission` call the target DEV operation once. When `PushCore` is not in the module list, `simulate_push`, `set_push_permission` fail. `simulate_push` with an ID name that does not exist and `set_social_account` with a name that is not snake_case fail without the target operation
- The `result` of `get_requests`, `get_user_state`, `get_resources`, `get_sound` is the target operation's result moved into the JSON fields of the table. `get_user_state` with an unknown kind name fails. Non-JSON text, `[]`, a negative offset and a `1.5` offset for `extract_logs` fail without the target operation, and the offset of a path not in the list does not change the result. For a log file whose bytes are `a`, `한` (3 bytes), `b`, offset 2 gives `offset` 4 and `content` `b`. The `content` of a file containing one byte 0xFF that cannot be read as UTF-8 holds one U+FFFD in its place
- For each built-in command of `list_commands`, `args` equals `args` of the table and `description` is not an empty string. `args` of `tap_anchor` is `["anchor", "key"]`
- The result of a content command equals the handler result, and a second registration with the same name leaves an error log and the first handler stays
- After `set_content_state` is called again, `content` of the next `get_state` is the value of the later callback. For a callback that returns a value that is not a JSON object, `content` is `{}` and there is one error log for that callback
- When `SoundCore.SoundPlayedEvent` and `TweenCore.TweenStartedEvent` come d ms of test clock after a `tap`, `latency_ms` of that input is d and `feedback` is `Sound` 1, `Tween` 1. Events after `QACore.feedbackWindowMs` are not counted, and when there is no response event within it, `latency_ms` is `null`
- When a `Response` mark comes d ms of test clock after a `tap` without a feedback event, `latency_ms` of that input is d and `feedback` is empty
- For each `ItemChange` of `UserStateCore.ItemChangedEvent` with a change amount of 1 or more, one row of `kind` `Item` whose `amount` is the change amount is recorded in `rewards`, and when `big_delta` is `12345678901234567890`, `amount` is 2^53−1. One with a change amount of 0 or less or whose `source` is `Cheat` or `PlaySessionRefund` is not recorded. For each `Reward` mark, one row of `kind` `Mark` is recorded
- Each kind of `mark` is recorded in `marks`, and the number of inputs between two `Goal`s is `input_count` of `goal_intervals`
- When `QACore.idleThresholdMs` + 1 passes without input and state event, `idle_spans` has one span
- For each `SceneCore.SceneStartedEvent`, one entry with that event's `scene_key` and `duration_ms` is recorded in `scene_loads`
- After `QACore.telemetryMaxRecords` + 1 inputs, `inputs` holds the limit count and `dropped` is 1. After `clear_telemetry`, every item is empty and `dropped` is 0
- QACore connects to a loopback WebSocket server the test started and sends a hello holding the token as the first message. The response of a command sent through that connection equals the result of the same `run_command`. Receiving a message over the length limit drops the connection. The log has no token string. With `UnitTestCore.require_platform`(`android`, `ios`, `windows`, `macos`, `linux`), this test does not run in a browser run
- When the port or token launch value is missing, QACore does not connect and there is no log
- `release` drops the connection and there is no debug screen. A new `init` connects again
- Even under an input block, pause and time scale 100, the debug screen opens and commands end
- When a registered invariant gives `false`, its name is in `invariant_failures` of the next `get_state`, and there is one error log per name. A name format violation and a second registration with the same name give an error log and `false`
- When a block with reason tag `cutscene` has run for the `cutscene` value of `QACore.softlockBlockMs` − 1, `softlock` is `null`, and when it has run for that value, `kind` is `Block`. When `QACore.softlockNoResponseInputs` − 1 inputs are put in without a state event and `QACore.softlockNoResponseMs` passes, `softlock` is `null`, and with one more input `kind` is `NoResponse`. With step mode on, it is `null`. When there is no state event after `init`, the elapsed is counted from `init`, and calling `clear_telemetry` in between gives the same result
- Under `set_time_scale`(500), the command time limit of `step`(ms) is `QACore.commandTimeoutMs` + ms × 2
- After `set_step_mode`(`on`), when `step`(100) ends, game time has grown by 100, and `step_mode` of `get_state` is `true` and `step_budget_ms` is 0. `step` when not in step mode, `set_step_mode` when `RealtimeCore.match_state` is not `None`, and 0 and `QACore.stepMaxMs` + 1 for `step` are `ok` = `false` without the target operation
- When `RealtimeCore.match_state` is `Matching`, `leave_match` calls `RealtimeCore.leave` once, `RealtimeCore.match_state` is `None` when it ends, and a `set_step_mode`(`on`) sent next succeeds. `leave_match` when `None` is `ok` = `true` without `RealtimeCore.leave`, and when `RealtimeCore` is not in the module list it is `ok` = `false`
- After `RealtimeCore.create_room` ends with `ok`, `room_code`, `room_mode_id`, `room_mode` of `get_state` are the room code and match mode ID value of `RealtimeCore.room_info` and the ID name of that ID value, and after `RealtimeCore.leave_room` they are empty string, 0, empty string. When `RealtimeCore` is not in the module list, all three are `null`
- When `TutorialCore` has a current tutorial, `tutorial` of `get_state` is the ID name and `step` of that tutorial; otherwise it is `null`. `completed_tutorials` has only the ID names of completed tutorials as keys. When `TutorialCore` is not in the module list, both are `null`
- In `Playing` of a lockstep match, `step` calls `RealtimeCore.request_step` once and ends with its result
- In `Playing` of a lockstep match, when `step` exceeds the command time limit because another participant does not send its step end, it is `ok` = `false` and `step_budget_ms` and `step_mode` do not change. A `step` received before that `RealtimeCore.request_step` ends is `ok` = `false` without calling `RealtimeCore.request_step`
- From `set_step_mode`(`on`) to `set_step_mode`(`off`), the block elapsed time of active blocks does not grow and there is no forced release
- In step mode, time stopped between `step`s is not included in `latency_ms` or in `duration_ms` of `idle_spans`·`goal_intervals`
- With step mode off, when after `mark`(`Fail`) only the device time of the test clock grows by 60000 and `mark`(`Restart`) is called after one test frame that advances 100 ms, the `play_at` difference of the two marks is 100. Adding one background advance of 30000 ms between the two marks also leaves the `play_at` difference at 100
- In step mode, when 1000 ms pass without `step` after `mark`(`Fail`) and `mark`(`Restart`) is called after `step`(100), the `play_at` difference of the two marks is 100 and the `at` difference is 1000 or more
- In step mode, while `TimeCore.set_paused`(true) is in effect, `step`(50) is `ok` = `false` and `step_budget_ms` of `get_state` is 0. After `TimeCore.set_paused`(false), advancing frames leaves game time unchanged
- In step mode, when content calls `TimeCore.set_paused`(true) after `step`(1000) is sent and before that game time has passed, that `step` is `ok` = `false` (`game time is paused`) no later than the frame after that call, before the command time limit, and `step_budget_ms` is 0. When the budget became 0 in the frame of that call, that `step` is `ok` = `true`
- Even while the engine does not draw the window (e.g. a window fully covered by other windows), `capture_screen` returns a PNG
- `set_virtual_keyboard`(`300`) calls `SafeAreaCore.set_virtual_keyboard`(300) once and `none` calls `SafeAreaCore.clear_virtual_keyboard` once, and `0` and `-1` are `ok` = `false` without the target operation
- `set_input_device`(`Gamepad`) calls `InputCore.set_test_device`(`Gamepad`) once, and after it ends, in `list_ui` only the focus element of the topmost modal popup has `focused` `true`. `gamepad` is `ok` = `false` without the target operation
- When the input device is `Gamepad`, `focus_ui` calls `UICore.set_test_focus` with a `UIButton` element of a focus target instance, and in the next `list_ui` only that element has `focused` `true`. A `path` that does not exist and an element for which `UICore.set_test_focus` is `false` give `ok` = `false`
- In `list_ui`, a `UIButton` element of a panel under a modal popup has `modal_covered` `true`, and an element inside that popup has `false`. A `UIButton` with an action that has a gamepad button binding has `pad_action` `true`, and `false` when it has no action or that action has no gamepad button binding. An element without a `UIButton` has `button` and `pad_action` `false`. A text input element pressed with `tap` has `text_input` and `focused` `true`. The `owner` of an element inside a visible system popup is `system_popup_0`
