# push

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

Takes device token registration, picks the targets of the remote pushes that handlers and operators schedule, sends them through the OS push service adapter, and keeps send records. Sends an ad push only to devices with receive consent (ad push consent), and at night does not send it to devices without night receive consent but defers it.

## dependency

- `session`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `RegisterPushToken` (core rpc, `silent`, `retry`, `sensitive`). changes: none | `device_token`, `language`, `timezone_offset_ms` | empty response | `INVALID_REQUEST` | `routing`. Client `PushCore` sends it |
| `queue_push` | ctx, target user ID, message ID value, `args`, `send_at`, `dedupe_key` | push ID | 0 | content handler, hook, core module |
| `cancel_push` | ctx, target user ID, `dedupe_key` | none | none | content handler, core module |
| `refresh_push_consent` | ctx | none | none | `auth`(`UpdatePushConsent`) |
| `remove_user` | ctx | none | none | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age, job `auth_guest_sweep`) |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `schedule_push` | `operation_id`, `message_id`, `args`, `send_at`, `target` | `push_id` | `bad_request`, `conflict` | operator |
| `cancel_scheduled_push` | `push_id` | empty object | `not_found`, `conflict` | operator |
| `get_push` | `push_id` | push record | `not_found` | operator |
| `list_pushes` | `from_at`, `to_at`, `limit` | `pushes`: list of push records. Ascending order of `send_at` | `bad_request` | operator |

- `args`: list of `PushArg`. Fills the format arguments of the message text. A `PushArg` is a `name` and one value. The value is an integer or a string. The `args` field type of `schedule_push` is `array<object{name: string, value: object union{int_value: int64, text_value: string}}>`
- TypeScript form that content code calls: `queue_push(ctx, user_id, message_id, args, send_at, dedupe_key)`, with `args` being `PushArg[]`. A `PushArg` is `{ name: string; int_value: bigint }` for an integer and `{ name: string; text_value: string }` for a string
- `timezone_offset_ms`: the UTC offset in ms of the device's time zone. A time zone ahead of UTC is positive
- `dedupe_key`: an empty string, or a string of at most `push.maxDedupeKeyBytes`
- `target`: `{"user_ids": [...]}` or `{"filter": {"platforms": [...], "languages": [...], "active_within_ms": n}}`. An empty array and `active_within_ms` 0 mean no condition. A negative `active_within_ms` is `bad_request`
- push record of admin output: the `push_record` columns without `lease_owner` and `expires_at`; `args` and `target` are JSON values
- admin operation field type: `message_id` is `int32`, `push_id` is `int64`, `target` is `object union{user_ids: array<int64>, filter: object{platforms: array<string>, languages: array<string>, active_within_ms: int64}}`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `RegisterPushTokenRequest` | `device_token` | `string` | `max_len_key`: `push.maxDeviceTokenBytes` |
| `RegisterPushTokenRequest` | `language` | `string` | `max_len`: 35 |
| `RegisterPushTokenRequest` | `timezone_offset_ms` | `int64` | `min`: -86399999, `max`: 86399999 |

## behavior

### device registration

- A device registration row is a `push_device` row. Because it has to change another user's row of the same `device_token`, its scope is not `user`, and it is not in user snapshot clone. There is one per `device_token` and one per user
- When the checks below pass, `RegisterPushToken` deletes that user's rows whose `device_token` differs from the requested value, and inserts or replaces the row with the requested `device_token` key. That row's `user_id` is the requesting user, and `session_id` and the other columns are the values of the current request. The session ID and the platform are `session_id` and `platform` of ctx
  - `provider` is `fcm` when `X-Ogw-Platform` is `android`, and `apns` when it is `ios`. Another platform is `INVALID_REQUEST`
  - When `device_token` is empty, `INVALID_REQUEST`
  - When `language` is not in game settings `supportedLanguages`, `INVALID_REQUEST`
- When another user had the row of the same `device_token`, that row becomes the requesting user's row. Only the new user's pushes go to that device
- `RegisterPushToken` and `refresh_push_consent` write `ad_allowed` (`push_ad` is `GRANTED`) and `night_allowed` (`push_night` is `GRANTED`) of that user's device registration rows from that user's `ConsentUserState`, read with `storage.get_state` in ctx
- When sending, if `session.check_current`(`user_id`, `session_id` of the row) fails, deletes that row and does not send. So after logout, login on another device or withdrawal, nothing goes to that device
- `remove_user` deletes that user's device registration rows in the user transaction of ctx, and changes the `SCHEDULED` records whose only target is that user to `CANCELED`

### schedule

- A push record is a `push_record` row. `target_user_id` is that user ID when `user_ids` of `target` has only one user, otherwise null. A record of `queue_push` has `target` `{"user_ids": [<target user ID>]}`. The `SCHEDULED` record count of a target user, the records of (target user, `dedupe_key`), and, in `remove_user`, the records whose only target is that user are found by `target_user_id`
- `status`: `SCHEDULED`, `SENDING`, `SENT`, `CANCELED`, `EXPIRED`, `FAILED`
- `queue_push` saves the push record in the transaction of ctx and returns its `push_id`. When the transaction is rolled back, the record also does not remain
- `queue_push` checks. On violation, returns 0, leaves an `error` log and does not schedule
  - the message ID value is in `push_message`
  - the name set of `args` equals the format argument name set of `title` and `body` of that row
  - in `title` and `body` of every supported language, the formatter of each argument accepts the value kind of the `PushArg`. The accepted value kinds are in the format table of the data SKILL
  - when an argument of the `compact` formatter is a string, its value is a big integer of the contract
  - request time ≤ `send_at` ≤ request time + `push.maxScheduleAheadMs`
  - `dedupe_key` is `push.maxDedupeKeyBytes` or less
- Among the `queue_push` calls in content code, when a call that picks the message ID value with a `ReservedId` accessor and passes `args` as an array literal violates the name set and value kind checks above, static check `format args` blocks it
- When the target user has `push.maxScheduledPerUser` `SCHEDULED` records, returns 0 and leaves a `warn` log
- When `dedupe_key` is not empty, changes the `SCHEDULED` records of the same (target user, `dedupe_key`) to `CANCELED` and schedules anew
- `cancel_push` changes the `SCHEDULED` records of the same (target user, `dedupe_key`) to `CANCELED` in the transaction of ctx. When `dedupe_key` is an empty string, does nothing
- Before reading the target user's records, `queue_push` and `cancel_push` lock the target user ID of `push_target_lock` with `storage.lock_game_row` in the transaction of ctx. So the scheduled count limit check, the cancel and schedule of `dedupe_key`, and `cancel_push` for the same target user are handled one at a time
- `push_target_lock` is locked after the rows that the caller locks. After calling `queue_push` or `cancel_push`, the caller does not lock other game rows in that transaction. When calling for several target users in one transaction, the caller calls in ascending order of target user ID
- `schedule_push` does the same checks as `queue_push`, and a violation is `bad_request`. The time criterion is `clock_now`. It does not look at `push.maxScheduledPerUser`, and `dedupe_key` is an empty string. The `user_ids` count is 1 or more and `push.maxTargetUserIds` or less
- `cancel_scheduled_push` changes only `SCHEDULED` to `CANCELED`. Another status is `conflict`

### send

- Job `push_send` (interval `push.pollIntervalMs`), which push sets with `server-time.schedule_job` at server start, changes each `SCHEDULED` record with `send_at` ≤ `clock_now` and each `SENDING` record with `lease_until` ≤ `clock_now` to `SENDING`, in one game transaction per record, and takes the lease. Taking the lease writes a new secure random value to `lease_owner` and `clock_now` + `push.leaseMs` to `lease_until`. This write is a conditional update done only when `lease_owner` and `lease_until` are still as they were when the record was picked; when no row changed, the lease was not taken
- Each time a batch ends, writes `cursor_user_id`, the counts and `lease_until` = `clock_now` + `push.leaseMs` in one game transaction, only when `lease_owner` is its own value. When `lease_owner` is not its own value, does not write and stops sending that record. Another server instance continues a record whose lease ended, from `cursor_user_id`
- When `send_at` of a `SCHEDULED` record that job `push_send` picked is < `clock_now` − `push.maxDelayMs`, does not change it to `SENDING` but changes it to `EXPIRED` in the same game transaction, and does not send it. A `SENDING` record continues sending from `cursor_user_id` regardless of `send_at`
- target device: a device registration row of a user who matches `target`. `user_ids` selects those users; `filter` selects by the platform of `provider`, `language`, and `updated_at` ≥ `clock_now` − `active_within_ms`. Handles `push.sendBatchSize` devices at a time in ascending order of user ID and keeps `cursor_user_id`. Within a batch, a group of devices with the same provider and payload is sent concurrently
- `device_count` is the count of handled target devices that passed `session.check_current`
- ad push: for a push whose `push_message` row has `kind` `Ad`, also checks the below per device
  - when `ad_allowed` is `false`, does not send and increases `consent_skipped_count`
  - when the device's local time is within the night window and `night_allowed` is `false`, does not send, writes (push ID, user ID, the time that night window ends) to `push_held` and increases `held_count`
  - the device's local time is `clock_now` + `timezone_offset_ms` of the device registration row. When game settings `pushConsent.nightStartMinute` is less than `pushConsent.nightEndMinute`, the night window is the range where the minute within the local day is `pushConsent.nightStartMinute` or more and less than `pushConsent.nightEndMinute`. When `pushConsent.nightStartMinute` is more than `pushConsent.nightEndMinute`, it crosses midnight and is the range where the minute is `pushConsent.nightStartMinute` or more, or less than `pushConsent.nightEndMinute`
- `expires_at` of `push_held` is `send_at` + `push.maxDelayMs`. Each time job `push_send` runs, for each row with `send_at` ≤ `clock_now`, deletes the row of that key in one game transaction. Only when a row was deleted, after commit, sends that push when that user's device registration row passes `session.check_current` and `ad_allowed` is `true`. When no row was deleted, another server instance took the row, so it does not send. The result is added in one game transaction by an update that adds to the counts of that push record
- text per device: uses the text found with the translation keys of `title` and `body` of the `push_message` row in the translation binary of the registered `language` in `server/build/data/`, read with `GameData.load_translation`, and fills the format arguments with `args`. The formatter results and culture rules are those of format in the data SKILL. The culture rule is looked up by the registered `language`, and the timezone offset of `date` and `datetime` is the registered `timezone_offset_ms`. When the result year of `date` or `datetime` is not from 1 to 9999, leaves that place empty and leaves one `error` log per record. When `kind` is `Ad`, puts before the title the same-language translation of `title` of the `push_message` row that reserved ID `[push_ad_label]` points to, and one space
- payload: `title`, `body`, data `message_id` (ID value as a decimal string), `push_id`
- adapter result
  - `OK`: increases `sent_count`
  - `INVALID_TOKEN`: deletes that device registration row and increases `invalid_count`
  - `FAILED` and exceeding time limit `push.sendTimeoutMs`: waits `push.retryIntervalMs` with `server-time.sleep`, then sends again. After `push.retryMaxAttempts` failures including the first, increases `failed_count`
- When the game transaction that writes a batch result or the game transaction that finishes a record is `FAILED` (lock wait over the limit, PostgreSQL deadlock or serialization failure), writes again after `push.retryIntervalMs`. Leaves one `error` log at the first failure of that write and one when sending stops. This goes up to `push.retryMaxAttempts` attempts including the first, and only while `clock_now` + `push.retryIntervalMs` < `lease_until`. When the write still fails, stops sending that record, the same as when the lease is lost
- When, at send time, `message_id` of the record is not in `push_message` of the server build data (a data update between `queue_push` and sending), does not send, finishes that record as `FAILED` in one game transaction and leaves one `error` log per record. The `push_held` rows of that record are deleted without sending. When the record has already finished (e.g. `SENT`), does not change the status, deletes only the `push_held` rows and leaves one `error` log
- When all target devices are handled, `SENT`. When `device_count` is 1 or more and all of them are in `failed_count`, `FAILED`
- When a record becomes `SENT`, `FAILED`, `CANCELED` or `EXPIRED`, writes `clock_now` to `finished_at` and `finished_at` + `push.recordRetentionMs` to `expires_at`. The expiry cleanup of `storage` deletes that record
- The send log is kept per record. Device tokens, titles and bodies are not logged

### adapter

- Per-environment `adapters.push-fcm` (values `fake`, `push-fcm`) and `adapters.push-apns` (values `fake`, `push-apns-sandbox`, `push-apns`) of game settings. A `RegisterPushToken` whose provider is that of a key whose value is `null` (`fcm` for `push-fcm`, `apns` for `push-apns`) is `INVALID_REQUEST`
- interface: `send(list of device tokens, payload)` → `OK`, `INVALID_TOKEN` or `FAILED` per device. `FAILED` can carry a failure reason (e.g. HTTP status, APNs `reason`, FCM error code, network error), without the device token. push writes that reason to `reason` of the first failure log
- The fake adapter returns `OK` for a token that starts with `fake:` and `INVALID_TOKEN` for other tokens. The fake adapter token of `PushCore` is `fake:<install ID>`
- `push-fcm` calls the FCM HTTP v1 API with the project of game settings `environments.<ENV>.fcm.projectId`. The access token is the value that the token endpoint gives in exchange for an RS256 JWT with `iss` `environments.<ENV>.fcm.serviceAccountEmail`, `scope` `https://www.googleapis.com/auth/firebase.messaging` and `aud` `https://oauth2.googleapis.com/token`, signed with the private key of secret `environments.<ENV>.secrets.pushFcm`
- `push-apns` sends to the APNs production endpoint and `push-apns-sandbox` to the APNs development endpoint, with token authentication. The provider token is an ES256 JWT with header `kid` game settings `pushApns.keyId` and payload `iss` `appleTeamId`, signed with the private key of secret `environments.<ENV>.secrets.pushApns`. `apns-topic` is `appId`

### table

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `push_device` | `game` | `user_id`, `device_token`, `session_id`, `provider`(`fcm`, `apns`), `language`, `timezone_offset_ms`, `ad_allowed`, `night_allowed`, `updated_at` | `device_token` | none | `(user_id)` |
| `push_record` | `game` | `push_id`, `source`(`handler`, `operator`), `message_id`, `args`, `send_at`, `target`, `target_user_id`, `dedupe_key`, `status`, `device_count`, `sent_count`, `invalid_count`, `failed_count`, `consent_skipped_count`, `held_count`, `cursor_user_id`, `lease_owner`, `lease_until`, `created_at`, `finished_at`, `expires_at` | `push_id` | `expires_at` | `(status, send_at)`, `(target_user_id, status)`, `(send_at)` |
| `push_held` | `game` | `push_id`, `user_id`, `send_at`, `expires_at` | `(push_id, user_id)` | `expires_at` | `(send_at)`, `(user_id)` |
| `push_target_lock` | `game` | `user_id` | `user_id` | none | none |

- The four tables are registered with `storage.register_table` without a snapshot flag. The personal data user column of `push_device` is `user_id`. No row is written to `push_target_lock`; it is used only for `lock_game_row` locks
- `args` and `target` of `push_record` are JSON strings written in the field types of `schedule_push`. `finished_at` and `expires_at` are null before the record finishes

### real adapter

| adapter key | real adapter |
|---|---|
| `push-fcm` | `push-fcm` |
| `push-apns` | `push-apns` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `device_id` | push device token | `push-fcm` | `developer_communications` | `true` | `false` | `false` | `true` | `android` | `none` |
| `device_id` | push device token | `push-apns` | `developer_communications` | `true` | `false` | `false` | `true` | `ios` | `none` |
| `device_id` | push device token that receives ad pushes | `push-fcm` | `developer_advertising` | `true` | `false` | `false` | `true` | `android` | `pushConsent.adPush = true` |
| `device_id` | push device token that receives ad pushes | `push-apns` | `developer_advertising` | `true` | `false` | `false` | `true` | `ios` | `pushConsent.adPush = true` |

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `RegisterPushToken` input violation, adapter value of that provider is `null` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `queue_push` check violation | 0. Nothing scheduled | none | `error` |
| scheduled count limit of the target user | 0. Nothing scheduled | none | `warn` |
| `push_target_lock` lock wait over the limit in `queue_push`, `cancel_push` | throw | `INTERNAL` | `error` log by `routing` |
| `schedule_push` check violation | `bad_request` | none | `audit` |
| cancel of a record that is not `SCHEDULED` | `conflict` | none | `audit` |
| adapter failure | `failed_count` after retries | none | `error`. Per record, at the first failure and at the end |
| game transaction that writes a batch result or the finish is `FAILED` | sending stops after retries | none | `error` at the first failure and when stopping |
| `message_id` not in the server build data at send time | record `FAILED` | none | `error`. One per record |
| `push.leaseMs` condition violation | server start failure | none | `error` |
| `pushConsent.nightStartMinute` equals `pushConsent.nightEndMinute` | server start failure | none | `error` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `push.maxDeviceTokenBytes` | integer | core | content | maximum bytes of `device_token` |
| `push.maxDedupeKeyBytes` | integer | core | content | maximum bytes of `dedupe_key` |
| `push.maxScheduleAheadMs` | integer | core | content | maximum duration from now to `send_at` |
| `push.maxScheduledPerUser` | integer | core | content | maximum count of `SCHEDULED` records per target user |
| `push.maxTargetUserIds` | integer | core | content | maximum count of `user_ids` of `schedule_push` |
| `push.pollIntervalMs` | integer | core | content | interval for finding records to send. 1 or more |
| `push.leaseMs` | integer | core | content | valid duration of a send lease |
| `push.maxDelayMs` | integer | core | content | maximum duration by which a push can be sent later than `send_at` |
| `push.sendBatchSize` | integer | core | content | device count handled at a time |
| `push.sendTimeoutMs` | integer | core | content | time limit of an adapter call. 1 or more |
| `push.retryIntervalMs` | integer | core | content | interval before sending again to a failed device |
| `push.retryMaxAttempts` | integer | core | content | maximum send attempts per device, the first included. 1 or more |
| `push.recordRetentionMs` | integer | core | content | duration that a finished push record is kept |
| `environments.<ENV>.secrets.pushFcm` | string | game | none | name of the secret that holds the private key (PEM) of the `environments.<ENV>.fcm.serviceAccountEmail` service account |
| `environments.<ENV>.secrets.pushApns` | string | game | none | name of the secret that holds the APNs auth key (`.p8` PEM) |
| `environments.<ENV>.fcm.projectId` | string | game | none | Firebase project ID of the FCM HTTP v1 API |
| `environments.<ENV>.fcm.serviceAccountEmail` | string | game | none | service account that gets the FCM HTTP v1 API access token |
| `appleTeamId` | string | game | none | `iss` of the APNs provider token JWT |
| `pushApns.keyId` | string | game | none | `kid` of the APNs provider token JWT |
| `appId` | string | game | none | APNs `apns-topic` |
| `supportedLanguages` | array<string> | game | none | languages accepted as `language` of `RegisterPushToken` |
| `environments.<ENV>.adapters.push-fcm` | string? | game | none | FCM push adapter name. `null` means this environment has no FCM adapter |
| `environments.<ENV>.adapters.push-apns` | string? | game | none | APNs push adapter name. `null` means this environment has no APNs adapter |
| `pushConsent.adPush` | boolean | game | none | whether ad pushes are sent |
| `pushConsent.nightStartMinute` | integer | game | none | minute within the local day at which the night window starts |
| `pushConsent.nightEndMinute` | integer | game | none | minute within the local day at which the night window ends |
| `routing.externalMaxResponseBytes` | integer | core | content | maximum bytes of an external service response body. Over it, that call fails |

- `push.leaseMs` is more than `push.retryMaxAttempts` × (`push.sendTimeoutMs` + `push.retryIntervalMs`). On violation, the server does not start
- When `pushConsent.nightStartMinute` equals `pushConsent.nightEndMinute`, the server does not start

## data

`data/tables/push_message.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `title` | `tstring<id>` | `Server` |
| `body` | `tstring<id>` | `Server` |
| `kind` | `enum<PushKind>` | `Server` |

- When game settings `pushConsent.adPush` is `false` and there is a row with `kind` `Ad`, the server does not start

`data/enums.csv`

| type | element |
|---|---|
| `PushKind` | `Info`, `Ad` |

- `Ad` marks a push with promotional content for commercial purposes (ad push). Every other push is `Info`

reserved ID: `[push_ad_label]` → row of `push_message`. The `title` of that row is the text that marks an ad push. The reserved ID is required when game settings `pushConsent.adPush` is `true`

reserved string, reserved sound: none

## DEV

- The operation name of the `testing.fake` controller (service `push-fcm`, `push-apns`) is `send`. `set_result` sets an object with device tokens as keys and `OK`, `INVALID_TOKEN` or `FAILED` as values; a token not set follows the default rule of the fake adapter. `input` of `calls()` is `{tokens, payload}`

## test

- The push of `queue_push` goes once to a registered device after `send_at`, and the record is `SENT`
- `queue_push` in a request whose handler returned `GameError` is not scheduled
- No push goes to the previous device of a user who logged out or logged in on another device, and that registration row is deleted
- When another user registers the same device token, the previous user's pushes do not go to that device
- When a user registers again with a different `device_token`, that user's device registration rows are one row of the new token. When two users register the same `device_token` concurrently, there is one row of that token, and it is the row of one of the two users
- Scheduling twice with the same `dedupe_key` makes the earlier record `CANCELED`, and the push goes only once. After `cancel_push`, it does not go
- `queue_push` with a message that does not exist, a mismatch of `args` names, or an out-of-range `send_at` returns 0, and there is no record
- The title and body are made from the translation of the device's `language`, and the format arguments are filled
- The registration row with an `INVALID_TOKEN` result is deleted. `FAILED` goes into `failed_count` after retries
- A `SCHEDULED` record picked later than `push.maxDelayMs` is not sent and is `EXPIRED`. For a `SENDING` record whose lease ended during sending, another server instance sends from `cursor_user_id` to the end even when more than `push.maxDelayMs` has passed since `send_at`, and the record is `SENT`
- A push goes only to the devices that match the platform, language and `active_within_ms` of `filter`
- When the server instance that took the lease is stopped during sending, another server instance continues from `cursor_user_id` and does not send again to the devices of finished batches
- `cancel_scheduled_push` of a record that is not `SCHEDULED` is `conflict`
- `RegisterPushToken` from web, windows, macos and linux is `INVALID_REQUEST`
- In an environment where `adapters.push-apns` is `null`, `RegisterPushToken` from `ios` is `INVALID_REQUEST`, and no device registration row is created
- Logs have no device token, title or body
- The push ID that `queue_push` returned equals `push_id` of the saved push record
- After the lease ends and another server instance takes the lease, the earlier server instance does not write `cursor_user_id` and stops sending that record
- When two server instances take the lease of the same record concurrently, only one gets it
- With settings that violate the `push.leaseMs` condition, the server does not start
- When the transactions of two different users call `queue_push` concurrently with the same target user and the same `dedupe_key`, that target user has one `SCHEDULED` record of that `dedupe_key`
- When the target user has `push.maxScheduledPerUser` − 1 `SCHEDULED` records, of the `queue_push` calls that the transactions of two different users make concurrently for that target user, only one is scheduled and the other returns 0
- After `remove_user`, that user has no device registration row, the `SCHEDULED` records whose only target is that user are `CANCELED`, and records that also target other users stay
- `export_user_rows` includes that user's device registration rows
- A push with `kind` `Ad` does not go to a device with `ad_allowed` `false` and goes into `consent_skipped_count`. The title starts with the title translation of the `[push_ad_label]` row and a space
- On a device whose local time is within the night window, when `night_allowed` is `false`, an `Ad` push does not go at once but goes into `push_held`, and goes once in the first send cycle after the night window ends. When `night_allowed` is `true`, it goes at once. An `Info` push goes regardless of the night window and consent
- Even when job `push_send` of two server instances picks the same `push_held` row together, that push goes to that device only once, and `sent_count` of the push record increases by only 1
- With settings where `pushConsent.nightStartMinute` is less than `pushConsent.nightEndMinute`, an `Ad` push for a device with `night_allowed` `false` goes into `push_held` when the minute of the local time is `pushConsent.nightStartMinute`, and goes at once when it is `pushConsent.nightEndMinute`. With settings where the two values are equal, the server does not start
- After `UpdatePushConsent`, `ad_allowed` and `night_allowed` of that user's device registration rows are the new values
- For each case of core test fixture `text-format` whose `kind` is `int` or `string` and whose `expected` is not `null`, the push text of a device registered with that language and timezone offset 0 equals `expected`
- The `{t:date}` text of a device with `timezone_offset_ms` 9 hours equals the text of t + 9 hours on a device with 0
- `queue_push` given a `PushArg` of a value kind that the formatter does not accept (e.g. a string for `n`) returns 0, and there is no record. `schedule_push` is `bad_request`
- `queue_push` given, for `compact`, a string `PushArg` that is not a big integer returns 0, and there is no record
- `RegisterPushToken` with an out-of-range `timezone_offset_ms` is `INVALID_REQUEST`
