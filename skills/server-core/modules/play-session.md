# play-session

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

Handles the start, continue and finish of one single-player play round (play session) whose result client simulation decides. At start, the server sets the play session ID and the start time and handles the cost of the choices made before the round starts with a content hook; at continue, it handles that cost with a content hook; at finish, it checks the result with the minimum duration of the data and a content verification hook, then applies it only once with a content hook.

## dependency

- `storage`
- `server-time`
- `logging`
- `validation`
- `item-ledger`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `StartPlaySession` (core rpc, `retry`). changes: `content` | `mode_id`, `level_id`, `options` | `play_session_id`, `started_at`, `loadout` | `INVALID_REQUEST`, `INTERNAL`, `GameError` of a hook | `routing`. Client content code sends it |
| `ContinuePlaySession` (core rpc, `retry`). changes: `content` | `play_session_id`, `options` | `continue_count` | `INVALID_REQUEST`, `PLAY_SESSION_NOT_FOUND`, `PLAY_SESSION_EXPIRED`, `PLAY_SESSION_CONTINUE_LIMIT`, `GameError` of a hook | `routing`. Client content code sends it |
| `FinishPlaySession` (core rpc, `retry`). changes: `content` | `play_session_id`, `result` | `result`: applied `PlaySessionResult` bytes | `INVALID_REQUEST`, `PLAY_SESSION_NOT_FOUND`, `PLAY_SESSION_EXPIRED`, `PLAY_SESSION_TOO_FAST`, `PLAY_SESSION_REJECTED`, `GameError` of a hook | `routing`. Client content code sends it |
| `get_active_play_session` | ctx | play session record of the ctx user's active play session. none when there is no active play session | none | content handler, hook |
| `refund_entry` | ctx, play session record, list of `ItemAmount` | `ItemChangeResult.OK` | failure element of `ItemChangeResult` or `GameError` of a hook. A call outside `apply_play_session` throws | content `apply_play_session` hook |

- `mode_id`: ID value of `play_session_mode`
- `level_id`: ID value of a target that content defines (e.g. a stage). 0 means no target. Hook `prepare_play_session` gives its meaning and checks it
- `result`: bytes of the `PlaySessionResult` message that the game defines in `service.proto`
- `play_session_id`: UUID v4 string
- `options`: for `StartPlaySession`, bytes of the `PlaySessionStartOptions` message that the game defines in `service.proto`, holding the choices made before the round starts (e.g. booster). For `ContinuePlaySession`, bytes of the `PlaySessionContinueOptions` message that the game defines, holding the choices of one continue (e.g. the kind of added moves). Empty bytes are a message whose fields all have default values
- `continue_count`: the continue count of that play session, this continue included
- `loadout`: bytes of the `PlaySessionLoadout` message that the game defines in `service.proto`. Hook `prepare_play_session` returns it holding the user state that decides the result of that round (e.g. team, equipment stats). Client simulation uses it, and it goes to the hooks as `loadout` of the play session record. For a game that does not use it, it is empty bytes
- `PlaySessionResult`, `PlaySessionLoadout`, `PlaySessionStartOptions` and `PlaySessionContinueOptions` are module messages. A game that uses this module must define `PlaySessionResult`. Each of the other three is defined only by a game that uses that message

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `StartPlaySessionRequest` | `mode_id` | `int32` | `table`: `play_session_mode` |
| `StartPlaySessionRequest` | `level_id` | `int32` | `min`: 0, `max`: 2^31−1 |
| `StartPlaySessionRequest` | `options` | `bytes` | `max_len_key`: `play-session.optionsMaxBytes` |
| `ContinuePlaySessionRequest` | `play_session_id` | `string` | `max_len`: 36 |
| `ContinuePlaySessionRequest` | `options` | `bytes` | `max_len_key`: `play-session.optionsMaxBytes` |
| `FinishPlaySessionRequest` | `play_session_id` | `string` | `max_len`: 36 |
| `FinishPlaySessionRequest` | `result` | `bytes` | `max_len_key`: `play-session.resultMaxBytes` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `StartPlaySessionResponse` | `play_session_id` | `string` |
| `StartPlaySessionResponse` | `started_at` | `int64` |
| `StartPlaySessionResponse` | `loadout` | `bytes` |
| `ContinuePlaySessionResponse` | `continue_count` | `int32` |
| `FinishPlaySessionResponse` | `result` | `bytes` |

## behavior

- `once_key` prefix: `play_session_refund:`

### play session

- The play session row is in `play_session_session` (scope `user`, column `user_id`, `play_session_id`, `mode_id`, `level_id`, `started_at`, `options`, `loadout`, key `user_id`, snapshot flag `false`). Each user has one play session
- continue: paying a cost before the round ends to keep playing the same round. e.g. adding moves. The continue row is in `play_session_continue` (scope `user`, column `user_id`, `continue_index`, `options`, key `(user_id, continue_index)`, snapshot flag `false`). `continue_index` increases by 1 from 0 within that play session
- play session record (hook input): `play_session_id`, `mode_id`, `level_id`, `started_at`, `options`(`PlaySessionStartOptions` bytes), `loadout`, `continues`(list of the `options` bytes of the continue rows, in `continue_index` order), `finished_at`(request time of `FinishPlaySession`; 0 outside `FinishPlaySession`)
- active play session: a play session whose play session row exists, whose `mode_id` is in `play_session_mode` of the server build data, and for which `server-time.is_reached_strict`(`started_at` + `max_duration`) is `false`
- `get_active_play_session` returns the record of the ctx user's active play session, and none when there is none. It does not change the saved state. A content handler uses it to bind a request made during the round to that play session

### start

`StartPlaySession` processing order. On failure, nothing changes.

1. Decodes `options` as `PlaySessionStartOptions`; when it does not pass `validation.validate_message`, `INVALID_REQUEST`
2. Sets `play_session_id` to a secure random UUID v4. `started_at` is request time
3. Hook `prepare_play_session`(ctx, `mode_id`, `level_id`, `options` bytes). On `GameError`, that error. The bytes received with `pass` are `loadout`. When `loadout` is more than `play-session.loadoutMaxBytes`, `INTERNAL`, and an `error` log is left
4. Writes the play session row with `options` and `loadout`, and deletes all continue rows of that user. An existing play session is replaced by this play session

- `prepare_play_session` handles the start conditions of that round (unlock, entry count), the entry cost and the cost of what `options` chose (`item-ledger.subtract_items`), and sets the user state used for the result calculation as `loadout`. To return the entry cost, `apply_play_session` calls `refund_entry`

### continue

`ContinuePlaySession` processing order. On failure, nothing changes.

1. When `play_session_id` is not in UUID v4 format, `INVALID_REQUEST`
2. When there is no play session row, `play_session_id` differs, or the play session's `mode_id` is not in `play_session_mode` of the server build data, `PLAY_SESSION_NOT_FOUND`
3. When `server-time.is_reached_strict`(`started_at` + `max_duration`) is `true`, `PLAY_SESSION_EXPIRED`
4. When the continue row count of that play session is `max_continue_count` of that mode or more, `PLAY_SESSION_CONTINUE_LIMIT`
5. Decodes `options` as `PlaySessionContinueOptions`; when it does not pass `validation.validate_message`, `INVALID_REQUEST`
6. Hook `continue_play_session`(ctx, play session record, `options` bytes). On `GameError`, that error
7. Writes a continue row (`continue_index` is the current continue row count, `options`) and returns the continue row count after the write as `continue_count`

- `continue_play_session` handles the conditions and the cost of a continue (`item-ledger.subtract_items`). It sees earlier continues in `continues` of the record
- A continue does not change the `loadout` of the play session
- A resend with the same request ID returns the response that `idempotency` saved and adds no continue row

### finish

`FinishPlaySession` processing order. On failure, the play session and the saved state do not change.

1. When `play_session_id` is not in UUID v4 format, `INVALID_REQUEST`
2. When there is no play session row, `play_session_id` differs, or the play session's `mode_id` is not in `play_session_mode` of the server build data, `PLAY_SESSION_NOT_FOUND`
3. When `server-time.is_reached_strict`(`started_at` + `max_duration`) is `true`, `PLAY_SESSION_EXPIRED`
4. When request time − `started_at` < `min_duration`, `PLAY_SESSION_TOO_FAST`. Leaves a `security` log
5. Decodes `result` as `PlaySessionResult`; when it does not pass `validation.validate_message`, `INVALID_REQUEST`
6. Hook `verify_play_session`(ctx, play session record, `result` bytes). On `reject`, `PLAY_SESSION_REJECTED`, and a `security` log is left
7. Hook `apply_play_session`(ctx, play session record, `result` bytes). On `GameError`, that error
8. Deletes the play session row and that user's continue rows, and puts the `result` bytes in the response

- A failure at step 3, 4 or 6 is rolled back, so the play session row remains. The next `StartPlaySession` replaces it
- `min_duration` applies to every `FinishPlaySession` regardless of the result (success, failure, give-up). A mode that needs to also apply the result of a give-up or a fast failure (e.g. returning the entry cost of an abandoned round) sets `min_duration` to 0, and `verify_play_session` judges the minimum duration per result with `finished_at` − `started_at` of the record
- A resend with the same request ID returns the response that `idempotency` saved

### refund

- `refund_entry` returns the entry cost that `prepare_play_session` subtracted. Calls `item-ledger.add_items`(ctx, list, change source(`PlaySessionRefund`, `play_session_id` of the play session record, once_key `play_session_refund:<play_session_id>`)) and returns its result
- The second `refund_entry` of the same play session is `ALREADY_APPLIED` and changes nothing
- Called outside `apply_play_session`, it throws, and that request is `INTERNAL`

### result verification

- in-play record: content state that a content `rpc` during the round (e.g. an item used within the round) writes with the `play_session_id` of the record that `get_active_play_session` returned. `verify_play_session` and `apply_play_session` read the in-play records with the same `play_session_id` as the record and put them into the result check and the apply. play-session does not read, write or delete in-play records
- `verify_play_session` checks that the values of the result (score, kill count, collected count) are within the upper bounds of content data and the conditions of `level_id`, and returns `reject` when they are not. The upper bounds include the amounts that `options` and `continues` of the record and the in-play records add (e.g. the move count that a booster, a continue or an item used in the round adds). `verify_play_session` does not change the saved state
- Content that verifies the result by recalculating it puts in `loadout` a simulation seed that `prepare_play_session` set with ctx random. The client makes the simulation random with `UtilCore.create_random`(`make_purpose_seed`(`play_session_simulation`, simulation seed)), and `verify_play_session` with `storage.create_random`(`make_purpose_seed`(`play_session_simulation`, simulation seed)). The client puts the input record of the round in `PlaySessionResult`. `verify_play_session` runs, with that input record and the play session record, the same shared formula `<feature>.sim_play` as the client (deterministic simulation of `client-content`) to recalculate the result, and returns `reject` when it differs from the reported values. It reads the user state that changes the result only from `loadout` of the record, and what was used during the round only from in-play records
- The data rows that the recalculation reads do not change after the first PROD build. The rule is the deterministic simulation of `client-content`. `FinishPlaySession` and `ContinuePlaySession` from a client that differs only in data hash also reach the handler (step 7 of the request processing order of `routing`)
- `apply_play_session` decides reward amounts, loot and probabilities with data and ctx random. Using a result value as a reward amount as it is, and submitting a result value to `ranking.submit_score` or `submit_guild_score` as the score of a board that has a row in `ranking_reward`, happen only when `verify_play_session` recalculated and verified that value

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `prepare_play_session`(handler hook) | `StartPlaySession` step 3 | ctx, `mode_id`, `level_id`, `options` bytes | `pass` and `loadout` bytes, or `GameError` | `pass` and empty bytes |
| `continue_play_session`(handler hook) | `ContinuePlaySession` step 6 | ctx, play session record, `options` bytes | `pass` or `GameError` | none. Registration is required when there is a `play_session_mode` row with `max_continue_count` 1 or more |
| `verify_play_session`(handler hook) | `FinishPlaySession` step 6 | ctx, play session record, `result` bytes | `pass` or `reject` | `pass` |
| `apply_play_session`(handler hook) | `FinishPlaySession` step 7 | ctx, play session record, `result` bytes | `pass` or `GameError` | changes nothing |

- `prepare_play_session`, `continue_play_session` and `apply_play_session` are called inside `storage.with_hook_change_source`(ctx, `PlaySession`, `play_session_id`). The change source of items that content changes inside it is source `PlaySession`, ref `play_session_id`. The change source that `refund_entry` passes is source `PlaySessionRefund`
- When there is a `play_session_mode` row with `max_continue_count` 1 or more and no `continue_play_session`, the server does not start

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation, `play_session_id` in a wrong format, decode failure, `validate_message` failure | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| missing or different play session, play session of a mode not in data | `PLAY_SESSION_NOT_FOUND` | `PLAY_SESSION_NOT_FOUND` | none |
| play session past `max_duration` | `PLAY_SESSION_EXPIRED` | `PLAY_SESSION_EXPIRED` | none |
| continue that reached `max_continue_count` | `PLAY_SESSION_CONTINUE_LIMIT` | `PLAY_SESSION_CONTINUE_LIMIT` | none |
| finish faster than `min_duration` | `PLAY_SESSION_TOO_FAST` | `PLAY_SESSION_TOO_FAST` | `security` log. `mode_id`, `elapsed_ms` (elapsed duration) |
| `reject` of `verify_play_session` | `PLAY_SESSION_REJECTED` | `PLAY_SESSION_REJECTED` | `security` log. `mode_id`, `play_session_id` |
| `loadout` over `play-session.loadoutMaxBytes` | `INTERNAL` | `INTERNAL` | `error` log. `mode_id`, `loadout_bytes` (byte count) |
| `refund_entry` called outside `apply_play_session` | throw | `INTERNAL` | `error` log |
| `continue_play_session` missing | server start failure | none | `error` log |

Added `CoreError`: `PLAY_SESSION_NOT_FOUND`, `PLAY_SESSION_EXPIRED`, `PLAY_SESSION_TOO_FAST`, `PLAY_SESSION_REJECTED`, `PLAY_SESSION_CONTINUE_LIMIT`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `play-session.resultMaxBytes` | integer | core | content | maximum bytes of `result` |
| `play-session.optionsMaxBytes` | integer | core | content | maximum bytes of `options` of `StartPlaySession` and `ContinuePlaySession` |
| `play-session.loadoutMaxBytes` | integer | core | content | maximum bytes of the `loadout` that `prepare_play_session` returns |

## data

`data/tables/play_session_mode.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `min_duration` | `duration` | `Server` |
| `max_duration` | `duration` | `All` |
| `max_continue_count` | `int` | `All` |

- `max_duration` > 0, `min_duration` < `max_duration` and `max_continue_count` ≥ 0. On violation, the server does not start
- `max_continue_count` limits the continue count of one play session. 0 means no continue

## DEV

none

## test

- `StartPlaySession` results in one play session row and returns `play_session_id` and `started_at`, and a second `StartPlaySession` replaces the earlier play session
- The `options` bytes of `StartPlaySession` go to `prepare_play_session`, and the same bytes go to `verify_play_session` and `apply_play_session` as `options` of the record. `options` that violate the `PlaySessionStartOptions` declaration are `INVALID_REQUEST` and no hook is called
- `ContinuePlaySession` calls `continue_play_session` once and returns `continue_count` 1, then 2, and after that the record `continues` of `FinishPlaySession` holds the sent `options` in the order sent
- `ContinuePlaySession` after `max_continue_count` continues is `PLAY_SESSION_CONTINUE_LIMIT` and no hook is called
- After `GameError` of `continue_play_session`, the continue rows and the saved state stay
- `ContinuePlaySession` for a missing play session or with a different `play_session_id` is `PLAY_SESSION_NOT_FOUND`, and `ContinuePlaySession` sent at `started_at` + `max_duration` is `PLAY_SESSION_EXPIRED`. A resend with the same request ID gets the first response and the continue rows increase by only one
- After a new `StartPlaySession`, `continues` of the record is empty
- `get_active_play_session` returns the record of the active play session, and returns none when there is no play session row, at `started_at` + `max_duration`, and after `FinishPlaySession`
- `GameError` of `prepare_play_session` is the error, and there is no play session row
- The `loadout` that `prepare_play_session` returned comes in the `StartPlaySession` response and equals `loadout` of the play session record that `verify_play_session` and `apply_play_session` receive. After a continue, `loadout` is also the same. Over `play-session.loadoutMaxBytes`, the result is `INTERNAL`, and no play session row and no change by the hook remain
- `FinishPlaySession` after `min_duration` calls `verify_play_session` and `apply_play_session` once each in this order, deletes the play session row and returns that `result`
- When `verify_play_session` returns `reject`, the result is `PLAY_SESSION_REJECTED`, a `security` log is left, `apply_play_session` is not called, and the play session row and the saved state stay
- A finish sent at `started_at` + `min_duration` − 1 is `PLAY_SESSION_TOO_FAST`, a `security` log is left and the play session row stays
- `ip` of the `security` log of `PLAY_SESSION_TOO_FAST` and `PLAY_SESSION_REJECTED` is the truncated IP of that request's client IP
- In a mode with `min_duration` 0, `FinishPlaySession` with a request time equal to `started_at` calls `verify_play_session` without `PLAY_SESSION_TOO_FAST`, and `finished_at` − `started_at` of the record that hook receives is 0
- A finish sent at `started_at` + `max_duration` is `PLAY_SESSION_EXPIRED`
- A missing play session and a different `play_session_id` are `PLAY_SESSION_NOT_FOUND`. A second `FinishPlaySession` (different request ID) of a finished play session is `PLAY_SESSION_NOT_FOUND` and no hook is called; the same request ID gets the first response
- A `result` that violates the `(ogw.v)` declaration or the `PlaySessionResult` declaration is `INVALID_REQUEST` and no hook is called
- When, after a play session is opened, the server is started again with data without that `mode_id` row, `FinishPlaySession` is `PLAY_SESSION_NOT_FOUND` and no hook is called. The next `StartPlaySession` replaces that play session row
- After `GameError` of `apply_play_session`, the play session row and the saved state stay
- When there is a row with `max_continue_count` 1 or more and no `continue_play_session`, or there is a row with `min_duration` ≥ `max_duration` or a row with a negative `max_continue_count`, the server does not start
- `refund_entry` called in `apply_play_session` adds those items, and the source of that `ItemChange` is `PlaySessionRefund` and its ref is `play_session_id`. The second `refund_entry` of the same play session is `ALREADY_APPLIED` and the balance stays
- `refund_entry` called outside `apply_play_session` (e.g. in `prepare_play_session`) throws and that request is `INTERNAL`
- The `ItemChange` of `subtract_items` and `add_items` that content calls inside `prepare_play_session`, `continue_play_session` and `apply_play_session` has source `PlaySession` and ref `play_session_id`, and the `ItemChange` of `refund_entry` inside the same `apply_play_session` has source `PlaySessionRefund`
