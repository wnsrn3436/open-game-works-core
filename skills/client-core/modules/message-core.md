# MessageCore

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

Handles toasts and black box messages, notifications that are shown for a set duration and then disappear. A popup is not a message; `UICore` handles it.

## dependency

`LogCore`, `TimeCore`, `ResourceCore`, `PoolCore`, `LocalizationCore`, `ResolutionCore`, `InputBlockCore`, `TweenCore`, `UICore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `prepare` | none | async operation. success flag | `false` | `BootstrapCore`(`Prepare` stage) |
| `show_toast` | translation key, `FormatArgs` of `LocalizationCore` (optional), extra text (core only) | none | none | core, content code |
| `show_black_box` | translation key, `FormatArgs` (optional), extra text (core only) | none | none | core, content code |
| `close_black_box` | none | none | none | `SceneCore` |
| `close_all` | none | none | none | `BootstrapCore`(restart, update reboot) |

- Extra text is an untranslated string appended after the wording. e.g. diagnostic information of `NetworkCore`. Content code does not pass it
- No operation receives a string as the wording

## behavior

### message kind

| kind | input block | dim | same text ignored | render order |
|---|---|---|---|---|
| toast | no | no | yes | above |
| black box message | yes | yes | no | below |

- Both kinds are drawn on `UICore.get_layer(Message)`
- Toasts and black box messages do not receive pointer input. The UI under a toast receives input the same as when there is no toast
- The dim of a black box message is an element inside the black box resource that covers the whole visible game area. It differs from the dim of `UICore`

### resource

- The toast resource and the black box resource are prefabs with a `MessageView` component at the root. `MessageView` points to the UI text element that shows the wording. The engine mapping is in the engine implementation rules. The toast prefab is a manual-return pool object of `PoolCore`
- When a resource key in core settings is an empty string, a screen made by code is used. A toast made by code is white text on a black band whose opacity is `UICore.dimOpacity`, and a black box made by code is white text on a black dim whose opacity is `UICore.dimOpacity` and that covers the visible game area
- The wording appears in the center of the visible game area

### prepare

- `prepare` loads the toast resource, the black box resource, and the enter and exit tween presets (kind of `TweenCore.get_preset_kind`) into the global scope, and makes one black box object and keeps it hidden. When the toast resource key is not an empty string, it fills the `PoolCore` pool of the toast prefab in advance; when it is an empty string, it makes one toast object by code and keeps it hidden
- When it is called again, it closes the same as `close_all`, destroys the previous black box object and the toast object made by code, and reads the core settings again and loads
- A message request before `prepare` succeeds, after it fails, and before a `prepare` called again ends writes an error log and is ignored
- `prepare` writes an error log when the sum of the length of the black box enter tween preset, `MessageCore.blackBoxDurationMs`, and the length of the black box exit tween preset is `InputBlockCore.maxDurationMs` or more. The values are used as they are and the result of `prepare` does not change. The length of a tween preset is cycle time × repeat count of `TweenCore`, and 0 when the key is an empty string

### text

- The wording is made when the request is received. It is the result of `LocalizationCore.get_text` when there is no `FormatArgs`, and the result of `LocalizationCore.format` when there is one. When there is extra text, one line break and the extra text are appended
- The caller's `FormatArgs` is not kept. When the caller changes values after the request, the wording does not change

### display

One message is shown in the order below. From the start of 1 to the end of 5 it is on display.

1. Puts the message object on the `Message` layer, resets the tween properties to the prefab's values, and then puts in the wording
2. Plays the enter tween preset with `TweenCore.play_preset`
3. Keeps it for the display duration: `MessageCore.toastDurationMs` for a toast, `MessageCore.blackBoxDurationMs` for a black box
4. Plays the exit tween preset with `TweenCore.play_preset`
5. Takes the message object down

- When the tween preset key is an empty string, it goes to the next step without that presentation
- The display duration and tweens progress in real elapsed time
- When the toast resource key is not an empty string, the toast object is borrowed from the global scope pool of `PoolCore` in 1 and returned in 5
- The toast object made by code and the black box object are each one object that is reused. When not on display, they are hidden. When one was destroyed outside MessageCore, it is made again in 1 of the next message of the same kind
- A black box message sets a block with reason tag `message` through `InputBlockCore` from 1 to 5. The pass list is the system popup root of `UICore.get_block_pass_list`

### queue

- There is one queue per kind, and only one message per kind is on display at a time. When one is on display, a request goes to the end of the queue, and when 5 finishes, the request at the front of the queue is shown
- Toasts and black box messages do not wait for each other
- When the wording of a toast request equals the wording of a toast on display or in the queue, the request is ignored. A black box message with the same wording is also put into the queue

### close

- kind close: takes down the message of that kind on display without presentation and empties the queue. Stops the tweens of the message object, and for a black box, releases the block
- `close_black_box` does a kind close only for black box messages
- `close_all` does a kind close for both kinds
- `release` takes them down the same as `close_all`, then returns borrowed toast objects to the pool and destroys the toast object made by code and the black box object

### display failure

The messages below stop display and are taken down, and then the request at the front of the queue of the same kind is shown.

- A toast whose toast object could not be borrowed
- A black box message whose block could not be set. The black box object is not shown
- A message whose message object was destroyed outside MessageCore while on display

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| no `MessageView` at the resource root in `prepare`, no UI text element, the tween preset of a key that is not an empty string among the four enter·exit tween preset keys cannot be loaded or repeats infinitely, toast pool pre-fill failure when the toast resource key is not an empty string | `false` | error |
| `prepare` while a `prepare` is in progress | `false`. The `prepare` in progress continues | error |
| sum of the lengths of the black box enter·exit tween presets and `MessageCore.blackBoxDurationMs` is `InputBlockCore.maxDurationMs` or more | those values are used. The result of `prepare` is unchanged | error |
| message request before `prepare` success | ignored | error |
| no translation key, the made wording is an empty string | ignored | error |
| toast object cannot be borrowed | display failure | error |
| message object destroyed outside while on display | display failure | error |
| block of the black box cannot be set | display failure | `InputBlockCore` writes it |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `MessageCore.toastResource` | string | core | content | resource key of the toast prefab. An empty string means the screen made by code |
| `MessageCore.blackBoxResource` | string | core | content | resource key of the black box prefab. An empty string means the screen made by code |
| `MessageCore.toastDurationMs` | integer | core | content | toast display duration |
| `MessageCore.blackBoxDurationMs` | integer | core | content | black box message display duration |
| `MessageCore.toastEnterTween` | string | core | content | toast enter tween preset key. An empty string means the toast enters without a presentation |
| `MessageCore.toastExitTween` | string | core | content | toast exit tween preset key. An empty string means no presentation |
| `MessageCore.blackBoxEnterTween` | string | core | content | black box enter tween preset key. An empty string means no presentation |
| `MessageCore.blackBoxExitTween` | string | core | content | black box exit tween preset key. An empty string means no presentation |
| `UICore.dimOpacity` | number | core | content | opacity of the dim made by code. The black band of the toast made by code and the black dim of the black box also have this opacity |
| `InputBlockCore.maxDurationMs` | integer | core | content | block elapsed time at which the forced release of `InputBlockCore` happens. 1 to 5 of a black box message must be shorter than this |

## data

none

## DEV

none

## test

- When `prepare` succeeds, both resources are in the global scope and the toast pool is filled in advance. When the toast resource key is an empty string, `prepare` is `true` and there is no toast pool
- For each condition of the error table, the log and result of the table occur. A request that is not displayed does not go into the queue
- A toast starts the exit tween only after the enter tween ends and `MessageCore.toastDurationMs` passes, and a black box starts it only after `MessageCore.blackBoxDurationMs` passes
- Even with game time pause and time scale 2000, the display duration passes in real elapsed time
- A presentation whose tween preset key is an empty string is skipped and progress continues
- When the sum of the lengths of the black box enter·exit tween presets and `MessageCore.blackBoxDurationMs` is `InputBlockCore.maxDurationMs`, `prepare` writes one error log and is `true`, and when it is 1 less, there is no such log
- A black box after a black box whose exit tween made the opacity 0 appears with the prefab's opacity without an enter tween
- Three requests of the same kind with different wording appear one at a time in the order received
- A black box request while a toast is on display and a toast request while a black box is on display appear immediately
- A toast request with the same wording as a toast on display or in the queue does not appear, and black box requests with the same wording all appear
- The text of a request without `FormatArgs` is the `get_text` result, and the text of a request with it equals the `format` result. When there is extra text, it is the wording, one line break, and the extra text joined
- When the caller changes `FormatArgs` after the request, the wording stays the same
- While a toast is on display, there is no block set by MessageCore, and a UI element overlapping the toast receives input
- From 1 to 5 of a black box there is a block with reason tag `message`; during it, the buttons of an open system popup can be pressed and back input does not go to the back handling of `UICore`; after 5 and after `close_black_box`, `close_all`, `release` there is no block
- When a toast and a black box are on display and both queues have requests, after `close_black_box` the black box and its queue are empty and the toast continues to appear
- After `close_all`, there is no message on display and no queue, and all borrowed toast objects are in the pool. Requests after that appear by the display order and queue rules
- Toast objects still borrowed are 1 or fewer, and 0 after 5 of the last toast
- The `Message` layer is drawn above the `Popup` layer, and a toast above a black box
- After the black box object is destroyed outside, a black box request appears with a new object
- A toast after a toast whose toast object could not be borrowed appears, and there is one error log per failure
- When the resource keys in core settings are empty strings, the toast and black box made by code appear, and three toast requests with different wording appear in turn with the one toast object made by code. A toast request after that object is destroyed outside appears with a new object
- After `release` there is no black box object, and after `init` and `prepare` again, toasts and black boxes appear in display order
