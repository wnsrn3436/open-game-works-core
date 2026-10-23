# attendance

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

Lets a user receive a reward once per game day from an attendance calendar defined in data. Judges progress mode, progress reset cycle, active window and unlock condition, and grants rewards with `mailbox.grant_or_mail`.

## dependency

- `item-ledger`
- `mailbox`
- `live-event`
- `validation`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `ClaimAttendance` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `AttendanceUserState`, `content` | calendar ID value | received day, list of granted `ItemAmount`, whether granted by mail | `INVALID_REQUEST`, `ATTENDANCE_UNAVAILABLE`, `ATTENDANCE_LOCKED`, `ATTENDANCE_ALREADY_CLAIMED`, `ATTENDANCE_COMPLETED`, `INTERNAL`, `GameError` of the hook | `routing`. Sent by client content code |
| `get_attendance` | ctx, calendar ID value | `day`, `next_day` | for an unknown calendar ID value, both are 0 | content handler, hook |

- calendar ID value: the ID value of the `attendance_calendar` table
- `day`: the last received day number in the current progress. 0 when never received or when progress returned to the start
- `next_day`: the day number that a claim now would receive. 0 when nothing can be received. `get_attendance` looks at the active window and whether the user received today, and does not look at `requirement`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ClaimAttendanceRequest` | `calendar_id` | `int32` | `table`: `attendance_calendar` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `ClaimAttendanceResponse` | `day` | `int32` |
| `ClaimAttendanceResponse` | `items` | `repeated ItemAmount` |
| `ClaimAttendanceResponse` | `mailed` | `bool` |

## behavior

- `once_key` prefix: `attendance:`

### progress

- One calendar is one row of `attendance_calendar`. A day is one row of `attendance_reward` whose `id` is that calendar, and the day number is that row's `day`. N is the number of days of that calendar
- Progress is saved in the core UserState kind `AttendanceUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state`, `delete_core_state`. field: `int64 id`(calendar ID value), `int32 day`, `int64 claimed_day_number`(the last received game day number. 0 when none), `int64 reset_at`(the time progress returns to the start. 0 when none), `int32 event_round`
- Today is `server-time.get_day_number`(request time)
- When a row is read, the items below are applied in order. When there is no row, `day`, `claimed_day_number`, `reset_at`, `event_round` are 0. The applied result is saved only when there is a write
  1. round reset of `live-event`. The fields that return to the start are `day`, `claimed_day_number`, and their first value is 0
  2. When `reset_at` is not 0 and request time ≥ `reset_at`, treats `day`, `claimed_day_number` as 0
  3. When `mode` is `Streak`, `claimed_day_number` is not 0, and today − `claimed_day_number` > 1, treats `day` as 0
- next day: none when outside the active window or when `claimed_day_number` is today. When `day` < N, it is `day` + 1. When `day` ≥ N, none if `mode` is `Once`, otherwise 1

| mode | after last day | missed game day |
|---|---|---|
| `Cycle` | receives again from 1 on the next game day | does not break progress |
| `Once` | receives no more | does not break progress |
| `Streak` | receives again from 1 on the next game day | when even one game day is missed, the next claim is 1 |

- When `reset` is not `null`, progress returns to the start every reset cycle. e.g. a `Once` calendar whose `reset` is `Monthly` is received up to N days per game month
- `get_attendance` returns the applied `day` and the next day (0 when none) and writes nothing
- Client `UserStateCore.get_attendance` does the same calculation

### claim

`ClaimAttendance` processing order. On failure, does not change progress or items.

1. When `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the calendar row) is `false`, `ATTENDANCE_UNAVAILABLE`
2. When `passed` of the `validation` `evaluate_requirement` result for `requirement` is `false`, `ATTENDANCE_LOCKED`
3. When `claimed_day_number` after applying is today, `ATTENDANCE_ALREADY_CLAIMED`
4. When there is no next day, `ATTENDANCE_COMPLETED`
5. hook `validate_attendance_claim`
6. When `reward` of the next day row is not an empty array, `mailbox.grant_or_mail`. source `Attendance`, `ref` `<calendar ID value>:<next day>`, `once_key` `attendance:<calendar ID value>:<event_round>:<today>`(`<event_round>` is the `event_round` that step 8 writes), template reserved ID `[attendance_reward_mail]`, `args` an empty list. When the result is `Mailed`, sets whether granted by mail to `true`
7. When `extra_grant` of the next day row is `true`, hook `grant_attendance_extra`
8. Writes `day` as the next day, `claimed_day_number` as today, and `event_round` by the round reset rule. `reset_at` is 0 when `reset` is `null`, otherwise `server-time.get_next_reset`(`reset`, request time)
9. after hook `on_attendance_claimed`
10. Emits core analytics event `core_attendance_claimed` with `logging.track_core_event`

- `ClaimAttendance` sent again with the same request ID returns the response that `idempotency` saved, so the user does not receive twice
- Client content code decides when to let the user claim (popup after login, attendance screen)

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_attendance_claim` | claim step 5 | ctx, calendar ID value, next day | `pass` or `GameError` | `pass` |
| `grant_attendance_extra` | claim step 7 | ctx, calendar ID value, next day | `pass` or `GameError` | when there is an `attendance_reward` row whose `extra_grant` is `true`, the server does not start |
| `on_attendance_claimed`(after hook) | claim step 9 | ctx, calendar ID value, received day | none | does nothing |

- With `grant_attendance_extra`, content grants rewards that are not items
- `on_attendance_claimed` does the content's counting after a successful `ClaimAttendance`. e.g. `mission` `add_progress` for a mission that counts attendances

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| outside the active window | `ATTENDANCE_UNAVAILABLE` | `ATTENDANCE_UNAVAILABLE` | none |
| `passed` of `evaluate_requirement` is `false` | `ATTENDANCE_LOCKED` | `ATTENDANCE_LOCKED` | none |
| already received today | `ATTENDANCE_ALREADY_CLAIMED` | `ATTENDANCE_ALREADY_CLAIMED` | none |
| `Once` calendar received up to N days | `ATTENDANCE_COMPLETED` | `ATTENDANCE_COMPLETED` | none |
| reward grant failure (failure of `grant_or_mail`) | `INTERNAL` | `INTERNAL` | error rules of `mailbox` |
| hook rejection | `GameError` of the hook | `GameError` of the hook | none |
| an `attendance_reward` row whose `extra_grant` is `true` exists and there is no `grant_attendance_extra` | server start failure | none | `error` log |

Added `CoreError`: `ATTENDANCE_UNAVAILABLE`, `ATTENDANCE_LOCKED`, `ATTENDANCE_ALREADY_CLAIMED`, `ATTENDANCE_COMPLETED`

## settings

none

## data

`data/tables/attendance_calendar.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `mode` | `enum<AttendanceMode>` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |
| `requirement` | `requirement` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |

- When `reset` is `null`, progress does not return to the start on a `ResetCycle` cycle. When there is `live_event`, progress still follows the round reset of `live-event`, and when `mode` is `Streak`, it also follows the missed game day rule
- The game keeps the background of the calendar screen and the per-day highlight in an extension table

`data/tables/attendance_reward.csv`

| column | type | build target |
|---|---|---|
| `id` | `id` | `All` |
| `day` | `int` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `extra_grant` | `bool` | `All` |

- One row is one day. `id` is the ID name of `attendance_calendar`, and the rows with the same `id` are all the days of one calendar
- When there is a row whose `reward` is an empty array and `extra_grant` is `false`, or a row that violates these data rules, the server does not start

`data/invariants.csv`

| kind | table | column | group | min | max | child_table | child_column |
|---|---|---|---|---|---|---|---|
| `order_column` | `attendance_reward` | `day` | `id` | | | | |
| `child_exists` | `attendance_calendar` | `id` | | | | `attendance_reward` | `id` |
| `child_exists` | `attendance_reward` | `id` | | | | `attendance_calendar` | `id` |

`data/enums.csv`

| type | element |
|---|---|
| `AttendanceMode` | `Cycle`, `Once`, `Streak` |

- `ResetCycle` is an enum of `server-time`

reserved ID: `[attendance_reward_mail]` → row of `mail_template`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_attendance` | ctx, calendar ID value, day, `claimed_day_number` | none | an input violation throws | content cheat handler, `testing` |

- `set_attendance` writes the row with those values and writes `reset_at` and `event_round` by the rules of claim step 8. When day is 0, deletes the row. Throws for an unknown calendar, a day less than 0 or more than N, and a `claimed_day_number` less than 0. Does not look at the active window, `requirement` or hooks
- STG·PROD builds do not have `set_attendance`

## test

- The first `ClaimAttendance` grants the `reward` of day 1 with source `Attendance` and sends `day` 1 and `claimed_day_number` today of `AttendanceUserState` as the delta of the same response
- The second claim on the same game day is `ATTENDANCE_ALREADY_CLAIMED`, also at the next game day boundary − 1, and the claim succeeds at the boundary
- With `Cycle` the day after day N is 1, with `Once` the claim after day N is `ATTENDANCE_COMPLETED`, and with `Streak` the claim after one skipped game day is 1. `Cycle` and `Once` continue even when game days are skipped
- A calendar whose `reset` is `Monthly` is at day 1 on the first claim after the game month boundary
- After a `Once` calendar bound to a `live_event` with `repeat` is received up to N days in round 1, the first claim of round 2 is day 1
- When round 2 starts on the game day on which a calendar bound to a `live_event` with `repeat` was received in round 1, the first claim of round 2 on the same game day grants the `reward` of day 1 and `items` of the response is not an empty list
- Outside the active window and when `passed` of `evaluate_requirement` is `false`, the result is the set error and progress and balance stay unchanged
- `ClaimAttendance` with a calendar ID value that is not in `attendance_calendar` is `INVALID_REQUEST` and progress and balance stay unchanged
- A reward that could not be granted at once because it exceeds `max_amount` or because the `item-ledger` validation hook rejected it goes as `[attendance_reward_mail]` mail, and progress is saved
- When `grant_attendance_extra` returns `GameError`, the reward grant is also undone
- `ClaimAttendance` sent again with the same request ID applies only once
- A claim leaves core analytics event `core_attendance_claimed` for a user who allowed analytics
- `on_attendance_claimed` is called once per successful `ClaimAttendance` with that calendar ID value and the received day, and the changes inside it arrive as the delta of the same response. It is not called for a failed `ClaimAttendance`. When the hook throws, `ClaimAttendance` is `INTERNAL` and progress and items stay unchanged
- For each case of core test fixture `attendance-progress` (ID name of the `attendance_calendar` row, N, ID name of the `live_event` row, `AttendanceUserState` row, time, expected `(day, next_day)`), `get_attendance` equals the expected value. For each of `Cycle`, `Once`, `Streak`, the cases include a row whose `day` is greater than N. The `UserStateCore` test uses the same fixture
- When there is a row that violates the data rules, the server does not start
- When an `attendance_reward` row whose `extra_grant` is `true` exists and content does not register `grant_attendance_extra`, the server does not start and an `error` log is left
- In DEV, `set_attendance` changes progress to those values, and STG·PROD do not have it
