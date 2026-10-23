# block-report

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

Lets a user block and report another user, and lets an operator query and handle reports. Blocking is used by friend requests in `friend`, direct chat and message display in `chat`, and queue matching in `matchmaker`.

## dependency

- `storage`
- `server-time`
- `logging`
- `validation`
- `public-profile`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `BlockUser` (core rpc, `retry`). changes: none | `user_id` | empty response | `INVALID_REQUEST`, `USER_NOT_FOUND`, `BLOCK_LIMIT` | `routing`. client content code sends it |
| `UnblockUser` (core rpc, `retry`). changes: none | `user_id` | empty response | `INVALID_REQUEST` | `routing`. client content code sends it |
| `GetBlockedUsers` (core rpc, `silent`). changes: none | none | `blocked`: list of `BlockedUserEntry` | none | `routing`. client content code sends it |
| `ReportUser` (core rpc, `retry`). changes: none | `user_id`, `reason_id`, `context`, `ref`, `comment` | empty response | `INVALID_REQUEST`, `USER_NOT_FOUND`, `REPORT_LIMIT` | `routing`. client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `BlockUserRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `UnblockUserRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `ReportUserRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `ReportUserRequest` | `reason_id` | `int32` | `table`: `report_reason` |
| `ReportUserRequest` | `context` | `ReportContext` | none |
| `ReportUserRequest` | `ref` | `string` | `max_len_key`: `block-report.maxRefBytes` |
| `ReportUserRequest` | `comment` | `string` | `max_chars_key`: `block-report.maxCommentLength` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetBlockedUsersResponse` | `blocked` | `repeated BlockedUserEntry` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `is_blocked` | ctx, blocking user ID, blocked user ID | `true` when the first user has blocked the second | `false` | content handler, hook |
| `is_blocked_either` | ctx, two user IDs | `true` when either one has blocked the other | `false` | content handler, hook, `friend`, `chat` |
| `list_blocked_ids` | ctx, user ID | list of user IDs that user has blocked. Ascending order | empty list | content handler, hook, `chat`, `matchmaker` |
| `add_report` | ctx, target user ID, `reason_id`, `ReportContext`, `ref`, `comment`, `evidence` | `ReportResult.OK` | failure element of `ReportResult` | `chat`, content handler, hook |
| `register_block_listener` | function(ctx, blocking user ID, blocked user ID → none. failure is a throw) | none | none. A registration error is a server start failure | `friend`. Calls it at server start |
| `remove_user` | ctx | none | none | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age, job `auth_guest_sweep`) |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `list_reports` | `status`(`enum{Open, Resolved}`), `from_at`, `to_at`, `after_created_at`(optional), `after_report_id`(optional), `limit` | `reports`: list of reports. Ascending order of `(created_at, report_id)` | `bad_request` | operator |
| `resolve_report` | `operation_id`, `report_id`, `resolution` | empty object | `not_found`, `conflict`, `bad_request` | operator |

- `BlockedUserEntry`(base proto message): `PublicProfileEntry profile`, `int64 blocked_at`(`created_at` of the block row)
- `ReportContext`(base proto enum): `Profile`, `Chat`, `Match`, `Guild`, `Other`. The screen the report was made from
- `reason_id`: ID value of `report_reason`
- `ref`: identifying string of the reported target. e.g. the decimal string of a match ID or a guild ID. At most `block-report.maxRefBytes` bytes
- `comment`: description written by the reporter. It is the empty string, or `validation.is_plain_text`(comment, `block-report.maxCommentLength`) is `true`
- `evidence`: text of the reported target saved on the server. Text the client sent is not used. `chat` passes the text of the reported message, content handlers and hooks pass the text of the reported target that content saved, and `ReportUser` passes the empty string. At most `block-report.maxEvidenceBytes` bytes
- report: `report_id`, `reporter_id`, `target_id`, `reason_id`, `context`(`ReportContext` element name), `ref`, `comment`, `evidence`, `status`(`Open`, `Resolved`), `created_at`, `resolved_at`, `resolution`, `expires_at`(null when `Open`)
- `resolution`: handling note written by the operator. The empty string is `bad_request`
- field types of admin operations: `report_id` and `after_report_id` are `int64`, `resolution` is `string`

`ReportResult`

| element | meaning |
|---|---|
| `OK` | Recorded the report. When the same report is already `Open`, records nothing and returns `OK` |
| `LIMIT` | The reporter's report count in the current fixed window reached the limit |
| `INVALID_INPUT` | `reason_id` is not in `report_reason`, `ReportContext` is `_UNSPECIFIED`, or `ref`, `comment` or `evidence` breaks its rule |

## behavior

### block

- Block rows are stored in `block_report_block`(scope `user`, column `user_id`, `blocked_id`, `created_at`, key `(user_id, blocked_id)`, snapshot flag `true`). `storage.delete_user` deletes them at withdrawal
- `BlockUser` processing order. A failure changes nothing
  1. `INVALID_REQUEST` when `user_id` is the caller's own
  2. `USER_NOT_FOUND` when `public-profile.is_active_user` is `false`
  3. When already blocked, success without changing anything
  4. Deletes the user's block rows whose `blocked_id` has `is_active_user` `false`
  5. `BLOCK_LIMIT` when the block row count is `block-report.maxBlocks` or more
  6. Writes the block row and calls the functions received through `register_block_listener` in registration order
- `UnblockUser` is `INVALID_REQUEST` when `user_id` is the caller's own. Otherwise it deletes that block row. It also succeeds when there is no row or the target is a withdrawn user
- `GetBlockedUsers` turns the users of the block rows into profiles with `public-profile.get_public_profiles` and returns them in descending order of `blocked_at`, ties in ascending order of user ID. Users without a profile are left out
- `is_blocked`, `is_blocked_either` and `list_blocked_ids` read block rows with `storage.db`(ctx) and write nothing. They also read block rows of other users
- Functions received through `register_block_listener` are called inside the `BlockUser` transaction. When a function throws, the request is `INTERNAL` and no block row is left

### report

- Report rows are stored in `block_report_report`(scope `game`, column `report_id`, `reporter_id`, `target_id`, `reason_id`, `context`, `ref`, `comment`, `evidence`, `status`, `created_at`, `resolved_at`(0 when `Open`), `resolution`, `expires_at`(`int64?`), key `report_id`, expiry column `expires_at`, personal data user column `reporter_id`, index `(reporter_id, target_id, context, ref)`, `(target_id)`, `(status, created_at)`). `report_id` is an integer that increases from 1 and is never given again. The last given ID is kept in a single `block_report_sequence`(scope `game`, column `id`(one row with value 0), `last_report_id`, key `id`) row. In step 4 of `add_report`, it locks and reads the key 0 row of `block_report_sequence` with `storage.lock_game_row` and uses the value plus 1 as the new `report_id`. When there is no row, the last ID counts as 0. The `expires_at` of an `Open` report is null, so expiry cleanup does not delete it. Report rows of a withdrawn user also stay until `expires_at`
- The report count counter is stored in `block_report_count`(scope `user`, column `user_id`, `window_start`, `count`, `expires_at`, key `user_id`, expiry column `expires_at`, snapshot flag `false`). The counter counts per fixed window of `server-time`. The length is `block-report.reportWindowMs` and the time is the request time. `window_start` is that window start, and `expires_at` is window start + `block-report.reportWindowMs`
- `ReportUser` processing order. A failure changes nothing
  1. `INVALID_REQUEST` when `user_id` is the caller's own
  2. `USER_NOT_FOUND` when `public-profile.is_active_user` is `false`
  3. `add_report`(evidence is the empty string). `REPORT_LIMIT` on `LIMIT`, `INVALID_REQUEST` on `INVALID_INPUT`
- `add_report` processing order
  1. `INVALID_INPUT` when the input meets the `INVALID_INPUT` condition of `ReportResult`
  2. When an `Open` report with the same (reporter, target, `ReportContext`, `ref`) exists, writes nothing and returns `OK`
  3. `LIMIT` when `count` in the current fixed window is `block-report.maxReportsPerWindow` or more
  4. Writes the report row as `Open` and increases `count` by 1. Leaves `report_id`, the target user ID and `reason_id` in an `info` log
- `resolve_report` runs in a game tx opened with `storage.run_game_transaction`, locking and reading the report row with `storage.lock_game_row`. `not_found` when there is no report, `conflict` when it is `Resolved`, `bad_request` when `resolution` is the empty string. Otherwise it sets `status` to `Resolved`, `resolved_at` to `clock_now` and `expires_at` to `resolved_at` + `block-report.reportRetentionMs`, and writes `resolution`. The expiry cleanup of `storage` deletes report rows that reached `expires_at`
- `list_reports` returns up to `limit` reports with that `status` and `from_at` ≤ `created_at` < `to_at`, in ascending order of `(created_at, report_id)`. The rules for the time range and `limit` are the body rules of `admin-api`
- cursor: when `after_created_at` and `after_report_id` are given, returns only reports whose `(created_at, report_id)` is greater than `(after_created_at, after_report_id)`. The next query gives the `created_at` and `report_id` of the last report of the previous query. Giving only one of the two is `bad_request`
- A ban after handling a report is done separately with `admin-api.ban_user`, a chat mute with `chat.mute_chat_user`
- A report on a user's text that content saves and shows to other users (e.g. self-introduction, room name) is left by the content handler with `add_report`. `ReportContext` is the screen that showed the text, `ref` is the identifying string of the text, and `evidence` is the text the handler read from the saved state. When the text is more than `block-report.maxEvidenceBytes` bytes, it is cut at the last UTF-8 character boundary within that byte count
- `remove_user`, inside the user transaction of ctx, changes the `evidence` of report rows whose `target_id` is that user to the empty string. The other columns of those rows and the report rows that user wrote stay as they are

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `in_app_messages` | report reason, comment, reported message and text | `module` | `fraud_prevention` | `true` | `false` | `false` | `true` | `all` | `none` |

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation, own `user_id` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| target that does not exist or is a withdrawn user | `USER_NOT_FOUND` | `USER_NOT_FOUND` | none |
| block count limit | `BLOCK_LIMIT` | `BLOCK_LIMIT` | none |
| report count limit | `REPORT_LIMIT`, `LIMIT` of `add_report` | `REPORT_LIMIT`. For `LIMIT` of `add_report` called by a content handler or hook, the caller decides | `warn` log. reporter user ID |
| `INVALID_INPUT` of `add_report` in `ReportUser` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `INVALID_INPUT` of `add_report` called by a core module, content handler or hook | `INVALID_INPUT` | the caller decides | `error` log |
| throw of a listener function | throw | `INTERNAL` | `routing` writes an `error` log |
| second `register_block_listener` registration of the same function | server start failure | none | `error` log |
| lock wait timeout on the `block_report_sequence` row in step 4 of `add_report` | throw | `INTERNAL` | `routing` writes an `error` log |
| lock wait timeout on the report row in `resolve_report` | `internal` | none | error rules of `admin-api` |
| `resolve_report` with an empty `resolution` | `bad_request` | none | `audit` |
| `resolve_report` of a report that does not exist | `not_found` | none | `audit` |
| `resolve_report` of a `Resolved` report | `conflict` | none | `audit` |
| only one of `after_created_at`, `after_report_id` given to `list_reports` | `bad_request` | none | error rules of `admin-api` |
| body rules violation in `list_reports`, `resolve_report` | `bad_request` | none | error rules of `admin-api` |

Added `CoreError`: `BLOCKED`, `BLOCK_LIMIT`, `REPORT_LIMIT`. `friend` and `chat` return `BLOCKED` when they do not handle a request because there is a block between the two users

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `block-report.maxBlocks` | integer | core | content | block count limit per user |
| `block-report.reportWindowMs` | integer | core | content | fixed window length of the report count counter. 1 or more |
| `block-report.maxReportsPerWindow` | integer | core | content | report count limit per fixed window |
| `block-report.reportRetentionMs` | integer | core | content | duration a `Resolved` report is kept from `resolved_at` |
| `block-report.maxRefBytes` | integer | core | content | maximum bytes of `ref`. At least `CHAT_CHANNEL_KIND_DIRECT:<int64>:<int64>:<int64>`(84 bytes) of `chat`, the longest `ref` a core module makes. The core settings schema checks it |
| `block-report.maxCommentLength` | integer | core | content | maximum code point count of `comment` |
| `block-report.maxEvidenceBytes` | integer | core | content | maximum bytes of `evidence` |

## data

`data/tables/report_reason.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |

- client content code builds the reason list of the report screen from this table

## DEV

none

## test

- After `BlockUser`, `is_blocked` is `true`, and after `UnblockUser`, `false`. A second `BlockUser` on the same target succeeds and there is one block row
- A `user_id` that is the caller's own or 0 is `INVALID_REQUEST`, a user that does not exist is `USER_NOT_FOUND`, and reaching the limit is `BLOCK_LIMIT`
- A row blocking a withdrawn user is deleted at the next `BlockUser` and does not count toward the limit
- A registered listener is called once inside the `BlockUser` transaction. When the listener throws, the result is `INTERNAL` and there is no block row
- `GetBlockedUsers` is in descending order of `blocked_at` and leaves out withdrawn users
- `is_blocked_either` is `true` for a block in either direction
- A second report with the same target, the same `ReportContext` and the same `ref` makes no further report and succeeds
- When the report count in a fixed window reaches `block-report.maxReportsPerWindow`, the next report is `REPORT_LIMIT`, and reports are accepted again in the next fixed window
- When two users report concurrently, the `report_id` of the two reports differs
- `INVALID_REQUEST` when `reason_id` is not in `report_reason`, `context` is `_UNSPECIFIED`, or `comment` breaks the plain text condition
- `resolve_report` writes `Resolved` and `resolution`; a second call with a different `operation_id` is `conflict`, and one with the same `operation_id` returns the first output
- `list_reports` returns the reports selected by status and time range in ascending order of `(created_at, report_id)`. Even when more reports than `limit` share the same `created_at`, continuing with queries whose cursor is the last report of the previous query gets every report once. A query that gives only one of the cursor fields is `bad_request`
- After `Withdraw`, that user's block rows are gone and that user's report rows stay. `admin-api.export_personal_data` includes the report rows that user wrote
- A report resolved with `resolve_report` is deleted by the expiry cleanup after it reaches `resolved_at` + `block-report.reportRetentionMs`, and an `Open` report of the same time stays
- When the target user of a chat report does `Withdraw`, the `evidence` of reports targeting that user is the empty string, and the report rows and their other columns stay as they are
- `add_report` called by a content handler writes the report row with the passed `evidence`, and `list_reports` returns that `evidence`. An `evidence` longer than `block-report.maxEvidenceBytes` is `INVALID_INPUT` and there is no report row
