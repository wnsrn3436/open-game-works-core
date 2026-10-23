# live-event

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

This module judges the schedule of live events defined in data and the active window of data rows, records the participation of users, and hands the settlement of ended events to a content hook. Content writes the content of an event (rules, rewards, screens).

## dependency

- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_active_events` | ctx | list of `{event_id, round, start_at, end_at}` (event ID value, round, start time, end time) of the events active now. In ascending order of event ID value | empty list | content handler, hook, core module |
| `is_active` | ctx, event ID value | `true` when active | `false`. Also `false` for an unknown event ID value | content handler, hook |
| `is_in_active_window` | ctx, `start_at`, `end_at`, `live_event` (each value from the data row. none and 0 mean absent) | `true` when inside the active window | `false` | content handler, hook, `shop`, `gacha`, `iap`, `mission`, `attendance`, `offer` |
| `get_round` | ctx, event ID value | `round`, `start_at` (start time), `end_at` (end time) of the active round. When there is no active round, 0, the start time of the next round and the end time of the next round; when there is no next round either, all three 0 | all three 0 for an unknown event ID value | content handler, hook, `mission`, `shop`, `iap`, `attendance`, `offer` |
| `get_latest_round` | event ID value, time | `round`, `start_at` (start time), `end_at` (end time) of the latest round among the rounds with start time ≤ that time. All three 0 when there is no such round | all three 0 for an unknown event ID value | `ranking` |
| `round_to_write` | ctx, `live_event` (value from the data row. none and 0 mean absent) | `event_round` to write to a row by the round reset rule | none | `mission`, `shop`, `iap`, `attendance`, `offer` |
| `is_round_reset` | ctx, `live_event` (value from the data row. none and 0 mean absent), the row's `event_round` | `true` when the round reset rule reads the row as returned to its start | `false` | `mission`, `attendance`, `offer` |
| `join_event` | ctx, event ID value | `LiveEventResult.OK` | `LiveEventResult.NOT_ACTIVE`, `LiveEventResult.NOT_SETTLED`, `LiveEventResult.UNKNOWN_EVENT` | content handler, hook |
| `get_participation` | ctx, event ID value | last `round` and `settled` of the participation | `round` 0, `settled` `false` | content handler, hook |
| `on_request_start` | user ID | async operation. none | none. A failure is an `error` log | `routing`, `auth` |

- `on_request_start` is called in the request start step of `routing` and does the work of the settlement rules

`LiveEventResult`: `OK`, `NOT_ACTIVE`, `NOT_SETTLED`, `UNKNOWN_EVENT`

## behavior

schedule

- One event is one row of the `live_event` table. A round is one opening of the event, counted from 1
- The start time of round n is `start_at` + (n − 1) × `repeat`, and its end time is `end_at` + (n − 1) × `repeat`. When `repeat` is `null`, there is only round 1
- When there is a `repeat_until`, only rounds with start time < `repeat_until` exist
- A round is active when `server-time.is_reached`(start time) is `true` and `is_reached_strict`(end time) is `false`
- next round: among the rounds whose `is_reached`(start time) is `false`, the round with the earliest start time
- `get_latest_round` judges by the given time without a ctx and does not use `is_reached`. Among the rounds with start time ≤ that time, it also returns an ended round
- Client `UserStateCore.get_live_event_round` shows whether a round is active with the same table and the same calculation. The server makes the judgement

active window

- The active window is the period of a data row set by the columns `start_at` (`datetime?`), `end_at` (`datetime?`) and `live_event` (`ref<live_event.id>?`). When any one of the conditions below holds, the row is outside the active window, otherwise inside. `is_in_active_window` makes this judgement
  - `start_at` is set and `server-time.is_reached`(`start_at`) is `false`
  - `end_at` is set and `server-time.is_reached_strict`(`end_at`) is `true`
  - `live_event` is set and `is_active`(`live_event`) is `false`

round reset

- Round reset is the rule that returns user saved state tied to a data row with a `live_event` column to its start for each round of that event. `mission`, `shop`, `iap`, `attendance` and `offer` use it on their own UserState rows with `round_to_write` and `is_round_reset`
- That UserState row has an `int32 event_round` field. When the row is written, the round of `get_round`(`live_event`) is written when the data row has a `live_event`, otherwise 0 (`round_to_write`)
- When the row is read, if the data row has a `live_event`, the round of `get_round`(`live_event`) is not 0, and it differs from the row's `event_round` (`is_round_reset` is `true`), the fields that the module sets as returning to the start are read as their initial values and `event_round` as that round. When the row has a `reset_at` field, `reset_at` is read as that module's next reset time. The values read this way are saved only when there is a write to that row
- While the round is 0, the row's values are read as they are
- Round reset is checked before the lazy reset of `server-time`
- Client `UserStateCore` applies the same rule with the round of `get_live_event_round`

participation

- `join_event` records the user's participation in the active round. Called again in the same round, it changes nothing and is `OK`
- Participation is saved in the base proto's core UserState kind `LiveEventEntryUserState` (list kind). Only this module writes it, with `storage.put_core_state`. fields: `int64 id` (event ID value), `int32 round`, `int64 joined_at`, `bool settled`. Each event keeps only its last round
- When `settled` of the previous round is `false`, `join_event` for a new round is `NOT_SETTLED` and records nothing. A participation whose `settled` is `false` is not overwritten

settlement

- Settlement is content giving the result for a participation in an ended round. e.g. converting leftover event currency into another item, ranking rewards
- `on_request_start` does the settlement. For each `LiveEventEntryUserState` whose `settled` is `false`, it opens one out-of-request change with `storage.run_user_transaction` and does the steps below. When `WITHDRAWN`, it does nothing
  1. When the round's end time > request time, ends without doing anything
  2. Hook `settle_live_event` when `settle` is `true`
  3. Sets `settled` to `true`
- When the participation's event ID value is not in the `live_event` table, instead of steps 1 to 3 it sets `settled` to `true` without the hook and leaves an `error` log
- Settlement changes go in that request's response as the pending delta
- Settlement happens at the request start of the user's first request after the round end time. So a result of that round that a handler handles after the end time (e.g. the result of a match started before the end time) is handled after the settlement and is not part of it. The rule content follows is `## handler` of [`server-content`](../../server-content/SKILL.md)
- When the hook returns a `GameError` or throws, that one settlement is rolled back and an error log is left. `settled` stays `false`, and the next request does it again. The original request continues to be handled

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `settle_live_event` | settlement step 2 | ctx, event ID value, round | `pass` or `GameError` | does nothing and returns `pass` |

- `settle_live_event` is called inside `storage.with_hook_change_source`(ctx, `LiveEvent`, `<event ID value>:<round>`). The change source of item changes inside it is source `LiveEvent`, `ref` `<event ID value>:<round>`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `join_event` for an event that is not active | `NOT_ACTIVE` | set by content | none |
| `join_event` for an event whose previous round has `settled` `false` | `NOT_SETTLED` | set by content | none |
| event ID value not in the table | `UNKNOWN_EVENT` for `join_event`, `(0, 0, 0)` for `get_round` and `get_latest_round` | set by content for `join_event` | `error` log |
| settlement hook failure | none. The request continues | none | `error` log |
| the event of a participation to settle is not in the table | none. Ends the settlement without the hook | none | `error` log |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `server-time.silentMarginMs` | integer | core | content | time judgement margin of a `silent` request |

## data

`data/tables/live_event.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `start_at` | `datetime` | `All` |
| `end_at` | `datetime` | `All` |
| `repeat` | `duration?` | `All` |
| `repeat_until` | `datetime?` | `All` |
| `settle` | `bool` | `Server` |

- `end_at` > `start_at`
- When there is a `repeat`, `repeat` ≥ `end_at` − `start_at`. Rounds do not overlap
- When `repeat` is `null`, `repeat_until` is also `null`
- When there is a `repeat_until`, `repeat_until` > `start_at`. Round 1 always exists
- The server does not start when a row violates the rules of `live_event`
- After the first PROD build, among the `live_event` rows in the data of the PROD data tag of [`data`](../../data/SKILL.md), the `start_at`, `repeat` and `repeat_until` of a row whose `start_at` is at most the check time are not changed. The `end_at` of that row is only moved earlier, and the earlier value is after `start_at`. The check time is the time the data tool ran. On a violation the data tool blocks it with `prod_change`. A different schedule is made as a new row

## DEV

none. Moving the time in the DEV environment follows the cheat time offset of `server-time`

## test

- An event without `repeat` becomes active at `start_at` and is not active at `end_at`
- At a request time earlier than the round start time by less than `server-time.silentMarginMs`, `get_round` of a `silent` request returns that round as active, and `get_round` of a request without `silent` returns round 0 with that round's start time and end time. For both requests the round is active at end time − 1 and not active at the end time
- In a request without `silent`, `is_in_active_window` is `false` at `start_at` − 1, `true` at `start_at`, `true` at `end_at` − 1 and `false` at `end_at`; it is `false` when given a `live_event` that is not active, and `true` when all three are none
- The round number and times of an event with `repeat` are correct right before and right after the boundaries, and there is no round after `repeat_until`
- The server does not start when a row has `repeat_until` at most `start_at`
- `join_event` for an event that is not active is `NOT_ACTIVE` and saves nothing
- Two `join_event` calls in the same round leave one participation
- A participation in an ended round is settled only once, in `on_request_start` of the next request, and the settlement changes go in that response. They also go in a `Login` response
- In the first request after the round end time, hook `settle_live_event` is called before the handler, and `settled` of `get_participation` called by that handler is `true`
- When the settlement hook returns a `GameError`, only the settlement changes are rolled back, the original request succeeds, and the next request does the settlement again
- An event whose `settle` is `false` becomes `settled` without the hook
- A participation with `settled` `false` for an event not in the `live_event` table becomes `settled` without the hook in the next request, and one `error` log is left
- `join_event` for a new round changes a previous round row whose `settled` is `true` to the new round, and is `NOT_SETTLED` when there is a previous round whose `settled` is `false`
- At a time moved by the cheat time offset, the active judgement and settlement follow that time
- For each case of the core test fixture `live-event-round` (ID name of the `live_event` row, time, expected `get_round` result), `get_round` equals the expected value. The cases include times before the first round, between rounds, after the last round and after `repeat_until`. The `UserStateCore` test uses the same fixture
- `get_round` of an event ID value not in `live_event` is `(0, 0, 0)` and leaves an `error` log
- `round_to_write` returns 0 for no `live_event` and the round for an active round. `is_round_reset` is `false` for no `live_event`, between rounds (round 0) and for the same round as the row's `event_round`, and `true` for a different active round
- `get_latest_round` returns `(0, 0, 0)` at the first round's start time − 1, that round at the start time, that ended round from the round end time to the next round's start time − 1, and the last round after `repeat_until`
- The `ItemChange` of an item that content grants inside `settle_live_event` has source `LiveEvent` and ref `<event ID value>:<round>`
- The server does not start when a row violates the data rules
