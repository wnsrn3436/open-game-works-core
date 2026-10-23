# offer

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

Handles offers that open for a limited period only to a user who meets a condition. When content reports a trigger, judges the conditions of the data and turns on that user's offer.

## dependency

- `validation`
- `live-event`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `trigger_offer` | ctx, offer ID value | `OfferTriggerResult.OK` | failure element of `OfferTriggerResult` | content handler, hook |
| `is_offer_active` | ctx, offer ID value | `true` when active | `false`. An unknown offer ID value is also `false` | content handler, hook, `shop`, `iap` |
| `get_offer_ends_at` | ctx, offer ID value | end time of the last turn-on of the offer | 0. The offer was never turned on, or the offer ID value is unknown | content handler, hook, `shop`, `iap` |
| `read_purchase_limit` | ctx, `offer`(0 means none) of the product data row, `reset`(`ResetCycle?`) of the product data row, `live_event`(0 means none) used for round reset, `count` of the purchase count row, `reset_at`, `event_round`(all three 0 when there is no row) | `count`, `reset_at`, `event_round` read by the purchase limit read rule, and `write_reset_at` for writing an increased purchase count | none | `shop`, `iap` |

- offer ID value: ID value of the `offer` table. Content code gets it with a reserved ID accessor

`OfferTriggerResult`

| element | meaning |
|---|---|
| `OK` | turned the offer on |
| `UNKNOWN_OFFER` | offer ID value not in the `offer` table |
| `UNAVAILABLE` | outside the active window of the offer |
| `ACTIVE` | already active. The end time was not changed |
| `LIMIT_REACHED` | the turn-on count reached `max_triggers` |
| `COOLDOWN` | before the last end time + `cooldown` |
| `LOCKED` | `passed` of the `evaluate_requirement` result for `requirement` is `false` |

## behavior

### state

- The state is saved to the core UserState kind `OfferUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state` and `delete_core_state`. field: `int64 id` (offer ID value), `int64 started_at` (time of the last turn-on), `int32 trigger_count` (turn-on count), `int32 event_round`
- The end time is `started_at` + `duration`. The offer is active when the row exists and `server-time.is_reached_strict`(end time) is `false`
- When the offer row has `live_event`, the `OfferUserState` row follows the round reset of `live-event`. The fields that go back to their initial value are `started_at` and `trigger_count`, and the initial value is 0. A row with `trigger_count` 0 counts as no row
- Client `UserStateCore.is_offer_active` and `get_offer_ends_at` do the same calculation
- purchase limit read: `read_purchase_limit` starts from the received values of `count`, `reset_at` and `event_round` of the product's purchase count row (`ShopPurchaseUserState` of `shop`, `IapPurchaseUserState` of `iap`) and reads them in the order below. `shop` and `iap` read the purchase count row only with this operation, and get the next reset time only from `write_reset_at` of this operation. The values changed by this read are saved only when something writes to that row
  1. round reset of `live-event`: when `live-event.is_round_reset`(`live_event`, `event_round`) is `true`, takes `count` as 0, `event_round` as `live-event.round_to_write`(`live_event`) and `reset_at` as the next reset time
  2. offer purchase reset: when `offer` is there and `reset_at` is not 0 and differs from `get_offer_ends_at`(`offer`), takes `count` as 0 and `reset_at` as `get_offer_ends_at`(`offer`). So even when the offer is turned on again before the previous end time, the purchase count starts from 0
  3. lazy reset of `server-time`: when `reset_at` is not 0 and `server-time.is_reached_strict`(`reset_at`) is `true`, takes `count` as 0 and `reset_at` as the next reset time
- The next reset time is `get_offer_ends_at`(`offer`) when `offer` is there, otherwise `server-time.get_next_reset`(`reset`, request time). When `reset` is `null` and there is no `offer`, it is 0 and there is no reset
- `write_reset_at` is the next reset time when the read `reset_at` is 0, otherwise the read `reset_at`

### trigger

`trigger_offer` processing order. At the first step that applies, returns its element and changes nothing.

1. When the offer ID value is not in `offer`, `UNKNOWN_OFFER`
2. When `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the offer row) is `false`, `UNAVAILABLE`
3. When active, `ACTIVE`
4. When `trigger_count` ≥ `max_triggers`, `LIMIT_REACHED`. When there is no `max_triggers`, takes the `int32` maximum 2^31−1 of `trigger_count` as `max_triggers`
5. When the row exists and request time < end time + `cooldown`, `COOLDOWN`
6. When `passed` of the `validation` `evaluate_requirement` result for `requirement` is `false`, `LOCKED`
7. Writes `started_at` as request time, `trigger_count` as its value plus 1, and `event_round` by the round reset rule of `live-event`
8. Emits core analytics event `core_offer_triggered` with `logging.track_core_event`

- Content decides the occasion of a trigger (e.g. 3 failures of the same stage, reaching a level, the moment of being blocked on a purchase screen because currency is short) and the screen after the offer turns on
- The changed row goes in the delta of that response. When called in an out-of-request change, it goes to a pending delta. When the handler ends with `GameError`, the rollback of `storage` reverts it. So a request that ends in failure cannot be an occasion
- When the occasion is a moment at which the client checks in advance and does not send a request (e.g. a purchase with short currency), client content code sends a game `rpc` at that moment. Its handler checks the condition again with the server's values (e.g. balance short), then calls `trigger_offer` and ends with success

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| unknown offer ID value in `trigger_offer` | `UNKNOWN_OFFER` | content decides | `error` log |
| outside the active window, active, count limit, cooldown, `passed` of `evaluate_requirement` is `false` | that element | content decides | none |

Added `CoreError`: none

## settings

none

## data

`data/tables/offer.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `duration` | `duration` | `All` |
| `cooldown` | `duration` | `All` |
| `max_triggers` | `int?` | `All` |
| `requirement` | `requirement` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |

- `duration` is 1 or more, `cooldown` is 0 or more, `duration` + `cooldown` is 2^53−1 or less, and `max_triggers` is 1 or more. When a row violates this, the server does not start
- The game keeps the background and text of the offer screen in an extension table

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_offer` | ctx, offer ID value, `started_at`, `trigger_count` | none | input violation throws | content cheat handler, `testing` |

- `set_offer` writes the row with those values and writes `event_round` by the round reset rule of `live-event`. When `trigger_count` is 0, deletes the row. Throws for an unknown offer, for a value that is not an integer, is less than 0 or is outside the range of its field type (`started_at` `int64`, `trigger_count` `int32`), and for a `started_at` for which `started_at` + `duration` + `cooldown` of that offer is 2^63 or more. Does not look at the active window, `requirement`, the `cooldown` condition or `max_triggers`
- STG and PROD builds do not have `set_offer`

## test

- `trigger_offer` is `OK` and sends an `OfferUserState` row with `started_at` request time and `trigger_count` 1 in the delta of the same response. At end time − 1, `is_offer_active` is `true`; at end time, `false`
- Each step of the processing order returns its element and the row stays. `trigger_offer` while active is `ACTIVE` and the end time stays
- At end time + `cooldown` − 1 the result is `COOLDOWN`; at that time, `OK`. When `trigger_count` is `max_triggers`, `LIMIT_REACHED`
- `trigger_offer` in a request whose handler ended with `GameError` leaves no row
- `get_offer_ends_at` returns the last end time also after the active period ends, and 0 when the offer was never turned on
- `read_purchase_limit` reads `count` as it is for `offer` 0, for `reset_at` 0 and for a `reset_at` equal to `get_offer_ends_at`, and reads `count` 0 and `reset_at` `get_offer_ends_at` for a `reset_at` that is not 0 and differs from `get_offer_ends_at`. A row that round reset, offer purchase reset and lazy reset all apply to is read in that order. `write_reset_at` of a row with `reset_at` 0 is the next reset time
- After an offer bound to a `live_event` with `repeat` is turned on `max_triggers` times in round 1, `get_offer_ends_at` between rounds is the last end time. When round 2 starts, `get_offer_ends_at` before turning on is 0 and `is_offer_active` is `false`, `trigger_offer` is `OK`, and the row's `trigger_count` is 1 and `event_round` is 2
- `OK` leaves core analytics event `core_offer_triggered` for a user who allowed analytics
- When a row violates the data rules, the server does not start
- In DEV, `set_offer` changes the row to those values; STG and PROD do not have it
- For an offer without `max_triggers`, `trigger_offer` after `set_offer`(…, 2^31−1) is `LIMIT_REACHED` and the row stays
- `set_offer` accepts a `started_at` for which `started_at` + `duration` + `cooldown` is 2^63−1, after which `is_offer_active` and `trigger_offer` do not throw, and throws for a `started_at` for which it is 2^63
