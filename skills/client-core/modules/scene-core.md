# SceneCore

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

Handles the transition that replaces the one scene on screen with another scene, the loading screen during it, and the retry of scene preparation failures.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `ResourceCore`, `PoolCore`, `SafeAreaCore`, `InputBlockCore`, `ScreenEffectCore`, `UICore`, `MessageCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `change_scene` | scene key, scene param | async operation. success flag | `false` | content code, `QACore`, `ShortcutCore`, `BootstrapCore`(`FirstScene` stage) |
| `boot_change_scene` | scene key, scene param | async operation. success flag | `false` | `BootstrapCore`(`TitleScene` stage), test |
| `current_scene_key` | none | scene key of the current scene | empty string | all code |
| `current_scope` | none | resource scope of the current scene | none | all code |
| `current_root_panel_key` | none | root panel key of the current scene. Empty string when there is none | empty string | `ShortcutCore`, content code |
| `is_transitioning` | none | whether a transition is in progress | `false` | all code |

- scene key: the resource key of a scene resource. e.g. `scene/lobby/main`
- scene param: the object a transition passes to the new scene. When there is no value to pass, none is passed. The caller does not change it after passing it

## behavior

### scene

- Only one scene placed by SceneCore is on screen at a time. This is the current scene. Before the first transition, from stage 3 of a transition until before stage 7, and after `release`, there is no current scene
- The scene root is the scene base type that the engine-specific implementation rules set. When the root is not the scene base type, it is an unrecoverable failure
- The scene root reads the scene key, scene param and resource scope. SceneCore puts the values in at stage 4
- root panel key: one panel key that the scene root sets through the scene base type. It can be absent. SceneCore opens that panel with `UICore.open_root_panel` at stage 7
- scene UI root: the UI element that the scene root points to through the scene base type. It can be absent. The scene's UI is placed under the scene UI root, and scene code does not place UI elements directly in the `SceneUI` layer
- In `init`, SceneCore creates one safe area root of `SafeAreaCore` inside `UICore.get_layer(SceneUI)` and destroys it in `release`. The scene UI root moved at stage 7 has the same position and size as this safe area root
- scene holder: an engine object that SceneCore creates in `init` and destroys in `release`. A scene is under the scene holder from stage 4 until it is destroyed. From stage 4 until before stage 7, the scene under the scene holder is not visible and does not receive the per-frame engine callbacks or the input callbacks. The initialization that the engine does when an object is attached finishes at stage 4, so scene code can use references to its child objects from `on_preload`. The engine mapping is in the engine-specific implementation rules
- Callbacks that the scene root implements. A callback that is not implemented behaves as `default`

  | callback | when | input | output | default |
  |---|---|---|---|---|
  | `on_exit` | stage 2 | none | none | does nothing |
  | `on_preload` | stage 5 | empty preload request, empty pool fill list | none | adds nothing to the lists |
  | `on_prepare` | stage 6 | none | async operation. success flag | `true` |
  | `on_start` | stage 7 | none | async operation. none | ends at once |

- `on_prepare` is where the scene requests from the server the values it uses. Scene code after `on_start` ends does not start loading resources
- Code outside SceneCore does not call the engine's scene change functions

### transition

A transition is in progress from the start of stage 1 until it ends at stage 8. A `change_scene` or `boot_change_scene` received during a transition leaves a warn log and returns `false`. The transition in progress does not change.

| stage | work |
|---|---|
| 1 begin | Sets the transition block. Closes the black box message with `MessageCore.close_black_box`. Does not close toasts. Calls `InputBlockCore.release_all` with `scene` as the reason tag to keep. Turns the panel lock on with `UICore.set_panel_lock` and calls `UICore.close_all_popups`. Shows the loading screen and waits until that ends |
| 2 exit | When there is a current scene, calls `on_exit` and sends `SceneEndedEvent` |
| 3 unload | Calls `UICore.reset_panel_stack`. Destroys the current scene and its scene UI root, and after the destruction ends, releases that scene's resource scope |
| 4 load | Creates a resource scope with the new scene key, loads the scene resource with that scope, creates the scene and places it under the scene holder. When there is a scene UI root, before placing the scene under the scene holder, sets the root's position and size equal to the safe area root of the `SceneUI` layer, and sets them equal again on every `SafeAreaCore.SafeAreaChangedEvent` until it is moved at stage 7. This is so that the `SafeAreaCore` parent check of ignore-mark UI elements under it sees a parent within the rules even under the scene holder |
| 5 preload | With the lists that `on_preload` filled, preloads through `ResourceCore` and fills pools through `PoolCore`. Goes to stage 6 even on failure |
| 6 prepare | Calls `on_prepare` and waits. When it is `false`, opens the retry popup |
| 7 start | Turns the panel lock off with `UICore.set_panel_lock`. Makes the new scene visible and receive the per-frame engine callbacks and the input callbacks, moves the scene UI root, when there is one, under the safe area root of the `SceneUI` layer, and makes the new scene the current scene. When there is a root panel key, calls `UICore.open_root_panel` and waits. Calls `on_start` and waits |
| 8 end | Waits until `SceneCore.loadingMinDisplayMs` passes from the time the loading screen was shown. Hides the loading screen and waits until that ends. Releases the transition block. The transition ends. Sends `SceneStartedEvent`. The result is `true` |

- transition block: the block with reason tag `scene` that is set through `InputBlockCore` from stage 1 until hiding the loading screen at stage 8 ends. The pass list is `UICore.get_block_pass_list`. It is released while the retry popup is open
- Panel opens and closes received after the panel lock is turned off at stage 7 are handled even during the transition. e.g. `on_start` opens a panel on top of the root panel
- The minimum display duration is measured with the real elapsed time of `TimeCore`
- `boot_change_scene` does not use the loading screen, the minimum display duration or the retry popup. `false` at stage 6 is an unrecoverable failure. Everything else is the same as `change_scene`
- `change_scene` is accepted only after `boot_change_scene` has succeeded once. A call before that leaves an error log and returns `false`

### loading screen

- The loading screen is the screen that covers the whole screen during a transition. Its resource key is game settings `loadingScreen`. When first shown, it is loaded with the global scope and created once; it is reused in the next transitions and destroyed at `release`
- In `init`, SceneCore creates one safe area root of `SafeAreaCore` inside `UICore.get_layer(Loading)` and destroys it in `release`. The loading screen is placed under this safe area root with the same position and size as the safe area root
- The full-screen background of the loading screen gets an ignore mark. Other UI elements are placed inside the safe area
- Callbacks that the loading screen root implements

  | callback | when | input | output | default |
  |---|---|---|---|---|
  | `on_show` | stage 1 | new scene key | async operation. none | ends at once |
  | `on_progress` | when shown, when progress changes | progress permille | none | does nothing |
  | `on_hide` | stage 8 | none | async operation. none | ends at once |

- progress permille = finished task count × 1000 ÷ total task count, rounded down. The tasks are loading the scene, each item of the preload request, each pool fill, and `on_prepare`. The total task count is set when `on_preload` returns at stage 5 and does not change after that. Before that, progress is 0. It does not decrease, and it is 1000 after `on_prepare` returns `true`
- For the fade and flash of `on_show` and `on_hide`, the loading screen root makes requests to the `Transition` channel of `ScreenEffectCore` with the loading screen root as owner. When the transition ends or stops, SceneCore clears that owner's effects with `ScreenEffectCore.clear_owner`
- When the loading screen root is not the loading screen base type, SceneCore leaves an error log and destroys it. That transition runs without a loading screen, and the next transition creates it again

### retry popup

- The popup that SceneCore opens with `UICore.open_system_popup` on `false` at stage 6. The body is `[scene_prepare_failed]` and it has one button. It does not close with back input
- When the retry count is less than `SceneCore.prepareRetryCount`, the button is `[scene_retry]`. Pressing it sets the transition block again and runs stage 6 again
- When the retry count reaches `SceneCore.prepareRetryCount`, the button is `[scene_restart]`. Pressing it sends `RestartRequestedEvent`
- When the popup closes without a button, it sends `RestartRequestedEvent`
- A transition in which `[scene_restart]` is pressed or the popup closes without a button skips the remaining stages, ends with `false`, and stays in transition until `release`

### unrecoverable failure

- scene resource cannot be loaded, scene root is not the scene base type, transition block cannot be set, retry popup cannot be opened, `on_prepare` of `boot_change_scene` is `false`, `open_root_panel` is `false`
- When the transition block is set, it is released, and `FatalErrorRequestedEvent` is sent. The transition stops at that stage and ends with `false`. The loading screen and the panel lock stay as they are, and it stays in transition until `release`

### lifecycle

- `release` stops the transition in progress, clears the `ScreenEffectCore` effects of the loading screen owner, and destroys the current scene and its scene UI root, the scene created at stage 4, the loading screen, the safe area roots of the `SceneUI` layer and the `Loading` layer, and the scene holder. The resource scope is released by `release` of `ResourceCore`
- A stopped transition does not change SceneCore state even when an operation it was waiting on ends. The closing of a retry popup that was open is ignored

## hook

none

## event

| event | when | payload |
|---|---|---|
| `SceneEndedEvent` | after `on_exit` is called at stage 2 | `scene_key`: the scene that ends |
| `SceneStartedEvent` | after the transition ends at stage 8 | `scene_key`: new scene, `duration_ms`: real elapsed time from the start of stage 1 |

- `RestartRequestedEvent` and `FatalErrorRequestedEvent` that SceneCore sends are boot events of `EventCore`, and `BootstrapCore` handles them

## error

| condition | failure value | log |
|---|---|---|
| `change_scene`, `boot_change_scene` during a transition | `false` | warn. The requested scene key and the scene key in progress |
| `change_scene` before `boot_change_scene` succeeds | `false` | error |
| scene resource cannot be loaded, root is not the scene base type, transition block cannot be set, `on_prepare` of `boot_change_scene` is `false`, `open_root_panel` is `false` | `false` | error. `FatalErrorRequestedEvent` |
| loading screen root is not the loading screen base type | none. Transition without a loading screen | error |
| retry popup cannot be opened | `false` | error. `FatalErrorRequestedEvent` |
| preload or pool fill failure | none. The transition continues | left by `ResourceCore`, `PoolCore` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `loadingScreen` | string | game | none | resource key of the loading screen |
| `SceneCore.loadingMinDisplayMs` | integer | core | content | minimum duration from showing the loading screen until starting to hide it |
| `SceneCore.prepareRetryCount` | integer | core | content | largest number of times `on_prepare` can be called again through the retry popup. 0 or more |

## data

reserved string

| name | used by |
|---|---|
| `[scene_prepare_failed]` | retry popup body |
| `[scene_retry]` | retry button of the retry popup |
| `[scene_restart]` | restart button of the retry popup |

## DEV

none

## test

- When there is a current scene, `change_scene` is `true`, `current_scene_key` is the new scene key, `current_scope` is the scope whose name is the new scene key, and `is_transitioning` is `false`
- A transition happens in this order: showing the loading screen, `on_exit`, `SceneEndedEvent`, emptying the panel stack, destroying the previous scene, releasing the previous scope, loading the new scene, `on_preload`, preload, pool fill, `on_prepare`, opening the root panel, `on_start`, hiding the loading screen, releasing the transition block, `SceneStartedEvent`
- A transition without a current scene has no `on_exit` and no `SceneEndedEvent`
- Right after a transition is received, the only active block is the one with reason tag `scene`, and there is no open popup or black box message. A toast that was being displayed stays visible
- When a transition is received while a popup open flow and a tween that turned on input block hold their blocks, those blocks are released, and when that popup flow and tween end later there is no error log and the transition block stays
- The new scene is not on screen from stage 4 until before stage 7
- A scene created at stage 4 can use references to its child objects when it receives `on_preload`; from stage 4 until before stage 7 the scene's per-frame engine callbacks are not called, and after stage 7 they are called
- After a transition to a scene with a scene UI root, after stage 7 the scene UI root is under the SceneCore safe area root of the `SceneUI` layer and its position and size equal the safe area. They also match after `SafeAreaCore.set_virtual_notch`. When stage 3 of the next transition ends, that scene UI root has been destroyed
- In a build that contains DEV code, when the safe area differs from the visible game area (`SafeAreaCore.set_virtual_notch`), a transition to a scene that has a UI element with an ignore mark directly under the scene UI root gives no `SafeAreaCore` parent rule error log, and after stage 7 that UI element covers the whole visible game area. Even when a `set_virtual_notch` that changes an inset is called during stage 6 and `on_prepare` creates an ignore-mark UI element directly under the scene UI root, there is no error log
- A transition to a scene without a scene UI root adds no UI element under the safe area root of the `SceneUI` layer
- The result is `true` even when preload or pool fill fails
- A second transition request during a transition gives a warn log and `false` and does not change the transition in progress. `change_scene` before `boot_change_scene` succeeds gives an error log and `false`
- A panel open received from stage 1 until the panel lock is released does not open the panel, and a panel open inside `on_start` opens it
- On a transition to a scene with a root panel key, when `on_start` is called the panel stack is one root item and `current_root_panel_key` is that key. In a scene without a root panel key, when `on_start` is called the panel stack is empty and `current_root_panel_key` is an empty string
- When `prepare` of the root panel is `false`, `FatalErrorRequestedEvent` comes once without `on_start` and the result is `false`
- When `on_prepare` is `false`, the `[scene_retry]` retry popup opens without the block with reason tag `scene`, and pressing it sets the block again and then calls `on_prepare` again
- When `on_prepare` is `false` the first time and all `SceneCore.prepareRetryCount` times, the `[scene_restart]` popup opens, and pressing it sends `RestartRequestedEvent` once. Closing it without a button also sends it once; the result is `false` and `is_transitioning` is `true`
- The retry popup does not close with back input
- Calling `change_scene` with a scene key whose scene resource cannot be loaded or with a scene whose root is not the scene base type sends `FatalErrorRequestedEvent` once after the block is released; there are no stages 5 to 8, the result is `false`, and later transition requests are ignored
- With a loading screen whose root is not the loading screen base type, the transition ends with `true` without a loading screen after an error log
- Two transitions create the loading screen once, and its resource key is in the global scope
- The loading screen is under the SceneCore safe area root of the `Loading` layer and its position and size equal the safe area. They also match after `SafeAreaCore.set_virtual_notch`, and the background with an ignore mark covers the whole visible game area. After `release`, that safe area root is not in the `Loading` layer
- On the test clock, even when the other stages end at once, hiding the loading screen starts `SceneCore.loadingMinDisplayMs` after it was shown
- The values that `on_progress` receives start at 0, do not decrease, do not exceed 1000, increase per preload item, and are 1000 after `true` of `on_prepare`. The value before `on_preload` returns is 0. It reaches 1000 even when the pool fill list is empty
- `boot_change_scene` creates no loading screen, ends with `true` while the test clock is stopped, and on `false` of `on_prepare` sends `FatalErrorRequestedEvent` without a popup
- When `SceneStartedEvent` is received, `is_transitioning` is `false` and `duration_ms` equals the test clock elapsed time from the start of stage 1
- `release` while waiting on any stage leaves no remaining stages and destroys the three scene objects, and `boot_change_scene` and `change_scene` after `init` again satisfy the first test item
- Whether a transition ends in success, failure or stop, the overlay of the `Transition` channel is transparent
