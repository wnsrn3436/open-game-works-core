# ShortcutCore

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

Opens scenes and panels along a screen navigation path (shortcut) defined in the data `shortcut` table. e.g. "Go get more" in a currency shortage popup, "Go now" in a quest

## dependency

`LogCore`, `EventCore`, `DataCore`, `LocalizationCore`, `RequirementCore`, `MessageCore`, `UICore`, `SceneCore`

- `LocalizationCore` is used only for the `FormatArgs` type

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_param_builder` | panel key, param builder | success flag | `false` | content code |
| `navigate` | shortcut ID | async operation. success flag | `false` | content code |
| `is_navigating` | none | whether navigating | `false` | core, content code |

- A shortcut ID is an ID value of the `shortcut` table. The caller gets it from a `ref<shortcut.id>` column value or a reserved ID accessor

## behavior

### shortcut

- A shortcut is one row of the `shortcut` table. It moves the screen to the target scene (`scene`), and when the panel path (`panels`) is not empty, opens those panels in list order. The last element is the target panel
- The target scene is opened with scene param none
- `stack` is where the panel path opens. `Root` opens after going back to the target scene's root panel, and `Top` opens on top of the current panel stack. When the scene was changed at stage 6, `Top` also acts as `Root`. The value set this way is the applied stack
- `args` are values that the param builder of the target panel reads when it builds the param. That param builder defines the meaning of the elements. The param builder of a panel that is not the target panel does not read `args`
- When `panels` is empty, `args` is not used
- When `requirement` is not 0 (empty cell), the move happens only when `passed` of `RequirementCore.evaluate` is `true`
- Extra values per game go in an extension table

### navigate order

`navigate` runs the stages below in order. It is navigating from the start of stage 2 until it ends or stops.

| stage | contents |
|---|---|
| 1 request check | When navigating, or when `SceneCore.is_transitioning` or `UICore.is_panel_transitioning` is `true`, leaves a warn log and returns `false`. The move in progress does not change |
| 2 row lookup | Gets the shortcut row through `DataCore`. Stops when there is none |
| 3 requirement check | When `requirement` is not 0 (empty cell), judges it with `RequirementCore.evaluate`. When `passed` is `false`, gives the lock notice and stops |
| 4 build param | Skipped when `panels` is empty. Sets a param for each element of `panels` in list order. When that panel has a param builder, calls it with the row and the target panel flag and uses the returned param. Otherwise uses param none. When the target panel has no param builder and `args` is not empty, stops |
| 5 close popups | Calls `UICore.close_all_popups`. After that, when `SceneCore.is_transitioning` or `UICore.is_panel_transitioning` is `true`, leaves a warn log and stops. e.g. a transition started by a popup's hidden callback |
| 6 change scene | When the target scene differs from `SceneCore.current_scene_key`, calls `SceneCore.change_scene` with the target scene and scene param none and waits. Stops on `false` |
| 7 back to root | Skipped when the applied stack is `Top` or `SceneCore.current_root_panel_key` is an empty string. Calls `UICore.close_panels_to` with that root panel key and waits. Stops on `false` |
| 8 open panels | Skipped when `panels` is empty, or when the applied stack is `Root` and `panels` is only the root panel key. When `panels` has one element, calls `UICore.open_panel` with that panel and the param from stage 4; with two or more, calls `UICore.open_panels` with `panels` and the param list from stage 4; then waits. Clear stack is on when the applied stack is `Root` and the root panel key is an empty string, and off otherwise. Stops on `false` |
| 9 end | Ends navigating, sends `ShortcutNavigatedEvent` and returns `true` |

- lock notice: when the judgement result has a guide translation key, calls `MessageCore.show_toast` with `FormatArgs` filled by `RequirementCore.fill_guide_args`. When there is no guide translation key, it shows no toast
- A stopped move skips the remaining stages, ends navigating and returns `false`. When it stops after stage 5 it does not reopen the closed popups; when it stops after changing the scene at stage 6 it does not go back to the previous scene; when it stops at stage 8 it does not reopen the panels closed at stage 7
- The panel stack at stage 9. The same-panel-key replacement rule of `UICore` applies as it is to the opens at stage 8
  - applied stack `Root`, scene with a root panel: `panels` in list order on top of the root item. When `panels` is empty or only the root panel, one root item
  - applied stack `Root`, scene without a root panel: `panels` in list order. When `panels` is empty, the stack before the move when stage 6 was skipped, and the stack that the new scene's start handling opened when the scene was changed at stage 6
  - applied stack `Top`: `panels` in list order on top of the stack before the move. When `panels` is empty, the stack before the move

### release

- Stops the move in progress. Even when an operation it was waiting on ends, it skips the remaining stages. A stopped `navigate` ends with `false`
- Deletes the registered param builders

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| param builder | stage 4 of `navigate`, per element of `panels` | shortcut row, target panel flag | param of that panel. none when it cannot build one | error when it is the target panel and `args` is not empty, otherwise param none |

- There is one param builder per panel key. The feature that has that panel registers it in content initialization
- When the target panel flag is `false`, the param builder does not read `args`

## event

| event | when | payload |
|---|---|---|
| `ShortcutNavigatedEvent` | stage 9 of `navigate` | shortcut ID, target scene key, list of the panel keys of `panels`. Empty list when `panels` is empty |

## error

| condition | failure value | log |
|---|---|---|
| param builder throws | `false`. Stage 5 and later do not run | error |
| caught by the stage 1 request check | `false` | warn |
| shortcut ID not in the table | `false` | error |
| param builder returns param none | `false`. Stage 5 and later do not run | error |
| target panel has no param builder and `args` is not empty | `false`. Stage 5 and later do not run | error |
| in transition after stage 5 | `false` | warn |
| scene transition failure at stage 6, failure to go back to the root panel at stage 7, panel open failure at stage 8 | `false` | none. The failing module leaves it |
| registering a param builder twice for the same panel key | `false`. The first one is kept | error |

## settings

none

## data

`data/tables/shortcut.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `scene` | `reskey` | `Client` |
| `panels` | `array<reskey>` | `Client` |
| `stack` | `enum<ShortcutStack>` | `Client` |
| `args` | `array<int>` | `Client` |
| `requirement` | `requirement` | `Client` |
| `#comment` | comment column | |

- `panels` is the panel path. Its elements are panel keys and are stacked in list order. An empty array opens no panel
- Elements of `args` are integers or ID names
- A row whose `panels` is an empty array but whose `args` is not empty is data check `out_of_range`

`data/enums.csv`

| type | element |
|---|---|
| `ShortcutStack` | `Root`, `Top`. The game does not change it |

## DEV

none

## test

- A `shortcut` row whose `panels` is an empty array and whose `args` is not empty is a data check `out_of_range` ERROR
- When `navigate` runs with a shortcut for which `passed` of the condition judgement is `true`, a param builder exists, the target scene has a root panel and is not the current scene, `stack` is `Root` and `panels` has one element, the condition judgement, the param builder, `close_all_popups`, `change_scene`, `close_panels_to`, `open_panel` and `ShortcutNavigatedEvent` each happen once in this order, and the result is `true`
- With two popups open and the stack root R, A, B, `navigate` with a shortcut whose target scene is the current scene, whose `stack` is `Root` and whose `panels` is only C does not call `change_scene`; when it ends, no popup is open and the stack is R, C
- With the stack root R, A, `navigate` with a shortcut whose target scene is the current scene, whose `stack` is `Root` and whose `panels` is B, C, D calls `open_panels`(B, C, D) once with clear stack off after `close_panels_to`(R), with no `open_panel`; when it ends, the stack is R, B, C, D
- With the stack root R, A, `navigate` with a shortcut whose target scene is the current scene and whose `stack` is `Top` does not call `close_panels_to`. When `panels` is only B, `open_panel`(B) is called with clear stack off and when it ends the stack is R, A, B; when `panels` is B, C, `open_panels`(B, C) is called with clear stack off and the stack is R, A, B, C
- When the target scene is not the current scene and `stack` is `Top`, the same calls as for `Root` happen in the same order with the same clear stack, and when it ends the stack is `panels` on top of the root item
- When the target scene is not the current scene, `close_panels_to` is called after the result of `change_scene` is received, and a panel that the new scene's `on_start` opened on top of the root is not in the stack when it ends
- When the target is a scene without a root panel and `stack` is `Root`, `close_panels_to` is not called and clear stack of the open is on. When `panels` has one element, the stack is only that panel when it ends; with two or more, `open_panels` is called and the stack is `panels`
- When `stack` is `Root` and `panels` is only the root panel, `open_panel` is not called and when it ends the stack is one root item
- The row the param builder receives is that shortcut row, and the param of each panel instance or stack item is the object that the panel's builder returned. When `panels` is B, C and both have builders, B's builder is called with target panel flag `false` and C's builder with `true`. A panel without a builder receives param none, and there is no error when it is not the target panel even when `args` is not empty. When the target panel has no builder and `args` is empty, that panel receives param none
- For each condition of the error table, the log in the table and `false` come out, and there are no calls after that stage. A `navigate` received while navigating does not change the result of the move in progress
- When the condition judgement is a failure with a guide translation key, `show_toast` is called once with that key and `FormatArgs` filled by `fill_guide_args`, the result is `false`, and there is no `close_all_popups`, `change_scene`, `open_panel` or `open_panels`. For a failure without a guide key, there is no `show_toast`
- When `requirement` is 0 (empty cell), the condition judgement is not called
- With one popup open and the stack root R, A, `navigate` with a shortcut whose `panels` is empty and whose target scene is the current scene calls no param builder, `change_scene`, `open_panel` or `open_panels`, sends `ShortcutNavigatedEvent` (empty panel key list) once, returns `true` and leaves no popup open. When `stack` is `Root`, the event comes after `close_all_popups` and `close_panels_to` and the stack is R; in a scene without a root panel the stack is the same as before the move. When `stack` is `Top`, there is no `close_panels_to` and the stack is R, A
- When `prepare` of the target panel fails, the result is `false`, closed popups do not reopen, the stack is one root item when the applied stack is `Root` and the stack before the move when it is `Top`, and when the scene was changed at stage 6 the current scene is the target scene
- A failed or ignored `navigate` sends no `ShortcutNavigatedEvent`
- `release` while waiting on `change_scene`, `close_panels_to`, `open_panel` or `open_panels` leaves no remaining stages even after the awaited operation ends
