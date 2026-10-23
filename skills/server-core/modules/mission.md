# mission

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

Handles the progress counters, reset and completion reward claim of missions and achievements (missions whose `reset` is `null`) defined in data. The game decides what to count with the counters in data, and content code reports progress.

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
| `add_progress` | ctx, counter ID value, amount | list of mission ID values whose progress changed | throws on an unknown counter ID value and on an amount less than 1 | content handler, hook |
| `get_progress` | ctx, mission ID value | `progress`, `claimed`. 0 and `false` for a row that went back to the start by round reset or lazy reset | 0 and `false` for an unknown mission | content handler, hook |
| `ClaimMission` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `MissionProgressUserState`, `content` | mission ID value | claimed `ItemAmount` list | `MISSION_UNAVAILABLE`, `MISSION_LOCKED`, `MISSION_NOT_COMPLETED`, `MISSION_ALREADY_CLAIMED`, `INTERNAL`, the hook's `GameError` | `routing`. Client content code sends it |

- A counter ID value is an ID value of the `mission_counter` table. Content code gets it with a reserved ID accessor

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ClaimMissionRequest` | `mission_id` | `int32` | `table`: `mission` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `ClaimMissionResponse` | `items` | `repeated ItemAmount` |

## behavior

- `once_key` prefix: `mission:`

progress

- Progress is saved in the base proto core UserState kind `MissionProgressUserState`(list kind). Only this module writes it, with `storage.put_core_state` and `delete_core_state`. Fields: `int64 id`(mission ID value), `int64 progress`, `bool claimed`, `int64 reset_at`, `int32 event_round`
- A mission with no row is `(0, false)`. Client `UserStateCore.get_mission_progress` reads with the same rules as round reset and lazy reset
- `add_progress` changes the progress of each mission that points to that counter and meets all of the following
  1. `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the mission row) is `true`
  2. After round reset and lazy reset, `claimed` is `false` and `progress` < `target`
- A progress change follows the `mode` of the counter. An amount over 2^53−1 is taken as 2^53−1. The result does not exceed `target`
  - `Sum`: `progress` + amount
  - `Max`: the larger of `progress` and amount
- Progress is not accumulated from before `add_progress`. Amounts while outside the active window are dropped
- `requirement` does not block progress. Progress accumulates even while `passed` of `evaluate_requirement` is `false`, and only the claim is blocked with `MISSION_LOCKED`
- When the handler that calls `add_progress` ends with `GameError`, progress is also rolled back by the rollback of `storage`

lazy reset

- `progress` and `claimed` are read with the lazy reset of `server-time`. Their first values are `progress` 0 and `claimed` `false`
- The next reset time is `server-time.get_next_reset`(`reset`, request time). When `reset` is `null`, `reset_at` is 0 and the mission does not reset
- `progress` and `claimed` of a mission with `live_event` also follow the round reset of `live-event`. The first values are the same as in lazy reset

claim. `ClaimMission` processing order. On failure, progress and items are not changed.

1. `MISSION_UNAVAILABLE` when `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the mission row) is `false`
2. `MISSION_LOCKED` when `passed` of `evaluate_requirement`(`requirement`) is `false`
3. `MISSION_ALREADY_CLAIMED` when `claimed` is `true` after round reset and lazy reset
4. `MISSION_NOT_COMPLETED` when `progress` < `target`
5. hook `validate_mission_claim`
6. When there is a `reward`, `mailbox.grant_or_mail`. Source `Mission`, `ref` is the decimal string of the mission ID value, `once_key` is `mission:<mission ID value>:<event_round>:<reset_at>`, the template is reserved ID `[mission_reward_mail]`, and `args` is an empty list. `Mailed` is also a claim
7. When `extra_grant` is `true`, hook `grant_mission_extra`
8. Saves `claimed` as `true`
9. after hook `on_mission_claimed`
10. Emits core analytics event `core_mission_claimed` with `logging.track_core_event`

- A `ClaimMission` sent again with the same request ID returns the response that `idempotency` saved, so the reward is not claimed twice
- To claim several missions at once, client content code sends `ClaimMission` per mission

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_mission_claim` | claim step 5 | ctx, mission ID value | `pass` or `GameError` | `pass` |
| `grant_mission_extra` | claim step 7 | ctx, mission ID value | `pass` or `GameError` | when a `mission` row with `extra_grant` `true` exists, the server does not start |
| `on_mission_claimed`(after hook) | claim step 9 | ctx, mission ID value | none | does nothing |

- With `grant_mission_extra`, content grants a reward that is not an item (e.g. a title)
- `on_mission_claimed` does the aggregation of content after a successful claim. e.g. `add_progress` with the counter of a mission that completes when all daily missions are claimed

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| outside the active window | `MISSION_UNAVAILABLE` | `MISSION_UNAVAILABLE` | none |
| `passed` of `evaluate_requirement` is `false` | `MISSION_LOCKED` | `MISSION_LOCKED` | none |
| `claimed` is `true` | `MISSION_ALREADY_CLAIMED` | `MISSION_ALREADY_CLAIMED` | none |
| `progress` < `target` | `MISSION_NOT_COMPLETED` | `MISSION_NOT_COMPLETED` | none |
| reward grant failure (failure of `grant_or_mail`) | `INTERNAL` | `INTERNAL` | error rules of `mailbox` |
| hook rejection | the hook's `GameError` | the hook's `GameError` | none |
| a `mission` row with `extra_grant` `true` exists but there is no `grant_mission_extra` | server start failure | none | `error` log |
| unknown counter, amount less than 1 in `add_progress` | throw | `INTERNAL` | `routing` writes the `error` log |

Added `CoreError`: `MISSION_UNAVAILABLE`, `MISSION_LOCKED`, `MISSION_ALREADY_CLAIMED`, `MISSION_NOT_COMPLETED`

## settings

none

## data

`data/tables/mission_counter.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `mode` | `enum<MissionCounterMode>` | `All` |

`data/tables/mission.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `desc` | `tstring<id>` | `Client` |
| `counter` | `ref<mission_counter.id>` | `All` |
| `target` | `long` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |
| `requirement` | `requirement` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `extra_grant` | `bool` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |

- `target` is at least 1 and at most 2^53−1
- A mission whose `reset` is `null` does not reset on a `ResetCycle` period. When it has `live_event`, it still follows the round reset of `live-event`
- When there is a row whose `reward` is an empty array and whose `extra_grant` is `false`, the server does not start
- The game keeps the display order, category tab and shortcut of missions in an extension table

`data/enums.csv`

| type | element |
|---|---|
| `MissionCounterMode` | `Sum`, `Max` |

- `ResetCycle` is an enum of `server-time`

reserved ID: `[mission_reward_mail]` → row of `mail_template`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SetMissionProgress` (core cheat). changes: `MissionProgressUserState` | mission ID value, progress, claimed | empty response. The changed `MissionProgressUserState` in the delta | `INVALID_REQUEST` | `routing` DEV code. Client `QACore`, bots and `testing` send it |

- `SetMissionProgress` follows the processing order of `cheat`. When progress exceeds `target`, `INVALID_REQUEST`. Writes `progress` and `claimed` of the row with the received values, `reset_at` as the next reset time of lazy reset, and `event_round` by the rule of round reset. Does not check the active window, `requirement` or hooks
- STG and PROD builds have no `SetMissionProgress`

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SetMissionProgressRequest` | `mission_id` | `int32` | `table`: `mission` |
| `SetMissionProgressRequest` | `progress` | `int64` | `min`: 0, `max`: 2^53−1 |
| `SetMissionProgressRequest` | `claimed` | `bool` | none |

## test

- `add_progress` changes only the missions of that counter, `Sum` adds and `Max` keeps the larger value, and both stop at `target`
- `add_progress` with an amount over 2^53−1 does not throw and gives the same result as `add_progress` with amount 2^53−1
- `add_progress` for a mission outside the active window or with `claimed` `true` does not change progress
- `add_progress` for a mission whose `passed` of `evaluate_requirement` is `false` changes progress, and its `ClaimMission` is `MISSION_LOCKED`. `ClaimMission` after `passed` becomes `true` gives the reward with the progress accumulated until then
- For a mission whose `requirement` is an empty cell, `add_progress` changes progress and `ClaimMission` gives the reward
- A `Daily`, `Weekly`, `Monthly` mission keeps its progress just before the reset time and is `(0, false)` at the first read just after it. A mission whose `reset` is `null` does not reset on a `ResetCycle` period
- `ClaimMission` grants the reward with source `Mission` and changes `claimed` to `true`. Both come in the delta of the same response
- Each claim step ends with the error that its failure condition defines, and progress and balance are unchanged
- When the reward cannot be granted directly because it exceeds `max_amount` or an `item-ledger` validation hook rejects it, it is sent as a `[mission_reward_mail]` mail and `claimed` is `true`
- A mission cannot be claimed twice before a reset, and is claimed again after a reset
- After a mission tied to a `live_event` with `repeat` is claimed in round 1, it is the `(progress, claimed)` of round 1 between rounds, `(0, false)` at the first read of round 2, and is claimed again in round 2. The `once_key` values of the two claims of that mission whose `reset` is `null` differ
- When `grant_mission_extra` returns `GameError`, the reward grant is also rolled back
- When a handler ends with `GameError` after `add_progress`, progress is unchanged
- When a row violates the data rules, the server does not start
- When a `mission` row with `extra_grant` `true` exists and content does not register `grant_mission_extra`, the server does not start and an `error` log is left
- In DEV, `SetMissionProgress` changes progress to that value, and `reset_at` of the row is `get_next_reset`(`reset`, request time). A `Daily` mission is `(0, false)` at the first read after that reset time, and `reset_at` of a mission whose `reset` is `null` is 0
- `reset_at` of a `Daily`, `Weekly`, `Monthly` mission is `server-time.get_next_reset`(`reset`, request time)
- A claim leaves core analytics event `core_mission_claimed` for a user who allowed analytics
- `on_mission_claimed` is called once with that mission ID value per successful `ClaimMission`, and the changes of `add_progress` called inside it come in the delta of the same response. It is not called for a failed `ClaimMission`. When the hook throws, `ClaimMission` is `INTERNAL`, and progress, `claimed` and items are unchanged
