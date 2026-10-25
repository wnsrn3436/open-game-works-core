# BootstrapCore

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

Owns build info, the boot order from running the app to the first scene, the order of module `init` and `release`, the content entry, the fatal error screen of an unrecoverable failure, restart (redoing the boot from the beginning without running the app again), and app exit. It is not in the module list and has no lifecycle.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `DataCore`, `LocalizationCore`, `ResourceCore`, `SoundCore`, `NetworkCore`, `AuthCore`, `ResolutionCore`, `InputCore`, `InputBlockCore`, `UICore`, `MessageCore`, `SceneCore`, `GameUpdateCore`

- optional dependency: `PushCore`, `PaymentCore`, `AdCore`, `BadgeCore`, `RealtimeCore`, `NativeUiCore`, `QualityCore`, `AccessibilityCore`, `NoticeCore`, `ChatCore`, `VirtualPadCore`(touch emulation of DEV code)
- dev dependency: `QACore`
- For the other modules in the module list, it calls only `init` and `release`
- The only modules that depend on `BootstrapCore` are the DEV modules `QACore` and `UnitTestCore`. Other modules report through the boot events of `EventCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `start_boot` | content entry, module list(the generated module list when omitted), `BootTestReplacements`(none when omitted) | none | none | boot entry scene, test, `UnitTestCore` |
| `request_restart` | none | none | none | content code |
| `report_fatal` | reason text(English) | none | none | content code |
| `boot_stage` | none | `BootStage` | `None` | content code, `QACore` |
| `get_build_info` | none | `BuildInfo` | `BuildInfo` with every field an empty value | content code, `QACore` |
| `get_first_scene` | none | game settings `firstScene` | empty string | content code |

### type

| type | contents |
|---|---|
| content entry | Object that the content code in `client/boot/` makes. It has `content_init`, `content_release`, `select_first_scene` of the hook table |
| module list | List of modules, each with `init` and `release`. The harness tool generates the generated module list from the client modules among the modules the game uses (`## module` of the `core` skill). It does not include `BootstrapCore`, modules without a lifecycle (`UtilCore`) or DEV modules (`QACore`, `UnitTestCore`). In the order, a dependency comes before the module that depends on it; when several candidates fit the same position, the module that appears first in the module table of `client-core` SKILL.md comes first |
| `BootStage` | `None`, `InitModules`, `LoadData`, `Prepare`, `TitleScene`, `Update`, `ApplyUpdate`, `ContentInit`, `Login`, `AfterLogin`, `FirstScene`, `Done`, `Halted` |
| `BuildInfo` | `app_id`, `app_version`(`<major>.<minor>.<patch>`), `environment`(`LOCAL`, `DEV`, `STG`, `PROD`), `platform`(`android`, `ios`, `web`, `windows`, `macos`, `linux`), `server_url`, `game_update_url`(deploy list URL), `update_trust_keys`(list of key ID and Ed25519 public key), `adapters`(list from adapter key to adapter name), `ad_units`(list from placement ID value to ad unit ID), `instance_id` |
| update set | downloaded data(`DownloadedData`), downloaded translation(list of `DownloadedTranslation`), downloaded bundle(list of `DownloadedBundle`). Empty at first |

## behavior

### build info

- A DEV, STG or PROD build reads the build info file that the build tool wrote into the build. Its location and format are in the engine-specific implementation rules. `adapters` is the `adapters` of that environment in game settings. `ad_units` is, for each placement in `adUnits` of that environment in game settings, the ID value of the placement ID name and the ad unit ID of the build platform. A placement with no value for the build platform is not included. `instance_id` is an empty string
- The build info file has a wrong format when one of these holds: any `BuildInfo` field is missing, the type of a field value differs from the engine-specific implementation rules, `app_version` is not `<major>.<minor>.<patch>`(each part a decimal integer of 0 or more), `environment` or `platform` is outside the values of the `BuildInfo` table. Other values (empty string and empty list included) and unknown keys do not make the format wrong. The Ed25519 public key values of `update_trust_keys` are not checked. The same holds for the file of a DEV build
- A run without a build info file is a dev run. DEV code makes build info from launch values
- It reads build info once at the start of `InitModules` and does not read it again after a restart

### boot order

The boot entry scene that the engine opens first calls only `start_boot`. A stage starts after the previous stage ends. This table is every operation that `BootstrapCore` calls in each stage outside DEV code, and their order. It does not call operations of modules that are not in the module list.

| stage | work, in the listed order | failure |
|---|---|---|
| `InitModules` | 1. Read build info and set the app storage root<br>2. Pass adapters: `AuthCore.set_storage_scope`, `AuthCore.set_social_adapter`, `PushCore.set_push_adapter`, `PushCore.set_notification_adapter`, `PaymentCore.set_store_adapter`, `AdCore.set_ads_adapter`(the ad unit list is build info `ad_units`), `RealtimeCore.set_transport`(the P2P transport of `RealtimeCore` made from build info `server_url`, `app_version` and the relay-only flag. The relay-only flag is `false` in a dev run, otherwise `BootstrapCore.realtimeRelayOnly`), `NativeUiCore.set_native_adapter`<br>3. `init` in module list order. Subscribe to `RestartRequestedEvent` and `FatalErrorRequestedEvent` right after `EventCore.init` succeeds, and to `UICore.ExitConfirmedEvent` right after `UICore.init` succeeds<br>4. `LocalDataCore.load_device_file`<br>5. `NetworkCore.set_server_info`(`server_url`, `app_version`, `platform` of build info)<br>6. `ResolutionCore.apply_saved_screen_mode`, `InputCore.load_keys`, `SoundCore.load_volume_settings`, `QualityCore.apply_saved_level`, `AccessibilityCore.apply_saved_settings`<br>7. When the update set has bundles, `ResourceCore.apply_bundles`(the bundles of the update set)<br>8. `ResolutionCore.load_fill_image` | Failure of 1, 3, 5 is fatal. `false` of 4, 7 goes on to the next |
| `LoadData` | 1. `DataCore.load`(the data of the update set; none when there is none)<br>2. `LocalizationCore.resolve_language`<br>3. `LocalizationCore.load_translation`(the translation list of the update set)<br>4. `LocalizationCore.load_fonts`<br>5. `LocalizationCore.load_prompt_icons` | `false` of 1, `0` of 2 and `false` of 3 are fatal. `false` of 4, 5 goes on to the next |
| `Prepare` | Calls `UICore.prepare`, `MessageCore.prepare`, `BadgeCore.prepare` one at a time in this order and waits for each | On `false`, leaves an error log and goes on to the next operation |
| `TitleScene` | Waits for `SceneCore.boot_change_scene`(game settings `titleScene`, none). On success, destroys the boot entry scene | fatal |
| `Update` | Waits for `GameUpdateCore.check_update`(`UpdateSource` filled from build info) | On `false`, leaves an error log and goes to `ContentInit` |
| `ApplyUpdate` | Makes a new update set from `GameUpdateCore.downloaded_data`, `downloaded_translations`, `downloaded_bundles`. When it differs from the current update set, does an update reboot | none |
| `ContentInit` | 1. `content_init` of the content entry<br>2. `DataCore.build_derived_containers` | `false` of 1 leaves an error log and goes to 2. `false` of 2 is fatal |
| `Login` | 1. Wait for `NoticeCore.wait_maintenance_clear`<br>2. Wait for `AuthCore.boot_login` | When 2 is not `Success`, login failure handling |
| `AfterLogin` | Calls `LocalDataCore.load_user_file`(the logged-in user ID), `BadgeCore.load_saved`, `PaymentCore.recover_purchases`, `AdCore.start`, `ChatCore.start` in this order. Does not wait, even for async operations | Each module handles it |
| `FirstScene` | Waits for `SceneCore.change_scene`(scene key, none) with the scene key that `select_first_scene` gave | fatal on `false` |
| `Done` | Emits `BootCompletedEvent` | none |

- passing adapters: the module spec sets the adapter key. `BootstrapCore` picks the adapter by the build info `adapters` value of that key. When the value is `fake`, DEV code passes the fake adapter of that module. Otherwise it passes the real adapter that the selection criterion of that module spec decides from that value and build info `platform`. E.g. `PushCore` gets the APNs adapter for `push-apns-sandbox`. In other cases it passes none. When there is a value but it cannot pass an adapter, it leaves an error log. A fake adapter is DEV code. In a build without DEV code, `fake` is a value it cannot pass
- Logs left in `InitModules` 1 and 2 are collected and left, in the order they were left, right after 3 does `init` of `LogCore`. When 1 is fatal, it does `init` of `LogCore` only, leaves the collected logs, then does fatal error handling
- `NativeUiCore` and the notification adapter of `PushCore` have no adapter key. `BootstrapCore` passes the native adapter and the notification adapter of build info `platform`, and in a dev run passes the fake adapters of DEV code. When that platform has no adapter, it passes none
- The value for `AuthCore.set_storage_scope` is `<app_id>.<environment>`. When `instance_id` is not an empty string, `.<instance_id>` is appended
- app storage root(`LocalDataCore`): app storage when build info `instance_id` is an empty string, otherwise `instances/<instance_id>/` of app storage. `InitModules` 1 sets the root after reading build info and finishing the format check (in a dev run, the launch value check). When 1 cannot read build info or the check fails, the root is app storage. The same holds after a restart
- comparing update sets: two update sets are equal when the data version and the set of data file SHA-256, the set of translation (language, SHA-256) and the list of bundle (bundle name, SHA-256) are all equal
- update reboot: replaces the update set with the new update set, does restart handling 1 to 5, then boots again from `InitModules`. This boot skips `Update` and `ApplyUpdate`. Downloaded data, translation and bundles are applied only through this path
- A restart does not delete the update set. The boot after a restart applies the current update set and does `Update` and `ApplyUpdate`
- Each time a stage ends, it leaves the stage name and the elapsed ms in an info log
- `boot` block: the block with reason tag `boot` that it sets with `InputBlockCore.block` during `Prepare`, `ApplyUpdate`, `ContentInit`, `AfterLogin`. The pass list is `UICore.get_block_pass_list`. It does not set it during `TitleScene`, `Update`, `Login`, `FirstScene`
- UI ready: the state in which all `Prepare` stage operations of the current boot have ended. Before that, it does not open `UICore` popups
- The content code of the title scene does not read the generated containers of game data before `ContentInit`. It shows the progress rate with `GameUpdateCore.bytes_total` and `bytes_done`
- `Halted`: the state in which the boot order has stopped. It does not call the remaining operations of the current stage (operations that DEV code calls included). When an operation it was waiting for since before the stop ends, it discards that result. It does not go to the next stage, and does not do the failure handling of the boot order table (fatal, login failure popup, error log) or the stage-end info log. A new boot starts only by a restart

### login failure

- When the result of `boot_login` is not `Success`, it sets the boot order to `Halted` and opens the login failure popup
- login failure popup: a `UICore` system popup. The body is the ban body for `Banned`, `[bootstrap_age_blocked]` for `AgeBlocked`, otherwise `[bootstrap_login_failed]`. The buttons are `[bootstrap_banned_deletion]` and `[bootstrap_restart]` for `Banned`, otherwise the one button `[bootstrap_restart]`. It does not close on back input. `[bootstrap_restart]` and a close without a button start a restart. When it cannot be opened, it is handled as a fatal error
- ban body: `[bootstrap_banned]` when the ban end time of `LoginResult` is not 0, `[bootstrap_banned_permanent]` when it is 0. `FormatArgs` are `public_code`(the public code of `LoginResult` in two groups of 4 characters joined with `-`, and the empty string for an empty public code, `set_string`), `until_at`(ban end time, `set_int`), `url`(deletion page address, `set_string`)
- `[bootstrap_banned_deletion]`: waits for `AuthCore.issue_deletion_code`, then opens the deletion code popup. The deletion code popup is a `UICore` system popup. On success the body is `[bootstrap_banned_deletion_code]` and `FormatArgs` are `public_code`, `code`(`set_string`), `expires_at`(`set_int`), `url`(the received `url`, `set_string`). On failure it is `[bootstrap_banned_deletion_failed]`. Buttons, back input, close and failure to open are the same as the login failure popup for a result other than `Banned`. When it receives a restart request, fatal report, exit request or `shutdown` while waiting for `issue_deletion_code`, it discards that result and does not open the deletion code popup

### content entry

- In `content_init`, content code registers hooks of core modules and makes the state that content uses. `content_init` ends without waiting
- `content_release` deletes the state that content made and removes its event subscriptions
- Because the `release` of a core module deletes the hooks registered to that module, `content_init` after a restart registers the hooks again

### fatal error

- report path: `report_fatal` for content code, `EventCore.FatalErrorRequestedEvent` for other core modules, the fatal of the boot order table for failures inside `BootstrapCore`
- processing order
  1. Leave the reporting module and the reason in an error log
  2. Set the boot order to `Halted` and release the `boot` block
  3. When UI ready, open the fatal popup. Otherwise show the fatal screen
- fatal popup: a `UICore` system popup. Body `[bootstrap_fatal_error]`, one button `[bootstrap_restart]`. It does not close on back input. The button and a close without a button start a restart. When one of the fatal popup, login failure popup or deletion code popup is open or being opened, it does not open the fatal popup. When it cannot open it, it leaves an error log and shows the fatal screen
- fatal screen: drawn with the engine's default means, without data, translation or game resources, above every screen except the debug layer. While `UICore` is `init`ed, it is drawn on the `Fatal` UI layer of `UICore`. The text is `The game could not start. Close the app and open it again.`. It has no buttons or input handling and does not start a restart. It is shown only once per boot

### restart

- report path: `request_restart` for content code, `EventCore.RestartRequestedEvent` for other core modules
- On receipt, it sets the boot order to `Halted`. It does the steps below in order, without waiting, in the next frame after the reporting call returns
  1. `InputBlockCore.release_all`
  2. `UICore.close_all_popups`
  3. `MessageCore.close_all`
  4. reverse release: `content_release` of the content entry, `release` in reverse order of the module list
  5. Remove the fatal screen
  6. Boot from `InitModules` with the same content entry and module list. Do not open the boot entry scene again
- Restart requests and fatal reports received after a restart is received, until the new boot starts `InitModules`, are ignored

### app exit

- exit request: an app exit request of the OS (closing the desktop window, a termination signal) and `UICore.ExitConfirmedEvent`
- On an exit request, it does these in order in the same frame: set the boot order to `Halted` and discard a restart scheduled for the next frame → emit `AppQuitEvent` → `LogCore.notify_app_state(quit)` → `LocalDataCore.flush` → reverse release. For `ExitConfirmedEvent`, it then requests process termination from the engine
- Exit requests, restart requests and fatal reports after the reverse release ends are ignored
- When it receives an exit request before `start_boot`, it ends without `init` of any module

## hook

Received through the content entry. There is no registration operation.

| hook | when | input | output | default |
|---|---|---|---|---|
| `content_init` | `ContentInit` | none | success flag | none. The content entry must have it |
| `content_release` | Start of reverse release. Called only when the current boot called `content_init` | none | none | does nothing |
| `select_first_scene` | `FirstScene` | none | scene key | game settings `firstScene` |

## event

none. `BootCompletedEvent` and `AppQuitEvent` that `BootstrapCore` emits and `RestartRequestedEvent` and `FatalErrorRequestedEvent` that it subscribes to are boot events of `EventCore`. It subscribes to `UICore.ExitConfirmedEvent`.

## error

| condition | failure value | log |
|---|---|---|
| `content_release` hook throws | continues the reverse release | error |
| fatal of the boot order table | fatal | error. module name |
| build info file has a wrong format, STG·PROD build cannot read the build info file | fatal screen | error |
| `Prepare` stage operation fails | next operation | error. module name |
| `check_update` is `false` | goes to `ContentInit` | error |
| `content_init` returns `false` or throws | goes to `ContentInit` 2 | error |
| `select_first_scene` throws or returns an empty string | goes to game settings `firstScene` | error |
| adapter value exists but the adapter cannot be passed | goes on without the adapter | error. adapter key and value |
| `start_boot` called again without `shutdown` | ignored | error |
| `start_boot` of a build without DEV code receives `BootTestReplacements` | boots without test replacements | error |
| fatal popup cannot be opened | fatal screen | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `titleScene` | string | game | none | scene key of the title scene |
| `firstScene` | string | game | none | scene key of the `select_first_scene` default |
| `environments.<ENV>.adapters` | object | game | none | adapter key and adapter name per environment. The build info `adapters` of a dev run uses only the keys |
| `environments.<ENV>.adUnits` | object | game | none | per environment, the AdMob ad unit ID of each platform for each placement ID name. Becomes build info `ad_units` |
| `BootstrapCore.realtimeRelayOnly` | boolean | core | content | whether the P2P transport outside a dev run is made relay-only |

## data

reserved string

| name | used by |
|---|---|
| `[bootstrap_fatal_error]` | fatal popup body |
| `[bootstrap_login_failed]` | login failure popup body for results other than `Banned` and `AgeBlocked` |
| `[bootstrap_banned]` | `Banned` login failure popup body with a ban end time |
| `[bootstrap_banned_permanent]` | `Banned` login failure popup body with ban end time 0 |
| `[bootstrap_banned_deletion]` | button of the `Banned` login failure popup that gets a deletion code |
| `[bootstrap_banned_deletion_code]` | success body of the deletion code popup |
| `[bootstrap_banned_deletion_failed]` | failure body of the deletion code popup |
| `[bootstrap_age_blocked]` | `AgeBlocked` login failure popup body |
| `[bootstrap_restart]` | button of the fatal popup, login failure popup and deletion code popup |
| `[app_name]` | app display name. The harness tool uses it as the window title and as the app name shown in the OS and the store. Core does not show this text on screen while running |

format argument

| text | arguments |
|---|---|
| `[bootstrap_banned]` | `{public_code}`(`string`), `{until_at}`(`integer`), `{url}`(`string`) |
| `[bootstrap_banned_permanent]` | `{public_code}`(`string`), `{url}`(`string`) |
| `[bootstrap_banned_deletion_code]` | `{public_code}`(`string`), `{code}`(`string`), `{expires_at}`(`integer`), `{url}`(`string`) |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_launch_value` | launch value name | value. Empty string when there is none | empty string | `QACore`, DEV code |
| `shutdown` | none | none | none | test, `UnitTestCore` |
| `is_update_reboot` | none | whether the boot of the current `boot_stage` is an update reboot | `false` | test |

- launch value: a value that the runner passes when it starts the client of a dev run. How it is passed is in the engine-specific implementation rules

  | launch value | meaning |
  |---|---|
  | `OGW_SERVER_URL` | base URL of the instance server |
  | `OGW_INSTANCE_ID` | instance ID. Written with `[a-z0-9_-]` |
  | `OGW_AUTOMATION_PORT` | loopback port on which the runner listens for the `QACore` automation channel. `QACore` connects to this port |
  | `OGW_AUTOMATION_TOKEN` | automation channel token that the runner makes per run |
  | `OGW_DEV_ACCOUNT` | dev account name that the dev login of the boot uses |
  | `OGW_DEV_ACCESS` | value that the runner gave the instance server as key `devAccess` of server start argument `--secret-file` |
  | `OGW_PLATFORM` | platform that the dev run emulates. One of the `platform` values of `BuildInfo`. When it is an empty string, it emulates none |

- build info of a dev run: `app_id`, `app_version`, `game_update_url` are empty strings, `update_trust_keys` and `ad_units` are empty lists, `environment` is `LOCAL`, `platform` is `OGW_PLATFORM` when it is not an empty string and otherwise the platform of the running OS, `server_url` is the server URL of the kept `BootTestReplacements` when there is one and otherwise `OGW_SERVER_URL`, `instance_id` is `OGW_INSTANCE_ID` and `OGW_DEV_ACCOUNT` joined with `.` when neither is an empty string and otherwise `OGW_INSTANCE_ID`, and `adapters` is `fake` for each adapter key present in at least one of DEV, STG, PROD of game settings. It is fatal when `server_url` is empty, `OGW_PLATFORM` is neither an empty string nor a `platform` value of `BuildInfo`, `OGW_INSTANCE_ID` has a character outside `[a-z0-9_-]`, or `OGW_DEV_ACCOUNT` has a character outside `[a-z0-9_]`
- DEV registration list call: after `build_derived_containers` of `ContentInit`, it calls the DEV registration list of `QACore` in order. In a boot where `QACore` is not `init`ed (e.g. a test boot that did not put `QACore` in the module list), it does not call it
- dev login: when `OGW_DEV_ACCOUNT` is not an empty string, step 2 of `Login` waits for `AuthCore.dev_login`(that name) instead of `AuthCore.boot_login`. Result handling is the same as for `boot_login`
- `BootTestReplacements`: the set of test replacements that a test passes to `start_boot`. The fields are test clock, `NetworkTransport`, log listener, realtime transport, server URL and update downloads, and each field can be none. Update downloads are the three lists that `ApplyUpdate` uses instead of the downloaded data, translation and bundles of `GameUpdateCore`. `BootstrapCore` keeps the received value until `shutdown`
- passing test replacements: when there are kept `BootTestReplacements`, `InitModules` 2 of every boot (restart and update reboot included) calls, together with the adapters, `TimeCore.set_test_clock`(test clock), `LogCore.set_test_clock`(test clock), `NetworkCore.set_transport`(`NetworkTransport`), `LogCore.set_log_listener`(log listener). It does not call the operation of a field that is none
- passing DEV token storage: when `AuthCore` is in the module list, `InitModules` 2 calls `AuthCore.use_dev_token_storage` right after `AuthCore.set_storage_scope`
- value for `RealtimeCore.set_transport` in `InitModules` 2: when `BootTestReplacements` has a realtime transport, it passes that without wrapping it. Otherwise, a dev run passes the P2P transport wrapped in a network simulation transport that is again wrapped in a lockstep transport, a DEV build with a build info file passes the P2P transport wrapped in a lockstep transport, and an STG·PROD build passes the P2P transport
- touch emulation: when the build info `platform` of a dev run is `android` or `ios` and `VirtualPadCore` is in the module list, it calls `VirtualPadCore.set_test_touch_support`(`true`) after `InitModules` 3
- adding `QACore`: in a run that contains DEV code (dev run and DEV build), `start_boot` called without `BootTestReplacements` adds `QACore` at the end of the received module list (the generated module list when omitted) when `QACore` is not in it. Restart and update reboot also use the module list with it added. `QACore` is `init`ed in `InitModules` 3 like other modules and `release`d by reverse release. `start_boot` given `BootTestReplacements` does not add it. A test of that kind that needs `QACore` puts it in the module list directly
- passing dev access: after `InitModules` 5, it passes to `NetworkCore.set_dev_access` the `dev_access` of the build info file in a DEV build with that file, or launch value `OGW_DEV_ACCESS` in a dev run
- `shutdown`: returns the boot and all modules to their initial state between tests. It does these in order in the same frame
  1. Set the boot order to `Halted` and discard the remaining stages and a restart scheduled for the next frame
  2. When the current boot called `content_init`, call `content_release` of the content entry
  3. `release` every core module with a lifecycle except `UnitTestCore`, in the reverse of the order rule of the module list. A module that is not `init`ed stays as it is, without a log
  4. Remove the fatal screen
  5. Clear the update set, the read build info and the kept `BootTestReplacements`, and set `boot_stage` to `None`
- `shutdown` does not do `AppQuitEvent`, `LogCore.notify_app_state(quit)`, `LocalDataCore.flush` or the process termination request. The boot from before `shutdown` does not go to the next stage even when an operation it was waiting for ends. A `start_boot` call after `shutdown` is the same as the first call
- An STG·PROD build has no `get_launch_value`, `shutdown`, launch value reading, fake adapter, adding `QACore`, passing DEV token storage, DEV registration list call, `BootTestReplacements`, network simulation transport, lockstep transport, touch emulation or passing dev access

## test

- When the `push-apns` value of build info `adapters` is `push-apns` or `push-apns-sandbox`, the APNs adapter is passed to `PushCore` on `ios`, and when the `push-fcm` value is `push-fcm`, the FCM adapter is passed on `android`
- Calling `start_boot` with the test module list reaches `Done`, `current_scene_key` is the scene key of `select_first_scene`, there is no active block, and there is no unchecked error log
- The operations of the boot order table are called once each, per stage, in the table order, and operations of modules not in the module list are not called
- Passing adapters comes before the `init` of every module, and module `init` is called in module list order, `release` of reverse release in reverse order, and `content_release` before module `release`
- During `Prepare`, `ApplyUpdate`, `ContentInit`, `AfterLogin` there is a block with reason tag `boot`, and during `TitleScene`, `Update`, `Login`, `FirstScene` there is none
- When `content_init` is called, data and translation loading has ended and it is before `AuthCore.boot_login`. When `NoticeCore` is in the module list, `boot_login` is called after `wait_maintenance_clear` returns. `build_derived_containers` is called after `content_init`
- Before a `Prepare` stage operation ends, the next operation and `TitleScene` do not start, and on `false` the next operation is called after an error log. `FirstScene` starts even when `AfterLogin` operations have not ended
- In a boot where `PaymentCore` is in the module list and there is no store adapter chosen by build info, there is no error log of `PaymentCore` until `Done`
- When `AdCore` is in the module list, the ad unit list that `set_ads_adapter` receives is build info `ad_units`
- With no received file, there is no update reboot. When any of downloaded data, translation or bundle exists, there is one update reboot, and in that boot `apply_bundles`, `DataCore.load`, `load_translation` are called with the update set and `check_update` is not called
- A restart after an update reboot makes the new boot apply the same update set and call `check_update`, and when the received files are the same there is no update reboot
- When `check_update` is `false`, `ContentInit` is called without `ApplyUpdate`
- When `boot_login` is not `Success`, there is no `AfterLogin` or `FirstScene`, `boot_stage` is `Halted`, and one login failure popup opens. For `AgeBlocked` the body is `[bootstrap_age_blocked]`. Pressing `[bootstrap_restart]` starts a restart
- For `Banned`, the body is `[bootstrap_banned]` when there is a ban end time and `[bootstrap_banned_permanent]` when it is 0, `public_code`, `until_at`, `url` of `FormatArgs` are the values of `LoginResult`, and the buttons are `[bootstrap_banned_deletion]`, `[bootstrap_restart]`. Pressing `[bootstrap_banned_deletion]` calls `AuthCore.issue_deletion_code` once; on success the `[bootstrap_banned_deletion_code]` popup holding `code`, `expires_at`, `url` opens, on failure the `[bootstrap_banned_deletion_failed]` popup opens, and `[bootstrap_restart]` of that popup starts a restart. When a restart is reported while waiting for `issue_deletion_code`, the deletion code popup does not open even when that result returns, and when a fatal is reported, only one fatal popup opens
- Without `select_first_scene`, it goes to game settings `firstScene`
- `get_first_scene` returns game settings `firstScene`
- For each fatal condition of the error table, there is no next stage and an error log is left
- The error log of an adapter that could not be passed is in the log file of `LogCore`. When an STG·PROD build cannot read build info, that error log is in the `LogCore` log file directly under app storage and the fatal screen is shown. A build info file without `ad_units` or with `environment` outside the values of the `BuildInfo` table also shows the fatal screen, and a build info file with extra unknown keys reaches `Done` without fatal
- When `change_scene` of `FirstScene` is `false` because of a transition that the content code of the title scene started, one fatal popup opens
- On a fatal after UI ready, there is no `boot` block, one fatal popup opens with one button, and pressing it starts a restart. Reporting again while it is open leaves the popup count unchanged
- On a fatal before UI ready (`LoadData` failure), no `UICore` popup is opened, the fatal screen is shown once, and there is no restart
- `FatalErrorRequestedEvent` and `RestartRequestedEvent` emitted by another module are handled the same as `report_fatal` and `request_restart`, and `ExitConfirmedEvent` starts app exit. The same holds in the boot after a restart and after an update reboot, with one handling per event
- Reporting a restart several times in one frame gives one reverse release. Reverse release does not start before the reporting call returns
- When an exit request comes in the frame in which a restart was reported, there is one reverse release, and after it there is no module `init` and no `InitModules` stage
- Calling `report_fatal` or `request_restart` inside `content_init` leaves no `build_derived_containers` and no DEV registration list call in that boot. When a module `init` in `InitModules` 3 emits `FatalErrorRequestedEvent`, that boot has no `init` of later modules and no `InitModules` 4 to 8. When an operation of `AfterLogin` reports a fatal, that boot has no later operations
- A restart while waiting in `Login` leaves no `AfterLogin` of the halted boot, and the new boot goes from `InitModules`. When the new boot finishes `TitleScene`, there are no open popups or messages. Even when `boot_login` of the halted boot later returns a result other than `Success`, there is no login failure popup, no fatal, and no error log or stage info log of that boot
- A restart while an `Interaction` request of `NetworkCore`, a popup open flow or a black box message holds a block leaves no unchecked error log through the restart up to `Done` of the new boot
- After a restart, `content_init` is called again, and a hook registered before the restart is registered only once
- On the update reboot of `ApplyUpdate`, a restart or app exit during `TitleScene` or `Update`, and a `shutdown` before `ContentInit`, `content_release` is not called and the reverse-order module `release` is called. In the boot after an update reboot or a restart, `content_init` is called once
- Requesting app exit during the `Login` wait, during the `TitleScene` transition, and after `Done` each gives `AppQuitEvent`, `notify_app_state(quit)`, `flush` and reverse release once each, and no engine object remains after exit. `ExitConfirmedEvent` is the same, with one process termination request
- `shutdown` while waiting in `Login` and after `Done` each gives `content_release` once, the init check of every module with a lifecycle other than `UnitTestCore` is `false`, `boot_stage` is `None`, and there is no `AppQuitEvent`, `notify_app_state(quit)`, `flush` or process termination request. The halted boot does not go to the next stage even when an operation it was waiting for ends. After that, a `start_boot` call with the test module list reaches `Done` without an error log
- A module that a test `init`ed without a `start_boot` call is in its state before `init` after `shutdown`, and `content_release` is not called
- `shutdown` after an update reboot and booting again leaves the update set empty, so `apply_bundles` is not called and build info is read again
- In a dev run, `get_build_info` returns the server URL and instance ID of the launch values, `LOCAL`, and `fake` for each adapter key present in at least one environment of game settings, and the value for `set_storage_scope` ends with the instance ID
- In a dev run, when `OGW_INSTANCE_ID` is `i1` and `OGW_DEV_ACCOUNT` is an empty string, the log file of `LogCore` and `local_data/device.dat` of `LocalDataCore` are created under `instances/i1/` of app storage. When `OGW_DEV_ACCOUNT` is `opponent_1`, they are created under `instances/i1.opponent_1/` and `instance_id` of `get_build_info` is `i1.opponent_1`. When `OGW_INSTANCE_ID` is an empty string, they are created directly under app storage. When `OGW_INSTANCE_ID` is `I1`, it is fatal, that error log is in the `LogCore` log file directly under app storage, and no file is created under `instances/` of app storage
- When `OGW_DEV_ACCOUNT` is set, `dev_login` is called and `boot_login` is not called
- `start_boot` called without `OGW_SERVER_URL` and with `BootTestReplacements` holding a server URL reaches `Done` without fatal, and `server_url` of `get_build_info` is that server URL. When both `OGW_SERVER_URL` and that server URL are missing, it is fatal
- In `start_boot` given `BootTestReplacements`, for the first boot, the boot after a restart and the boot after an update reboot, `InitModules` 2 calls `TimeCore.set_test_clock`, `LogCore.set_test_clock`, `NetworkCore.set_transport`, `set_log_listener` with those values before module `init`, and when there is a realtime transport, `RealtimeCore.set_transport` receives it. `start_boot` called without `BootTestReplacements` after `shutdown` does not call the four operations
- When `RealtimeCore` is in the module list, `set_transport` of a dev run receives a lockstep transport wrapping a network simulation transport, and a DEV build with a build info file receives a lockstep transport wrapping the P2P transport
- When `BootstrapCore.realtimeRelayOnly` is `true`, the P2P transport of a build with a build info file is relay-only, and the P2P transport of a dev run is not relay-only
- In a dev run, when `OGW_PLATFORM` is `ios`, `platform` of `get_build_info` is `ios`, and when `VirtualPadCore` is in the module list, `set_test_touch_support`(`true`) is called once. When `OGW_PLATFORM` is `IOS`, it is fatal
- In a dev run, when `OGW_PLATFORM` is `android`, after `InputCore` does `init`, `get_device` is `Touch` and `ResolutionCore.get_fill_mode` is the value of the `android` rule
- In a dev run outside a browser, when `OGW_PLATFORM` is `web` and `OGW_DEV_ACCOUNT` is an empty string, `platform` of `get_build_info` is `web`, `boot_login` is `Success` through new account login and login token save, and `boot_stage` becomes `Done`
- When `PushCore` is in the module list, a build whose build info `platform` is `android` or `ios` passes the notification adapter of that platform with `set_notification_adapter`, a dev run passes the fake notification adapter, and a build of any other platform passes none
- In a dev run, the value of launch value `OGW_DEV_ACCESS` is passed to `NetworkCore.set_dev_access`, so `X-Ogw-Dev-Access` of a cheat command request of `QACore` is that value
- An STG·PROD build has no `get_launch_value`, fake adapter or DEV registration list call
- In a run that contains DEV code, `start_boot` called without `BootTestReplacements` with a module list without `QACore` does `init` of `QACore` as the last of the module list. `start_boot` given `BootTestReplacements` does not `init` `QACore`
