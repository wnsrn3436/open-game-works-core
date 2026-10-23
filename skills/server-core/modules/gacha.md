# gacha

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

Takes the cost on a banner defined in data, draws with `loot-table` and grants with `item-ledger`. Handles pity, the rate-up guarantee, the `MULTI` guarantee, disclosed rates calculated from the data that decides the draw, and draw records.

## dependency

- `loot-table`
- `item-ledger`
- `mailbox`
- `live-event`
- `storage`
- `server-time`
- `logging`
- `validation`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `DrawGacha` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `GachaPityUserState`, `content` | banner ID value, `GachaDrawMode`, whether to use a ticket | list of `GachaDrawResult`(in draw order), list of granted `ItemAmount`, whether the grant went by mail | `GACHA_BANNER_UNAVAILABLE`, `GACHA_BANNER_LOCKED`, `INVALID_REQUEST`, `CoreError` of `item-ledger`, `GameError` of the hook | `routing`. client content code sends it |
| `GetGachaRates` (core rpc, `silent`). changes: none | banner ID value | list of `GachaRateSection`, `pity_count`, `rate_up_guarantee`, `multi_count` | `INVALID_REQUEST` | `routing`. client content code sends it |
| `ListGachaHistory` (core rpc, `silent`). changes: none | banner ID value(0 is all), cursor `draw_seq`(0 starts from the latest row), maximum row count | list of `GachaHistoryEntry`. Descending order of `draw_seq`. When the cursor is 0, holds rows from the row with the largest `draw_seq`; otherwise holds only rows whose `draw_seq` is less than the cursor | `INVALID_REQUEST` | `routing`. client content code sends it |
| `get_pity` | ctx, banner ID value | `count`, `rate_up_guaranteed` | 0 and `false` for an unknown banner | content handler, hook |

- When `banner_id` of `ListGachaHistory` is not 0 and the handler does not find it in `gacha_banner` with `validation.has_table_id`, the result is `INVALID_REQUEST`
- `GachaDrawMode`: `SINGLE`(once), `MULTI`(`multi_count` of the banner times). A base proto enum
- `GachaDrawResult`: `repeated ItemAmount items`(items drawn in that round), `GachaDrawKind kind`, `bool rate_up`. A base proto message
- `GachaDrawKind`: `NORMAL`, `PITY`, `MULTI_GUARANTEE`. A base proto enum
- `GachaRateSection`: `GachaDrawKind kind`, `bool rate_up_guaranteed`, `repeated GachaRate rates`. `GachaRate`: `repeated ItemAmount items`, `int64 numerator`, `int64 denominator`, `bool rate_up`. Base proto messages
- `GachaHistoryEntry`: `int64 draw_seq`, `int64 drawn_at`, `int32 banner_id`, `int32 draw_index`, `GachaDrawKind kind`, `bool rate_up`, `repeated ItemAmount items`. A base proto message

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `DrawGachaRequest` | `banner_id` | `int32` | `table`: `gacha_banner` |
| `DrawGachaRequest` | `mode` | `GachaDrawMode` | none |
| `DrawGachaRequest` | `use_ticket` | `bool` | none |
| `GetGachaRatesRequest` | `banner_id` | `int32` | `table`: `gacha_banner` |
| `ListGachaHistoryRequest` | `banner_id` | `int32` | `min`: 0, `max`: 2^31−1 |
| `ListGachaHistoryRequest` | `cursor_draw_seq` | `int64` | `min`: 0, `max`: 2^63−1 |
| `ListGachaHistoryRequest` | `max_rows` | `int32` | `min`: 1, `max_key`: `gacha.maxHistoryRows` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `DrawGachaResponse` | `results` | `repeated GachaDrawResult` |
| `DrawGachaResponse` | `items` | `repeated ItemAmount` |
| `DrawGachaResponse` | `mailed` | `bool` |
| `GetGachaRatesResponse` | `sections` | `repeated GachaRateSection` |
| `GetGachaRatesResponse` | `pity_count` | `int32` |
| `GetGachaRatesResponse` | `rate_up_guarantee` | `bool` |
| `GetGachaRatesResponse` | `multi_count` | `int32` |
| `ListGachaHistoryResponse` | `entries` | `repeated GachaHistoryEntry` |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `list_gacha_history` | `user_id`, `from_at`, `to_at`, `after_seq`, `limit` | `entries`: up to `limit` draw records with `from_at` ≤ `drawn_at` < `to_at` and `draw_seq` greater than `after_seq`, in ascending order of `draw_seq` | `not_found`, `bad_request` | operator |

## behavior

- `once_key` prefix: `gacha:`

### pity state

- The pity state is saved in core UserState kind `GachaPityUserState`(list kind) of base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id`(pity owner banner ID value), `int32 count`(number of draws since the last time a pity tier was reached), `bool rate_up_guaranteed`(whether the next time a pity tier is reached is a guaranteed rate-up). When there is no row, it is `(0, false)`
- pity owner: the banner itself when the banner's `pity_banner` is `null`, otherwise the banner of `pity_banner`. Banners with the same owner share the pity state
- Reason it is UserState: the number of draws left until pity and whether a guarantee is set are public information shown to the user, and they are values decided from the user's own records, so they are not judgement values to hide. The client shows the remaining count with these values
- pity tier P: `pity_table` and every table reached from `pity_table` through `table`. `MULTI` tier G: `multi_guaranteed_table` and every table reached from it. A round reached a tier when the `tables` of that round's `LootResult` has a table of the tier

### draw order

`DrawGacha` processing order. A failure changes neither items, the pity state nor draw records.

1. sale condition check. `GACHA_BANNER_UNAVAILABLE` when `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the banner row) is `false`; otherwise `GACHA_BANNER_LOCKED` when `passed` of `validation.evaluate_requirement`(`requirement`) is `false`
2. count n: 1 for `SINGLE`, `multi_count` for `MULTI`. `INVALID_REQUEST` when `GachaDrawMode` is not `SINGLE` or `MULTI`, when it is `MULTI` and `multi_count` is `null`, or when a ticket is used and `ticket_item` is `null`
3. hook `validate_gacha_draw`
4. cost: `(ticket_item, n)` when a ticket is used; otherwise `single_cost` for `SINGLE` and `multi_cost` for `MULTI`. When it is not empty, `item-ledger.subtract_items`, source `Gacha`, `ref` is the decimal string of the banner ID value
5. Reads the pity state `(c, g)` of the pity owner
6. For round i = 1 to n, in order
   - table to roll and kind: when `pity_count` is set and c + 1 ≥ `pity_count`, `pity_table` and `PITY`. Otherwise, when it is `MULTI`, i = n, `multi_guaranteed_table` is set and no earlier round reached G, `multi_guaranteed_table` and `MULTI_GUARANTEE`. Otherwise `loot_table` and `NORMAL`
   - Calls `loot-table.roll` with count 1. When g is `true`, gives substitution list `(pity_table, rate_up_table)`
   - `rate_up`: `tables` has `rate_up_table`
   - pity update: when the round reached P, c = 0, and when `rate_up_guarantee` is `true`, g = the negation of `rate_up`. When it did not reach P, c = c + 1
7. grant list: the output of hook `grant_gacha_result` when it is registered, otherwise `loot-table.sum_items`(all round results)
8. When the grant list is not empty, `mailbox.grant_or_mail`, source `Gacha`, `ref` is the decimal string of the banner ID value, `once_key` is `gacha:<request ID>`, the template is reserved ID `[gacha_grant_mail]`, `args` is the empty list. When the result is `Mailed`, sets whether the grant went by mail to `true`
9. Saves the pity state and one draw record per round, and emits core analytics event `core_gacha_drawn` with `logging.track_core_event`
10. after hook `on_gacha_drawn`

- When `loot-table` fails, the result is `INTERNAL`
- Random is used only in step 6. A cost shortage ends before random is used
- A `DrawGacha` sent again with the same request ID returns the response that `idempotency` saved, so it does not draw again

### disclosed rates

- `GetGachaRates` calculates with `loot-table.get_rates`, on the same `loot_table` and `gacha_banner` rows of the server build data that `DrawGacha` rolls. There is no rate table for disclosure and no rates in client data. `weight` has build target `Server`, so it is not in client data
- Sections are emitted in the order below. A banner whose `rate_up_guarantee` is `true` emits two sections per kind, `rate_up_guaranteed` `false` and `true`, and the `true` section is calculated with substitution list `(pity_table, rate_up_table)`. Otherwise one `false` section
  1. `NORMAL`: `loot_table`
  2. `PITY`: `pity_table`. Only when `pity_count` is set
  3. `MULTI_GUARANTEE`: `multi_guaranteed_table`. Only when `multi_count` is set and `multi_guaranteed_table` is set
- A `GachaRate` is one `LootRate`. `rate_up` is `true` when `path` has an entry of `rate_up_table`
- `pity_count`(0 is no pity), `rate_up_guarantee` and `multi_count`(0 is no `MULTI`) are values of the banner row. The client gets these values with `GetGachaRates` and the pity state with `GachaPityUserState`

### draw record

- draw record: the record row of one draw round. Its columns are `user_id`, `draw_seq`(`int64`. An integer that increases by 1 per round per user. Assigned in round order from the largest value among that user's draw records + 1, or from 1 when there is no draw record), `drawn_at`(request time), `request_id`, `banner_id`(`int32`), `draw_index`(`int32`. From 1), `kind`(element name of `GachaDrawKind`), `rate_up`, `items`(the round result. proto3 JSON text of the `ItemAmount` list), `pity_count_before`(`int32`. c before the round), `cost`(the step 4 cost, only in the `draw_index` 1 row. The empty list in the others. Same format as `items`), `data_version`(ctx `data_version` of `storage`), `expires_at`
- The draw record table is registered with `storage.register_table` with scope `user`, key `(user_id, draw_seq)`, expiry column `expires_at`, snapshot flag `true`, index `(user_id, banner_id, draw_seq)`, `(user_id, drawn_at)`. `expires_at` is `drawn_at` + `gacha.historyRetentionMs`
- `ListGachaHistory` returns only the draw records of the requesting user
- The `user_target` of `list_gacha_history` is `user_id`. It only reads, in the target user's transaction that `admin-api` opened, and returns one object per row keyed by column name. `items` and `cost` are not JSON text but that JSON array

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_gacha_draw` | draw order step 3 | ctx, banner ID value, count n | `pass` or `GameError` | `pass` |
| `grant_gacha_result` | draw order step 7 | ctx, banner ID value, list of `LootResult` | `pass` and a list of `ItemAmount` to grant, or `GameError` | grants `sum_items` of the results |
| `on_gacha_drawn`(after hook) | draw order step 10 | ctx, banner ID value, `GachaDrawMode`, list of `GachaDrawResult`(in draw order) | none | does nothing |

- `grant_gacha_result` turns drawn items into content's grant. e.g. turns a character item the user already owns into a fragment item, and content makes the character UserState. The output list follows the input check of `item-ledger`
- The draw records and the `GachaDrawResult` of the response are the drawn result regardless of the hook
- `on_gacha_drawn` does content's aggregation after a successful draw. e.g. `mission` `add_progress` for a mission that counts draws

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| outside the active window | `GACHA_BANNER_UNAVAILABLE` | `GACHA_BANNER_UNAVAILABLE` | none |
| `passed` of `evaluate_requirement` is `false` | `GACHA_BANNER_LOCKED` | `GACHA_BANNER_LOCKED` | none |
| `MULTI` on a banner without `multi_count`, ticket use on a banner without a ticket, maximum row count out of range, `ListGachaHistory` banner not in `gacha_banner` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `GachaDrawMode` that is not `SINGLE` or `MULTI` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| cost shortage | failure of `item-ledger` | error rules of `item-ledger` | none |
| hook rejection | `GameError` of the hook | `GameError` of the hook | none |
| `loot-table` failure, mail grant failure | `INTERNAL` | `INTERNAL` | error rules of `loot-table` and `mailbox` |
| `list_gacha_history` of a user that does not exist or a withdrawn user, body rules violation of `list_gacha_history` | `not_found`, `bad_request` | none | error rules of `admin-api` |

Added `CoreError`: `GACHA_BANNER_UNAVAILABLE`, `GACHA_BANNER_LOCKED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `gacha.historyRetentionMs` | integer | core | content | duration a draw record is kept |
| `gacha.maxHistoryRows` | integer | core | content | maximum row count of one `ListGachaHistory` |

## data

`data/tables/gacha_banner.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `loot_table` | `ref<loot_table.id>` | `All` |
| `single_cost` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `multi_count` | `int?` | `All` |
| `multi_cost` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `multi_guaranteed_table` | `ref<loot_table.id>?` | `All` |
| `ticket_item` | `ref<item.id>?` | `All` |
| `pity_count` | `int?` | `All` |
| `pity_table` | `ref<loot_table.id>?` | `All` |
| `rate_up_table` | `ref<loot_table.id>?` | `All` |
| `rate_up_guarantee` | `bool` | `All` |
| `pity_banner` | `ref<gacha_banner.id>?` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |
| `requirement` | `requirement` | `All` |

- The rate-up probability is set by `weight` in the `loot_table` data. `rate_up_table` is the rate-up target table and is used for the guarantee and the `rate_up` display
- `multi_count` is 2 or more. When `multi_count` is `null`, `multi_cost` is the empty array and `multi_guaranteed_table` is `null`
- When `multi_guaranteed_table` is set, at least one table of G is reached from `loot_table`, G does not contain `loot_table`, and when `pity_table` is also set, `pity_table` is in G
- `pity_count` and `pity_table` are both `null` or both set. `pity_count` is 1 or more. `pity_table` is reached from `loot_table`, and P does not contain `loot_table`. No table of P is reached from `loot_table` or `multi_guaranteed_table` through a path that does not pass `pity_table`
- When `rate_up_table` is set, `pity_table` is set and `rate_up_table` is in P. When `rate_up_guarantee` is `true`, `rate_up_table` is set
- When `pity_banner` is set, the `pity_banner` of that banner is `null`, and `pity_count`, `pity_table` and `rate_up_guarantee` equal those of that banner
- A violation of the `gacha_banner` rules is data check `out_of_range`, and the server does not start
- The game keeps the display order, background image and category of banners in an extension table

`data/enums.csv`: none. `GachaDrawMode` and `GachaDrawKind` are base proto enums

reserved ID: `[gacha_grant_mail]` → row of `mail_template`

## DEV

none

## test

- A draw subtracts the cost, grants the result, and changes the pity state and draw records. All four arrive in the delta and `item_changes`(source `Gacha`) of the same response
- When the cost is short, the result is `ITEM_NOT_ENOUGH`, and nothing changes, with no draw record and no `grant_gacha_result` call
- Ticket use subtracts n `ticket_item`. Ticket use on a banner without `ticket_item` and `MULTI` on a banner without `multi_count` are `INVALID_REQUEST`
- A `DrawGacha` whose `GachaDrawMode` is not `SINGLE` or `MULTI` is `INVALID_REQUEST`, and nothing changes
- Before `start_at`, from `end_at` on, and when the linked live event is not active, the result is `GACHA_BANNER_UNAVAILABLE`
- With a fixed seed, the round after `pity_count` − 1 rounds that do not reach P is `PITY` and rolls `pity_table`. On reaching P, the count is 0
- On a `rate_up_guarantee` banner, after a pity tier hit that missed the rate-up, the next pity tier hit is `rate_up_table`, and after it g is `false`
- In `MULTI`, when the earlier rounds do not reach G, the last round is `MULTI_GUARANTEE`; when they did, it is `NORMAL`
- Two banners with the same `pity_banner` share the pity state
- The sections of `GetGachaRates` equal `loot-table.get_rates` called with the same data
- With a fixed seed, when the `loot_table` of a banner without pity is rolled N = 100000 times through the roll path of a draw (`loot-table.roll` with count 1 that `DrawGacha` calls in `SINGLE`, and its substitution list), the difference between the count per path and the `NORMAL` section rate × N is at most 2√N
- With a fixed seed, the item order produced by 1000 `SINGLE` `DrawGacha` on a banner without pity equals the order of rolling that banner's `loot_table` 1000 times through the same roll path with the same seed
- When the grant is `LIMIT_EXCEEDED`, the same list goes as a `[gacha_grant_mail]` mail and the cost is subtracted
- The output of `grant_gacha_result` is granted, and the draw records and `GachaDrawResult` are the drawn result
- A `DrawGacha` sent again with the same request ID is applied only once
- `ListGachaHistory` with cursor 0 returns only the caller's rows, from the row with the largest `draw_seq` in descending order of `draw_seq`; the next page after a cut in the middle of a `MULTI` draw continues from the remaining rounds; the rows of two `DrawGacha` with the same request time also arrive, each once and none missing; and rows past the retention period are deleted
- Banner 0 in `ListGachaHistory` returns the caller's rows of all banners, and a banner ID value not in `gacha_banner` is `INVALID_REQUEST`
- `list_gacha_history` works in the `admin-api` processing order, and a withdrawn user is `not_found`
- Even when `MULTI` draw records with the same `drawn_at` are cut at `limit`, the next `list_gacha_history` given the `draw_seq` of the last row as `after_seq` returns the remaining rounds, each once and none missing
- A direct write of `GachaPityUserState` by a content handler is rejected
- When there is a banner row that breaks the data rules, the server does not start
- `DrawGacha` of a user for whom `passed` of `evaluate_requirement`(`requirement`) is `false` is `GACHA_BANNER_LOCKED`, and nothing changes, with no draw record and no `grant_gacha_result` call
- A draw leaves core analytics event `core_gacha_drawn` for a user who allowed analytics
- `on_gacha_drawn` is called once per successful `DrawGacha` with that list of `GachaDrawResult`, and `mission.add_progress` called inside it comes in the delta of the same response. It is not called for a failed `DrawGacha`. When the hook throws, `DrawGacha` is `INTERNAL`, and the cost, the grant, the pity state and the draw records stay as they are
