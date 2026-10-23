# server-time

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

Gives server time as the criterion for game rules. Handles the request time fixed within a request, time judgement, the cheat time offset, the system clock adapter, the scheduler that runs on the clock adapter, the real elapsed time limits of network input and output, game day and reset period boundaries, lazy reset and fixed window.

## dependency

none

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `now` | ctx | `request_time` of ctx. Unix ms | none | content handler, hook, core module |
| `is_reached` | ctx, target time | judgement result | Throws on a target violation | content handler, hook, core module |
| `is_reached_strict` | ctx, target time | `true` when request time ≥ target | Throws on a target violation | content handler, hook, core module |
| `clock_now` | none | current time of the clock adapter. Unix ms | none | core module |
| `user_now` | user ID, DB handle | `clock_now` + the cheat time offset of that user | none | `auth`, `session`, `storage`, `routing`, `iap`, `testing` |
| `get_day_number` | time | game day number of that time | none | content handler, hook, core module |
| `get_period_start` | `ResetCycle?` element, time | start time of the reset period that contains that time. 0 when `null` | none | content handler, hook, core module |
| `get_next_reset` | `ResetCycle?` element, time | first reset time after that time. 0 when `null` | none | content handler, hook, core module |
| `get_period_number` | `ResetCycle` element, time | number of the reset period that contains that time | none | content handler, hook, core module |
| `get_window_start` | window length ms, time | window start of the fixed window that contains that time | Throws when the length is less than 1 | core module |
| `schedule_job` | job name, period ms, job function | none | A registration error is a server start failure. A call after the server has started throws | `routing`, `admin-api`, `notice`, `remote-config`, `game-update`, `push`, `ranking`, `migration`, `matchmaker`, `p2p-signaling`, `auth`, `user-snapshot-clone`, `logging`. Called at server start |
| `sleep` | ms | async operation. none | none | core module |
| `network_time_limit` | ms | `AbortSignal` that aborts when ms has passed in real elapsed time since the call | Throws when ms is less than 1 | core module |

- The `None` element of a `ResetCycle?` input is the same as `null`. Passing `None` to `get_period_number` throws
- target violation: less than 0, or 2^63 or more. Throws, and the request ends with `INTERNAL`. `routing`, which receives the exception, leaves the error log
- The DB handle is the handle of a transaction that the caller opened or of `storage.read_db`. server-time passes that handle only to the cheat time offset read

## behavior

- Times that the client sent are not used for judgement. `X-Ogw-Timestamp` is used only for the signature check of `session`
- request time: `storage` decides it with `user_now` when opening a transaction and puts it in `request_time` of ctx. It does not change within a request
- The request time of an out-of-request change is the `user_now` at the time that transaction was opened
- time judgement `is_reached`
  - request without `silent`: request time ≥ target
  - `silent` request: request time + `server-time.silentMarginMs` ≥ target. This keeps a request sent without user action from failing because of the difference between the client's estimated time and the request time
  - out-of-request change: request time ≥ target
- A judgement that does not allow a result before the target uses `is_reached_strict`. e.g. no grant before the end time
- Server code reads the system clock only through the clock adapter. The clock adapters are `system` and the test clock. Only `testing` sets the test clock, with DEV operation `set_clock`
- The clock adapter is `ClockAdapter` of `server-time/clock.ts`. `now()` gives the current time in Unix ms, and `real_time` gives `true` for the system clock and `false` for a test clock. `subscribe(listener)` calls the listener synchronously each time the time changes. `subscribe` of the system clock does not call the listener
- Game-wide boundaries that must not include the user offset (e.g. the ranking season boundary, the `ReportMatchResult` deadline) are judged with `clock_now`
- Judgements of one user's rights and claims (e.g. subscription entitlement, the daily reward claim date) use the request time. They follow the cheat time offset in DEV

game day and `ResetCycle`

- 1 day is 86400000 ms. o is game settings `dailyResetOffsetMs`
- `get_day_number`(t) = ⌊(t − o) ÷ 1 day⌋. Game day d is the interval of at least d × 1 day + o and less than (d + 1) × 1 day + o, and the date of d is the UTC date of Unix ms d × 1 day
- One period of `ResetCycle`
  - `Daily`: one game day
  - `Weekly`: 7 game days from a game day whose date is a Monday
  - `Monthly`: from a game day whose date is the 1st until before the game day whose date is the 1st of the next month
- `get_period_start`(c, t) is the start time of the first game day of the period that contains t, and `get_next_reset`(c, t) is the start time of the first game day of the next period
- `get_period_number`(c, t) is the number of the period that contains t, and the numbers of two consecutive periods differ by 1. d is `get_day_number`(t)
  - `Daily`: d
  - `Weekly`: ⌊(d + 3) ÷ 7⌋. The date of game day 0, 1970-01-01, is a Thursday, so it goes up by 1 at a game day whose date is a Monday
  - `Monthly`: (Y − 1970) × 12 + (M − 1). Y and M are the year and the month of the date of game day d
- The calculation that decides the game day, date, reset boundary and period number from a time is done only with these four operations. Client `TimeCore` does the same calculation as `get_day_number`, `get_period_start` and `get_next_reset`

lazy reset

- lazy reset: when a UserState row that has a `reset_at` field is read, and `reset_at` is not 0 and request time ≥ `reset_at`, the fields that go back to the start are seen as their initial values and `reset_at` is changed to the next reset time. When `reset_at` is 0, it does not reset. The values seen this way are saved only when that row is written
- The module that writes that row decides the fields that go back to the start, their initial values and the next reset time

fixed window

- Among the fixed windows of length L ms, the window that contains time t is the interval of at least ⌊t ÷ L⌋ × L and less than ⌊t ÷ L⌋ × L + L. The window start of that window is ⌊t ÷ L⌋ × L, and the window end is the window start + L
- The module that uses the fixed window decides L and the time used as t (`clock_now` or the request time)
- minute window: the fixed window whose L is 60000 and whose t is `clock_now`

### scheduler

- There is one scheduler per server instance. It runs jobs and ends `sleep` by the time of the clock adapter
- The time limits of network input and output (external service calls, request body reads, WebSocket frame reads and authentication waits) and the lock and connection waits of `storage` and their retry intervals are measured in real elapsed time, independent of the clock adapter. Core modules measure these time limits only with the signal of `network_time_limit`, and changing the test clock does not abort that signal
- A job name is snake_case and unique within a server instance. A second `schedule_job` with the same name and a period less than 1 are server start failures
- In `server-time`, `complete_start()` only closes `schedule_job` registration and does not run jobs. A job runs once in `end_start()` when server start ends. After that, it runs again when the clock time at which its last run started + the period ≤ the clock time. Even when the clock time passes several periods at once, it runs once
- Only one run of the same job runs at a time. When it is time to run again during a run, it runs once right after the run ends
- A job function has no input and can wait. A job function leaves its own failures in logs and does not throw. Failures that occur after `stop()` of its module has started (e.g. a DB connection closed under a running transaction) are not logged. When it throws, the scheduler treats that run as ended, without a log
- `sleep`(ms) ends when the clock time becomes at least the clock time at the call + ms
- With a test clock, after the one run when server start ends, the scheduler starts due jobs and ends the `sleep` calls that reached their time only when the time of the test clock changes. Jobs and `sleep` do not progress as real time passes
- When the server instance stops, the scheduler also stops. Running jobs and waiting `sleep` calls are discarded unfinished

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| target violation | throw | `INTERNAL` | `error` log by `routing` |
| same name, period less than 1 in `schedule_job` | server start failure | none | `error` log by the server start of `routing` |
| `schedule_job` after server start | throw | none | none |
| ms less than 1 in `network_time_limit` | throw | none | none |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `server-time.silentMarginMs` | integer | core | content | time judgement margin of a `silent` request |
| `dailyResetOffsetMs` | integer | game | none | ms by which the game day boundary is offset from UTC 00:00 |

## data

`data/enums.csv`

| type | element |
|---|---|
| `ResetCycle` | `Daily`, `Weekly`, `Monthly` |

- The reset period columns of `shop`, `iap`, `ads-reward`, `mission`, `attendance` and `reset-counter`, the season period column of `ranking`, and client `TimeCore` use this enum

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_offset_provider` | function (user ID, DB handle → offset ms) | none | Calling it twice is a server start failure | `cheat` |
| `set_clock` | test clock | none | A call after server start has begun throws | `testing` |
| `wait_idle` | none | async operation. none | none | `testing` |

- cheat time offset: an integer of ms added to the request time per user. `cheat` handles its save and change, and `cheat` registers the provider with `register_offset_provider` at server start. server-time does not depend on `cheat`
- `user_now` adds the offset that the registered offset provider returned. When there is no provider, it adds 0. STG·PROD do not have `cheat`, so `user_now` equals `clock_now`
- The offset goes into the request time, the request time of an out-of-request change and the signature comparison time. It does not go into `clock_now`
- The test clock is a clock adapter that `testing` makes. One test clock can be set on several server instances with `set_clock`, and when its time changes, it notifies the schedulers of all server instances that have that test clock set
- `wait_idle` ends when there is no running job, or when all running jobs are in `sleep` until a time that the test clock has not reached yet

## test

- All `now` calls within one request return the same value
- When a job that reads a table registered by its own module runs for the first time on a new DB, there is no error log. When `complete_start()` of a later module fails or the server cannot listen on the port, no job runs
- At a request time earlier than the target by less than `server-time.silentMarginMs`, `is_reached` of a request without `silent` is `false`, and that of a `silent` request is `true`
- Under the same condition, `is_reached_strict` is `false`, and it is `true` when request time = target
- A target violation ends with `INTERNAL` and does not change the saved state
- In DEV, the request time of a user whose offset is O is clock + O, and that of a user without an offset is clock
- In STG·PROD, `user_now` equals `clock_now`
- Core code does not read the system clock outside the clock adapter (static check)
- For each case of core test fixture `reset-time`, `get_day_number`, `get_period_start`, `get_next_reset` and `get_period_number` equal the expected values. `input` is `{"offset_ms": <o>, "cycle": "<ResetCycle element name>", "time": <time>}`, and `expected` is `{"day_number": <get_day_number(time)>, "period_start": <get_period_start(cycle, time)>, "next_reset": <get_next_reset(cycle, time)>, "period_number": <get_period_number(cycle, time)>}`. The fixture contains cases where o is 0, positive, and the negative value for UTC+9 midnight, and cases where the time is a game day boundary − 1 and the boundary, a Monday boundary, and the Monthly boundaries at the end of February of a leap year and at the end of December. The client `TimeCore` test uses the same fixture
- In the minute window, the window start of `clock_now` 119999 is 60000 and its window end is 120000, and the window start of `clock_now` 120000 is 120000. The user counter window of a user with a cheat time offset is also decided by `clock_now`
- With the system clock, a job runs once when server start ends and then once per period
- With a test clock, after running once when server start ends, a job runs only when the clock changed past the period, and runs once even when the clock passes several periods at once. It does not run as real time passes
- The same job does not run overlapped, and when it is time to run again during a run, it runs once after the run ends
- A job that threw runs again at the next time
- `sleep` ends when the test clock reaches that time
- A second `schedule_job` with the same name and a period less than 1 block server start, and `schedule_job` after the server has started throws
- `wait_idle` ends without waiting for a job that is in `sleep` until a time the test clock has not reached
- Core code does not use timers outside `schedule_job`, `sleep` and `network_time_limit` (static check)
- The signal of `network_time_limit`(ms) aborts after ms has passed in real time, and does not abort when the test clock is moved by more than ms before that. ms less than 1 throws
