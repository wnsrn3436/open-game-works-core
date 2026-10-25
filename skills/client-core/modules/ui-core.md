# UICore

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

Handles UI layers, panels and the panel stack, popups and the popup queue, popup suppression, system popups, back input handling, focus, the keyboard shift of text input elements, the loading icon, UI buttons, scroll lists, and the license screen.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `ResourceCore`, `PoolCore`, `SoundCore`, `LocalizationCore`, `ResolutionCore`, `SafeAreaCore`, `InputCore`, `InputBlockCore`, `TweenCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `prepare` | none | async operation. success flag | `false` | `BootstrapCore`(`Prepare` stage) |
| `get_layer` | `UILayer` | the engine object of that UI layer | none | the `used by` column of the UI layer table, `NativeUiCore`(`Debug`. hides it in `capture_screen`) |
| `open_root_panel` | panel key | async operation. success flag | `false` | `SceneCore` |
| `open_panel` | panel key, param, clear stack flag | async operation. success flag | `false` | core, content code |
| `open_panels` | list of (panel key, param), clear stack flag(optional. default `false`) | async operation. success flag | `false` | core, content code |
| `close_panel` | force flag(optional. default `false`) | async operation. success flag | `false` | core, content code |
| `close_panels_to` | panel key, force flag(optional. default `false`) | async operation. success flag | `false` | core, content code |
| `reset_panel_stack` | none | none | none | `SceneCore` |
| `set_panel_lock` | lock flag | none | none | `SceneCore` |
| `open_popup` | popup key, param, hidden callback, `PopupSuppress`(optional) | async operation. `PopupOpenResult` | `Failed` | core, content code |
| `suppress_popup` | suppress key, `PopupSuppressMode` | none | none | content code |
| `is_popup_suppressed` | suppress key | whether suppressed | `false` | content code |
| `open_system_popup` | `SystemPopupParam`, hidden callback | async operation. success flag | `false` | core, content code |
| `close_popup` | popup instance, after-close callback(optional) | async operation. none | none | that popup instance itself. UICore calls it for back policy `Close` and from system popup buttons |
| `close_all_popups` | none | none | none | `BootstrapCore`(restart, update reboot), `SceneCore`, `ShortcutCore` |
| `show_loading_icon` | none | loading icon token | invalid token | core, content code |
| `hide_loading_icon` | loading icon token | none | none | core, content code |
| `get_current_panel_key` | none | panel key. empty string when there is none | empty string | core, content code |
| `get_panel_stack` | none | list of panel keys from the bottom item up | empty list | core, content code |
| `get_open_popups` | none | list of popup keys of open popups from the bottom up. does not include system popups | empty list | core, content code |
| `get_open_popup_count` | none | number of visible popups. includes system popups. does not allocate memory | 0 | core, content code |
| `is_system_popup_visible` | none | whether a visible system popup exists. equals whether the system popup root is visible. does not allocate memory | `false` | `TutorialCore` |
| `is_panel_transitioning` | none | flag | `false` | core, content code |
| `is_flow_in_progress` | none | whether a panel transition, a popup request waiting in the popup queue, a popup open flow or close, or a system popup open flow or close is in progress. does not allocate memory | `false` | `QACore` |
| `get_block_pass_list` | none | `BlockPassList` of `InputBlockCore`. `elements` is the system popup root alone, and `actions` is `back` alone. Returns the one UICore holds, and the caller does not change it | none | core, content code |
| `get_anchor_rect` | anchor name, anchor key(optional. default none) | `AnchorResult` | `found` and `visible` are `false` | `TutorialCore`, `QACore`, `UnitTestCore`, content code |
| `is_modal_covered` | UI element | whether modal covered | `false` | `QACore` |
| `set_view_focus` | `FocusView`, focus element list, initial focus element, accept callback(the clicked element. can be none) | none | none | `CutsceneCore`, `TutorialCore` |
| `set_back_override` | callback or none | none | none | `CutsceneCore` |
| `open_licenses` | none | async operation. success flag | `false` | content code |

### type

| type | contents |
|---|---|
| `UILayer` | a layer of the UI layer table below |
| `UIPanel`, `UIPopup` | base of panel classes and popup classes. has the panel interface |
| `UIParam` | base of param classes. content code inherits it |
| `UIPanelCache` | base of cache classes. content code inherits it |
| `PopupSuppress` | `key`(suppress key), `mode`(`PopupSuppressMode`) |
| `PopupSuppressMode` | `Forever`(do not show again), `Today`(do not show until the next day boundary) |
| `PopupOpenResult` | `Opened`(opened), `Suppressed`(not opened because suppressed), `Failed`(could not open) |
| `FocusView` | `Cutscene`, `Tutorial` |
| `SystemPopupParam` | body translation key, `FormatArgs` of `LocalizationCore`(optional), extra text, button list(at least 1 and at most 3, each button with a label translation key and a callback), back button index(can be absent) |
| `BackPolicy` | `Close`, `Ignore`, `Custom` |
| `PanelOpenReason` | `New`(opened forward), `Returned`(returned by closing the panel above) |
| `PanelCloseReason` | `Covered`, `Closed` |
| `AnchorResult` | `found`(a `UIAnchor` that is an anchor match is in the UI tree), `visible`, `rect`(rectangle in `ResolutionCore` game coordinates. empty rectangle when not visible), `element`(the UI element that `UIAnchor` is attached to. none when not visible), `owner`(key of the nearest panel or popup instance containing `element`. empty string when there is none or it is not visible) |
| `UIScrollSizeMode` | `Fixed`(the scroll-axis size of every item is the item size of the component property), `Measured`(uses the measured size per item) |

### component

| component | operation | input | output | failure value | caller |
|---|---|---|---|---|---|
| `UIAnchor` | `set_anchor_key` | anchor key or none | none | none | content code |
| `UIButton` | `set_on_click` | callback or empty callback | none | none | core, content code |
| `UIButton` | `get_action` | none | action name. empty string when there is none | empty string | `QACore` |
| `UIScrollList` | `set_items` | item count, bind callback, pool scope, end-near callback(optional), start-near callback(optional), start-at-end flag(optional. default `false`) | async operation. success flag | `false` | `CutsceneCore`, content code |
| `UIScrollList` | `append_items` | number of items to add | success flag | `false` | content code |
| `UIScrollList` | `prepend_items` | number of items to add at the front | success flag | `false` | content code |
| `UIScrollList` | `set_loading` | on flag | none | none | content code |
| `UIScrollList` | `get_scroll_offset` | none | scroll position | 0 | content code |
| `UIScrollList` | `set_scroll_offset` | scroll position | none | none | content code |
| `UIScrollList` | `scroll_to_index` | item index | success flag | `false` | content code |
| `UIScrollList` | `scroll_to_end` | none | none | none | content code |

- scroll position: the scroll-axis distance from the list start to the start of the visible area. It is in game coordinates and is at least 0 and at most the max scroll position. The max scroll position is the larger of 0 and (content length − visible area length), and the content length is the sum of the scroll-axis sizes of the lines and the loading item line and the item spacing between them

## behavior

### UI layer

A row further down the table is drawn above the rows before it. The scene's world is below all UI layers. UICore creates all UI layers in `init`. UICore is the only module that creates UI layers, and other modules get them with `get_layer`.

| `UILayer` | contents | used by |
|---|---|---|
| `WorldEffect` | `World` channel overlay | `ScreenEffectCore` |
| `SceneUI` | scene UI root | `SceneCore` |
| `VirtualPad` | virtual joystick and buttons | `VirtualPadCore` |
| `Panel` | panels, the dim and modal blocker of panels | UICore |
| `CutsceneEffect` | `Cutscene` channel overlay | `ScreenEffectCore` |
| `Cutscene` | cutscene screen | `CutsceneCore` |
| `Loading` | loading screen | `SceneCore` |
| `TransitionEffect` | `Transition` channel overlay | `ScreenEffectCore` |
| `Popup` | popups, the dim and modal blocker of popups, system popup root | UICore |
| `Tutorial` | screen highlight and hand pointer display | `TutorialCore` |
| `Message` | toast, black box message, voice subtitles | `MessageCore`, `AccessibilityCore` |
| `LoadingIcon` | loading icon, the color filter above it | UICore, `AccessibilityCore` |
| `Fatal` | fatal screen of `BootstrapCore` | `BootstrapCore` |
| `Debug` | debug screen | `QACore` |

- Every UI layer covers the visible game area and is not affected by `CameraCore` camera movement, zoom, or shake
- UI elements of a higher layer receive pointer input first, and received input does not go to lower layers or the world
- UICore places the panels, popups, dims, modal blockers, loading icon, and system popup root it creates under the `SafeAreaCore` safe area. Dims and modal blockers ignore the safe area and cover the whole visible game area
- UI elements of UI layers receive input and play tweens also during a game time pause

### panel and popup

- Panels, the screen-unit UI, are opened on the `Panel` layer. One panel is visible. Popups open on the `Popup` layer, and several open together. A popup that became visible later is above. System popups are above other popups
- The panel key and popup key are the resource keys of the panel and popup prefabs. The prefab root is a class that inherits `UIPanel` or `UIPopup`
- UI property: a value set on the panel and popup prefab root. back policy(default `Close`), modal(default `true`), dim(default `false`), open tween preset key(default none), close tween preset key(default none), initial focus(a UI element in that prefab with `UIButton` attached. default none). The engine mapping is in the engine-specific implementation rules
- While a panel or popup with modal on is visible, the UI and world below it do not receive pointer input. A modal blocker is placed directly below it. On the `Popup` layer, only one is placed, below the topmost modal popup
- modal covered: a visible modal panel or modal popup (system popups included) is drawn above the UI element. The instance containing that element, instances being prepared, and instances whose destruction has started are not counted. The drawing order is the order of the UI layer table and the stacking order of popups
- A dim is placed directly below a panel or popup with dim on. On the `Popup` layer, only one is placed, below the topmost popup with dim on. Below the same popup the order is modal blocker, dim, popup. The dim does not receive pointer input
- Open and close tweens play on the prefab root with `TweenCore.play_preset`
- UICore creates a resource scope per panel and popup instance and releases that scope after destroying the instance. An instance whose destruction has started is not visible and does not receive input
- Params and caches do not reference engine objects or resources. Callbacks are the exception. UICore and panel classes do not change a received param

### panel interface

| method | input | output | default |
|---|---|---|---|
| `accepts_param` | param | whether it accepts | accepts only param none |
| `prepare` | panel: `PanelOpenReason`, cache(none for an item never shown). popup: none | async operation. success flag | `true` |
| `on_opened` | panel: `PanelOpenReason`. popup: none | none | none |
| `on_closed` | panel: `PanelCloseReason`. popup: none | none | none |
| `on_back` | none | none | none |

- Only UICore calls the methods. An instance can read its key, param, and resource scope, and a panel holds a cache
- `prepare` is the preparation before becoming visible (server requests for data to display, loading resources). An instance being prepared is not visible and does not receive input. `prepare` does not call an operation that starts a panel transition, or `open_popup`, which is not for system popups
- A panel's `PanelOpenReason` is the direction of movement. `New` means opened with `open_panel`, `open_root_panel`, or `open_panels`, and `Returned` means returned to with `close_panel` or `close_panels_to`. Whether the item is shown for the first time is known from the cache: the cache of an item never shown is none

### panel stack

- A panel stack item holds only the panel key, param, cache, whether it has been shown, and whether it is the root item. Only the top item has a panel instance (current panel)
- root item: the item that `open_root_panel` pushed. There is at most one, at the bottom of the stack, and only `reset_panel_stack` removes it
- panel transition: from the start to the end of `open_root_panel`, `open_panel`, `open_panels`, `close_panel`, or `close_panels_to`. One at a time. During it, UICore sets a block with reason tag `ui` through `InputBlockCore.run_blocked` and uses `get_block_pass_list` as the pass list
- A panel transition operation received during a panel transition or a panel lock leaves a warn log and returns `false`. `open_popup`, `open_system_popup`, `reset_panel_stack`, and `close_all_popups` are not blocked
- The screen changes only after `prepare` of the item to be shown succeeds. When a panel transition fails, UICore destroys the created instance, releases its scope, and ends. The stack and the current panel do not change

`open_panel` processing order

1. Start the transition. Create a scope, load the prefab, create an instance, and set the param
2. When `accepts_param` is `false`, leave an error log and fail. When `prepare(New, none)` is `false`, fail
3. When the panel key of the current panel equals the panel key being opened, replace: close the current panel immediately (`on_closed(Closed)`, destroy) and replace its item with the new item. The replaced item keeps its root flag, and clear stack is not used. Go to 4. Otherwise, when there is a current panel: when clear stack is off or the current panel is the root item, cover it (`on_closed(Covered)`, keep the cache in the item, destroy the instance). Otherwise close it immediately (`on_closed(Closed)`, destroy) and remove all items above the root item. When there is no root item, remove all items
4. Push the new item on top of the stack (not when it was replaced in 3), make it visible, then call `on_opened(New)`
5. Wait for the open tween and end the transition

- `open_root_panel` is accepted only when the stack is empty, does the same as `open_panel` with param none and clear stack off, then makes the new item the root item
- `open_panels` runs the flow of `open_panel`(with the received clear stack flag) for the last element. In step 4, before pushing the new item, it pushes the preceding elements in list order as items never shown. The preceding elements have no instance, `prepare`, `on_opened`, or event. On failure the preceding elements are not pushed either

The close flow is the handling of `close_panel` and `close_panels_to`. The destination is the item the close flow shows.

1. Start the transition. The current panel stays visible
2. For the destination item, create a scope, load the prefab, create an invisible instance, and set the item's param and cache
3. The reason is `Returned`, and the cache is none when the destination item has never been shown, otherwise that item's cache. When `accepts_param` is `false`, leave an error log, and it is a destination failure. When `prepare(reason, cache)` is `false`, it is a destination failure
4. Destination failure: when force is off, fail. When force is on and the destination is the root item, leave an error log and go to step 5. When force is on and the destination is not the root item, destroy the destination instance, release its scope, and repeat from step 2 with the item directly below as the destination
5. Call `on_closed(Closed)` on the current panel, wait for the close tween, then destroy it and remove its item. Remove the items between the current panel and the destination
6. Make the destination visible and call `on_opened(Returned)`. No open tween plays. End the transition

- When the prefab of step 2 is not a panel class, repeat from step 2 with the item directly below as the destination, regardless of force
- When there is no item below to use as the destination, do step 5 and end with the stack empty
- The items between the current panel and the destination are removed only in step 5 and have no instance or callback
- The destination of `close_panel` is the item directly below the current panel. When there is no current panel or it is the root item, leave a warn log and return `false`
- The destination of `close_panels_to` is the topmost item with that panel key. When the stack has no item with that panel key, leave a warn log and return `false`. When that item is the current panel, return `true` without a transition
- flow cancel: `reset_panel_stack` and `release` stop the flow in progress. Instances not yet shown are destroyed, a panel in its open tween stays as the current panel, and the set block is released. The stopped operation ends with `false`, and the results of loads and `prepare` that finish after that are discarded
- `reset_panel_stack` cancels the flow, closes the current panel immediately, and empties the stack. It does not wait

### popup

- popup queue: `open_popup` runs open flows one at a time in the order received. When the same popup key is open, in an open flow, or in the queue, leave a warn log and return `Failed`
- popup open flow: set a block with reason tag `ui` (the pass list is `get_block_pass_list`), scope and instance, `accepts_param`, `prepare`, make it visible on top and `on_opened`, open tween, release the block
- An open popup is a popup instance from when the open flow makes it visible until closing (`close_popup`, `close_all_popups`) starts. A popup in its open tween is also an open popup. A popup after closing starts and before destruction is a closing popup. The popup flow is a popup's open flow and the handling of `close_popup`
- `close_popup`: set a block with reason tag `ui` (the pass list is `get_block_pass_list`), `on_closed`, close tween, destroy and release the scope, release the block, hidden callback, after-close callback. When it is not an open popup, leave a warn log and ignore
- The after-close callback returns the popup's result to the opener. When its result is decided, the popup closes itself, passing the result callback it received in its param as the after-close callback. When closed by `close_all_popups`, the after-close callback is not called
- `close_popup` of a popup in its open tween stops the open tween, ends that open flow (block release, `UIOpenedEvent`, `Opened` of `open_popup`), then closes
- The hidden callback is called once when a popup that became visible closes. It is not called for a popup that failed or was canceled before becoming visible
- Popups do not close on a panel transition or `reset_panel_stack`
- `close_all_popups`: empties the queue (discarded requests get `Failed`), cancels open flows not yet visible (`open_popup` gets `Failed`, `open_system_popup` gets `false`, no hidden callback), ends the open flow of a popup in its open tween the same way as `close_popup`, then immediately closes open popups and closing popups from the top. Immediate close of a popup stops its tween, calls `on_closed` only on a popup that has not received `on_closed`, and calls the hidden callback after destroying it and releasing its scope. A `close_popup` in progress ends then, and blocks set by popup flows are released. It does not wait. An `open_popup` received while it is in progress leaves a warn log and returns `Failed`, and an `open_system_popup` leaves a warn log and returns `false`
- Only the callers of `close_all_popups` close all popups at once

### popup suppression

- Popup suppression exists only for popups whose `open_popup` received a `PopupSuppress`. For other popups there is no judgement and no save
- The suppress key is `<owner>.<name>` and follows the `LocalDataCore` key rule. e.g. `shop_panel.loss_warning`, `event_notice.notice_12`
- When `open_popup` has a `PopupSuppress` and `is_popup_suppressed`(that key) is `true`, it does not enter the queue and ends at once with `Suppressed`. There is no instance, hidden callback, event, or log. The judgement is made when `open_popup` is called
- A popup instance reads the received `PopupSuppress` along with its key, param, and scope. The content popup prefab holds the suppression toggle, which is visible only when the instance has a `PopupSuppress`. When the popup closes with the toggle on, content code calls `suppress_popup`(that key, that mode)
- It is saved in the `user` file of `LocalDataCore`, key `UICore.popup_suppress`. An element is `<suppress key>=<until>`, and until is a decimal integer. `Forever` is −1, and `Today` is `TimeCore.get_next_day_boundary`(`TimeCore.get_current_day`)
- `is_popup_suppressed` is `true` when an element with that key exists and until is −1 or `TimeCore.is_reached`(until) is `false`
- `suppress_popup` deletes the element with the same key and the elements whose until is not −1 and whose `is_reached`(until) is `true`, and adds the new element. For `Today`, when `TimeCore.is_synced` is `false`, it does not save and leaves a warn log
- An element with a wrong format is treated as absent, and the next `suppress_popup` deletes it
- The `user` file is loaded after login. While `LocalDataCore.is_loaded`(`user`) is `false`, `is_popup_suppressed` is `false`, `open_popup` does not judge a popup suppressed, and `suppress_popup` does not save. In that time UICore does not read or write the `user` file of `LocalDataCore` and leaves no log

### system popup

- A system popup is a UICore popup made of a body and buttons. When `UICore.systemPopupResource` is an empty string, a screen built in code is used
- `open_system_popup` opens at once, without the popup queue or the duplicate check, and opens as modal. The blocks of its open flow and close have no pass list
- `open_system_popup` ends with `true` when the system popup's open flow ends and does not wait for the system popup to close. It is also `true` when closing started during the open tween and ended the open flow. The closing of a system popup is told only through the hidden callback and the button callback
- The system popup root is a UI element placed above other popups on the `Popup` layer. System popups open under it, and the root does not receive pointer input. The root is visible only while a visible system popup exists, and is hidden when there is none
- The body is the `LocalizationCore` translation when there are no format arguments, otherwise the format result. When the extra text is not an empty string, it is displayed below the body without translation
- When the body and extra text do not fit in the area above the buttons, that area scrolls vertically. Pointer drag, mouse wheel, and up and down direction input when the input device is `Gamepad` or `KeyboardMouse` move the scroll position. One direction input moves it by `UICore.systemPopupScrollStep`. Up and down direction input does not move the focus of the system popup
- One button is placed at the center of the popup area, and two or more are placed at equal spacing within the popup area. Buttons are inside the popup area and do not overlap
- Pressing a button runs `close_popup`, passing that button callback as the after-close callback. When closed by `close_all_popups`, the button callback is not called. An omitted callback is skipped without a log
- Back input on a system popup is a press of the back button, regardless of back policy. When there is no back button, it is ignored
- While one or more system popups are visible, UICore sets `InputBlockCore.set_timer_hold`(`ui`, `true`), and sets it to `false` when none remain

### open_licenses

- `open_licenses` opens the license screen from the game's license manifest as a system popup, waits until it closes, then returns `true`. The license manifest format is `## license manifest` in command.md of the [`core`](../../core/SKILL.md) skill
- The body of the system popup is `[ui_licenses_title]`, its only button is `[ui_licenses_close]`, and the back button is that button. The extra text is the text below joined in this order
  1. For each component of `components` whose `platforms` contains the platform the app runs on, in manifest order: a line of `name` and `version` joined by one space, a `license` line, a `url` line, `notice`, an empty line. A line whose value is an empty string is not included
  2. For each SPDX license ID that appears in the `license` expressions of the components of 1 and is in `texts`, in order of first appearance: an ID line, its full text, an empty line
- When the license screen is open, `open_licenses` does not open it and returns `false`
- When the license manifest cannot be read or its format is wrong, it does not open and returns `false`

### back input

UICore registers a back handler with `InputCore.set_back_handler` in `init`. Back input before `prepare` finishes is ignored without a log. Later back input gets the first matching handling below.

1. When an open flow or close of a system popup is in progress, ignore
2. When there is an open system popup, apply back to the topmost system popup
3. When there is a back override, call its callback
4. During a panel transition or while a popup flow is in progress, ignore
5. When there is an open popup, follow the back policy of the topmost popup
6. When there is a current panel, follow its back policy. However, when the current panel is the root panel and its back policy is `Close`, do 7
7. When the platform the app runs on is `android`, `windows`, `macos`, or `linux`, open the exit confirm system popup. On `ios` or `web`, do nothing. Body `[ui_exit_confirm]`, buttons `[ui_exit_quit]`, `[ui_exit_cancel]`, back button `[ui_exit_cancel]`. Pressing `[ui_exit_quit]` emits `ExitConfirmedEvent`. `BootstrapCore`, which subscribes to that event, does the app exit

| `BackPolicy` | handling |
|---|---|
| `Close` | `close_popup` for a popup, `close_panel` for a panel. the exit confirm of 7 for the root panel |
| `Ignore` | does nothing |
| `Custom` | calls `on_back` |

- back override: the one callback set by `set_back_override`. Calling it again replaces it, and none deletes it. `release` deletes it
- The back handler returns that it consumed the back input (`true`) when 1 to 5 above match or when it opens the exit confirm in 7 (including `Close` of the root panel), and returns `false` otherwise. It is also `false` before `prepare` finishes. Back input received by the current panel is not consumed, so a `Gameplay` action with the same key or gamepad button as `back` is also pressed. A panel that receives gameplay input sets its back policy to `Custom` or `Ignore`

### focus

- focus: the one UI element pressed with keys and gamepad. A `UIButton` that has focus is clicked by the engine's accept input. This click follows the `UICore.buttonClickIntervalMs` and `[ui_button_click]` rules the same as a pointer click
- Focus is set only during focus mode. Focus mode lasts while `InputCore.get_device` is `Gamepad`, and, while it is `KeyboardMouse`, from receiving a key direction input until receiving a mouse movement or a mouse button press. A key direction input received by a text input element that has engine focus does not start focus mode
- UICore sets focus on the focus target in the next frame when the device becomes `Gamepad` through `InputDeviceChangedEvent`, in that frame when focus mode starts by a key direction input, and in that frame when the focus target changes during focus mode. The direction input that started focus mode does not move focus. When focus mode ends, focus is removed at once
- focus target: the focus element of the first of the following that exists. When none exists, there is no focus target and no focus
  1. the topmost instance among visible system popups
  2. `Tutorial` view focus
  3. `Cutscene` view focus
  4. the topmost instance among visible modal panels and modal popups
- An instance being prepared or whose destruction has started is not a focus target
- view focus: the list of focus elements set per `FocusView` with `set_view_focus`. It becomes a focus target only when the list has a visible element. Passing an empty list deletes that view focus. The list contains only UI elements with `UIButton` attached
- The focus element of a view focus is first the initial focus element, and when that element is none, not in the list, or not visible, it is the first visible element in the list. Calling `set_view_focus` again applies the first-time rule. When focus moves within the list, the element it moved to is the focus element of the view focus
- When an element of a view focus is clicked by accept input while it has focus, the accept callback is called once with that element after that click
- The focus element of an instance is first the initial focus of its UI property, and when there is none, the first `UIButton` element in that instance in the engine's focus order. For a system popup it is the first button. When focus moves within the instance, the element it moved to is the focus element of that instance
- When the topmost instance closes and the instance below becomes topmost again, focus is set on the focus element of that instance. When that element was destroyed or is not visible, the first-time rule applies. A panel that the close flow created again uses the first-time rule
- Focus moves by the engine's direction input and does not leave the instance of the focus target or the visible elements of the view focus
- When an element inside a `UIScrollList` item UI has focus and a scroll-axis direction input arrives, and there is a next line in that direction that does not fully fit in the visible area, `UIScrollList` does the following instead of the engine's focus movement. When there is no next line or it fully fits in the visible area, the engine's focus movement applies
  1. In the direction of increasing index (down in a vertical list, right in a horizontal list), set the scroll position to (distance to the next line start + scroll-axis size of the next line − visible area length), and in the opposite direction to the distance to the next line start, then clamp it the same as `set_scroll_offset`. Borrow item UIs for the items of the next line and bind them
  2. Move focus to the first `UIButton` element, in the engine's focus order, inside the item UI of the item in the next line at the same cross-axis slot as the current item (the last item of that line when that slot does not exist)
- The element that has focus shows the engine's focus display. The engine mapping is in the engine-specific implementation rules

### text input and keyboard shift

- text input element: a UI element where a human enters characters. The engine mapping is in the engine-specific implementation rules
- A text input element pressed with the pointer gets engine focus regardless of input device. This engine focus is not the focus pressed with keys and gamepad, and UICore does not remove it even outside focus mode. When focus mode starts, focus is set on the focus target
- keyboard shift: when there is a visible text input element E that has engine focus and `SafeAreaCore.get_keyboard_area` is not an empty rectangle, the shift target of E moves up by distance d from its original position. Otherwise the shift target stays at its original position
  - shift target: the root of the nearest panel or popup instance containing E. When there is none, the UI layer E is on
  - d = max(0, min(bottom edge of E + `UICore.keyboardGap` − top edge of the keyboard area, top edge of E − top edge of `SafeAreaCore.get_safe_area`)). The edges of E are in game coordinates with the shift target at its original position
  - when it is recomputed: on receiving `SafeAreaCore.KeyboardAreaChangedEvent` or `SafeAreaChangedEvent`, when the engine focus of a text input element changes, when the shift target instance is destroyed. It moves in the frame it is recomputed, without a tween
  - There is one shift target. When the shift target changes, the previous shift target returns to its original position
  - While moved, pointer input and `get_anchor_rect` use the moved position

### UI anchor

- `UIAnchor` is a component attached to a UI element, and the prefab sets its snake_case anchor name. It lets the UI that `TutorialCore` highlights and the UI that the automation channel presses be found by name. The engine mapping of anchor names is in the engine-specific implementation rules
- anchor key: a value content code sets at run time with `UIAnchor.set_anchor_key`, the ID value of the target that UI element points to. It is used to pick one among anchors with the same name. e.g. the ID value of the item in a slot. A position within a list is not used as an anchor key and is referred to with `<name>.<index>`. A UI element with a fixed position (e.g. an equipment slot) gets a distinct anchor name per element instead of an anchor key. The default is none, and passing none deletes the key
- anchor match: when `get_anchor_rect` has no anchor key, a `UIAnchor` with the same name, and when it has one, a `UIAnchor` whose name and anchor key both match
- `get_anchor_rect` returns the game coordinates rectangle of a visible one among the `UIAnchor` elements that are an anchor match. When none is visible, `visible` is `false`. Visible: the element and all its ancestors are visible, it is not inside a panel or popup being prepared or whose destruction has started, and the element is not modal covered
- When two or more visible `UIAnchor` elements are an anchor match, it returns the one drawn topmost
- An anchor name inside a `UIScrollList` item UI is found with `<name>.<index>`
- When an anchor name that content data, a bot scenario, or a save fixture points to is not on any `UIAnchor` of the scenes and prefabs, static check `anchor reference` blocks it. Anchor keys are decided at run time, so they are not checked

### loading icon

- `show_loading_icon` creates one display request and returns a token. When there are one or more requests, the icon is shown at the center of the `LoadingIcon` layer, and when there are none, it is hidden
- The loading icon does not receive pointer input and sets no block
- When `UICore.loadingIconResource` is an empty string, an icon built in code is used

### UI button and scroll list

- `UIButton` is a component attached to a button UI element. Core and content code receive clicks only through the callback set with `UIButton.set_on_click`
- `UIButton.set_on_click(callback)` sets the one click callback of that button. Calling it again replaces it, and an empty callback deletes it. The callback is an instance method of the object that owns the button. When the button is destroyed, the callback is also deleted
- All `UIButton` elements share one last click time. A click before `UICore.buttonClickIntervalMs` has passed since then in real elapsed time is discarded. For each accepted click, `[ui_button_click]` plays on the `Ui` bus of `SoundCore` and the click callback is called
- component property: a value set on a core component attached to a UI element. The component property of `UIButton` is action (an `InputCore` action name. default empty string). `get_action` returns that value
- action click: a `UIButton` whose action is not an empty string receives one click in a frame where `InputCore.is_just_pressed` of that action is `true`, when the button and its ancestors are visible, it is not inside a panel or popup being prepared or whose destruction has started, and it is not modal covered. This click also follows the click interval and `[ui_button_click]` rules above. The judgement runs every frame and does not allocate memory
- When the action is a name for which `InputCore.has_action` is `false`, or is `back`, UICore leaves an error log when the button enters the UI tree and treats it as a button whose action is an empty string. When an action set in content scenes and prefabs is one of these two, static check `action reference` blocks it
- `UIScrollList` is a component that displays item UIs of the same prefab, scrolled along the scroll axis. Its component properties are item prefab key, direction (scroll axis), item size (width, height), `UIScrollSizeMode`(default `Fixed`), item spacing (scroll axis), cross axis count (at least 1. default 1), cross axis spacing (default 0), loading item prefab key (no loading item when it is an empty string), and end follow flag (default `false`). The engine mapping is in the engine-specific implementation rules
- line: a group of items placed in sequence along the scroll axis. When the cross axis count is n, the item at index i is placed in line ⌊i ÷ n⌋, at (i mod n) × (item cross-axis size + cross axis spacing) from the cross axis start. The last line can have fewer than n items. An item overlapping the visible area is an item whose line overlaps the visible area
- scroll-axis size of a line: for `Fixed`, the scroll-axis value of the item size. For `Measured`, the cross axis count is 1, and it is the measured size of the item of that line. An item not yet measured uses the scroll-axis value of the item size (estimated size). The distance to a line start is the sum of the scroll-axis sizes of the preceding lines and the item spacing
- measured size: in `Measured`, the minimum scroll-axis size of a bound item UI, read with the cross-axis size of the item UI set to the cross-axis size of the visible area. When and how it is read is in the engine-specific implementation rules. It is kept per index and read again on rebind
- When a measured size differs from the previous size of that index, within the frame it is read the positions of the following items and the content length are corrected and the items overlapping the visible area are decided again. When the line start of that item is before the visible area start, the size difference is added to the scroll position so visible items do not move on screen. When end follow is on and the scroll position before the correction was the max scroll position, it is set to the max scroll position after the correction. Otherwise the scroll position is clamped the same as `set_scroll_offset`
- `set_items` prefills the item prefab pool up to the max number of items that can overlap the visible area and the loading item prefab pool with one, then borrows item UIs from `PoolCore` only for items overlapping the visible area and calls `bind(item UI, index)`. An item UI that scrolls out is reused for a new item. For `Measured`, the pool count and the first layout are decided with estimated sizes, and all previous measured sizes are deleted. It turns the loading state off, and when the start-at-end flag is `true` it sets the scroll position to the max scroll position, otherwise it clamps the scroll position to at most the new max scroll position. When it is called again while a `set_items` is waiting, the waiting one ends with `false` without binding
- `append_items` increases the item count. It does not wait. When end follow is on and the scroll position before the call was the max scroll position, the scroll position is set to the new max scroll position, otherwise the scroll position does not change. It borrows item UIs for the new indexes whose items overlap the visible area and binds them
- `prepend_items`(n) adds n items at the front of a list whose cross axis count is 1. It does not wait. The item at index i becomes index i + n, and its measured size and borrowed item UI move with it. Moved item UIs are not bound again. The sum of the scroll-axis sizes of the n added lines and the item spacing is added to the scroll position so items that were visible do not move on screen. It borrows item UIs for the new indexes whose items overlap the visible area and binds them
- remaining item count = item count − 1 − last index overlapping the visible area. When no item is visible, the last index is −1. The judgement runs when `set_items`, `append_items`, or `prepend_items` finishes and in a frame where the scroll position or a measured size changes
- The end-near callback is called once at the first judgement after `set_items` or `append_items` where the remaining item count is `UICore.scrollLoadThresholdItems` or less. After that it is not called until the next `append_items` or `set_items`. In this callback content code requests the next list and calls `append_items` with the received count
- front remaining item count = first index overlapping the visible area. When no item is visible, there is no judgement. The judgement runs at the same times as for the remaining item count
- The start-near callback is called once at the first judgement after `set_items` or `prepend_items` where the front remaining item count is `UICore.scrollLoadThresholdItems` or less. After that it is not called until the next `prepend_items` or `set_items`. In this callback content code requests the preceding list and calls `prepend_items` with the received count
- Turning `set_loading` on borrows one loading item, shows it at item size at the cross axis start of the line after the last line, and includes it in the scroll range. Turning it off returns the loading item. The loading item has no index and is not counted in binding or the remaining item count. When the loading item prefab key is an empty string, it does nothing
- `set_scroll_offset` clamps the received value to at least 0 and at most the max scroll position and sets it. `scroll_to_index`(i) sets the scroll position to the distance to the start of the line that has item i and clamps it the same way. `scroll_to_end` sets the scroll position to the max scroll position
- Item UIs and the loading item are owner-bound borrows from `PoolCore` with `UIScrollList` as the owner object. When the `UIScrollList` is destroyed, `PoolCore` subtracts them from the borrowed count

### prepare and release

- `prepare` loads into the global scope the keys among the core settings dim, loading icon, and system popup resources that are not an empty string, and `[ui_button_click]`. When one fails, it still loads the rest to the end, and when any one failed it returns `false`. Failure: the received resource is the fallback resource of `ResourceCore`, or the root of the loaded dim, loading icon, or system popup prefab is not a UI element. For a failed dim, loading icon, or system popup, the one built in code is used
- `open_root_panel`, `open_panel`, `open_panels`, `open_popup`, `open_system_popup`, and `show_loading_icon` before `prepare` finishes leave an error log and return the failure value. Once `prepare` finishes, even when it failed, this restriction is lifted
- `release` cancels all flows, empties the queue, and deletes view focus. Stopped operations end with the failure value. It destroys panels, popups, dims, modal blockers, the loading icon, and UI layers, and releases their scopes. It does not call `on_closed`, hidden callbacks, or button callbacks, and emits no event. It calls `InputBlockCore.set_timer_hold`(`ui`, `false`)

## hook

none

## event

| event | when | payload |
|---|---|---|
| `UIOpenedEvent` | after a panel transition that made a panel visible, or the open flow of a popup, ends | key, panel flag, `PanelOpenReason`(`New` for a popup) |
| `UIClosedEvent` | after a panel or popup instance is destroyed. Includes panel cover and immediate close, and for a popup it is after the hidden callback | key, panel flag, `PanelCloseReason`(`Closed` for a popup) |
| `PanelFlowFinishedEvent` | after a panel transition operation that started a transition ends with success, failure, or cancel and the transition has ended. Not emitted for a call that ended without starting a transition | panel key, open flag(`true` for `open_root_panel`, `open_panel`, `open_panels`), success flag |
| `ExitConfirmedEvent` | the `[ui_exit_quit]` button callback of the exit confirm | none |

- `UIClosedEvent` is not emitted for an instance for which `UIOpenedEvent` was not emitted. The events one operation emits are in the order closed, opened
- `UIOpenedEvent` and `UIClosedEvent` are not emitted for system popups
- Content code and tests wait for the end of a flow with these events. They do not wait by counting frames

## error

| condition | failure value | log |
|---|---|---|
| prefab root is not `UIPanel` or `UIPopup`, `accepts_param` is `false` | `false`. `prepare` is not called | error |
| `prepare` is `false` | `false`. a close flow with force on continues with the item below | none |
| `accepts_param` or `prepare` of the root item is `false` in a close flow | `false` when force is off; when force is on, shows the root item and calls `on_opened(Returned)` | error |
| panel transition operation during a transition or a panel lock | `false`. stack unchanged | warn |
| `close_panel` when there is no current panel or it is the root item | `false`. stack unchanged | warn |
| `close_panels_to` with a panel key not in the stack | `false`. stack unchanged | warn |
| `open_root_panel` when the stack is not empty | `false`. stack unchanged | error |
| `open_panels` with an empty list | `false`. stack unchanged | error |
| duplicate popup, popup request during `close_all_popups` | `Failed` for `open_popup`, `false` for `open_system_popup` | warn |
| suppress key outside the `<owner>.<name>` rule | `Failed` for `open_popup`, `false` for `is_popup_suppressed`, `suppress_popup` does not save | error |
| `SystemPopupParam` has 0 buttons or 4 or more, back button index outside the list, body or label translation key does not exist | `false` | error |
| `close_popup` of an instance that is not an open popup | none | warn |
| `hide_loading_icon` with a token that points to no request | none. display unchanged | error |
| `set_items` with count < 0, no item prefab key, item size ≤ 0, item spacing or cross axis spacing < 0, cross axis count < 1, `Measured` with a cross axis count other than 1 | `false`. no item UI is borrowed | error |
| `append_items` before `set_items` or with count < 1 | `false`. item count unchanged | error |
| `prepend_items` before `set_items`, with count < 1, or with a cross axis count other than 1 | `false`. item count unchanged | error |
| `scroll_to_index` with an index less than 0 or at least the item count | `false`. scroll position unchanged | error |
| `set_scroll_offset` value is NaN or infinity | scroll position unchanged | error |
| `UIButton` click before `init` | click discarded | error |
| `UIButton` action not in the action list, or `back` | treated as a button whose action is an empty string | error |
| element without `UIButton` in the `set_view_focus` list | that element is not put in the list | error |
| `set_anchor_key` with an anchor key less than 1 | key unchanged | error |
| `get_anchor_rect` with an anchor key less than 1 | `found` and `visible` are `false` | error |
| callback that cannot be called | not called | error |
| license manifest cannot be read, format violation | `false` for `open_licenses`. not opened | error |
| `open_licenses` while the license screen is open | `false` | warn |
| resource received in `UICore.prepare` is a fallback resource, root of the loaded dim, loading icon, or system popup prefab is not a UI element | `false` after loading the rest. a failed dim, loading icon, or system popup uses the one built in code | error. per failed resource |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `UICore.buttonClickIntervalMs` | integer | core | content | interval that prevents repeated `UIButton` clicks |
| `UICore.dimResource` | string | core | content | resource key of the dim prefab. empty string means a black dim built in code |
| `UICore.dimOpacity` | number | core | content | opacity of the dim built in code |
| `UICore.loadingIconResource` | string | core | content | resource key of the loading icon prefab. empty string means an icon built in code |
| `UICore.systemPopupResource` | string | core | content | resource key of the system popup prefab. empty string means a screen built in code |
| `UICore.scrollLoadThresholdItems` | integer | core | content | the remaining item count at which `UIScrollList` calls the end-near callback, and the front remaining item count at which it calls the start-near callback |
| `UICore.keyboardGap` | number | core | content | game coordinates distance kept between the bottom edge of the text input element and the top edge of the keyboard area in keyboard shift |
| `UICore.systemPopupScrollStep` | number | core | content | game coordinates distance that one direction input moves the system popup scroll |
| `TimeCore.reachMarginMs` | integer | core | content | ms added to the reach judgement of `TimeCore`. used in the expected times of tests |
| `InputBlockCore.maxDurationMs` | integer | core | content | block elapsed time at which the forced release of `InputBlockCore` happens. tests wait longer than this |

## data

- reserved string: `[ui_exit_confirm]`(exit confirm body), `[ui_exit_quit]`(quit button), `[ui_exit_cancel]`(cancel button), `[ui_licenses_title]`(license screen title), `[ui_licenses_close]`(license screen close button)
- reserved sound: `[ui_button_click]`

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `user` | `UICore.popup_suppress` | `array<string>` | list of popup suppression elements |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_test_focus` | UI element | success flag | `false` | `QACore`, core test |

- When the input device is `Gamepad` and the element has `UIButton` attached and is inside the instance of the focus target or among the visible elements of the view focus, `set_test_focus` sets focus on that element and returns `true`. That element becomes the focus element of that instance or view focus. Otherwise it does not change focus and returns `false`
- STG and PROD builds do not have `set_test_focus`

## test

- `is_flow_in_progress` is `true` from `open_popup` until its open flow ends (its open tween and its wait in the popup queue included), from `close_popup` until the close ends, from `open_system_popup` until its open flow ends, and during a panel transition, and `false` when none of these is in progress
- All UI layers are drawn in the order of the behavior table, and a lower layer does not receive pointer input that a UI element of a higher layer received. During camera shake the screen position of UI elements stays the same
- During a game time pause, a popup `UIButton` still calls its click callback and the open tween finishes
- Opening B from panel A gives stack A, B, A is destroyed and its scope released, and `on_closed(Covered)` and `on_opened(New)` are each called once
- Opening a panel whose `prepare` is `false` returns `false`, there is no instance, and the stack and current panel are unchanged
- During a panel transition and a popup flow there is a block with reason tag `ui`, and after success, failure, or cancel no block set by UICore remains
- While the retry popup of a request sent by panel `prepare` stays open for longer than `InputBlockCore.maxDurationMs`, the block with reason tag `ui` is not released by forced release
- When a request sent by popup `prepare` fails and the retry popup opens, pressing the retry button under the reason tag `ui` block of the popup open flow calls the button callback, and the open flow then continues. The button of a system popup opened during the close tween of `close_popup` can also be pressed
- In stack A, B, when B stores cache C and then D is opened and closed, B, created again while D is visible, has the param it was first opened with and C and receives `prepare(Returned, C)`, followed in order by `on_closed(Closed)` of D and `on_opened(Returned)` of B, and B has no open tween
- In stack R, A with root item R, after `open_panel`(B) with clear stack on, the stack is R, B and A receives `on_closed(Closed)`. When the current panel is R, R receives `on_closed(Covered)`. In a stack without a root item, the stack is B alone
- When the current panel is the root item, `close_panel` gives a warn log and `false`, and the stack is unchanged
- In stack A, B, C, when the `prepare` of B is `false`, `close_panel` without force returns `false`, C stays visible, the stack is unchanged, and there is no `on_closed` or event. With force on, B is removed, A receives `prepare(Returned, cache)` and `on_opened(Returned)`, and the stack is A
- When `prepare(Returned)` of root item R is `false`, a close flow with force on leaves an error log and shows R, and R receives `on_opened(Returned)`
- `open_panel` of current panel A with a different param: after the `prepare` of the new A succeeds, the previous A receives `on_closed(Closed)` and the stack length is unchanged, and when the `prepare` of the new A is `false`, the previous A and the stack are unchanged. When the root item is opened with the same key, the replaced item is the root item
- In stack R, A, B, C, after `close_panels_to`(A) the stack is R, A and B has no instance or callback. When the `prepare` of A is `false`, it returns `false` without force and the stack is unchanged. A key not in the stack gives a warn log and `false`, and the key of the current panel gives `true` without a transition
- In stack R, after `open_panels`(A, B, C) the stack is R, A, B, C, and only C has an instance, `prepare(New, none)`, `on_opened(New)`, and `UIOpenedEvent`. A following `close_panel` gives B `prepare(Returned, none)`, `on_opened(Returned)`, and a `UIOpenedEvent` with reason `Returned`, with no open tween. When the `prepare` of C is `false`, the stack stays R
- In stack R, A with root item R, after `open_panels`(B, C) with clear stack on, the stack is R, B, C and A receives `on_closed(Closed)`. In stack A without a root item, the stack is B, C. With clear stack off, stack R, A becomes R, A, B, C
- `open_root_panel` when the stack is not empty gives an error log and `false`
- Calling `reset_panel_stack` during an `open_panel` that waits for `prepare` ends that operation with `false`, and even when `prepare` succeeds later the panel is not visible and the stack is empty
- Each condition of the error table gives the log and failure value of the table
- Calling `open_popup` twice in a row calls the second `prepare` after the first popup flow ends, and the second is shown on top. An `open_popup` during a panel transition opens before that transition ends
- A system popup opens even while another system popup is open and while waiting for the `prepare` of a popup, and is shown above regular popups opened after it
- `close_popup` runs in the order `on_closed`, close tween, destruction, hidden callback, after-close callback, and each of the two callbacks runs once
- The after-close callback of a popup closed by `close_all_popups` is not called
- After `close_all_popups` the popups and the queue are empty, the hidden callback runs once per closed popup, and queued requests get `Failed`
- `close_popup` of a popup in its open tween stops the open tween, `Opened` of `open_popup` and `UIOpenedEvent` come before `on_closed`, the hidden callback and `UIClosedEvent` each happen once, and afterwards no block set by UICore remains
- `close_all_popups` ends the `open_popup` of a popup waiting for `prepare` with `Failed`, and that popup has no hidden callback. A popup in its open tween gets `Opened` and one hidden callback, and a popup in its close tween does not get `on_closed` again and gets one hidden callback
- When a popup is open, it stays open after a panel transition and `reset_panel_stack`
- A popup instance opened without `PopupSuppress` has no `PopupSuppress`, and an instance opened with one reads the received value
- After `suppress_popup`(k, `Forever`), `open_popup` with key k is `Suppressed` and there is no instance, hidden callback, or `UIOpenedEvent`. The same holds after `release`, `init`, and user file load. Another key, and the same popup key without `PopupSuppress`, open
- After `suppress_popup`(k, `Today`), `open_popup` is `Suppressed` at the server time just before the next day boundary of `TimeCore` + `TimeCore.reachMarginMs`, and `Opened` at that time. The same holds when the day boundary is before or after UTC 00:00
- When `suppress_popup`(k, `Today`) is called at day boundary + `TimeCore.reachMarginMs` − 1, `open_popup` is `Opened` at that day boundary + `TimeCore.reachMarginMs`
- Before the `user` file load, `open_popup` with a `PopupSuppress` is `Opened`, `suppress_popup` does not save, `is_popup_suppressed` is `false`, and there is no error log of `LocalDataCore`
- When the root panel is the current panel and its back policy is `Close`, back input opens the exit confirm without `close_panel` on android, windows, macos, and linux, and does nothing on ios and web. When the back policy is `Custom`, `on_back` is called
- Back input is handled in the back input order, and the result for each of the three `BackPolicy` values equals the table. The body and buttons of the exit confirm are the reserved strings of data, and `[ui_exit_cancel]` and back input close only that popup
- Back input before `prepare` finishes gives no popup and no log. Back input with no popup or panel to handle opens the exit confirm when the platform the app runs on is `android`, `windows`, `macos`, or `linux`, and does not open it on `ios` or `web`
- The back handler returns `true` for back input received by a system popup, an open popup, a system popup flow in progress, the back override, a panel transition, or a popup flow, and for back input that opened the exit confirm, and returns `false` for back input received by the current panel, back input before `prepare`, and back input with nothing to handle on `ios` or `web`
- With a back override, back input while no system popup is open calls that callback once and does not follow the back policies of popups and panels or the exit confirm. When a system popup is open, back applies to that system popup. After the override is deleted with none, the rest of the back input order applies
- Pressing a system popup button calls the button callback once after the hidden callback. A system popup without a back button does not close on back input
- `open_system_popup` ends with `true` when the open flow ends, with the system popup visible, and at that time the hidden callback has not been called
- Under a block whose pass list is `get_block_pass_list`, without a system popup, pointer input at a position inside the safe area does not pass, and when a system popup opens, pressing its button calls the button callback
- Under a block whose pass list is `get_block_pass_list`, when the input device is `KeyboardMouse`, a system popup opens, and a gamepad button is pressed once, the first button of the system popup has focus in the next frame, and gamepad direction input and accept input click another button of that system popup. Without a system popup, gamepad accept input does not click a button of a popup under the block
- `get_block_pass_list` returns the same `BlockPassList` on every call, and its `elements` is the system popup root alone and its `actions` is `back` alone
- The center of a single system popup button equals the center of the popup area, and two or three buttons have equal spacing and do not overlap
- While a modal popup is open, the popups, panel, `SceneUI`, and world below do not receive pointer input, and while only popups with modal off are open, the panel receives input outside them
- When two popups with dim on are open, there is one dim, directly below the upper popup, and closing the upper popup moves it directly below the lower popup
- Releasing one of two tokens leaves the loading icon visible, and releasing both hides it. UI below receives pointer input at the loading icon position
- A second click within `UICore.buttonClickIntervalMs` has no click callback and no sound even on a different button, and a click after it has passed has them
- Calling `set_on_click` again calls only the later callback, and a click after an empty callback has no callback. There is no log after the button is destroyed
- Wherever a `UIScrollList` of 1000 items is scrolled, the number of borrowed item UIs equals the number of items overlapping the visible area, and each item UI is bound to its index. Closing that panel brings the borrowed count to 0, and then the scope is released
- The scroll position is the same before and after `append_items`, and among the new indexes only items overlapping the visible area are bound to their index
- In a vertical `UIScrollList` with cross axis count 3 and 10 items, index 4 is in the second slot of the second line, the fourth line has one item, and the number of borrowed item UIs equals the number of items of the lines overlapping the visible area. `scroll_to_index`(4) gives the distance to the second line start. The loading item of `set_loading(true)` is at the cross axis start of the fifth line
- Calling `set_items` again while one is waiting gives `false` for the earlier call with no bind from it, and only the binds of the later call happen
- After `scroll_to_index`(i), `get_scroll_offset` is the distance to the start of the line that has item i, or the max scroll position when that distance is more than the max scroll position. An index outside the list gives `false` and an error log
- Passing −1 and max scroll position + 1 to `set_scroll_offset` gives `get_scroll_offset` 0 and the max scroll position
- The end-near callback is not called at a remaining item count of `UICore.scrollLoadThresholdItems` + 1, is called once in the frame the count reaches that value, is not called again on further scrolling, and is called once more when the count reaches it again after `append_items`. `set_items` with count 0 calls it once when it finishes
- In a `Measured` vertical `UIScrollList` bound with a different minimum height per item, the distance to the line start of index i is the sum of the measured sizes of the preceding items and the item spacing. Even when the measured size of an item above the visible area differs from its estimated size, the screen position of visible items stays the same. `set_items` of `Measured` with cross axis count 2 gives `false` and an error log
- Before and after `prepend_items`(n), the screen position and item UI of items that were visible are the same and those item UIs are not bound again, and among the new indexes only items overlapping the visible area are bound. A `<name>.<index>` anchor is found with the new index. `prepend_items` on a list with cross axis count 3 gives `false` and an error log
- The start-near callback is not called at a front remaining item count of `UICore.scrollLoadThresholdItems` + 1, is called once in the frame the count reaches that value, and is called once more when the count reaches it again after `prepend_items`. `set_items` with the start-at-end flag `true` and an item count more than the number of items overlapping the visible area + `UICore.scrollLoadThresholdItems` does not call the start-near callback when it finishes, and the scroll position is the max scroll position
- With end follow on and the scroll position at the max scroll position, after `append_items` and after a change of the measured size of the last item the scroll position is the new max scroll position. When it is not at the max scroll position, the scroll position is unchanged after `append_items`
- After `scroll_to_end`, `get_scroll_offset` is the max scroll position
- During `set_loading(true)` one loading item is shown in the line after the last line with no bind, and after `set_loading(false)` there is none. When the loading item prefab key is an empty string, it is not shown
- For each success, failure, or cancel of a panel transition operation that started a transition, there is one `PanelFlowFinishedEvent`, and `is_panel_transitioning` is `false` when it is received
- A panel transition operation called during a transition or a panel lock, and `close_panel` called when there is no current panel, return `false` and have no `PanelFlowFinishedEvent`. The transition that was in progress has one `PanelFlowFinishedEvent`
- `get_anchor_rect` returns `found`, `visible`, and the rectangle for a visible anchor, a result with only `found` `true` for an anchor under a hidden ancestor, inside a panel in `prepare`, or inside a panel under an open modal popup or system popup, and a result with both `false` for a name that does not exist. An anchor inside a panel with only popups with modal off above it is visible. When two with the same name are visible, it is the one drawn on top. `owner` is the panel key for an anchor in a panel, the popup key for an anchor in a popup, and an empty string for an anchor on the `SceneUI` layer
- When `set_anchor_key` sets key 7, key 7, and key 9 on three visible `UIAnchor` elements named a, `get_anchor_rect`(a, 7) returns the one drawn on top of the two with key 7, (a, 9) returns the one with key 9, (a, 8) returns a result with `found` and `visible` `false`, and (a) without a key returns the one drawn on top of the three. After `set_anchor_key`(none), that anchor is not found by (a, 7) and is found by (a). `set_anchor_key` and `get_anchor_rect` with key -1 leave an error log
- `get_open_popup_count` equals the number of visible popups each time a regular popup or a system popup opens and closes
- `is_system_popup_visible` equals whether the system popup root is visible each time a system popup opens and closes, and is `false` when only regular popups are open
- When a system popup opens and closes, `get_open_popups` is unchanged and there is no `UIOpenedEvent` or `UIClosedEvent`
- In the frame after the input device becomes `Gamepad`, the initial focus element of the topmost modal popup has focus, and gamepad accept input is one click of that `UIButton`. When the input device becomes `Touch`, there is no focus
- When the input device is `KeyboardMouse`, on one key direction input the initial focus element of the topmost modal popup has focus in that frame, and focus does not move. The next key direction input moves focus, and a key accept input is one click of the `UIButton` that has focus. After that, one mouse movement leaves no focus. A key direction input received by a text input element with engine focus creates no focus
- In a popup without initial focus, the first `UIButton` has focus, and direction input does not move focus to an element outside that popup
- While the input device is `Gamepad`, when popup B opens above popup A, the focus element of B has focus, and when B closes, the element in A that had focus before B opened has focus again
- When only a panel with modal off is open, there is no focus and gamepad presses do not go to UI elements
- When the input device is `Gamepad` and a modal popup is open, calling `set_view_focus`(`Cutscene`, buttons A and B, A, callback) gives A focus, direction input does not move focus outside A and B, and accept input is one click of A and one callback(A). Setting a `Tutorial` view focus over it gives its initial focus element focus, and when a system popup opens its first button has focus. After `set_view_focus`(`Cutscene`) with an empty list, the focus element of the modal popup has focus
- When the input device is `Gamepad`, in a vertical `UIScrollList` with 100 items and cross axis count 1, when an item of the last line fully inside the visible area has focus, one down direction input changes the scroll position so the end of the next line aligns with the end of the visible area, and the first `UIButton` of the item at the next index has focus. Repeating down direction input calls the end-near callback once, and at the last item the scroll position is unchanged. Repeating up direction input up to the first item gives scroll position 0
- When the resource keys of core settings are empty strings, the dim, loading icon, and system popup built in code are shown
- When `UICore.dimResource` is a key that does not exist and the root of the `UICore.loadingIconResource` prefab is not a UI element, `UICore.prepare` ends with `false` after loading the system popup prefab and `[ui_button_click]`, UICore has two error logs, and the dim and loading icon built in code and the loaded system popup are shown
- After `release` there are no panels, popups, dims, modal blockers, loading icon, or UI layers, and there is no `on_closed`, hidden callback, button callback, or event
- For a `UIButton` element of a panel under an open modal popup, `is_modal_covered` is `true`, and for an element inside that popup and an element of a panel with only popups with modal off above it, it is `false`. After that modal popup closes, the panel element gives `false`
- A `UIButton` with an action receives one click callback and one `[ui_button_click]` in the frame that action is pressed. When the button is modal covered or not visible, or there is a block that does not pass that action, there is no click. When the accept input of focus and an action click both match in the same frame, there is one click
- A `UIButton` whose action is `back` or not in the action list leaves an error log and is not clicked by the input of that name
- `set_test_focus` sets focus on a `UIButton` element of the focus target instance and returns `true` when the input device is `Gamepad`, and returns `false` with focus unchanged for an element outside that instance, an element without `UIButton`, or when the input device is not `Gamepad`
- When the input device is `Touch`, a pressed text input element has engine focus and still has it in the next frame. When the input device becomes `Gamepad`, the focus element of the focus target has focus
- When text input element E in a popup has engine focus and the keyboard area set with `SafeAreaCore.set_virtual_keyboard` covers the bottom edge of E, that popup root is d higher, and the bottom edge of E + `UICore.keyboardGap` equals the top edge of the keyboard area. After `clear_virtual_keyboard` the popup root is at its original position. When E is on the `SceneUI` layer, the `SceneUI` layer moves
- When the keyboard area covers up to the top edge of E + `UICore.keyboardGap`, d is the distance between the top edge of E and the top edge of the safe area. When the keyboard area does not reach the bottom edge of E + `UICore.keyboardGap`, the shift target is at its original position
- When engine focus moves from E to a text input element of another instance, the shift target of E returns to its original position and the shift target of the new element moves
- The extra text of `open_licenses` contains only the components whose `platforms` contains the platform the app runs on, in manifest order, and contains the full text of `texts` once per SPDX license ID. `[ui_licenses_close]` and back input close the screen, and `open_licenses` is `true`. Calling it again while it is open gives `false` and a warn log, and without a manifest it gives `false` and an error log
- In a system popup whose extra text is longer than the area, when the input device is `Gamepad`, one down direction input moves the scroll position by `UICore.systemPopupScrollStep`, and at the end the scroll position is unchanged
