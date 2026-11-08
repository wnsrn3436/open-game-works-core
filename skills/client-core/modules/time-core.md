# TimeCore

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

Estimates server time, judges reach, game day and reset period boundaries, handles the time scale and pause of game time and the app entering and returning from background, and gives the random seeds of the purposes that need no reproduction. DEV code has a step mode that advances game time only by a set amount, a random base that fixes those random seeds, and a frame step that follows an engine that runs at a fixed frame rate.

## dependency

`UtilCore`, `LogCore`, `EventCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `sync_server_time` | `server_time_at` of the response, sent monotonic time, received monotonic time | none | none | `NetworkCore` |
| `is_synced` | none | whether the first sync has happened | `false` | all code |
| `get_server_time` | none | server time (Unix ms) | 0 | all code |
| `get_device_time` | none | device time (Unix ms) | 0 | all code |
| `get_monotonic_time` | none | monotonic time (ms) | 0 | all code |
| `is_reached` | target time | whether reached | `false` | all code |
| `is_before_end` | end time | whether it is before the end time | `false` | all code |
| `get_remaining_ms` | target time | remaining ms | 0 | all code |
| `get_day_start` | time | start of the game day that contains that time | 0 | all code |
| `get_next_day_boundary` | time | start of the next game day | 0 | all code |
| `is_same_day` | two times | whether they are in the same game day | `false` | all code |
| `get_current_day` | none | start of the current game day | 0 | all code |
| `get_day_number` | time | game day number | 0 | all code |
| `get_period_start` | `ResetCycle?` element, time | start of the reset period that contains that time. 0 when `null` | 0 | all code |
| `get_next_reset` | `ResetCycle?` element, time | first reset time after that time. 0 when `null` | 0 | all code |
| `get_game_time` | none | game time (ms) | 0 | all code |
| `get_game_frame_ms` | none | game time increase of this frame | 0 | all code |
| `get_real_time` | none | real elapsed time (ms) | 0 | all code |
| `get_real_frame_ms` | none | real elapsed time increase of this frame | 0 | all code |
| `set_time_scale` | time scale (permille) | none | none | all code |
| `get_time_scale` | none | time scale (permille) | 1000 | all code |
| `set_paused` | whether paused | none | none | all code |
| `is_paused` | none | whether paused | `false` | all code |
| `get_resume_count` | none | number of background returns after `init` | 0 | all code |
| `get_last_background_ms` | none | last background elapsed time. 0 when there has been no return | 0 | all code |
| `make_random_seed` | purpose name | random seed (int64) of that purpose | 0 | all code |

## behavior

### clock

- server time: the current time on the server's clock as estimated by the client
- device time: the current time of the device clock. The user can change it
- monotonic time: an ms value that does not decrease while the app runs and does not change when device time changes. The reference point and whether it increases while the device sleeps are in the engine-specific implementation rules
- Time judgements (comparing a time in data or UserState with now) use only server time. Time judgements are not made with device time, monotonic time, game time or real elapsed time
- Sync, reach, remaining time and day boundary calculations use integers

### sync

- `NetworkCore` calls `sync_server_time` for each response that step 1 of response processing sets. The sent monotonic time is when the request was passed to `NetworkTransport`, and the received monotonic time is when `NetworkTransport` reported the response
- calculation
  - round trip = received monotonic time − sent monotonic time
  - base server time = `server_time_at` + `UtilCore.floor_div`(round trip, 2)
  - base monotonic time = received monotonic time
  - server time = base server time + current monotonic time − base monotonic time
- The base server time changes only at sync and background return. A server time changed by cheat is sent by the server in `server_time_at`, and TimeCore follows it through sync
- When the absolute value of the server time difference just before and just after a sync is `TimeCore.jumpThresholdMs` or more, it publishes `ServerTimeJumpedEvent`. The first sync does not count

### reach

- `is_reached(target)`: server time ≥ target + `TimeCore.reachMarginMs`
- `is_before_end(target)`: server time < target − `TimeCore.reachMarginMs`
- `get_remaining_ms(target)`: target + `TimeCore.reachMarginMs` − server time. 0 when it is less than 0
- Whether a target is reached is decided only with `is_reached`. The exceptions are the recovery item calculation and the timed item calculation of `UserStateCore`, which must give the same values as the server. `get_remaining_ms` is used only for display and local push delay
- For a judgement in which the server rejects a request or stops grants by an end time, whether it is before the end time is decided with `is_before_end`. e.g. `end_at` and `expires_at` of data and UserState, the end time of a live event round, the end time of an offer, `ends_at` of a subscription, `reset_at` of mission progress. So the client treats them as ended a margin earlier than the server. The timed item `ends_at` of `UserStateCore` does not follow this rule and is judged without a margin, the same as the server `item-ledger`

### day boundary

- 1 day is 86400000 ms. o is game settings `dailyResetOffsetMs`
- `get_day_number`, `get_period_start` and `get_next_reset` are calculated with the same definitions as the operations of the same names in the server `server-time`, and give the same values for the same input. `get_day_number(t)` = `UtilCore.floor_div`(t − o, 1 day)
- `get_day_start(t)` = t − `UtilCore.floor_mod`(t − o, 1 day)
- `get_next_day_boundary(t)` = `get_day_start(t)` + 1 day
- `is_same_day(a, b)`: the `get_day_number` values of the two times are equal
- `get_current_day()` = `get_day_start`(server time − `TimeCore.reachMarginMs`). Which game day it is now is decided only with `get_current_day`
- Day boundary calculation does not use the device timezone
- `DayChangedEvent`: the check runs every frame and right after a sync. The check right after a sync runs after `ServerTimeJumpedEvent`. Before the first sync, there is no check
  - When `get_current_day` differs from the recorded value, it publishes `DayChangedEvent` and records the new value. It publishes once even when several game days pass at once or when the value changes because server time decreased
  - The first record is made at the first sync and does not publish

### game time

- game time is the accumulated elapsed ms with time scale and pause applied, and real elapsed time is the accumulated elapsed ms without them. Both are 0 at `init`
- A frame is a process frame. TimeCore increases game time and real elapsed time once per process frame, before the other process callbacks of that frame. So process callbacks read this frame's `get_game_frame_ms` and `get_real_frame_ms`, and code that runs before that frame's process callbacks (input handling, physics step, frame start signal) reads the values of the previous frame. How it runs before the other process callbacks is in the engine-specific implementation rules
- real frame increase = current monotonic time − the monotonic time of the later of the increase in the previous frame and the last background return. The first frame is measured from the monotonic time at `init`. A frame step of `## DEV` replaces this rule
- time scale is an integer in permille. The default is 1000. Per frame, game time increase = `UtilCore.floor_div`(real frame increase × time scale + carry-over, 1000), and the remainder carries over to the next frame
- During pause, game time does not increase. Time scale and pause follow the last set value
- Time scale and pause do not change server time, device time, monotonic time or real elapsed time
- World objects and gameplay timers use game time, and UI uses real elapsed time
- How time scale and pause are applied to engine features (physics, animation, timer) is in the engine-specific implementation rules

### background

- background: the state in which the OS has taken the app off the screen and frames do not run. How entering and returning are detected is in the engine-specific implementation rules
- Time spent in background is not added to game time or real elapsed time
- TimeCore keeps whether it is in background, and is not in background at `init`. It handles entering only when not in background and returning only when in background, and ignores other enters and returns without a log
- background elapsed time = the larger of the monotonic time difference and the device time difference between entering and returning
- On entering, it calls `LogCore.notify_app_state(background)` and then publishes `AppBackgroundEnteredEvent`
- On returning, it increases the resume count by 1. After the first sync, it adds (background elapsed time − the monotonic time difference between entering and returning) to the base server time. Then it calls `LogCore.notify_app_state(foreground)` and publishes `AppForegroundReturnedEvent`. After the first sync, `NetworkCore` syncs server time again on this event

### random seed

- `make_random_seed`(purpose name) gives the random seed of a purpose that needs no reproduction (`### random` of `UtilCore`): `UtilCore.make_purpose_seed`(purpose name, r + k), with r + k added in 64-bit two's complement (modulo 2^64). r is the random base set with `set_random_base` (`## DEV`) when there is one, and otherwise the device time at the call. k is the number of earlier `make_random_seed` calls with the same purpose name since `init`
- So with a random base, the k-th random seed of each purpose is the same on every run, whatever the times of the calls and the order of the calls of other purposes
- A purpose name that is not snake_case (`UtilCore.is_snake_case`) gives the failure value and is not counted

## hook

none

## event

| event | when | payload |
|---|---|---|
| `ServerTimeJumpedEvent` | right after a sync whose server time difference before and after the sync is `TimeCore.jumpThresholdMs` or more | `previous_server_time`, `server_time` |
| `DayChangedEvent` | when the current game day changes | `day_start` |
| `AppBackgroundEnteredEvent` | background entered | none |
| `AppForegroundReturnedEvent` | background returned | `background_ms`, `resume_count` |

## error

| condition | failure value | log |
|---|---|---|
| `get_server_time`, `is_reached`, `is_before_end`, `get_remaining_ms`, `get_current_day` before the first sync | failure value in the API table | `error` |
| sync with received monotonic time < sent monotonic time, or with `server_time_at` ≤ 0 | ignored. Server time stays as it is | `error` |
| game settings `dailyResetOffsetMs` is −1 day or less, or 1 day or more | the calculation uses 0 for o | one `error` in `init` |
| time scale 0 or less | ignored | `error` |
| `make_random_seed` with a purpose name that is not snake_case | 0 | `error` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `TimeCore.reachMarginMs` | integer | core | content | ms added in reach judgements and remaining time, and subtracted in before-end judgements |
| `TimeCore.jumpThresholdMs` | integer | core | content | smallest server time difference that publishes `ServerTimeJumpedEvent` |
| `dailyResetOffsetMs` | integer | game | none | ms by which the game day boundary is offset from UTC 00:00 |

## data

- The enum `ResetCycle` is defined by the server `server-time`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_test_clock` | test clock | none | none | `UnitTestCore`, `BootstrapCore`, core test |
| `set_test_clock_read_step` | ms (0 or more) | none | none | core test |
| `step_test_frame` | progress ms, whether background progress, whether the device sleeps | none | none | `UnitTestCore` |
| `set_step_mode` | whether step mode | none | none | `QACore` |
| `is_step_mode` | none | whether step mode | `false` | `QACore`, `RealtimeCore` |
| `add_step_budget` | ms | none | none | `QACore`, `RealtimeCore` |
| `get_step_budget` | none | remaining step budget (ms) | `0` | `QACore`, `RealtimeCore` |
| `set_random_base` | random base (int64) | none | none | `BootstrapCore`, core test |
| `set_test_frame_step` | fps (integer 1 or more) | none | none | core test |
| `get_frame_step_fps` | none | fps of the frame step. 0 without a frame step | `0` | `QACore` |

- A test clock is an object that gives monotonic time and device time. `set_test_clock` is called only before `init`. `release` deletes it
- `set_random_base` sets the random base of `### random seed`, so that the dev runs given the same random base make the same random seeds. It is called only before `init`. `release` deletes the random base
- frame step: a DEV mode in which every engine frame is one fixed step of time. TimeCore is at a frame step of fps f when the engine runs at a fixed f frames per second whatever the time a frame takes, which `init` reads from the engine (the engine-specific implementation rules say how; e.g. the movie maker of the engine), or when `set_test_frame_step`(f) was called before `init`
- At a frame step of fps f, the real frame increase of the n-th engine frame after `init` (n from 1) is ⌊n × 1000 ÷ f⌋ − ⌊(n − 1) × 1000 ÷ f⌋ ms, in place of the monotonic time difference of `### game time`. So n frames add ⌊n × 1000 ÷ f⌋ ms to real elapsed time, game time grows from that increase with time scale, pause and step mode as from any real frame increase, and each frame of a movie the engine records is one step of the game after the frame before it, whatever the speed of the host
- Monotonic time, device time and server time do not follow the frame step. While a test clock is in use, TimeCore is still at the frame step, but engine frames do not change game time and real elapsed time (the test clock rules of `## DEV`), so the frame step changes no time value
- `get_frame_step_fps` is f at a frame step, also while a test clock is in use, and 0 otherwise. `release` ends the frame step and deletes the value of `set_test_frame_step`. `set_test_frame_step` with fps less than 1 leaves an `error` log and the call is ignored
- `set_test_clock_read_step`: while TimeCore reads the test clock, each time it reads monotonic time, it moves the test clock's monotonic time by ms after the read. With 0, it does not move it. `release` sets it to 0
- While a test clock is in use, engine frames do not change game time and real elapsed time. The frame increase of an engine frame is the sum of the increases of the test frames handled after the previous engine frame
- `step_test_frame` is called after moving the test clock. Without background progress, it runs one frame whose real frame increase is the progress ms, and the day check of that frame. With background progress, it handles background entering and returning in order, sets the background elapsed time to the progress ms, and sets the monotonic time difference between entering and returning to 0 when the device sleeps and to the progress ms otherwise. When the progress ms is negative, it leaves an `error` log and does nothing
- step mode: a DEV mode that advances game time only by the step budget. In step mode, the per-frame game time increase is the smaller of the increase with time scale and pause applied and the remaining step budget, and the budget decreases by that much. An increase cut off by the budget does not carry over
- In step mode, while the budget is 0, engine features (physics, animation, timer) stop as during pause. When the budget is greater than 0 or step mode is off, engine features follow the pause set with `set_paused`. Engine features in the frame where the budget becomes 0 run to the end of that frame, so engine features can advance up to one frame more than game time. `is_paused` returns only the value set with `set_paused`
- `set_step_mode` turns step mode on or off and sets the budget to 0. When it is turned off, game time returns to the normal rules
- `add_step_budget` adds ms to the budget. When not in step mode or when ms is less than 1, it leaves an `error` log and the call is ignored
- Step mode and the budget do not change server time, device time, monotonic time or real elapsed time. `release` turns step mode off
- STG and PROD builds have no step mode, no random base and no frame step

## test

- After a sync with `server_time_at` S, sent a and received b, and advancing the test clock by d, `get_server_time` is S + `floor_div(b − a, 2)` + d
- For each condition of the error table, the failure value and an `error` log come out
- Changing the device time of the test clock changes only `get_device_time`; server time, monotonic time, game time and real elapsed time stay as they are
- When server time = target + margin − 1, `is_reached` is `false` and `get_remaining_ms` is 1. At target + margin they are `true` and 0
- When server time = target − margin − 1, `is_before_end` is `true`, and at target − margin it is `false`
- For each case of the core test fixture `reset-time`, `get_day_number`, `get_period_start` and `get_next_reset` equal the expected values
- `get_day_start`, `get_next_day_boundary` and `is_same_day` match the day boundary formulas for day boundary − 1 and day boundary, with game settings `dailyResetOffsetMs` 0, positive and negative
- When server time = day boundary + margin − 1, `get_current_day` is day boundary − 1 day, and at + margin it is day boundary
- `DayChangedEvent`: not published at the first sync; published once at day boundary + margin, once on a sync that skips 3 days, and once on a sync that goes back before the day boundary
- When the difference before and after a sync is `TimeCore.jumpThresholdMs`, `ServerTimeJumpedEvent` is published once; when it is 1 less or at the first sync, it is not published
- When the frame start signal of frame F waits 20 ms, `get_real_frame_ms` read by a process callback of the same frame F is 20 or more (TimeCore updates before the other process callbacks)
- Without a test clock, at time scale 2000, when a process callback waits 20 ms in frame F, `get_real_frame_ms` read by the process callback of F+1 is 20 or more and at most the difference between the device monotonic time read at the frame start signal of frame F (before TimeCore sets F's increase) and the device monotonic time read in that process callback of F+1, and `get_game_frame_ms` is twice that
- Without a test clock, after staying in background for 300 ms and returning, `get_real_frame_ms` and `get_game_frame_ms` of the first frame after the return are less than 300
- Advancing 1000 ms at time scale 2000 increases real by 1000 and game by 2000, and the frame increases match. At time scale 333, after three 1 ms frames game time is 0, and after the fourth frame it is 1
- After a sync, advancing 1000 ms during pause increases server time and real elapsed time by 1000, and game time stays as it is
- For each background progress d, the resume count increases by 1, `get_last_background_ms` is d, game time and real elapsed time stay as they are, and `AppBackgroundEnteredEvent` and `AppForegroundReturnedEvent` are each published once in that order
- When the engine reports a return without an enter after `init`, the resume count, `get_last_background_ms` and server time stay as they are, with no event or log. When it reports entering twice and then returning twice, `AppBackgroundEnteredEvent` and `AppForegroundReturnedEvent` come once each and the resume count is 1
- After a sync, with background progress d while the device sleeps, when `AppForegroundReturnedEvent` is received, `get_server_time` is the value right after the sync + d. With background progress d while the device does not sleep, it is also the value right after the sync + d
- In step mode with budget 0, advancing frames leaves game time as it is while real elapsed time increases. After `add_step_budget`(100), seven 16 ms frames increase game time by 100 and the budget is 0
- When not in step mode, `add_step_budget` gives an `error` log and is ignored. After `set_step_mode`(false), game time increases every frame again
- After `set_step_mode`(true), engine features stop as during pause and `is_paused` is `false`. After `add_step_budget`(100), engine features run again, and they stop again after the frame in which the budget becomes 0. With `set_paused`(true), they stay stopped even when budget remains. After `set_step_mode`(false), engine features follow the pause set with `set_paused`
- In step mode, while `set_paused`(true) is in effect, advancing frames after `add_step_budget`(100) leaves game time as it is and `get_step_budget` is 100. After `set_paused`(false), seven 16 ms frames increase game time by 100 and the budget is 0
- After `set_random_base`(42) before `init`, two calls of `make_random_seed`(`a`) give `UtilCore.make_purpose_seed`(`a`, 42) and then `UtilCore.make_purpose_seed`(`a`, 43), and a call of `make_random_seed`(`b`) between them gives `UtilCore.make_purpose_seed`(`b`, 42), whatever the device time of the test clock at the calls. After `release`, `set_random_base`(42) and another `init`, the first `make_random_seed`(`a`) gives `UtilCore.make_purpose_seed`(`a`, 42) again. With random base 9223372036854775807, the second `make_random_seed`(`a`) gives `UtilCore.make_purpose_seed`(`a`, −9223372036854775808)
- Without a random base, with device time T of the test clock, two calls of `make_random_seed`(`a`) at that device time give `UtilCore.make_purpose_seed`(`a`, T) and `UtilCore.make_purpose_seed`(`a`, T + 1). A call of `make_random_seed`(`Abc`) is not counted: the next `make_random_seed`(`a`) gives `UtilCore.make_purpose_seed`(`a`, T + 2) at that device time
- Without a test clock, after `set_test_frame_step`(60) before `init`, at time scale 1000, the first three engine frames have real frame increases 16, 17, 17 and the same game frame increases, and 60 engine frames increase real elapsed time and game time by 1000, also when a process callback waits 50 ms in one of them. `get_frame_step_fps` is 60, and `get_monotonic_time` grows with the device monotonic clock and not with the frame step
- With a test clock in use, after `set_test_frame_step`(60) before `init`, `get_frame_step_fps` is 60, and engine frames do not change game time and real elapsed time
- Without a test clock, at a frame step of 60 in step mode with budget 0, engine frames leave game time as it is, and after `add_step_budget`(50) three engine frames increase game time by 50 and the budget is 0
- Without a frame step, `get_frame_step_fps` is 0. After `release` and another `init` without `set_test_frame_step`, `get_frame_step_fps` is 0 and the real frame increase is the monotonic time difference again
