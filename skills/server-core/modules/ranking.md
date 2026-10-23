# ranking

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

Collects user or guild scores into ranking boards defined in data and lets ranks be queried. When a season ends, sends rank rewards by `mailbox`.

## dependency

- `mailbox`
- `item-ledger`
- `storage`
- `server-time`
- `logging`
- `live-event`
- optional dependency: `guild`, `nickname`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `submit_score` | ctx, board ID value, score, display | `RankingResult.OK` | failure element of `RankingResult` | content handler, hook |
| `submit_guild_score` | ctx, board ID value, guild ID, score | `RankingResult.OK` | failure element of `RankingResult` | content handler, hook |
| `update_display` | ctx, display | `RankingResult.OK` | `INVALID_DISPLAY` | content handler |
| `get_my_entry` | ctx, board ID value | my `RankingEntry` in the current season. On a guild board, the entry of my guild | When there is no score, rank 0 and score 0. Throws when the board ID value is not in `ranking_board` | content handler, hook |
| `get_season` | ctx, board ID value | `season` (number) and `season_ends_at` (end time) of the current season | `UNKNOWN_BOARD` | content handler, hook, `rating` |
| `GetRankingTop` (core rpc). changes: none | board ID value, `previous`, `offset`, `limit` | season number, season end time, `RankingEntry` list | `INVALID_REQUEST` | `routing`. Client content code sends it |
| `GetRankingAround` (core rpc). changes: none | board ID value, `previous` | season number, season end time, my `RankingEntry`, `RankingEntry` list before and after | `INVALID_REQUEST` | `routing`. Client content code sends it |
| `remove_user` | ctx | none | none | `auth` (`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age, job `auth_guest_sweep`), `admin-api` |

- There is no core rpc through which the client sends a score. A content handler or hook decides the score on the server and submits it with `submit_score` or `submit_guild_score`. A score decided by client simulation is submitted in `apply_play_session` as the result that `play-session.verify_play_session` verified
- The display is an extra string shown with the nickname in rank lists. e.g. a title. It may be an empty string. Content decides it and does not put the nickname or personal data (email, social login identifier) in it
- `RankingEntry` (base proto message): `int32 rank` (from 1. 0 when outside the ranks), `int64 user_id`, `string display`, `int64 score`, `string nickname`, `int64 guild_id` (guild ID on a guild board. 0 on a user board), `string guild_name` (guild name on a guild board. Empty string on a user board)
- The `nickname` of `RankingEntry` is the current nickname that `GetRankingTop` and `GetRankingAround` read with `nickname.get_nicknames` when they build the response. They split the user IDs into groups of `nickname.maxLookupCount` per call. It is an empty string for a user without a nickname and on a server whose server module list does not have `nickname`. The `nickname` of the `RankingEntry` of `get_my_entry` and of hook `ranking_season_reward` is an empty string
- When `previous` is `true`, queries the season just before
- `offset` is the number of ranks to skip, and `limit` is the maximum number of entries to return

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `GetRankingTopRequest` | `board_id` | `int32` | `table`: `ranking_board` |
| `GetRankingTopRequest` | `previous` | `bool` | none |
| `GetRankingTopRequest` | `offset` | `int32` | `min`: 0, `max`: 2^31−1 |
| `GetRankingTopRequest` | `limit` | `int32` | `min`: 1, `max_key`: `ranking.maxPageSize` |
| `GetRankingAroundRequest` | `board_id` | `int32` | `table`: `ranking_board` |
| `GetRankingAroundRequest` | `previous` | `bool` | none |

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetRankingTopResponse` | `season` | `int64` |
| `GetRankingTopResponse` | `season_ends_at` | `int64` |
| `GetRankingTopResponse` | `entries` | `repeated RankingEntry` |
| `GetRankingAroundResponse` | `season` | `int64` |
| `GetRankingAroundResponse` | `season_ends_at` | `int64` |
| `GetRankingAroundResponse` | `my_entry` | `RankingEntry` |
| `GetRankingAroundResponse` | `entries` | `repeated RankingEntry` |

- `season_ends_at` is the season end time of the query output

`RankingResult`

| element | meaning |
|---|---|
| `OK` | Applied. Also `OK` when `Best` did not change the score because the score was not better |
| `UNKNOWN_BOARD` | The board ID value is not in `ranking_board` |
| `OUT_OF_RANGE` | The score or the `Sum` total is outside the range from −(2^53−1) to 2^53−1 |
| `INVALID_DISPLAY` | The display exceeds `ranking.maxDisplayBytes` or contains control characters |
| `ENTITY_MISMATCH` | The board's `entity` does not match the operation. `submit_score` accepts only user boards, and `submit_guild_score` only guild boards |
| `UNKNOWN_GUILD` | The guild of `submit_guild_score` does not exist |
| `SEASON_CLOSED` | On an event board, the round of the current season is not active: before the first round, between rounds, after the last round |

## behavior

- `once_key` prefix: `ranking:`

table

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `ranking_score` | `game` | `board_id`, `season`, `user_id`, `score`, `reached_at`, `display` | `(board_id, season, user_id)` | none | `(board_id, season, score, reached_at, user_id)`, `(user_id)` |
| `ranking_season` | `game` | `board_id`, `season`, `status`, `end_at`, `cursor_score`, `cursor_reached_at`, `cursor_entity_id`, `cursor_rank`, `failed_count`, `lease_owner`, `lease_until_at` | `(board_id, season)` | none | `(status, end_at)` |
| `ranking_season_shift` | `game` | `board_id`, `shift` | `board_id` | none | none |
| `ranking_guild_score` | `game` | `board_id`, `season`, `guild_id`, `score`, `reached_at` | `(board_id, season, guild_id)` | none | `(board_id, season, score, reached_at, guild_id)`, `(guild_id)` |
| `ranking_reward_retry` | `game` | `board_id`, `season`, `user_id`, `entry`, `attempts`, `next_attempt_at` | `(board_id, season, user_id)` | none | `(user_id)` |

- The five tables are registered with `storage.register_table`. `ranking_score` and `ranking_reward_retry` are registered with personal data user column `user_id`. `ranking_guild_score` is registered without a personal data user column. The scope is `game` because jobs and queries read other users' rows and delete per season
- There is one `ranking_season` row per season of a board that has `cycle` or `live_event`. `status` is `Open`, `Closing`, `Retrying` or `Closed`, and `end_at` is the end time of that season. `cursor_score`, `cursor_reached_at` and `cursor_entity_id` are the sort key of the last handled score row (`cursor_entity_id` is the user ID on a user board and the guild ID on a guild board) and are null before handling. `cursor_rank` is the rank of that row and is 0 before handling. `failed_count` is the number of users whose reward was given up. `lease_owner` is first an empty string, and `lease_until_at` is first 0
- There is one `ranking_reward_retry` row (retry row) per (board, season, user) whose handling for one user ended in `FAILED`. `entry` is the bytes of the `RankingEntry` passed to that handling, `attempts` is the number of retries, and `next_attempt_at` is the next retry time

season

- A board whose `cycle` and `live_event` are `null` has one season (number 0) that does not end
- When there is `cycle`, the season number at time t is `server-time.get_period_number`(`cycle`, t) + the season shift of that board, and the season boundary is the reset boundary of `cycle`
- event board: a board that has `live_event`. The season number and end time at time t are the round and end time of `live-event.get_latest_round`(`live_event`, t). Before the first round, number 0 and end time 0. Between rounds and after the last round, the season is the last started round. Event boards do not use the season shift. e.g. the ranking of an event held every weekend
- season end time: on a board that has `cycle`, the end time of the season at time t is `server-time.get_next_reset`(`cycle`, t). The end time of a season closed with `close_season_now` is the time it was closed
- season shift: an integer per board. Kept in a `ranking_season_shift` row; 0 when there is no row. Only DEV operation `close_season_now` changes it
- `get_season` returns the season number at `clock_now` and the end time of that season. It equals the season that `submit_score` applies to at that time. For a board whose `cycle` and `live_event` are `null`, number 0 and end time 0
- Other values that follow a board's season (e.g. the season of `rating`) read the season number with `get_season`. They do not calculate it again from `cycle`, `live_event` and the season shift
- The time for season judgement is `server-time.clock_now`. The cheat time offset is not added
- There is one score per (board, season, user). A new season starts with empty scores

score

- `submit_score` applies to the season at that time. The reached time is the same time
  - `Best`: changes the score and the reached time only when the new score is better. Better is the larger value when `sort_direction` is `Desc` and the smaller value when it is `Asc`
  - `Sum`: adds the score and changes the reached time
  - `Set`: changes the score to the new score and changes the reached time. e.g. rating
  - The display is changed to the new value even when the score does not change
- On an event board, when that time is at or after the season end time or the season number is 0, `submit_score` is `SEASON_CLOSED` and changes nothing
- `update_display` changes the display of the current season row on every board of the user
- `submit_score` and `update_display` write only that user's `ranking_score` rows inside ctx's user transaction. As an exception, on a board that has `cycle` or `live_event`, `submit_score` inserts the `ranking_season` row of that season with an insert that writes nothing on a key conflict. The inserted row's `status` is `Open` and its `end_at` is the end time of that season. Concurrent submissions to the same board are all applied. Handlers do not read or write ranking storage directly
- Score rows have scope `game`, so `storage.delete_user` does not delete them. On withdrawal, `remove_user` deletes them
- Rank order is score order; for the same score, the user with the earlier reached time comes first, and when that is also the same, the user with the smaller user ID comes first
- Only ranks 1 to `size` have a rank. Users after that have rank 0

query

- `GetRankingTop` returns from rank `offset` + 1 to the smaller of `offset` + `limit` and `size`. When `offset` ≥ `size`, an empty list. After `nickname` is filled, the result is cached per (board, season, `offset`, `limit`) for `ranking.topCacheMs`
- `GetRankingAround` returns my row and a list that joins, in rank order, the `ranking.aroundCount` entries before my rank and the `ranking.aroundCount` entries after it, excluding my row. When I have no score or my rank is 0, my row's rank is 0 and the before and after list is empty. Not cached
- When `previous` is `true` and there is no previous season, or it was deleted after `ranking.seasonRetentionMs` passed, an empty list
- `previous` on a board whose `cycle` and `live_event` are `null` is an empty list
- season end time of the query output: for the current season, the end time that `get_season` returned. For `previous`, the `end_at` of the previous season's `ranking_season` row; when there is no row, `server-time.get_period_start`(`cycle`, `clock_now`) on a board that has `cycle` and 0 on an event board. 0 on a board whose `cycle` and `live_event` are `null`

guild board

- A board whose `entity` is `Guild` is a guild board, and a board whose value is `User` is a user board. A guild board keeps one score per guild. In this spec, a score row is a `ranking_score` row on a user board and a `ranking_guild_score` row on a guild board
- In a guild board entry, `user_id` is 0 and `display` and `nickname` are empty strings
- `submit_guild_score` processing order. On failure, changes nothing
  1. `UNKNOWN_BOARD` when the board does not exist, `ENTITY_MISMATCH` when it is a user board, `SEASON_CLOSED` under the `SEASON_CLOSED` condition of `submit_score` on an event board
  2. Locks that guild row with `guild.lock_guild`(ctx, guild ID). `UNKNOWN_GUILD` when it returns none. When it is `FAILED`, throws and the request is `INTERNAL`
  3. Applies to that guild's `ranking_guild_score` row. The score range, the application of the update mode, the reached time and the insert of the `ranking_season` row are the same as in `submit_score`
- Submissions for the same guild are handled one at a time by the guild row lock, and all are applied
- `submit_score` is `ENTITY_MISMATCH` on a guild board. `update_display` does not change guild boards
- Rank order on a guild board is score order; for the same score, the guild with the earlier reached time comes first, and when that is also the same, the guild with the smaller guild ID comes first
- `GetRankingTop` returns guild entries. My entry in `GetRankingAround` and `get_my_entry` is the entry of the guild that `guild.get_member`(ctx, me) returned. When I am not a guild member or that guild has no score, my entry is rank 0 and score 0, its `guild_id` is my guild ID (0 when I am not a member), and the before and after list is empty
- `guild_name` is filled with `guild.get_guild_infos` at query time. Empty string when the guild does not exist. The cache of `GetRankingTop` keeps the filled result
- disband: at server start, ranking registers a function with `guild.register_disband_listener`. The function deletes the `ranking_guild_score` rows of that guild on every board and in every season
- When there is a guild board and the server module list does not have `guild`, the server does not start

season reward

- Each time job `ranking_season` (period `ranking.seasonCheckIntervalMs`), which ranking registered with `server-time.schedule_job` at server start, runs, it does the following
  1. seasons to handle: `ranking_season` rows whose `status` is `Open` and `end_at` ≤ `clock_now`, and rows whose `status` is `Closing` or `Retrying` and `lease_until_at` ≤ `clock_now`. They are handled one by one in `(board_id, season)` ascending order
  2. lease: in one game transaction, does a conditional update that, only when `lease_owner` and `lease_until_at` are still what they were when the row was picked, sets `lease_owner` to a new secure random value and `lease_until_at` to `clock_now` + `ranking.seasonJobLeaseMs`, and changes `status` to `Closing` when it is `Open`. When no row changed, the lease was not taken and that season is skipped. When `status` is `Retrying`, does reward retry instead of steps 3 to 5
  3. When the board's `reward_mail` is `null`, changes the season to `Closed` only when `lease_owner` is its own value. Otherwise handles the score rows of that season in rank order one by one, starting from the row after the cursor, from rank `cursor_rank` + 1 to the board's `size`. On a user board it does the handling for one user for the user of that row; on a guild board, the guild handling for the guild of that row
  4. Each time it handles one score row, in one game transaction, only when `lease_owner` is its own value, writes the cursor, `cursor_rank`, `failed_count` and the retry rows that the handling inserts, and extends `lease_until_at` to `clock_now` + `ranking.seasonJobLeaseMs`. When it is not its own value, writes nothing and stops handling that season. When the server instance that took the lease stops, another server instance continues from after the cursor after the lease ends
  5. When it has handled up to rank `size` or no rows are left, only when `lease_owner` is its own value, changes the season to `Closed` when that season has no retry rows, and otherwise changes it to `Retrying` and writes 0 to `lease_until_at`. When changing to `Closed` with `failed_count` 1 or more, leaves that number in an `error` log
  6. retention: for each season whose `status` is `Closed` and `end_at` + `ranking.seasonRetentionMs` ≤ `clock_now`, deletes that season's score rows and `ranking_season` row in one game transaction
- The handling for one user is one out-of-request change of that user opened with `storage.run_user_transaction`. When the user is `WITHDRAWN`, it is skipped
  1. Decides the reward with hook `ranking_season_reward`. When the hook throws or its output format is wrong, the change function throws and that handling is `FAILED`
  2. When the reward is not empty, calls `mailbox.send_mail` for each chunk made by splitting the attachment list in order into groups of `mailbox.maxAttachments`. When the attachment list is empty, there is one empty chunk. The template is the board's `reward_mail`, `args` is integer `MailArg`s `rank` and `season`, `attachments` is that chunk, and `extra_id` is the hook's `extra_id` for the first chunk and 0 otherwise. The `once_key` of chunk k is `ranking:<board ID value>:<season>` when k is 1 and `ranking:<board ID value>:<season>:<k>` when k is 2 or more. `ALREADY_SENT` from `send_mail` counts as success; on `INVALID_INPUT`, the change function returns `CoreError` `INTERNAL` and that handling is `REJECTED`
- The result of the handling for one user is the result of `run_user_transaction`. On `REJECTED`, leaves an `error` log and adds 1 to `failed_count`. On `FAILED`, leaves an `error` log, and when `ranking.rewardRetryMaxAttempts` is 1 or more, inserts a retry row (`attempts` 0, `next_attempt_at` `clock_now` + `ranking.rewardRetryInitialMs`) with an insert that writes nothing on a key conflict; when it is 0, adds 1 to `failed_count`. Then goes to the next user
- guild handling: in a game tx opened with `storage.run_game_transaction`, reads `guild.list_member_ids`(game tx, guild ID) and does the handling for one user for each member. Its `RankingEntry` is the entry of that guild. Each time it handles one member, in one game transaction, only when `lease_owner` is its own value, writes the retry rows that the handling inserts and extends `lease_until_at` to `clock_now` + `ranking.seasonJobLeaseMs`; when it is not its own value, stops handling that season. After handling all members, it does step 4 and adds in step 4 the number that the member handling of that guild adds to `failed_count`. When it stops during the handling, the next handling does that guild again from the first member
- The members of guild handling are the members at the time of handling. Reward eligibility (e.g. only members who joined before the season end time) is decided by hook `ranking_season_reward`. Because `once_key` is the same per user, a member who moved to another guild during handling also receives the mail once
- reward retry: the handling done in step 2 for a season whose `status` is `Retrying`. Among that season's retry rows, the rows with `next_attempt_at` ≤ `clock_now` are taken one by one in `user_id` ascending order, and the handling for one user is done again with that row's `entry` as the `RankingEntry`. Each time it handles one row, in one game transaction, only when `lease_owner` is its own value, writes the following and extends `lease_until_at` to `clock_now` + `ranking.seasonJobLeaseMs`. When it is not its own value, writes nothing and stops handling that season
  - `COMMITTED`, `WITHDRAWN`: deletes that row
  - `REJECTED`: deletes that row, adds 1 to `failed_count` and leaves an `error` log
  - `FAILED`: adds 1 to `attempts`. When `attempts` ≥ `ranking.rewardRetryMaxAttempts`, deletes that row, adds 1 to `failed_count` and leaves an `error` log. Otherwise writes `clock_now` + g(`attempts`) to `next_attempt_at`. g(0) is `ranking.rewardRetryInitialMs`, and g(a) is the smaller of the quotient of g(a − 1) × `ranking.rewardRetryFactorPermille` ÷ 1000 and `ranking.rewardRetryMaxIntervalMs`
- After reward retry, when that season has no retry rows, changes it to `Closed` only when `lease_owner` is its own value, and when `failed_count` is 1 or more, leaves that number in an `error` log. When some remain, writes 0 to `lease_until_at` only when `lease_owner` is its own value
- When the handling for one user is `FAILED` after `stop()` has started, does not write its result (cursor, `failed_count`, retry rows, `attempts` of reward retry) and stops handling that season. After `stop()` has started, does not do the `Closed` and `Retrying` transitions of step 5 and of the end of reward retry. The next lease holder continues
- Even when the user of a retry row is handled again, `once_key` is the same, so mail goes once per user

withdrawal

- `remove_user` deletes that user's score rows and retry rows on every board and in every season inside ctx's user transaction. `admin-api` opens that user's out-of-request change with `storage.run_user_transaction` and calls it. A deleted user is not in query results or among season reward targets

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `ranking_season_reward` | step 1 of season reward | ctx (the user receiving the reward), board ID value, season number, season end time (`end_at` of `ranking_season`), `RankingEntry` | `attachments` (attachment `ItemAmount` list), `extra_id`. An empty list and 0 mean no reward | the `reward` group of the `ranking_reward` row whose board is the same and `rank_from` ≤ rank ≤ `rank_to`, and `extra_id` 0. No reward when there is no row |

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| unknown board in `submit_score`, `submit_guild_score`, `get_season` | `UNKNOWN_BOARD` | set by content | `error` log |
| `get_my_entry` with a board ID value not in `ranking_board` | throw | `INTERNAL` | `error` log by `routing` |
| score out of range | `OUT_OF_RANGE` | set by content | `error` log |
| display error | `INVALID_DISPLAY` | set by content | `warn` log |
| board ID value of a core rpc not in the table, `offset` or `limit` of `GetRankingTop` out of range | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `FAILED` in season reward handling | none. Inserts a retry row and goes to the next user. When retries are `FAILED` `ranking.rewardRetryMaxAttempts` times, gives up and counts it in `failed_count` | none | `error` log. On the first `FAILED` and on giving up |
| `REJECTED` in season reward handling | none. Counts it in `failed_count` and goes to the next user | none | `error` log |
| board `entity` mismatch in `submit_score`, `submit_guild_score` | `ENTITY_MISMATCH` | set by content | `error` log |
| guild that does not exist in `submit_guild_score` | `UNKNOWN_GUILD` | set by content | `warn` log |
| submission outside the active round of an event board | `SEASON_CLOSED` | set by content | none |
| guild row lock wait timeout in `submit_guild_score` | throw | `INTERNAL` | `error` log by `routing` |
| a guild board exists and `guild` is not in the server module list | server start failure | none | `error` log |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `ranking.maxPageSize` | integer | core | content | upper limit of `limit` of `GetRankingTop` |
| `ranking.aroundCount` | integer | core | content | number of entries before me and after me each in `GetRankingAround` |
| `ranking.topCacheMs` | integer | core | content | cache duration of the `GetRankingTop` result |
| `ranking.maxDisplayBytes` | integer | core | content | byte length limit of the display |
| `ranking.seasonCheckIntervalMs` | integer | core | content | period of job `ranking_season` |
| `ranking.seasonJobLeaseMs` | integer | core | content | DB lease duration of job `ranking_season` |
| `ranking.rewardRetryInitialMs` | integer | core | content | interval until the first retry of a season reward |
| `ranking.rewardRetryFactorPermille` | integer | core | content | multiplier of the season reward retry interval. permille |
| `ranking.rewardRetryMaxIntervalMs` | integer | core | content | maximum season reward retry interval |
| `ranking.rewardRetryMaxAttempts` | integer | core | content | maximum number of season reward retries for one user. The first handling is not counted |
| `ranking.seasonRetentionMs` | integer | core | content | duration for which the scores of an ended season are kept |
| `mailbox.maxAttachments` | integer | core | content | limit on the number of `reward` elements of `ranking_reward` and the number of attachments in one season reward mail |
| `nickname.maxLookupCount` | integer | core | content | number of users passed to one call of `get_nicknames` |
| `dailyResetOffsetMs` | integer | game | none | ms by which the game day boundary is offset from UTC 00:00. The `Weekly` and `Monthly` season boundaries follow it |

## data

`data/tables/ranking_board.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `sort_direction` | `enum<RankingOrder>` | `All` |
| `update_mode` | `enum<RankingUpdateMode>` | `All` |
| `entity` | `enum<RankingEntity>` | `All` |
| `cycle` | `enum<ResetCycle>?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |
| `size` | `int` | `All` |
| `reward_mail` | `ref<mail_template.id>?` | `Server` |

- `size` is 1 or more
- `cycle` and `live_event` are not used together. When both are present, `out_of_range`. When both are `null`, that board has a single season that does not end. `ResetCycle` is an enum of `server-time`

format argument

| text | arguments |
|---|---|
| `ranking_board.reward_mail` | `{rank}`(`integer`), `{season}`(`integer`) |

`data/tables/ranking_reward.csv`

| column | type | build target |
|---|---|---|
| `id` | `id` | `All` |
| `rank_from` | `int` | `All` |
| `rank_to` | `int` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |

- `id` is an ID name of `ranking_board`. When it is not there, `ref_missing`
- 1 ≤ `rank_from` ≤ `rank_to` ≤ the board's `size`, and the ranges of the same board do not overlap
- When the board's `reward_mail` is `null`, that board's `ranking_reward` rows are `out_of_range`
- The number of `reward` elements is at most `mailbox.maxAttachments`. Server start checks this rule, not the data check
- When a row violates the rules of `ranking_board` or `ranking_reward`, the server does not start

`data/enums.csv`

| type | element |
|---|---|
| `RankingOrder` | `Desc`, `Asc` |
| `RankingUpdateMode` | `Best`, `Sum`, `Set` |
| `RankingEntity` | `User`, `Guild` |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `close_season_now` | ctx, board ID value | none | none | content cheat handler, `testing` |

- On a board that has `cycle`, `close_season_now`, in ctx's transaction, locks that board's `ranking_season_shift` row with `storage.lock_game_row`, inserts or changes the current season's `ranking_season` row to `status` `Closing` and `end_at` `clock_now`, takes the lease (`lease_owner` a new secure random value, `lease_until_at` `clock_now` + `ranking.seasonJobLeaseMs`), and adds 1 to the season shift. For the reward, the handling called with `storage.after_commit` after commit handles that season with that lease through steps 3 to 5 of job `ranking_season`. When that handling stops, job `ranking_season` continues after the lease ends. The next season starts with empty scores, and its end time stays the calculated value. On a board whose `cycle` is `null`, changes nothing and leaves a `warn` log
- STG·PROD builds do not have `close_season_now`

## test

- In season reward and reward retry, the handling of a user that is `FAILED` after `stop()` has started does not change the cursor, `failed_count`, retry rows or `attempts`, that season does not become `Closed`, and the next lease holder continues from that user
- `Best` applies only a better score, `Sum` adds, and `Set` changes the score even to a worse score. Better is correct for `Asc` and `Desc`
- For the same score, the user who reached it first comes first
- Scores submitted concurrently to the same board are all applied
- A user outside `size` has rank 0
- `GetRankingTop` returns the same result within the cache duration and shows new scores after it
- While scores do not change, joining the results of `GetRankingTop` with `offset` 0, `limit` n and with `offset` n, `limit` n equals the result with `offset` 0, `limit` 2n. There are no ranks beyond `size`, and `offset` ≥ `size` returns an empty list. `limit` 0 and more than `ranking.maxPageSize` are `INVALID_REQUEST`
- `GetRankingAround` returns the `aroundCount` entries before me and after me, excluding my row, in rank order
- After the nickname is changed with `SetNickname` or `rename_user`, the `nickname` of that user's `RankingEntry` in `GetRankingAround` is the new nickname, and `GetRankingTop` has the new nickname after `ranking.topCacheMs`. The display of the `ranking_score` row stays the same
- `submit_score` with an empty display is `OK`
- A submission just before a season boundary goes into the previous season, and a submission just after it goes into the new season
- The season of a `Weekly` board changes at the start of a game day whose date is a Monday, and the season of a `Monthly` board at the start of a game day whose date is the 1st. Both follow game settings `dailyResetOffsetMs`, and the numbers of two consecutive seasons differ by 1
- The rewards of an ended season go by mail once each according to the `ranking_reward` ranges, and even when the job is stopped midway and started again, they do not go twice to the same user
- The `args` of the reward mail are integer `MailArg`s `rank` and `season`
- When the `ranking_season_reward` hook is registered, the reward is sent with its result
- When hook `ranking_season_reward` returns a list longer than `mailbox.maxAttachments`, one mail goes per chunk, only the first mail carries the hook's `extra_id`, and from the second chunk the `once_key` is `ranking:<board ID value>:<season>:<k>`. Running the job again does not add mail
- After `remove_user`, that user is not in query results or season rewards, and that user has no retry rows
- An out-of-range score and an out-of-range `Sum` total are `OUT_OF_RANGE`, and the score stays the same
- A season past the retention duration is deleted, and a `previous` query returns an empty list
- When a row violates the data rules, the server does not start
- A `ranking_reward` row of a board whose `reward_mail` is `null` is data check `out_of_range`, and the server does not start
- `close_season_now` called by `testing.call_dev` with a user ID does not throw. After `wait_background`, the rewards of the closed season go out, the current season starts with empty scores, and a `previous` query returns the closed season. The end time of the current season stays the same
- When the transaction that called `close_season_now` is rolled back, the season shift and the season state stay the same, and no rewards go out
- `close_season_now` on a board whose `cycle` is `null` does not change scores or seasons and leaves a `warn` log
- `get_season` returns the season number that `submit_score` at the same time applied to and the end time of that season, and after `close_season_now` it returns a number 1 larger. A board whose `cycle` and `live_event` are `null` gives number 0 and end time 0, and a board that does not exist gives `UNKNOWN_BOARD`
- During `Closing` handling, after a user ranked above the already handled ranks becomes a withdrawn user, starting the job again does not skip the next user, and the ranks continue
- When a user who already got the mail is handled again and `send_mail` is `ALREADY_SENT`, it is not counted in `failed_count`
- When the reward handling for one user is `FAILED`, a retry row for that user is created and the season is `Retrying`. The job after `next_attempt_at` is reached sends that user the reward mail once, deletes the retry row and changes the season to `Closed`
- When retries keep being `FAILED`, the `next_attempt_at` interval grows from `ranking.rewardRetryInitialMs` by the g rule and does not exceed `ranking.rewardRetryMaxIntervalMs`. When `ranking.rewardRetryMaxAttempts` retries are `FAILED`, the retry row is deleted, `failed_count` goes up by 1, the season is `Closed`, and an `error` log is left
- A user whose reward handling is `REJECTED` is counted in `failed_count` without a retry row
- Even when the server instance is stopped before a season with scores ends and `restart_test_server` is run several seasons later with `set_time`, the reward goes once per user for each ended season with scores
- When job `ranking_season` of two server instances started with `testing.start_peer_server` take the lease of the same season at the same time, only one takes it, and the reward goes once per user. After the lease ends and another instance takes it, the earlier instance stops without writing the cursor
- When a season closed with `close_season_now` is queried with `previous`, the season end time is the time it was closed, and that season's scores are deleted by the job after closing time + `ranking.seasonRetentionMs` is reached
- The season end time of a query on a board whose `cycle` and `live_event` are `null` is 0
- The season number of an event board is the number of the round that last started at that time. A submission within a round goes into that round's season, and `submit_score` and `submit_guild_score` before the first round, at a round end time and between rounds are `SEASON_CLOSED`, and the score stays the same
- The job after the round end time of an event board sends that season's rewards according to the `ranking_reward` ranges, and `GetRankingTop` between rounds returns the ended round as `season` and that round's end time as `season_ends_at`. A submission in the next round goes into a new season with empty scores, and a `previous` query returns the previous round
- `close_season_now` on an event board does not change scores or seasons and leaves a `warn` log
- A `ranking_board` row that has both `cycle` and `live_event` is data check `out_of_range`, and the server does not start
- `get_my_entry` with a board ID value not in `ranking_board` throws, and the request is `INTERNAL`
- For a user with a cheat time offset, the `season` and `season_ends_at` of `GetRankingTop` and `GetRankingAround` are the number and end time that `get_season` returned at the same time
- `admin-api.export_personal_data` includes that user's `ranking_score` rows
- `submit_guild_score` on a guild board adds for `Sum` and applies only a better score for `Best`. `Sum` scores that two members submit concurrently to the same guild are all applied
- `submit_guild_score` on a user board and `submit_score` on a guild board are `ENTITY_MISMATCH`, `submit_guild_score` for a guild that does not exist is `UNKNOWN_GUILD`, and the score stays the same
- When a lock wait timeout occurs while another transaction holds the guild row lock, `submit_guild_score` throws, the request is `INTERNAL`, and the score stays the same
- A `GetRankingTop` entry of a guild board carries `guild_id`, `guild_name` that is the current guild name, and `user_id` 0, and for the same score, the guild that reached it first comes first. `GetRankingAround` is based on my guild, and when I am not a guild member, my entry is rank 0 and the before and after list is empty
- After a guild is disbanded, there are no `ranking_guild_score` rows of that guild in any season
- The guild board rewards of an ended season go by mail once to each member at the time of handling, and hook `ranking_season_reward` receives that guild entry and the season end time. Even when the job is stopped in the middle of the member handling of a guild and started again, mail goes once per member
- In data with a guild board, when `guild` is not in the server module list, the server does not start
