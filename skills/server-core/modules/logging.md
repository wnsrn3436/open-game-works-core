# logging

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

This module writes server logs, and saves the error logs and analytics events that clients send and the analytics events that server code emits. It sends analytics events to the analytics adapter, and requests from the analytics adapter the deletion of the analytics data of a user who withdrew.

## dependency

- `storage`
- `server-time`

logging exports the handlers of the two core `rpc`, and `routing` collects them. logging exports the three admin operations `list_client_errors`, `list_client_events`, `list_server_events`, and `routing` collects them and passes them to `admin-api`.

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `log` | ctx, level, message, field object | none | none | content handler, hook |
| `write` | log entry | none | none | core module |
| `truncate_ip` | IP string | truncated IP | empty string when it is not an IP address | core module |
| `with_audit_actor` | operator name, function | result of the function | none | `admin-api` |
| `with_request_ip` | client IP, function | result of the function | none | `routing` |
| `annotate_request_log` | ctx, field object, minimum level | none | throws on a rule violation | core module |
| `take_request_log_annotation` | ctx | the added field object and minimum level | none | `routing` |
| `track` | ctx, event name, param list | none | throws on a rule violation | content handler, hook |
| `track_core_event` | ctx, core analytics event name, param list | none | throws on a rule violation | `auth`, `tutorial`, `iap`, `ads-reward`, `gacha`, `shop`, `mission`, `attendance`, `offer` |
| `ReportClientErrors` (core rpc, `silent`, `retry`). changes: none | `errors` (list of `ClientErrorEntry`), `dropped_error_count` | empty response | `INVALID_REQUEST`, `RATE_LIMITED` | `routing`. Client `NetworkCore` sends it as the sender of `LogCore` |
| `ReportAnalyticsEvents` (core rpc, `silent`, `retry`). changes: none | `events` (list of `AnalyticsEvent`), `dropped_event_count` | empty response | `INVALID_REQUEST`, `RATE_LIMITED` | `routing`. Client `NetworkCore` sends it as the sender of `LogCore` |
| `count_report_request` | user ID | `pass` | `RATE_LIMITED`, `UNAUTHORIZED`, `INTERNAL` | `routing` |
| `request_analytics_deletion` | ctx | none | none | `auth` |
| `list_client_errors` | `user_id`(optional), `from_at`, `to_at`, `after_time_at`(optional), `after_user_id`(optional), `after_seq`(optional), `limit` | `entries` | `bad_request` | operator |
| `list_client_events` | `user_id`(optional), `name`(optional), `from_at`, `to_at`, `after_time_at`(optional), `after_user_id`(optional), `after_seq`(optional), `limit` | `entries` | `bad_request` | operator |
| `list_server_events` | `user_id`(optional), `name`(optional), `from_at`, `to_at`, `after_time_at`(optional), `after_user_id`(optional), `after_seq`(optional), `limit` | `entries` | `bad_request` | operator |

- log entry: the fields are `kind`, `level`, `message`, `user_id`, `request_id`, `request`, `fields` (object that holds the fields added per `kind` and the fields set by the spec of the module that writes the log). A missing value is `null`, and `write` adds `time`. An entry of `kind` `request` also holds `min_level` (the minimum level of `take_request_log_annotation`), `request_body` (request body bytes. `null` when absent) and `sensitive` (whether the `rpc` has option `(ogw.sensitive)`), and `write` sets that line's level and `request_body` by the `### server log` rules
- `with_audit_actor` calls the function, and while the function runs, for each `kind` `audit` entry that `write` receives with no `actor` in `fields`, writes that operator name as `actor`
- `log` writes a `kind` `game` log. The level is `debug`, `info`, `warn` or `error`
- `annotate_request_log` adds fields to the `request` log that the ctx's request will write and sets the minimum level. Called several times on the same ctx, it merges the fields, the later value wins for the same key, and the minimum level is the highest of the levels received. The level order is `debug`, `info`, `warn`, `error`
- Rules of `annotate_request_log`: a key of the field object is snake_case and is not a common field, `error_code`, `duration_ms`, `client_version`, `platform`, `seed` or `request_body`. A value is an integer, string or bool. On a violation it throws and the request ends with `INTERNAL`
- `take_request_log_annotation` is called even after the ctx's transaction has ended and the ctx is invalid. The added values remain even when the transaction is rolled back. A ctx on which `annotate_request_log` was not called gives an empty field object and minimum level `debug`
- A key of a field object is snake_case and is not a common field name. A value is an integer, string or bool. On a violation, that field is dropped and a `warn` log is written
- `ClientErrorEntry`, `AnalyticsEvent`, `AnalyticsParam`, `AnalyticsParamKind` are base proto messages and an enum
- `level` of `ClientErrorEntry` is `warn` or `error`. `AnalyticsParamKind` is `INT`, `DOUBLE`, `STRING`, `BOOL`. In `AnalyticsParam`, only the one value field of its `kind` has a value
- Field types of the admin operations: `name` is `string`, `after_user_id` is `int64`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ReportClientErrorsRequest` | `errors` | `repeated ClientErrorEntry` | `max_count_key`: `logging.maxErrorEntries` |
| `ReportClientErrorsRequest` | `dropped_error_count` | `int32` | `min`: 0, `max`: 2^31−1 |
| `ClientErrorEntry` | `time_at` | `int64` | `min`: 0, `max`: 2^63−1 |
| `ClientErrorEntry` | `level` | `string` | `max_chars_key`: `logging.maxStringLength` |
| `ClientErrorEntry` | `tag` | `string` | `max_chars_key`: `logging.maxStringLength` |
| `ClientErrorEntry` | `message` | `string` | `max_chars_key`: `logging.maxErrorMessageLength` |
| `ClientErrorEntry` | `stack_trace` | `string` | `max_chars_key`: `logging.maxStackTraceLength` |
| `ReportAnalyticsEventsRequest` | `events` | `repeated AnalyticsEvent` | `max_count_key`: `logging.maxEvents` |
| `ReportAnalyticsEventsRequest` | `dropped_event_count` | `int32` | `min`: 0, `max`: 2^31−1 |
| `AnalyticsEvent` | `name` | `string` | `max_chars_key`: `logging.maxStringLength` |
| `AnalyticsEvent` | `time_at` | `int64` | `min`: 0, `max`: 2^63−1 |
| `AnalyticsEvent` | `params` | `repeated AnalyticsParam` | `max_count_key`: `logging.maxEventParams` |
| `AnalyticsParam` | `key` | `string` | `max_chars_key`: `logging.maxStringLength` |
| `AnalyticsParam` | `kind` | `AnalyticsParamKind` | none |
| `AnalyticsParam` | `int_value` | `int64` | `min`: −2^63, `max`: 2^63−1 |
| `AnalyticsParam` | `double_value` | `double` | none |
| `AnalyticsParam` | `string_value` | `string` | `max_chars_key`: `logging.maxStringLength` |
| `AnalyticsParam` | `bool_value` | `bool` | none |

## behavior

### server log

- Server logs are written one line at a time to the server instance's log output. The log output is the log line writer override that `routing.create_server` received, or stdout when there is none. The format and common fields follow the log rules of server-core. The deploy of [`build`](../../build/SKILL.md) sets the rotation of container logs, and the host collects and keeps the logs before rotation deletes them
- STG and PROD do not use the `debug` level
- Fields added per `kind`

| kind | added field |
|---|---|
| `request` | `error_code` (0 on success), `duration_ms`, `client_version`, `platform`, `seed` (for a request for which `routing` made a ctx, the decimal string of the ctx's `seed`, otherwise null), the fields added with `annotate_request_log`. For the client log `rpc`, `dropped_count`, `client_dropped_count`, `consent_dropped_count` |
| `error` | `stack_trace`. null unless it is an unhandled exception |
| `security` | `ip` (truncated IP. When the entry has no `ip`, the truncated IP of the client IP inside the function of `with_request_ip`, null outside it), `reason` |
| `audit` | `actor` (the value in the entry's `fields` when there is one, the operator name inside the function of `with_audit_actor`, otherwise `system`) and the fields set by the spec of the module that writes the audit |
| `game` | the fields passed by content |
| `core` | `module` (name of the core module that wrote the log) |

- The `reason` of a `security` log is snake_case. When the spec of the module that writes the log sets the `reason`, it is that value; otherwise it is the name of the failure's failure value converted to snake_case. When the failure value is an enum element, the element without the enum name and prefix is used. e.g. `SESSION_REPLACED` is `session_replaced`, and `OTHER_USER` of `PurchaseStatus` is `other_user`. For the `security` log of a failure whose failure value has no name (e.g. HTTP status), that spec sets the `reason`
- `security` logs are grouped into windows per group key and `reason`. The group key is the user ID for a request that identified the user, otherwise the truncated IP. A window starts at the `server-time.clock_now` at which a `security` log is written for a group key and `reason` that have no window, and ends `logging.securityRepeatWindowMs` later. Only the first line of a window is written; the other lines in the window are not written, and their number and truncated IPs are counted. Windows are kept in the server instance's memory
- At server start, logging sets the job `logging_security_flush` (period `logging.securityRepeatWindowMs`) with `server-time.schedule_job`. For each ended window, when there are lines not written, the job writes one summary `security` log line with `reason` `repeated`, `count` (number of lines not written after the first line) and `ips` (the truncated IPs of those lines. Without duplicates, in first-seen order, at most `logging.maxRepeatedIps`), and it deletes the ended window. The summary line's level is `warn`, its `message` is the `reason` of the grouped lines, and its `user_id` is the group key when the group key is a user ID, otherwise null. Summary lines are not grouped into windows
- In an environment that includes DEV code, the `request` log adds `request_body` (base64). The `request` log of a request whose `rpc` has option `(ogw.sensitive)` does not add `request_body`, whatever the environment
- The level of the `request` log is `error` for a request that ended with `INTERNAL` and `info` for any other request. When the minimum level of `annotate_request_log` is higher, it is that level

### client log collection

- The two `rpc` require a session. Logs from before login are not received
- The handlers of the two `rpc` pass the counts and level to add to the `request` log with `annotate_request_log`. They pass all of `dropped_count`, `client_dropped_count`, `consent_dropped_count`, and a count that does not apply is 0
- analytics consent: after the limit check, `ReportAnalyticsEvents` reads the user's core UserState kind `ConsentUserState` (owner `auth`) with `storage.get_state`. When there is no row or `analytics_allowed` is `false`, it saves no event, sends nothing to the analytics adapter, and succeeds with an empty response. The number of dropped events is added to that request's `request` log as `consent_dropped_count`. The level is not changed
- rate limit: in one `storage.run_user_transaction`, `count_report_request` writes the user's `logging_report_counter` row with one upsert statement, reads the `count` after the write from that statement, and commits. The counter counts per minute window of `server-time`. When there is no row or the row's `window_start` differs from the window start of the current minute window, it writes `window_start` as that window start, `count` as 1 and `expires_at` as that minute window's window end; when they are equal, it increments `count` by 1. When the `count` after the write is more than `logging.reportRateLimitPerMinute`, the result is `RATE_LIMITED`. The request processing order of `routing` sets when it is called, and it counts whatever the result of the request. When `run_user_transaction` is `WITHDRAWN`, the result is `UNAUTHORIZED`; when `FAILED`, `INTERNAL`; and the count does not go up
- The limits of entry count, event count, param count and string length are the core `rpc` request field table. A request over any one of them ends with `INVALID_REQUEST` in the field validation of `routing` and saves nothing
- When any event `name` or param `key` is not snake_case (`[a-z][a-z0-9_]*`) or any event `name` starts with `core_`, nothing is saved and the result is `INVALID_REQUEST`
- For a param whose `kind` and value field do not match, NaN and infinity of `DOUBLE`, and a param whose `key` equals that of an earlier param in the same event, only that param is dropped. Other params of the same event and other events are saved. The number of dropped params is added to that request's `request` log as `dropped_count`, and the level becomes `warn`. Dropped keys and values are not logged
- For a `ClientErrorEntry` whose `level` is neither `warn` nor `error`, only that entry is dropped. Other entries of the same request are saved. The number of dropped entries is added to that request's `request` log as `dropped_count`, and the level becomes `warn`. The content of dropped entries is not logged
- Only the defined fields are saved. On save, `received_at` (request time) and the ctx's `client_version` and `platform` are added
- `dropped_error_count` and `dropped_event_count` (number of entries and events that the client dropped because of its queue limit) are added to that request's `request` log as `client_dropped_count`. When it is more than 0, the level becomes `warn`

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `logging_client_error` | `user` | `user_id`(`int64`), `seq`(`int64`), `time_at`(`int64`), `received_at`(`int64`), `client_version`(`string`), `platform`(`string`), `level`(`string`), `tag`(`string`), `message`(`string`), `stack_trace`(`string`), `expires_at`(`int64`) | `(user_id, seq)` | `expires_at` |
| `logging_client_event` | `user` | `user_id`(`int64`), `seq`(`int64`), `time_at`(`int64`), `received_at`(`int64`), `client_version`(`string`), `platform`(`string`), `name`(`string`), `params`(`bytes`. protobuf bytes of an `AnalyticsEvent` with only the `params` field filled), `expires_at`(`int64`) | `(user_id, seq)` | `expires_at` |

- Both tables are registered with `storage.register_table` and excluded from snapshots. The personal data user column is `user_id`, and the index is `(time_at, user_id, seq)`. `seq` is an integer that grows from 1 per user within the table
- The order of `AnalyticsParam` in `params` is the `params` order of the received event
- `logging_report_counter`: scope `user`, column `user_id`(`int64`), `window_start`(`int64`), `count`(`int64`), `expires_at`(`int64`), key `user_id`, expiry column `expires_at` (window end of that minute window). Registered with `storage.register_table`, excluded from snapshots
- `expires_at` is `received_at` + `logging.clientLogRetentionMs`
- `list_client_errors` and `list_client_events` return up to `limit` rows in the range `[from_at, to_at)` in ascending order of `(time_at, user_id, seq)`. The body rules of `admin-api` check the range and `limit`
- An element of `entries` is one row: an object that holds every column with the column name as the key. The value format equals that of the rows of `storage.export_user_rows`
- cursor: when `after_time_at`, `after_user_id`, `after_seq` are given, only rows whose `(time_at, user_id, seq)` is greater than `(after_time_at, after_user_id, after_seq)` are returned. The next query gives the `time_at`, `user_id`, `seq` of the last entry of the previous query. `bad_request` when only some of the three fields are given or `after_seq` is less than 1

### server analytics event

- `track` and `track_core_event` save one analytics event of the ctx user to `logging_server_event` in the ctx's transaction. When the transaction is rolled back, it does not remain
- A param is `(key, value)`, and the value is one of integer, float, string, bool. In TypeScript, `bigint` and an integer `number` are integers, and any other `number` is a float. On save, each param is converted to an `AnalyticsParam` (the `kind` that matches the value, and that value field). The order of `AnalyticsParam` in `params` is the order of the received params
- On a violation of the rules below, it throws and the request ends with `INTERNAL`
  - The event name and param keys are snake_case and at most `logging.maxStringLength`
  - The param count is at most `logging.maxEventParams` and the keys differ from each other
  - A string value is at most `logging.maxStringLength`, and a float value is not NaN or infinity
  - The event name of `track` does not start with `core_`. The name of `track_core_event` is in the core analytics event table below, the params are all the params of that row, and each value is of the table's type
- analytics consent: when the `ConsentUserState` read with `storage.get_state` does not exist or `analytics_allowed` is `false`, nothing is saved or sent. No log is written

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `logging_server_event` | `user` | `user_id`(`int64`), `seq`(`int64`), `time_at`(`int64`), `request_id`(`string`), `client_version`(`string`), `platform`(`string`), `name`(`string`), `params`(`bytes`. protobuf bytes of an `AnalyticsEvent` with only the `params` field filled), `expires_at`(`int64`) | `(user_id, seq)` | `expires_at` |

- Registered with `storage.register_table`, excluded from snapshots. The personal data user column is `user_id`, and the index is `(time_at, user_id, seq)`. `seq` is an integer that grows from 1 per user. `time_at` is the request time, and `request_id`, `client_version`, `platform` are the ctx's values. `expires_at` is `time_at` + `logging.serverEventRetentionMs`
- `list_server_events` returns rows with the same range, sort, `entries` format, cursor and `limit` rules as `list_client_events`

core analytics event. Its name starts with `core_`, and only core modules emit it. Revenue metrics are counted with `core_iap_granted` and `core_iap_refunded` whose `test` is `false`, not with client events.

| event | module | when | param |
|---|---|---|---|
| `core_user_created` | `auth` | the transaction of `Login` or `DevLogin` that opens the session of a user that request created (step 6 of `auth`). A user whose request then failed has none | `provider` (string. `LoginProvider` element name. `LOGIN_PROVIDER_GUEST` for `DevLogin`) |
| `core_session_started` | `auth` | the transaction in which `Login`, `AutoLogin` or `DevLogin` opened a new session | `login` (string. request name) |
| `core_tutorial_step` | `tutorial` | when `SaveTutorialProgress` changed the progress | `tutorial_id` (integer), `step` (integer) |
| `core_iap_granted` | `iap` | when a payment record was recorded as `GRANTED` | `product_id` (integer), `store` (string. `IapStore` element name), `spend_amount` (integer), `test` (bool), `renewal` (bool. `true` for a renewal transaction. Step 8 of the grant order of `iap` judges it) |
| `core_iap_refunded` | `iap` | the user transaction that changed a payment record to `REFUNDED` | `product_id` (integer), `store` (string. `IapStore` element name), `spend_amount` (integer), `test` (bool) |
| `core_ad_rewarded` | `ads-reward` | when a ticket was changed to `Granted` | `placement_id` (integer) |
| `core_gacha_drawn` | `gacha` | when `DrawGacha` succeeded | `banner_id` (integer), `count` (integer. number of draws), `ticket` (bool) |
| `core_shop_bought` | `shop` | when `BuyShopProduct` succeeded | `product_id` (integer), `quantity` (integer) |
| `core_mission_claimed` | `mission` | when `ClaimMission` succeeded | `mission_id` (integer) |
| `core_attendance_claimed` | `attendance` | when `ClaimAttendance` succeeded | `calendar_id` (integer), `day` (integer) |
| `core_offer_triggered` | `offer` | when `trigger_offer` turned on an offer | `offer_id` (integer), `trigger_count` (integer) |

### analytics adapter

- The adapter key is `analytics`, and the names are `fake`, `analytics-ga4`. When game settings `environments.<ENV>.adapters.analytics` is `null`, nothing is sent
- `analytics-ga4` sends to the GA4 property of Firebase Analytics with the GA4 Measurement Protocol. It appends the query `measurement_id` (game settings `environments.<ENV>.analyticsGa4.measurementId`) and `api_secret` (secret `environments.<ENV>.secrets.analytics`) to `POST https://www.google-analytics.com/mp/collect`. `client_id` and `user_id` of the body are the user ID decimal string, and each event is `name`, `params`, `timestamp_micros` (`time_at` × 1000). One call holds up to 25 events, and more are sent split over several calls
- Events and params that GA4 does not accept are not sent: an event `name` or param `key` of more than 40 characters, a string value of more than 100 characters, the params after the 25th in each event
- The adapter's `delete_user_data`(user ID) requests from the provider the deletion of the user's analytics data and returns a success flag
- `delete_user_data` of `analytics-ga4` calls the Google Analytics User Deletion API `POST https://www.googleapis.com/analytics/v3/userDeletion/userDeletionRequests:upsert` once each with `id.type` `USER_ID` and `CLIENT_ID`, and succeeds when both are HTTP 200. The body is `{"kind": "analytics#userDeletionRequest", "id": {"type": <type>, "userId": <user ID decimal string>}, "propertyId": <property ID>}`, and the property ID is game settings `environments.<ENV>.analyticsGa4.propertyId`. The access token is the value obtained at that token endpoint in exchange for an RS256 JWT whose `iss` is game settings `environments.<ENV>.analyticsGa4.serviceAccountEmail`, `scope` is `https://www.googleapis.com/auth/analytics.user.deletion` and `aud` is `https://oauth2.googleapis.com/token`, signed with the private key of secret `environments.<ENV>.secrets.analyticsServiceAccount`
- Saved client events and server events are sent after commit with the adapter's `send(events)` through `storage.after_commit`. The time limit is `logging.analyticsSendTimeoutMs`
- A failed send is not sent again. The DB rows remain. A failure writes a `warn` log; while the same kind of failure continues, only the first failure and a change of kind are logged
- The operation names of the fake adapter controller are `send`, `delete_user_data`. The `input` of `calls()` is the event list for `send` and the user ID for `delete_user_data`. `set_result` sets the success flag of `delete_user_data`, and before it is set the flag is `true`

### analytics deletion

- When the current environment has an analytics adapter, `request_analytics_deletion` writes the user's `logging_analytics_deletion` row (`attempts` 0, `created_at` request time) in the ctx's transaction. When the row already exists, it is left as it is. When there is no analytics adapter, it does nothing. When the transaction is rolled back, no row remains
- `logging_analytics_deletion`: scope `game`, column `user_id`(`int64`), `attempts`(`int32`), `created_at`(`int64`), key `user_id`, index `(created_at)`. The scope is `game` so that the row remains after withdrawal. Registered with `storage.register_table`
- At server start, logging sets the job `logging_analytics_deletion` (period `logging.analyticsDeletionIntervalMs`) with `server-time.schedule_job`. The job reads up to `logging.analyticsDeletionBatchSize` rows in ascending order of `created_at` with `storage.read_db`, and for each row calls the adapter's `delete_user_data`(user ID) outside a transaction. The time limit is `logging.analyticsSendTimeoutMs`
- On success, it deletes the row in one `storage.run_game_transaction`. On failure, it increments `attempts` by 1 the same way and writes a `warn` log. When the incremented `attempts` reaches `logging.analyticsDeletionMaxAttempts`, it deletes the row and writes the `user_id` in an `error` log
- Two server instances may send the same row at the same time. `delete_user_data` has the same result when called several times for the same user

### real adapter

| adapter key | real adapter |
|---|---|
| `analytics` | `analytics-ga4` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `crash_data` | error logs sent by the client | `module` | `app_functionality` | `true` | `false` | `false` | `false` | `all` | `none` |
| `product_interaction` | analytics events emitted by the client and the server | `module` | `analytics` | `true` | `false` | `false` | `true` | `all` | `consent.privacyChoices = true` |
| `product_interaction` | analytics events emitted by the client and the server | `module` | `analytics` | `true` | `false` | `false` | `false` | `all` | `consent.privacyChoices = false` |
| `product_interaction` | analytics events sent to the analytics adapter | `analytics-ga4` | `analytics` | `true` | `false` | `false` | `true` | `all` | `consent.privacyChoices = true` |
| `product_interaction` | analytics events sent to the analytics adapter | `analytics-ga4` | `analytics` | `true` | `false` | `false` | `false` | `all` | `consent.privacyChoices = false` |

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| a name that is not snake_case or that starts with `core_` | `INVALID_REQUEST`. Nothing is saved | `INVALID_REQUEST` | none |
| more than `logging.reportRateLimitPerMinute` | `RATE_LIMITED`. Nothing is saved | `RATE_LIMITED` | `security` log by `routing` |
| the user transaction of `count_report_request` is `WITHDRAWN` | `UNAUTHORIZED`. Nothing is saved | `UNAUTHORIZED` | none |
| the user transaction of `count_report_request` is `FAILED` | `INTERNAL`. Nothing is saved | `INTERNAL` | `error` log |
| mismatched param | only that param is dropped | none | `dropped_count` of the `request` log, level `warn` |
| `ClientErrorEntry` whose `level` is neither `warn` nor `error` | only that entry is dropped | none | `dropped_count` of the `request` log, level `warn` |
| analytics send failure | not sent again | none | `warn` log |
| analytics deletion request failure | sent again in the next job run. When it reaches `logging.analyticsDeletionMaxAttempts`, the row is deleted | none | `warn` log. `error` log when the row is deleted |
| invalid field object | that field is dropped | none | `warn` log |
| rule violation of `track` or `track_core_event` | throw | `INTERNAL` | `error` log by `routing` |
| rule violation of `annotate_request_log` | throw | `INTERNAL` | `error` log by `routing` |
| body rules violation of `list_client_errors`, `list_client_events` or `list_server_events` | `bad_request` | none | error rule of `admin-api` |
| only some of `after_time_at`, `after_user_id`, `after_seq` given to `list_client_errors`, `list_client_events` or `list_server_events`, or an `after_seq` less than 1 | `bad_request` | none | error rule of `admin-api` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `logging.securityRepeatWindowMs` | integer | core | content | length of the window that groups `security` logs, and period of the job `logging_security_flush` |
| `logging.maxRepeatedIps` | integer | core | content | max number of IPs in the list of a summary line |
| `logging.reportRateLimitPerMinute` | integer | core | content | limit on the number of client log requests per user in one minute window |
| `logging.maxErrorEntries` | integer | core | content | max number of entries in one `ReportClientErrors` |
| `logging.maxErrorMessageLength` | integer | core | content | max code points of `message` |
| `logging.maxStackTraceLength` | integer | core | content | max code points of `stack_trace` |
| `logging.maxEvents` | integer | core | content | max number of events in one `ReportAnalyticsEvents` |
| `logging.maxEventParams` | integer | core | content | max number of params in one event |
| `logging.maxStringLength` | integer | core | content | max code points of `tag`, `name`, `key` and a string value |
| `logging.clientLogRetentionMs` | integer | core | content | duration for which client log rows are kept |
| `logging.serverEventRetentionMs` | integer | core | content | duration for which `logging_server_event` rows are kept |
| `logging.analyticsSendTimeoutMs` | integer | core | content | time limit of an analytics adapter call |
| `logging.analyticsDeletionIntervalMs` | integer | core | content | period of the job `logging_analytics_deletion` |
| `logging.analyticsDeletionBatchSize` | integer | core | content | number of rows that the job `logging_analytics_deletion` sends in one run |
| `logging.analyticsDeletionMaxAttempts` | integer | core | content | max number of times one deletion request is sent |
| `environments.<ENV>.adapters.analytics` | string? | game | none | analytics adapter name. When `null`, this environment has no analytics adapter |
| `environments.<ENV>.analyticsGa4.measurementId` | string | game | none | measurement ID of the GA4 data stream that `analytics-ga4` sends to |
| `environments.<ENV>.secrets.analytics` | string | game | none | name of the secret that holds the Measurement Protocol API secret of `analytics-ga4` |
| `environments.<ENV>.analyticsGa4.propertyId` | string | game | none | GA4 property ID for which `analytics-ga4` requests user deletion |
| `environments.<ENV>.analyticsGa4.serviceAccountEmail` | string | game | none | service account that gets the User Deletion API access token |
| `environments.<ENV>.secrets.analyticsServiceAccount` | string | game | none | name of the secret that holds the private key (PEM) of the `environments.<ENV>.analyticsGa4.serviceAccountEmail` service account |
| `routing.externalMaxResponseBytes` | integer | core | content | max bytes of an external service response body. When more, the call fails |
| `consent.privacyChoices` | boolean | game | none | whether to ask for the ad personalization and analytics choices |

## data

none

## DEV

- The `request` log of an environment that includes DEV code has `request_body`. The `request` log of an `(ogw.sensitive)` request and the `request` log in STG and PROD do not have it

## test

- For each request for which `routing` writes a `request` log, there is one `request` log line with all common fields
- The `request` log level of a successful request and of a request that ended with `GameError` is `info`, and that of a request that ended with `INTERNAL` is `error`. The `request` log of a successful request that gave minimum level `warn` and fields with `annotate_request_log` has level `warn` and holds those fields. An `annotate_request_log` that violates the rules is `INTERNAL`
- The `request` log `seed` of a request given a seed through `testing.send` is the decimal string of that seed
- For each unhandled exception, there is an `error` log with `stack_trace`
- In the STG environment, `debug` logs, `request_body`, tokens and signatures are not in the logs
- In the DEV environment, the `request` log of `core/Login` and `core/VerifyPurchase`, which are `(ogw.sensitive)`, has no `request_body`, and the `request` log of a request without `(ogw.sensitive)` has it
- When N lines (N ≥ 2) of `security` log with the same user ID and `reason` from requests that identified the user fall within one window, only the first line is written, and after moving the test clock by twice `logging.securityRepeatWindowMs` and `wait_background`, there is one summary line with `count` N − 1 written by the job `logging_security_flush`. Requests that did not identify the user are grouped by truncated IP, and when a window has only one line, there is no summary line
- `ip` of a `security` log and `ips` of a summary line are truncated IPs
- `ReportClientErrors` without a session is rejected
- A request over one limit and a request with a name that is not snake_case save nothing and are `INVALID_REQUEST`
- Only the mismatched param is dropped, and the other events of the same request are saved
- Only the `ClientErrorEntry` whose `level` is `info` is dropped, the other entries of the same request are saved, and `dropped_count` of that request's `request` log is 1 with level `warn`
- A client log request does not increment the user counter of `routing`
- A client log request that ended with `INVALID_REQUEST` also counts in the report counter, and the next request that goes over `logging.reportRateLimitPerMinute` in one minute window does not call the handler and is `RATE_LIMITED`
- When the user transaction of `count_report_request` is `FAILED`, the handler is not called, the result is `INTERNAL`, and the report counter does not go up
- A client log request that arrives when the `expires_at` of a `logging_report_counter` row has passed but the row is not deleted yet writes the row's `count` as 1
- A query returns only rows in the range `[from_at, to_at)`, up to `limit` of them, in ascending order of `(time_at, user_id, seq)`. Even when more rows than `limit` have the same `time_at`, continuing with queries whose cursor is the last entry of the previous query gets every row once. A query that gives only some of the cursor fields is `bad_request`
- An element of `entries` of `list_client_events` holds every column of the row, `int64` columns are decimal strings, and the `params` obtained by reading `params` as standard base64 and decoding it as `AnalyticsEvent` equal the sent param list
- An environment without an analytics adapter sends nothing, and the fake adapter receives the saved events as they are
- An analytics send failure does not change the request result
- Client log rows past the retention duration are deleted
- `ReportAnalyticsEvents` of a user whose `analytics_allowed` of `ConsentUserState` is `false` or who has no row succeeds, the events are not in the DB or the fake analytics adapter, and `consent_dropped_count` is the number of events. Events after it becomes `true` are saved
- `track` of a user who consented leaves a `logging_server_event` row and an event in the fake analytics adapter after commit. `track` in a request whose handler ended with `GameError` leaves neither, and `track` of a user who did not consent also leaves neither
- In `track`, a name starting with `core_` and a key that is not snake_case are `INTERNAL`, and so is `track_core_event` with a name not in the table
- `ReportAnalyticsEvents` with an event name starting with `core_` saves nothing and is `INVALID_REQUEST`
- `list_server_events` returns only rows in the range `[from_at, to_at)`, up to `limit` of them, in ascending order of `(time_at, user_id, seq)`, and rows past the retention duration are deleted
- After the `Withdraw` commit, the job `logging_analytics_deletion` calls `delete_user_data` of the fake analytics adapter with that user ID and deletes the row. When `delete_user_data` fails, it is called again in the next run, and after `logging.analyticsDeletionMaxAttempts` failures the row is deleted and an `error` log is written. `Withdraw` in an environment without an analytics adapter and a rolled-back transaction leave no row
- The `actor` of an `audit` line written without `actor` in `fields` inside the function of `with_audit_actor` is that operator name, and for a line written outside the function it is `system`
- The `ip` of a `security` line written without `ip` inside the function of `with_request_ip` is the truncated IP of that client IP, and for a line written outside the function it is null. The same holds for a line written after an async operation that the function awaited
