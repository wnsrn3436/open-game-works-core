# PaymentCore

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

Handles the store purchase flow, subscription purchase and restore, entitlement and pass lookup, product ownership judgement, and daily reward claim. Before a purchase it gets a check from the server `iap` module and recommends account link to a guest, sends the receipt of a purchased transaction to `iap` for verification and grant, and handles again the transactions it could not grant and the transactions it could not confirm with the store.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `UICore`, `NetworkCore`, `UserStateCore`, `AuthCore`

- server dependency: `iap`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_store_adapter` | store adapter | none | none | `BootstrapCore`(`InitModules`) |
| `is_supported` | none | whether there is a store adapter | `false` | content code |
| `prepare` | none | async operation. success flag | `false` | content code |
| `get_price` | product ID value | price string the store gave | empty string | content code |
| `purchase` | product ID value | async operation. `PurchaseResult` | `Rejected` | content code |
| `recover_purchases` | none | async operation. success flag, `RecoverySummary` | `false`, `RecoverySummary` with every count 0 | `BootstrapCore`(`AfterLogin`), content code |
| `restore_purchases` | none | async operation. success flag, `RecoverySummary` | `false`, `RecoverySummary` with every count 0 | `PaymentCore`, content code |
| `is_subscribed` | product ID value | whether there is an entitlement | `false` | content code |
| `get_subscription_ends_at` | product ID value | `ends_at` of `SubscriptionUserState` | `0` | content code |
| `get_pass_days_left` | product ID value | number of game days left on the pass | `0` | content code |
| `is_owned` | product ID value | whether the product is owned | `false` | `AdCore`, content code |
| `can_claim_daily` | product ID value | whether the daily reward can be received today | `false` | content code |
| `claim_daily` | product ID value | async operation. success flag | `false` | content code |
| `open_subscription_management` | none | async operation. success flag | `false` | content code |

- `set_store_adapter` is called before `init`. A call after `init` leaves an error log and is ignored
- `PurchaseResult`

  | element | meaning |
  |---|---|
  | `Success` | The grant is applied to UserState |
  | `Cancelled` | The user cancelled the guest warning or the store purchase |
  | `LinkRequested` | The user chose account link in the guest warning. No store purchase was made |
  | `Pending` | The store put the purchase on hold. Recovery handles it when the hold is released |
  | `StoreFailed` | `prepare` or the store purchase failed |
  | `VerifyFailed` | The verify result is `Invalid` |
  | `DeliveryPending` | The verification request failed. The transaction was not finished, and delivery retry handles it again |
  | `OtherAccount` | The verify result is `OtherUser`. The transaction belongs to another account, so it was not finished |
  | `Rejected` | A start condition or `CheckPurchase` stopped it, so no store purchase was made |
  | `AgeConfirmationRequired` | The `CheckPurchase` result is `AGE_CONFIRMATION_REQUIRED`. No store purchase was made |
  | `SpendLimitReached` | The `CheckPurchase` result is `IAP_SPEND_LIMIT_REACHED`. No store purchase was made |

- `RecoverySummary`: the counts, per verify result, of the transactions that went through transaction processing. Fields `granted`, `already_granted`, `invalid`, `other_user`, `pending`, `failed` are, in order, the number of transactions with verify result `Granted`, `AlreadyGranted`, `Invalid`, `OtherUser`, `Pending`, `Failed`. Skipped transactions are not counted

## behavior

### store and product

- store: `IapStore`(`APPLE`, `GOOGLE`) of base proto. A product is one row of the `iap_product` table that server `iap` owns, and the product's SKU is the `sku_apple` or `sku_google` cell for that store. A product whose SKU is an empty string is not sold in that store
- A transaction is referred to by the transaction ID the store gave it. Two transactions are the same transaction when their (store, transaction ID) is the same
- Server `iap` does the grant and the entitlement judgement
- PaymentCore sets the adapter key and the store adapter selection criterion, and `BootstrapCore` chooses with build info and passes the adapter with `set_store_adapter`

  | platform | store | build info `adapters` key |
  |---|---|---|
  | `ios`, `macos` | `APPLE` | `iap-apple` |
  | `android` | `GOOGLE` | `iap-google` |

  - When the value of that key is `fake`, the adapter is the fake adapter; with any other value it is the store adapter of that store. The store decides sandbox or not from the build's signing
  - When there is no key or the platform is `windows`, `linux` or `web`, there is no store adapter
- The product type is `Consumable`, `NonConsumable` or `Subscription` of `IapProductType`. A subscription renewal transaction is also one transaction

### store adapter

The store adapter wraps the store SDK. Handling that differs per store stays only inside the store adapter. Code outside PaymentCore does not call the store adapter.

| adapter operation | input | output |
|---|---|---|
| `connect` | none | async operation. success flag |
| `query_prices` | SKU list | async operation. success flag, price string per SKU (empty string when not received) |
| `buy` | SKU, product type, account token | async operation. One of `Success`, `Cancelled`, `Pending`, `Failed`, and the receipt when `Success` |
| `list_unfinished` | none | async operation. success flag, receipt list |
| `list_owned` | none | async operation. success flag, receipt list of `NonConsumable` products and of `Subscription` products the store considers valid |
| `finish` | receipt, product type | async operation. success flag |
| `open_subscription_management` | none | async operation. Whether the store's subscription management screen opened |

- receipt: store, SKU, transaction ID, receipt data. Receipt data is the purchase proof the store issued and is sent unchanged as the receipt of `VerifyPurchase` and `RecoverPurchase`. The format per store is the receipt of server [`iap`](../../server-core/modules/iap.md)
- Notifications the store adapter emits: disconnection, purchase update (one receipt). A purchase update is a transaction that ended outside `buy`. e.g. a transaction whose hold was released, a transaction bought outside the app
- account token: `account_token` of the `CheckPurchase` response. The store adapter passes it unchanged to the store purchase (Apple `appAccountToken`, Google `obfuscatedAccountId`). PaymentCore does not create or save the account token
- A store adapter operation other than `buy` (`connect`, `query_prices`, `list_unfinished`, `list_owned`, `finish`, `open_subscription_management`) fails when it does not end within `PaymentCore.storeCallTimeoutMs`. `buy` waits for user action, so it has no time limit
- `finish` of store `GOOGLE` returns success also for a transaction that server `iap` already consumed or acknowledged

### prepare

- processing order: `connect` → build the SKU table → price fetch. When `connect` and price fetch succeed, PaymentCore enters the ready state
- price fetch: calls `query_prices` with the SKUs of the SKU table
- The SKU table maps this store's SKUs to products. Empty SKUs are not added. When the SKU table is empty, there is no price fetch and the result is success
- A call in the ready state does not call the store and is `true`. When a `prepare` is in progress, it does not start a new one and returns that one's result
- On a disconnection notification, PaymentCore leaves the ready state. The next `prepare` connects again
- When an in-progress `prepare` gets a disconnection notification, that `prepare` does not set the ready state and ends with `false`
- `get_price` does not call the store and returns the price string that `prepare` received

### purchase

1. Start condition check. When one applies, the result is `Rejected` without a store purchase: no store adapter, not logged in (`AuthCore.is_logged_in`), a product not in `iap_product`, this store's SKU is an empty string, another `purchase` in progress
2. guest warning: when `AuthCore.list_linked_providers` returns 0 providers and some social provider has `AuthCore.is_provider_supported` `true`, opens the guest warning popup: `UICore.open_system_popup`, body `[payment_guest_warning]`, buttons `[payment_guest_link]`, `[payment_guest_continue]`, `[payment_guest_cancel]`, back button `[payment_guest_cancel]`. `[payment_guest_link]` returns `LinkRequested` and `[payment_guest_cancel]` returns `Cancelled`, without a store purchase. When only the hidden callback is called without a button callback, returns `Cancelled` without a store purchase. When the popup cannot open, error log and `Rejected`
3. When not in the ready state, runs `prepare`. When it fails, `StoreFailed`
4. Sends `CheckPurchase`(store, product ID value). When it ends in failure (error response, communication failure), ends without a store purchase
   - The failure callback returns `true` for `AGE_CONFIRMATION_REQUIRED` and `IAP_SPEND_LIMIT_REACHED`, and the results are `AgeConfirmationRequired` and `SpendLimitReached`. Content code does the display. Content code that receives `AgeConfirmationRequired` can call `AuthCore.prepare_consent`
   - For any other failure it returns `false` and the result is `Rejected`. The failure handling of `NetworkCore` does the display
5. Calls `buy` with `account_token` of the `CheckPurchase` response. Returns `Cancelled` and `Pending` as they are, and `Failed` becomes `StoreFailed`
6. When `buy` is `Success`, sends the receipt with `VerifyPurchase`(store, receipt data). The failure callback returns `true` for `IAP_VERIFY_UNAVAILABLE` and `false` otherwise
7. Acts per the table below by verify result and returns

| verify result | `finish` | `purchase` result |
|---|---|---|
| `Granted`, `AlreadyGranted` | Calls it. When it fails, the result is the same and that transaction stays an unfinished transaction | `Success` |
| `Invalid` | Calls it | `VerifyFailed` |
| `OtherUser` | Does not call it | `OtherAccount` |
| `Pending` | Does not call it | `Pending` |
| `Failed` | Does not call it. Delivery retry handles it again | `DeliveryPending` |

- verify result: `Granted` when `PurchaseStatus` of the `VerifyPurchase` or `RecoverPurchase` response is `GRANTED`, `AlreadyGranted` when `ALREADY_GRANTED`, `Invalid` when `INVALID`, `OtherUser` when `OTHER_USER`, `Pending` when `PENDING`. `Failed` when the request ends in failure (error response, communication failure)
- When `purchase` returns, the UserState delta of the response is already applied
- The failure handling of `NetworkCore` displays request failures. Content code decides the display of `StoreFailed`, `Pending`, `VerifyFailed`, `DeliveryPending`, `OtherAccount`. The screen opened after `LinkRequested` is option entry `account` of the `client-content` skill

### delivery retry

- When `purchase` returns `DeliveryPending`, calls `recover_purchases` after `PaymentCore.deliveryRetryDelayMs` of real elapsed time of `TimeCore`
- When there is a store adapter, after the first call of `recover_purchases`, calls `recover_purchases` on each `TimeCore.AppForegroundReturnedEvent`
- Content code can call `recover_purchases`. e.g. the retry button of a grant-pending notice

### recovery

- unfinished transaction: a transaction whose store purchase ended but whose `finish` has not succeeded. A transaction on hold is not an unfinished transaction
- `BootstrapCore` calls `recover_purchases` at `AfterLogin`, and delivery retry and content code also call it. When there is no store adapter, it does nothing and is `false` without a log. When not in the ready state, it runs `prepare` first, then handles the transactions of `list_unfinished` one by one. When `prepare` and `list_unfinished` succeed, it is `true`. The verify result per transaction does not change the success flag and is counted in `RecoverySummary`. When a `recover_purchases` is in progress, returns that one's result
- A purchase update notification received after the first call of `recover_purchases` handles that one transaction at once. A notification received before the first call is not handled. That transaction appears in `list_unfinished`
- When the store is `GOOGLE`, per login session, after the first `recover_purchases` that ends, PaymentCore calls `restore_purchases` once and does not use the result. PaymentCore detects a change of login session from `LoginCompletedEvent` and `SessionEndedEvent`, the same as for the `finish` success list
- transaction processing: verifies with `RecoverPurchase`(store, receipt data). The failure callback of `RecoverPurchase` returns `true` for every failure (warn log, no screen). That transaction is `Failed` and is handled again at the next recovery

  | verify result | `PurchaseRecoveredEvent` | `finish` |
  |---|---|---|
  | `Granted` | Emitted right after verification, before `finish` | Calls it |
  | `AlreadyGranted`, `Invalid` | Not emitted | Calls it |
  | `OtherUser`, `Pending`, `Failed` | Not emitted | Does not call it. Handled again at the next recovery time |

- skipped transaction: a SKU not in the SKU table (error log), an in-flight transaction, a transaction whose `finish` succeeded in the current login session. An in-flight transaction is looked at again at the next recovery time
- in-flight transaction: a transaction that falls under one of the below
  - a transaction whose transaction processing by recovery, `restore_purchases` or a purchase update notification started and has not ended
  - a transaction of an in-progress `purchase`. From the call of `buy` until `buy` returns, it is every transaction with this store's SKU of that `purchase`'s product, and after `buy` returns `Success` until `purchase` returns, it is the (store, transaction ID) of that receipt
- The `finish` success list keeps only (store, transaction ID) in memory. On `AuthCore.LoginCompletedEvent` or `SessionEndedEvent`, PaymentCore treats the login session as changed and empties the list
- When an async operation ends and the login session at its start has ended, the result is discarded: the list does not change, `finish` and events are not called, and the operation ends with the failure value
- `restore_purchases` handles the transactions of `list_owned` with the same transaction processing as recovery. When a `restore_purchases` is in progress, it does not start a new one and returns that one's result. For a `restore_purchases` that content code called, content code does the result display and the block during it
- subscription sync: after transaction processing, when `UserStateCore` holds one or more `SubscriptionUserState`, `recover_purchases` and `restore_purchases` send `SyncSubscriptions` with `send`. The failure callback returns `true`. A failure does not change the operation result

### subscription and pass

- The entitlement judgement applies the definition of server `iap` to the `SubscriptionUserState` cache in `UserStateCore`: `state` is `ACTIVE` or `GRACE_PERIOD`, `TimeCore.is_synced` is `true`, and `TimeCore.is_before_end`(`ends_at`) is `true`. When there is no row, `false`
- Today is `TimeCore.get_day_number`(`TimeCore.get_current_day`). A pass is a pass of server `iap` (a `Consumable` with `pass_days`)
- `get_pass_days_left`: for a pass, `pass_end_day` of `IapPurchaseUserState` in `UserStateCore` − today. `0` when `TimeCore.is_synced` is `false`, the value is less than 0, or the product is not a pass
- `is_owned`: `true` for `NonConsumable` when `UserStateCore.get_iap_purchase_count` is 1 or more, for `Subscription` when `is_subscribed`, for a pass when `get_pass_days_left` is 1 or more. `false` for any other product
- `can_claim_daily`: `true` when `daily_reward` of `iap_product` is not an empty array, there is a daily entitlement (`is_subscribed` for `Subscription`, `get_pass_days_left` 1 or more for a pass), and `daily_claimed_day` of `IapPurchaseUserState` differs from today
- `claim_daily`: sends `ClaimIapDaily`(product ID value) with `send`. The grant is applied through the UserState delta of the response. The failure handling of `NetworkCore` does the failure display
- `purchase` of a subscription product passes product type `Subscription` to `buy`. A renewal transaction arrives by purchase update notification and `list_unfinished` and is verified by the transaction processing of recovery
- `open_subscription_management`: `false` when there is no store adapter. Cancellation and payment method change happen in the store screen

### lifecycle

- `release` deletes the store adapter registration, the ready state, the SKU table, the prices, the in-flight transactions, the `finish` success list, whether `recover_purchases` has been called, whether `restore_purchases` of store `GOOGLE` has been called in the current login session, and the waiting delivery retry
- Receipt data and the account token are not written to the log. A transaction is referred to by store, SKU, transaction ID

### real adapter

| adapter key | real adapter |
|---|---|
| `iap-apple` | `iap-apple` |
| `iap-google` | `iap-google` |

## hook

none

## event

| event | when | payload |
|---|---|---|
| `PurchaseRecoveredEvent` | When the verify result of recovery or `restore_purchases` is `Granted` | `product_id`: ID value of the granted product |

## error

| condition | failure value | log |
|---|---|---|
| Start condition violation of `purchase`, except another `purchase` in progress | `Rejected` | error |
| `CheckPurchase` failure | `Rejected`, `AgeConfirmationRequired`, `SpendLimitReached` | `NetworkCore` writes it |
| `SyncSubscriptions` failure | operation result unchanged | `NetworkCore` writes it |
| Operation on a product not in `iap_product`, `is_subscribed` or `get_subscription_ends_at` on a product that is not `Subscription` | failure value | error |
| Another `purchase` in progress | `Rejected` | warn |
| `prepare`, `restore_purchases` without a store adapter | `false` | error |
| `recover_purchases` without a store adapter | `false` | none |
| `connect`, `query_prices` failure | `false` for `prepare`, `StoreFailed` for `purchase` | error |
| `query_prices` gives no price for a product in the SKU table | empty string for `get_price` | error once per product |
| `get_price` when not in the ready state or for a product not in the SKU table | empty string | error |
| `buy` is `Failed` | `StoreFailed` | error |
| verify result `Invalid` | `VerifyFailed` | error |
| `finish` failure | `Success` for `purchase` | error |
| `set_store_adapter` called after `init` | none | error |
| The guest warning popup cannot open | `Rejected` | error |
| verify result `OtherUser` | `OtherAccount`. The transaction is not finished | warn |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `PaymentCore.storeCallTimeoutMs` | integer | core | content | time limit of one store adapter operation other than `buy` |
| `PaymentCore.deliveryRetryDelayMs` | integer | core | content | duration from `DeliveryPending` until `recover_purchases` is called |
| `TimeCore.reachMarginMs` | integer | core | content | ms subtracted in the before-end-time judgement of `TimeCore`. Used for the expected times in tests |

## data

used table: `iap_product`

- Reads `id`, `type`, `sku_apple`, `sku_google`, `daily_reward`, `pass_days` of the `iap_product` table whose header server `iap` defines. For `daily_reward` it checks only whether it is empty. It does not read the grant contents, purchase limit, `spend_amount` or price. The displayed price comes from the store through `get_price`
- Server `iap` defines enum `IapProductType`

reserved string: `[payment_guest_warning]`, `[payment_guest_link]`, `[payment_guest_continue]`, `[payment_guest_cancel]`

reserved ID, reserved sound: none

## DEV

- The fake adapter works as the chosen store and shows no store screen. `connect`, `query_prices`, `list_*`, `finish` succeed, and the price string is the SKU itself. `buy` is `Success` when no next result is set
- A fake adapter transaction uses a new UUID v4 transaction ID per `buy`, and its receipt data has the format of the server `iap` fake adapter, `fake:<SKU>:<transaction ID>:<account token>`. The fake adapter controller of server `testing` sets the verify result
- A transaction that `buy` of the fake adapter created appears in `list_unfinished` until `finish` succeeds

| operation | input | output | caller |
|---|---|---|---|
| `fake_set_next_buy_result` | one of `Success`, `Cancelled`, `Pending`, `Failed` | none. Used for the next single `buy` | core test |
| `fake_hold_buy` | hold flag | none. While `true`, `buy` creates the transaction, puts it in `list_unfinished` and does not return. A call with `false` makes the held `buy` return `Success` and the receipt of that transaction | core test |
| `fake_set_fail` | adapter operation name, fail flag | none | core test |
| `fake_add_unfinished` | product ID value, account token | none. Adds one transaction to `list_unfinished` | core test |
| `fake_complete_pending` | none | none. Emits a purchase update notification for each transaction on hold | core test |
| `fake_renew_subscription` | product ID value | none. Emits a purchase update notification with receipt data `fake:<SKU>:<transaction ID>:<account token>:<original transaction ID>`, whose original transaction ID is the first fake transaction ID of that product and whose transaction ID is a new UUID v4 | core test |

## test

- An `open_subscription_management` that does not end is `false` at `PaymentCore.storeCallTimeoutMs`
- When `RecoverPurchase` of background recovery is `IAP_VERIFY_UNAVAILABLE`, there is one warn log and no screen, and the next recovery handles that transaction again

- `purchase` calls `CheckPurchase`, `buy`, `VerifyPurchase` in that order, and the account token `buy` receives is `account_token` of the `CheckPurchase` response
- When `CheckPurchase` fails, the result is `Rejected` without `buy`
- For each verify result, whether `finish` is called and the `purchase` result match the purchase table
- When `buy` is `Cancelled`, `Pending`, `Failed`, the result is `Cancelled`, `Pending`, `StoreFailed` respectively, without a verification request
- When the verify result is `Failed`, the result is `DeliveryPending` without `finish`, and the `recover_purchases` after `PaymentCore.deliveryRetryDelayMs` verifies that transaction and calls `finish` on it. After the first call of `recover_purchases`, each return to the foreground calls `recover_purchases` once
- When the verify result is `OtherUser`, the result is `OtherAccount` without `finish`, and recovery also has no `finish` and no event
- When there is no linked provider and there is a usable social provider, one guest warning popup opens before `CheckPurchase`. `[payment_guest_link]` gives `LinkRequested`, and `[payment_guest_cancel]`, back input and closing by `UICore.close_all_popups` give `Cancelled`, all without `CheckPurchase` and `buy`. `[payment_guest_continue]` continues the purchase. When there is a linked provider or no usable social provider, there is no popup
- When `finish` fails, the result is `Success` with an error log, and the next `recover_purchases` handles it again
- Each start condition violation gives `Rejected` and the log in the table, without `CheckPurchase` and `buy`
- When not in the ready state, `purchase` runs `prepare` first, and when `prepare` fails, the result is `StoreFailed` without `buy`
- Two concurrent calls of `prepare` call `connect` once, and both calls have the same result. In the ready state, `connect` is not called
- When the SKU table is empty, `prepare` is `true` without `query_prices`
- After a disconnection notification, `get_price` is an empty string, and the next `prepare` calls `connect` once
- When a disconnection notification arrives during a `prepare` that waits for price fetch, that `prepare` is `false` and not in the ready state even when price fetch succeeds
- With N unfinished transactions, `RecoverPurchase` is sent N times, and for each verify result the event and `finish` match the recovery table. The event of a `Granted` transaction is emitted once, before `finish`
- A purchase update notification before the first call of `recover_purchases` is not verified, and a notification after it is handled at once
- Even when a purchase update notification arrives for the same transaction as an in-flight transaction, verification happens once
- A `recover_purchases` called during a `buy` held by `fake_hold_buy`(`true`), and a `recover_purchases` called after `buy` returns and before the `VerifyPurchase` response, do not verify that transaction. The verification request of that transaction is one `VerifyPurchase`, there is no `PurchaseRecoveredEvent`, and `finish` happens once
- When a verification response of the previous login session ends in a new session, the list, `finish` and event do not change
- `restore_purchases` is `true` when `list_owned` succeeds, regardless of the verify result per transaction, and `false` without verification when it fails
- When the store is `GOOGLE`, a `restore_purchases` that content code calls while a `restore_purchases` called by PaymentCore is in progress does not call `list_owned` again and returns the same success flag and `RecoverySummary` as the one in progress
- When the store is `GOOGLE`, `list_owned` is called once after the first `recover_purchases` that ends after login, and one `RecoverPurchase` goes out per transaction of it. After the next `recover_purchases` in the same login session there is no `list_owned`. When the store is `APPLE`, there is no `list_owned` before content code calls `restore_purchases`
- `RecoverySummary` of `recover_purchases` and `restore_purchases` equals the counts per verify result of the transactions that went through transaction processing. Handling one `Granted` transaction and one `OtherUser` transaction gives `granted` 1, `other_user` 1, and 0 for the rest. Skipped transactions are not counted
- For each platform of the adapter selection criterion and each value of `iap-apple`, `iap-google`, the chosen adapter and store match the criterion
- After `release`, an `init` again without a store adapter gives `false` for `prepare` and `Rejected` for `purchase`
- Without a store adapter, `recover_purchases` is `false` with no store call, no request and no log, and after that `recover_purchases` is not called on `AppForegroundReturnedEvent`
- With the fake adapter and the server fake adapter, `purchase` is `Success` and the grant delta is applied
- The logs of the purchase and recovery tests have no fake receipt data string and no account token string
- When `CheckPurchase` is `AGE_CONFIRMATION_REQUIRED`, `IAP_SPEND_LIMIT_REACHED`, the result is `AgeConfirmationRequired`, `SpendLimitReached` without `buy` and without the default display of `NetworkCore`
- With the fake adapter, a subscription `purchase` is `Success` and `is_subscribed` is `true`, and it is `true` when server time is `ends_at` − `TimeCore.reachMarginMs` − 1 and `false` when it is `ends_at` − `TimeCore.reachMarginMs`
- After `fake_renew_subscription`, one `RecoverPurchase` goes out and `ends_at` moves later
- When there is a `SubscriptionUserState`, `recover_purchases` and `restore_purchases` send one `SyncSubscriptions` after transaction processing; otherwise they do not send it
- `can_claim_daily` is `false` on the game day the daily reward was claimed and at the next game day boundary + `TimeCore.reachMarginMs` − 1, and `true` at the next game day boundary + `TimeCore.reachMarginMs`. For a pass it is `false` from the game day of `pass_end_day`
- `is_owned` is `true` after a `NonConsumable` grant delta, and for a pass it is `true` while game days are left
