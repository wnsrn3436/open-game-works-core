# UserStateCore

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

Keeps the UserState that the server sent as a client cache, applies UserState deltas, and reports each apply through hooks and events. Gives, with the same calculation as the server modules, the current balance and recovery times of a recovery item, the balance of a group item, the end time of a timed item, the balance of a big item, the result of an item grant over `max_amount`, and, with resets applied, purchase counts, grant counts, reset counters, mission progress, attendance progress, live event rounds and offer periods.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `DataCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `apply_delta` | UserState delta, source(`Response`, `Pending`) | success flag. Whether the delta was applied | `false` | `NetworkCore` |
| `notify_item_changes` | list of `ItemChange` | none | none | `NetworkCore` |
| `notify_item_mails` | list of `ItemMail` | none | none | `NetworkCore` |
| `get` | list kind, `id` | object in the cache | none | core, content code |
| `get_single` | single kind | object in the cache | none | core, content code |
| `count` | list kind | number of objects | `0` | core, content code |
| `list` | list kind, caller buffer | number filled | `0` | core, content code |
| `get_change_number` | kind | change number | `0` | core, content code |
| `get_item_balance` | ID value of the item | balance. For a recovery item, the value with recovery up to the current server time applied; for a group item, the sum of the member item balances; for a timed item, 1 while the effect is active and 0 otherwise; for a big item, 2^53−1 when it is more than 2^53−1 | `0` | core, content code |
| `get_item_recovery` | ID value of the item | (next recovery time, cap reach time). Both `0` when the item is not recovering | (`0`, `0`) | core, content code |
| `get_item_big_balance` | ID value of the item | big integer of the balance | big integer `0` | core, content code |
| `get_item_ends_at` | ID value of the item | end time of a timed item. `0` when the effect has ended or the item is not a timed item | `0` | core, content code |
| `preview_item_add` | list of `ItemAmount` | one `ItemAddPreviewRow` per item. In input order | empty list | content code |
| `get_user_created_at` | none | time received by `set_user_created_at` | `0` | `AdCore`, content code |
| `get_shop_purchase_count` | shop product ID value | purchase count in the current limit period | `0` | content code |
| `get_iap_purchase_count` | iap product ID value | purchase count of `iap` | `0` | `PaymentCore`, content code |
| `get_ad_reward_count` | ad placement ID value | grant count in the current limit period | `0` | content code, `AdCore` |
| `get_reset_counter` | reset counter ID value | count in the current reset cycle | `0` | content code |
| `get_mission_progress` | mission ID value | `(progress, claimed)` | `(0, false)` | content code |
| `get_attendance` | calendar ID value | `(day, next_day)` | `(0, 0)` | content code |
| `get_live_event_round` | live event ID value | `(round, start time, end time)` | `(0, 0, 0)` | content code |
| `is_offer_active` | offer ID value | `true` when active | `false` | content code |
| `get_offer_ends_at` | offer ID value | end time of the offer last turned on | `0` | content code |
| `is_in_period` | `start_at`, `end_at`, live event ID value. A value not given is 0 | `true` when inside the period | `false` | content code |
| `set_user_created_at` | user creation time (Unix ms) | none | none | `AuthCore` |

- A kind here is a kind identifier that the contract tool generates from `user_state.proto` and the base proto. The contract tool generates the code that connects the generated kind types to the cache
- A core kind is a UserState kind of the base proto. Its list and order are `## core UserState kind` of the base proto table that [`server-core`](../../server-core/SKILL.md) `## base proto` points to. Core kinds are cached and applied the same as game kinds

- `ItemAddPreviewRow` and `ItemAddPreview` (`Applied`, `Converted`, `Discarded`, `Mailed`) are the fields and elements that server core `item-ledger` defines. The client's `ItemAddPreviewRow` holds `applied`, `overflow` and the `applied`, `overflow` of each `replacements` element as the contract's big encoding pairs `applied`·`big_applied`, `overflow`·`big_overflow`

## behavior

### cache

- `apply_delta` is the only way the UserState cache changes
- There is a cache per kind. A single kind holds at most one object, and a list kind holds several objects looked up by `id`
- `get`, `get_single` return the object in the cache as it is and do not create a new one. When there is none, the result is none without a log
- `list` fills the caller buffer. The fill order is not defined
- Content code does not change objects in the cache: it does not write values to fields, and does not add objects to or remove objects from the cache
- Code that keeps an object reference looks the object up again when it receives the `UserStateChangedEvent` for that kind
- Calculation operations (`get_item_balance`, `get_item_recovery`, `get_item_big_balance`, `get_item_ends_at`, `preview_item_add`, `get_shop_purchase_count`, `get_iap_purchase_count`, `get_ad_reward_count`, `get_reset_counter`, `get_mission_progress`, `get_attendance`, `get_live_event_round`, `is_offer_active`, `get_offer_ends_at`, `is_in_period`) calculate when called and do not change the cache, change numbers or events
- time-dependent operation: a calculation operation whose result changes as server time passes even when the change number stays the same. These are `get_item_balance` and `get_item_big_balance` for a recovery item and a timed item, `get_item_recovery` for a recovery item, `get_item_ends_at` for a timed item, `preview_item_add` that contains a recovery item or a timed item, `get_shop_purchase_count`, `get_iap_purchase_count`, `get_ad_reward_count`, `get_reset_counter`, `get_mission_progress`, `get_attendance`, `get_live_event_round`, `is_offer_active`, `get_offer_ends_at`, `is_in_period`. Content code reads again at the time the result changes. e.g. the balance of a recovery item at the next recovery time

### delta apply

- A delta item is a `UserStateEntry`. It is an upsert when `deleted` is `false`, and a delete when it is `true`. The format and the item order are `## UserState` of [`contract`](../../contract/SKILL.md). An item of a single kind points to the one object of that kind
- An item with a kind name this build does not know is skipped and not applied. The other items of the same delta are applied
- A delta whose `full` is `true` (a login response, the `user_state` of a `Resync` response whose `full` is `true`) treats every object in the cache as a delete item before the apply. An object whose `id` is in an upsert of that delta is not treated as a delete and is applied as an upsert
- The apply order is the item order of the delta

| item | target object missing | target object present |
|---|---|---|
| upsert | creates an object, copies the server values into it and puts it in the cache | copies the server values into the target object in place |
| delete | skips it without a log | removes the target object from the cache |

- An in-place copy does not create a new object. The object reference is the same before and after the copy
- A delete without a target object is a normal item. The server also sends deletes of objects the client has not received. e.g. a delete that is in both `user_state` and `pending_user_state` of the same response, a delete of an object that was created and deleted before the client received it
- An object removed from the cache is not changed by later applies. An upsert with the same `id` creates a new object
- Each applied item raises the change number of its kind by 1. A skipped item does not raise it. The change number is `0` at `init`, and is raised before the hook and event of that item
- Right after an upsert is applied, the `after_update` hook of that kind is called. When the hook is called, the later items of the same delta are not applied yet
- After all items are applied, `UserStateChangedEvent` is emitted once for each kind with one or more applied items. The order between kinds is not defined
- The delta of a login response and the `user_state` of a `Resync` response whose `full` is `true` have `full` `true` and hold the whole UserState as upserts

### item balance

- recovery item: an item that has a row in the `item_recovery` table (a table that server core `item-ledger` defines). Other items are not recovery items
- `get_item_balance` of an item that is not a recovery item is the `amount` of the object in `ItemBalanceUserState` whose `id` is that ID value, and `0` when there is no such object
- Saved values A and S of a recovery item: when there is an object, A = `amount` and S = `recovery_started_at`. When there is none, A = `initial_amount`, and S = the time received by `set_user_created_at` when `initial_amount` < recovery cap C (the recovery of server core `item-ledger`), otherwise S = 0. When no time was received, S = 0
- When `set_user_created_at` receives a time that differs from the current value, it changes the value and emits `UserStateChangedEvent`. It does not change the change number
- The balance of a recovery item and `get_item_recovery` do the recovery calculation of server core `item-ledger` (`get_balance`, `get_recovery`) with the saved values A, S and t = `TimeCore.get_server_time`. To give the same values as the server, they use neither `TimeCore.is_reached` nor `TimeCore.reachMarginMs`. When `TimeCore.is_synced` is `false`, the balance is A and `get_item_recovery` is (`0`, `0`). For an item that is not a recovery item, `get_item_recovery` is (`0`, `0`). The `cap_bonus_item` balance in C is `get_item_balance` of that item
- group item: an item that has a row in `item_group` (a table that server core `item-ledger` defines). Its balance is the sum of `get_item_balance` over the member items in `members`
- timed item: an item that has a row in `item_timed`. With `ends_at` E of the `ItemBalanceUserState` object and t = `TimeCore.get_server_time`, when t < E the balance is 1 and `get_item_ends_at` is E. Otherwise both are `0`. `TimeCore.reachMarginMs` is not used. When `TimeCore.is_synced` is `false`, both are `0`
- big item: an item that has a row in `item_big`. Its balance is the object's `amount`, `big_amount` read with the contract's big encoding. `get_item_big_balance` is that big integer, and `get_item_balance` is 2^53−1 when that value is more than 2^53−1
- `get_item_big_balance` of an item that is not a big item is the value of `get_item_balance` converted with `UtilCore.big_from_int`

### item grant preview

- `preview_item_add` does the same calculation as server `item-ledger.preview_add_items`. It reads amounts as the big encoding pair `amount`, `big_amount` of `ItemAmount`. It calculates the remaining duration of a timed item with t = `TimeCore.get_server_time`. A list that contains a group item gives the failure value. The balance before the change is `get_item_big_balance` for a big item, otherwise `get_item_balance`. `max_amount` and `overflow` are values of the `item` table, and replacement grants are values of the `item_overflow` table. Going over `max_amount` is judged with the balance limit of `item-ledger`. The balance limit 10^`max_digits` − 1 of a big item is the big integer that repeats `9` as many times as `max_digits` of `item_big`, and sums, differences and comparisons of big items use `UtilCore.big_add`, `big_sub`, `big_compare`. When a `Reject` item or a replacement item goes over `max_amount`, every row is `Mailed`
- The client does not know the server's validation hooks and the deltas it has not received yet, so the result can differ from the server's judgement. The server judges, and the `SHOP_OVERFLOW_LOSS` error of `shop` blocks a discarded amount that was not in the preview

### reset and period

- In this section, reaching a time is judged with `TimeCore.is_reached`, and being before an end time with `TimeCore.is_before_end`. Today is `TimeCore.get_day_number`(`TimeCore.get_current_day`)
- `get_shop_purchase_count`, `get_iap_purchase_count`, `get_ad_reward_count` are the `count` of the object in `ShopPurchaseUserState`, `IapPurchaseUserState`, `AdRewardCountUserState` whose `id` is that ID value. They are `0` when there is no object, when the round reset of server `live-event` sets the count back to the start, or when `reset_at` is not 0 and `is_reached`(`reset_at`) is `true`. The round of the round reset is the round of `get_live_event_round`. `get_iap_purchase_count` looks at the round reset only when the `type` of `iap_product` is `Consumable`, and `get_ad_reward_count` does not look at the round reset
- `get_shop_purchase_count` and `get_iap_purchase_count` are `0` when the `offer` of that product row is not 0, `reset_at` is not 0, and `reset_at` differs from `get_offer_ends_at`(that `offer`) (the same as the purchase limit read of server `offer`). This is checked after the round reset and before the `reset_at` reach judgement
- `get_mission_progress` applies the same reset rules to `(progress, claimed)` of `MissionProgressUserState`, and is `(0, false)` on a reset. However, `reset_at` is checked by whether `is_before_end`(`reset_at`) is `false` instead of `is_reached`(`reset_at`). This is because the server sets progress back to the start at `reset_at` and rejects claims after it
- `get_reset_counter` is the `count` of the object in `ResetCounterUserState` whose `id` is that ID value. It is `0` when there is no object, or when `reset_at` is not 0 and `is_reached`(`reset_at`) is `true`
- `get_attendance` does the same calculation as server `attendance.get_attendance` with `AttendanceUserState`, `attendance_calendar`, `attendance_reward`. The period judgement is `is_in_period`
- `get_live_event_round` does the same calculation as server `live-event.get_round` with the `live_event` table, and returns the same values also when there is no active round. A round is active when `is_reached`(start time) is `true` and `is_before_end`(end time) is `true`. The next round is the round with the earliest start time among the rounds whose `is_reached`(start time) is `false`
- `is_offer_active`, `get_offer_ends_at` do the same calculation as the operations with the same names in server `offer`, with `OfferUserState` and the `offer` table. The round of the round reset is the round of `get_live_event_round`. Being before the end time is `is_before_end`
- `is_in_period`: `false` when `start_at` is not 0 and `is_reached`(`start_at`) is `false`, or `end_at` is not 0 and `is_before_end`(`end_at`) is `false`, or the live event ID value is not 0 and the round of `get_live_event_round` is 0. Otherwise `true`

### lifecycle

- `init` starts with an empty cache, change numbers `0` and user creation time none
- `release` empties the cache and the user creation time and deletes the registered hooks

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `after_update` | registered per kind. Right after an upsert of that kind is applied | the applied object | none | does nothing |

- It is an after hook. It is not called for deletes and skipped items
- Handling after the whole delta is applied uses `UserStateChangedEvent`, not a hook

## event

| event | when | payload |
|---|---|---|
| `UserStateChangedEvent` | after `apply_delta` applies all items, for each kind with applied items. After `set_user_created_at` changes the value, once with kind `ItemBalanceUserState`, source `Response` | kind, source, list of upserted `id`, list of deleted `id`. In the events of a single kind and of `set_user_created_at`, both lists are empty |
| `ItemChangedEvent` | once when `notify_item_changes` receives a list that is not empty | list of `ItemChange`. In the order of `item_changes` of the response |
| `ItemMailedEvent` | once when `notify_item_mails` receives a list that is not empty | list of `ItemMail`. In the order of `item_mails` of the response |

## error

| condition | failure value | log |
|---|---|---|
| the `after_update` hook throws | applies the rest of the delta and `apply_delta` is `true`. The cache has already changed | error |
| the delta decode format differs from the contract (including two or more items with the same kind and `id` in the same delta. Kinds this build does not know are excluded) | `apply_delta` is `false`. Applies none of the delta and emits `EventCore.RestartRequestedEvent` | error |
| an item of a kind this build does not know | skips that item | warn |
| the kind of `get`, `list` is not a list kind, the kind of `get_single` is not a single kind | the failure value in the table | error |
| an item of `preview_item_add` is not in the `item` table or is a group item, `big_amount` is neither an empty string nor a big integer, an amount is less than 1 or more than the amount limit of that item (as server core `item-ledger` defines it), the same item ID value appears twice | empty list | error |
| the live event ID value of `get_live_event_round` is not in the `live_event` table | `(0, 0, 0)` | error. Once per ID value until `release` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `TimeCore.reachMarginMs` | integer | core | content | ms that `TimeCore` adds in reach judgements and subtracts in before-end-time judgements. The recovery calculation does not use this value; it is used in the expected times of tests |

## data

used table: `item`, `item_overflow`, `item_recovery`, `item_group`, `item_timed`, `item_big`, `attendance_calendar`, `attendance_reward`, `live_event`, `offer`, `shop_product`, `iap_product`, `mission`, `reset_counter`

- Reads the `item`, `item_overflow`, `item_recovery`, `item_group`, `item_timed`, `item_big` tables of server core `item-ledger` with `DataCore`. `item-ledger` defines the headers
- Reads with `DataCore` the tables `attendance_calendar`, `attendance_reward` of server core `attendance`, `live_event` of `live-event`, `offer` of `offer`, `shop_product` of `shop`, `iap_product` of `iap`, `mission` of `mission`, `reset_counter` of `reset-counter`. The module of each table defines its headers

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `export_json` | kind. none means every kind | JSON object string that writes the cache in the same format as `user_state` of server core `admin-api.get_user`. When a kind is given, it holds only the one key of that kind | empty string | `QACore` |
| `apply_test_delta` | UserState delta | success flag | `false` | core test |

- `apply_test_delta` behaves the same as `apply_delta`. Core tests use it to prepare UserState

## test

- After a delta with an upsert without a target object, an upsert with a target object and a delete, `get` of the first two `id`s equals the server values and `get` of the deleted `id` is none
- The `get` results before and after an upsert with a target object are the same object
- When one delta has two items with the same kind and `id`, none of the delta is applied
- In a delta with an item of a kind this build does not know, only that item is skipped with a warn log, and the items of other kinds are applied
- A delete without a target object is skipped without a log, a change number change or `UserStateChangedEvent`. When another item of the same kind in the same delta is applied, the deleted `id` list of the `UserStateChangedEvent` for that kind does not have the skipped `id`. An upsert has no log whether or not there is a target
- An object added again with the same `id` after a delete differs from the deleted object, and the deleted object is not changed by later upserts
- After a delete of a single kind, `get_single` is none, the change number rises by 1, and `UserStateChangedEvent` of that kind is emitted once
- Even with several items of one kind, `UserStateChangedEvent` is emitted once for that kind, and not for a kind with no applied item
- When `UserStateChangedEvent` is received, the whole delta is applied, and it is received before the success callback of `NetworkCore`
- `after_update` is called once per upsert right after its apply, and is not called for deletes and skipped items. The change number inside the hook is the value after that item is applied
- The change number rises by 1 for each applied item and does not rise for skipped items
- For a delta whose format differs from the contract, `apply_delta` is `false`, the cache and change numbers do not change, and one error log and one `RestartRequestedEvent` are emitted. For an applied delta, `apply_delta` is `true`
- `get_item_balance` of an item without a balance object is `0`, and is that `amount` when a balance arrives in an `ItemBalanceUserState` delta
- For a recovery item (interval 60000, amount 1, cap 5) with `amount` 2 and `recovery_started_at` S, the balance is 2 at server time S + 59999, 3 at S + 60000, 5 at S + 600000, and `get_item_recovery` at S + 60000 is (S + 120000, S + 180000). When the balance is the cap, it is (`0`, `0`)
- The balance of a recovery item with `cap_bonus_item` (cap 5, bonus item balance 2) rises to 7 as time passes, and after a delta makes the bonus item balance 3, the balance and `get_item_recovery` are calculated with C 8
- The balance of a recovery item without an object is `initial_amount`, and when `initial_amount` < recovery cap C, recovery starts from the time of `set_user_created_at`. Before the first sync it is A
- At a time when only recovery happened, there is no `UserStateChangedEvent` and no change number change
- With the same data and balances, `preview_item_add` returns the same rows as server `item-ledger.preview_add_items` for each overflow of a `Reject`, `Discard`, `Convert` item and of a replacement item with `Discard`. A recovery item is calculated with the balance that applies recovery up to the current server time
- `notify_item_changes`, `notify_item_mails` emit `ItemChangedEvent`, `ItemMailedEvent` once for a list that is not empty, in the order received, and emit none for an empty list
- For each case of core test fixture `item-recovery`, `get_item_balance`, `get_item_recovery` equal the expected values
- After a `full` delta, only the upserts of that delta remain in the cache, an object that remains with the same `id` is the same object, and `UserStateChangedEvent` is emitted once for each kind that had a deleted object or has an upsert
- After `release` and `init` again, the cache is empty, change numbers are `0`, and hooks registered before are not called
- `export_json` writes the same values as the cache in the same format as `user_state` of server core `admin-api.get_user`, and is not in STG·PROD builds
- For a `ShopPurchaseUserState` object whose `reset_at` is R, `get_shop_purchase_count` is `count` at server time R + `TimeCore.reachMarginMs` − 1 and `0` at R + `TimeCore.reachMarginMs`. The same holds for `get_iap_purchase_count`, `get_ad_reward_count`, `get_reset_counter`
- For a `MissionProgressUserState` object whose `reset_at` is R, `get_mission_progress` is the saved `(progress, claimed)` at server time R − `TimeCore.reachMarginMs` − 1 and `(0, false)` at R − `TimeCore.reachMarginMs`
- For an object with `event_round` 1 of a shop product bound to a `live_event` with `repeat`, `get_shop_purchase_count` is `count` between rounds and `0` from the start time of round 2 + `TimeCore.reachMarginMs`. The same holds for `get_iap_purchase_count` of a `Consumable` product, `get_mission_progress`, `get_attendance`
- For an object with `event_round` 1 of an offer bound to a `live_event` with `repeat`, `get_offer_ends_at` is `started_at` + `duration` between rounds and `0` from the start time of round 2 + `TimeCore.reachMarginMs`
- For each case of core test fixtures `live-event-round`, `attendance-progress`, `get_live_event_round`, `get_attendance` equal the expected values. `TimeCore.reachMarginMs` is set to 0
- `get_live_event_round` of an ID value not in the `live_event` table is `(0, 0, 0)` with one error log
- `is_offer_active` is `true` at `started_at` + `duration` − `TimeCore.reachMarginMs` − 1 and `false` at `started_at` + `duration` − `TimeCore.reachMarginMs`, and `get_offer_ends_at` is still `started_at` + `duration` after that
- `is_in_period` with `end_at` E is `true` at E − `TimeCore.reachMarginMs` − 1 and `false` at E − `TimeCore.reachMarginMs`. `get_live_event_round` whose active round has end time F has round 0 from F − `TimeCore.reachMarginMs`
- `get_user_created_at` is the value of `set_user_created_at`, and `0` before a value is received and after `release`. Each `set_user_created_at` that changes the value emits `UserStateChangedEvent`(`ItemBalanceUserState`, `Response`, two empty lists) once and leaves the change number as it is. `set_user_created_at` with the same value emits no event
- `get_item_balance` of a group item is the sum of the member item balances, and `preview_item_add` with a group item and `preview_item_add` with an amount more than 2^53−1 for an item that is not a big item give an empty list and an error log
- For a timed item with `ends_at` E, `get_item_balance` is 1 at server time E − 1 and 0 at E, and `get_item_ends_at` is E at E − 1 and `0` at E. When the effect ends only because time passes, there is no `UserStateChangedEvent`
- For each case of core test fixture `item-timed`, `preview_item_add` equals the expected value
- For each case of core test fixture `item-big`, `preview_item_add` equals the expected value
- In `preview_item_add` that adds 2^53−1 to a `Convert` item whose balance is `max_amount`, the element of the replacement item (`convert_to` `amount` 2, `overflow` `Discard`, balance 0) has `applied` equal to the `max_amount` of that replacement item, `overflow` 0 and `big_overflow` equal to the big integer of 2 × (2^53−1) − `max_amount`
- For a big item whose `big_amount` is `12345678901234567890`, `get_item_big_balance` is that string and `get_item_balance` is 2^53−1. For an item that is not a big item, `get_item_big_balance` is the decimal string of `get_item_balance`
