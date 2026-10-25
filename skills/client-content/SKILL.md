---
name: client-content
description: Holds the rules of client content code for folder structure, feature boundary, core usage, role split with server, shared formula, deterministic simulation, tick simulation, scene and prefab, DEV code, automation channel connection, bot playtest scenario and save fixture, row simulation and client regression test, and the per-engine content rules. Read when writing or fixing client content code, when doing client hardening, when the server hardening agent looks at `## role split with server`, and when the core agent writes per-engine content rules or writes the scenario of a benchmark game
---

# client content

Per-engine rules: [godot](engines/godot.md)

## folder

The folders below are logical folders. A logical folder and a path under it that harness documents write mean the actual path in the engine project, and the per-engine rules `## project` set the actual path. The harness tool, the data tool and the contract tool set the actual path with the per-engine rules of game settings `engine`.

| logical folder | contents | writer |
|---|---|---|
| `client/core/` | client core of the core release | harness tool |
| `client/generated/` | generated code of the contract tool, the data tool and the resource key constants, the resource key list file, the merged core settings values `core_settings.json`, the spec types of core settings `core_settings_types.json`, the module list of `BootstrapCore`, the game's license manifest | harness tool |
| `client/features/<feature>/` | content code of one feature | content agent |
| `client/common/` | content code that several features share | content agent |
| `client/boot/` | content entry passed to `BootstrapCore.start_boot` (`content_init`, `content_release`, `select_first_scene`) | content agent |
| `client/tests/` | client regression test | content agent |
| `client/build/` | client table binary, translation binary and `data_version` that the data tool made with binary build. Not committed | harness tool |
| `client/dev/` | DEV code. Bot playtest scenarios and save fixtures go in `client/dev/bot/` | content agent, harness tool |

- `client/core/` and `client/generated/` are not edited. An automated check compares them against the core release and the generation result
- `<feature>` is snake_case. One feature handles one or more screens, and one screen is handled by one feature

## feature boundary

- A feature does not reference the code, scenes or prefabs of another feature. Notification between features uses content events of `EventCore`
- Code that several features use goes in `client/common/`
- Screen navigation uses `SceneCore`, `UICore` and `ShortcutCore`
- Static check `feature boundary` blocks references across feature boundaries. The per-engine rules set which references it checks

## core usage

- Core is used only through the public API of its spec. The module list and the specs are [`client-core`](../client-core/SKILL.md)
- Where hooks are registered follows `## hook` of [`core`](../core/SKILL.md). Content initialization is `content_init` of the content entry
- No block with the same purpose is set again on top of a block that core already sets
- What core handles (server request, UserState cache, resource loading, translation, sound, popup, tween) is not written again in content code. When core falls short, a core proposal is written and content code works around it
- Code outside `client/dev/` does not read the settings files (`settings.json`, `core_settings.json`) or `CoreSettings`. Game settings values used at run time are received through core operations, and gameplay values go in data `game_setting`. Static check `settings access` blocks violations
- Resources are not loaded directly with the engine API; `ResourceCore` is used. Static check `resource load` blocks violations
- The engine's built-in random functions are not used; the random instance of `UtilCore` is used. Static check `engine random` blocks violations
- Data containers, their rows and derived containers are not changed. Static check `data mutation` blocks violations
- The display spacing of interstitial ads (minimum interval, new user grace, Nth opportunity, ad removal product list) is set by `ad_placement` data. Content code decides which moment is an opportunity. e.g. the end of each level after the third level is cleared. `AdCore.show` is called at each opportunity. Content code does not count time intervals or opportunities on its own
- The watch-ad entry of a placement whose `AdCore.get_ready_state` is `Unsupported`, the product purchase entry when `PaymentCore.is_supported` is `false`, and the push permission request entry when `PushCore.get_permission` is `Unsupported` are not put on screen. On web all three apply
- Changing the meaning or value type of a `LocalDataCore` key uses a new key name. When the new key does not exist and the original key does, the original value is converted and written once to the new key, and the original key is deleted with `remove_value`
- The option screen has the entries below. An entry with a condition is there only under that condition. Static check `option entry` blocks a missing call
  - `terms`: a button that opens the `TERMS` and `PRIVACY` documents with `AuthCore.open_terms_document`
  - `withdrawal`: a button that calls `AuthCore.withdraw` after getting consent with a confirm popup. When `iap_product` has a row whose `type` is `Subscription` and a `SubscriptionUserState` row read with `UserStateCore.list` has `auto_renew` `true`, the confirm popup has a warning that withdrawal does not cancel the store subscription so auto-renewal charges continue, and a button that calls `PaymentCore.open_subscription_management`
  - `user code`: text that shows the public code of `AuthCore.get_public_code` in two groups of 4 characters joined with `-`, and a button that copies that text with `NativeUiCore.copy_text`. `NativeUiCore` is put in game settings `coreModules.client`
  - `account`: present when a social provider has `AuthCore.is_provider_supported` `true`. For each such provider, text that shows whether it is linked (`AuthCore.list_linked_providers`), and an `AuthCore.link_account` button for a provider that is not linked. When `link_account` is `AlreadyLinked`, `AuthCore.switch_account` (that provider) is called after getting consent with a confirm popup for switching to the account linked to that provider. The confirm popup opened from an account with no linked provider has a warning that the user cannot come back to the current account. When `PaymentCore.purchase` returns `LinkRequested`, this entry opens. The scene that `select_first_scene` returns has a button that opens this entry before the first tutorial starts
  - `privacy choices`: when `AuthCore.is_privacy_choices_enabled` is `true`, a button that calls `AuthCore.open_privacy_choices`. When `AdCore` is a module the game uses, an additional button that calls `AdCore.open_ad_privacy_options` when `AdCore.is_ad_privacy_options_required` is `true`
  - `push consent`: when `AuthCore.is_ad_push_enabled` is `true`, a `push_ad` toggle and a `push_night` toggle that show the value of `PushCore.get_push_consent` and change it with `PushCore.set_push_consent`
  - `restore`: when game settings `buildPlatforms` has `ios` or `macos` and `iap_product` has a row whose `type` is `NonConsumable` or `Subscription` and whose `sku_apple` is not an empty string, a button that calls `PaymentCore.restore_purchases` when the platform is `ios` or `macos`. When `other_user` of the result `RecoverySummary` is 1 or more, a notice shows that there are purchases bound to another account
  - `licenses`: a button that calls `UICore.open_licenses`
  - `account deletion`: a button that calls `AuthCore.issue_deletion_code`, text that shows the received `code`, `expires_at` and `url`, and buttons that copy `code` and `url` with `NativeUiCore.copy_text`
- When game settings `buildPlatforms` has `android` and `iap_product` has a row whose `type` is `NonConsumable` or `Subscription` and whose `sku_google` is not an empty string, `PaymentCore.restore_purchases` is called once when the scene that `select_first_scene` returned starts, when the platform is `android`. When `other_user` of the result `RecoverySummary` is 1 or more, a notice shows that there are purchases bound to another account
- In a realtime game, `select_first_scene` returns the scene key of the scene that shows the match when `RealtimeCore.saved_match_id` is not an empty string. That scene calls `RealtimeCore.rejoin_match` with that match ID when it starts, and on `Failed` goes to the scene key of `BootstrapCore.get_first_scene`

- The page of a web build is cross-origin isolated (COEP `require-corp`, COOP `same-origin`; `build` skill `## web hosting`). Content code loads scripts, images, audio and fonts of another origin only from a host whose response sends CORP `cross-origin` or answers CORS, and does not rely on iframes of another origin (e.g. web display ads, external widgets) or on popups that return to the opener. When such a feature is needed, it goes in a core proposal

## role split with server

- The server makes the judgements that decide results (reward, probability, win or loss, item change, unlock). The client changes the screen with the UserState delta and the response message of the server response. The exceptions are the two client calculations below
- Single-player play whose result client simulation decides (e.g. match-3 board, action run) starts with the `play-session` request `StartPlaySession` and ends with `FinishPlaySession`. The client decodes `loadout` of the response with the generated `PlaySessionLoadout` and uses it as the user state of the simulation, and sends the result of the finished round as the generated `PlaySessionResult`. The server decides rewards, loot and unlocks, and they come as a delta
- Choices made before the round starts (e.g. booster) are sent in `options` of `StartPlaySession` (the generated `PlaySessionStartOptions`), and a continue during the round in `options` of `ContinuePlaySession` (the generated `PlaySessionContinueOptions`). The server subtracts the cost and it comes as a delta. A continue is applied to the simulation after its success response arrives. The continue count is checked against `max_continue_count` of `play_session_mode` before sending
- `GameUpdateCore.set_in_play`(`true`) is called when one round (a play session of `play-session`, a realtime match) starts, and `set_in_play`(`false`) when the result response of that round (`FinishPlaySession`, `ReportMatchResult`) arrives or the round is abandoned. When the server requires a data update in the meantime, the restart popup opens after the round ends
- The client calculates the results within a realtime match (win or loss, score), and the participants agree on them with the realtime messages of the contract. A result that changes the saved state is reported by content code with the `matchmaker` request `ReportMatchResult` after the match ends, and `result_rule` of `matchmaker` confirms it
- After `ReportMatchResult` is sent, the result screen shows the result with the `MatchOutcomeUserState` item of that `match_id` (`## hook` of [`server-content`](../server-content/SKILL.md)). When `status` of the response is `PENDING` or the item is not there yet, it shows a notice that it is waiting for the judgement, and calls `NetworkCore.resync` at each interval set in data until the item arrives. A match not judged becomes `MISMATCH` at the server's `deadline_at`, and its item arrives. When there is still no item after the wait limit set in data, the result screen can be closed, with the notice that it is waiting for the judgement, and an item that arrives later follows `## UserState changed outside a request`
- Before sending a request the server would reject, the client checks the same condition in advance and does not send it. e.g. not enough items, purchase limit, locked, outside the active window. The conditions use the same data as the server. Counts with a reset and progress, active windows and offers are read with the `UserStateCore` operations `get_shop_purchase_count`, `get_iap_purchase_count`, `get_ad_reward_count`, `get_reset_counter`, `get_mission_progress`, `get_attendance`, `get_live_event_round`, `is_offer_active`, `get_offer_ends_at` and `is_in_period`. The effect of a timed item is judged with `UserStateCore.get_item_ends_at`, and an unlock with `RequirementCore.evaluate`
- An amount that grows as time passes and that a content request adds to an item (e.g. idle production gold) is calculated by server content code from the server time and the last added time kept in content UserState. This calculation is a shared formula. The client puts that UserState of `UserStateCore` and `TimeCore.get_server_time` into the same shared formula and shows on screen the amount not added yet. This display is not a judgement that decides a result
- When there is an amount that grows as time passes, before a core request that uses that item as a cost (e.g. `BuyShopProduct`, `DrawGacha`) is sent, the content request that adds that amount is sent first and its success response received. The advance check of that core request uses the balance of `UserStateCore` with the delta of that response applied
- When content code judges whether an end time (e.g. `end_at` of data, `expires_at` of a mail, the end time of `get_live_event_round`, `get_offer_ends_at`) has not passed yet, it uses `TimeCore.is_before_end`. It does not judge by whether `TimeCore.is_reached`(end time) is `false`
- A formula that client and server both calculate, and the judgement of a `RequirementType` element for which content registers a judge hook on either the client or the server, are shared formulas. Each shared formula gets a name. A formula is `<feature>.<formula>`, a `RequirementType` element is `requirement.<element in snake_case>`, and each part is snake_case
- The line right above the client function and the server function of a shared formula is a one-line comment `ogw:shared <name>`. On the server it is `// ogw:shared <name>`, and the per-engine rules set the comment format of the client. There is one in `client/` and one in `server/`
- Each shared formula has a fixture `data/fixtures/<name>.json`. Its format is `{"cases": [{"name": "<case>", "input": <JSON value>, "expected": <JSON value>}, ...]}`, with one or more cases. The client regression test reads that fixture with `UnitTestCore.read_shared_fixture`, and the server regression test with the `testing` operation `read_shared_fixture`, and they check per case that the function result equals `expected`
- Static check `shared formula` blocks violations of the shared formula rules
- A screen that calls paid random (probability disclosure of `server-content`) has a probability screen that the user can open before that request. Probabilities are calculated only as `numerator / denominator` of the `GetGachaRates` or `GetLootRates` response
- Before sending a purchase or request whose grant list the client can build from data (e.g. `BuyShopProduct`, `ClaimMission`), when the `UserStateCore.preview_item_add` result of that grant list has a `Discarded` or `Mailed` row, the client sends it after getting consent with a warning popup. On `SHOP_OVERFLOW_LOSS`, it gets consent with the same warning and sends again with `accept_loss` set to `true`
- A request whose grant list the server decides (e.g. `FinishPlaySession`, `DrawGacha`) is sent without a preview. The overflowed amount and mail grants are shown with `ItemChange` of `ItemChangedEvent` and `ItemMail` of `ItemMailedEvent` that come with that response
- For the reward of a tutorial step, that step's `complete` is `Cue` and its `save` is `true`, and `TutorialCore.notify_cue` is called after the success response of the content `rpc` that gives the reward arrives. So progress is saved after the reward, and when the app ends before the save, the next run does that step again and sends the same `rpc` again
- A tutorial step whose progress depends on the result of an action (e.g. server request success) does not set `complete` to `AnchorTap`. An `AnchorTap` step ends right after the click callback of the anchor element without waiting for the result. It is set to `Cue` with `TutorialCore.notify_cue` called after success, or to a `Requirement` that sees the result through UserState
- In a realtime game, judgements between clients are exchanged with the realtime messages of the contract. `RealtimeCore` exchanges bytes, so sending uses the generated `RealtimeMessage` encode and receiving uses its decode. A received message is checked as external input
- Presentation durations and animation values go in animation resources and tween presets (`tween/<name>`), and gameplay durations (cooldown, duration, speed) go in data

## deterministic simulation

- deterministic simulation: a client simulation that must give the same result when run again with the same input on another device or on the server. Tick simulation and the client simulation whose result the `play-session` hook `verify_play_session` recalculates are deterministic simulations.

- Its code goes in `client/features/<feature>/sim/` and `client/common/sim/` and keeps the rules below. The per-engine rules set the code it can call. Static check `determinism` blocks violations
  - Integers only. Division and remainder use `UtilCore.floor_div` and `UtilCore.floor_mod`, and scaling uses `UtilCore.apply_permille`
  - Random is one instance made with `UtilCore.create_random`(`UtilCore.make_purpose_seed`(purpose name, base)). The confirmed state of a tick simulation uses purpose name `match_simulation` and the match seed, and the simulation of `play-session` uses `play_session_simulation` and the simulation seed held in `loadout`
  - A simulation that uses time advances in fixed-length ticks, and the time is tick number × tick length. The tick length goes in a content table. `TimeCore` and frame elapsed time are not used
- Only simulation code changes the simulation state. The screen is drawn from the simulation state. Results of engine physics, animation and object transforms are not used as simulation state
- In the simulation of `play-session`, the function that runs one round to the end with `loadout`, `options` of `StartPlaySession`, `options` of the continues and the input record of the round, and returns the result values, is shared formula `<feature>.sim_play`. The server's `verify_play_session` recalculates the result with the same function
- `ogw generate` makes `data/simulation_tables.csv`, the list of tables that deterministic simulation code reads, from that code. The generated accessor `GameSetting` counts as reading the `game_setting` table
- After the first PROD build, the values of rows in those tables that were in the PROD data tag data of [`data`](../data/SKILL.md) are not changed. The data tool blocks it with `prod_change`. To change a value, a row with a new ID name is added, and `prepare_play_session` puts the ID value of that row into `loadout` of a new round so that the simulation reads that row. So `verify_play_session` also recalculates a round started before a data update with the same values

## tick simulation

Content code runs a realtime match in which all participants run the same simulation to decide the results within the match (e.g. versus action, RTS) as a tick simulation. A tick simulation is a deterministic simulation. Input exchange and tick progress are built on the realtime messages of `RealtimeCore` and the match time.

- Tick t runs when `RealtimeCore.match_time_ms` is t × tick length or more and the tick t inputs of all participants are present. Ticks do not advance with frame elapsed time. So in a DEV lockstep match the simulation advances only as far as `step` of `QACore`
- An input is the contract realtime message for one tick of one participant, sent as `Reliable`. A DEV lockstep match delivers the `Reliable` messages sent during one step to all participants before the next step starts
- An input whose fields all have default values is an empty input. A received input that fails the external input check is treated as an empty input. All participants treat the inputs of a participant who left as empty inputs from the same tick
- Only the tick function changes the simulation state. A tick run under the conditions above is a confirmed tick, and the simulation state changed only by confirmed ticks is the confirmed state. The screen is drawn from the confirmed state or the predicted display copy
- predicted display copy: the state made by running ahead, on a copy of the confirmed state, the ticks not run yet with the same tick function and predicted inputs. The ticks it runs go up to the last tick t for which `RealtimeCore.match_time_ms` is t × tick length or more. The predicted input is, for its own input, the input sent, and for an input of another participant not received yet, the last input received from that participant. When no input was received, it is an empty input. When a confirmed tick runs, the predicted display copy is discarded and made again from the confirmed state
- The random of the predicted display copy is one instance made with `UtilCore.create_random`(`UtilCore.make_purpose_seed`(`match_prediction`, match seed)), and it does not use the random of the confirmed state
- The confirmed state, `MatchInputLog`, the match result and `ReportMatchResult` are decided only by confirmed ticks. Values of the predicted display copy are not written to the confirmed state
- When `result_rule` of the match mode is `ServerReplay`, the tick function is shared formula `<feature>.sim_tick`. `MatchInputLog` holds the last tick run; for each input that is not an empty input, its tick, participant index and input (in tick order, and in participant index order within the same tick); and for each participant, the tick from which their input was treated as an empty input after leaving (0 when they did not leave). All participants report the same bytes. Server `replay_match` runs the same tick function from tick 0 to that last tick with the same inputs
- At match end, when the tick in which the simulation reaches the end condition runs, the `matchmaker` request `ReportMatchResult` is sent. For `ServerReplay`, `input_log` holds `MatchInputLog`. `RealtimeCore.end_match` is called after the other participants have received all of this client's inputs up to that tick
- While a tick cannot run because it waits for a participant's input, the screen shows the participants being waited for

## hardening

At build, the client hardening agent finds and fixes the items below based on the contract. The content agent writes code without them from the start.

- Judgements made by the client that decide results. The client simulation of `play-session`, results within a realtime match and the on-screen display of amounts that grow as time passes are not targets
- Request handling that differs from the contract
- Received realtime messages used without an external input check
- Requests sent without an advance check
- A core request that uses an item as a cost without first sending the content request that adds the amount of that item that grows as time passes
- DEV code outside `client/dev/`
- Constants in the client's constants file (per-engine rules `## feature folder`) that are game data values
- Values set by data, the server or code that are embedded in the source text of text the client shows ([`data`](../data/SKILL.md) `### format`)
- Code that puts text entered by another user (nickname, chat message, guild name) into a text element that interprets markup without escaping. e.g. BBCode of Godot `RichTextLabel`
- Code that opens a URL not in data. Code that opens a URL that came from user input or a server response
- Code that puts text entered by the user into logs of `LogCore` and into analytics events

## scene and prefab

- A screen that matches one of the below is split into a scene, and other screens are made as panels
  - Its gameplay loop, world or camera differs from the previous screen. e.g. lobby and battle
  - Its resources are not kept in memory together with the resources of the previous screen. e.g. a large map, battle assets
  - Back input does not return to the previous screen. e.g. title, lobby, battle, result
- Panels and popups are not manipulated from outside. The state that the screen changes is kept outside panels and popups (`UserStateCore`, content state objects), and panels and popups draw by following that state through events
- A panel's `prepare` prepares all data the screen needs when the cache is none, and when there is a cache sends only the requests for data that must be received again. `PanelOpenReason` is the navigation direction, so it is used only for presentation and screen flow decisions
- The values a panel puts in the cache in `on_closed(Covered)` are only screen state (scroll position, selected tab)
- `prepare(Returned)` of the root panel returns `true`, and the data it needs is received by request after the panel is shown
- When the back policy of the root panel is `Close`, back input opens the exit confirm. When another behavior is needed, the back policy is set to `Custom` and back input is handled in `on_back`
- A panel whose shown content became invalid (e.g. the event ended, kicked from the guild) closes itself by calling `UICore.close_panel` with force
- A popup returns its result through the callback of its param. When the result is decided, the popup closes itself by passing that callback as the after-close callback of `UICore.close_popup`
- The resource keys of scenes, prefabs and tween presets are `scene/<name>`, `prefab/<name>` and `tween/<name>`
- Scenes and prefabs reference other resources by resource key
- The background, border and decoration of UI elements visible on screen (e.g. panel, popup, button, card and item frames, HUD, icon) are drawn with art resources (`nine_slice`, `icon`, `image`). The engine's default look and single-color boxes made in code are not left on screen as they are. Those resources are put in as placeholder resources of [`resource`](../resource/SKILL.md) and handed off with a resource request. The judge agent looks at this as `presentation`
- Animations of `sprite_animation` and `rig_animation_2d` are played by the `animations` names in `spec` of that resource row

### UI composition

- One theme gives every screen its colors, fonts, text sizes and the look of panels, popups, plates and buttons. Scenes and prefabs pick a style of the theme and do not set their own (the theme of `engines/<engine>.md`)
- Text sizes are the steps of the theme: title, heading, body, caption and number. The UI quality check fails a screen with more text sizes than game settings `uiQuality.maxFontSizes` or with text smaller than `uiQuality.minFontPx`, and text whose contrast with what is behind it is under `uiQuality.minContrast`
- A panel or popup is drawn in layers: a frame, a header band that holds its title, an inner inset behind its content, and a divider between its groups. Its background is not one flat color, and its content fills it. The UI quality check fails a panel or popup whose background is mostly one color or that is mostly empty (game settings `uiQuality`)
- lobby: the logo or title and the playable character or key art in the middle, the start button as the largest button at the bottom center, currencies at the top right, other menus at the sides
- HUD: health and level at the top left, time or goal at the top center, resources at the top right, abilities at the bottom. A HUD plate is the size of what it holds
- popup: a title band at the top, the content, and the buttons at the bottom with the main action on the right
- result: the outcome as a title, the numbers of the play counting up, the rewards, then the retry and leave buttons
- A button has normal, pressed and disabled art, and a press plays a sound and a scale tween. Panels and popups open and close with tween presets, and the items of a list or a reward appear one after another
- The positions of screen elements are based on the visible game area of `ResolutionCore` and the safe area of `SafeAreaCore`
- A text input element is placed so that it is fully visible above the on-screen keyboard even after the keyboard shift moves it. The keyboard capture of the UI quality check checks this
- Information distinguished only by color is also shown with shape or text
- A user is shown to a person by its public code (`AuthCore.get_public_code`, `public_code` of `PublicProfileEntry`) in two groups of 4 characters joined with `-`, and is found from a code a person typed with `FindUserByPublicCode`. A user ID is not shown on screen
- When game settings `gamepadSupported` is `true`, every `UIButton` on every screen can be pressed with a gamepad. A button inside a modal panel or modal popup is reachable by focus movement, and every other button has as its `UIButton` action an action that has a gamepad button binding. The gamepad focus check of the UI quality check checks this
- The behavior of the action set on a `UIButton` is received only through the click callback, and content code does not read that action again with `InputCore`
- Text shown to humans that refers to the key, mouse button, gamepad button or touch button that presses an action does not write its name but uses the input prompt token `{action:<action>}`. A UI text element that directly wrote the result of `LocalizationCore.get_text` or `format` receives the `InputCore` event `InputPromptChangedEvent` and writes again

## UserState changed outside a request

- UserState changed by an out-of-request change (`### transaction` of [`storage`](../server-core/modules/storage.md)) comes as a `UserStateChangedEvent` whose source is `Pending`
- How much of an item was gained or lost is presented only with `ItemChange` of `ItemChangedEvent`. It is not calculated by subtracting the UserState before the change from the UserState after it
  - The amount that overflowed `max_amount` is presented with `overflow` of `ItemChange`, and its substitute grant with the source `Overflow` `ItemChange` right after it. A grant sent by mail is presented with `ItemMail` of `ItemMailedEvent`
- The default way to tell about that change is the display of `BadgeCore`. Popups or presentations are shown only on screens that content code decides (e.g. lobby, mailbox)
- Entering that screen calls `NetworkCore.resync` to receive the pending delta

## DEV code

- Cheats, debug screens, debug text and automation channel commands go only in `client/dev/`. Code that is not DEV code or a regression test (`client/tests/`) does not reference `client/dev/`
- debug text: a non-empty string literal that client content code, scenes and prefabs put into the text of a UI text element

## automation channel

Bot playtests and the play agent's instance control use the automation channel of `QACore`. The content agent registers the following in `client/dev/` for each feature.

- For each screen, a command `<feature>.open_<screen>` that goes to that screen and a command that reads the state of that screen. `open_<screen>` takes no argument; called from any screen, it makes the needed state with setup, opens that screen and then ends. The UI quality check goes through the screens with this command. Other command names are `<feature>.<command>`
- For each value that can go wrong (item, quantity, HP, progress), an invariant is registered with `QACore.register_invariant`. e.g. an item balance is not negative
- `QACore.mark` is called at the moments of failure (`Fail`), restart (`Restart`), goal reached (`Goal`) and a reward that is not an item (`Reward`), and at the first screen response to input (`Response`). `Reward` gets the ID value of the target received. For `Reward`, e.g. a drawn character, dropped equipment, a run upgrade. For `Response`, e.g. a silent move, an attack start. The judge agent's telemetry uses these marks
- An anchor with several targets of the same kind (e.g. minions on the board, cards in hand, list items) has that kind as the anchor name and the unique number of the target as the anchor key. The unique number is a value that does not change while that target exists. e.g. the number assigned when a minion is played in a match, the ID value of an item. The order of screen positions is not used as the anchor name or the anchor key. This is so that the play agent and bots press the same target with the same anchor even when other targets appear or disappear
- A content command `<feature>.bot_next_input` that picks the input the bot puts in for the current state. It takes no argument. It returns one input command to put in as `{"command": "<name>", "args": ["<argument>", ...]}` in `result`, and `null` when there is nothing to put in. The returned command is a `QACore` built-in command marked as input. e.g. one move that makes a match on a match-3 board. The `auto` step of the bot playtest calls it
- In a realtime game, one feature that starts matches registers the behavior of the opponent bot client as content command `<feature>.opponent_step`. Its argument is the ID name of a match mode. When `RealtimeCore.match_state` is `None` and the client is not in a room, it calls the matching start code of that feature with that match mode to start matching, and `result` is `null`. When that user does not meet the matching conditions, it meets them with cheats and then starts. When it is `None` and the client is in a room, it calls `RealtimeCore.leave_room` only when it is the only room member, and `result` is `null`. When it is not `None`, it returns, as the opponent, one input command to put in next as `{"command": "<name>", "args": ["<argument>", ...]}` in `result`, and `null` when there is no input to put in. The returned command is a `QACore` built-in command marked as input
- When `match_mode` has a mode that can open a room of [`matchmaker`](../server-core/modules/matchmaker.md), the feature that registered `.opponent_step` also registers content command `<feature>.opponent_join_room`. Its argument is a room code. It calls `RealtimeCore.leave` when `RealtimeCore.match_state` is not `None`, or `RealtimeCore.leave_room` when the client is in a room, and then waits for `RealtimeCore.join_room`(that room code). When `ok` of `RoomResult` is `false`, the command fails. `result` is `null`
- When the modules the game uses include one of `friend`, `guild` and `chat`, one feature that uses that module registers the behavior of the social bot client as content command `<feature>.social_step`. Its argument is the user ID (decimal string) of the client that is not the bot client. Each call does, with the request code of that feature, one action below of the modules the game uses that can be done now, and returns the name of that one action as a string in `result`. When there is no action to do, `result` is `null`. The same action is not done twice on the same target. When the social bot client does not meet the conditions of an action, it meets them with cheats
  - `friend`: sends a friend request to that user. Accepts a friend request that user sent
  - `guild`: creates a guild. Accepts the join request of that user
  - `chat`: sends one reply message for each `Direct` channel message that user sent to the social bot client and for each message that user sent to the `Guild` channel of the same guild

## bot playtest

`ogw check` runs `client/dev/bot/scenario.json` on a headless instance and judges no blocker and full flow. The content agent writes the scenario and the save fixtures.

- scenario: UTF-8 JSON object `{"steps": [<step>, ...], "goal": <condition>}`. The steps run in order, and `goal` must be `true` after the last step
- save fixture: `client/dev/bot/fixtures/<name>.json`. It is `{"steps": [<step>, ...]}` and holds only steps whose `kind` is `setup`. `<name>` is snake_case. The runner uses it to start an instance at that moment. A moment that comes only after time passes is made by moving the server time forward by that duration with a `set_server_time_offset` step

| step field | contents |
|---|---|
| `kind` | One of `input`, `setup`, `auto`, `save` |
| `command` | For `input`, a `QACore` built-in command marked as input; for `setup`, a built-in command marked as setup or a content command; for `auto`, `<feature>.bot_next_input`. Not written for `save` |
| `args` | Arguments of the command. A list of strings; an empty list when there are none |
| `until` | The condition at which the step ends. When absent, the step ends when the command ends. `auto` must have it |
| `timeoutMs` | Time limit of the step. An integer of 1 or more, on every step |
| `social` | The module name the step checks (`friend`, `guild`, `chat`). Only on the required steps of that module |

- `auto`: repeats calling the command and putting in the returned input command until `until` is `true`. When `result` is `null`, it puts in nothing and calls again. The tool leaves at least 2 times `UICore.buttonClickIntervalMs` of the game's merged core settings between two inputs. When that key is absent, it leaves no gap
- `save`: reads `content` of `get_state`, calls `restart`, and reads `content` again after `boot_stage` becomes `Done`. When the two values differ, the step fails
- condition: `{"path": "<path>", "op": "<op>", "value": <JSON value>}` or `{"all": [<condition>, ...]}`. `path` starts with `state.` (`QAState` of `get_state`) or `telemetry.` (`get_telemetry`) and joins field names with `.`. `op` is `eq`, `ne`, `gte`, `lte` or `count_gte` (array length is `value` or more). A path that does not exist is `false`
- `goal` holds `{"path": "telemetry.goal_intervals", "op": "count_gte", "value": <n>}` (n is 1 or more). Even for a game with many levels or stages, the end of the scenario is this `goal`
- The scenario holds all of the below. Static check `bot scenario` blocks a missing one
  - Steps from the first run of a new user through the tutorial to the `Goal` mark of the main loop
  - A `save` step
  - When the `tutorial` table has rows, tutorial resume: with N the `id` ID name of the row with the smallest `order`, a step whose `until` is `{"path": "state.tutorial.id", "op": "eq", "value": "N"}`, the `save` step right after it, and after that a step whose `until` is `{"path": "state.completed_tutorials.N", "op": "eq", "value": true}`
  - reconnect: a `force_network_failure`(`connection_failed`) step, then a `force_network_failure`(`none`) step, then a step whose `until` sees that progress continued
  - In a realtime game, a `drop_peer`(`other`) step and a `drop_matchmaker` step during a match, each followed by a step whose `until` sees that the match continued
  - In a realtime game, a `restart` step whose `kind` is `setup` during a match. Its `until` is `{"path": "state.match_state", "op": "eq", "value": "Playing"}`
  - In a realtime game where `match_mode` has a row whose `allow_room` is `true`: a step whose `until` is `{"path": "state.room_code", "op": "ne", "value": ""}`, then a step that starts a match with that room, which the opponent bot client joined, and whose `until` is `{"path": "state.match_state", "op": "eq", "value": "Playing"}`
  - For each of `friend`, `guild` and `chat` among the modules the game uses: a step whose `until` sees the result of a `.social_step` action reaching the client that is not the bot client (e.g. a received friend request, an accepted guild join, a received reply message). The `social` of that step is that module name
- No blocker is `fail` when one of the below occurs. The state after `restart` and before `boot_stage` becomes `Done` is not looked at
  - The client process or the server process ended
  - `state.boot_stage` is `Halted`
  - The client log or the server log has an error level line
  - `state.invariant_failures` is not empty
  - `state.softlock` is not `null`
  - A command returned `ok` = `false`, or a step did not end within `timeoutMs`
- When no blocker is `pass`, no step failed (e.g. a value mismatch of a `save` step), and `goal` is `true` after the last step, full flow is `pass`; otherwise it is `fail`. A failed step does not make no blocker `fail`. When the scenario stops at a failed step, no blocker is `unknown`: the blocker check of that step and the steps after it did not run
- When the scenario file is missing or the scenario format is wrong, no blocker and full flow are `fail`. When the bot playtest cannot run for another reason (e.g. the instance does not start), both are `unknown`

## row simulation

Each table used as `level_id` in the `play-session` request `StartPlaySession` (e.g. level, stage) has a row simulation. A row simulation is an automated check that runs the round of one row to the end with a bot per seed without a screen, and measures whether it can be solved and its difficulty metrics.

- Content command `<feature>.simulate_<table>` is registered in `client/dev/`. `<table>` is the name of that table, and the first column of that table is `id(key)`. Its arguments are the ID name of the row and the seed (a decimal integer of 1 or more)
- The command runs one round of that row to the end without changing the screen and without sending server requests. The simulation random is made with the `UtilCore` operation `create_random`(`make_purpose_seed`(`play_session_simulation`, seed)), and the bot that content wrote in `client/dev/` picks the inputs. Choices before the round starts and continues are not used
- `result` is `{"solved": <bool>, "metrics": {"<metric>": <integer>, ...}}`. `solved` is whether the round was cleared. `<metric>` is snake_case and is not `solve_permille`. e.g. `moves_left`, `moves_used`
- target column: the table has `sim_<metric>_min` and `sim_<metric>_max` as a pair. Their type is `int?` and their build target is `None`. `null` means there is no bound on that side. `<metric>` is a metric of the command or `solve_permille`
- Row values come from calling the command once for each seed from seed 1 to the seed count
  - `solve_permille`: the number of seeds whose `solved` is `true` × 1000 ÷ seed count. The remainder is dropped
  - A metric of the command: the median of the values of all seeds. With an even number of values, the smaller of the two middle values
- The row judgement is the first of the below that matches
  - `error`: the command returned `ok` = `false`, did not end within `QACore.commandTimeoutMs`, `result` has a wrong format, or `metrics` lacks a metric that has a target column in that table
  - `unsolvable`: `solve_permille` is 0
  - `out`: a value is less than `sim_<metric>_min` or more than `sim_<metric>_max`
  - `in`: otherwise
- `row simulation` of `ogw check <game> --loop` uses game settings `rowSimulationSeeds` as the seed count, and is `pass` when every row is `in`, otherwise `fail`. A table that has `sim_` target columns but no command is also `fail`

## regression test

When a feature is made, its regression test is written with it. Conventions and running follow [`UnitTestCore`](../client-core/modules/unit-test-core.md).

- Expected values are calculated from `design.md`, the contract and data. Values are not compared with a range unless the contract gives a range
- Input is put in with real input injection. Input handlers are not called directly
- Time, random and save are set with the test operations of core. Core internal state is not changed
- For deterministic simulation, the test checks that two runs with the same seed and input give the same result and the same simulation state
- It is forbidden to make a test pass by running it several times, to lengthen sleeps and timeouts, to weaken asserts, and to skip
- A test checks that a request blocked by an advance check was not sent
- For each tutorial reward step, when `release` and `init` happen after the success response of the reward `rpc` and before the response of `SaveTutorialProgress`, that step starts again, and with the success response of the reward `rpc` sent again, the step ends and moves to the next step
- When a defect is fixed, a test that fails before the fix is written first
