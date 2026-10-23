# shop

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

Lets users buy and sell products defined in data with in-game items, and handles sale conditions (`start_at` and `end_at`, live event, unlock condition, offer), the purchase limit and the limit reset cycle. `iap` handles store payment products.

## dependency

- `item-ledger`
- `mailbox`
- `live-event`
- `offer`
- `validation`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `BuyShopProduct` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `ShopPurchaseUserState`, `content` | product ID value, quantity, `accept_loss` | list of granted `ItemAmount`, whether granted by mail | `SHOP_PRODUCT_UNAVAILABLE`, `SHOP_PRODUCT_LOCKED`, `SHOP_LIMIT_REACHED`, `SHOP_OVERFLOW_LOSS`, `INVALID_REQUEST`, `CoreError` of `item-ledger`, `GameError` of the hook | `routing`. Sent by client content code |
| `get_purchase_count` | ctx, product ID value | purchase count within the current limit period | none. 0 for an unknown product | content handler, hook |

- When `accept_loss` is `true`, the user buys even when some reward is discarded because it exceeds `max_amount`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `BuyShopProductRequest` | `product_id` | `int32` | `table`: `shop_product` |
| `BuyShopProductRequest` | `quantity` | `int32` | `min`: 1, `max`: 2^31−1 |
| `BuyShopProductRequest` | `accept_loss` | `bool` | none |

core `rpc` response field

| message | field | type |
|---|---|---|
| `BuyShopProductResponse` | `items` | `repeated ItemAmount` |
| `BuyShopProductResponse` | `mailed` | `bool` |

## behavior

purchase order. On failure, does not change items or the purchase count.

1. When the quantity is more than the product's `max_quantity`, or bundle × quantity is more than `item-ledger.amount_limit`, `INVALID_REQUEST`. Bundle × quantity multiplies each amount of the bundle by the quantity as `bigint`
2. sale condition check. When `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the product row) is `false`, or there is `offer` and `offer.is_offer_active` is `false`, `SHOP_PRODUCT_UNAVAILABLE`; when neither, and `passed` of `validation.evaluate_requirement`(`requirement`) is `false`, `SHOP_PRODUCT_LOCKED`
3. When there is `limit_count` and the purchase count of the current limit period + quantity > `limit_count`, `SHOP_LIMIT_REACHED`
4. hook `validate_shop_purchase`
5. When `cost` is not an empty array, `item-ledger.subtract_items`: the list is the `cost` bundle × quantity, source `Shop`, `ref` the decimal string of the product ID value
6. When `reward` is not an empty array, `item-ledger.preview_add_items`(`reward` bundle × quantity). When there is a `Discarded` row and `accept_loss` is `false`, `SHOP_OVERFLOW_LOSS`
7. When `reward` is not an empty array, `mailbox.grant_or_mail`: the list is the `reward` bundle × quantity, source `Shop`, `ref` the decimal string of the product ID value, `once_key` `shop:<request ID>`, template reserved ID `[shop_grant_mail]`, `args` an empty list. When the result is `Mailed`, sets whether granted by mail to `true`. `items` of the response is the list of granted `ItemAmount` of `grant_or_mail`
8. When `extra_grant` is `true`, hook `grant_shop_extra`
9. Saves the purchase count
10. after hook `on_shop_bought`
11. Emits core analytics event `core_shop_bought` with `logging.track_core_event`

- When `cost` is an empty array, the product is free; when `reward` is an empty array, there is no item reward. When there is a row whose `reward` is an empty array and `extra_grant` is `false`, the server does not start
- Exceeding `max_amount` does not block the purchase. `grant_or_mail` sends by mail a grant in which a `Reject` item overflows or that a validation hook rejected. An amount sent by mail is not a discarded amount
- The cost subtracted in step 5 is reflected in the preview balance of step 6. On a failure after step 5, the rollback of `storage` also reverts the cost subtraction of step 5
- `BuyShopProduct` sent again with the same request ID returns the response that `idempotency` saved, in the request processing order of `routing`, so the user does not buy twice

limit period

- The purchase count is saved in the core UserState kind `ShopPurchaseUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id`(product ID value), `int32 count`, `int64 reset_at`, `int32 event_round`
- `count`, `reset_at` and `event_round` of a purchase count row are read with `offer.read_purchase_limit`(`offer`, `reset`, `live_event` of the product, the values of the row). Client `UserStateCore.get_shop_purchase_count` reads them by the same rule
- When increasing the purchase count, writes `reset_at` as `write_reset_at` of `read_purchase_limit`. `count` does not increase beyond 2^31−1
- `server-time` decides the boundary of the reset cycle
- `once_key` prefix: `shop:`

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_shop_purchase` | purchase order step 4 | ctx, product ID value, quantity | `pass` or `GameError` | `pass` |
| `grant_shop_extra` | purchase order step 8 | ctx, product ID value, quantity | `pass` or `GameError` | when there is a `shop_product` row whose `extra_grant` is `true`, the server does not start |
| `on_shop_bought`(after hook) | purchase order step 10 | ctx, product ID value, quantity | none | does nothing |

- `validate_shop_purchase` judges per-game purchase conditions that cannot be written as `requirement` in data. e.g. a user who bought another product on the same game day cannot buy
- With `grant_shop_extra`, content grants rewards that are not items
- `on_shop_bought` does the content's counting after a successful purchase. e.g. `mission` `add_progress` for a mission that counts purchases

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| quantity out of range, bundle × quantity more than the amount limit | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| outside the active window, offer not active | `SHOP_PRODUCT_UNAVAILABLE` | `SHOP_PRODUCT_UNAVAILABLE` | none |
| `passed` of `evaluate_requirement` is `false` | `SHOP_PRODUCT_LOCKED` | `SHOP_PRODUCT_LOCKED` | none |
| purchase limit reached | `SHOP_LIMIT_REACHED` | `SHOP_LIMIT_REACHED` | none |
| cost short | failure of `item-ledger` | error rules of `item-ledger` | none |
| some reward is discarded and `accept_loss` is `false` | `SHOP_OVERFLOW_LOSS` | `SHOP_OVERFLOW_LOSS` | none |
| reward grant failure (failure of `grant_or_mail`) | `INTERNAL` | `INTERNAL` | error rules of `mailbox` |
| failure of `preview_add_items` in step 6 | `INTERNAL` | `INTERNAL` | error rules of `item-ledger` |
| hook rejection | `GameError` of the hook | `GameError` of the hook | none |
| a `shop_product` row whose `extra_grant` is `true` exists and there is no `grant_shop_extra` | server start failure | none | `error` log |

Added `CoreError`: `SHOP_PRODUCT_UNAVAILABLE`, `SHOP_PRODUCT_LOCKED`, `SHOP_LIMIT_REACHED`, `SHOP_OVERFLOW_LOSS`

## settings

none

## data

`data/tables/shop_product.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `cost` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `extra_grant` | `bool` | `All` |
| `max_quantity` | `int` | `All` |
| `limit_count` | `int?` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |
| `requirement` | `requirement` | `All` |
| `offer` | `ref<offer.id>?` | `All` |

- `max_quantity` is 1 or more, and `limit_count` is 1 or more
- When `reset` is `null` and there is no `offer`, the purchase count does not reset on a `ResetCycle` cycle. When there is `live_event`, it still follows the round reset of `live-event`
- When `limit_count` is `null`, `reset` is `null`
- When there is `offer`, `reset` is `null`. The purchase count counts from 0 each time the offer turns on
- The game keeps the display order, category tab and icon of products in an extension table
- `ResetCycle` is an enum of `server-time`

reserved ID: `[shop_grant_mail]` → row of `mail_template`

## DEV

none

## test

- A purchase subtracts the cost, adds the reward and increases the purchase count. All three come in the delta of the same response, and the `item_changes` source of the reward is `Shop`
- When the cost is short, `ITEM_NOT_ENOUGH`, and the purchase count stays unchanged
- A purchase of quantity 2 changes the cost and the reward by 2 times. A quantity more than `max_quantity` is `INVALID_REQUEST`
- When a user with balance 0 buys and the big item reward amount × quantity is more than 2^53−1 and at most the amount limit of that item, the purchase succeeds and `big_delta` of the reward `ItemChange` is that multiplied amount. When the multiplied amount is more than the amount limit of that item, `INVALID_REQUEST`, and nothing changes. When amount × quantity of an item that is not a big item is more than 2^53−1, `INVALID_REQUEST`
- `BuyShopProduct` with a product ID value that is not in `shop_product` is `INVALID_REQUEST`
- Before `start_at`, from `end_at` on, and when the linked live event is not active, `SHOP_PRODUCT_UNAVAILABLE`
- On reaching `limit_count`, `SHOP_LIMIT_REACHED`, and after the reset time the user buys again
- After a product with `limit_count` 1 bound to a `live_event` with `repeat` is bought in round 1, `get_purchase_count` between rounds is 1, and in round 2 the user buys again
- For a product without `offer`, with `reset` `null` and `limit_count` 1, the second purchase is `SHOP_LIMIT_REACHED` even after time passes, and the `ShopPurchaseUserState` row of the first purchase has `count` 1 and `reset_at` 0
- `reset_at` of the `ShopPurchaseUserState` row made by the first purchase of a `Daily`, `Weekly` or `Monthly` product is `server-time.get_next_reset`(`reset`, request time), and the purchase count right before and right after that time matches the reset rule
- When `validate_shop_purchase` returns `GameError`, nothing changes
- When `grant_shop_extra` returns `GameError`, the cost and the reward are also reverted
- When a `Reject` item of the reward exceeds `max_amount`, the purchase succeeds, the cost is subtracted, the whole reward list goes as a `[shop_grant_mail]` mail, `item_mails` of the response has one `ItemMail`, and whether granted by mail is `true`. Regardless of `accept_loss`
- When a `Discard` item or a `Convert` replacement item of the reward exceeds `max_amount`, `accept_loss` `false` is `SHOP_OVERFLOW_LOSS` and the cost, reward and purchase count stay unchanged. `accept_loss` `true` grants up to `max_amount`, and `overflow` of `ItemChange` has the discarded amount
- Even when a `Convert` item of the reward overflows, the user buys with `accept_loss` `false` when all the replacement items fit
- The purchase of a user for whom `passed` of `evaluate_requirement`(`requirement`) is `false` is `SHOP_PRODUCT_LOCKED`, and nothing changes
- After a `limit_count` 1 product of an offer bound to a `live_event` with `repeat` is bought in round 1, when that offer is turned on again in round 2 before the previous end time, the user buys that product again
- A product with `offer` is `SHOP_PRODUCT_UNAVAILABLE` when that offer is not active; when it is active, the user buys and `reset_at` is the end time of that offer. The purchase count after the offer turns on again starts from 0
- A successful purchase leaves core analytics event `core_shop_bought` for a user who allowed analytics, and a failed purchase does not
- `on_shop_bought` is called once per successful purchase with that product ID value and quantity, and the changes inside it come in the delta of the same response. It is not called for a failed purchase. When the hook throws, the purchase is `INTERNAL` and the cost, reward and purchase count stay unchanged
- When the cost and the reward have the same item, overflow is judged with the balance after the cost is subtracted
- A purchase sent again with the same request ID applies only once
- When a row violates the data rules, the server does not start
- When there is a `shop_product` row whose `extra_grant` is `true` and content does not register `grant_shop_extra`, the server does not start and an `error` log is left
