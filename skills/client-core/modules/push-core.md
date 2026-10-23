# PushCore

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

Handles notification permission, server registration of the push device token, local push scheduling, delivery of received remote pushes, and lookup and change of ad push consent.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `LocalizationCore`, `DataCore`, `NetworkCore`, `AuthCore`

- server dependency: `push`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_push_adapter` | push adapter or none. Called before `init` | none | none | `BootstrapCore`(`InitModules`) |
| `set_notification_adapter` | notification adapter or none. Called before `init` | none | none | `BootstrapCore`(`InitModules`) |
| `get_permission` | none | `PermissionStatus` | `Undetermined` | core, content code |
| `request_permission` | none | async operation. `PermissionStatus` | `Undetermined` | content code |
| `schedule_local` | ID value of `local_push` | success flag | `false` | content code |
| `schedule_local_after` | ID value of `local_push`, delay ms | success flag | `false` | content code |
| `cancel_local` | ID value of `local_push` | none | none | content code |
| `cancel_all_local` | none | none | none | core, content code |
| `take_launch_push` | none | message ID value of the remote push that opened the app. `0` when there is none | `0` | content code |
| `get_push_consent` | none | `PushConsentInfo` | `PushConsentInfo` with both values `CONSENT_CHOICE_UNSPECIFIED` | content code |
| `set_push_consent` | `push_ad`, `push_night`(`ConsentChoice`) | async operation. success flag | `false` | content code |

### type

| type | contents |
|---|---|
| `PermissionStatus` | `Undetermined`, `Granted`, `Denied`, `Unsupported`. A state the OS blocked is `Denied`. `Unsupported` when there is no notification adapter |
| message ID value | message ID value of the push payload that the server core `push` module sent. `0` when the payload has none |
| `PushConsentInfo` | `push_ad`, `push_night`. Values of base proto enum `ConsentChoice` |

## behavior

### permission

- PushCore caches the notification permission state. At `init` and at `TimeCore.AppForegroundReturnedEvent`, it reads the state again with `read_permission` of the notification adapter. Before the first read ends, the value is `Undetermined`. When there is no notification adapter, the cache is `Unsupported`
- `get_permission` returns the cache. It does not read from the OS again
- When the platform is `web`, PushCore does not call the notification adapter even when it received one, and the permission cache is always `Unsupported`. So web has no local push scheduling, and with no push adapter it also receives no remote push
- `request_permission` reads again with `read_permission`, and when the value is `Undetermined`, shows the OS permission request screen with `request_permission` of the notification adapter, then caches and returns that result. Otherwise it returns the read value without a screen. `Unsupported` when there is no notification adapter
- Content code decides when to request permission

### device token registration

- On each `AuthCore.LoginCompletedEvent`, PushCore gets the device token with `get_device_token` of the push adapter and sends core `rpc` `RegisterPushToken`(device token, `LocalizationCore.get_language_code`, device timezone offset) with `NetworkCore.send`. The device timezone offset is the UTC offset in ms of the device time zone at the time of sending, and its sign and range are those of `timezone_offset_ms` in server `push`
- When the push adapter reports a device token change while there is a session, PushCore registers again
- When the device token is empty, PushCore does not register. The adapter of a platform without remote push returns an empty value
- When registration fails, PushCore registers again at the next `LoginCompletedEvent` or the next token change. The failure callback returns `true`
- PushCore sends no unregistration. The server unregisters at logout, account switch and withdrawal

### ad push consent

- An ad push is a push whose `kind` in server `push` is `Ad`. Ad push consent is the consent to receive ad pushes (`push_ad`) and to receive them also at night (`push_night`)
- The consent state is `ConsentUserState` in server `auth`. `get_push_consent` returns `push_ad`, `push_night` from `AuthCore.get_consent`
- `set_push_consent` calls `AuthCore.update_push_consent` and returns its result. `AuthCore` tells the result
- Content code provides the screen that changes the consent

### local push

- A local push is scheduled with one row of the `local_push` table
- `schedule_local` notifies after the row's `delay`. For a row whose `delay` is null, error log and `false`
- `schedule_local_after` notifies after the passed delay ms. For a row whose `delay` is not null, or a delay of 0 or less, error log and `false`. To notify at a time based on server time, the caller passes `TimeCore.get_remaining_ms`
- At scheduling, PushCore makes the title and body as text of the current language with `LocalizationCore.get_text`
- Scheduling and cancellation use `schedule_local`, `cancel_local`, `cancel_all_local` of the notification adapter
- Scheduling the same row again replaces the earlier schedule
- Even after passing the checks above, when the permission cache is not `Granted`, PushCore does not schedule with the OS and returns `false` without a log
- When `schedule_local` of the notification adapter returns `false`, PushCore leaves an error log and returns `false`
- Schedules remain after `release` and app exit. Only `cancel_local` and `cancel_all_local` delete them
- When `AuthCore.SessionEndedEvent` is `Logout`, `Switch`, `Withdraw` or `AgeBlocked`, PushCore runs `cancel_all_local`

### remote push receive

- A remote push received while the app is running is reported with `PushReceivedEvent`
- When the user taps a notification while the app is running and comes to the app, PushCore reports it with `PushOpenedEvent`
- When the app started from a notification tap, `take_launch_push` returns that message ID value once per process. Later calls are `0`, also after restart and update reboot. PushCore gets this value from the push adapter at `take_launch_push` and does not keep it

### push adapter

The push adapter wraps the OS push service and receives the device token and remote pushes. Code outside PushCore does not call the push adapter.

| adapter operation | input | output |
|---|---|---|
| `get_device_token` | none | async operation. device token. Empty value when not received |
| `take_launch_push` | none | message ID value of the remote push whose notification tap started the app. `0` when there is none |

- Notifications the push adapter emits: device token changed (new device token), remote push received (message ID value), notification opened (message ID value). Received is a remote push received while the app is running, and opened is the user tapping a notification while the app is running and coming to the app
- When `get_device_token` does not end within `PushCore.deviceTokenTimeoutMs`, PushCore treats the token as an empty value
- The adapter key is `push-fcm` for platform `android` and `push-apns` for `ios`. Other platforms have no push adapter
- When the value of that key in build info `adapters` is `fake`, it is the fake push adapter; `push-fcm`, the FCM adapter; `push-apns` or `push-apns-sandbox`, the APNs adapter. The `aps-environment` entitlement the build adds decides production or sandbox for APNs
- When there is no push adapter, the device token is an empty value and no remote push is received
- The push adapter gives the message ID value of the remote push whose notification tap started the app only once, at the first request in the process, and gives `0` after that and when there is no such push. This state lives in the process, not in the adapter object, so it carries over across `release` and a new adapter
- fake push adapter
  - The device token is `fake:<install ID>` when the platform is `android` or `ios`, and an empty value on other platforms, because server `push` does not accept registration from other platforms. The install ID is a UUID v4 made at first use and kept in the `LocalDataCore` `device` file
  - For the launch push, it gives the value set with `set_fake_launch_push`, following the launch push rule of the push adapter

### notification adapter

The notification adapter wraps the platform's OS notification API and handles notification permission and local push. It does not use the OS push service, so it works independently of the push adapter. It has no adapter key in game settings. Code outside PushCore does not call the notification adapter.

| adapter operation | input | output |
|---|---|---|
| `read_permission` | none | async operation. `PermissionStatus` |
| `request_permission` | none | async operation. `PermissionStatus` resulting from the OS permission request screen |
| `schedule_local` | ID value of `local_push`, title, body, delay ms | success flag |
| `cancel_local` | ID value of `local_push` | none |
| `cancel_all_local` | none | none |

- The notification adapter exists on platforms `android` and `ios`. `BootstrapCore` chooses it with build info `platform` and passes it with `set_notification_adapter`
- When there is no notification adapter, the permission is `Unsupported` and no local push is scheduled
- fake notification adapter
  - Returns `Granted` without a permission request screen. `set_fake_permission` changes that value
  - Does not schedule with the OS and keeps only a schedule list
  - `schedule_local` returns the value of `set_fake_schedule_result` (default `true`). When the value is `false`, the schedule list does not change

### release

- Deletes the permission cache, the event subscriptions, and the push adapter and notification adapter it was given. It does not delete the OS local push schedules or a launch push not yet taken

### real adapter

| adapter key | real adapter |
|---|---|
| `push-fcm` | `push-fcm` |
| `push-apns` | `push-apns` |

## hook

none

## event

| event | when | payload |
|---|---|---|
| `PushReceivedEvent` | When a remote push is received while the app is running | message ID value |
| `PushOpenedEvent` | When the user taps a notification while the app is running and comes to the app | message ID value |

## error

| condition | failure value | log |
|---|---|---|
| ID value not in `local_push` | `false` | error |
| Row `delay` is null in `schedule_local` | `false` | error |
| Row `delay` is not null in `schedule_local_after`, delay of 0 or less | `false` | error |
| Scheduling when the permission is not `Granted` | `false`. Not scheduled with the OS | none |
| `schedule_local` of the notification adapter returns `false` | `false` | error |
| `RegisterPushToken` failure | registered again at the next login or token change | `NetworkCore` writes it |
| `set_push_adapter`, `set_notification_adapter` after `init` | ignored | error |
| `AuthCore.get_consent` failure in `get_push_consent`, `AuthCore.update_push_consent` failure in `set_push_consent` | failure value | `AuthCore` writes it |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `PushCore.deviceTokenTimeoutMs` | integer | core | content | time limit of push adapter `get_device_token` |
| `PushCore.permissionReadTimeoutMs` | integer | core | content | time limit of a notification permission read. When exceeded, that read ends with `Undetermined`. A permission request that waits for the user has no time limit. 1 or more |

## data

`data/tables/local_push.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `title` | `tstring<id>` | `Client` |
| `body` | `tstring<id>` | `Client` |
| `delay` | `duration?` | `Client` |

- `delay` is null or 1 or more. A violation is data check `out_of_range`
- `local_push` rows do not hold content meant for an ad push. Ad pushes are sent only through server `push`

format argument

| text | arguments |
|---|---|
| `local_push.title` | none |
| `local_push.body` | none |

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `PushCore.install_id` | `string` | install ID of the fake push adapter |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_fake_permission` | `PermissionStatus` | none | none | core test, `QACore` |
| `set_fake_schedule_result` | success flag | none. Sets the value that `schedule_local` of the fake notification adapter returns | none | core test |
| `list_scheduled_local` | caller buffer | number filled. ID value and remaining ms per schedule | `0` | core test |
| `simulate_push` | message ID value, whether it was opened by a tap | none | none | core test, `QACore` |
| `set_fake_launch_push` | message ID value | none. Sets the launch push the fake push adapter gives next | none | core test |

- `simulate_push` emits the same `PushReceivedEvent` or `PushOpenedEvent` as when the fake push adapter receives a remote push

## test

- After `init` and before the first read, `get_permission` is `Undetermined`. After the OS permission changes, it is the previous value before the return to foreground and the changed value after it
- When the permission is not `Undetermined`, `request_permission` returns the read value without a screen
- Each `LoginCompletedEvent` sends `RegisterPushToken` once with the current language code and device timezone offset. A token change notification sends it again, and there is no request for an empty token or when there is no push adapter
- With only a notification adapter and no push adapter, `request_permission` gives the notification adapter's result, a `schedule_local` that passes the checks schedules, and there is no `RegisterPushToken`
- When there is no notification adapter, `get_permission` and `request_permission` are `Unsupported`, and a `schedule_local` that passes the checks is `false` without a log
- On the test clock, when `get_device_token` of the push adapter does not end within `PushCore.deviceTokenTimeoutMs`, there is no `RegisterPushToken`
- Scheduling the same row twice leaves one schedule that follows the later delay
- For each of `schedule_local` of a row with null `delay`, `schedule_local_after` of a row with non-null delay, a delay of 0 or less, and an ID value that does not exist, there is no schedule and one error log
- When the permission is not `Granted`, a schedule that passes the checks does not reach the OS and there is no log
- After `set_fake_schedule_result`(`false`), a `schedule_local` and a `schedule_local_after` that pass the checks each give `false` and one error log, and `list_scheduled_local` does not fill that row
- When the platform is `web`, even with a fake notification adapter given, `get_permission` and `request_permission` are `Unsupported` without a permission request screen, and a `schedule_local` that passes the checks does not schedule with the OS
- The scheduled title and body are text of the language at scheduling time
- `release` does not delete OS schedules. Each `SessionEndedEvent` with `Logout`, `Switch`, `Withdraw`, `AgeBlocked` gives one `cancel_all_local`, and `Rejected` gives none
- After `set_fake_launch_push`, even across `release` and `init`, `take_launch_push` returns that message ID value once, and the next call and a call after another `release` and `init` are `0`
- `simulate_push` emits the event, and STG·PROD builds have no DEV operation, fake push adapter or fake notification adapter
- `get_push_consent` gives the two values of `AuthCore.get_consent`, and `set_push_consent` calls `AuthCore.update_push_consent` once and returns its result
- PushCore gets the push token and receives remote notifications through the APNs adapter and FCM adapter it was given
