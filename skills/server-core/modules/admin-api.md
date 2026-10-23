# admin-api

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

Owns the HTTP API with which an operator queries and changes the live game. Owns operator authentication, role check and the `audit` log of every admin operation, and itself exports the admin operations that other modules and content do not export.

## dependency

- `storage`
- `server-time`
- `logging`
- `item-ledger`
- `mailbox`
- optional dependency: `iap`, `ranking`

admin-api does not depend on `routing`. admin-api exports the route `POST /admin/<operation>` and `routing` collects it. Other modules export admin operations whose caller in `## API` is `operator`, and `routing` collects them at server start and passes them to admin-api with `register_admin_operation`. `routing` also passes the content admin operations that content `server/main.ts` registered with `routing.register_admin_operation`, under module name `game`. An operation whose caller is `admin-api` is an internal operation that admin-api calls, not an admin operation. admin-api does not depend on modules that only export admin operations.

## API

operator: a caller that has a name, a role list and an admin secret in game settings `environments.<ENV>.adminOperators`. Humans and the harness tool. The harness tool is the operator named `ogw`. An admin operation is `POST /admin/<operation>`. The LOCAL server and the test server use the operators below instead of `adminOperators`, regardless of environment. The admin secret is the value of `server.read_secret`(`adminSecret.<operator name>`)

- `ogw`: all of roles `read`, `ops`, `economy`, `release`, `privacy`
- `read`, `ops`, `economy`, `release`, `privacy`: the one role equal to the name. Only those whose key `adminSecret.<operator name>` is in the `--secret-file` file are operators

admin operations of admin-api

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_user` | `user_id` | `user_id`, `created_at`, `withdrawn_at`, `ban`, `user_state`, `server_state` | `not_found` | operator |
| `export_personal_data` | `user_id` | personal data JSON file | `not_found`, `too_large` | operator |
| `grant_items` | `operation_id`, `user_id`, `items` | `result` | `not_found`, `conflict` | operator |
| `revoke_items` | `operation_id`, `user_id`, `items` | `result`, `shortfall` | `not_found`, `conflict` | operator |
| `list_item_history` | `user_id`, `from_at`, `to_at`, `after_seq`, `limit` | `entries` | `bad_request` | operator |
| `list_payments` | `user_id` | `payments`, `other_user_attempts` | `not_found` | operator |
| `send_mail` | `operation_id`, `user_id`, `mail` | `mail_id` | `not_found`, `conflict`, `bad_request` | operator |
| `broadcast_mail` | `operation_id`, `mail`, `start_at` | `broadcast_id` | `conflict`, `bad_request` | operator |
| `cancel_broadcast` | `broadcast_id` | empty object | `not_found` | operator |
| `remove_ranking_user` | `user_id` | empty object | `not_found` | operator |
| `ban_user` | `user_id`, `until_at`, `reason` | empty object | `not_found` | operator |
| `unban_user` | `user_id` | empty object | `not_found` | operator |
| `set_maintenance` | `enabled` | empty object | none | operator |
| `set_kill_switch` | `request_name`, `enabled` | empty object | `not_found`, `conflict` | operator |
| `get_switches` | none | `maintenance`, `kill_switches` | none | operator |

Admin operations that other modules export and `routing` passes with `register_admin_operation`. The spec of that module sets input, output and failure value. The set of (module, admin operation) of this table without the `game` row equals the set of operations whose `caller` cell is `operator` in the `## API` tables of server module specs outside admin-api, and `ogw docs check` compares the two.

| module | admin operation | role |
|---|---|---|
| `auth` | `withdraw_user` | `ops` |
| `auth` | `find_user_by_social_account` | `read` |
| `logging` | `list_client_errors`, `list_client_events`, `list_server_events` | `read` |
| `game-update` | `get_deploy_list`, `get_update_signing_key` | `read` |
| `game-update` | `put_update_file`, `publish_deploy_list`, `prune_update_files` | `release` |
| `push` | `get_push`, `list_pushes` | `read` |
| `push` | `schedule_push`, `cancel_scheduled_push` | `ops` |
| `migration` | `get_migration_batch` | `read` |
| `migration` | `start_migration_batch`, `stop_migration_batch` | `release` |
| `user-snapshot-clone` | `export_user_snapshot`, `sample_user_ids`, `list_clones`, `export_game_state`, `sample_game_state` | `read` |
| `user-snapshot-clone` | `import_user_snapshot`, `wipe_clone`, `import_game_state` | `ops` |
| `coupon` | `get_coupon`, `list_coupon_codes` | `read` |
| `coupon` | `create_coupon`, `disable_coupon` | `economy` |
| `notice` | `list_notices` | `read` |
| `notice` | `put_notice`, `delete_notice` | `ops` |
| `remote-config` | `list_remote_config` | `read` |
| `remote-config` | `set_config_value`, `clear_config_value`, `put_experiment`, `stop_experiment` | `ops` |
| `nickname` | `find_user_by_nickname` | `read` |
| `nickname` | `rename_user` | `ops` |
| `gacha` | `list_gacha_history` | `read` |
| `iap` | `revoke_test_grant` | `economy` |
| `block-report` | `list_reports` | `read` |
| `block-report` | `resolve_report` | `ops` |
| `guild` | `get_guild` | `read` |
| `guild` | `rename_guild`, `set_guild_description`, `set_guild_member_role`, `kick_guild_member`, `disband_guild`, `import_guild` | `ops` |
| `chat` | `list_chat_messages` | `read` |
| `chat` | `delete_chat_message`, `mute_chat_user`, `unmute_chat_user` | `ops` |
| `game` | content admin operation. The name starts with `game_` | the role set when that operation is registered |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `POST /admin/<operation>` (route) | HTTP request, client IP | HTTP status, JSON body | processing order below | `routing` |
| `register_admin_operation` | name of the exporting module, admin operation | none | none. A registration error is a server start failure | `routing`. Called at server start |
| `is_maintenance` | none | `true` when maintenance is on | none | `routing`, `auth`, `matchmaker`, `notice` |
| `is_banned` | user ID | `banned`(`true` when the user is a ban target), `until_at`(the `until_at` of that ban. 0 when the user is not a ban target) | none | `routing`, `auth`, `matchmaker` |
| `ip_in_cidrs` | client IP, list of CIDR strings | `true` when the client IP is in one of those CIDRs | `false`. A string that is not a CIDR contains no IP | `routing` |
| `is_kill_switched` | request name or `MATCH_REQUEST` | `true` when the kill switch is on | none | `routing`, `matchmaker` |

- `items`: list of `{item_id, amount, big_amount}`. It is `ItemAmount` of `item-ledger`, and the amount is the contract's big encoding pair `amount`, `big_amount`. `big_amount` is optional and is the empty string when absent. The input check of `item-ledger` judges the range of the amount
- `shortfall`: a list in the same format as `items`. Holds, in the same order, the amount not revoked for each item of input `items`
- `mail`: a mail input JSON value of `mailbox`. admin-api converts it into a mail input with `mailbox.mail_input_from_json`
- `ban`: `null` when the user is not a ban target, otherwise `{until_at, reason, banned_at}`
- output JSON of `get_user`: `withdrawn_at` is `null` when the user is not a withdrawn user
- `until_at`: the time the ban ends. 0 means it does not end
- `result`(`grant_items`, `revoke_items`): an element name of `ItemChangeResult` of `item-ledger`
- `payments`, `other_user_attempts`(`list_payments`): the list of payment records that `iap.list_payments` returned and the list of `OTHER_USER` records
- field types of admin-api that are not in the common admin field table: `mail` is `json`, `enabled` is `bool`, `request_name` is `string`, `broadcast_id` is `int64`
- An admin operation that a module exports holds the items below. Collected operations also follow this spec's processing order, authentication, body rules, user-targeted operation rules, `operation_id` rules and `audit` log
  - name
  - role: one of `read`, `ops`, `economy`, `release`
  - body format: `json` or `binary`. With `binary`, a byte limit is added
  - input field: per field name, the field type and whether it is required. The input fields of a `binary` body operation are the query string and use only `int64`, `int32`, `string`
  - `user_target`: for a user-targeted operation, the name of the `int64` input field that holds the target user ID. Otherwise none
  - handler function: the input is the input that passed the body check, the transaction, and the prepare value when there is a prepare function; the output is an output JSON object or a failure reason (`bad_request`, `not_found`, `conflict`, `external_failed`, `internal`). The transaction is the target user's out-of-request ctx that admin-api opened with `storage.run_user_transaction` when there is `user_target`, otherwise the game tx opened with `storage.run_game_transaction`. On a failure reason, admin-api rolls back that transaction
  - prepare function(optional): the input is the input that passed the body check; the output is a prepare value or a failure reason (`bad_request`, `not_found`, `conflict`, `external_failed`). It takes the work that is not to be done with a transaction open (e.g. an external service call). When the prepare function opens a transaction, it commits that transaction inside the prepare function
  - audit args function(optional): the input is the input that passed the body check; the output is `args` of the `audit` log. Only operations whose spec sets `args` separately have one
- TypeScript shape of an admin operation: object `{name, role, body, max_body_bytes, input, user_target, handler, prepare, audit_args}`. `body` is `'json'` or `'binary'`, and `max_body_bytes` is the byte limit of a `binary` body. `input` is `{type, optional}` per input field name, and `type` is one of `{kind: 'int64'}`, `{kind: 'int32'}`, `{kind: 'bool'}`, `{kind: 'string'}`, `{kind: 'json'}`, `{kind: 'enum', elements}`, `{kind: 'array', element}`, `{kind: 'object', fields}`, `{kind: 'object_union', fields}`. `user_target` is a field name or `null`. The functions are `handler(input, transaction, prepare value, body)`, `prepare(input, body)`, `audit_args(input, body)`, and `body` is the bytes of a `binary` body, `null` for a `json` body. A failure reason is the string of its name, and a prepare value is not a failure reason string. In the input that passed the check, `int64` is `bigint`, `int32` is `number`, `enum` is the element name, and a missing optional field has no key
- In every admin operation, `int64` values of output JSON are decimal strings, bytes are standard base64, and enum values of the base proto and data are element names. admin-api writes a `bigint` that a handler function returned as a decimal string
- admin-api calls the prepare function and the handler function inside `logging.with_audit_actor`(operator name, function)
- field type: `int64`, `int32`, `bool`, `string`, `enum{element, ...}`(the value is the element name of one of the listed enum elements), `array<T>`, `object{field name: type, ...}`, `object union{key: type, ...}`(an object that has exactly one of the listed keys), `json`(one JSON value. The handler function checks it)
- spec notation of admin operations. The admin operations of admin-api and the collected operations use the same notation
  - The input column of the `## API` table lists the input field names. Only a field with `(optional)` after its name is optional; the rest are required. Fields of an `object` type use the same notation
  - The field type is the type in the common admin field table below. The spec of the operation writes the type of a field that is not in the table
  - The body format is `binary` only for operations that the spec calls binary body operations; the rest are `json`
  - The spec of the collected operations writes `user_target` per operation. An operation for which it is not written has none

common admin field

| field | field type |
|---|---|
| `user_id`, `target_user_id` | `int64` |
| `operation_id`, `reason` | `string` |
| field whose name ends with `_at` | `int64` |
| `after_seq` | `int64` |
| `limit` | `int32` |
| `items` | `array<object{item_id: int32, amount: int64, big_amount(optional): string}>` |

## behavior

- `once_key` prefix: `admin:`

### processing order

Handles one admin request in the order below. When a step fails, responds with that step's HTTP status and `{"error":"<reason>"}`. Whichever step it ends at, it leaves one line of `audit` log.

1. IP: when game settings `environments.<ENV>.adminAllowedCidrs` is not `null` and the client IP is in none of those CIDRs, 403 `forbidden`. When the number of authentication failures of that IP in the current minute window is `admin-api.authFailuresPerMinute` or more, 429 `rate_limited`
2. authentication: `Authorization` is `Bearer <operator name>.<admin secret>`. When the operator name is not in `adminOperators` or the admin secret does not equal that operator's secret value, 401 `unauthorized`. The secret comparison runs in constant time. On failure, increments the IP counter by one
3. operation: when it is not a registered operation name, 404 `not_found`. When the operator's role list does not have the operation's role, 403 `forbidden`
4. body limit: when the accumulated body exceeds `admin-api.maxBodyBytes` (for a binary body operation, the limit that its module set) or the total read duration exceeds `admin-api.bodyReadTimeoutMs`, 400 `bad_request`. The body is first read in this step. Steps 1 to 3 look only at the request line and headers
5. body check: when the body violates the body rules below, 400 `bad_request`
6. handling: when there is a prepare function, calls it after the target user check of a user-targeted operation and before opening the transaction, outside the transaction. At that point the `operation_id` row is not yet looked at. On a failure reason, does not call the handler function and ends with that failure value. Then calls the handler function. Success is 200 with the output JSON; failure is the operation's failure value

- The body is one JSON object. For an operation registered with a binary body, the body is raw bytes and the input is the query string
- The IP is the client IP that `routing` passed to the route handler. The IP counter counts per minute window of `server-time`. The counter is kept in table `admin_api_ip_counter` and registered with `storage.register_table`: scope `game`, column `ip`, `window_start`, `count`, `expires_at`, key `(ip, window_start)`, expiry column `expires_at`. `window_start` is the window start of that minute window, and `expires_at` is the window end
- On each authentication failure of step 2, one `storage.run_game_transaction` increments by 1 the `count` of the row of that IP and the current minute window, and commits. The count stays however that request ends later. Step 1 only reads that row's `count`. When there is no row, it is 0
- Admin paths do not emit CORS headers

### role

- The role is decided by what the operation does. `read` is a query that does not change saved state and is not a personal data export, `ops` is service operation (ban, maintenance, kill switch, notice, remote config, push, withdrawal, clone, forced nickname change, ranking exclusion, report handling, guild name and description change, guild member role change and kick, guild disband and making guilds for reproduction, chat message deletion and mute), `economy` is item, mail, coupon and payment adjustment, `release` is update file, deploy list and migration batch, and `privacy` is the export of a user's personal data
- roles of the admin operations of admin-api: `read` is `get_user`, `list_item_history`, `list_payments`, `get_switches`. `privacy` is `export_personal_data`. `ops` is `remove_ranking_user`, `ban_user`, `unban_user`, `set_maintenance`, `set_kill_switch`. `economy` is `grant_items`, `revoke_items`, `send_mail`, `broadcast_mail`, `cancel_broadcast`
- The role of a collected operation is the value in the collected operation table and equals the role that its module exported
- For the handler function of a collected operation or content admin operation whose role is `read`, admin-api wraps that transaction (the target user's ctx or the game tx) in `storage.run_read_only` and calls the handler function. A write inside the handler function is a misuse of `storage`, so it throws and the result is 500 `internal`

### body rules

- A missing required field, an unknown field and a type mismatch are `bad_request`. Does not convert a bool to an integer or a numeric string to an integer
- `user_id` is an integer of 1 or more. An `int64` value accepts both a JSON integer and a decimal integer string. Rejects decimals and exponent notation
- When `big_amount` of `items` is neither the empty string nor a contract big integer, `bad_request`
- The time range is from `from_at` inclusive to `to_at` exclusive, and `to_at − from_at` is at least 1 and at most `admin-api.maxSearchRangeMs`
- `limit` is at least 1 and at most `admin-api.maxSearchRows`
- `after_seq` is an integer of 0 or more. 0 means from the start of the range; otherwise it is the sequence of the last row of the previous query
- A string is at most `admin-api.maxStringBytes`, and `operation_id` is not empty
- `request_name` is in request name format (`<Name>`, `core/<Name>`, `cheat/<Name>`, `core/cheat/<Name>`) or is `MATCH_REQUEST`

### user-targeted operation

- User-targeted operations are the operations of admin-api whose input has `user_id` (except `list_item_history`) and the collected operations given `user_target`. After step 5, when `storage.get_user_record` of the target user is none or has `withdrawn_at`, does not call the handler function, does not change saved state, and returns 404 `not_found`. admin-api judges user existence and withdrawal by the user record of `storage`, not by `auth`
- Exception: `get_user`, `export_personal_data`, `list_payments` also accept a withdrawn user and are 404 only when `get_user_record` is none. `get_user` of a withdrawn user returns it with `withdrawn_at`
- `grant_items`, `revoke_items`, `send_mail`, `remove_ranking_user` run as one out-of-request change (`storage.run_user_transaction`) of the target user. The change becomes that user's pending delta
- The change source of `grant_items`, `revoke_items` is source `Admin`, `ref` the operation name, `once_key` `admin:<operation name>:<operation_id>`
- `grant_items` calls `item-ledger.add_items`. `OK` and `ALREADY_APPLIED` are 200 and return that element name as `result`. With `ALREADY_APPLIED` the balance is unchanged. With any other failure element, returns 409 `conflict` and that element name as `result`
- `revoke_items` calls `item-ledger.revoke_items`. When it revokes more than the balance, the balance stops at 0 and the missing amount is `shortfall`. `OK` and `ALREADY_APPLIED` are 200 and return that element name as `result`. With `ALREADY_APPLIED` the balance is unchanged and `shortfall` is an empty list. With any other failure element, returns 409 `conflict` and that element name as `result`
- The handler function of a content admin operation that has `user_target` is called inside `storage.with_hook_change_source`(the target user's ctx, `Admin`, operation name)
- `list_item_history` calls `item-ledger.list_history` with `after_seq` as the cursor, `list_payments` calls `iap.list_payments`, `send_mail` calls `mailbox.send_mail`, `broadcast_mail` calls `mailbox.broadcast_mail`, `cancel_broadcast` calls `mailbox.cancel_broadcast`, and `remove_ranking_user` calls `ranking.remove_user`. When `cancel_broadcast` is `false`, 404 `not_found`. `broadcast_mail`, `cancel_broadcast` make that call in one game tx opened with `storage.run_game_transaction`
- When `iap` is not in the server module list, `list_payments` is not registered, and when `ranking` is not, `remove_ranking_user` is not registered. Such a request is 404 `not_found` at step 3 of the processing order
- When the `MailResult` of `mailbox.mail_input_from_json`, `send_mail`, `broadcast_mail` is `INVALID_INPUT`, 400 `bad_request`. `ALREADY_SENT` of `send_mail` is 200 and `mail_id` is the ID of the mail that already exists
- `operation_id`: an admin operation whose input has `operation_id`, collected operations included, follows this rule
  - admin-api locks and reads the `(operation name, operation_id)` row of `admin_api_operation` with `storage.lock_game_row`, in the same transaction as the handler function
  - When the row exists, does not call the handler function. When the row's `input_sha256` equals that of this input, returns the row's `output`; otherwise 409 `conflict`
  - When there is no row and the handler function returns an output, writes the row in the same transaction. A request that ended with a failure reason or an exception is not recorded
  - `admin_api_operation`: scope `game`, column `operation`, `operation_id`, `input_sha256`(lowercase hex SHA-256 of the UTF-8 of `storage.canonical_json` of the input that passed the check), `output`, `created_at`, `expires_at`, key `(operation, operation_id)`, expiry column `expires_at`. `expires_at` is `created_at` + `admin-api.operationIdRetentionMs`. Registered with `storage.register_table`
- `get_user` reads `get_state`, `list_state` with `run_read_only` in one transaction of the target user opened with `storage.run_user_transaction`, and writes nothing. When `WITHDRAWN`, `user_state`, `server_state` are empty objects. The JSON is made with the proto3 JSON code that the contract tool generated. `user_state`, `server_state` use the snake_case of the kind name as key. A single kind is the message's proto3 JSON object, and a list kind is its array

### personal data export

- `export_personal_data` makes the JSON file that answers a user's request to view their personal data. It reads with `run_read_only` in one transaction of the target user opened with `storage.run_user_transaction`, and writes nothing. A withdrawn user is read with `storage.read_db` and `user_state` is an empty object
- The file is one JSON object

| key | value |
|---|---|
| `user_id` | decimal string |
| `created_at` | value of `storage.get_user_record` |
| `exported_at` | request time |
| `user_state` | same format as `user_state` of `get_user` |
| `tables` | an array of rows per table name that `storage.export_user_rows` returned. A row is an object keyed by column name, and `int64` is a decimal string |

- The tables in `tables` are the tables given a personal data user column in `register_table`, with the rows where that column is the target user ID. Accepts both scope `user` and `game`. The module that registered a table decides which tables hold personal data. admin-api does not know module names
- Does not include server state
- The response is 200, `Content-Type: application/json`, `Content-Disposition: attachment; filename="personal-data-<user_id>.json"`, and the body is the file
- When the UTF-8 byte length of the file exceeds `admin-api.maxExportBytes`, 413 `too_large`
- `args` of the `audit` log is only `user_id`, and the log keeps neither the file contents nor `body_sha256`

### ban, maintenance, kill switch

- All three are kept in the tables below. They stay after a server restart

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `admin_api_ban` | `game` | `user_id`, `until_at`, `reason`, `banned_at` | `user_id` | none |
| `admin_api_switch` | `game` | `kind`(`maintenance`, `kill_switch`), `target`, `updated_at` | `(kind, target)` | none |

- Both tables are registered with `storage.register_table`
- The personal data user column of `admin_api_ban` is `user_id`
- `ban_user` inserts or replaces that user's `admin_api_ban` row. `banned_at` is the request time. `unban_user` deletes that row
- There is one `admin_api_switch` row per switch that is on. Maintenance is `kind` `maintenance`, `target` the empty string, and a kill switch is `kind` `kill_switch`, `target` the request name or `MATCH_REQUEST`. When `enabled` is `true`, `set_maintenance`, `set_kill_switch` insert the row or update its `updated_at`; when it is `false`, they delete the row
- `is_banned` is `true` when the user has an `admin_api_ban` row and `until_at` is 0 or `server-time.clock_now` < `until_at`
- When `request_name` of `set_kill_switch` is not the request name of an `rpc` of `service Game` or base proto `service Core` and is not `MATCH_REQUEST`, 404 `not_found`; when it is an element of `NoAccessTokenRpc`, 409 `conflict`
- A server instance caches the maintenance and kill switch state in memory. The job `admin_switch_cache` (period `admin-api.switchCacheMs`) that admin-api schedules at server start with `server-time.schedule_job` reads it again with `storage.read_db`. The server instance that made a change updates its own cache at once
- Bans are not cached. `is_banned` reads the user's `admin_api_ban` row with `storage.read_db` on each request

### audit log

- One line of `kind` `audit` log per admin request: `request` is the operation name, `user_id` is the target user (`null` when there is none), `actor`(the name of the operator that passed step 2. `null` when the request ended before that), `ip`(truncated IP), `status`(HTTP status), `error`(the reason, `null` on success), `args`(the input that passed the check)
- When the spec of a collected operation sets `args` separately, the value that the audit args function of that operation returned is used. e.g. `import_user_snapshot`
- `args` does not hold binary bodies or secrets. For a binary body, the SHA-256 hex is kept in `body_sha256`
- `args` of a request that ended in steps 1 to 4 is `null`
- No admin operation deletes or changes the `audit` log

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| body limit, body rules violation, `INVALID_INPUT` of mail | 400 `bad_request` | `audit` |
| authentication failure | 401 `unauthorized` | `audit`, `security` |
| IP outside `adminAllowedCidrs`, operation outside the operator's roles | 403 `forbidden` | `audit`, `security` |
| IP authentication failure limit exceeded | 429 `rate_limited` | `audit`, `security` |
| unknown operation, no target | 404 `not_found` | `audit` |
| `operation_id` input mismatch, item change failure, kill switch target not allowed | 409 `conflict` | `audit` |
| personal data export file over the limit | 413 `too_large` | `audit`, `error` |
| external service call failure | 502 `external_failed` | `audit`, `error` |
| unhandled exception | 500 `internal` | `audit`, `error`(stack trace) |
| `internal` of the handler function | 500 `internal` | `audit`, `error` |

- When `adminOperators` has the same name twice or the secret of any operator cannot be read, the server does not start. When a collected operation has no role or a role outside the allowed values, the server does not start. The server also does not start when a collected operation or content admin operation whose role is `read` has `operation_id` in its input fields
- When two modules export the same admin operation name, an exported name overlaps an operation name of admin-api, or a content admin operation name does not start with `game_`, the server does not start
- Calling `register_admin_operation` after server start has finished throws

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `environments.<ENV>.adminOperators` | array<object> | game | none | per operator, `name`, `roles`, `secret`(the name of the secret in the host secret store that holds the admin secret) |
| `environments.<ENV>.adminAllowedCidrs` | array<string>? | game | none | list of CIDRs of the client IPs whose admin requests are accepted. `null` means no blocking by IP |
| `admin-api.maxBodyBytes` | integer | core | content | max bytes of a JSON body |
| `admin-api.bodyReadTimeoutMs` | integer | core | content | total time limit for reading the body |
| `admin-api.authFailuresPerMinute` | integer | core | content | authentication failure limit per IP in one minute window |
| `admin-api.maxStringBytes` | integer | core | content | max bytes of a body string |
| `admin-api.maxSearchRangeMs` | integer | core | content | max length of a query time range |
| `admin-api.maxSearchRows` | integer | core | content | max number of rows of a query result |
| `admin-api.operationIdRetentionMs` | integer | core | content | duration that `operation_id` records are kept |
| `admin-api.switchCacheMs` | integer | core | content | interval at which the maintenance and kill switch cache is read again |
| `admin-api.maxExportBytes` | integer | core | content | max bytes of the `export_personal_data` file |

## data

none

## DEV

none. The admin API exists in every environment

## test

- An unknown operator name and a wrong secret are 401, and when IP authentication failures reach the limit, a correct secret is also 429 in that minute window
- A request without `Authorization` is 401 without the body being read, even when the body is larger than `admin-api.maxBodyBytes`
- A request from an IP outside `adminAllowedCidrs` is 403 even with a correct secret, and the handler function is not called
- When `adminAllowedCidrs` is `null`, a request with a correct secret from any IP does not become 403 at step 1
- Every `audit` log has `actor`, and the `actor` of a request that passed step 2 is that operator name
- Authentication failures of the same IP sent split across two server instances started with `testing.start_peer_server` accumulate in one IP counter, and when the sum reaches `admin-api.authFailuresPerMinute`, both instances are 429
- The results of `ban_user`, `set_maintenance`, `set_kill_switch` stay after `restart_test_server`, and after `unban_user` and `enabled` `false` the row is gone
- At each step of the processing order, a failing request ends with the set status, saved state does not change, and one line of `audit` log is left
- An unknown field, a bool for an integer field, a decimal `user_id` and an out-of-range `limit` are 400
- `grant_items` for a withdrawn user and for a nonexistent user are 404 and the balance is unchanged
- The balance change of `grant_items` arrives as a pending delta in the next successful response of the target user
- Two `grant_items` with the same `operation_id` change the balance only once and return the same output. With a different input, 409
- `grant_items` and `revoke_items` with the same `operation_id` both apply, and the `once_key` values in the `item-ledger` history are `admin:grant_items:<operation_id>`, `admin:revoke_items:<operation_id>`
- After `grant_items` with `operation_id` `mail:<mail ID>`, `ClaimMail` of that mail by that user grants the attachments
- A request whose handler function threw or returned a failure reason leaves no `admin_api_operation` row, and a retry with the same `operation_id` calls the handler function again
- Of two concurrent requests with the same `operation_id`, only one calls the handler function
- A collected operation given `user_target` does not call the handler function for a nonexistent user or a withdrawn user, and is 404
- A body whose `object union` field has two keys or no key, and a value outside the `enum`, are 400
- `revoke_items` does not take the balance below 0 and returns `shortfall`
- `revoke_items` with an `item_id` that is not in the `item` table is 409 `conflict` with `result` `UNKNOWN_ITEM`, and the balance is unchanged
- `grant_items` with `big_amount` `12345678901234567890` on a big item whose `max_digits` is 20 adds that amount, and `revoke_items` with the same `items` revokes that amount. `grant_items` whose `big_amount` is not a big integer is 400 `bad_request`, and `grant_items` that gives an item that is not a big item a `big_amount` over 2^53−1 is 409 `conflict` with `result` `INVALID_AMOUNT`, and the balance is unchanged
- A game request of a banned user is `BANNED`, and is handled once `until_at` has passed. Right after `unban_user`, it is handled
- After `set_maintenance`, every server instance answers `MAINTENANCE` within `admin-api.switchCacheMs`, and after it is turned off, they handle requests within the same duration
- A request whose kill switch is on is `FEATURE_DISABLED`, and other requests are handled. Turning it on for `core/Login`, `core/GetNotices` is 409, and for `MATCH_REQUEST` it turns on. Turning it on for game `rpc` `Login` makes only that game `rpc` `FEATURE_DISABLED`, and `core/Login` is handled. A name that starts with `cheat/` is 404
- Ban, maintenance and kill switch stay after a server restart
- The JSON of `get_user` follows the rules for kind names, field names and `int64` strings
- The `audit` log has no secrets and no binary bodies
- The `ip` of the `audit` log is a truncated IP
- For each operation of the collected admin operation table, a request of an operator that has its role calls the handling of that module, a wrong secret is 401, and an operator without that role gets 403 `forbidden`. The same holds per role for the admin operations of admin-api
- After `cancel_broadcast`, the next request of a user who has not yet received the mail does not have that broadcast mail
- After `remove_ranking_user`, that user is not in ranking query results
- `tables` of `export_personal_data` has only that user's rows of the `user`, `game` scope tables registered with a personal data user column, and no rows of other users and no unregistered tables. `Content-Disposition` is attachment
- `export_personal_data` for a nonexistent user is 404, and a file over the limit is 413
- The `audit` log of `export_personal_data` has no file contents
- `get_user` for a user who has rows of a contract version lower than the current one returns the converted values, the saved rows and their contract version stay unchanged, and no pending delta is made
- `get_user` for a withdrawn user is 200 with `withdrawn_at`, and `user_state`, `server_state` are empty. A nonexistent user is 404
- `send_mail` and `broadcast_mail` whose `attachments` exceed the limit are 400. A second `send_mail` sent with a different `operation_id` and the same `once_key` is 200 and `mail_id` is the ID of the first mail
- `export_personal_data` and `list_payments` for a withdrawn user are 200, and `tables` of `export_personal_data` has the remaining payment records
- A content admin operation that starts with `game_` follows the processing order, authentication, `operation_id` rules and `audit` log, and when it has `user_target`, `add_items` inside the handler function is recorded with source `Admin` and ref the operation name
- In a collected operation that has a prepare function, the prepare function is called once outside the transaction before the handler function, and its prepare value is passed to the handler function. When the prepare function returns a failure reason, the handler function is not called and the status is that of the failure value
- When the handler function of a content admin operation whose role is `read` writes saved state, with `user_target` and without it, the result is 500 `internal` and saved state is unchanged. A content admin operation whose role is `read` and whose input fields have `operation_id` blocks server start
