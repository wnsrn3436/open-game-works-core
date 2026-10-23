# TutorialCore

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

Runs the tutorial steps written in a data table in order, and does screen highlighting, hand pointer display and input restriction. Saves progress to the server `tutorial` module to continue it in the next run, and judges the start condition with `RequirementCore`.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `ResourceCore`, `LocalizationCore`, `NetworkCore`, `UserStateCore`, `AuthCore`, `RequirementCore`, `SafeAreaCore`, `InputCore`, `InputBlockCore`, `UICore`, `SceneCore`

- server dependency: `tutorial`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `check_start` | none | whether it started a tutorial | `false` | content code |
| `notify_cue` | `TutorialCue` value | whether a tutorial finished its current step | `false` | content code |
| `skip` | none | whether it skipped | `false` | content code |
| `is_running` | none | whether there is an active tutorial | `false` | all code |
| `current` | none | the ID value of the current tutorial and its current `step`. (0, 0) when there is none | (0, 0) | all code |
| `is_completed` | tutorial ID value | whether it is a completed tutorial | `false` | all code |

## behavior

### progress state

- progress step: the last `step` saved per tutorial. It is the value read with `UserStateCore.get` from the core UserState kind `TutorialProgressUserState` defined by server `tutorial` (list kind, `id` is the tutorial ID value, field `step`), and 0 when there is no row
- TutorialCore uses the larger of the progress step saved on the server and the `step` finished in this run as the progress step of that tutorial
- completed tutorial: a tutorial whose progress step is at least the last `step` of that tutorial
- `is_completed` of a tutorial ID value not in the `tutorial` table leaves an error log and is `false`
- progress step save: sends the core rpc `SaveTutorialProgress`(tutorial ID value, `step`) of server `tutorial` with `NetworkCore.send`. Goes to the next step without waiting. The failure callback returns `true` and there is no screen display. On failure the progress step of this run stays as it is, and the next save or resend sends a `step` of that value or more
- When the `step` to send is at most the value of `TutorialProgressUserState`, it is not sent. The server accepts only a `step` larger than the saved value
- when it saves: when a step whose `save` is `true` is finished, when the last step is finished, when skipped (sends the last `step`)
- resend: before choosing candidates, the start check sends `SaveTutorialProgress` with that `step` for each tutorial whose largest `step` saved in this run (a step whose `save` is `true`, the last step, the last `step` of a skip) is larger than the value of `TutorialProgressUserState`, when there is no `SaveTutorialProgress` of that tutorial waiting for a response

### tutorial state

- active tutorial: a tutorial started in this run and not finished or skipped. Each active tutorial has one of the two states below
  - `Shown`: step progress from 3 to 5. Only the `Shown` tutorial has the tutorial view and the block of reason tag `tutorial`. There is at most one `Shown` tutorial
  - `Paused`: step progress 1 or 2, or step progress has stopped. There can be several
- current tutorial: the `Shown` tutorial. When there is none, the `Paused` tutorial with the smallest `order`
- step screen condition: when `panel` is not null, `UICore.get_current_panel_key` is `panel` and `UICore.get_open_popups` is an empty list. When `popup` is not null, the last element of `get_open_popups` is `popup`. When both are null, it always holds
- anchor lookup: the result of `UICore.get_anchor_rect`(`anchor`, `anchor_key`) for a step whose `anchor` is not an empty string. When `anchor_key` is null, it is called without an anchor key. The anchor rectangle, `AnchorResult` and `element` in this document are those of the anchor lookup
- step anchor condition: `anchor` is an empty string, or `visible` of the anchor lookup is `true` and, when `panel` or `popup` is not null, `owner` of `AnchorResult` is that value
- show condition: the step screen condition and the step anchor condition of the current step both hold

### start

- The start check runs on `SceneCore.SceneStartedEvent`, on `UserStateCore.UserStateChangedEvent`, on the start watch callback, at tutorial end, when the `Shown` tutorial becomes `Paused`, and on a `check_start` call
- start watch: at the first start check after login, sets `RequirementCore.watch`(that requirement ID, one `UserStateChanged` trigger with an empty target, a callback that runs the start check) for each non-zero `start_requirement` of an unfinished tutorial. Only one is set per requirement ID. When all tutorials that have that ID as `start_requirement` are finished or skipped, it calls `unwatch`. For a time-dependent condition, `RequirementCore` judges again by time and calls the callback
- In these cases the start check does not run and is `false`: not logged in (`AuthCore.is_logged_in`), there is a `Shown` tutorial, `SceneCore` is in transition
- candidate: among tutorials that are not finished and not active, a tutorial whose `start_requirement` is 0 (empty cell) or has `passed` `true` in its `RequirementCore.evaluate`, and for which the `can_start_tutorial` hook returned `true`
- Starts the candidate with the smallest `order`. The start step is the smallest step among steps whose `step` is larger than the progress step. A started tutorial does step progress 1 as `Paused`. When the show condition of the start step does not hold at that time, this repeats with the remaining candidates
- The start check is `true` when it starts one or more tutorials
- A tutorial that fails the step check is not started and is removed from the candidates. It is not checked again in the same run
- step check: applies the `tutorial_step` data check conditions of `## data` again to the steps of that tutorial

### step progress

1. Emits `TutorialStepStartedEvent`
2. Checks the show condition each frame. In a frame with no `Shown` tutorial, among the tutorials in 2 whose show condition holds, the tutorial that was last `Shown` goes to 3 (`Shown`) when there is one, otherwise the tutorial with the smallest `order` does. When the duration in which the step screen condition holds while the step anchor condition does not hold reaches `TutorialCore.anchorWaitWarnMs` without a break in `TimeCore` real elapsed time, it leaves a warn log once for that step and keeps waiting
3. Shows the tutorial view: the text in the speech bubble when there is `text`, the highlight (a dim that covers the outside of the anchor rectangle) when there is `anchor`, the hand pointer at the center of the anchor rectangle when `pointer` is `true`. The highlight, hand pointer and speech bubble follow the anchor rectangle each frame
4. When `restrict_input` is `true`, waits for the condition of 5 with `InputBlockCore.run_blocked`(reason tag `tutorial`). Pass list: `element` of the `AnchorResult` the anchor lookup gave, the advance button and skip button of the tutorial view, the system popup root of `UICore.get_block_pass_list`
5. When the condition of `complete` is met, hides the tutorial view, releases the block and finishes the step

| `complete` | step end condition |
|---|---|
| `Advance` | click of the advance button of the tutorial view |
| `AnchorTap` | one pointer received through `InputCore.set_ui_pointer_observer` is pressed inside the anchor rectangle and released inside the anchor rectangle, or the accept callback of the view focus is called with the anchor `element`. The rectangle is the anchor lookup value at press and at release. The input also goes to the UI element of the anchor unchanged |
| `Requirement` | `passed` of the `RequirementCore.evaluate` result of `complete_requirement` is `true`. Calls `evaluate` right after setting the requirement watch, and after that judges by `passed` of the `RequirementResult` the requirement watch callback received |
| `Cue` | the value `notify_cue` received equals `cue` |

- `AnchorTap` end order: when a release meets the condition, the step is not finished inside the observer callback; it is finished after the handling in which `InputCore` passes that release to the UI element ends, before the next frame. So when that release becomes a `UIButton` click of the anchor element, that click callback is called before the step ends. `UICore` calls the accept callback after the click callback, so the step is finished inside the accept callback. From meeting the condition until finishing the step there is no pause judgement, and when that tutorial is skipped or `release` is called in between, the step is not finished. The engine mapping is in the engine-specific implementation rules
- A step that is not `Advance` hides the advance button. A tutorial whose `skippable` is `false` hides the skip button
- view focus: when showing the tutorial view in 3, makes the advance button the initial focus element when `complete` is `Advance`, and `element` of `AnchorResult` when it is `AnchorTap` and that `element` has a `UIButton` attached, and passes that element and the visible skip button as the focus element list to `UICore.set_view_focus`(`Tutorial`). The accept callback receives the condition of `AnchorTap`. A step with another `complete` sets no view focus. When the tutorial view is hidden or destroyed, deletes it with an empty list. While hidden because of a system popup, it stays as it is
- When game settings `gamepadSupported` is `true` and the `AnchorResult` `element` of an `AnchorTap` step has no `UIButton` attached, leaves an error log (anchor name, anchor key) when showing the tutorial view in 3. When a UI element in the scenes and prefabs of the content with a `UIAnchor` of that anchor name attached has no `UIButton`, static check `anchor reference` blocks it
- When a step is finished, saves if it is one of the times when it saves, then does the next step from 1 when there is a next step, otherwise finishes the tutorial. At tutorial end, emits `TutorialCompletedEvent` and runs the start check
- On receiving `SceneEndedEvent`, hides the tutorial view of the `Shown` tutorial, releases the block and stops the step progress of all active tutorials (`Paused`). While stopped, it does not receive the condition of `complete`. On receiving `SceneStartedEvent`, each active tutorial does its current step again from 2
- `AnchorTap` and `Cue` that happened in the previous scene are not passed to the next step
- pause: from 3 to 5, checks the show condition each frame. When it does not hold, or in a step with `anchor` the `element` differs from the element received in 3, hides the tutorial view, releases the block and returns to 2 of the same step (`Paused`). The pass list of 4 done again uses the new `element`
- From 3 to 5, checks `UICore.is_system_popup_visible` each frame. While it is `true`, hides the tutorial view, and shows it again when it becomes `false`. The block, step progress and condition judgement stay as they are. In a frame where it is `true`, there is no pause judgement and no `Shown` transition of 2
- The conditions of `Requirement` and `Cue` are received from 2. When the condition is met in 2, does 5 without doing 3 and 4. The conditions of `Advance` and `AnchorTap` are received from 3
- `notify_cue` finishes the step of each active tutorial from 2 to 5 whose current step `cue` equals the received value
- requirement watch: when 2 of a `Requirement` step starts, sets `RequirementCore.watch`(`complete_requirement`, one `UserStateChanged` trigger with an empty target, callback). When the step ends, the step progress stops, or the tutorial is skipped, calls `unwatch`

### skip

- When `skippable` of the `Shown` tutorial is `true` and a skip button click or `skip` is received, hides the tutorial view of that tutorial, releases the block, sets the `step` finished in this run of that tutorial to the last `step`, saves the last `step`, emits `TutorialCompletedEvent`(`skipped` = `true`), and runs the start check
- When there is no `Shown` tutorial or its `skippable` is `false`, `skip` is `false`

### tutorial view

- The resource key is game settings `tutorialView`. On first use, loads it with global scope and creates one, and when it passes the view check, puts it under a `SafeAreaCore` safe area root that TutorialCore creates in the `Tutorial` layer of `UICore.get_layer`. The view root has the same position and size as the safe area root and changes with it when the safe area root changes. The engine mapping is in the engine-specific implementation rules
- TutorialCore attaches the `SafeAreaCore` ignore mark to the dim so that the dim covers the whole visible game area. The positions of the highlight and hand pointer are the game coordinates of the anchor rectangle regardless of the safe area
- speech bubble position: in a step with `anchor`, TutorialCore puts the speech bubble on the side of the anchor rectangle, above or below, with the larger remaining height inside the view root. When equal, below. The edge of the speech bubble on the anchor side touches the edge of the anchor rectangle on that side, and the horizontal center of the speech bubble is the horizontal center of the anchor rectangle. When it goes beyond the view root at that position, it is moved into the view root by the amount it goes beyond. When moved vertically, the speech bubble can overlap the anchor rectangle. The speech bubble size is its size in the tutorial view resource. A step without `anchor` puts the speech bubble at the position set in the tutorial view resource
- The tutorial view component on the view root, defined in the engine-specific implementation rules, points to the dim, speech bubble, text element, hand pointer, advance button and skip button. A button without the `UIButton` of `UICore` attached counts as missing
- view check: the view root is a UI element, the component exists, and all parts the component points to exist. On failure, destroys the created instance, leaves an error log and proceeds without the tutorial view until `release`. When proceeding without the tutorial view, an `Advance` step ends right after 3 and sets no block
- speech bubble text: when showing the tutorial view in 3 of a step with `text`, binds it with `LocalizationCore.bind_text`(text element, `text`), and unbinds it with `LocalizationCore.unbind_text` when hiding the tutorial view. While hidden because of a system popup, it stays as it is
- skip button text: when creating a tutorial view that passed the view check, binds it with `LocalizationCore.bind_text`(skip button, `[tutorial_skip]`)
- The dim, speech bubble, text element and hand pointer of the tutorial view do not receive pointer input. Only the advance button and skip button receive it

### lifecycle

- `init` passes an observer to `InputCore.set_ui_pointer_observer`
- `release` stops all active tutorials without saving, deletes the requirement watches and start watches with `RequirementCore.unwatch`, destroys the tutorial view and its safe area root, releases the block, passes none to `InputCore.set_ui_pointer_observer`, and deletes the progress steps of this run and the list of tutorials that failed the step check

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `can_start_tutorial` | per candidate in the start check | tutorial ID value | whether it may start | `true` |

- Content code defers the start by the state of the running game. e.g. during cutscene playback, during battle
- `can_start_tutorial` is an owner hook. The object of the scene that holds that state registers it

## event

| event | when | payload |
|---|---|---|
| `TutorialStepStartedEvent` | step progress 1. Also emitted for a `Paused` tutorial | `tutorial_id`, `step` |
| `TutorialCompletedEvent` | when a tutorial is finished or skipped | `tutorial_id`, `skipped`: bool |

## error

| condition | failure value | log |
|---|---|---|
| `can_start_tutorial` hook throws | that tutorial is not a candidate. The next judgement calls the hook again | error per throw |
| step check failure | does not start the tutorial | error. tutorial ID and `step` |
| tutorial view resource cannot be loaded, view check failure | proceeds without the tutorial view | error |
| the anchor is not visible for `TutorialCore.anchorWaitWarnMs` while the step screen condition holds | keeps waiting | warn. anchor name, anchor key |
| `AnchorTap` anchor without `UIButton` attached when `gamepadSupported` is `true` | continues progress | error. anchor name, anchor key |
| `SaveTutorialProgress` failure | continues progress | `NetworkCore` leaves it |
| `notify_cue` when there is no active tutorial from 2 to 5 | `false` | none |
| `notify_cue` that differs from the current step `cue` of every active tutorial | `false` | none |
| `check_start` when not logged in, when there is a `Shown` tutorial, or when `SceneCore` is in transition | `false` | none |
| `skip` when there is no `Shown` tutorial or its `skippable` is `false` | `false` | none |
| `is_completed` of a tutorial ID value not in the `tutorial` table | `false` | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `tutorialView` | string | game | none | resource key of the tutorial view |
| `TutorialCore.anchorWaitWarnMs` | integer | core | content | duration of waiting for the anchor while the step screen condition holds until a warn log is left |
| `gamepadSupported` | boolean | game | none | when `true`, leaves an error log for an `AnchorTap` anchor without `UIButton` attached |
| `RequirementCore.timeRecheckMs` | integer | core | content | real elapsed time interval at which a watch of a time-dependent condition is marked as pending evaluation. Used for the expected times in tests |

## data

`data/tables/tutorial.csv`. TutorialCore defines the header

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `order` | `int` | `Client` |
| `start_requirement` | `requirement` | `Client` |
| `skippable` | `bool` | `Client` |

`data/tables/tutorial_step.csv`. TutorialCore defines the header. Server `tutorial` reads `id` and `step`

| column | type | build target |
|---|---|---|
| `id` | `id` | `All` |
| `step` | `int` | `All` |
| `text` | `tstring<id,step>` | `Client` |
| `anchor` | `string` | `Client` |
| `anchor_key` | `int?` | `Client` |
| `panel` | `reskey?` | `Client` |
| `popup` | `reskey?` | `Client` |
| `pointer` | `bool` | `Client` |
| `restrict_input` | `bool` | `Client` |
| `complete` | `enum<TutorialComplete>` | `Client` |
| `complete_requirement` | `requirement<id,step>` | `Client` |
| `cue` | `enum<TutorialCue>?` | `Client` |
| `save` | `bool` | `Client` |

`tutorial_step` data check

- When `pointer` or `restrict_input` is `true` or `complete` is `AnchorTap`, and `anchor` is an empty string, it is `empty_required`
- When `complete` is `Requirement` and `complete_requirement` is 0 (empty cell), it is `empty_required`
- `anchor_key` is the anchor key of the anchor lookup. The cell holds an ID name. e.g. the ID name of the item in a slot. When null, the lookup is without an anchor key. A non-null value less than 1 is `out_of_range`. When `anchor_key` is not null and `anchor` is an empty string, it is `empty_required`
- When `cue` is `null`, that step has no cue. When `complete` is `Cue` and `cue` is `null`, it is `empty_required`
- `panel` is a panel key and `popup` is a popup key. When `panel` and `popup` are both not null, it is `out_of_range`
- When `popup` is not null and `restrict_input` is `false`, it is `out_of_range`
- resume start step: the first step of a tutorial, and the step right after a step whose `save` is `true`. When `popup` of a resume start step is not null, it is `out_of_range`
- When the `anchor` of a step whose `panel` or `popup` is not null is not in the prefab of that panel or popup, static check `anchor reference` blocks it

`data/enums.csv`

| type | element |
|---|---|
| `TutorialComplete` | `Advance`, `AnchorTap`, `Requirement`, `Cue`. The game does not change it |
| `TutorialCue` | set by the game |

`data/invariants.csv`

| kind | table | column | group | min | max | child_table | child_column |
|---|---|---|---|---|---|---|---|
| `order_column` | `tutorial` | `order` | | | | | |
| `order_column` | `tutorial_step` | `step` | `id` | | | | |
| `child_exists` | `tutorial` | `id` | | | | `tutorial_step` | `id` |
| `child_exists` | `tutorial_step` | `id` | | | | `tutorial` | `id` |

reserved string

| name | used by |
|---|---|
| `[tutorial_skip]` | skip button text |

## DEV

none

## test

- When two unfinished tutorials are candidates, the tutorial with the smaller `order` starts and `TutorialStepStartedEvent` is emitted with its first step
- A tutorial whose `start_requirement` has `passed` `false` or whose `can_start_tutorial` is `false` does not start
- When the progress step is k, it starts from the smallest step whose `step` is larger than k. When the progress step is the last `step`, `is_completed` is `true` and it does not start
- `check_start` during a `SceneCore` transition and while there is a `Shown` tutorial is `false`
- For a step whose `panel` is X, when the current panel is not X or a popup is open, there is no tutorial view and no block of reason tag `tutorial`. When X is the current panel and no popup is open, it shows; when a popup opens over it, there is no tutorial view and no block in the next frame, and when that popup closes, the same step shows again
- A step whose `popup` is P shows only while P is the topmost open popup, and when another popup opens over P, there is no tutorial view and no block in the next frame
- A step whose `panel` is X and whose `anchor` is a does not show when a is visible only in `SceneUI` outside X
- When the anchor of a step whose `panel` and `popup` are null is in a panel under an open modal popup, there is no tutorial view and no block, and when that popup closes, the same step shows
- While tutorial A with the smaller `order` is `Paused` waiting for the step screen condition, `check_start` starts the next candidate B and is `true`, and B becomes `Shown`. While B is `Shown`, A stays `Paused` even when the show condition of A holds. When B ends or becomes `Paused`, A becomes `Shown` in the next frame
- When the show conditions of two `Paused` tutorials hold in the same frame, the tutorial with the smaller `order` becomes `Shown`. When the `Shown` tutorial finishes a step and the show condition of its next step holds, that tutorial becomes `Shown` even when the show condition of a `Paused` tutorial with a smaller `order` holds
- Calling `notify_cue` with the current step `cue` of a `Paused` tutorial is `true` and that step ends. `current` returns the `Shown` tutorial, or the `Paused` tutorial with the smallest `order` when there is no `Shown` tutorial
- Before the anchor is visible, there is no tutorial view and no block of reason tag `tutorial`; after it is visible, the highlight and hand pointer are at the position of the anchor rectangle. When the anchor moves, they follow in the next frame
- When the vertical center of the anchor rectangle is above the vertical center of the view root, the speech bubble is right below the anchor rectangle, and when below, right above it. When the remaining height on that side is at least the speech bubble height, the speech bubble does not overlap the anchor rectangle and is inside the view root. When the anchor moves, the speech bubble follows in the next frame
- When the remaining height both above and below the anchor rectangle is less than the speech bubble height, the speech bubble overlaps the anchor rectangle, is inside the view root and touches the top edge or bottom edge of the view root
- When the speech bubble width is larger than the anchor rectangle width and the left edge of the anchor rectangle touches the left edge of the view root, the left edge of the speech bubble touches the left edge of the view root, and the vertical position of the speech bubble equals the one when the anchor rectangle is at the horizontal center of the view root
- In a step whose `restrict_input` is `true`, when the anchor element is hidden, there is no tutorial view and no block of reason tag `tutorial` in the next frame; when it is visible again, the same step shows again and the pass list uses the `element` of that time. The same holds when the anchor of the same name changes to another element
- When a step shows with `SafeAreaCore.set_virtual_notch` set, the position and size of the view root equal the safe area, the speech bubble, advance button and skip button are inside the safe area, the dim covers the whole visible game area, and the highlight and hand pointer are at the game coordinates position of the anchor rectangle
- When a system popup opens while a step shows, the tutorial view is not visible in the next frame, the block of reason tag `tutorial` and `Shown` stay as they are even when the anchor is under the system popup, and the buttons of the system popup receive presses. When the system popup closes, the tutorial view of the same step shows again in the next frame
- While waiting for the anchor, `notify_cue` of a `Cue` step is `true` and the step ends without the tutorial view. A `Requirement` step ends when `passed` becomes `true` during that time
- A `Requirement` step whose `complete_requirement` is a condition of a time-dependent type that reads server time ends when, without a delta, server time reaches the pass time of that condition and then the test clock advances by `RequirementCore.timeRecheckMs`. A tutorial that has the same condition as `start_requirement` starts the same way, with no `SceneStartedEvent`, `UserStateChangedEvent` or `check_start` until then
- In a step whose `restrict_input` is `true`, a tap outside the anchor rectangle does not reach UI elements, and a tap inside becomes a click of the anchor UI element. The buttons of a system popup receive presses
- In an `AnchorTap` step, a tap that the anchor UI element consumes finishes the step and also becomes a click of that element. Pressing inside the anchor rectangle and releasing outside does not finish the step
- In an `AnchorTap` step, `current` called inside the `UIButton` click callback of the anchor element is that step, and the `TutorialStepStartedEvent` of the next step is emitted after that click callback and before the next frame. The same holds for accept input when the input device is `Gamepad`. When `skip` is called inside the click callback, only one `TutorialCompletedEvent`(`skipped` = `true`) is emitted and there is no `TutorialStepStartedEvent` of the next step
- With anchor keys 7 and 9 on two visible `UIAnchor` elements named a, the highlight and hand pointer of a step whose `anchor` is a, `anchor_key` is 9 and `restrict_input` is `false` are on the anchor rectangle of key 9, and a tap inside the anchor of key 7 does not finish an `AnchorTap` step. When the anchor of key 9 is hidden, there is no tutorial view even when the anchor of key 7 is visible. A step whose `anchor_key` is null uses the one of the two anchors drawn on top
- When the input device is `Gamepad`, in an `Advance` step the advance button has focus and accept input finishes the step. In an `AnchorTap` step, the anchor UI element with a `UIButton` attached has focus and accept input is one click of that element and the step end. When the anchor UI element has no `UIButton`, only the visible skip button is a focus element; when `gamepadSupported` is `false` there is no error log, and when `true` an error log with the anchor name is left. When `skippable` is `true`, direction input moves focus to the skip button and accept input skips. In `Requirement` and `Cue` steps there is no `Tutorial` view focus
- For each `complete`, the step ends only on the condition in the table. `notify_cue` with another value is `false` and the step stays as it is
- Finishing a step whose `save` is `true` sends `SaveTutorialProgress` once with that `step`, and a step where it is `false` sends nothing unless it is the last step
- Finishing the last step sends `SaveTutorialProgress` with the last `step`, and the next candidate starts after `TutorialCompletedEvent`(`skipped` = `false`)
- When `SaveTutorialProgress` fails, the next step still proceeds, and the next save sends a larger `step`
- After `SaveTutorialProgress` of the last step fails, the start check of `SceneStartedEvent` sends `SaveTutorialProgress` once with the last `step`. A start check while waiting for that response and a start check after the UserState delta of the success response do not send it
- While `SaveTutorialProgress` is being sent, there is no block of reason tag `network` and no loading icon, and the anchor tap of the next step reaches the anchor UI element
- After a progress step is given with the UserState delta of a fake response, `release` and `init` make it start from the step after that
- When `skippable` is `true`, skip saves the last `step` of the `Shown` tutorial, emits `TutorialCompletedEvent`(`skipped` = `true`), releases the block and starts the next candidate. When `false`, there is no skip button and `skip` is `false`
- Even after a skip whose `SaveTutorialProgress` failed, `is_completed` is `true`, and after that `SceneStartedEvent` and `check_start` do not start that tutorial again
- When the scene changes during step progress, on `SceneEndedEvent` the block and tutorial view disappear and all active tutorials are `Paused`; before `SceneStartedEvent` it does not show again even when the anchor is visible, and when the anchor is visible after that, the same step shows again
- When proceeding without the tutorial view, an `Advance` step ends right after 3 and there is no block of reason tag `tutorial`
- With a tutorial view resource whose view root is not a UI element, an error log is left and it proceeds without the tutorial view, and later steps do not load the tutorial view resource again
- In a step whose `restrict_input` is `false`, a tap on the dim, speech bubble or hand pointer becomes a click of the UI element under it
- While a step whose `text` contains an input prompt token shows, changing the input device with `InputCore.set_test_device` rewrites the text element with the input prompt of the new input device, and an input device change after that step ends does not change the text element. The skip button text is the translation of `[tutorial_skip]`
- `SceneStartedEvent` and `check_start` before login do not start a tutorial
- When the `step` to send is at most the `TutorialProgressUserState` value, `SaveTutorialProgress` is not sent
- For each condition of the `tutorial_step` data check, a tutorial with a step that violates that condition does not start and an error log is left
- After `release`, there is no tutorial view and no block, and no further `SaveTutorialProgress` is sent
- `can_start_tutorial` registered as a function of a scene object is called in the start check while that object exists, and a start check after that object is destroyed by a scene transition uses the default `true`
- `is_completed` of a tutorial ID value not in the `tutorial` table is `false` and an error log is left
