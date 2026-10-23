# reset-counter

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

Counts the reset counters defined in data (a user's count that goes back to 0 each reset period. e.g. daily entry count, daily gift count, stamina purchase step) and judges the limit. Content code decides what to count and when to add.

## dependency

- `storage`
- `server-time`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_count` | ctx, reset counter ID value | count of the current reset period | none. 0 for an unknown reset counter ID value | content handler, hook |
| `add_count` | ctx, reset counter ID value, amount, limit (optional) | `ResetCounterResult.OK` | `ResetCounterResult.LIMIT_REACHED`. Throws on an unknown reset counter ID value and on an amount or limit out of range | content handler, hook |

- A reset counter ID value is an ID value of the `reset_counter` table. Content code gets it with a reserved ID accessor
- amount and limit are integers from 1 to 2^53−1
- When the limit argument is given, judges with that value instead of the row's `limit`. e.g. a daily entry count that differs per VIP level

`ResetCounterResult`

| element | meaning |
|---|---|
| `OK` | Added amount to the count |
| `LIMIT_REACHED` | count + amount exceeds the limit. The count was not changed |

## behavior

- The count is stored in the core UserState kind `ResetCounterUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id` (reset counter ID value), `int64 count`, `int64 reset_at`
- The count of a reset counter without a row is 0
- The count is read with the lazy reset of `server-time`. The initial value is 0, and the next reset time is `server-time.get_next_reset`(`reset`, request time). When `reset` is `null`, `reset_at` is 0 and the count does not reset. Client `UserStateCore.get_reset_counter` reads it by the same rules
- `add_count`: let c be the count after lazy reset, and L the judging limit (the limit argument, or the row's `limit` when there is none). When there is an L and c + amount > L, `LIMIT_REACHED`. Otherwise writes the count as min(c + amount, 2^53−1), and when `reset_at` is 0, writes the next reset time to it
- When there is no limit argument and the row's `limit` is `null`, `add_count` is always `OK`
- When the handler that called `add_count` ends with `GameError`, the count is also reverted by the rollback of `storage`

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| count + amount exceeds the limit | `LIMIT_REACHED` | set by content | none |
| unknown reset counter ID value, amount or limit out of range | throw | `INTERNAL` | `error` log by `routing` |

Added `CoreError`: none

## settings

none

## data

`data/tables/reset_counter.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `limit` | `long?` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |

- When `limit` is `null`, the row has no limit. When it is not `null`, it is from 1 to 2^53−1. A violation is data check `out_of_range`, and the server does not start
- When `reset` is `null`, the count is not reset
- `ResetCycle` is an enum of `server-time`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SetResetCounter` (core cheat). changes: `ResetCounterUserState` | reset counter ID value, count | empty response. The changed `ResetCounterUserState` in the delta | `INVALID_REQUEST` | `routing` DEV code. Client `QACore`, bots and `testing` send it |

- `SetResetCounter` follows the processing order of `cheat`. Writes the received value to the row's `count` and writes `server-time.get_next_reset`(`reset`, request time) to `reset_at`. Does not look at the limit
- STG·PROD builds do not have `SetResetCounter`

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SetResetCounterRequest` | `counter_id` | `int32` | `table`: `reset_counter` |
| `SetResetCounterRequest` | `count` | `int64` | `min`: 0, `max`: 2^53−1 |

## test

- `add_count` adds amount to the count and is `OK`. When count + amount exceeds the row's `limit`, `LIMIT_REACHED`, and the count stays the same
- When the limit argument is larger than the row's `limit`, the count goes up to that limit argument, and `add_count` without a limit argument on a row whose `limit` is `null` is always `OK`
- The `reset_at` of the row that the first `add_count` of a `Daily`, `Weekly` or `Monthly` reset counter made is `server-time.get_next_reset`(`reset`, request time); just before the reset time the count is kept, and the first `get_count` just after it is 0. The `reset_at` of a row whose `reset` is `null` is 0, and its count stays the same as time passes
- `add_count` after the reset time counts from 0 and changes `reset_at` to the next reset time
- When the handler ends with `GameError` after `add_count`, the count stays the same
- `add_count` with an unknown reset counter ID value, or with 0 or 2^53 as amount, is `INTERNAL`
- When there is a row whose `limit` is 0, the server does not start
- In DEV, `SetResetCounter` changes the count to that value and carries the `ResetCounterUserState` delta. It also writes a value above the limit. An unknown reset counter is `INVALID_REQUEST`
