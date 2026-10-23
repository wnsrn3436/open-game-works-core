# CutsceneCore

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

Plays a cutscene that shows dialogue and presentation by running the steps written in a data table in order. Owns line progress, line voice, conditional branching, choice, skip, cutscene pause and line history.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `ResourceCore`, `PoolCore`, `SoundCore`, `LocalizationCore`, `RequirementCore`, `SafeAreaCore`, `InputCore`, `InputBlockCore`, `TweenCore`, `CameraCore`, `ScreenEffectCore`, `UICore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `play` | cutscene ID value, resource scope, `FormatArgs` of `LocalizationCore`(empty when omitted), skippable flag(`true` when omitted) | async operation. `CutsceneResult` | `CutsceneResult` whose `status` is `Failed` and whose `choices` is empty | content code |
| `is_playing` | none | whether a cutscene is playing | `false` | all code |
| `register_actor` | actor key, object | success flag | `false` | content code |
| `unregister_actor` | actor key | none | none | content code |

- `CutsceneResult`: `status`(`CutsceneStatus`), `choices`(list of the `CutsceneChoiceRecord` of each choice picked with choice input during playback, in the order picked. An empty list when none was picked)
- `CutsceneStatus`

  | element | meaning |
  |---|---|
  | `Completed` | reached playback end without skip |
  | `Skipped` | reached playback end during skip handling |
  | `Stopped` | ended during playback because the resource scope was released or the module was `release`d |
  | `Failed` | could not start playback |

- `CutsceneChoiceRecord`: `step`(`step` of the picked `Choice` step), `choice`(`choice` of the picked `cutscene_choice` row)

- actor key: a snake_case string that points to an actor. Content code does not write actor keys in code. It registers with the actor component of the engine-specific implementation rules, or calls `register_actor` with a value read from data

## behavior

### step and command

- In `cutscene_step`, the rows with the same `id` form one cutscene. One row is a step, and playback runs steps in `step` order starting from the step with the smallest `step`. `Jump`, a passed `Branch` and a choice go to the `next_step` step
- A wait-optional command(`Move`, `Animate`, `Camera`, `ScreenEffect`, `Staging`) runs the next step after it ends when `wait` is `true`, and right after it starts when `false`. Other commands run the next step after they end
- in-progress command: a wait-optional command that has started and has not ended yet
- playback end: `End` has run or there is no next step to run, and there is no in-progress command
- finalize: puts an in-progress command into its end state and ends it. `Move` skips the tween to its end, `Camera` puts the camera at the goal position with `CameraCore.snap_to`, `ScreenEffect` skips the effect to its end, `Animate` applies the animation end state, and `Staging` destroys the instance.
- When a new command starts while the same command on the same target is in progress, it finalizes the previous command, then starts. `Move` and `Animate` have the same target when `actor` is the same; `Camera` and `ScreenEffect` have the same target as any command of the same kind. When the new command fails the start check (the list below of commands that leave an error log and end at once, the "the command ends at once" row of the error table), the start check comes before finalize, and the previous command is not finalized and continues. When an operation of a dependency module fails after the start check passes (e.g. `Failed` of `CameraCore.move_by_preset`, `ScreenEffectCore.play_preset`), the previous command has already been finalized
- Measured in game time: `Wait`, the tweens of `Move` and `Camera`. Measured in real elapsed time: typing, auto advance, fast forward, `ScreenEffect`

| command | behavior | ends when |
|---|---|---|
| `Line` | Shows the speaker name, portrait(`resource`) and text in the dialogue box and plays the line voice. Hides the speaker name when `speaker` is `null` and the portrait when `resource` is `null` | line progress |
| `Choice` | Shows choices | choice input |
| `Wait` | Waits for `duration` after all in-progress commands end | when the wait ends |
| `Move` | Moves `actor` to the position of the `target` actor at command start with the `resource` tween preset | when the tween ends |
| `Animate` | Plays `animation` of `actor`. A looping animation counts as ended once it starts | when the animation ends |
| `Camera` | Moves the camera to the position of the `target` actor at command start with `CameraCore.move_by_preset`, using the `resource` tween preset and the playback scope | when `move_by_preset` ends |
| `Sound` | Plays the `resource` sound as a sound effect. For a looping sound, keeps the playback handle | immediately |
| `Bgm` | Plays that BGM when `resource` is set, and stops the BGM when it is `null` | immediately |
| `ScreenEffect` | Plays the `resource` tween preset on the `Cutscene` channel with `ScreenEffectCore.play_preset`. The owner is the cutscene view | when the effect ends |
| `Staging` | Makes an instance from `resource`, attaches it as a child of `actor`, or to the staging parent when `actor` is an empty string, and starts it. Staging without an end counts as ended once it starts and is destroyed in playback end handling | when the staging ends and the instance is destroyed |
| `Cue` | Emits `CutsceneCueEvent` | immediately |
| `Jump` | Goes to the `next_step` step | immediately |
| `Branch` | Judges `requirement` with `RequirementCore.evaluate` and goes to the `next_step` step when `passed` is `true`, or to the next step in `step` order when `false` | immediately |
| `End` | Runs no more steps | immediately |

- These leave an error log and end at once: a command that uses an unregistered actor key, a command whose `Move` tween preset has no `Position` change, a `Move` whose `actor` and `target` differ in dimension (2D or 3D), an `Animate` of an animation the actor does not have, a `Camera` while `CameraCore.has_camera` is `false`, a `Camera` whose `target` dimension differs from the dimension of the attached camera (`CameraCore.is_3d_camera`), a `Move`, `Camera` or `ScreenEffect` whose tween preset has no first change, a `Camera` whose first change of the tween preset has a duration out of range. When there is no camera or the camera and `target` differ in dimension, the `Camera` command and its skip application call no `CameraCore` operation other than `CameraCore.has_camera` and `CameraCore.is_3d_camera`. When the actor is destroyed during a command, that command ends
- The tween preset of `Move`, `Camera`, `ScreenEffect` is resource type `tween`, loaded with the kind of `TweenCore.get_preset_kind`. At command start, it gets the preset that step 3 preloaded with `ResourceCore.get_loaded`(playback scope). When the received definition has no first change in its first step (a fallback definition from a failed load included), the start check fails. For `Camera`, the start check also fails when the duration of that change is not at least 0 and at most `TweenCore.maxDurationMs`. `ScreenEffect` calls `ScreenEffectCore.play_preset` at once with the received definition
- `Move` copies the tween preset with `TweenCore.copy_definition`, sets the target value of the last `Position` change in step order to the position of the `target` actor at command start converted to coordinates relative to the parent of `actor`, then plays it on `actor` with `TweenCore.play`. Other changes keep the preset values
- When the step run after a `Line` or `Choice` is neither `Line` nor `Choice`, it hides the dialogue box

### playback

1. Check: when a cutscene is playing, when there are no cutscene steps, or when the cutscene check fails, it does nothing and returns the failure value
2. Show the cutscene root and set the block with reason tag `cutscene`
3. Preload the view resource and the `resource` and `voice` of the steps with the playback scope. Go to step 4 regardless of the preload result. The `resource` and `voice` of a step that could not be loaded are the fallback resource of `ResourceCore` when the command uses them
4. Make the cutscene view, attach it to the cutscene root and do the view check. When it fails: during a cutscene pause, do the `TimeCore` handling of the cutscene pause end; destroy the view, clear the back override to none, hide the root, release the block and return the failure value
5. Run the first step

- playback scope: the resource scope that `play` received. The resources that playback loads and the sounds, BGM and tweens it plays all use the playback scope. When the playback scope is released, it does the stop
- cutscene check: applies the data check conditions of `## data` again to the rows of the cutscene to play
- playback end handling: the `TimeCore` handling of the cutscene pause end when in a cutscene pause, clearing the back override, destroying staging instances, stopping the kept looping sounds, stopping the line voice and replay voice, destroying the cutscene view, emptying the line history, hiding the cutscene root, releasing the block, returning the result. Actor positions, camera and BGM are not returned to their state before playback
- stop: without finalizing in-progress commands, stops the tweens, calls `CameraCore.stop_move` for `Camera`, then does playback end handling. `status` of the result is `Stopped`
- The line text and choice text are the result of `LocalizationCore.format` converting `text` with the `FormatArgs` of `play`. The inline icon height is the current font size of the text element for line text and 0 for choice text. It converts once when `Line` and `Choice` start and does not convert again on `InputCore.InputPromptChangedEvent`. The speaker name is the translation of `cutscene_speaker.name`

### cutscene view

- cutscene root: the UI element that CutsceneCore makes in `init` under one safe area root of `SafeAreaCore` that it makes inside `UICore.get_layer(Cutscene)`. Its position and size equal that safe area root. It is hidden while not playing, and while shown it receives all pointer input in its area. The engine mapping is in the engine-specific implementation rules
- cutscene view root: the root of the instance made from the cutscene view resource; a UI element. When attached to the cutscene root in step 4, its position and size are set equal to the cutscene root, and they change when the cutscene root changes. The engine mapping is in the engine-specific implementation rules
- The cutscene view resource is game settings `cutsceneView`. The view root has the cutscene view component of the engine-specific implementation rules, and the component points to the parts below

  | part | required |
  |---|---|
  | staging parent(ignores the safe area), dialogue box, speaker name element, portrait element, text element, choice button list(one or more), advance button, skip button | yes |
  | auto advance button, fast forward button | no |
  | line history button, line history window, line history list, line history close button | no. Either all four exist or none does |

- view check: the view root is a UI element, the component exists, all parts with required yes in the part table exist, the parts with no keep the condition of the required cell, and the `UIButton` action of the advance button and the skip button is an empty string. A button part without a `UIButton` of `UICore` counts as missing. Because CutsceneCore receives `cutscene_advance` and `cutscene_skip` directly from `InputCore`, one press is one advance input or skip input only when the action of the two buttons is an empty string
- render order: staging parent < other parts < line history window. The `Cutscene` channel overlay is on the `CutsceneEffect` layer, so it is drawn below the whole cutscene view
- block: reason tag `cutscene`, set with `InputBlockCore` from step 2 of `play` until playback end handling. Pass: actions `cutscene_advance`, `cutscene_skip`, `back`, the cutscene root, the system popup root of `UICore.get_block_pass_list`. `cutscene_advance` and `cutscene_skip` are core actions of `InputCore`
- view focus: from attaching the cutscene view until playback end handling, each time the state of the table below changes, it calls `UICore.set_view_focus`(`Cutscene`, focus element list, initial focus element, none). Playback end handling clears it with an empty list

  | state | focus elements | initial focus |
  |---|---|---|
  | line history window is open | visible voice buttons of the line history list, line history close button | line history close button |
  | `Choice` running | choice buttons that are visible and not locked, line history button when it exists | first choice button that is not locked |
  | otherwise | those of advance button, skip button, auto advance button, fast forward button, line history button that exist and are visible | advance button |

### line progress

- advance input: an advance button click, a press of the `cutscene_advance` action in this frame. An advance button click while `cutscene_advance` is held down is not an advance input: a press of the same key or gamepad button and the click are one advance input. A press of `cutscene_advance` while a view button other than the advance button has UICore focus is not an advance input: that accept input is a click of that button
- advance input during `Line`: during typing it shows the whole text, and when the whole text is shown it ends the `Line`. Advance input outside `Line` is ignored
- typing: visible character count = the quotient of the time elapsed since `Line` start ÷ `CutsceneCore.typingIntervalMs`. It does not exceed the character count of the text. When `CutsceneCore.typingIntervalMs` is 0, it shows the whole text at start. The character count of the text counts an inline icon as one character
- auto advance: when on, it ends the `Line` `CutsceneCore.autoAdvanceDelayMs` after the whole text is shown and voice end is reached. The wait is measured from the later of the two
- fast forward: when on, it shows the whole text at once and ends the `Line` after `CutsceneCore.fastForwardDelayMs`. When both it and auto advance are on, fast forward applies
- A click on the auto advance button or the fast forward button turns that feature on and off and shows the on state on the button. Each playback starts with both off

### line voice

- line voice: the `voice` sound of a `Line` step. It is the source text of that row's `text` read aloud in the source language, and the same sound plays regardless of the current language. When a `Line` starts with `voice` not `null` and fast forward off, it plays it with `SoundCore.play`(`voice`, `Voice`, playback scope) and keeps the play handle. A `Line` started while fast forward is on plays no line voice
- voice end: `SoundCore.is_playing` of the kept line voice handle is `false`. A `Line` that played no line voice is at voice end from its start
- When a `Line` ends, it stops the line voice with `SoundCore.stop`. The same holds whichever of advance input, auto advance, fast forward or skip input ends it
- replay voice: a voice played by a voice button click of a line history item. The click stops the playing line voice and replay voice and plays the `voice` of that item with `SoundCore.play`(`voice`, `Voice`, playback scope). Closing the line history window stops the replay voice

### choices

- locked choice: a `cutscene_choice` row whose `requirement`, judged with `RequirementCore.evaluate` when the `Choice` starts, has `passed` `false`. It judges once per `Choice` at start and does not judge again during the `Choice`
- `Choice` takes the `cutscene_choice` rows of that step minus the locked choices with `hide_locked` `true`, puts the remaining rows into the choice buttons from the front in `choice` order, shows them and hides the remaining buttons. When there are more remaining rows than buttons, it leaves an error log and shows as many as there are buttons
- The button of a locked choice shows the text and is put in the locked state. A button in the locked state does not receive clicks. The display of the locked state is in the engine-specific implementation rules
- `Choice` does not change the visibility of the dialogue box. Choice buttons are outside the dialogue box
- On a choice input (a click on a choice button that is visible and not locked), it puts the `CutsceneChoiceRecord` of the picked row at the end of `choices` of the result, hides all choice buttons and clears their locked state, ends the `Choice`, then goes to `next_step` of the picked row. Advance input, auto advance and fast forward do not end a `Choice`

### skip

- skippable playback: a playback in which the skippable flag of `play` is `true`. In a playback that is not skippable, it hides the skip button for the whole playback and ignores skip input, so no skip happens. Line progress, choice and line history are the same
- skip input: in a skippable playback, a skip button click, a press of the `cutscene_skip` action in this frame.
- On a skip input, it does these in order without waiting: finalize the in-progress commands → end the running `Line` or `Wait` and hide the dialogue box → do skip application from the next step → on reaching a `Choice`, run that `Choice` and end the skip. Later steps run without skip application → on reaching playback end, do playback end handling
- skip application: `Line` is not shown, plays no line voice and is not put in the line history. `Wait`, `Staging`, `Sound` are not done. `Move`, `Animate`, `Camera`, `ScreenEffect` start and are finalized at once. `Cue` emits the event. `Jump`, `Branch`, `End` are done as usual. Of the `Bgm` steps met, only the last one runs, before the `Choice` runs or before playback end handling
- Skip input during `Choice` is ignored

### cutscene pause

- cutscene back input: the back input that the callback set with `UICore.set_back_override` receives from playback step 2 until playback end handling. CutsceneCore sets the callback in playback step 2 and clears it to none on step 4 failure and in playback end handling
- On a cutscene back input, it closes the line history window when it is open; otherwise, when not in a cutscene pause, it starts a cutscene pause
- cutscene pause start: when `TimeCore.is_paused` is `false`, it calls `TimeCore.set_paused(true)` and remembers that it called it. Then it opens the pause popup with `UICore.open_system_popup`. The body is `[cutscene_pause_body]`, the buttons are `[cutscene_pause_resume]` and, in a skippable playback while no `Choice` is running, `[cutscene_pause_skip]`, and the back button is `[cutscene_pause_resume]`. When `open_system_popup` is `false`, it leaves an error log and ends the cutscene pause
- During a cutscene pause, it does not count the real elapsed time of typing, auto advance and fast forward. It ignores advance input, choice input and skip input and does not run the next step. What is measured in game time and the line voice and replay voice of the `Voice` bus stop through the pause of `TimeCore`
- A `[cutscene_pause_resume]` click ends the cutscene pause. A `[cutscene_pause_skip]` click ends the cutscene pause, then is handled the same as a skip input
- cutscene pause end: when it called `TimeCore.set_paused(true)` at the start, it calls `TimeCore.set_paused(false)`. Then it runs the next step that it could not run in the meantime
- A pause popup button click after playback ends only closes the popup

### line history

- line history: the list of the speaker, converted text and `voice` of each `Line` run during playback, in run order. An item is added at `Line` start, and when the count exceeds `CutsceneCore.lineHistoryMaxCount`, the oldest item is discarded
- A line history button click opens the window when it is closed and closes it when it is open. A close button click closes it
- An item of the line history list points to a speaker name element, a text element and a voice button. The voice button can be absent. The engine mapping is in the engine-specific implementation rules
- opening: fills the line history list (`UICore` scroll list) with the line history items. Index 0 is the oldest item. It hides the speaker name element of an item without a speaker and the voice button of an item whose `voice` is `null`. It does not convert the text again
- While the window is open, it ignores advance input, choice input and skip input, and the `Line` does not end. When the window closes, it measures the waits of auto advance and fast forward again from the beginning

### watch record and lifecycle

- CutsceneCore does not save the watch record or the picked choices. Content code saves them from `status` and `choices` of the result. A watch record or picked choice tied to a reward or progress is kept on the server
- Typing, the advance input check, the voice end check and the end check of `Line` and `Wait` do not allocate new memory per frame
- Actor registrations stay until `release`, regardless of playback. When a registered object is destroyed, it deletes that registration
- `release` does the stop when playing, deletes all actor registrations, and destroys the cutscene root and its safe area root

## hook

none

## event

| event | when | payload |
|---|---|---|
| `CutsceneCueEvent` | When a `Cue` runs or gets skip application | `cutscene_id`: ID value, `step`: int, `cue`: `CutsceneCue` value |

## error

| condition | failure value | log |
|---|---|---|
| `play` during playback | failure value. The playback in progress continues | error |
| cutscene ID without steps, cutscene check failure | failure value | error. Cutscene ID and the failed check |
| view check failure, view resource cannot be loaded | failure value | error |
| in playback step 3, the `resource` or `voice` of a step cannot be loaded | playback continues. That resource is the fallback resource of `ResourceCore` | `ResourceCore` leaves it |
| `register_actor` with an already registered actor key, a destroyed object, or an object that cannot be an actor | `false` | error |
| unregistered actor, no `Position` change in the tween preset of `Move`, `actor` and `target` of `Move` differ in dimension, missing animation, no camera, the camera and `target` of `Camera` differ in dimension, no first change in the tween preset of `Move`, `Camera`, `ScreenEffect`, the duration of the first change of the tween preset of `Camera` out of range | the command ends at once | error |
| more choice rows to show than choice buttons | shows as many as there are buttons | error |
| `UICore.open_system_popup` of the cutscene pause start is `false` | ends the cutscene pause | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `cutsceneView` | string | game | none | resource key of the cutscene view |
| `CutsceneCore.typingIntervalMs` | integer | core | content | interval at which typing shows one more character. 0 means no typing |
| `CutsceneCore.autoAdvanceDelayMs` | integer | core | content | in auto advance, the time from the whole text being shown and voice end being reached until the `Line` ends |
| `CutsceneCore.fastForwardDelayMs` | integer | core | content | in fast forward, the time from the whole text being shown until the `Line` ends |
| `CutsceneCore.lineHistoryMaxCount` | integer | core | content | limit on the number of line history items |
| `TweenCore.maxDurationMs` | integer | core | content | maximum duration of the first change of a tween preset that the `Camera` start check accepts |

## data

`data/tables/cutscene_step.csv`

| column | type | build target | used by command |
|---|---|---|---|
| `id` | `id` | `All` | all. cutscene ID |
| `step` | `int` | `Client` | all |
| `command` | `enum<CutsceneCommand>` | `Client` | all |
| `wait` | `bool` | `Client` | wait-optional command |
| `actor` | `string` | `Client` | `Move`, `Animate`, `Staging`(can be empty) |
| `target` | `string` | `Client` | `Move`, `Camera` |
| `speaker` | `ref<cutscene_speaker.id>?` | `Client` | `Line`(can be empty) |
| `text` | `tstring<id,step>` | `Client` | `Line` |
| `resource` | `reskey?` | `Client` | `Line`·`Bgm`(can be empty), `Move`, `Camera`, `Sound`, `ScreenEffect`, `Staging` |
| `animation` | `string` | `Client` | `Animate` |
| `duration` | `duration?` | `Client` | `Wait` |
| `cue` | `enum<CutsceneCue>?` | `Client` | `Cue` |
| `next_step` | `int?` | `Client` | `Jump`, `Branch` |
| `voice` | `reskey?` | `Client` | `Line`(can be empty) |
| `requirement` | `requirement<id,step>` | `Client` | `Branch` |

`data/tables/cutscene_choice.csv`

| column | type | build target |
|---|---|---|
| `id` | `id` | `All` |
| `step` | `int` | `Client` |
| `choice` | `int` | `Client` |
| `text` | `tstring<id,step,choice>` | `Client` |
| `next_step` | `int` | `Client` |
| `requirement` | `requirement<id,step,choice>` | `Client` |
| `hide_locked` | `bool` | `Client` |

- A row whose `requirement` is an empty cell does not become a locked choice. `hide_locked` is whether to hide the row when it is a locked choice

`data/tables/cutscene_speaker.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |

data check. The rows with the same `id` are one cutscene

- A `step` of `cutscene_step` less than 1 is `out_of_range`, and one repeated within the same cutscene is `duplicate`
- A `next_step` of `cutscene_step` or `cutscene_choice` that is not a `cutscene_step` `step` of the same cutscene is `ref_missing`
- A `next_step` of `Jump` or `Branch` that is at most the `step` of that step is `out_of_range`
- A `Choice` step without a `cutscene_choice` row with the same `id` and `step` whose `requirement` is an empty cell is `required_missing`. So each `Choice` has at least one choice that does not become a locked choice
- Two rows in `cutscene_choice` with the same `id`, `step`, `choice` are `duplicate`. A `cutscene_choice` row with no `cutscene_step` row of the same `id`, `step` is `ref_missing`, and when `command` of that `cutscene_step` row is not `Choice`, it is `out_of_range`
- The empty string of `string` and `tstring`, `null` of a nullable, `false` of `bool` and the empty cell of `requirement` count as empty values. In a `cutscene_step` row, a column that the command does not use and that holds a value that is not empty is `out_of_range`. Among the columns the command uses, a column other than `wait` and the columns marked as can be empty that holds an empty value is `empty_required`
- An `actor` or `target` that is not an empty string and not snake_case is `value_type`
- When `cue` is `null`, that step emits no cue
- A `voice` other than `null` that is the same in two `cutscene_step` rows is `duplicate`

`data/enums.csv`

| type | element |
|---|---|
| `CutsceneCommand` | `Line`, `Choice`, `Wait`, `Move`, `Animate`, `Camera`, `Sound`, `Bgm`, `ScreenEffect`, `Staging`, `Cue`, `Jump`, `End`, `Branch`. The game does not change it |
| `CutsceneCue` | set by the game |

- Other tables point to a cutscene with `ref<cutscene_step.id>`
- reserved string: `[cutscene_pause_body]`, `[cutscene_pause_resume]`, `[cutscene_pause_skip]`
- reserved ID, reserved sound: none

## DEV

none

## test

- During a `Line`, while the line history button has UICore focus, pressing and releasing a gamepad button bound to both `ui_accept` and `cutscene_advance` opens the line history window, and the `Line` does not end
- Clicking the advance button with the mouse while holding the `cutscene_advance` key gives one advance input, that of the key press
- Steps run in `step` order from the first step, and the next step runs after a wait-optional command with `wait` `true` ends, and right after one with `false` starts
- With the test clock, `Wait` does not end before the in-progress commands have ended and `duration` has passed, and ends once it has passed
- At playback end, `status` of the result is `Completed`, there is no cutscene view and no block with reason tag `cutscene`, and the line history is empty
- After `Jump`, a `Branch` with `passed` `true` and a choice input, the `next_step` step runs, and after a `Branch` with `passed` `false`, the next step in `step` order runs. The same holds for a `Branch` during skip application
- When `Move` ends, the world position of `actor` equals the world position of `target` at command start, also when `actor` and `target` have different parents. When the preset has two `Position` changes, the earlier change goes to the target value of the preset. When `Camera` ends, the camera shows `target`
- Even when the parent of a 2D actor is a 3D object or an object that is neither 2D nor 3D, when a `Move` to a 2D `target` ends, the world position of `actor` equals the world position of `target`
- A `Move` with a 2D `actor` and a 3D `target`, and one with a 3D `actor` and a 2D `target`, each leave one error log and end without moving `actor`, and the next step runs
- For an `Animate` of a looping animation, the next step runs right after it starts even when `wait` is `true`
- For each command failure of the error table, playback continues after an error log. Destroying the actor during a command ends that command
- While no camera is attached, a `Camera` command ends at once after one error log of CutsceneCore, and there is no error log of `CameraCore`
- A `Camera` with a `target` of a different dimension started while a `Camera` is in progress, and an `Animate` of a missing animation of the same `actor` started while an `Animate` is in progress, each leave one error log and end, and the previous command is not finalized and runs to its end
- Even when a `Camera` whose tween preset has no first change is skipped by skip input or run by skip application, the camera is at the same position as without that `Camera`
- A `Camera` with a tween preset without a first change started while a `Camera` is in progress, a `ScreenEffect` with a tween preset that could not be loaded started while a `ScreenEffect` is in progress, a `Move` with a tween preset whose step 0 is empty started while a `Move` of the same `actor` is in progress, and a `Camera` with a tween preset whose first change has a duration longer than `TweenCore.maxDurationMs` started while a `Camera` is in progress each leave one error log of CutsceneCore and end, and the previous command is not finalized and runs to its end
- A `Camera` with a 2D `target` while a 3D camera is attached and a `Camera` with a 3D `target` while a 2D camera is attached each end at once without moving the camera after one error log of CutsceneCore, and do not move the camera in skip application either
- A cutscene whose `Line` `resource` and `voice` cannot be loaded also continues to step 4 and plays to the end, and `status` of the result is `Completed`. The portrait element shows the fallback resource of `ResourceCore`, and there is no error log of CutsceneCore
- Each `play` and `register_actor` failure of the error table gives the failure value and an error log, and after a failed `play` the cutscene root is hidden and there is no view or block. A `play` during playback does not change the playback in progress
- After a registered object is destroyed, registering another object with the same actor key gives `true`
- With the test clock, with typing interval d and a text of n characters, k characters are visible at k × d (k < n) and n characters at n × d. With interval 0, n characters are visible at start
- An advance input during typing shows the whole text and does not end the `Line`, and an advance input after the whole text is shown ends it. An advance input outside `Line` does not change how the steps run
- The text element of a `text` with format arguments equals the conversion result of `LocalizationCore`. The text element of a `text` with an input prompt token shows the input prompt at `Line` start and does not change even when `InputPromptChangedEvent` occurs during the `Line`
- In a `Line` without line voice, auto advance does not end it at `CutsceneCore.autoAdvanceDelayMs` − 1 and ends it at the delay itself. Fast forward shows the whole text at start and ends it at `CutsceneCore.fastForwardDelayMs`. When both are on, fast forward applies. Both are off at playback start
- `Choice` shows choices in `choice` order and does not end before a choice input, even with auto advance and fast forward on and an advance input arriving. Choices are shown even when `Choice` runs with the dialogue box hidden
- The line history grows per `Line`, and after the (`CutsceneCore.lineHistoryMaxCount` + 1)th `Line` the oldest item is gone. Index 0 of the line history list is the oldest item
- While the line history window is open, advance, choice and skip input are ignored and auto advance does not end the `Line`. After the window closes, it ends at `CutsceneCore.autoAdvanceDelayMs`
- The skip of a cutscene without `Choice` ends in the same frame, `status` of the result is `Skipped`, the actors of all `Move` are at their goal positions, the remaining `Cue` are emitted in order, there are no sound effects, line voice or staging instances, and the BGM is the result of the last `Bgm`
- With a `Choice`, the skip stops at that `Choice`, and the steps after the choice input run without skip application. A skip during `Choice` is ignored
- Releasing the playback scope or doing `release` during playback makes `status` of the result `Stopped`, and there is no view, staging instance, line voice, replay voice or block. After `release` and `init` again, registration with a previous actor key succeeds
- During playback the active block is the one with reason tag `cutscene`, and `cutscene_advance`, `cutscene_skip`, `back` and the cutscene root area pass while other actions do not
- In a `Line` that is typing, back input opens the pause popup and `TimeCore.is_paused` is `true`; advancing the test clock leaves the visible character count unchanged, the line voice stays stopped on the `Voice` bus, and the next step does not run. After a `[cutscene_pause_resume]` click or the back input of the pause popup, typing and line voice continue and `TimeCore.is_paused` is `false`
- When `TimeCore.set_paused(true)` was in effect before playback, `TimeCore.is_paused` is `true` even after the cutscene pause ends
- During a cutscene pause, presses of `cutscene_advance` and `cutscene_skip` are ignored, and a `[cutscene_pause_skip]` click gives the same result as a skip button click. The pause popup of a playback with skippable flag `false` and the one while `Choice` runs have no `[cutscene_pause_skip]`
- Back input while the line history window is open closes the window and does not open the pause popup
- Back input after playback end follows the handling other than back override in the back input order of UICore
- When the input device is `Gamepad`, during `Line` the advance button has focus and an accept input is one advance input. During `Choice`, the first choice button has focus, and it goes to `next_step` of the choice picked with direction input and accept input. When the window opens by the accept input of the line history button, the close button has focus. After playback end there is no `Cutscene` view focus
- A press of `cutscene_skip` does one skip, the same as a skip button click, and is ignored during `Choice` and while the line history window is open
- A `play` called with a cutscene view whose advance button or skip button has a `UIButton` action that is not an empty string gives the error log of the view check failure and the failure value, and after that the cutscene root is hidden and there is no view, block or back override
- Pressing `cutscene_advance` for one frame during typing shows the whole text, and the `Line` does not end
- When playback ends after the block was released by `InputBlockCore.release_all` during playback, there is no error log
- Actor positions and BGM right before and right after `Completed`, `Skipped`, `Stopped` playback end handling are the same. The handle of a looping sound is stopped after playback end handling
- For each `Cue`, `CutsceneCueEvent` holding the cutscene ID, `step` and `cue` is emitted once
- The `Cutscene` channel is transparent at start, in the preset end state when `ScreenEffect` completes, and transparent after playback end, stop and `release`
- The dialogue box is hidden on a `Move` after a `Line`, and shown on a `Line` or `Choice` after a `Line`
- When playing with a virtual notch, the position and size of the cutscene root and the view root equal the safe area
- After `init` and before playback, the cutscene root is hidden under the CutsceneCore safe area root of the `Cutscene` layer, and the layer below receives the pointer input of that area. After `release` there is no such safe area root in the `Cutscene` layer
- When playing with skippable flag `false`, the skip button is not shown for the whole playback, a press of `cutscene_skip` does no skip, and `status` of the result after running to the end is `Completed`. A playback with the skippable flag omitted shows the skip button
- A locked choice with `hide_locked` `true` is not shown, and a locked choice with `false` is shown with its text in the locked state, and a click on it does not end the `Choice`. A choice whose `requirement` passes is not locked
- When the input device is `Gamepad`, during `Choice` a choice button in the locked state is not among the focus elements, and when the first choice is a locked choice, the initial focus is the first choice button that is not locked
- Each choice input adds the picked `step` and `choice` at the end of `choices` of the result. When playback stops after a pick, the result with `status` `Stopped` also has the choices picked until then, and `choices` of a failed `play` is empty
- When a `Line` with `voice` starts, that voice is in `SoundCore.get_playing` on the `Voice` bus, and it is not there in the frame in which the `Line` ended by advance input or skip input
- While the line voice is playing, auto advance does not end the `Line`, and ends it `CutsceneCore.autoAdvanceDelayMs` after voice end
- A `Line` started while fast forward is on and a `Line` under skip application play no line voice
- A voice button click of a line history item stops the line voice and plays the voice of that item on the `Voice` bus, and closing the window stops that playback. An item whose `voice` is `null` shows no voice button
- In the typing of a `Line` whose text holds one inline icon, the character count of the text is the count with the inline icon counted as one character
- Two `cutscene_step` rows with the same `voice` other than `null` are data check `duplicate`
