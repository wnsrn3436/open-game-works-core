# item-ledger

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

As the only path that changes user items, this module owns the transactions and history that add, subtract and check a user's items (currency, and goods counted by number). It also owns recovery items, group items, timed items and big items.

## dependency

- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_balance` | ctx, item ID value | balance (integer). For a recovery item, the value with recovery up to the request time applied; for a group item, the sum of the member item balances; for a timed item, 1 while the effect is active, otherwise 0 | none. 0 for an unknown item ID value | content handler, hook, core module |
| `get_ends_at` | ctx, item ID value | end time of the timed item. 0 when the effect has ended or the item is not a timed item | none. 0 for an unknown item ID value | content handler, hook, core module |
| `get_recovery` | ctx, item ID value | `next_at` (next recovery time), `cap_at` (time the cap is reached). Both 0 when not recovering | both 0 when the item is not a recovery item or the item ID value is unknown | content handler, hook, core module |
| `check_items` | ctx, list of `ItemAmount` | `true` when the user has everything in the list | `false` | content handler, hook, core module |
| `amount_limit` | item ID value | amount limit of that item | 0 for an unknown item ID value | core module |
| `read_amount` | `ItemAmount` | amount. The integer read from the big encoding pair `amount`, `big_amount` | none when `big_amount` is neither an empty string nor a big integer | core module |
| `make_item_amount` | item ID value, amount | `ItemAmount` that carries the amount in the big encoding pair | none | core module |
| `check_add_items` | list of `ItemAmount` | `ItemChangeResult.OK` | `INVALID_AMOUNT`, `UNKNOWN_ITEM`, `UNSUPPORTED_ITEM` of `ItemChangeResult` | `mailbox` |
| `content_change_source` | ctx, change source passed by content code (optional) | change source whose `source`, `ref`, `once_key` are set by the change source rules below | none | `mailbox` |
| `has_core_once_key_prefix` | `once_key` | `true` when it starts with a core `once_key` prefix | `false` | `mailbox` |
| `change_failure_code` | `ItemChangeResult` failure element or `GameError` | failure code that a core module's request responds with. It is the response rule of `## error` below | none | core module |
| `add_items` | ctx, list of `ItemAmount`, change source | `ItemChangeResult.OK` | failure element of `ItemChangeResult` or the hook's `GameError` | content handler, hook, core module |
| `subtract_items` | ctx, list of `ItemAmount`, change source | `ItemChangeResult.OK` | failure element of `ItemChangeResult` or the hook's `GameError` | content handler, hook, core module |
| `exchange_items` | ctx, list of `ItemAmount` to subtract, list of `ItemAmount` to add, change source | `ItemChangeResult.OK` | failure element of `ItemChangeResult` or the hook's `GameError` | content handler, hook, core module |
| `preview_add_items` | ctx, list of `ItemAmount` | `ItemAddPreviewRow` per item. In input order | `INVALID_AMOUNT`, `UNKNOWN_ITEM`, `UNSUPPORTED_ITEM` of `ItemChangeResult` | content handler, hook, `shop` |
| `revoke_items` | ctx, list of `ItemAmount`, change source | list of elements, one per item, each `item_id` (item ID value), `shortfall` (amount not revoked). In input order | failure element of `ItemChangeResult` | `admin-api`, `iap`, content `revoke_iap` hook |
| `list_history` | user ID, start time, end time, cursor `seq` (0 is from the start), max row count | list of history rows. Holds the rows with start time ≤ `time` < end time and `seq` greater than the cursor, in ascending order of `seq` | empty list | `admin-api` |

- ctx is the user transaction of one request or of one out-of-request change. Items outside the ctx's user are not read or changed
- `admin-api` and `iap` call `revoke_items` inside an out-of-request change opened with `storage.run_user_transaction`. The content `revoke_iap` hook is called inside that change opened by `iap`
- `ItemAmount` is `(item ID value, amount)`. The amount is an integer of at least 1 and at most the item's amount limit. The amount limit is 10^`max_digits` − 1 for a big item and 2^53−1 for any other item. In the contract it is the base proto message `ItemAmount` (`int32 item_id`, `int64 amount`, `string big_amount`), and the amount goes in the contract's big encoding pair `amount`, `big_amount`
- For each change, adds the base proto message `ItemChange` (`int32 item_id`, `int64 delta` (applied signed change), `int64 overflow` (amount that did not fit because of `max_amount`. 0 unless `Discard` or `Convert`), `ItemChangeSource source`, `string ref`, `string big_delta`, `string big_overflow`) to the ctx with `storage.add_item_change`. For a request it goes in that response's `item_changes`; for an out-of-request change it accumulates with the pending delta. `shortfall` is not carried. `ItemChangeSource` is a base proto enum
- A `Convert` replacement grant is, per replacement item, an `ItemChange` with source `Overflow` and `ref` the decimal string of the overflowed item's ID value, carried right after the overflowed item's `ItemChange`
- `delta` and `big_delta`, and `overflow` and `big_overflow`, of `ItemChange` are each a big encoding pair of the contract. For a timed item, `delta` and `overflow` are amounts (counts of `duration` units)
- `exchange_items` records, per item, the net change that combines the amount to subtract and the amount to add of the same item ID value as one `ItemChange` and one history row. An item whose net change is 0 is not recorded
- `check_add_items` runs the step 1 input check of the `add_items` change order with the server build data. It reads and writes nothing
- A change source is `(source, ref, once_key)`. In TypeScript it is the object `{source, ref, once_key}`, and an omitted `ref` or `once_key` is an empty string
  - `source`: an `ItemChangeSource` element. When content code calls, core sets it: the source of the ctx's `hook_change_source` when there is one, otherwise `Request`. A `source` passed by content code is not used
  - `ref`: string that identifies the cause. When the ref passed by content code is not an empty string, that value. Otherwise the ref of the ctx's `hook_change_source` when there is one, otherwise the ctx's `request_name`. The spec of a core module sets the ref that module passes
  - `once_key`: when not empty, a change with the same `once_key` is applied only once for the same user. Content code can also pass it. When a `once_key` passed by content code starts with a core `once_key` prefix, nothing changes, the call throws and leaves an `error` log. The request is `INTERNAL`
- core `once_key` prefix: a string that a `once_key` passed by a core module starts with. They are `ad:`, `admin:`, `attendance:`, `broadcast:`, `coupon:`, `gacha:`, `iap:`, `mail:`, `mission:`, `play_session_refund:`, `ranking:`, `rating:`, `shop:`. A server module spec that sets a core `once_key` format has, in `## behavior`, a line `` - `once_key` prefix: `<prefix>`, ... `` with the prefixes of that format. This list equals all prefixes of those lines together, and `ogw docs check` compares them

`ItemChangeResult`

| element | meaning |
|---|---|
| `OK` | applied |
| `ALREADY_APPLIED` | a change with the same `once_key` already exists. Nothing was changed |
| `NOT_ENOUGH` | the balance is less than the amount to subtract |
| `LIMIT_EXCEEDED` | the balance after adding is more than `max_amount` and the item's `overflow` is `Reject`. The same for a `Convert` replacement grant item |
| `UNKNOWN_ITEM` | an item ID value that is not in the `item` table |
| `INVALID_AMOUNT` | the amount is less than 1 or more than the item's amount limit. Or the same item ID value is in the list twice |
| `UNSUPPORTED_ITEM` | an item that the operation does not handle: a group item in a list to add or revoke and in `set_balance`, a timed item in a list to subtract |
| `REJECTED` | the validation hook returned a `GameError`. That `GameError` is returned with it |

`ItemAddPreviewRow`: `item_id` (item ID value), `outcome` (`ItemAddPreview`), `applied` (amount that goes into the item), `overflow` (amount that does not fit because of `max_amount`), `replacements` (list of elements, one per `Convert` replacement item, each `item_id` (replacement item ID value), `applied` (amount that goes in), `overflow` (amount that does not fit). In `convert_to` order. An empty list unless `Convert`). `applied`, `overflow` and the `applied`, `overflow` of `replacements` elements are `bigint`

`ItemAddPreview`

| element | meaning |
|---|---|
| `Applied` | the whole amount goes into the item |
| `Converted` | the whole overflowed amount goes to the `Convert` replacement grant, and no replacement item has an amount that does not fit |
| `Discarded` | the amount that does not fit is discarded. The item's `overflow` is `Discard` and `overflow` is 1 or more, or a replacement item's amount that does not fit is 1 or more |
| `Mailed` | `add_items` of the same list ends with `LIMIT_EXCEEDED`. Every row is `Mailed`, with `applied` and `overflow` 0 and `replacements` an empty list. `mailbox.grant_or_mail` sends this whole list as mail |

`ItemChangeSource`: `Request`, `Mail`, `Shop`, `Iap`, `IapRefund`, `IapTransfer`, `AdReward`, `Gacha`, `Mission`, `Coupon`, `Nickname`, `Admin`, `Cheat`, `Recovery`, `Overflow`, `Attendance`, `LiveEvent`, `Match`, `UserChange`, `PlaySessionRefund`, `PlaySession`

- Only this module uses `Recovery` and `Overflow`. When a caller passes one as the change source, the call ends with `INTERNAL` and leaves an error log
- `Recovery` is recorded only in the history of recovery application and is not carried in `item_changes`
- `Overflow` is recorded in the history and the `item_changes` of a `Convert` replacement grant (change order step 3)

## behavior

- An item is one row of the `item` table. Per item, the user balance is an integer of at least 0 and at most the balance limit. The balance limit is 10^`max_digits` − 1 for a big item and `max_amount` for any other item. In this spec, the judgement of more than `max_amount` uses the balance limit
- A recovery item, group item, timed item and big item is an item with a row in the `item_recovery`, `item_group`, `item_timed` and `item_big` table respectively. An item is at most one of these four
- An item is something whose sameness is decided by count alone. Things whose units each have different attributes (e.g. equipment with an enhancement level) are not items. Content defines them as a UserState kind
- `ItemBalanceUserState` is a core UserState kind of the base proto. Only this module writes it, with `storage.put_core_state` and `delete_core_state`. `storage` rejects `put_state` and `delete_state` from content code

change order. `add_items`, `subtract_items` and `exchange_items` are handled in the order below and end with the failure value of the step that fails. On failure, no balance and no history changes.

1. Input check: `INVALID_AMOUNT`, `UNKNOWN_ITEM`, `UNSUPPORTED_ITEM`. `exchange_items` checks the list to subtract and the list to add separately
2. `ALREADY_APPLIED` when there is a `once_key` and it is in the same user's `once_key` table
3. Calculation of the balance after the change, per item. The balance before the change of a recovery item is the balance after recovery application. `exchange_items` calculates after combining the amount to subtract and the amount to add of the same item ID value
   - Balance less than 0: `NOT_ENOUGH`
   - Balance more than `max_amount`: `LIMIT_EXCEEDED` when `overflow` is `Reject`; when `Discard`, sets the balance to `max_amount` and records the amount that did not fit as `overflow`. When `Convert`, makes the replacement grant below
   - `Convert` replacement grant: sets the balance to `max_amount` and records the overflowed amount n as `overflow`. For each `convert_to` element of the item's `item_overflow` row, adds to the same operation a replacement grant that adds `amount` × n to that replacement item. Replacement grants are calculated in this step after all changes of the list are calculated, one by one in list order and `convert_to` order. A replacement item's balance above its limit follows that item's `overflow`: when `Reject`, the whole operation is `LIMIT_EXCEEDED`; when `Discard`, sets the balance to `max_amount` and records the amount that did not fit as the `overflow` of that replacement grant
   - A product or sum more than the item's amount limit counts as more than `max_amount`
   - Group items and timed items are calculated by the group item and timed item rules below
4. Call of hook `validate_item_change`. `REJECTED` when it returns a `GameError`
5. Record of recovery application of recovery items, save of balances, save of history, save of `once_key`
6. Call of hook `after_item_change`

- There is one `once_key` for the whole operation, replacement grants included
- `preview_add_items` calculates steps 1 and 3 of the change order of `add_items` for the same list and saves nothing. The balance is the value with earlier changes in the same ctx and recovery up to the request time applied. It does not run steps 2 and 4, because the validation hook is called only right before a change that has a change source. So a grant that becomes mail through a hook rejection (`REJECTED`) shows as the element of the calculation without the hook, not as `Mailed`. A hook rejection makes no discarded amount, so a grant in the same ctx after a preview with no `Discarded` row discards nothing
- `check_items` is `true` when balance ≥ amount for each item of the list. The balance is the value of `get_balance`. When the list has a group item together with its member item, the group item's balance is the sum, over member items, of the balance minus that member item's amount in the list. `false` when the input meets the `INVALID_AMOUNT` or `UNKNOWN_ITEM` condition
- `revoke_items` applies the recovery of recovery items first. When the balance is less than the amount to revoke, it sets the balance to 0, returns the missing amount as shortfall and records it in the history. It does not call the validation hook. For each item with a revoked amount of 1 or more, it leaves one `audit` log line through the transaction's `storage.on_commit`. A rolled-back revocation leaves no log. The fields are `user_id`, `item_id` (item ID value), `revoked` (amount revoked), `shortfall` (amount not revoked), `source`, `ref`, `once_key`, and `revoked`, `shortfall` are big integer strings of the contract. `actor` follows the `audit` rule of `logging`
- The `once_key` of `revoke_items` is handled as in `add_items`. When it is in the same user's `once_key` table, nothing changes and the result is `ALREADY_APPLIED`; otherwise it is saved with the revocation
- `UNSUPPORTED_ITEM` when the list of `revoke_items` has a group item. A timed item is revoked by the timed item rules below
- After a failed operation, the handler can continue with other changes in the same transaction. When the handler returns a `GameError`, `storage` rolls back the whole transaction
- Changes of the same user are handled one at a time by the per-user serialization of `storage`. Concurrent requests cannot write the same balance twice

recovery

A recovery item is an item with a row in the `item_recovery` table. While the balance is less than the recovery cap, it grows by `recovery_amount` every `recovery_interval`. Recovery alone does not go above the recovery cap. Other changes (grant, mail, purchase) can add above the recovery cap up to `max_amount`, and more than `max_amount` follows the `overflow` rule of the change order.

- recovery cap C: `recovery_cap` when `cap_bonus_item` is `null`, otherwise `recovery_cap` + the user's `cap_bonus_item` balance. e.g. a game whose max stamina grows with user level sets the item granted on level up as `cap_bonus_item`
- Saved values: `amount` (balance at the last save) A and `recovery_started_at` (start time of the current recovery interval) S of `ItemBalanceUserState`. S is 0 when balance ≥ C
- The calculation is lazy. The balance at time t (request time, `server-time.now`) is as below; it is only calculated, not saved
  - A when S is 0 or A ≥ C
  - Otherwise n = `max(0, floor((t − S) / recovery_interval))`, balance = `min(A + n × recovery_amount, C)`. When n is at least the count that reaches C, the balance is set to C without multiplying, to prevent overflow
- Recovery application: in change order step 5 and right before the save of `revoke_items` and `set_balance`, it is done for each recovery item in the operation's list (for `set_balance`, its item) and in `Convert` replacement grants, and for each recovery item whose own `cap_bonus_item` is in that list or those replacement grants. C is set from the `cap_bonus_item` balance before the operation's change. Writes the balance of the lazy calculation as A; when that balance is less than C, moves S to S + n × `recovery_interval` to keep the interval in progress, otherwise sets S to 0. When the grown amount is 1 or more, records one history row with source `Recovery` and `ref` an empty string
- S after the change: C after the change is set from the `cap_bonus_item` balance after the change. 0 when the balance after the change ≥ C after the change; t when S after recovery application is 0 and the balance after the change < C after the change; otherwise S after recovery application. A recovery item whose `cap_bonus_item` balance alone changed also saves its balance row with this A and S
- A recovery item with no row counts as A = `initial_amount`. When `initial_amount` < C, S is the user's `created_at` read with `storage.get_user_record`, otherwise 0
- `get_recovery`: set from n and balance B of the lazy calculation. `(0, 0)` when S is 0 or B ≥ C. Otherwise S′ = S + n × `recovery_interval`, the next recovery time is S′ + `recovery_interval`, and the time the cap is reached is S′ + `ceil((C − B) / recovery_amount)` × `recovery_interval`
- Recovery is set by time alone, so recovery alone sends no delta

group item

A group item is an item that combines the balances of several member items into one balance to check and subtract. e.g. a premium currency with a paid premium currency item and a free premium currency item as member items. The balance of a group item is not saved.

- The balance is the sum of the balances of the member items in `members` of `item_group`
- Subtract: change order step 3 first calculates the items of the list that are not group items, then the group items in list order. The amount a of a group item is subtracted in `members` order, from each member item by min(remaining a, that member item's balance at that point). `NOT_ENOUGH` when not all of it can be subtracted
- A group item does not appear in `ItemChange`, history rows or the hooks' lists. The subtracted amount is recorded as changes of member items; when the same member item is also in the list, the two are recorded as one combined net change
- `UNSUPPORTED_ITEM` when a group item is in `add_items`, `revoke_items`, `preview_add_items`, the list to add of `exchange_items`, or `set_balance`
- Each member item keeps its own balance and history. The balance and spending of paid currency are counted by the balance and history of the paid member item

timed item

A timed item is an item whose effect lasts until an end time. Amount 1 is an effect of `duration` ms of `item_timed`.

- The saved value is `ends_at` E of `ItemBalanceUserState`. The remaining duration R is max(0, E − request time). The balance is 1 when R > 0, otherwise 0
- Add n: k = n when R + n × `duration` ≤ `max_amount` × `duration`. When it is more, `LIMIT_EXCEEDED` when `overflow` is `Reject`; when `Discard`, k = ⌊(`max_amount` × `duration` − R) ÷ `duration`⌋ and n − k is recorded as `overflow`. E becomes request time + R + k × `duration` and `delta` is k. Adding during the effect extends the end time; adding after the effect has ended starts from the request time
- Revoke n: the revoked duration x = min(R, n × `duration`). E becomes request time + R − x, shortfall is ⌊(n × `duration` − x) ÷ `duration`⌋, and `delta` is −(n − shortfall)
- `UNSUPPORTED_ITEM` when a timed item is in the list to subtract of `subtract_items` or `exchange_items`. The effect ends at the end time
- When E after the change ≤ request time, the row is deleted
- `preview_add_items` sets `applied` and `overflow` with the same k as add
- `get_ends_at` is E when R > 0, otherwise 0
- In the lists of `validate_item_change` and `after_item_change`, the balance before the change and the balance after the change of a timed item are the remaining duration in ms

big item

A big item is an item whose balance can be more than 2^53−1. e.g. gold of an idle game.

- Balances, amounts and change amounts are calculated as `bigint`

storage and client delivery

- Balances are saved in the UserState kind `ItemBalanceUserState` (list kind). The fields are `int64 id` (item ID value), `int64 amount`, `int64 recovery_started_at`, `int64 ends_at`, `string big_amount`. `amount` and `big_amount` are a big encoding pair of the contract. `recovery_started_at` of an item that is not a recovery item is 0. `ends_at` of an item that is not a timed item is 0, and `amount` of a timed item is 0. A group item has no row. For an item that is neither a recovery item nor a timed item, a row whose balance became 0 is deleted. The row of a recovery item is not deleted
- Balance changes go to the client in the UserState delta that `storage` makes. An out-of-request change goes as a pending delta
- history row: `seq` (integer that grows by 1 per row per user. Assigned in recording order starting from the largest value among that user's history rows + 1, or from 1 when there are no rows), `time` (request time), `user_id`, `item_id`, `delta` (applied signed integer), `balance_after`, `overflow` (amount that did not fit because of `max_amount`), `shortfall`, `source`, `ref`, `once_key`, `request_id` (`null` for an out-of-request change), `ends_at_after` (`ends_at` after the change for a timed item. 0 for any other item). When the absolute value of `delta`, `balance_after`, `overflow` or `shortfall` is more than 2^53−1, that column is 0 and the contract's big integer is written to the `string?` column `big_delta`, `big_balance_after`, `big_overflow` or `big_shortfall`. Otherwise that `big_` column is `null`
- A row of a `Convert` replacement grant has source `Overflow`, `ref` the decimal string of the overflowed item's ID value, `request_id` and `time` equal to those of the overflowed item's row, and `once_key` an empty string
- The history table is registered with `storage.register_table` with scope `user`, key `(user_id, seq)`, an expiry column, snapshot flag `false` and index `(user_id, time)`. `list_history` reads by time range on this index. The `once_key` table is registered with scope `user`, an expiry column and snapshot flag `true`, so that it goes into the user snapshot clone with the balances. Rows older than `item-ledger.historyRetentionMs` are deleted by the expiry cleanup of `storage`

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_item_change` | change order step 4. `revoke_items` does not call it | ctx, change source, list of elements, one per item, each `item_id` (item ID value), `before` (balance before the change), `after` (balance after the change) | `pass` or `GameError` | `pass` |
| `after_item_change` | change order step 6, and after the save of `revoke_items` | ctx, change source, list of elements, one per item, each `item_id` (item ID value), `before` (balance before the change), `after` (balance after the change) | none | does nothing |

- In both hooks, the balance before the change is the balance after recovery application. Recovery application by itself does not call the hooks
- The lists of both hooks also have `Convert` replacement items. Each item is in the list only once, and its balance after the change includes the replacement grants

- `validate_item_change` judges per-game holding conditions. e.g. a specific item can be held from account level 10
- The item-ledger operations that can be called inside `validate_item_change` and `after_item_change` are the read operations `get_balance`, `get_recovery`, `get_ends_at`, `check_items`, `preview_add_items`. Read operations answer with the balance saved at that point. In `validate_item_change` it is the balance before the change, in `after_item_change` the balance after the change
- Calling `add_items`, `subtract_items`, `exchange_items`, `revoke_items` or `set_balance` inside either hook leaves an error log and ends the operation that called the hook with `INTERNAL`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| input check failure | `INVALID_AMOUNT`, `UNKNOWN_ITEM`, `UNSUPPORTED_ITEM` | set by content | `error` log |
| balance not enough | `NOT_ENOUGH` | set by content | none |
| more than `max_amount` | `LIMIT_EXCEEDED` | set by content | none |
| validation hook rejection | `REJECTED` | the hook's `GameError` | none |
| duplicate `once_key` | `ALREADY_APPLIED` | none. Not a failure | `info` log |
| source `Recovery` or `Overflow` passed by a caller | none. Throws, and the request is `INTERNAL` | `INTERNAL` | `error` log |
| `once_key` passed by content code that starts with a core `once_key` prefix | none. Throws, and the request is `INTERNAL` | `INTERNAL` | `error` log |
| call of `add_items`, `subtract_items`, `exchange_items`, `revoke_items` or `set_balance` inside `validate_item_change` or `after_item_change` | none. The operation that called the hook ends with `INTERNAL` | `INTERNAL` | `error` log |

- When a core module's request fails through these operations, it responds with `ITEM_NOT_ENOUGH` for `NOT_ENOUGH`, `ITEM_LIMIT_EXCEEDED` for `LIMIT_EXCEEDED`, the hook's `GameError` for `REJECTED`, and `INTERNAL` for the rest

Added `CoreError`: `ITEM_NOT_ENOUGH`, `ITEM_LIMIT_EXCEEDED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `item-ledger.historyRetentionMs` | integer | core | content | duration for which history and `once_key` are kept |
| `item-ledger.bigMaxDigits` | integer | core | content | upper bound of `max_digits` of `item_big`. 16 or more |

## data

`data/tables/item.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `type` | `enum<ItemType>` | `All` |
| `max_amount` | `long` | `All` |
| `overflow` | `enum<ItemOverflow>` | `All` |

- `type` is not used in judgements; content uses it for classification
- `max_amount` is at least 1 and at most 2^53−1. Outside that range the server does not start
- A new user's item grant is done by content's new user request with `add_items`. Only the first balance of a recovery item is set by `initial_amount` of `item_recovery`

`data/tables/item_overflow.csv`: replacement grant rules of items whose `overflow` is `Convert`.

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `convert_to` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |

- `id` is an ID name of the `item` table. `ref_missing` when it is not there
- `convert_to` is the items and amounts to give per 1 of overflowed amount
- data check. On a violation the server does not start
  - `required_missing` when an item whose `overflow` is `Convert` has no row
  - `out_of_range` when the `overflow` of the row's item is not `Convert`
  - `empty_required` when `convert_to` is an empty array
  - `cycle` when an item in `convert_to` is the row's item itself
  - `out_of_range` when the `overflow` of an item in `convert_to` is `Convert`

`data/tables/item_recovery.csv`: recovery rules of recovery items. An item with a row in this table is a recovery item.

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `recovery_interval` | `duration` | `All` |
| `recovery_amount` | `long` | `All` |
| `recovery_cap` | `long` | `All` |
| `cap_bonus_item` | `ref<item.id>?` | `All` |
| `initial_amount` | `long` | `All` |

- `id` is an ID name of the `item` table. `ref_missing` when it is not there
- `recovery_interval` is at least 1, `recovery_amount` is at least 1, and `recovery_cap` is at least 1 and at most the item's `max_amount`. When there is a `cap_bonus_item`, that item is not a recovery item, group item, timed item or big item, and `recovery_cap` + the `max_amount` of `cap_bonus_item` is at most the recovery item's `max_amount`. A violation is data check `out_of_range` and the server does not start
- `initial_amount` is the balance when the user has no balance row for the recovery item. It is at least 0 and at most the item's `max_amount`

`data/tables/item_group.csv`: group items and their member items.

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `members` | `array<ref<item.id>>` | `All` |

- `id` is an ID name of the `item` table. `ref_missing` when it is not there
- `members` is in subtraction order. It has 1 or more elements, with no duplicates. A member item is not the row's item itself, a recovery item, a group item, a timed item or a big item
- The `max_amount` of a group item is the sum of the member items' `max_amount` and is at most 2^53−1

`data/tables/item_timed.csv`: effect duration of amount 1 of a timed item.

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `duration` | `duration` | `All` |

- `id` is an ID name of the `item` table. `ref_missing` when it is not there
- `duration` is at least 1, and the item's `max_amount` × `duration` is at most 2^53−1. The item's `overflow` is `Reject` or `Discard`

`data/tables/item_big.csv`: digit count of big items.

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `max_digits` | `int` | `All` |

- `id` is an ID name of the `item` table. `ref_missing` when it is not there
- `max_digits` is at least 16 and at most `item-ledger.bigMaxDigits`. The item's `max_amount` is 2^53−1 and its `overflow` is `Reject` or `Discard`

item kind rule

- `out_of_range` when one item is in two or more of the tables `item_recovery`, `item_group`, `item_timed`, `item_big`
- The item of an `item_overflow` row and the items in `convert_to` are not group items, timed items or big items
- A cost column is an item column of a core table whose items are subtracted with `subtract_items`: `shop_product.cost`, `gacha_banner.single_cost`, `gacha_banner.multi_cost`, `gacha_banner.ticket_item`, `nickname_cost.cost`. A group item is not written in a core table item column other than a cost column. A timed item is not written in a cost column
- A violation of this section or of the rules of `item_group`, `item_timed`, `item_big` is data check `out_of_range` and the server does not start

item list column: the type of a column that holds several items and their amounts (e.g. cost, reward) is `array<{item_id: ref<item.id>, amount: long}>`. `shop`, `iap`, `ads-reward`, `ranking`, `rating`, `loot-table`, `gacha`, `mission`, `attendance`, `nickname` and content tables use it.

- data check: `value_type` when `item_id` repeats within one cell or `amount` is less than 1
- data check: `out_of_range` when `amount` is more than the amount limit of the item of that `item_id`
- An item list column is a list of `ItemAmount` in generated code, so it is the input of `check_items`, `add_items`, `subtract_items`, `exchange_items` as it is

`data/enums.csv`

| type | element |
|---|---|
| `ItemType` | `Currency`, `Goods` |
| `ItemOverflow` | `Reject`, `Discard`, `Convert` |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_balance` | ctx, item ID value, balance | `ItemChangeResult.OK` | `UNKNOWN_ITEM`, `INVALID_AMOUNT`, `UNSUPPORTED_ITEM` | content cheat handler, `SetItemBalance`, `testing` |
| `SetItemBalance` (core cheat). changes: `ItemBalanceUserState` | item ID value, balance | empty response. The changed `ItemBalanceUserState` in the delta | `INVALID_REQUEST` | `routing` DEV code. Sent by client `QACore`, bot, `testing` |

- `SetItemBalance` follows the processing order of `cheat`. The balance is read from the contract's big encoding pair `balance`, `big_balance`. `INVALID_REQUEST` when `big_balance` is neither an empty string nor a big integer. Calls `set_balance` for the access token's user; `INVALID_REQUEST` on `UNKNOWN_ITEM`, `INVALID_AMOUNT` or `UNSUPPORTED_ITEM`. The changed balance goes in that response's delta
- `set_balance` records with source `Cheat` and does not call the validation hook. It does check the balance range. For a recovery item it applies recovery and then changes the balance, and `recovery_started_at` follows the rule of S after the change. A group item is `UNSUPPORTED_ITEM`. For a timed item, the balance b is at least 0 and at most `max_amount`, and `ends_at` is written as request time + b × `duration`. When b is 0 the row is deleted
- STG and PROD builds have no `set_balance` and no `SetItemBalance`. A change called with source `Cheat` ends with `INTERNAL` in STG and PROD and leaves a `security` log (`reason` `cheat_source_closed`)

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SetItemBalanceRequest` | `item_id` | `int32` | `table`: `item` |
| `SetItemBalanceRequest` | `balance` | `int64` | `min`: 0, `max`: 2^53−1 |
| `SetItemBalanceRequest` | `big_balance` | `string` | `max_len_key`: `item-ledger.bigMaxDigits` |

## test

- On PostgreSQL, 50 or more `add_items` and `subtract_items` requests that one user sends concurrently to the test server, its peer and the peer process end with a response or `NOT_ENOUGH` (`NOT_ENOUGH` only for a subtraction with not enough balance), the accepted changes chain one by one from 0 to the final balance, no balance after any change is negative, and the final balance is the sum of the accepted changes
- Add, subtract and exchange change the balance, history, `ItemBalanceUserState` delta and the response's `item_changes` together
- A failed operation changes none of the balance, history and delta. The same when only one item of the list fails
- A balance does not go below 0. `NOT_ENOUGH` is returned
- When `overflow` is `Reject`, `LIMIT_EXCEEDED`; when `Discard`, sets the balance to `max_amount` and records the amount that did not fit in the history and in `overflow` of `ItemChange`
- When `overflow` is `Convert`, sets the balance to `max_amount` and adds overflowed amount × `convert_to` amount to the replacement items in the same operation. The overflowed item's `ItemChange` has `delta` the amount that went in and `overflow` the overflowed amount, and right after it comes the replacement item's `ItemChange` with source `Overflow` and `ref` the overflowed item ID value. The history also records `Overflow` rows with the same `request_id` and `time`
- When a `Convert` replacement item is `Reject` and the replacement grant makes it more than `max_amount`, the whole operation is `LIMIT_EXCEEDED` and nothing changes. When `Discard`, it is set to `max_amount`
- A `Convert` replacement item is in the lists of both hooks with the balance after the change including the replacement grant
- A second operation with the same `once_key` also makes no replacement grant
- For each of a `Reject`, `Discard` and `Convert` item and a `Discard` overflow of a replacement item, `preview_add_items` returns the `ItemAddPreview` element, `applied`, `overflow` and `replacements` equal to the `ItemChange` that `add_items` in the same ctx records, changes no balance, history, delta or `once_key`, and does not call the validation hook
- `preview_add_items` of a list in which one `Reject` item goes above `max_amount` has every row `Mailed`. An amount subtracted earlier in the same ctx is reflected in the preview's balance
- In `preview_add_items` that adds 2^53−1 to a `Convert` item whose balance is `max_amount`, for a replacement item element with `convert_to` `amount` 2, `overflow` `Discard` and balance 0, `applied` is that replacement item's `max_amount` and `overflow` is 2 × (2^53−1) − `max_amount`
- The server does not start when there is a `Convert` item with no `item_overflow` row, a row for an item that is not `Convert`, an empty `convert_to`, or the item itself or a `Convert` item in `convert_to`
- A second change with the same `once_key` is `ALREADY_APPLIED` and the balance stays the same
- When the validation hook returns a `GameError`, the result is `REJECTED` with that `GameError` and the balance stays the same
- Two concurrent requests of the same user each subtract from the same balance only once
- `add_items` and `exchange_items` called inside another module's content hook (e.g. `settle_live_event`) are applied, and `add_items`, `subtract_items`, `exchange_items`, `revoke_items` called inside `validate_item_change` or `after_item_change` end the operation that called the hook with `INTERNAL`
- `get_balance` and `check_items` called inside the two hooks answer with the balance before the change in `validate_item_change` and the balance after the change in `after_item_change`, and the operation that called the hook succeeds
- `revoke_items` does not take the balance below 0, returns the shortfall, and leaves for each revoked item an `audit` log with `item_id`, `revoked`, `shortfall`, `source`, `ref`, `once_key`, `actor`. When `admin-api` calls it, `actor` is the operator name; when `iap` calls it, `system`. Even when the server stops while a `storage.after_commit` function registered earlier in the same transaction is running, the `audit` log of the committed revocation remains
- A second `revoke_items` with the same `once_key` is `ALREADY_APPLIED` and the balance stays the same
- When `exchange_items` subtracts and adds the same item, that item's `ItemChange` and history row are one net change, and when the net change is 0 there is neither
- The balance change of an out-of-request change arrives in the pending delta of the next success response
- When a balance becomes 0, its `ItemBalanceUserState` row is deleted
- A direct write of `ItemBalanceUserState` from a content handler is rejected
- When `max_amount` is out of range, the server does not start
- History past the retention duration is deleted
- `list_history` returns the rows in the time range in ascending order of `seq`. Even when rows with the same `time` are cut off at the max row count, the next call with the last row's `seq` as the cursor returns the remaining rows, each exactly once, with none missed
- In STG and PROD, a change with source `Cheat` ends with `INTERNAL`
- A recovery item does not grow at the time just before a `recovery_interval` boundary and grows by `recovery_amount` at the boundary time. When several intervals pass, it grows that many times and stops at `recovery_cap`
- A recovery item at `recovery_cap` or more does not grow as time passes. `add_items` adds above `recovery_cap` up to `max_amount`
- Even when `recovery_cap` in data becomes less than the saved A, the balance after time passes is A and does not shrink
- Subtracting from a recovering item continues the interval in progress, and subtracting from at least the cap to less than the cap starts an interval from that request time
- Recovery application records source `Recovery` history and is not in `item_changes`. At a time when only recovery happened there is no delta
- An operation whose list and `Convert` replacement grants do not have a recovering recovery item records no recovery application for that item and does not change its saved A and S. When that item is a `Convert` replacement item, recovery application is done
- The balance of a recovery item with no row is `initial_amount`; when `initial_amount` < `recovery_cap`, recovery starts from the user's creation time; and the row of a recovery item whose balance became 0 remains
- In `get_recovery`, the next recovery time and the time the cap is reached equal the time at which `get_balance` at that time first grows and the time at which it becomes `recovery_cap`
- The balance of a recovery item with a `cap_bonus_item` grows over time up to `recovery_cap` + the bonus item balance and stops there. After an `add_items` that adds the bonus item of a recovery item that reached C and has S 0, that recovery item's S is the request time and recovery continues, and that recovery item's `ItemBalanceUserState` arrives in the same response delta. When subtracting the bonus item of a recovering recovery item makes its balance at least C after the change, S is 0 and it does not grow as time passes
- For each case of the core test fixture `item-recovery` (ID name of the recovery item, `cap_bonus_item` balance, saved A and S, time, expected balance and `get_recovery` result), `get_balance` and `get_recovery` equal the expected values. In a case whose saved S is not 0 and that reached C by time alone, `get_recovery` is `(0, 0)`. There is a case with a `cap_bonus_item` whose balance is 1 or more, in which the balance grows above `recovery_cap` up to C. The `UserStateCore` test uses the same fixture
- A call by a caller with source `Recovery` or `Overflow` is `INTERNAL`
- `add_items` called by content code with `once_key` `shop:1` throws, the request is `INTERNAL`, the balance, history and `once_key` table stay the same, and an `error` log is left. `shop:<request ID>` passed by `shop` is applied
- The `ItemChange` and history of `add_items` called by content code inside `storage.with_hook_change_source`(ctx, `LiveEvent`, `7:2`) have source `LiveEvent` and ref `7:2`, or the ref that content code passes when it passes one. Called outside, they have source `Request` and ref the request name
- The server does not start when a row violates the recovery column rules
- In DEV, `SetItemBalance` changes the balance to that value and carries the `ItemBalanceUserState` delta. An unknown item and an out-of-range balance are `INVALID_REQUEST`
- `get_balance` of a group item is the sum of the member item balances; subtracting a group item as another module's cost subtracts from member items in `members` order, with one `ItemChange` and one history row per member item. When the sum of member item balances is not enough, `NOT_ENOUGH` and nothing changes
- When the same list has a group item and its member item, the member item's amount is subtracted first, and that member item's `ItemChange` is one net change. `check_items` gives the same result as `subtract_items` of the same list
- Adding, revoking or `set_balance` of a group item is `UNSUPPORTED_ITEM` and nothing changes. A group item in a mail attachment is `INVALID_INPUT` of `send_mail`
- Adding a timed item during the effect extends the end time by n × `duration`; after the effect has ended, the end time is request time + n × `duration`. `get_balance` is 1 at end time − 1 and 0 at the end time, and `get_ends_at` is the end time, then 0 after it
- When a timed item's remaining duration would become more than `max_amount` × `duration`, `Reject` gives `LIMIT_EXCEEDED`, and `Discard` adds up to the amount that fits and records the rest as `overflow`. Subtracting is `UNSUPPORTED_ITEM`
- `revoke_items` of a timed item reduces the remaining duration and returns the amount beyond the remaining duration as shortfall
- For each case of the core test fixture `item-timed` (ID name of the timed item, saved `ends_at`, time, amount to add, expected `ends_at`, `delta`, `overflow`), `add_items` and `preview_add_items` equal the expected values. The cases have a timed item whose `overflow` is `Reject` and a timed item whose overflow is `Discard`. The `UserStateCore` test uses the same fixture
- For each case of the core test fixture `item-big` (ID name of the big item, saved balance, amount to add, expected `ItemAddPreview` element, `applied`, `overflow`, `add_items` result. Balance and amount are big integer strings), the row of `preview_add_items` and the result of `add_items` equal the expected values. The cases have an add whose balance goes above 2^53−1, an add set to 10^`max_digits` − 1 by `Discard`, and an add that is `Mailed` by `Reject` with `add_items` `LIMIT_EXCEEDED`. The `UserStateCore` test uses the same fixture
- Adding more than 2^53−1 to a big item makes the balance, `big_amount` of `ItemBalanceUserState`, `big_delta` of `ItemChange`, and `big_delta`, `big_balance_after` of the history that value, with `amount` and `delta` 0. When it comes back to 2^53−1 or less, the `big_` fields are empty strings
- Beyond the balance limit of a big item, `Reject` gives `LIMIT_EXCEEDED` and `Discard` sets it to 10^`max_digits` − 1. An amount more than 10^`max_digits` − 1 is `INVALID_AMOUNT`
- The server does not start when an item is in two kind tables, a member item is a group item, timed item, big item or recovery item, a group item is in a core table item column other than a cost column, a timed item is in a cost column, or a row has `max_digits` more than `item-ledger.bigMaxDigits`
- In DEV, `big_balance` of `SetItemBalance` changes the big item's balance to that value. A `big_balance` that is not a big integer is `INVALID_REQUEST`
