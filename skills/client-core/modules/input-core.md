# InputCore

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

Turns device input into actions and gestures and delivers them. Handles the input processing order, input device switching, changes of key bindings and gamepad button bindings, and input prompts.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `DataCore`, `ResolutionCore`, `InputBlockCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `has_action` | action | whether it is in the action list | `false` | core |
| `is_pressed` | action | pressed flag | `false` | core, content code |
| `is_just_pressed` | action | whether it was pressed this frame | `false` | core, content code |
| `is_just_released` | action | whether it was released this frame | `false` | core, content code |
| `get_strength` | action | strength (0 to 1) | 0 | core, content code |
| `get_vector` | negative x, positive x, negative y, positive y actions | 2D value | (0, 0) | core, content code |
| `get_mouse_position` | none | (`true`, mouse position) when there is a mouse position, otherwise (`false`, (0, 0)) | (`false`, (0, 0)) | content code |
| `get_mouse_motion` | none | mouse motion of this frame | (0, 0) | content code |
| `get_device` | none | `InputDevice` | `Touch` | core, content code |
| `get_last_gamepad` | none | gamepad ID of the last gamepad. −1 when there is no last gamepad | −1 | `SoundCore` |
| `get_connected_gamepads` | caller buffer | number of gamepad IDs filled. Fills the gamepad IDs of the connected gamepads in ascending order | 0 | core, content code |
| `set_pinch_enabled` | whether to enable | none | none | content code |
| `inject_action` | action, `pressed`, strength, pointer ID(optional) | none | none | `VirtualPadCore`, core test, client regression test |
| `cancel_input` | none | none | none | `QACore`, core test, client regression test |
| `get_cancel_count` | none | number of input cancels since `init` | 0 | `VirtualPadCore`, `UICore` |
| `set_back_handler` | callback(→ whether it consumed the back input) | none | none | `UICore` |
| `set_ui_pointer_observer` | callback(pointer ID, whether pressed, game coordinates position) or none | none | none | `TutorialCore` |
| `get_keys` | action, caller buffer | number of keys and mouse buttons filled | 0 | core, content code |
| `set_keys` | action, list of keys and mouse buttons | success flag | `false` | content code |
| `reset_keys` | none | none | none | content code |
| `load_keys` | none | none | none | `BootstrapCore`(`InitModules`) |
| `wait_key` | none | async operation. the key or mouse button pressed next | key none | content code |
| `cancel_wait_key` | none | none | none | content code |
| `get_pad_buttons` | action, caller buffer | number of gamepad buttons and gamepad axis directions filled | 0 | core, content code |
| `set_pad_buttons` | action, list of gamepad buttons and gamepad axis directions | success flag | `false` | content code |
| `reset_pad_buttons` | none | none | none | content code |
| `wait_pad_button` | none | async operation. the gamepad button or gamepad axis direction pressed next | button none | content code |
| `get_prompt_family` | none | prompt family(`InputPromptFamily`) | `Touch` | core, content code |
| `get_prompt` | action, the caller's `InputPrompt` | success flag. When `true`, fills `InputPrompt` | `false` | `LocalizationCore`, content code |

- `InputDevice`: `Touch`, `KeyboardMouse`, `Gamepad`. `GesturePhase`: `Start`, `Move`, `End`, `Cancel`. `BindingContext`: `Gameplay`, `Ui`, `Cutscene`
- `InputPrompt`: `family`(`InputPromptFamily`), `input`(prompt input), `icon`(`icon` resource key of the `input_prompt` row. Empty string when there is none), `name_key`(`name` translation key of the `input_prompt` row. none when there is no row). `InputPromptFamily` is an enum in `## data`
- `get_keys`, `set_keys`, `wait_key` exchange keys as key names (strings that the engine-specific implementation rules define) and mouse buttons as mouse button names. `get_pad_buttons`, `set_pad_buttons`, `wait_pad_button` exchange gamepad button names and gamepad axis direction names. key none and button none are the empty string
- Input handling, `is_pressed`, `is_just_pressed`, `is_just_released`, `get_strength`, `get_vector`, gesture judgement and event publishing do not allocate memory. Logs are excluded

## behavior

### action

- action: a snake_case name that states the meaning of an input. e.g. `confirm`, `move_left`. Each action has a binding (the list of device inputs that press that action)
- The action list and the default bindings are in the input map. The engine-specific implementation rules define the location and format of the input map. When the engine does not provide an input map, the engine-specific implementation rules define one file that the client core reads as the input map
- gamepad button names: `a`, `b`, `x`, `y`, `back`, `guide`, `start`, `left_stick`, `right_stick`, `left_shoulder`, `right_shoulder`, `dpad_up`, `dpad_down`, `dpad_left`, `dpad_right`. The engine mapping is in the engine-specific implementation rules
- gamepad axis names and ranges: `left_x`, `left_y`, `right_x`, `right_y` are from −1 to 1, and `trigger_left`, `trigger_right` are from 0 to 1. The engine mapping is in the engine-specific implementation rules
- gamepad axis direction name: a gamepad axis name followed by `-` for the negative direction or `+` for the positive direction. e.g. `left_x-`. `trigger_left` and `trigger_right` have only `+`. The strength of an axis direction is the magnitude of the axis value in that direction, and it is 0 when that magnitude is less than `InputCore.padAxisDeadzone`. One gamepad axis input is, for each direction of that axis, a press of that gamepad axis direction when the strength of that direction is greater than 0, and a release of that gamepad axis direction when it is 0. The previous gamepad axis input is the gamepad axis input right before it on the same axis of the same gamepad, and when there is none, the axis value counts as 0. A press whose direction strength was greater than 0 in the previous gamepad axis input is a press that changes only the strength. One input whose value goes directly from positive to negative is a release of the positive direction and a press of the negative direction. Action state, device detection, back handling and key wait all use this strength
- mouse button names: `mouse_left`, `mouse_right`, `mouse_middle`. The engine mapping is in the engine-specific implementation rules
- core action: an action whose name the core defines. They are `back` (default binding ESC key, gamepad button `b`), `cutscene_advance` (`CutsceneCore` uses it for line progress. default binding Space key, Enter key, gamepad button `a`) and `cutscene_skip` (`CutsceneCore` uses it for skip. default binding Tab key, gamepad button `start`). When even one core action is missing from the input map, `init` leaves an error log and fails
- Content code does not read device input directly. It receives world input with `is_pressed`, `is_just_pressed`, `is_just_released`, `get_strength`, `get_vector` and gesture events. It receives the mouse position and mouse motion with `get_mouse_position` and `get_mouse_motion`. Content code selects world objects by the position of gesture events
- binding context: the `BindingContext` defined per action by its name. `back` and actions whose names start with `menu_` are `Ui`, actions whose names start with `cutscene_` are `Cutscene`, and the others are `Gameplay`
- overlapping action: two actions with the same binding context. Two actions that are overlapping actions do not both have the same key, mouse button, gamepad button or gamepad axis direction in their bindings. Two actions with different binding contexts can both have the same key, mouse button, gamepad button or gamepad axis direction
- When two actions that are overlapping actions have the same key, mouse button, gamepad button or gamepad axis direction in the default bindings, `init` leaves an error log and fails

### input processing order

Device input is handled in the order below.

1. debug stage: an input that the debug input handler of DEV code handled is not used in later stages. When there is no handler, every input goes to the next stage
2. fill area stage: when the press position of a pointer is outside `ResolutionCore.get_visible_game_area`, that press is discarded. The left and top edges of the rectangle are inside, and the right and bottom edges are outside. That pointer does not become a passed pointer, so its moves and release are discarded in the block stage
3. block stage: first it does the block start check. A move or release of a pointer is discarded when that pointer is not a passed pointer. Any other input with a position (a pointer press, a press and release of a mouse button that is not a pointer, a mouse move that is not a pointer, a wheel) is discarded when `InputBlockCore.pass_position` of the window pixel position, converted from the game coordinates position of that input with `ResolutionCore.game_to_window`, is `false`. Any other input keeps only the actions it presses or releases for which `InputBlockCore.pass_action` is `true` (passed actions), and is discarded when there is no passed action. The stages after device detection treat that input as an input that presses or releases only the passed actions. Any other input that presses or releases no action is discarded in the blocked state. A key or gamepad input that this rule would discard is not discarded and stays as a focus input when there is a UI element with the engine focus and `InputBlockCore.pass_focus` of that element is `true`. Exception: an input that releases a pressed input source releases that source in action state also when the input is discarded or the action is removed from the passed actions
4. device detection: judges input device switching
5. key wait: when there is a waiting `wait_key` and the input is a key press or a press of a mouse button that has a mouse button name, it passes that key or mouse button and ends. When there is a waiting `wait_pad_button`, it passes the button when the input is a gamepad button press, and passes the gamepad axis direction when the strength of one direction of a gamepad axis input was less than `InputCore.padAxisWaitThreshold` in the previous gamepad axis input and is at least that value in this input, and ends. Key repeat input and a key press without a key name are not passed
6. UI stage: an input that a UI element handled is consumed. Exception: an input that releases a pressed input source releases that source even when consumed
7. world stage: passes the input that is not consumed (world input) to back handling, action state and gesture judgement, in that order

- An input of `inject_action` goes through only the block stage to the world stage. An inject that receives a pointer ID passes the block stage without `InputBlockCore.pass_action` when that pointer is a passed pointer
- passed pointer: a pressed pointer whose press passed the block stage. When `cancel_input` happens after that, it is not a passed pointer. It is a passed pointer until the handling of its release finishes
- For each press and release of a pointer that comes to the UI stage, it calls the callback of `set_ui_pointer_observer` once before passing the input to UI elements. The callback does not consume the input and does not change the handling of that input. Passing none deletes the callback
- mouse input made from touch: mouse input that the engine makes from touch. The engine mapping is in the engine-specific implementation rules. It is not a pointer, and it is not used for the debug stage, device detection, key wait, the callback of `set_ui_pointer_observer`, the world stage (back handling, action state, gesture judgement), the mouse position or the mouse motion. Its left mouse button press follows the pointer press rules in the fill area stage and the block stage. The mouse moves after that press until the release, and that release, also first get the block start check in the block stage, and pass when that press passed both stages and there has been no input cancel since, and are discarded otherwise. Other mouse input made from touch follows the rule for input with a position in the block stage. An input that passed goes to UI elements in the UI stage and does not go to the world stage even when not consumed
- A focus input skips key wait and the world stage. When it is not consumed in the UI stage, it is discarded
- A discarded device input is used only for device detection and not in any other later stage

### back

- back input: a press of `back` among world input. Key repeat and presses that change only the strength are excluded. A release of `back` is ignored
- For each back input, it calls the callback of `set_back_handler` once before passing that device input to action state. The callback returns whether it consumed that back input. When `true`, it does not pass that device input to action state. When `false` or when there is no callback, it passes the device input, by the action state rules, to the actions other than `back` that it presses. `back` is not passed to action state or gesture judgement
- One platform back button (Android back button) request is one inject of a `back` press. The platform back button does not end the app

### action state

- input source: one device input of a binding, or the inject, one per action. Device inputs of gamepad buttons and gamepad axis directions are different sources per gamepad ID. The engine-specific implementation rules define the upper limit on the number of gamepads that hold sources at one time, and presses and axis values of gamepads over the limit leave an error log and are not used as sources
- action state (except `back`): per source, `pressed`(bool), strength (0 to 1), pressed frame, released frame. A pressed source is a source whose `pressed` is `true`
- A world input that presses sets `pressed` of that source to `true` and the strength to the strength of the input. The strength of an input is 1 for a press of a key, mouse button or gamepad button, and the direction strength for a press of a gamepad axis direction. A world input that releases sets `pressed` to `false` and the strength to 0. Key repeat input changes nothing
- When the number of pressed sources goes from 0 to 1, the pressed frame is set to the current frame, and when it goes from 1 to 0, the released frame is set to the current frame
- `is_pressed`: one or more pressed sources. `get_strength`: the maximum strength of the pressed sources. `is_just_pressed`, `is_just_released`: the pressed frame and the released frame, respectively, are the current frame. The pressed frame and released frame of a device input are the first process frame that runs after that input: an input that comes before the process callback of frame F runs (between frames, during a physics step of F, during the frame start signal of F) is F, and an input that comes after the process callback of F starts running is F+1. Injects and the releases by `cancel_input` and gamepad disconnection are not device inputs, and their frame is the current frame. When a press or release of the same action that is not a device input comes after a device input whose pressed frame or released frame is not decided yet, the frame of both is the current frame
- `get_vector`: x is positive x strength − negative x strength, and y is positive y strength − negative y strength. When the length is more than 1, it keeps the direction and reduces the length to 1

### input device

- The current input device is the device of the device input last used for device detection. When it changes, it publishes `InputDeviceChangedEvent`
- input not used for device detection: a gamepad axis input that presses no action
- device of a device input: touch is `Touch`, mouse, key and text character input are `KeyboardMouse`, and gamepad buttons and gamepad axes are `Gamepad`. Key input and text character input made by the OS screen keyboard are also `KeyboardMouse` and are used for device detection
- The value at `init` is `Touch` when the platform is `android` or `ios`, and `KeyboardMouse` otherwise
- last gamepad: the gamepad that produced the gamepad input last used for device detection. There is none at `init`. A gamepad ID is an integer of 0 or more that the engine gives per gamepad, and the engine mapping is in the engine-specific implementation rules
- connected gamepad: a gamepad that the engine reported as connected. `init` puts the gamepads connected at that time in the list without an event. The engine mapping is in the engine-specific implementation rules
- When the engine reports a gamepad connection or disconnection and the list of connected gamepads changes, it publishes `GamepadConnectionChangedEvent`. A report that does not change the list publishes no event
- When a gamepad disconnects, it releases all pressed sources among the gamepad button and gamepad axis direction sources of that gamepad, removes all previous gamepad axis inputs of that gamepad, and when that gamepad is the last gamepad, removes the last gamepad. It does not change the current input device and the gamepad family and does not publish `InputPromptChangedEvent`

### pointer and gesture

- pointer: one input source with a position. One touch point, the left mouse button. A pointer ID is an integer of 0 or more, stays the same from press to release, and differs between pointers pressed at the same time. The pointer IDs of touch and the pointer ID of the left mouse button do not overlap. The mapping between engine input and pointer IDs is in the engine-specific implementation rules, and UI elements also use that mapping when they get a pointer ID from engine input
- Pointer positions, gesture positions and distance settings are in game coordinates (`ResolutionCore`). A position with a component that is not finite cannot be used. For a press or move, it leaves an error log and the input is not used for gesture judgement, and for a release, it leaves an error log and uses the previous position
- judge pointer: a pointer whose press is world input becomes a judge pointer when pressed. A pointer that stops being a judge pointer does not become one again until it is released. When the number of concurrent judge pointers exceeds `InputCore.maxJudgePointers`, that pointer does not become a judge pointer
- moved pointer: a pointer that has once been more than `InputCore.moveThreshold` away from its press position
- `TapEvent`: release of a judge pointer that is not a moved pointer and did not produce a long press. The position is the release position
- `LongPressEvent`: `InputCore.longPressMs` passes in the real elapsed time of `TimeCore` after a judge pointer that is not a moved pointer is pressed. Once per pointer. The position is the pointer position at the time of the judgement
- `DragEvent`: `Start` when a judge pointer becomes a moved pointer, `Move` each time its position changes after that, `End` on release. A pointer that produced a long press also starts a drag. `delta` is the difference from the position of the previous `DragEvent`, and for `Start` it is the difference from the press position
- `SwipeEvent`: the `TimeCore` real elapsed time from press to release of a pointer that produced `End` is at most `InputCore.swipeMaxMs`, and the distance between the press position and the release position is at least `InputCore.swipeMinDistance`. Published after `End`
- pinch: the default of `set_pinch_enabled` is `false`
  - When it is enabled, there is no pinch and a judge pointer is pressed, that pointer becomes a pinch pointer together with the earliest pressed of the already pressed judge pointers. When that pointer is in a drag, drag `Cancel` is published first. When a subscriber of that event disables pinch or calls `cancel_input` so that the two pointers cannot become pinch pointers, the pinch does not start. Then pinch `Start` is published
  - There is one pinch at a time. Pinch pointers do not make tap, long press, drag or swipe
  - The center is the midpoint of the two positions, and the scale is the distance between the two pointers ÷ the distance at `Start`. When the distance at `Start` is 0, the scale is 1
  - When a position changes, `Move`; when one is released, `End`, and the remaining pointer stops being a judge pointer. Disabling pinch during a pinch gives `Cancel`, and both pointers stop being judge pointers
- The position, center and scale of a `Cancel` event are the previous values of the same gesture, and `delta` is (0, 0). `Cancel` is once per gesture

### mouse

- mouse position: the position of the last input among the mouse moves, mouse button presses and mouse button releases that passed the block stage. In game coordinates. Unrelated to consumption in the UI stage. A position with a component that is not finite is not used. When there is no such input since `init`, there is no mouse position
- mouse motion: per frame, the sum of the relative motion of the mouse moves that passed the block stage in that frame, converted to game coordinates. When the frame changes, it counts again from (0, 0). A mouse move that does not change the cursor position also adds the relative motion that the engine gives
- `cancel_input` does not change the mouse position and the mouse motion

### input cancel

- `cancel_input`: releases the pressed sources of all actions, publishes `Cancel` for the drags and pinches in progress, does not publish the taps, long presses and swipes not yet published, makes the pressed judge pointers stop being judge pointers, ends a waiting `wait_key` with key none and a waiting `wait_pad_button` with button none, and increments the cancel count by one
- When InputCore calls it directly: the blocked state starts in the block start check, app focus loss, `TimeCore.AppBackgroundEnteredEvent`
- app focus loss: the loss of focus of the app window that the engine reports. The engine mapping is in the engine-specific implementation rules
- block start check: when `InputBlockCore.is_blocked` was `false` at the previous check and is `true` now, it calls `cancel_input`. It checks at every block stage, and every frame before the process callbacks of content code among the process callbacks of that frame. The previous value for the first check after `init` is `false`
- OS pointer cancel: the cancel of a pointer that the engine reports instead of the release of that pointer. The engine mapping is in the engine-specific implementation rules. In the input processing order, passed pointer, the UI stage and the callback of `set_ui_pointer_observer`, it is the release of that pointer. Gesture judgement does pointer cancel handling instead of that release
- pointer cancel handling: publishes drag or pinch `Cancel` only for that pointer and makes it stop being a judge pointer. For a pinch, the other pinch pointer also stops being a judge pointer
- When a press of the same pointer ID comes again without a release, it does pointer cancel handling on the pointer of the previous press, makes it stop being a passed pointer, and then handles the new press

### key binding

- key binding: the list of keys and mouse buttons (buttons that have a mouse button name) in the binding of an action. A changed key binding is used for input right away. `back` can also be changed. `get_keys` and `get_pad_buttons` also accept `back`
- `set_keys` is `false` without a log and does not change the binding in these cases: an empty list, a duplicate key or mouse button, contains key none, more than `InputCore.maxKeysPerAction` keys and mouse buttons, a key or mouse button in the key binding of an overlapping action
- `set_keys`, `reset_keys`, `load_keys` first release the pressed sources of the actions whose binding changes
- When `set_keys` succeeds, it writes the key bindings that differ from the default bindings to the `device` file of `LocalDataCore` under key `InputCore.key_bindings`. There is one element per action, and it is `<action>=<name>,<name>,...`. A name is a name that `set_keys` accepts. `reset_keys` resets the key bindings of all actions to the key bindings of the default bindings and deletes that key. It does not change gamepad button bindings
- `BootstrapCore` calls `load_keys` in `InitModules` after `LocalDataCore.load_device_file`. It does not apply the saved values of the actions below and leaves a warn log
  - an element in a wrong format, an action not in the action list, an action with two or more saved values
  - a list for which `set_keys` would return `false`. The check of the number of keys and mouse buttons runs before the other checks
  - an action whose application would give it the same key or mouse button as an overlapping action. Regardless of the saved order, it compares the actions to apply with the current key bindings of the actions not applied, removes all actions that would get the same key or mouse button as an overlapping action, and repeats until there is nothing to remove
- Calling `wait_key` again while it waits gives an error log and key none, and the earlier wait continues. `cancel_wait_key` and `cancel_input` end the earlier wait with key none
- gamepad button binding: the list of gamepad buttons and gamepad axis directions in the binding of an action. `get_pad_buttons`, `set_pad_buttons`, `reset_pad_buttons`, `wait_pad_button` apply the same rules as `get_keys`, `set_keys`, `reset_keys`, `wait_key` to gamepad buttons and gamepad axis directions. The differences are that the count limit is `InputCore.maxPadButtonsPerAction`, the save key is `InputCore.pad_bindings`, and the names in an element are gamepad button names or gamepad axis direction names. `cancel_wait_key` also ends a waiting `wait_pad_button` with button none
- `load_keys` applies the key bindings and the gamepad button bindings each by the rules above

### input prompt

- input prompt: the screen display of the input that presses an action. An icon and a name
- gamepad family: the kind of the gamepad that produced the gamepad input last used for device detection. One of `Generic`, `Xbox`, `PlayStation`, `Nintendo` of `InputPromptFamily`. It is decided by the gamepad name that the engine gives, and the engine mapping is in the engine-specific implementation rules. It is `Generic` at `init`
- prompt family: `Touch` when the current input device is `Touch`, `KeyboardMouse` when it is `KeyboardMouse`, and the gamepad family when it is `Gamepad`
- A gamepad button name is the name of the button's position. e.g. `a` is the bottom button of the right button group. The `input_prompt` rows define the display that differs per gamepad family
- prompt input: the string that finds the input prompt of an action in a prompt family
  - `Touch`: the action name
  - `KeyboardMouse`: the key name of the first key of the key binding. When the key binding has no key, the mouse button name of the first mouse button
  - gamepad family: the first gamepad button name of the gamepad button binding. When the gamepad button binding has no gamepad button, the first gamepad axis direction name
  - The order inside a binding is in the engine-specific implementation rules
- prompt table: the table from (`family`, `input`) of `input_prompt` to that row. The first `get_prompt` called while `DataCore.is_loaded` is `true` makes it from all rows of `input_prompt`, and `release` deletes it
- `get_prompt` is `false` without a log when there is no prompt input. Otherwise it finds the row of the prompt table whose `family` is the prompt family and whose `input` is the prompt input. When `DataCore.is_loaded` is `false`, it does not make or read the prompt table and treats it as no row, without a log. When the prompt family is `Xbox`, `PlayStation` or `Nintendo` and that row does not exist, it finds the row whose `family` is `Generic`. `family` of `InputPrompt` is the prompt family, `input` is the prompt input, and `icon` and `name_key` are the values of the found row. When there is no row or `icon` of the row is `null`, `icon` is the empty string, and when there is no row, `name_key` is none
- `get_prompt` is also used for `back`
- `InputPromptChangedEvent` is published when the prompt family changes and when a binding changes. A binding changes on a successful `set_keys`, `set_pad_buttons`, `reset_keys`, `reset_pad_buttons` and on a `load_keys` that applied one or more saved values. Once per call or per device input. When the input device also changes, it is published after `InputDeviceChangedEvent`

### lifecycle

- `release` resets all actions to the default bindings and empties the list of connected gamepads. It does not delete the saved key bindings and gamepad button bindings

## hook

none

## event

| event | when | payload |
|---|---|---|
| `InputDeviceChangedEvent` | the current input device changed | `device` |
| `TapEvent` | a tap was judged | `pointer_id`, `position` |
| `LongPressEvent` | a long press was judged | `pointer_id`, `position` |
| `DragEvent` | a drag phase was judged | `pointer_id`, `phase`, `start_position`, `position`, `delta` |
| `SwipeEvent` | a swipe was judged | `pointer_id`, `start_position`, `end_position` |
| `PinchEvent` | a pinch phase was judged | `phase`, `center`, `scale` |
| `InputPromptChangedEvent` | the prompt family or a binding changed | `family`: `InputPromptFamily` |
| `GamepadConnectionChangedEvent` | the list of connected gamepads changed | `gamepad_id`, `connected` |

## error

| condition | failure value | log |
|---|---|---|
| an action outside the action list for an operation other than `has_action` | failure value. Does nothing when there is no output | error |
| `back` for `is_pressed`, `is_just_pressed`, `is_just_released`, `get_strength`, `get_vector` | failure value | error |
| a core action is missing from the input map | `init` fails | error |
| in the default bindings, two actions that are overlapping actions have the same key, mouse button, gamepad button or gamepad axis direction | `init` fails | error. The two action names |
| `InputCore.padAxisWaitThreshold` is 0 or less, or more than 1 | `init` fails | error |
| `InputCore.padAxisDeadzone` is less than 0, or 1 or more | `init` fails | error |
| the strength of `inject_action` is outside 0 to 1 | clamps it to 0 to 1 | error |
| the strength of an `inject_action` press is NaN | does not inject it | error |
| the list of `set_keys` has a value that is not the empty string and is neither a key name nor a mouse button name | `false`. All bindings stay as they are | error |
| a callback that cannot be called, for `set_back_handler`, `set_ui_pointer_observer` | does not register it. The one registered earlier stays | error |
| a pointer position that cannot be used | by the gesture rules | error |
| `wait_key` while waiting | key none | error |
| the list of `set_pad_buttons` has a value that is not the empty string and is neither a gamepad button name nor a gamepad axis direction name | `false`. All bindings stay as they are | error |
| `wait_pad_button` while waiting | button none | error |
| an action that `load_keys` did not apply | none | warn |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `InputCore.moveThreshold` | number | core | content | distance from the press position for a pointer to become a moved pointer. game coordinates |
| `InputCore.longPressMs` | integer | core | content | real elapsed time of holding the press until a long press |
| `InputCore.swipeMaxMs` | integer | core | content | maximum real elapsed time from press to release for a swipe |
| `InputCore.swipeMinDistance` | number | core | content | minimum distance between the press position and the release position for a swipe. game coordinates |
| `InputCore.maxJudgePointers` | integer | core | content | maximum number of concurrent judge pointers |
| `InputCore.maxKeysPerAction` | integer | core | content | maximum number of keys and mouse buttons in the key binding of one action |
| `InputCore.maxPadButtonsPerAction` | integer | core | content | maximum number of gamepad buttons and gamepad axis directions in the gamepad button binding of one action |
| `InputCore.padAxisWaitThreshold` | number | core | content | direction strength at which `wait_pad_button` passes a gamepad axis direction. More than 0 and at most 1 |
| `InputCore.padAxisDeadzone` | number | core | content | a gamepad axis direction magnitude less than this value counts as strength 0. At least 0 and less than 1 |

## data

`data/tables/input_prompt.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `family` | `enum<InputPromptFamily>` | `Client` |
| `input` | `string` | `Client` |
| `icon` | `reskey?` | `Client` |
| `name` | `tstring<id>` | `Client` |

- One row is the input prompt of one prompt family and one prompt input. When `icon` is `null`, only the name shows, without an icon
- data check: two rows with the same `family` and `input` are `duplicate`. When `input` is the empty string, it is `empty_required`. When `family` is `Touch` and `input` is not snake_case, it is `value_type`. When `family` is `Generic`, `Xbox`, `PlayStation` or `Nintendo` and `input` is neither a gamepad button name nor a gamepad axis direction name, it is `value_type`. The `input` of a row whose `family` is `KeyboardMouse` is a key name or a mouse button name
- When the `input` of a row whose `family` is `Touch` is not in the action list of the game, or the `input` of a row whose `family` is `KeyboardMouse` is neither a key name nor a mouse button name, the static check `action reference` blocks it

`data/enums.csv`

| type | element |
|---|---|
| `InputPromptFamily` | `Touch`, `KeyboardMouse`, `Generic`, `Xbox`, `PlayStation`, `Nintendo`. The game does not change it |

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `InputCore.key_bindings` | `array<string>` | key bindings of the actions that differ from the default bindings |
| `device` | `InputCore.pad_bindings` | `array<string>` | gamepad button bindings of the actions that differ from the default bindings |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_debug_input_handler` | callback(device input → whether handled) | none | `QACore` |
| `inject_device_input` | one device input. The position is in game coordinates | none | `QACore`, `UnitTestCore`, core test |
| `inject_focus_lost` | none | none | core test |
| `set_test_device` | `InputDevice` | none | `QACore`, core test, client regression test |
| `set_test_gamepad_family` | one of `Generic`, `Xbox`, `PlayStation`, `Nintendo` of `InputPromptFamily` | none | core test, client regression test |
| `inject_gamepad_connection` | gamepad ID, whether connected | none | core test, client regression test |

- An input of `inject_device_input` goes from step 1 of the input processing order, the same as a real device input. Device input kinds: touch press·move·release·OS pointer cancel (touch index), mouse button press·release, mouse move, key press·release, gamepad button press·release, gamepad axis value, one text character. The input of bot playtests, the play agent and client regression tests comes in through this path. Gamepad button and gamepad axis inputs also receive a gamepad ID, and without one, they are inputs of gamepad ID 0. A negative gamepad ID leaves an error log and injects nothing
- The relative motion of a mouse move of `inject_device_input` is the difference between its position and the mouse position right before that input. When there is no mouse position, it is (0, 0)
- An input that the debug input handler handled goes to the debug layer even in the blocked state
- `inject_focus_lost` does the same handling as app focus loss, without an engine notification
- `inject_gamepad_connection` does the same handling as when the engine reports the connection or disconnection of that gamepad, without an engine notification
- `set_test_device` sets the current input device to that value and, when it changed, publishes `InputDeviceChangedEvent`. After that, device detection of device input works as before
- `set_test_gamepad_family` sets the gamepad family to that value and, when the prompt family changed, publishes `InputPromptChangedEvent`. After that, the gamepad family judgement of gamepad input works as before. A value other than `Generic`, `Xbox`, `PlayStation`, `Nintendo` leaves an error log and is ignored

## test

- While `ResolutionCore.set_test_screen` sets a window size that differs from the real window, an input at a game position injected with `inject_device_input` reaches the UI element drawn at that game position
- In the blocked state, device inputs and injects discarded in the block stage do not change UI elements, back handling, action state or `wait_key`. As an exception, a device input or inject that releases a pressed source releases that source even when discarded, so that action is not pressed after the block is released. That device input is still used for device detection. The result of an input not discarded in the block stage is the same as when there is no active block
- In the blocked state, when the UI element with the engine focus is a pass list UI element in every active block or a descendant of one, the accept input and direction input of the gamepad go to that UI element and do not change action state, back handling or `wait_pad_button`. When the UI element with the focus is outside the pass list UI elements, they are discarded
- In the blocked state, whether a pointer press and a position input that is not a pointer are discarded is decided by `InputBlockCore.pass_position`, and for pointer moves and releases by whether the pointer is a passed pointer. Other input goes only to the actions for which `InputBlockCore.pass_action` is `true`, and input with no such action or with no action is discarded
- When the `Gameplay` action `jump` and `cutscene_advance` both have the Space key, a Space press during a block whose pass list is `cutscene_advance`, `cutscene_skip`, `back` makes `is_just_pressed` of `cutscene_advance` and does not change the action state of `jump`
- When the `Gameplay` action `jump` and `back` both have gamepad button `b`, a `b` press during a block whose pass list is only `back` gives one back callback, and even when the callback returns `false`, the action state of `jump` stays as it is
- While `ResolutionCore.set_test_screen` sets a window size that differs from the real window, in the blocked state, an `inject_device_input` pointer press at a game position inside the pass list UI element area goes to that UI element, and a press at a game position outside the area is discarded
- When a pointer pressed on a pass list UI element of the block is moved outside the area and released, the move and release go to the UI stage. The moves and release of a pointer pressed outside the area are discarded even when it comes inside the area. The moves and release of a pointer for which the blocked state started while it was pressed are discarded
- After `ResolutionCore.set_test_screen` sets a `Letterbox` window with a fill area, a pointer pressed, moved and released in the fill area does not change UI elements, the callback of `set_ui_pointer_observer`, action state or gesture events. When it is an input of another device, `InputDeviceChangedEvent` is published once. When a pointer pressed inside the visible game area is moved to the fill area and released, `DragEvent` `End` occurs at that position
- An `inject_action` that receives a pointer ID changes the action state even for an action not in the pass list when that pointer is a passed pointer, and follows `InputBlockCore.pass_action` when it is not a passed pointer
- Even in the blocked state, the debug input handler is called once per device input, and an input it handled does not change later stages
- When a block is acquired while an action is pressed with a key, the result at the first block stage or first frame is the same as `cancel_input`, and even when that key is released in the blocked state, `is_pressed` is `false`
- The pointer of a press that a UI element consumed makes no gesture until it is released. A consumed key press does not change action state, and a consumed release releases that source
- For each press and release of a pointer that a UI element consumed and of a pointer it did not consume, the callback of `set_ui_pointer_observer` is called once with the pointer ID, whether pressed and the position, and the handling result is the same as without a callback. It is not called for input discarded in the block stage
- Each ESC press, platform back button and `back` inject gives one back callback, and key repeat and a `back` release give none. When there is no callback, the input is discarded without a log
- When the `Gameplay` action `jump` and `back` both have gamepad button `b` and the back callback returns `true`, a `b` press gives one back callback and the action state of `jump` stays as it is. When the callback returns `false`, there is one back callback and `is_just_pressed` of `jump`. When there is no callback, there is only `is_just_pressed` of `jump`
- `is_just_pressed` in the frame of the press, `false` and `is_pressed` in the next frame, `is_just_released` in the frame of the release
- When two sources are pressed and one is released, `is_pressed` holds and the strength is the strength of the remaining source
- An inject and a device input with the same action, `pressed` and strength make the same `is_pressed`, `is_just_pressed`, `is_just_released`, `get_strength` results
- In content code that runs in the first process frame after a device input press (`inject_device_input`), `is_just_pressed` is `true`, and in the next process frame it is `false`. The same holds for `is_just_released` of a release
- `get_vector` is the value of the rule, and when positive x and positive y are 1, the length is 1
- For each condition of the error table, the result and log are those of the table
- An input of another device publishes `InputDeviceChangedEvent` once, and an input of the same device, an inject and an input excluded from device detection publish none
- Moving at most `InputCore.moveThreshold` and releasing before `InputCore.longPressMs` gives one `TapEvent`
- When a pressed pointer is moved at most `InputCore.moveThreshold` and the test clock advances by `InputCore.longPressMs`, there is one `LongPressEvent` at the moved position, and no `TapEvent` after the release
- Moving more than the threshold gives `Start`, `Move` per position and `End` on release, `delta` is the value of the rule, and there is no `TapEvent`
- A drag that meets all swipe conditions gives one `SwipeEvent` after `End`, and when even one condition is not met, none. Even while the game time of `TimeCore` is paused, the time from press to release is measured in real elapsed time
- When pinch is disabled, the two pointers each produce a `TapEvent` and there is no `PinchEvent`. When it is enabled, the center and scale of `PinchEvent` are the values of the rule and there is no other gesture
- When pinch is enabled and a second pointer is pressed while a pointer is in a drag, drag `Cancel` comes and then pinch `Start`
- After `cancel_input`, `is_pressed` of the actions that were pressed is `false`, drags and pinches publish `Cancel` once, there is no long press, and the later moves and releases of those pointers make no gesture
- `inject_focus_lost` and the background progress of `UnitTestCore.advance_clock` each give the same result as `cancel_input`
- After a successful `set_keys`, the new key presses the action and the previous key does not, and the same holds after `release`, `init`, `load_keys`
- For each failure case of `set_keys`, the result is `false` and all bindings stay as they are. A list that contains the empty string gives no log, and a list that contains a value that is not the empty string and is neither a key name nor a mouse button name gives an error log. A `wait_key` ended by `cancel_wait_key` gives the empty string
- When the key binding and the gamepad button binding of the same action are changed with `set_keys` and `set_pad_buttons` and then `reset_keys` runs, after `reset_keys` and after a `load_keys` after it, the key bindings of all actions are the key bindings of the default bindings, and the changed gamepad button binding stays as it is
- Gamepad button `b` triggers the back callback, `a` presses `cutscene_advance`, and `start` presses `cutscene_skip`
- After a successful `set_pad_buttons`, the new gamepad button presses the action and the previous button does not, and the same holds after `release`, `init`, `load_keys`. After `reset_pad_buttons`, it is the default binding. A button of an overlapping action gives `false`
- `wait_pad_button` returns the next gamepad button press, and that press does not go to UI, back or action state
- When `set_keys`(action, [`mouse_right`]) succeeds, a right mouse button press presses that action, `get_keys` fills `mouse_right`, and the same holds after `release`, `init`, `load_keys`. When the key binding of an overlapping action has `mouse_right`, the result is `false`
- A left mouse button press during `wait_key` returns `mouse_left`, and that press does not go to UI, gestures or action state. Mouse input that the engine made from touch is not returned
- When `set_pad_buttons`(action, [`right_x+`]) succeeds, a positive value of `right_x` presses that action and `get_strength` is that value, and a negative value does not press it. `set_pad_buttons` with `trigger_left-` gives an error log and `false`
- After `set_pad_buttons`(`back`, [`left_y-`]), when `left_y` values come in the order −a, −b, −c, 0, −a (`InputCore.padAxisDeadzone` < a < b < c ≤ 1), the back callback is called twice. After `set_pad_buttons`(action1, [`left_y+`]) and `set_pad_buttons`(action2, [`left_y-`]), when the `left_y` value goes directly from a to −a, that one input gives `is_just_released` of action1 and `is_just_pressed` of action2 in the same frame
- During `wait_pad_button`, when the strength of one direction of an axis changes from less than `InputCore.padAxisWaitThreshold` to at least that value, it returns that gamepad axis direction name, and it does not return a value that changed while staying at least that value
- Each non-applied case of `load_keys` gives a warn log, and the other actions are applied. Two actions with the same key are both not applied even when the saved order is swapped
- `set_keys` with the same key succeeds for an action whose binding context is `Gameplay` and for `cutscene_advance`, and a key of an overlapping action gives `false`. `set_keys` of a `Gameplay` action with the key of `back` succeeds, and `set_keys` of a `menu_` action with it gives `false`. After the key of a `Gameplay` action is changed, a `set_keys` that changes it back to the same key as `cutscene_advance` succeeds
- When two actions that are overlapping actions have the same key in the default bindings, `init` gives an error log and fails
- After `release`, the bindings, the back callback, the pointer observer, action state, pointers, the pinch enabled state, the previous value of the block start check, the gamepad family, the previous gamepad axis inputs and the prompt table are their initial values, and `get_connected_gamepads` is 0
- `wait_key` returns the next key press, and that press does not go to UI, back or action state
- When a block is acquired while a judge pointer in a drag and two judge pointers in a pinch are pressed, at the first block stage or first frame the drag and pinch publish `Cancel` once, those pointers give no long press, and the releases of those pointers in the blocked state publish no gesture event
- A press at a position that cannot be used gives an error log and no gesture. A move that cannot be used during a drag gives an error log and no `DragEvent`, and a following release that cannot be used gives an error log and `End` at the previous position
- When a press of a pointer in a drag comes again without a release, it gives drag `Cancel`, and releasing that press without moving gives `TapEvent`
- Presses and releases of `inject_device_input` make the same events and action state as real device input
- After `init` before any mouse input, and after `release`, `get_mouse_position` is (`false`, (0, 0)). After a mouse move of `inject_device_input`, it is (`true`, that position), and touch presses and moves do not change it
- When two mouse moves are injected in one frame, `get_mouse_motion` of that frame is the sum of the two relative motions, and in the next frame it is (0, 0)
- A mouse move that a UI element consumed also changes `get_mouse_position` and `get_mouse_motion`. In the blocked state, a mouse move at a position where `InputBlockCore.pass_position` is `false` and a left mouse button pressed in the fill area change neither. `cancel_input` changes neither
- Gamepad button and axis inputs of `inject_device_input` make the same action state and `InputDeviceChangedEvent` as real gamepad input
- After `init` before any gamepad input, and after `release`, `get_last_gamepad` is −1, and after a gamepad button press of `inject_device_input` it is 0. A gamepad axis input that presses no action does not change the last gamepad
- After `inject_gamepad_connection`(1, `true`), `get_connected_gamepads` fills 1 and `GamepadConnectionChangedEvent`(1, `true`) is published once, and the same call again publishes no event. After `inject_gamepad_connection`(1, `false`), the list has no 1 and `GamepadConnectionChangedEvent`(1, `false`) is published once
- After `inject_gamepad_connection`(0, `true`), when an action is pressed with a button of gamepad 0 and `inject_gamepad_connection`(0, `false`) is called after `set_test_gamepad_family`(`PlayStation`), `is_pressed` is `false`, `get_last_gamepad` is −1, `get_device` stays as it is, `get_prompt_family` is `PlayStation`, and there is no `InputPromptChangedEvent`
- When the input device is `Touch`, a text character input of `inject_device_input` publishes `InputDeviceChangedEvent`(`KeyboardMouse`) once
- `set_test_device`(`Gamepad`) publishes `InputDeviceChangedEvent` once and `get_device` is `Gamepad`, and a second call with the same value publishes no event. After that, a touch press changes `get_device` to `Touch`
- When the current input device is `Touch` or `KeyboardMouse`, `get_prompt_family` is the same name, and when it is `Gamepad`, the gamepad family. After `init`, the gamepad family is `Generic`
- When the input device is `Gamepad`, `set_test_gamepad_family`(`PlayStation`) publishes `InputPromptChangedEvent` once, and a second call with the same value publishes no event. `set_test_gamepad_family` while the input device is `KeyboardMouse` does not change the prompt family, so it publishes no event
- When the input device changes and so the prompt family changes, `InputPromptChangedEvent` is published once after `InputDeviceChangedEvent`
- `get_prompt` fills `icon` and the `name` translation key of the `input_prompt` row whose `family` and `input` match. For `Xbox`, `PlayStation`, `Nintendo`, when no row matches, it fills from the `Generic` row, and when there is none either, it fills an empty `icon` and a none `name_key`. `input` is the prompt input
- In `KeyboardMouse`, the prompt input of an action with no key in its key binding is the first mouse button name, and the prompt input of an action with no gamepad button in its gamepad button binding is the first gamepad axis direction name. When the binding has no such input, `get_prompt` is `false` without a log. The prompt input of `Touch` is the action name
- After a successful `set_keys`, `input` of `get_prompt` is the new first key and `InputPromptChangedEvent` is published once. A failed `set_keys` or `set_pad_buttons` publishes no event
- `get_prompt` of `back` succeeds without a log
- `get_keys` and `get_pad_buttons` of `back` fill the keys and gamepad buttons of `back` without a log
- In a run where the engine also produces mouse input made from touch, pressing and releasing one touch gives one `TapEvent`, an action set with `set_keys`(action, [`mouse_left`]) is not pressed, and `get_mouse_position`, `InputDeviceChangedEvent` and the callback of `set_ui_pointer_observer` are the same as without that mouse input. In the blocked state, a left mouse button press made from touch at a position where `InputBlockCore.pass_position` is `false`, and the moves and release after it, do not go to UI elements. When a touch is pressed, then a block whose pass list does not have that UI element starts, and then the touch is released, that UI element is not clicked
- The `TapEvent` `pointer_id` of a touch and of the left mouse button pressed at the same time differ, and each is the pointer ID of the engine-specific implementation rules. An `inject_action` that a pass list UI element of a block, on receiving a touch press, calls with the pointer ID it got from the engine input changes the action state of an action not in the pass list
- After gamepad 0 and gamepad 1 press `a` of the same action, releasing or disconnecting only gamepad 1 leaves `is_pressed` `true`. After `set_pad_buttons`(action, [`left_x+`]), even when `left_x` a of gamepad 0 is followed by `left_x` 0 of gamepad 1, `is_pressed` is `true` (`InputCore.padAxisDeadzone` < a ≤ 1)
- After `set_pad_buttons`(`back`, [`left_y-`]), injecting `left_y` −a of gamepad 0, disconnecting and reconnecting gamepad 0, and then injecting `left_y` −a calls the back callback twice (`InputCore.padAxisDeadzone` < a ≤ 1)
- An OS pointer cancel of a judge pointer in a drag gives one `DragEvent` `Cancel` and no `End`, `SwipeEvent` or `TapEvent`, and the callback of `set_ui_pointer_observer` is called once with whether pressed `false`. An OS pointer cancel of a pointer pressed on a pass list UI element of a block goes to the UI stage, and after that the pointer is not a passed pointer
- When the content code process callback of frame F acquires a block while an action pressed with a key stays pressed, `is_just_released` of that action is `false` in F, `true` in the content code process callback of F+1, and `false` in F+2
- When `DataCore.is_loaded` is `false`, `get_prompt` of an action that has a prompt input is `true` without a log, with an empty `icon` and a none `name_key`, and after a successful `DataCore.load`, the same call fills the values of the matching `input_prompt` row
