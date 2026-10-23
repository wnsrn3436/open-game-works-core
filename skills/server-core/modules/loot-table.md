# loot-table

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

This module draws results with ctx random from weighted reward tables defined in data, calculates the probability of each result from the same data, and gives the probabilities of public loot tables to the client. This module does not grant the drawn results; the caller grants them with `item-ledger`.

## dependency

- `storage`
- `item-ledger`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `roll` | ctx, loot table ID value, count, substitution list (optional) | `result` (`LootRollResult.OK`), `results` (list of `LootResult`. As many as the count, in draw order) | failure element of `LootRollResult` | content handler, hook, `gacha` |
| `sum_items` | list of `LootResult` | list of `ItemAmount` merged in ascending order of item ID value | `AMOUNT_OVERFLOW` | content handler, hook, `gacha` |
| `get_rates` | ctx, loot table ID value, substitution list (optional) | list of `LootRate` | an empty list and an `error` log for an unknown loot table ID value and for a substitution list that meets the `INVALID_INPUT` condition | content handler, hook, `gacha` |
| `GetLootRates` (core rpc, `silent`). changes: none | loot table ID value | list of `LootRate` | `INVALID_REQUEST` | `routing`. Sent by client content code |

- loot table ID value: an `id` value of `loot_table.csv`. The group of rows with the same `id` is one table
- substitution list: list of `[from loot table ID value, to loot table ID value]` arrays. Within one roll, when it is the turn to roll the from table, the to table is rolled instead. This also applies to the first table rolled. The substitution list is not applied again to a to table that replaced a table. `INVALID_INPUT` when the same from appears twice. `INVALID_INPUT` when, in the graph with the substitutions applied (per table, edges to the tables that its entries' `table` points to; an edge to a from table goes to the to table), following from the first table rolled returns to the same table. This check runs before rolling
- `LootResult`: the result of one roll
  - `tables`: the loot table ID values rolled. In roll order, and the same table can appear several times. When substituted, the to table is in it
  - `entries`: `LootPathEntry` of the drawn entries. In draw order
  - `items`: list of `ItemAmount` that merges the `items` of the drawn entries in ascending order of item ID value. Can be an empty list
- `LootRate`: the probability of one path from the first table rolled to one entry. A base proto message, carried by the `GetLootRates` response
  - `repeated LootPathEntry path`: list of the entries passed up to that entry. The last element is that entry. `LootPathEntry` is a base proto message with `int32 table_id` (loot table ID value), `int32 order`
  - `repeated ItemAmount items`: the `items` of that entry
  - `int64 numerator`, `int64 denominator`: the probability that the entry is drawn through that path in one roll. Not reduced to lowest terms
  - The list order is the depth-first order of the roll order

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `GetLootRatesRequest` | `loot_table_id` | `int32` | `table`: `public_loot_table` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetLootRatesResponse` | `rates` | `repeated LootRate` |

`LootRollResult`

| element | meaning |
|---|---|
| `OK` | drawn |
| `UNKNOWN_TABLE` | the table to roll or a table of the substitution list is not in `loot_table` |
| `INVALID_COUNT` | the count is less than 1 or more than `loot-table.maxRollCount` |
| `INVALID_INPUT` | the substitution list has the same from twice, or the graph with the substitutions applied has a cycle reachable from the first table |
| `AMOUNT_OVERFLOW` | in one `LootResult` or in the sum of `sum_items`, the amount of one item is more than `item-ledger.amount_limit` |

## behavior

### roll order

The order of rolling one table T. `roll` rolls the first table the given count of times in sequence, and makes one `LootResult` per roll.

1. When T is a from in the substitution list, replaces T with the to. Adds T to `tables`
2. Draws all entries whose `kind` is `Guaranteed`, in ascending order of `order`
3. When there are entries whose `kind` is `Weighted`, lays out their `weight` in ascending order of `order` and calls `storage.random_weighted` once to draw one entry
4. For each drawn entry, in draw order: adds it to `entries`, adds its `items` to the result, and when `table` is not `null`, rolls that table by this order. The next entry is handled after that table is fully rolled

- Random is used only in step 3. The same seed, the same data and the same input give the same result
- An entry whose `items` and `table` are both empty is a "nothing" result
- On failure, no result is returned. Random numbers used before the failure are not given back
- Sums of amounts in `items` and `sum_items` are calculated as `bigint`

### probability

- The probability of a path is the product of a value per entry of the path: `weight / weight sum of that table` for a `Weighted` entry, 1 for a `Guaranteed` entry. `numerator` is the product of the path's `weight` values, and `denominator` is the product of the weight sums of the tables that the path's `Weighted` entries belong to. A path with no `Weighted` entry is `1/1`
- `get_rates` calculates with the same rows of the same container and the same substitution rules as `roll`. The disclosed probability values and the values used for the judgement are not taken from different tables or different calculations
- When the same table is reached by several paths, each path comes out separately. The caller merges paths with the same `items` for display

### public loot table

- A public loot table is a loot table with a row in `public_loot_table`. A loot table that a paid random of `server-content` rolls is a public loot table
- `GetLootRates` returns the result of `get_rates` (no substitution list) of that loot table as `LootRate` in the same order. `weight` has build target `Server`, but the probabilities are disclosed through this response

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| unknown table | `UNKNOWN_TABLE` | set by the caller | `error` log |
| count out of range | `INVALID_COUNT` | set by the caller | `error` log |
| duplicate in the substitution list, cycle made by substitution | `INVALID_INPUT` | set by the caller | `error` log |
| sum of one item's amounts more than the amount limit | `AMOUNT_OVERFLOW` | set by the caller | `error` log |
| `GetLootRates` for a loot table that is not a public loot table | `INVALID_REQUEST` | `INVALID_REQUEST` | none |

- When a core module's request ends with one of these failures, it responds with `INTERNAL`

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `loot-table.maxRollCount` | integer | core | content | limit on the count of one `roll` |

## data

`data/tables/loot_table.csv`

| column | type | build target |
|---|---|---|
| `id` | `id` | `All` |
| `order` | `int` | `All` |
| `kind` | `enum<LootEntryKind>` | `All` |
| `weight` | `int` | `Server` |
| `items` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `table` | `ref<loot_table.id>?` | `All` |

- One row is one entry. The rows with the same `id` are one table
- When `kind` is `Weighted`, `weight` is at least 1; when `Guaranteed`, 0. A `Guaranteed` entry has at least one of `items` and `table` not empty. A violation is data check `out_of_range`
- Per table, the sum of `weight` of `Weighted` entries is at most 2^32. A violation is data check `out_of_range`
- Following `table` back to the same table is data check `cycle`
- The `denominator` of every path is at most 2^53−1. A violation is data check `out_of_range`
- The server does not start with data that violates the rules of `loot_table`
- The rules of the `items` column follow the item list column of `item-ledger`

`data/tables/public_loot_table.csv`: loot tables whose probabilities are disclosed

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |

- `id` is an ID name of `loot_table`. `ref_missing` when it is not there

`data/enums.csv`

| type | element |
|---|---|
| `LootEntryKind` | `Weighted`, `Guaranteed` |

`data/invariants.csv`

| kind | table | column | group | min | max | child_table | child_column |
|---|---|---|---|---|---|---|---|
| `order_column` | `loot_table` | `order` | `id` | | | | |

## DEV

none

## test

- The `roll` results of two requests given the same seed through `testing.send` are equal. The result with a fixed seed and fixed data equals the expected value calculated by hand with the random test vector of `UtilCore`
- `Guaranteed` entries are drawn in every roll, and only one `Weighted` entry is drawn per roll
- A nested `table` is rolled, and the order of `tables` and `entries` matches the roll order
- The to table is rolled instead of the from table of the substitution list, and `tables` has the to table. Substitution is not applied again to the to table
- For N = 100000 rolls with a fixed seed, the difference between each path's count and the `get_rates` probability × N is at most 2√N
- With data in which no table has a `Guaranteed` entry, the sum of the probabilities of the `get_rates` paths that end at an entry without `table` is 1. `get_rates` given a substitution list gives the probabilities calculated with the to table
- `sum_items` merges the same items and is in ascending order of item ID value. When the sum of a big item is more than 2^53−1 and at most that item's amount limit, the result is that sum; when the sum is more than that item's amount limit, `AMOUNT_OVERFLOW`. When the sum of an item that is not a big item is more than 2^53−1, `AMOUNT_OVERFLOW`. The same for a sum within one `LootResult` of `roll`
- An unknown table, an out-of-range count, a duplicate in the substitution list, and a substitution list under whose to table a path returns to the from table give a failure element of `LootRollResult` and an `error` log, and use no random
- With data that has a gap in `order`, a `weight` out of range, a cycle or a `denominator` over the limit, the data check gives an error and the server does not start
- `GetLootRates` returns the same paths, `items` and probabilities as `get_rates` of the public loot table, in the same order, and a loot table that is not a public loot table is `INVALID_REQUEST`
- A `public_loot_table` row with an ID name not in `loot_table` is data check `ref_missing`
