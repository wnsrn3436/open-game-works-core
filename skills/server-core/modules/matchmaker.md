# matchmaker

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

Receives the matching connections of a realtime game, creates matches by grouping waiting users and parties or from the members of a room, and judges the match results that participants report and applies them to each participant's saved state. A room is a group of users gathered by a code, and a group of users who entered the queue together through a room is a party.

## dependency

- `auth`
- `session`
- `admin-api`
- `storage`
- `server-time`
- `logging`
- `p2p-signaling`
- `validation`
- `game-update`
- optional dependency: `block-report`, `rating`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `GET /realtime` (route, WebSocket) | `MatchmakerFrame` | `MatchmakerFrame` | `CLOSE` frame and connection close | `routing`. The P2P transport of client `RealtimeCore` connects |
| `ReportMatchResult` (core rpc, `retry`). changes: `content` | `match_id`, `result`, `input_log` | `MatchJudgeStatus` | `MATCH_NOT_FOUND`, `MATCH_NOT_PARTICIPANT`, `MATCH_ALREADY_REPORTED`, `INVALID_REQUEST` | `routing`. Client content code sends it |

- `MatchJudgeStatus`(base proto enum): `PENDING`, `CONFIRMED`, `MISMATCH`
- `result` is the bytes of the `MatchResult` message that the game defines in `service.proto`. `input_log` is filled only when `result_rule` is `ServerReplay`. It is the bytes of the `MatchInputLog` message that the game defines in `service.proto`
- `MatchResult` is a module message, and a game that uses this module must define it. `MatchInputLog` is a module message, and a game that has a match mode whose `result_rule` is `ServerReplay` defines it

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ReportMatchResultRequest` | `match_id` | `string` | `max_len`: 36 |
| `ReportMatchResultRequest` | `result` | `bytes` | `max_len_key`: `matchmaker.resultMaxBytes` |
| `ReportMatchResultRequest` | `input_log` | `bytes` | `max_len_key`: `matchmaker.inputLogMaxBytes` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `ReportMatchResultResponse` | `status` | `MatchJudgeStatus` |

### MatchmakerFrame

A base proto message. One frame is one unfragmented WebSocket binary message. On receiving a fragmented message, the connection is closed. Only `kind` and the fields of that kind are filled.

| kind | direction | field |
|---|---|---|
| `HELLO` | client → server | `access_token`, `data_version`: the client's data version. Same format as `X-Ogw-Data-Version`, `client_version`: the client's app version. Same format as `X-Ogw-Client-Version` |
| `HELLO_ACK` | server → client | `server_time_at` |
| `CLOSE` | server → client | `code`: `CoreError` value. After sending `CLOSE`, the server closes the connection with WebSocket close code 4000 and the decimal string of that `code` as the reason |
| `MATCH_REQUEST` | client → server | `mode_id`: ID value of `match_mode`, `lockstep` |
| `MATCH_CANCEL` | client → server | none |
| `MATCH_FAILED` | server → client | `reason`: `MatchFailReason`, `error_code`: when `REJECTED`, the hook's `GameError`, `FEATURE_DISABLED`, `APP_UPDATE_REQUIRED` or `DATA_UPDATE_REQUIRED` |
| `MATCH_FOUND` | server → client | `match_id`, `mode_id`, `players`(`MatchPlayer` list), `my_index`, `seed`(`int64`), `start_at`, `transport`, `lockstep` |
| `PEER_SIGNAL` | both | `index`, `payload`(bytes) |
| `MATCH_LEAVE` | client → server | `match_id` |
| `MATCH_REJOIN` | client → server | `match_id` |
| `MATCH_REJOINED` | server → client | `match_id`, `ok`, `my_index`, `players`, `transport`, `left_indices`: list of the indexes of participants who left. `p2p-signaling` sets its meaning |
| `PEER_LEFT` | server → client | `index` |
| `PEER_REJOINED` | server → client | `index` |
| `ROOM_CREATE` | client → server | `mode_id`, `lockstep` |
| `ROOM_JOIN` | client → server | `room_code`, `lockstep` |
| `ROOM_LEAVE` | client → server | none |
| `ROOM_KICK` | client → server | `user_id` |
| `ROOM_START` | client → server | none |
| `ROOM_STATE` | server → client | `room_code`, `mode_id`, `room_members`(user ID list. In joining order, and the first user is the host), `room_status`(`RoomStatus`), `lockstep` |
| `ROOM_FAILED` | server → client | `error_code`: `CoreError` or the hook's `GameError`, `request`: `kind` of the client frame that failed (`ROOM_CREATE`, `ROOM_JOIN`, `ROOM_KICK`, `ROOM_START`, `MATCH_REQUEST`) |
| `ROOM_KICKED` | server → client | none |

- `MatchmakerFrame` fields (the list order is the field number): `MatchmakerFrameKind kind`, `string access_token`, `string data_version`, `string client_version`, `int64 server_time_at`, `int32 code`, `int32 mode_id`, `bool lockstep`, `MatchFailReason reason`, `int32 error_code`, `string match_id`, `repeated MatchPlayer players`, `int32 my_index`, `int64 seed`, `int64 start_at`, `Transport transport`, `int32 index`, `bytes payload`, `bool ok`, `string room_code`, `int64 user_id`, `repeated int64 room_members`, `RoomStatus room_status`, `MatchmakerFrameKind request`, `repeated int32 left_indices`. New fields are added at the end of the list
- The elements of `MatchmakerFrameKind`(base proto enum) are the kinds of the frame table in table order
- `MatchPlayer`(base proto message): `int64 user_id`, `int32 index`, `int32 team`, `int32 party`
- `MatchFailReason`(base proto enum): `TIMEOUT`, `INVALID_MODE`, `REJECTED`, `CREATE_FAILED`
- `RoomStatus`(base proto enum): `Open`(not in the queue as a party), `Matching`(in the queue as a party)
- `team` of `MatchPlayer`: 0 when `team_size` of `match_mode` is 0, otherwise the team number counted from 0. `party`: 0 for a user who entered the queue alone, and for a user who entered through a room, the party number counted from 1 within that match
- `lockstep`: the DEV lockstep flag
- `transport` is the value that `p2p-signaling.prepare_transport` makes
- `routing` collects route `GET /realtime`, and it does not go through the request processing order. Authentication is done with `HELLO`
- `match_id`, `mode_id`, `my_index`, the `user_id`, `team`, `party` of `players`, `seed`, `start_at`, `lockstep` of `MATCH_FOUND` become the `RealtimeCore` `MatchInfo`. `RealtimeCore` does not send server requests, so content code sends `ReportMatchResult` with `NetworkCore`

## behavior

### connection

- Only the server instance that received server start argument `--matchmaker` opens `/realtime`. Requests to other server instances and requests that are not a WebSocket upgrade get HTTP 404, and a malformed upgrade request gets HTTP 400. Before the handshake, a new connection over a pre-authentication limit is refused with HTTP 429. Each environment has one server instance that receives that argument. Queues and connections exist only in the memory of that server instance
- The first frame after the connection opens is `HELLO`. When another frame comes before `HELLO`, the connection is closed
- `HELLO` handling: when `auth.verify_access_token` or `session.check_current` fails, `CLOSE`(that error) and close. When `admin-api.is_maintenance`, `CLOSE`(`MAINTENANCE`), and when `is_banned`, `CLOSE`(`BANNED`). When the format of `data_version` or `client_version` is wrong, `CLOSE`(`INVALID_REQUEST`). The data version judgement treats `data_version` as `X-Ogw-Data-Version` and `client_version` as `X-Ogw-Client-Version` and works the same as step 7 of the request processing order of `routing` (the core `rpc` exception is not used), and when its result is `APP_UPDATE_REQUIRED` or `DATA_UPDATE_REQUIRED`, `CLOSE`(that error). On success, `HELLO_ACK`(`server_time_at` is `server-time.clock_now`)
- Authentication is once per connection. While the connection is open, the connection is kept even when the access token expires
- When a new connection of the same user is authenticated, sends `CLOSE`(`SESSION_REPLACED`) to the previous connection and closes it
- After authentication, `PEER_SIGNAL`, `MATCH_LEAVE`, `MATCH_REJOIN` are passed to `p2p-signaling.handle_frame`. When a connection closes, removes that user from the queue, handles it the same as `ROOM_LEAVE` when the user is in a room, and then calls `p2p-signaling.connection_closed`
- For each participant change that `handle_frame`, `connection_closed`, `open_match_session` returned, when the match record of that `match_id` is `PENDING`, one game transaction writes `left_at`(`LEFT`) or `disconnected_at`(`DISCONNECTED`) of that index as `clock_now`, and for `REJOINED` writes `disconnected_at` as 0
- After authentication, a frame that cannot be parsed, a text frame, a frame of a server → client kind, and a second `HELLO` are dropped
- Before handling `MATCH_REQUEST`, `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_START` after authentication, sends `CLOSE`(`MAINTENANCE`) when `admin-api.is_maintenance` is `true`, or `CLOSE`(`BANNED`) when `is_banned` of the sending user is `true`, and closes the connection. That frame is not handled, and the closed connection is handled the same as a connection close

### matching

- There is one queue per combination of a `match_mode` row, the lockstep flag, and `data_version` and `client_version` of the `HELLO` of that connection. So clients with different data versions or app versions do not enter the same match. A party entry picks the queue with the values of the host connection
- replay version check: passes when `data_version` of the `HELLO` of the connection equals `client_data_version` that the server read at start. Otherwise it fails, and the error code is `DATA_UPDATE_REQUIRED` when the protocol hash equals that of `client_data_version`, and `APP_UPDATE_REQUIRED` otherwise. `replay_match` recalculates a `ServerReplay` match with the server's data, so the match accepts only connections that passed this check
- A queue entry is `(member list, rating, entry time)`. A member is `(user ID, rating of that user, block list of that user)`. The queue entry of a user who entered alone has that user as its one member and that user's rating as its rating. A party entry is a queue entry that holds all room members in room joining order, and its rating is the largest of the member ratings. The headcount of a queue entry is its member count. The block list is the value read when that member was put into the queue, and later `BlockUser` and `UnblockUser` do not apply to that entry
- A user is in only one queue entry at a time
- `MATCH_REQUEST` processing order of a user outside a room
  1. When that user is in a queue, removes the user
  2. When `admin-api.is_kill_switched` is `true` for `MATCH_REQUEST`, `MATCH_FAILED`(`REJECTED`, `FEATURE_DISABLED`). When `mode_id` is not in `match_mode` or `allow_queue` of that row is `false`, `MATCH_FAILED`(`INVALID_MODE`). When `result_rule` of that row is `ServerReplay` and the replay version check of that connection fails, `MATCH_FAILED`(`REJECTED`, that error code)
  3. Opens that user's transaction with `storage.run_rollback_transaction` and calls hook `prepare_match_request`. On `WITHDRAWN` or `FAILED`, `MATCH_FAILED`(`REJECTED`, error code 0). On `GameError`, `MATCH_FAILED`(`REJECTED`, that `GameError`). In the same transaction, reads the rating and block list to put in the queue. The rating is the `rating` of `rating.get_rating`(ctx, that rule) when `rating_rule` of `match_mode` is not `null`, and the rating that the hook returned when it is `null`. The block list is `list_blocked_ids`(ctx, that user) when `block-report` is in the server module list, and an empty list otherwise
  4. Puts a queue entry of that one user at the end of the queue
- `MATCH_CANCEL` and connection close of a user outside a room remove that user from the queue. `MATCH_REQUEST` and `MATCH_CANCEL` of a user in a room follow party handling
- Only on the server instance that received `--matchmaker`, job `matchmaker_tick`(period `matchmaker.tickMs`), which the matchmaker sets with `server-time.schedule_job` at server start, repeats the following per queue
  1. Let e0 be the entry that entered first and w the duration it has waited so far. Allowed spread s = `rating_spread` + `rating_spread_per_sec` × (quotient of w divided by 1000)
  2. In entry order from e0, collects the entries with |rating − rating of e0| ≤ s that fit the placement and have no block relation with the entries already collected. Placement: collected headcount + headcount of that entry ≤ `max_players`. When `team_size` is greater than 0, there are `max_players` ÷ `team_size` teams with `team_size` seats each, and a team whose empty seats are at least the headcount of that entry must exist. The entry is put in the team with the smallest number among such teams. Block relation: among the members of two entries, the block list of one member has a member of the other entry
  3. When the collected headcount is `max_players`, creates a match with the collected entries and goes back to 1
  4. When w ≥ `match_wait`: when the collected headcount is `min_players` or more, creates a match with the collected entries; otherwise sends `MATCH_FAILED`(`TIMEOUT`) to each member of e0 and removes e0. Goes back to 1
  5. When neither holds, ends this queue
- team assignment: when `team_size` is greater than 0 and matching creates a match, puts the collected entries one at a time in descending rating order (entry order on ties) into the team with the smallest sum of the ratings of the members already put in (the smallest team number on ties) among the teams whose empty seats are at least the headcount of that entry. The members of a party entry go into the same team. When an entry has no team to go into, this assignment is dropped and the teams placed in step 2 are used. This keeps entries with high ratings from gathering in one team
- Times are `server-time.clock_now`. The cheat time offset is not used

### room

- A room is kept in the memory of the server instance that received `--matchmaker` and has a room code, `mode_id`, a member user ID list (in joining order), `RoomStatus`, the lockstep flag, and `data_version` and `client_version` of the `HELLO` of the connection of the user who created the room. The first user of the list is the host
- A room code is a string of `matchmaker.roomCodeLength` characters picked with secure random from `matchmaker.roomCodeAlphabet`. When it collides with the code of an existing room, it is picked again. When it still collides after 100 picks, no room is created and that `ROOM_CREATE` is `ROOM_BUSY`
- A user is in only one room at a time. Every time a room changes, `ROOM_STATE` is sent to all members
- `ROOM_KICK` and `ROOM_START` of a user outside a room are `ROOM_NOT_HOST`
- When the members of the room change while member rating resolution waits for the transaction of each member, nothing is changed and `ROOM_FAILED`(`ROOM_BUSY`. `request` is the `kind` of the host frame that started member rating resolution) is sent to all members
- When a room frame or party handling fails, the room and the queue are not changed. For a failure outside member rating resolution, `ROOM_FAILED`(that error, `request` is the `kind` of that frame) is sent to the sending user

| frame | handling |
|---|---|
| `ROOM_CREATE` | `ROOM_BUSY` when in a room or queue. `FEATURE_DISABLED` when `admin-api.is_kill_switched` is `true` for `MATCH_REQUEST`. `INVALID_REQUEST` when `mode_id` is not in `match_mode` or that mode is not a mode that can open a room. Otherwise creates an `Open` room with only that user |
| `ROOM_JOIN` | `ROOM_BUSY` when in a room or queue. `ROOM_NOT_FOUND` when no room has that code. `ROOM_VERSION_MISMATCH` when `data_version` or `client_version` of the room differs from the `HELLO` value of that user's connection. `ROOM_BUSY` when the room is `Matching`. `ROOM_FULL` when the member count is the room capacity. The room capacity is `max_players` when `allow_room` of that mode is `true`, and `max_party_size` when it is `false`. Otherwise adds the user at the end of the member list |
| `ROOM_LEAVE` | Dropped when not in a room. When the room is `Matching`, removes the party entry from the queue and changes the room to `Open`. Removes that user from the member list. When there is no member left, deletes the room |
| `ROOM_KICK` | `ROOM_NOT_HOST` when not the host. `INVALID_REQUEST` when `user_id` is the sender or not a member. Sends `ROOM_KICKED` to the target and handles it the same as the target's `ROOM_LEAVE` |
| `ROOM_START` | `ROOM_NOT_HOST` when not the host. `ROOM_BUSY` when `Matching`. `FEATURE_DISABLED` when the kill switch is on. `INVALID_REQUEST` when `allow_room` of the room's mode is `false`. That error code when `result_rule` of that mode is `ServerReplay` and the replay version check of the host connection fails. `ROOM_NOT_ENOUGH_PLAYERS` when the member count is less than `min_players`. Does member rating resolution and creates a match with the members |

- member rating resolution: first checks `admin-api.is_banned` for each member. When there is a member for which it is `true`, sends `CLOSE`(`BANNED`) to each such member and closes its connection, then, without calling `prepare_match_request`, sends `ROOM_FAILED`(`BANNED`. `request` is the `kind` of the host frame that started member rating resolution) to all remaining members and ends. Otherwise, for each member in joining order, calls `prepare_match_request` the same way as step 3 of the `MATCH_REQUEST` processing order and reads the rating and block list. When all members succeed, calls hook `validate_party`. When any one fails or `validate_party` returns `GameError`, sends `ROOM_FAILED`(that `GameError` on `GameError`, `INTERNAL` on `WITHDRAWN` or `FAILED`. `request` is the `kind` of the host frame that started member rating resolution) to all members and ends
- party handling
  - `MATCH_REQUEST` of a non-host member is `ROOM_NOT_HOST`, and `MATCH_CANCEL` is dropped
  - host `MATCH_REQUEST`: `ROOM_BUSY` when `Matching`. `FEATURE_DISABLED` when the kill switch is on. `INVALID_REQUEST` when `mode_id` differs from `mode_id` of the room or `allow_queue` of that mode is `false`. That error code when `result_rule` of that mode is `ServerReplay` and the replay version check of the host connection fails. `ROOM_PARTY_TOO_LARGE` when the member count is more than `max_party_size`. Does member rating resolution, puts the party entry at the end of the queue and changes the room to `Matching`
  - host `MATCH_CANCEL`: removes the party entry from the queue and changes the room to `Open`
  - When the party entry is removed by `TIMEOUT`, changes the room to `Open`. When the party entry becomes a match, changes the room to `Open` after sending the `MATCH_FOUND` of step 3 of `### match creation`
- The room and its members stay after a match created through the room
- When the host leaves the room, the first user of the remaining list is the host
- When a new connection of the same user is authenticated, the previous connection closes, so that user leaves the room. A user rejoined with `MATCH_REJOIN` is also not in the room

### match creation

1. Saves the match record in one game transaction: `match_id`(UUID v4), `mode_id`, `user_ids`(index order. The index is the order of the collected entries from 0, and within an entry the member order. For `ROOM_START`, the room member order), `ratings`(index order. For each participant, the rating read in step 3 of the `MATCH_REQUEST` processing order or in member rating resolution), `teams`(index order. All 0 when `team_size` is 0; otherwise the number of the team that the team assignment of matching put the entry in. For `ROOM_START`, the quotient of the index divided by `team_size`), `parties`(index order. 0 for a user who entered alone, for a member of a party entry the number counted from 1 in the order the party entries were collected in that match, and 1 for every member of `ROOM_START`), `seed`(secure random `int64` of at least 0 and less than 2^63), `created_at`, `start_at` = `created_at` + `prepare_time`, `deadline_at` = `start_at` + `max_duration` + `matchmaker.reportMarginMs`, `status` `PENDING`, `lockstep`, `data_version` and `client_version`(the values of the queue or room), `source`(`Queue` for a match that matching created, `Room` for a match that `ROOM_START` created), `applies`(index order. Each item has `applied` `false`, `attempts` 0, `next_attempt_at` 0, `last_failure` empty string). On failure, `MATCH_FAILED`(`CREATE_FAILED`) to each participant and an error log
2. Gets `transport` with `p2p-signaling.prepare_transport`(`match_id`, `start_at`, `max_duration`), and passes to `open_match_session` the `MatchPlayer` list and connections of the participants, `transport`, and `expires_at`(`start_at` + `max_duration`)
3. Sends `MATCH_FOUND` to each participant. Only `my_index` differs, and the other fields are the same. The participant changes of step 2 and the `DISCONNECTED` of connections that closed during creation are written to the match record before that

### ReportMatchResult

1. `INVALID_REQUEST` when `match_id` is not in UUID v4 format
2. In the reporter's request transaction, locks and reads the match record row with `storage.lock_game_row`. `MATCH_NOT_FOUND` when it does not exist
3. `MATCH_NOT_PARTICIPANT` when the reporter is not in `user_ids`
4. When `status` is `CONFIRMED` or `MISMATCH`, changes nothing and returns that status
5. When `status` is `PENDING` and `deadline_at` ≤ `clock_now`, does not save the report, makes the judgement `MISMATCH` and returns `MISMATCH`. The apply of every participant is done as an out-of-request change and starts after the commit with `storage.after_commit`
6. `MATCH_ALREADY_REPORTED` when the reporter's report already exists
7. Saves the report in the record and makes the judgement. When the judgement is decided, does the reporter's apply in this transaction and starts the apply of the other participants after the commit with `storage.after_commit`

### result decision

Let n be the participant count. The same result means the same `result` bytes.

| `result_rule` | `CONFIRMED` | `MISMATCH` |
|---|---|---|
| `Consensus` | All n participants reported and every `result` is the same. That result | Two different `result` values were reported |
| `Majority` | The report count c of the same `result` satisfies 2c > n. That result | With m = the largest count of the same `result` + the count not reported yet, 2m ≤ n |
| `ServerReplay` | Every participant whose `left_at` and `disconnected_at` are both 0 in `participants` reported, an `input_log` to replay exists, and hook `replay_match` returned a result with that `input_log`. That result | n is 2 and two different `input_log` values were reported. Or every participant whose `left_at` and `disconnected_at` are both 0 reported, but there is no `input_log` to replay or `replay_match` returned `reject` |

- `input_log` to replay: when n is 2, that `input_log` when every reported `input_log` is the same. When n is 3 or more, with r the report count of the participants whose `left_at` is 0, the `input_log` whose report count c of the same `input_log` satisfies 2c > r. When there is no such `input_log`, there is no `input_log` to replay. When n is 3 or more, it waits for the reports of the remaining participants even when different `input_log` values were reported. This keeps one participant from voiding the match with a changed `input_log`
- When the result that would become `CONFIRMED` cannot be decoded as `MatchResult` or does not pass `validation.validate_message`, the judgement is `MISMATCH`. `ServerReplay` calls `replay_match` only when `data_version` of the match record equals `client_data_version` that the server read at start and the `input_log` to replay decodes as `MatchInputLog` and passes `validate_message`; otherwise `MISMATCH`
- The `CONFIRMED` condition of `ServerReplay` is checked with the `participants` at that time in the transaction that saved the report. It does not wait for the reports of participants who left or whose matchmaker connection closed, and judges at the last report among the remaining participants. The reported `input_log` holds the tick at which a departed participant left the match
- Only on the server instance that received `--matchmaker`, job `matchmaker_sweep`(period `matchmaker.sweepIntervalMs`), which the matchmaker sets with `server-time.schedule_job` at server start, changes `PENDING` records with `deadline_at` ≤ `clock_now` to `MISMATCH`. In this case the apply of every participant is done as an out-of-request change. Other server instances do not set this job
- When the judgement result is `CONFIRMED`, it is applied with hook `apply_match_result`, and when it is `MISMATCH`, with hook `apply_match_mismatch`
- In `Consensus` and `Majority`, a match with 2 participants becomes `MISMATCH` when the two reports differ or one report is missing, because there is no authority to decide which report is right. The apply hook decides the penalty of a participant who left and the handling of the remaining participants with `participants` of the match record

### apply

- Apply is once per participant. `applies` of the match record is a list in index order, and each item is `applied`(whether the apply of that index finished), `attempts`(the number of times the apply of that index ended with `FAILED`), `next_attempt_at`(time of the next apply), `last_failure`(the result `REJECTED` or `FAILED` of the last failed apply. Empty string when there was no failure). Marking an index means writing `applied` of that item as `true`
- The transaction that made the judgement writes `decided_at` as `clock_now` and sets `next_attempt_at` to `decided_at` for each index that is not marked. An apply transaction locks the match record row with `storage.lock_game_row`, calls the hook only when that index is not marked, and marks it in the same transaction
- The apply of a participant who is not the reporter is one `run_user_transaction` of that user. The change becomes a pending delta. The hook is called inside `storage.run_savepoint`, and on `GameError` only that savepoint is rolled back, and the same transaction marks that index and writes `last_failure` as `REJECTED`. It is not retried
  - `WITHDRAWN`: marks without applying
  - When the apply transaction throws outside the hook or ends with `FAILED`(DB or `storage` failure), that apply is `FAILED`
  - `FAILED`: one game transaction locks the match record row with `lock_game_row`, and when that index is not marked, increases `attempts` by 1 and writes `last_failure` as `FAILED`. When `attempts` reaches `matchmaker.applyRetryMaxAttempts`, gives up and marks the index. Otherwise writes `next_attempt_at` as `clock_now` + g(`attempts`). g(1) is `matchmaker.applyRetryInitialMs`, and g(a) is the smaller of the quotient of g(a − 1) × `matchmaker.applyRetryFactorPermille` ÷ 1000 and `matchmaker.applyRetryMaxIntervalMs`
  - An error log is left only when the result of the failed apply differs from the previous `last_failure`(including the first failure) and when giving up
- Job `matchmaker_sweep` retries each index that is not marked and whose `next_attempt_at` ≤ `clock_now`. Retries continue after a server restart
- The reporter's apply calls the hook inside `storage.run_savepoint` in the request transaction that made the judgement. When the hook returns `GameError`, only that savepoint is rolled back, that index is marked and an error log is left. The report and the judgement are committed and the request succeeds with the judgement status
- When an apply hook or `replay_match` throws or its output format is wrong, inside `ReportMatchResult` the request is `INTERNAL` and the report is not saved, and in the apply of a participant who is not the reporter, the apply is `FAILED`
- The match record is kept in `matchmaker_match`(key `match_id`, indexes `(status, deadline_at)`, `(next_apply_at)`) and `matchmaker_participant` with one row per participant index (key `(match_id, idx)`). `next_apply_at` is the earliest `next_attempt_at` among the indexes not marked after the judgement, and null when there is none. The two tables are registered with `storage.register_table` with scope `game` and expiry column `expires_at`. `expires_at` is set to that time + `matchmaker.recordRetentionMs` in the transaction where every index is marked, and left empty before that. A report after the expiry cleanup of `storage` deleted the record is `MATCH_NOT_FOUND`
- The matchmaker does not change saved state with the match result. Only the apply hooks change saved state

### security

- When one frame exceeds `matchmaker.maxFrameBytes` or its read duration exceeds `matchmaker.frameReadTimeoutMs`, closes the connection and does not handle that frame
- The frame count also counts control frames. The last 1000 ms and per-second counts are measured with `server-time.clock_now`, and `matchmaker.helloTimeoutMs` and `matchmaker.frameReadTimeoutMs` with `server-time.network_time_limit`
- After authentication, when the frame count of the last 1000 ms per user exceeds `matchmaker.framesPerSecond`, closes the connection with `CLOSE`(`RATE_LIMITED`). A new connection of the same user uses the same counter
- Before authentication, counts per IP the connection accepts per second against `matchmaker.preAuthAcceptsPerSecond`, the frames per second against `matchmaker.preAuthFramesPerSecond`, and the concurrent connections against `matchmaker.preAuthConnections`. A new connection over a limit is closed at once, and a connection over the frame count is closed. An authenticated connection is removed from the concurrent connection count
- A connection that does not authenticate within `matchmaker.helloTimeoutMs` from connection accept is closed
- IP judgement is the same as the rate limit rules of `routing`
- Values that a peer sends are not trusted. Results that change saved state go only through the judgement of this spec

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `prepare_match_request` | step 3 of the `MATCH_REQUEST` processing order and member rating resolution of a room. Inside `run_rollback_transaction` | ctx, `mode_id`, member user ID list | rating(`bigint`) or `GameError` | rating 0 |
| `validate_party` | in member rating resolution, after `prepare_match_request` of every member succeeds | `mode_id`, member list (`{user_id, rating}` in room joining order), `request`(the `kind` of the host frame that started member rating resolution. `ROOM_START` or `MATCH_REQUEST`) | `pass` or `GameError` | `pass` |
| `apply_match_result` | apply of a participant whose judgement is `CONFIRMED` | ctx, match record, index of that participant, result bytes | `pass` or `GameError` | changes nothing |
| `apply_match_mismatch` | apply of a participant whose judgement is `MISMATCH` | ctx, match record, index of that participant | `pass` or `GameError` | changes nothing |
| `replay_match` | when the `input_log` to replay is decided in the `ServerReplay` judgement | match record, `input_log` bytes to replay, random made from `seed`, server build data container and accessor at judgement time, its data version | result bytes or `reject` | `reject` |

- Member user ID list of `prepare_match_request`: for `MATCH_REQUEST` outside a room, the one user of ctx; for member rating resolution, all members of the room in joining order. The user of ctx is also in the list
- `validate_party` does not read or write the DB. The ratings of the member list are the ratings that member rating resolution read
- match record input: `match_id`, `mode_id`, `user_ids`, `ratings`, `teams`, `parties`, `participants`, `seed`, `start_at`, `data_version`, `client_version`, `source`, `replayed_input_log`
- `replayed_input_log` of match record input: the `input_log` that the `ServerReplay` judgement passed to `replay_match`. Empty bytes when none was passed
- `source` of match record input is `MatchSource`(`Queue`, `Room`)
- `participants` of match record input: a list in index order. Each item is `reported_at`(the `clock_now` when the report was saved. 0 when none), `result`(reported `result` bytes. Empty bytes when none), `input_log`(reported `input_log` bytes. Empty bytes when none), `left_at`(the `clock_now` when the participant left with `MATCH_LEAVE`. 0 when none), `disconnected_at`(the `clock_now` when the matchmaker connection last closed. 0 when rejoined with `MATCH_REJOIN`)
- `replay_match` does not read or write the DB. The random is `storage.create_random`(`make_purpose_seed`(`match_simulation`, match `seed`)). Client simulation makes the same random with `UtilCore.create_random`(`make_purpose_seed`(`match_simulation`, match seed)). When a `match_mode` row whose `result_rule` is `ServerReplay` exists but there is no `replay_match`, the server does not start
- `replay_match` checks the participant index, input order and range of `input_log` and calculates the result with game data and `seed`. It does not use the reported `result`
- `apply_match_result` and `apply_match_mismatch` are called inside `storage.with_hook_change_source`(ctx, `Match`, `match_id`). The change source of item changes inside it is source `Match`, `ref` `match_id`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| failure of the game transaction of a participant change (lock wait timeout, deadlock, DB failure) | the change is dropped. It is not retried: a retried `DISCONNECTED` could be written after a later `REJOINED` | none | `error` |
| authentication failure, maintenance and ban at `HELLO` and before handling `MATCH_REQUEST`, `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_START`, a banned member in member rating resolution, format violation of `data_version` and `client_version`, data version judgement failure, authentication of another connection | `CLOSE`(that `CoreError`) and close | that `CoreError` | authentication failure is `security`(`reason` `unauthorized`, `token_expired`, `session_replaced`) |
| frame size, read duration, frame count, pre-authentication limit, `HELLO` timeout | connection close. Exceeding the frame count is `CLOSE`(`RATE_LIMITED`) | `RATE_LIMITED` for exceeding the frame count, none for the rest | `security`(`reason` `frame_too_large`, `frame_read_timeout`, `rate_limited`, `pre_auth_connection_limit`(accepts per second and concurrent connections), `pre_auth_frame_limit`, `hello_timeout`) |
| match record save failure | `MATCH_FAILED`(`CREATE_FAILED`) | none | `error` |
| failure of a room frame and party handling | `ROOM_FAILED`(that error and the `kind` of the failed frame) | `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_BUSY`, `ROOM_NOT_HOST`, `ROOM_NOT_ENOUGH_PLAYERS`, `ROOM_PARTY_TOO_LARGE`, `ROOM_VERSION_MISMATCH`, `INVALID_REQUEST`, `FEATURE_DISABLED`, `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED`, `BANNED`, `INTERNAL`, the hook's `GameError` | none |
| `GameError` of the reporter's apply hook | marks that index. The request succeeds with the judgement status | none | `error` |
| match that does not exist, not a participant, duplicate report | `MATCH_NOT_FOUND`, `MATCH_NOT_PARTICIPANT`, `MATCH_ALREADY_REPORTED` | `MATCH_NOT_FOUND`, `MATCH_NOT_PARTICIPANT`, `MATCH_ALREADY_REPORTED` | none |
| apply failure | gives up after retries | none | `error`. First failure, change of failure kind, give-up |
| missing `replay_match`, room code settings violation | server start failure | none | `error` |

Added `CoreError`: `MATCH_NOT_FOUND`, `MATCH_NOT_PARTICIPANT`, `MATCH_ALREADY_REPORTED`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_BUSY`, `ROOM_NOT_HOST`, `ROOM_NOT_ENOUGH_PLAYERS`, `ROOM_PARTY_TOO_LARGE`, `ROOM_VERSION_MISMATCH`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `matchmaker.tickMs` | integer | core | content | queue matching period |
| `matchmaker.maxPlayers` | integer | core | content | value that `max_players` of `match_mode` cannot exceed |
| `matchmaker.reportMarginMs` | integer | core | content | margin added to `deadline_at` |
| `matchmaker.sweepIntervalMs` | integer | core | content | period of deadline judgement and apply retry |
| `matchmaker.recordRetentionMs` | integer | core | content | duration a match record is kept after the apply of every participant is marked |
| `matchmaker.resultMaxBytes` | integer | core | content | maximum bytes of `result` |
| `matchmaker.inputLogMaxBytes` | integer | core | content | maximum bytes of `input_log` |
| `matchmaker.applyRetryInitialMs` | integer | core | content | interval until the first apply retry |
| `matchmaker.applyRetryFactorPermille` | integer | core | content | retry interval multiplier. permille |
| `matchmaker.applyRetryMaxIntervalMs` | integer | core | content | maximum retry interval |
| `matchmaker.applyRetryMaxAttempts` | integer | core | content | maximum number of apply attempts, including the first |
| `matchmaker.maxFrameBytes` | integer | core | content | maximum bytes of one frame |
| `matchmaker.frameReadTimeoutMs` | integer | core | content | read time limit of one frame |
| `matchmaker.framesPerSecond` | integer | core | content | frame count limit per user in the last 1000 ms after authentication |
| `matchmaker.preAuthAcceptsPerSecond` | integer | core | content | connection accept limit per second per IP before authentication |
| `matchmaker.preAuthFramesPerSecond` | integer | core | content | frame limit per second per IP before authentication |
| `matchmaker.preAuthConnections` | integer | core | content | concurrent connection limit per IP before authentication |
| `matchmaker.helloTimeoutMs` | integer | core | content | time limit from connection accept to authentication |
| `matchmaker.roomCodeAlphabet` | string | core | content | character set used in room codes. Picked from ASCII uppercase letters and digits |
| `matchmaker.roomCodeLength` | integer | core | content | length of a room code |
| `matchmaker.lockstepMaxDurationMs` | integer | core | human | duration used instead of `max_duration` in a DEV lockstep match |
| `admin-api.switchCacheMs` | integer | core | content | interval for rereading the maintenance and kill switch cache |

- The server does not start when one of the following holds
  - `matchmaker.roomCodeAlphabet` is empty, or contains a character that is not an ASCII uppercase letter or digit, or a duplicate character
  - `matchmaker.roomCodeLength` is less than 1

## data

`data/tables/match_mode.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `min_players` | `int` | `All` |
| `max_players` | `int` | `All` |
| `match_wait` | `duration` | `Server` |
| `prepare_time` | `duration` | `All` |
| `max_duration` | `duration` | `All` |
| `result_rule` | `enum<MatchResultRule>` | `All` |
| `rating_spread` | `long` | `Server` |
| `rating_spread_per_sec` | `long` | `Server` |
| `max_party_size` | `int` | `All` |
| `team_size` | `int` | `All` |
| `rating_rule` | `ref<rating_rule.id>?` | `All` |
| `allow_queue` | `bool` | `All` |
| `allow_room` | `bool` | `All` |

- The server does not start when any of the following is violated: `min_players` ≥ 2, `max_players` ≥ `min_players`, `max_players` ≤ `matchmaker.maxPlayers`, the three durations > 0, the two rating values ≥ 0, 1 ≤ `max_party_size` ≤ `max_players`, `team_size` ≥ 0, at least one of `allow_queue` and `allow_room` is `true`. When `team_size` > 0, `max_players` is a multiple of `team_size` and `max_party_size` ≤ `team_size`. When a row with `rating_rule` exists, `rating` is in the server module list. Server start, not the data check, checks the rules on `matchmaker.maxPlayers` and the server module list
- `max_party_size` is the maximum headcount of a party entry. When it is 1, a room with two or more members cannot enter the queue as a party. `team_size` is the headcount of one team, and when it is 0, teams are not split
- Only a mode whose `allow_queue` is `true` creates matches from the queue (users who entered alone and party entries), and only a mode whose `allow_room` is `true` creates matches with `ROOM_START`. A mode that can open a room is a mode whose `allow_room` is `true`, or whose `allow_queue` is `true` and `max_party_size` is 2 or more
- `rating_rule` is the `rating` rule of the queue rating of that mode and of the rating that the match result changes. When it is `null`, `prepare_match_request` decides the queue rating

`data/enums.csv`

| type | element |
|---|---|
| `MatchResultRule` | `Consensus`, `Majority`, `ServerReplay` |

reserved ID, reserved string, reserved sound: none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `create_test_match` | `mode_id`, `user_ids`(index order), `seed` | `match_id` | throws when `mode_id` is not in `match_mode`, or the count of `user_ids` is less than `min_players` or more than `max_players` | `testing` |

- `create_test_match` saves, without a queue or connections, the match record of step 1 of match creation with the received `user_ids` and `seed`, `ratings`, `teams`, `parties` all 0, `lockstep` `false`, `data_version` set to the server's `client_data_version`, `client_version` set to an empty string, and `source` set to `Queue`. It does not call `p2p-signaling` and does not send `MATCH_FOUND`
- STG and PROD builds have no `create_test_match`
- DEV lockstep: a server that contains DEV code reads `lockstep` of `MATCH_REQUEST`, `ROOM_CREATE`, `ROOM_JOIN`. An entry with `lockstep` `true` enters the lockstep queue and is not grouped with `false` entries. `lockstep` of `ROOM_CREATE` is the lockstep flag of the room, and when `lockstep` of `ROOM_JOIN` differs from the room, `ROOM_NOT_FOUND`. The party entry and `ROOM_START` of a lockstep room become a lockstep match
- A lockstep match has `lockstep` `true` in the match record and in `MATCH_FOUND`. `deadline_at` is `start_at` + `matchmaker.lockstepMaxDurationMs` + `matchmaker.reportMarginMs`, and the durations of `prepare_transport` and `open_match_session` also use `matchmaker.lockstepMaxDurationMs` instead of `max_duration`. The lockstep transport of client `RealtimeCore` aligns the progress within the match
- STG and PROD servers do not read `lockstep` and treat it as `false`

## test

- `MATCH_REQUEST` before `HELLO` closes the connection. A connection that does not authenticate within `matchmaker.helloTimeoutMs` is closed, and an authenticated connection stays
- `HELLO` of a banned user and during maintenance gets `CLOSE` with that code, and the connection is closed with WebSocket close code 4000 and the decimal string of that code as the reason
- On an authenticated connection, `MATCH_REQUEST`, `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_START` sent after maintenance is turned on and `admin-api.switchCacheMs` has passed each get `CLOSE`(`MAINTENANCE`) and the connection is closed, and that user is not in the queue or a room. The same frames of a user banned after authentication get `CLOSE`(`BANNED`)
- After a non-host member of a room is banned, at the host's `ROOM_START` that member gets `CLOSE`(`BANNED`) and leaves the room, the remaining members get `ROOM_FAILED`(`BANNED`, `ROOM_START`), and there is no match. The same holds for the host's `MATCH_REQUEST`, and there is no party entry in the queue
- When the protocol hash of `data_version` of `HELLO` differs from both `client_data_version` and `compat_client_data_version`, `CLOSE`(`APP_UPDATE_REQUIRED`). When only the data hash differs, `CLOSE`(`DATA_UPDATE_REQUIRED`) only when `is_data_update_ready` is `true` or `client_version` is an empty string, and `HELLO_ACK` otherwise. A `data_version` equal to `client_data_version` gets `HELLO_ACK` even when it differs from the data version of the server build data
- When a new connection of the same user is authenticated, the previous connection gets `CLOSE`(`SESSION_REPLACED`)
- When `max_players` users wait, all get `MATCH_FOUND` with the same `match_id`, `seed`, `start_at`, and their `my_index` values differ
- When the `turn` adapter fails, `MATCH_FOUND` is still sent and `relays` of `transport` is empty
- When `match_wait` has passed, a match is created when there are `min_players` or more users; otherwise only the user who came first gets `TIMEOUT`
- Users whose rating difference is larger than the allowed spread are not grouped, and are grouped after the spread widens with the waiting duration
- `MATCH_REQUEST` of two users whose `data_version` or `client_version` of `HELLO` differ do not become the same match
- In a mode whose `rating_rule` is `null`, `ratings` of the match record that `apply_match_result` and `apply_match_mismatch` received holds, in index order, the rating that `prepare_match_request` returned for each participant
- In both the reporter's apply and the out-of-request apply, the `ItemChange` of an item that content granted inside `apply_match_result` has source `Match` and ref `match_id`
- A `mode_id` that does not exist is `INVALID_MODE`, a `GameError` of the hook is `REJECTED` and that code, and the user does not enter the queue
- When kill switch `MATCH_REQUEST` is on, `MATCH_REQUEST` is `MATCH_FAILED`(`REJECTED`, `FEATURE_DISABLED`) and does not enter the queue
- In a mode whose `result_rule` is `ServerReplay`, `MATCH_REQUEST` of a connection whose `data_version` of `HELLO` differs from `client_data_version` only in the data hash is `MATCH_FAILED`(`REJECTED`, `DATA_UPDATE_REQUIRED`), `MATCH_REQUEST` of a connection whose value equals `compat_client_data_version` is `MATCH_FAILED`(`REJECTED`, `APP_UPDATE_REQUIRED`), and neither enters the queue. The host `MATCH_REQUEST` of a room whose host is such a connection is `ROOM_FAILED`(that code, `MATCH_REQUEST`), and in a room of that mode whose `allow_room` is `true`, the host `ROOM_START` is `ROOM_FAILED`(that code, `ROOM_START`) and no match record is created. `MATCH_REQUEST` of a mode whose `result_rule` is `Consensus` enters the queue with the same connection
- A user whose connection closes while waiting or who sent `MATCH_CANCEL` does not enter a match
- When two different results come in `Consensus`, the judgement is `MISMATCH` and `apply_match_mismatch` is called once for each participant
- With 3 participants in `Majority`, two same results are `CONFIRMED`, and the participant who did not report also gets the apply as a pending delta
- In a 2-participant `ServerReplay` match, different `input_log` values are `MISMATCH`, and the same ones are `CONFIRMED` with the result of `replay_match`
- In a 3-participant `ServerReplay` match, when the `input_log` values of the first two reports differ, the match is `PENDING` before the third report. When the third report equals one of the two, `replay_match` is called once with that `input_log` and the match is `CONFIRMED`, `participants` of the match record that the apply hook received has the three `input_log` values, and `replayed_input_log` is that `input_log`. When the three `input_log` values all differ, `MISMATCH`, and `replayed_input_log` is empty bytes
- In `ServerReplay`, when every `input_log` is the same and `replay_match` returns `reject`, `MISMATCH`
- In a 3-participant `ServerReplay` match, when only index 0 reports after index 2 did `MATCH_LEAVE`, the match is `PENDING`, and when index 1 reports the same `input_log`, that report makes it `CONFIRMED` with the result of `replay_match`, and index 2 also gets `apply_match_result`. In a 2-participant `ServerReplay` match, when the other participant reports after the matchmaker connection of one participant closed, that report makes it `CONFIRMED`. In a 2-participant match, when the participant who left reported a different `input_log`, `MISMATCH`. In a 3-participant match, the report of the participant who left is not counted when deciding the `input_log` to replay
- The match record has `data_version` and `client_version` of the participant connections. A `ServerReplay` match whose `data_version` differs from the server's `client_data_version` does not call `replay_match` and is `MISMATCH` even when all participants report the same `input_log`
- A `Consensus` match where all participants reported the same `result` that violates the `(ogw.v)` declarations is `MISMATCH`, and `apply_match_result` is not called. A `ServerReplay` match with the same `input_log` that violates the declarations does not call `replay_match` and is `MISMATCH`
- A match not judged by `deadline_at` becomes `MISMATCH`
- `ReportMatchResult` of a `PENDING` match with `deadline_at` ≤ `clock_now` that job `matchmaker_sweep` has not judged yet does not save the report and returns `MISMATCH`, and `apply_match_mismatch` is called once for each participant. Job `matchmaker_sweep` that runs later does not judge that record again
- A match that does not exist, a user who is not a participant, and the second report of the same user each get their `CoreError`. A report after the judgement gets the judgement result without apply
- When two participants report concurrently, the judgement and the apply happen once per participant
- An apply `FAILED` is retried at the retry intervals, continues after a restart, and gives up after the maximum attempts. A participant who is a withdrawn user is not applied. After `FAILED`, the `applies` item of that index has `attempts` increased by 1, `next_attempt_at` equal to `clock_now` + g(`attempts`), and `last_failure` equal to `FAILED`. The error log is left at the first failure and at give-up, and not while `FAILED` continues
- Exceeding the frame size, exceeding the frame count and exceeding a pre-authentication limit close the connection
- A `match_mode` row violation, and a missing `replay_match` when a `ServerReplay` row exists, block server start
- With settings where `matchmaker.roomCodeAlphabet` is empty or contains lowercase letters or duplicate characters, or where `matchmaker.roomCodeLength` is 0, the server does not start in each case
- A `match_mode` row whose `allow_queue` and `allow_room` are both `false` blocks server start
- In a 2-participant `Consensus` match, when one participant does `MATCH_LEAVE` and does not report, the match is `MISMATCH` after `deadline_at`, and in the `participants` that the two `apply_match_mismatch` calls received, the index that left has `left_at` and `reported_at` 0, and the remaining index has `reported_at` and `result`
- When 2 participants report different `result` values, `MISMATCH`, and `participants` has the two `result` values
- `disconnected_at` of a participant whose matchmaker connection closed is the close time, and 0 after `MATCH_REJOIN`. A close after the judgement does not change the record
- When a participant of a `PENDING` match is grouped into a new match, `left_at` of that index of the previous match record is the time of grouping
- When a participant sends `ReportMatchResult` for a match created with `create_test_match`, the judgement and the apply hooks are called
- `replay_match` receives the server build data at judgement time and its data version
- The sequence of the random that `replay_match` received equals the sequence of `UtilCore.create_random`(`make_purpose_seed`(`match_simulation`, `seed`))
- When the server instance stops after the commit of the judging request and before the other participants are applied, job `matchmaker_sweep` applies that index
- When the apply of another participant and the retry of job `matchmaker_sweep` overlap, the apply hook is called once per index
- A record with an index left unapplied is not deleted even after `matchmaker.recordRetentionMs` has passed
- A server instance without the `--matchmaker` argument does not do deadline judgement and apply retry
- `ROOM_STATE` of a room that `ROOM_CREATE` created has the room code and one host, and after another user's `ROOM_JOIN`, both members get a `ROOM_STATE` with two members
- With `matchmaker.roomCodeAlphabet` `A` and `matchmaker.roomCodeLength` 1, the second user's `ROOM_CREATE` is `ROOM_FAILED`(`ROOM_BUSY`, `ROOM_CREATE`), there is one room, and the server keeps handling other frames
- A code that does not exist is `ROOM_NOT_FOUND`, a room whose member count is the room capacity is `ROOM_FULL`, and `ROOM_CREATE` and `ROOM_JOIN` of a user in a room or queue are `ROOM_BUSY`
- In a room of a mode with `allow_room` `false`, `max_party_size` 2 and `max_players` 4, `ROOM_JOIN` after 2 members is `ROOM_FULL`, and in a room of a mode whose `allow_room` is `true`, `ROOM_JOIN` after 4 members is `ROOM_FULL`
- `ROOM_JOIN` of a user whose `data_version` or `client_version` of `HELLO` differs from that of the user who created the room is `ROOM_VERSION_MISMATCH`, and the members are unchanged
- When the host leaves, the next member is the host, and when the last member leaves, the room is gone, so `ROOM_JOIN` with that code is `ROOM_NOT_FOUND`. A member whose connection closes leaves the room
- After the host's `ROOM_KICK`, the target gets `ROOM_KICKED` and is removed from the members. `ROOM_KICK` and `ROOM_START` of a non-host member are `ROOM_NOT_HOST`
- `ROOM_START` of a room with fewer than `min_players` members is `ROOM_NOT_ENOUGH_PLAYERS`. The match of `ROOM_START` holds the members with indexes in room joining order, every `party` is 1, and after that the room stays `Open`
- When `prepare_match_request` of one member is `GameError`, every member gets `ROOM_FAILED` with that error and with the `kind` of the host frame (`ROOM_START` or `MATCH_REQUEST`) as `request`, and there is no match
- At the host `MATCH_REQUEST` of a room with three members, `prepare_match_request` receives for each member the three member user IDs of the room in joining order, and `prepare_match_request` of a `MATCH_REQUEST` outside a room receives that one user
- After member rating resolution, `validate_party` receives `mode_id`, the `(user ID, rating)` list in joining order and the `kind` of the host frame. When it returns `GameError`, every member gets `ROOM_FAILED` with that error and that `kind`, there is no party entry and no match, and the room is `Open`. A server that did not register `validate_party` behaves the same as `pass`
- On failure of `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_KICK`, only the sending user gets `ROOM_FAILED` with the `kind` of that frame as `request`
- The host's `MATCH_REQUEST` puts in one party entry, the room becomes `Matching`, and the rating of the party entry is the largest of the member ratings. In the match that the party is in, the indexes of the members are consecutive and their `party` is the same
- `MATCH_REQUEST` of a room whose member count is more than `max_party_size` is `ROOM_PARTY_TOO_LARGE`, and `MATCH_REQUEST` of a non-host member is `ROOM_NOT_HOST`. When a member leaves during `Matching`, the party entry is removed from the queue and the room is `Open`
- `MATCH_REQUEST` outside a room in a mode whose `allow_queue` is `false` is `MATCH_FAILED`(`INVALID_MODE`) and does not enter the queue. In a room of that mode, the host's `MATCH_REQUEST` is `ROOM_FAILED`(`INVALID_REQUEST`, `MATCH_REQUEST`)
- In a room of a mode whose `allow_room` is `false`, the host's `ROOM_START` is `ROOM_FAILED`(`INVALID_REQUEST`, `ROOM_START`) and there is no match. `ROOM_CREATE` of a mode whose `allow_room` is `false` and `max_party_size` is 1 is `ROOM_FAILED`(`INVALID_REQUEST`, `ROOM_CREATE`) and there is no room
- `source` of the match record of a match that `ROOM_START` created, and of the match record that the apply hook received, is `Room`, and for a match that queue matching (including party entries) created, it is `Queue`
- With `max_players` 4 and `team_size` 2, when solo users with ratings 100, 90, 80, 70 enter, 100 and 70 are team 0 and 90 and 80 are team 1. When two 2-member parties enter, the two parties are in different teams. When a 2-member party with member ratings 50, 50 enters first and two solo users with ratings 100, 90 enter after it, the team assignment has no team to put the party in, so the party is team 0 and the two users are team 1
- When the reporter's apply hook returns `GameError`, `ReportMatchResult` still succeeds with the judgement status, the report and the judgement stay, that index is marked and an `error` log is left. The apply of the other participants continues. So the judgement of a `Consensus` match is the same regardless of report order
- On a DEV server, `MATCH_REQUEST` with `lockstep` `true` is not grouped with `false` entries, `lockstep` of `MATCH_FOUND` of that match is `true`, and `deadline_at` is `start_at` + `matchmaker.lockstepMaxDurationMs` + `matchmaker.reportMarginMs`. An STG test server treats `lockstep` as `false`
- When `block-report` is in the server module list, two users where one blocked the other are not grouped into one match even when they are in the same queue, and each is grouped with other users. The same holds when one member of a party entry has a block relation with a member of another entry
- `BlockUser` after entering the queue is not used for the matching of that entry, and is used from the next `MATCH_REQUEST`
- In a mode where `rating_rule` of `match_mode` is set, the queue rating and the match record `ratings` are the `rating` of `rating.get_rating`, and the rating that `prepare_match_request` returned is not used
- When a `match_mode` row with `rating_rule` exists but `rating` is not in the server module list, the server does not start
