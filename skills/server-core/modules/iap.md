# iap

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

Verifies the receipt of a store payment with an adapter, and grants only once per store transaction. Handles recovery of incomplete purchases, refunds and subscription state changes that the store notifies, subscription entitlements, passes and daily rewards, sale conditions and purchase limit periods, monthly spend limits per age band, test transactions, and ownership transfer of store transactions bound to another user.

## dependency

- `item-ledger`
- `mailbox`
- `live-event`
- `offer`
- `validation`
- `storage`
- `idempotency`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `CheckPurchase` (core rpc). changes: none | `IapStore`, product ID value | account token | `IAP_PRODUCT_UNAVAILABLE`, `IAP_PRODUCT_LOCKED`, `IAP_LIMIT_REACHED`, `AGE_CONFIRMATION_REQUIRED`, `IAP_SPEND_LIMIT_REACHED`, `GameError` of a hook | `routing`. Client `PaymentCore` sends it |
| `VerifyPurchase` (core rpc, `retry`, `sensitive`). changes: `ItemBalanceUserState`, `MailUserState`, `IapPurchaseUserState`, `SubscriptionUserState`, `content` | `IapStore`, receipt | `PurchaseStatus`, product ID value, list of granted `ItemAmount` | `IAP_VERIFY_UNAVAILABLE`, `INVALID_REQUEST`, `INTERNAL` | `routing`. Client `PaymentCore` sends it |
| `RecoverPurchase` (core rpc, `silent`, `retry`, `sensitive`). changes: `ItemBalanceUserState`, `MailUserState`, `IapPurchaseUserState`, `SubscriptionUserState`, `content` | `IapStore`, receipt | same as `VerifyPurchase` | same as `VerifyPurchase` | `routing`. Client `PaymentCore` sends it |
| `SyncSubscriptions` (core rpc, `silent`, `retry`). changes: none | none | none. The changed `SubscriptionUserState` goes to the pending delta | `IAP_VERIFY_UNAVAILABLE` | `routing`. Client `PaymentCore` sends it |
| `ClaimIapDaily` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `IapPurchaseUserState`, `content` | product ID value | list of granted `ItemAmount` | `INVALID_REQUEST`, `IAP_DAILY_INACTIVE`, `IAP_ALREADY_CLAIMED` | `routing`. Client `PaymentCore` sends it |
| `POST /iap/notify/<store>` (route) | store server notification | HTTP status | HTTP status of the store notification rules | `routing`. The store server sends it |
| `get_purchase_count` | ctx, product ID value | purchase count of the current limit period | none | content handler, hook |
| `is_subscribed` | ctx, product ID value | `true` when there is an entitlement | `false` | content handler, hook |
| `is_pass_active` | ctx, product ID value | `true` when the pass is active | `false` | content handler, hook |
| `list_payments` | user ID | `payments` (list of payment records), `other_user_attempts` (list of `OTHER_USER` records whose requesting user is that user). Rows are objects keyed by column name | empty list | `admin-api` |
| `has_granted_payment` | ctx, user ID | `true` when that user's payment records include a record whose result is `GRANTED` and that is not a test transaction | `false` | `auth`(job `auth_guest_sweep`) |
| `prepare_verify_purchase` | user ID, `VerifyPurchaseRequest` or `RecoverPurchaseRequest` | async operation. Adapter verification result, store transaction info, subscription snapshot | `INVALID_REQUEST`, `IAP_VERIFY_UNAVAILABLE` | `routing` |
| `prepare_sync_subscriptions` | user ID | async operation. none | `IAP_VERIFY_UNAVAILABLE` | `routing` |
| `register_account_lookup` | `has_social_link`(DB handle, user ID → bool) | none | none. Calling it twice or not calling it is a server start failure | `auth` |
| `revoke_test_grant` | `operation_id`, `user_id`, `store`, `transaction_id` | empty object | `not_found`, `conflict` | operator |
| `remove_user` | ctx | none | none | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` below the minimum age, job `auth_guest_sweep`) |

- `IapStore`: `APPLE`, `GOOGLE`. An enum of base proto
- `revoke_test_grant` is an admin operation. iap exports it, and `routing` collects it and passes it to `admin-api`. Field types: `store` is `enum{APPLE, GOOGLE}`, and `transaction_id` is `string`
- receipt: a purchase proof string that the store issues. Its format differs per store, and the adapter parses it. For `iap-apple` and `iap-apple-sandbox` it is the signed JWS of a StoreKit 2 transaction or the decimal string of the transaction ID, and for `iap-google` it is the JSON string of `Purchase.getOriginalJson()`
- device receipt: a receipt for which the adapter confirmed that the purchasing device received it from the store. For `iap-apple` and `iap-apple-sandbox`, a signed JWS receipt that passes the same certificate chain verification as the store transaction info and whose `transactionId` is the verified transaction ID; for `iap-google`, every receipt; for the fake adapter, the receipt that the `testing.fake` controller decides
- `PurchaseStatus`: an enum of base proto

| element | meaning | client handling |
|---|---|---|
| `GRANTED` | granted by this request | ends the store transaction |
| `ALREADY_GRANTED` | a store transaction already granted. Includes a store transaction granted to another user | ends the store transaction |
| `INVALID` | a store transaction that grant order step 4 judged `INVALID`. Not granted | ends the store transaction |
| `OTHER_USER` | a store transaction that is bound to another user, is not yet granted to any user, and does not meet the ownership transfer condition. Not granted | does not end the store transaction |
| `PENDING` | the store has not finished the payment | keeps it as an incomplete purchase |

- `RecoverPurchase` is the request in which the client sends incomplete purchases and purchases to restore. The server handling is the same as `VerifyPurchase`; only the name in the request log differs

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `CheckPurchaseRequest` | `store` | `IapStore` | none |
| `CheckPurchaseRequest` | `product_id` | `int32` | `table`: `iap_product` |
| `VerifyPurchaseRequest` | `store` | `IapStore` | none |
| `VerifyPurchaseRequest` | `receipt` | `string` | `max_len_key`: `iap.maxReceiptBytes` |
| `RecoverPurchaseRequest` | `store` | `IapStore` | none |
| `RecoverPurchaseRequest` | `receipt` | `string` | `max_len_key`: `iap.maxReceiptBytes` |
| `ClaimIapDailyRequest` | `product_id` | `int32` | `table`: `iap_product` |

- `SyncSubscriptionsRequest` has no field

core `rpc` response field

| message | field | type |
|---|---|---|
| `CheckPurchaseResponse` | `account_token` | `string` |
| `VerifyPurchaseResponse` | `status` | `PurchaseStatus` |
| `VerifyPurchaseResponse` | `product_id` | `int32` |
| `VerifyPurchaseResponse` | `items` | `repeated ItemAmount` |
| `RecoverPurchaseResponse` | `status` | `PurchaseStatus` |
| `RecoverPurchaseResponse` | `product_id` | `int32` |
| `RecoverPurchaseResponse` | `items` | `repeated ItemAmount` |
| `ClaimIapDailyResponse` | `items` | `repeated ItemAmount` |

## behavior

- `once_key` prefix: `iap:`

### pre-purchase check

- The order that `PaymentCore` sends for one purchase is `CheckPurchase` → store purchase → `VerifyPurchase`. Incomplete purchases are sent with `RecoverPurchase`
- `CheckPurchase` checks the items below in this order
  1. When the store of the request does not sell the product (the SKU column of that store is an empty string, or game settings have no adapter of that store), `IAP_PRODUCT_UNAVAILABLE`
  2. sale condition check. When `live-event.is_in_active_window`(`start_at`, `end_at`, `live_event` of the product row) is `false`, or `offer` exists and `offer.is_offer_active` is `false`, `IAP_PRODUCT_UNAVAILABLE`; when neither, and `requirement` does not pass `validation.evaluate_requirement`, `IAP_PRODUCT_LOCKED`
  3. When `limit_count` exists and the purchase count of the current limit period ≥ `limit_count`, `IAP_LIMIT_REACHED`. For `Subscription`, when there is an entitlement and `auto_renew` is `true`, `IAP_LIMIT_REACHED`
  4. monthly spend limit check
  5. hook `validate_iap_purchase`
- The account token takes the HMAC-SHA256 of the decimal string of the user ID (key: the UTF-8 bytes of the value of the secret in game settings `environments.<ENV>.secrets.iapAccountToken`) and writes its first 16 bytes as a string in UUID format (lowercase hex, `8-4-4-4-12`). The same user always gets the same value. The client does not make this value, and passes the value of the `CheckPurchase` response unchanged to the store purchase (Apple `appAccountToken`, Google `obfuscatedAccountId`)
- When `CheckPurchase` passes step 5, in the same transaction it locks that account token row of `iap_account_token` with `storage.lock_game_row`, and when the row does not exist, writes an (account token, requesting user ID) row. Ownership transfer reads this row when it finds the owner user of a store transaction by account token
- `VerifyPurchase` does not check the sale condition, `limit_count` and the monthly spend limit again. A store transaction whose payment has finished is granted even when it exceeds a limit, and a `warn` log is left

### monthly spend limit

- The age band comes from `age_confirmed_at` and `age_to` of `ConsentUserState` read with `storage.get_state`. Whether the age band is below n follows the definition of `auth`
- When game settings `consent.ageConfirmation` is `true` and `age_confirmed_at` is 0, `AGE_CONFIRMATION_REQUIRED`
- That user's monthly spend limit is the smallest of the values of the keys (age n) of game settings `purchaseLimits.monthlyBelowAge` for which the age band is below n. When there is no such key, there is no limit
- When there is a limit and monthly spend + `spend_amount` of that product > limit, `IAP_SPEND_LIMIT_REACHED`
- monthly spend: the sum of `spend_amount` of that user's payment records whose result is `GRANTED`, that are not test transactions, and whose verification time is at least `server-time.get_period_start`(`Monthly`, request time) and less than `get_next_reset`(`Monthly`, request time)
- The unit of `spend_amount` is an integer in the smallest unit of the currency that the game decides. It is the same unit as the values of `purchaseLimits.monthlyBelowAge`
- Subscription renewals do not go through `CheckPurchase`. Renewal transactions also count in monthly spend

### grant order

`VerifyPurchase` and `RecoverPurchase` are handled in the order below. In the request prepare of `routing`, `prepare_verify_purchase` does steps 1 to 3 outside the transaction and passes the verification result to the handler. The handler does steps 4 to 9 in the request transaction.

1. When game settings have no adapter of that store, `INVALID_REQUEST`
2. Verifies the receipt with the adapter outside the transaction. The result is `VALID`, `INVALID`, `PENDING` or `FAILED`, with the store transaction info (transaction ID, original transaction ID, SKU, app ID, account token, purchase time, whether it is a test transaction, whether it is a device receipt). When the result is `VALID` and the SKU is a `Subscription` product, it then gets the subscription snapshot with the subscription status lookup of the adapter. The time limit of each of the two calls is `iap.verifyTimeoutMs`
3. `FAILED`, adapter call failure, time limit exceeded: does not grant, leaves an error log, and returns `IAP_VERIFY_UNAVAILABLE`. Leaves no payment record
4. Locks with `storage.lock_game_row`, in this order, `(store, transaction ID)` of `iap_payment`, `(store, latest transaction ID)` of `iap_payment` when there is a subscription snapshot and its latest transaction ID differs from the transaction ID, and `(store, original transaction ID)` of `iap_binding`. When the payment record of the transaction ID is a `GRANTED` or `REFUNDED` record of the requesting user, it skips the judgements below and step 5 and goes to step 6. Otherwise it judges the items below in this order
   - `INVALID` when any of the following holds: the adapter result is `INVALID`. The app ID differs from `appId` of game settings. The transaction ID is empty, is longer than `iap.maxTransactionIdLength`, or contains characters outside printable ASCII. The SKU is not in the `iap_product` rows of that store (error log). The `REFUNDED` payment record of the transaction ID belongs to another user (`security` log). It is a test transaction and the requesting user reached the test grant limit (`security` log)
   - store transaction of another user: the `GRANTED` payment record of the transaction ID or the binding of the original transaction ID belongs to another user, or the binding of the original transaction ID does not belong to the requesting user and the account token exists and differs from the requesting user's value. When the ownership transfer condition is met, it does ownership transfer. After that, a `NonConsumable` whose payment record was moved ends with `GRANTED`, and anything else continues to step 5. When the ownership transfer condition is not met, it leaves an `OTHER_USER` record, and ends with `ALREADY_GRANTED` without steps 5 to 9 when there is a `GRANTED` payment record of the transaction ID, otherwise with `OTHER_USER`. Ownership transfer and both of these leave a `security` log
   - When there is no account token, `INVALID`. Exception: regardless of store, when the binding of the original transaction ID belongs to the requesting user, it continues; when there is no binding and purchase time + `iap.withdrawnRecordRetentionMs` > request time, it binds the original transaction ID to the requesting user and continues. Examples of a store transaction without an account token: Google Play promo code redemption, Apple offer code redemption
5. When `PENDING`, does not grant and returns `PENDING`
6. When the payment record of the transaction ID is `GRANTED` or `REFUNDED`, for `Subscription` it does subscription apply with the subscription snapshot when there is one, and returns `ALREADY_GRANTED`
7. grant
   - When `reward` exists, `mailbox.grant_or_mail` with source `Iap`, `ref` the transaction ID, `once_key` the grant `once_key` of the store transaction, template reserved ID `[iap_grant_mail]`, and `args` an empty list
   - When `extra_grant` is `true`, hook `grant_iap_extra`. On `GameError`, reverts the whole grant, leaves an error log and returns `INTERNAL`. It leaves no payment record, so the client sends again
8. Leaves the payment record as `GRANTED`, raises the purchase count of `IapPurchaseUserState` by 1 with the limit period rules, and writes `reset_at` and `event_round` of the raised row to `reset_at` and `event_round` of the payment record. For a pass, extends `pass_end_day` with the pass rules. For `Subscription`, binds the original transaction ID to the requesting user and does subscription apply with the subscription snapshot. For a test transaction, leaves an `audit` log (`reason` `iap_test_grant`, store, transaction ID, product ID value). Emits core analytics event `core_iap_granted` with `logging.track_core_event`. Param `product_id` is the product ID value, `store` is the `IapStore` element name of the store, and `spend_amount` and `test` are `spend_amount` of the payment record and whether it is a test transaction. `renewal` is `true` when the product is `Subscription` and, among the `iap_payment` records with the same `(store, original transaction ID)` and a different transaction ID, there is one whose result is `GRANTED` or `REFUNDED`; otherwise `false`. Same transaction as 7
9. `GRANTED`

- The `INVALID` of step 4 leaves the payment record as `INVALID` only when the payment record of the transaction ID does not exist or is `INVALID`. When there is a `GRANTED` or `REFUNDED` record, it does not change that record. When the result is `INVALID` because the transaction ID is empty, is longer than `iap.maxTransactionIdLength` or contains characters outside printable ASCII, it leaves no payment record. `OTHER_USER` leaves no payment record
- `OTHER_USER` record: one row per `(store, transaction ID, requesting user ID)`, holding the owner user ID of the store transaction (0 when none), the product ID value and the verification time. When the same key ends with `OTHER_USER` again, the verification time changes
- Payment records are used for payment disputes and refund handling, the payment record retention obligation, and blocking reuse of store transactions, so they are kept for `iap.withdrawnRecordRetentionMs` after withdrawal too. The same holds for the binding of an original transaction ID and a user

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `iap_payment` | `game` | `store`(`IapStore` element name), `transaction_id`, `original_transaction_id`, `user_id`, `sku`, `product_id`, `spend_amount`(data value at grant), `purchased_at`(purchase time), `verified_at`(verification time. The request time of that request), `result`(`GRANTED`, `INVALID`, `REFUNDED`), `test`(whether it is a test transaction), `reset_at`(`reset_at` of the `IapPurchaseUserState` row at grant. 0 for a record that was not granted), `event_round`(`event_round` of that row at grant. 0 for a record that was not granted), `transfer_count`, `delete_at` | `(store, transaction_id)` | `delete_at` | `(user_id)`, `(store, original_transaction_id)` |
| `iap_binding` | `game` | `store`, `original_transaction_id`, `user_id`, `delete_at` | `(store, original_transaction_id)` | `delete_at` | `(user_id)` |
| `iap_subscription` | `game` | `store`, `original_transaction_id`, `user_id`, `product_id`, `state`(`SubscriptionState` element name), `ends_at`, `auto_renew`, `updated_at`, `delete_at` | `(store, original_transaction_id)` | `delete_at` | `(user_id, product_id)` |
| `iap_account_token` | `game` | `account_token`, `user_id`, `delete_at` | `account_token` | `delete_at` | `(user_id)` |
| `iap_other_user` | `game` | `store`, `transaction_id`, `user_id`(requesting user), `owner_user_id`, `product_id`, `verified_at`, `delete_at` | `(store, transaction_id, user_id)` | `delete_at` | `(user_id)` |

- The five tables hold payment records, bindings of original transaction ID and user, subscription records, the mapping of account token and user ID, and `OTHER_USER` records. They are registered with `storage.register_table`, and outside the store notification handling of a withdrawn user they are written inside a user transaction. The personal data user column is `user_id`
- There is one payment record per `(store, transaction ID)`. When the store transaction of an `INVALID` record comes again, that record is changed to the new result, requesting user and verification time
- `transfer_count` is the number of times ownership transfer step 1 changed the user of the payment record, and its first value is 0
- grant `once_key` of a store transaction: when there is no payment record of the transaction ID or `transfer_count` is 0, `iap:<store>:<transaction ID>`; when `transfer_count` is n, `iap:<store>:<transaction ID>:t<n>`. `<store>` is the element name of `IapStore`
- `delete_at` is null before withdrawal, so expiry cleanup does not delete the row
- `remove_user` writes `delete_at` of that user's payment records, bindings, subscription records, account token mappings and `OTHER_USER` records as request time + `iap.withdrawnRecordRetentionMs`, inside the user transaction of ctx
- Raw receipts, account tokens and raw store notifications are not left in logs or the DB

### store acknowledgement

- When the store is `GOOGLE` and the adapter is `iap-google`, after the commit of a `VerifyPurchase` or `RecoverPurchase` request that ended with `GRANTED` or `ALREADY_GRANTED`, it calls the purchase acknowledgement of the adapter on that store transaction outside the transaction with `storage.after_commit`. `Consumable` is consume, `NonConsumable` is acknowledge, and `Subscription` is subscription acknowledge. A store transaction already consumed or acknowledged counts as success
- The time limit of purchase acknowledgement is `iap.verifyTimeoutMs`. Failure and time limit exceeded only leave an `error` log and do not change the response. `finish` of client `PaymentCore` also confirms the same store transaction, so the next recovery confirms it again
- When the store is `APPLE`, there is no purchase acknowledgement

### test transaction

- A store transaction that the store marks as a test payment counts as a test transaction: a store transaction in the Apple sandbox environment, a store transaction whose `purchaseType` in the Google purchase info is test. It is granted in every environment, and the payment record keeps `true` for whether it is a test transaction
- test grant limit: when game settings `purchaseLimits.testGrants` is not `null`, a user has reached the limit when that user has `count` or more test transaction `GRANTED` payment records whose verification time is at least request time − `periodMs`. When `null`, there is no limit
- `revoke_test_grant`: `user_target` is `user_id`. In the out-of-request change of the target user that `admin-api` opens, it does record recheck with `(store, transaction_id)` and judges with the re-read payment record. When the payment record does not exist, its user is not the target user, or it is not a test transaction, `not_found`; when the result is not `GRANTED`, `conflict`. Otherwise, in the same change, it does steps 1 to 4 of the store notification `REFUND` processing order, and for `Subscription`, changes `state` of that subscription record to `REVOKED` and `ends_at` to request time, and does subscription recompute

### ownership transfer

- owner user B of a store transaction: the user of the `GRANTED` payment record of the transaction ID. When there is none, the user of the binding of the original transaction ID; when that is also missing, the user of the `iap_account_token` row of the account token. When none of the three exists, there is no B
- ownership transfer condition: B exists, the receipt is a device receipt, B is a withdrawn user or `has_social_link`(B) of `register_account_lookup` is `false`, and the product type is `NonConsumable` or `Subscription`, or the product type is `Consumable` and there is no `GRANTED` payment record of the transaction ID
- ownership transfer does the following in the transaction of requesting user A
  1. For `NonConsumable` with a `GRANTED` payment record of the transaction ID: changes the user of the payment record to A, raises `transfer_count` by 1, raises A's `IapPurchaseUserState` purchase count by 1, changes `reset_at` and `event_round` of the payment record to the values of A's raised row, and does grant order step 7. The `once_key` of step 7 is the grant `once_key` of the store transaction after the raise, and the `once_key` granted to B is the grant `once_key` of the store transaction before the raise. `reset_at` and `event_round` before the change are passed to step 5
  2. For `Subscription` with a binding of the original transaction ID: changes the user of the binding of the original transaction ID and of the subscription record to A, and does subscription recompute with (A, that product)
  3. Changes `delete_at` of the moved records to null
  4. `audit` log: `reason` `iap_transfer`, store, transaction ID, user ID of B
  5. When 1 or 2 moved a record and B is not a withdrawn user, opens B's out-of-request change (`storage.run_user_transaction`) after commit with `storage.after_commit`. For `NonConsumable`, deletes B's unclaimed grant mail with `mailbox.cancel_mail_by_once_key`(the `once_key` of grant order step 7 that granted the `reward` of that store transaction to B), calls hook `revoke_iap` with reason `transfer` and the revocation list, and lowers B's purchase count by 1. When comparing to decide whether to lower the purchase count, it uses `reset_at` and `event_round` that step 1 passed. For `Subscription`, does subscription recompute with (B, that product). Failure only leaves an `error` log

### purchase count, pass, daily reward

- The purchase count, pass and daily reward state are saved in core UserState kind `IapPurchaseUserState` (list kind) of base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id`(product ID value), `int32 count`(purchase count. The number granted within the current limit period minus the number refunded), `int64 reset_at`, `int64 pass_end_day`(number of the game day on which the pass ends. That game day is not in the pass period. 0 when none), `int64 daily_claimed_day`(number of the game day on which the daily reward was last claimed. 0 when none), `int32 event_round`
- Today is `server-time.get_day_number`(request time)
- limit period: `count`, `reset_at` and `event_round` of the row are read with `offer.read_purchase_limit`(`offer` and `reset` of the product, the `live_event` used for round reset, the values of the row). The `live_event` used for round reset is the product's `live_event` only for products whose `type` is `Consumable`; for `NonConsumable` and `Subscription` it is 0, so no round reset happens. When raising `count`, `reset_at` is written as `write_reset_at` of `read_purchase_limit`. When lowering `count`, it does not go below 0. Client `UserStateCore.get_iap_purchase_count` reads with the same rules
- The places that lower the purchase count (`REFUND` processing order step 3, ownership transfer step 5) lower the purchase count by 1 only when `reset_at` and `event_round` of that user's `IapPurchaseUserState` row read with the limit period rules equal `reset_at` and `event_round` of the payment record of that grant. When they differ, that grant belongs to a past limit period, so the purchase count does not change
- pass: a product whose `type` is `Consumable` and that has `pass_days`. On each grant, when `pass_end_day` is greater than today, it changes to `pass_end_day` + `pass_days`, otherwise to today + `pass_days`. While today < `pass_end_day`, the pass is active, and `is_pass_active` is this judgement
- daily entitlement: for `Subscription`, the entitlement; for a pass, the pass being active. Other products have none
- `ClaimIapDaily`: when `daily_reward` of the product is an empty array, `INVALID_REQUEST`; when there is no daily entitlement, `IAP_DAILY_INACTIVE`; when `daily_claimed_day` is today, `IAP_ALREADY_CLAIMED`. When it passes, grants `daily_reward` with `mailbox.grant_or_mail`(source `Iap`, `ref` `daily:<today>`, `once_key` `iap:daily:<product ID value>:<today>`, template `[iap_grant_mail]`, `args` empty list) and changes `daily_claimed_day` to today

### subscription

- One subscription is identified by `(store, original transaction ID)`. The original transaction ID stays the same on every renewal, and each renewal transaction gets a new transaction ID. The adapter decides what each store uses as the original transaction ID
- subscription snapshot: the current state of that subscription that the adapter looked up from the store. It holds `SubscriptionState`, the expiry time, `auto_renew`, the latest transaction ID, the SKU and purchase time of the latest store transaction, and whether it is a test transaction
- `SubscriptionState`: an enum of base proto

| element | meaning | `ends_at` |
|---|---|---|
| `ACTIVE` | within a paid subscription period | expiry time of the store |
| `GRACE_PERIOD` | the renewal payment failed, and the store keeps the use going for this period | end time of the grace period |
| `BILLING_RETRY` | the renewal payment failed, and the store retries the payment. No use | expiry time of the store |
| `EXPIRED` | expired | expiry time of the store |
| `REVOKED` | the store revoked the use. Includes refunds | time the store revoked it |

- entitlement: `state` of `SubscriptionUserState` is `ACTIVE` or `GRACE_PERIOD` and request time < `ends_at`. Request time is `server-time.now` and follows the cheat time offset of DEV. `is_subscribed` is this judgement
- subscription apply: in one user transaction, does the following with the subscription snapshot
  1. When the SKU of the latest store transaction is not a `Subscription` product row, leaves an error log and changes nothing
  2. When there is no payment record of the latest transaction ID, treats that store transaction as a new subscription period and does grant order steps 7 to 8. When step 7 fails, reverts the whole subscription apply
  3. Changes `state`, `ends_at` and `auto_renew` of the subscription record to the snapshot values, and the product ID value to the product of the latest store transaction SKU
  4. Does subscription recompute for the product before the change and for the product after the change
- subscription of another user: when the subscription record or the binding of its original transaction ID belongs to a user C who is not the user of the opened transaction (in the store notification handling of a withdrawn user, that withdrawn user), subscription apply, the subscription change of `revoke_test_grant`, and the subscription record change of `REFUND` of a withdrawn user change nothing in that transaction. Instead, after commit, with `storage.after_commit` it opens C's out-of-request change (`storage.run_user_transaction`), locks the binding and reads the subscription record again; then for `revoke_test_grant` it changes `state` of the subscription record to `REVOKED` and `ends_at` to request time and does subscription recompute with (C, that product), and otherwise does subscription apply with the looked-up subscription snapshot. When the re-read subscription record or binding does not belong to C or C is a withdrawn user, it changes nothing. Failure only leaves an `error` log
- subscription recompute(user, product): among that user's subscription records of that product, picks the one with the latest `ends_at` among the records with entitlement (`state` is `ACTIVE` or `GRACE_PERIOD` and `server-time.user_now` of that user < `ends_at`). When there is none, picks the one with the latest `ends_at` among all records. When `ends_at` is equal, the one first in byte order of `(store, original transaction ID)`. Writes the `SubscriptionUserState` row with `state`, `ends_at` and `auto_renew` of the picked record. When there is no record, deletes the row
- Subscription state is saved in core UserState kind `SubscriptionUserState` (list kind) of base proto. Only this module writes it, with `storage.put_core_state` and `delete_core_state`. field: `int64 id`(product ID value), `SubscriptionState state`, `int64 ends_at`, `bool auto_renew`
- `updated_at` of a subscription record is the request time of the transaction that wrote `state`, `ends_at` and `auto_renew` of that record. When written in a game transaction, it is `server-time.clock_now`
- `SyncSubscriptions`: in the request prepare of `routing`, `prepare_sync_subscriptions` does a subscription status lookup outside the transaction for each of that user's subscription records whose `state` is `ACTIVE`, `GRACE_PERIOD` or `BILLING_RETRY` and where `clock_now` ≥ `ends_at` or `updated_at` + `iap.subscriptionSyncIntervalMs` ≤ `clock_now`. For each record whose lookup succeeded, it opens that user's out-of-request change with one `storage.run_user_transaction` and does subscription apply with the looked-up subscription snapshot, and that change becomes a pending delta. When any lookup or subscription apply fails, `IAP_VERIFY_UNAVAILABLE`. The handler does not change the saved state
- The grant per subscription period is `reward` and hook `grant_iap_extra`. When a new subscription period starts, it grants once with grant order step 7

### store notification

- `<store>` of route `POST /iap/notify/<store>` is `apple` or `google`. `routing` collects it, and it does not go through the request processing order and access token authentication. When game settings have no adapter of that store, HTTP 404
- The body is read by accumulating the received bytes. When it exceeds `iap.notifyMaxBodyBytes` or the whole read duration exceeds `iap.notifyBodyReadTimeoutMs`, it is not handled, and HTTP 400
- The adapter checks the format of the notification, then verifies the signature and extracts the notification ID and kind. When the format is wrong, HTTP 400; when the signature is wrong, HTTP 403. When the notification ID is less than 1 byte or more than `idempotency.maxNotifyIdBytes`, HTTP 400
- The adapter maps the store's kind to the notification kinds below

| kind | example stores | extracted value |
|---|---|---|
| `REFUND` | Apple `REFUND`, Google voided purchase | transaction ID |
| `SUBSCRIPTION` | Apple `DID_RENEW`, `EXPIRED`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`, `REVOKE`, Google `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_IN_GRACE_PERIOD`, `SUBSCRIPTION_ON_HOLD`, `SUBSCRIPTION_RECOVERED`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_REVOKED` | original transaction ID |
| `OTHER` | kinds not listed above | none |

- A notification ID is handled only once with `idempotency.claim_notify` (source is the adapter name) in the same transaction as the handling. On `DUPLICATE`, HTTP 200 without handling
- subscription status lookup: when `REFUND`, the payment record of the transaction ID is `GRANTED` and its product is `Subscription`, with the original transaction ID of the payment record; when `SUBSCRIPTION` and there is a subscription record of the original transaction ID, with that original transaction ID; it does the subscription status lookup of the adapter outside the transaction. It runs before `claim_notify`, and a lookup failure is HTTP 500
- record recheck: in the transaction that store notification handling or `revoke_test_grant` opens, before changing anything, it locks `(store, transaction ID)` of `iap_payment` with `storage.lock_game_row` and reads the payment record again; then, when there is a subscription snapshot and its latest transaction ID differs from the transaction ID, it locks `(store, latest transaction ID)` of `iap_payment`, and it locks `(store, original transaction ID)` of `iap_binding` and reads the subscription record again. The lock order is the same as grant order step 4. The transaction ID is that transaction ID for `REFUND` and `revoke_test_grant`, and the latest transaction ID of the looked-up subscription snapshot for `SUBSCRIPTION`. The original transaction ID is the value of the re-read payment record for `REFUND` and `revoke_test_grant`, and the value of the notification for `SUBSCRIPTION`. Judgement uses the re-read values, not the values read outside the transaction
- When `REFUND` and the payment record of the transaction ID is `GRANTED`, it opens the out-of-request change of the user of that record with `storage.run_user_transaction` and does record recheck. When the re-read payment record is not `GRANTED`, it only does `claim_notify` and returns HTTP 200. When the user of the re-read payment record is not the user of that transaction, it changes nothing and returns HTTP 500. A notification that the store sends again is handled with the changed user. When neither holds, it follows the `REFUND` processing order below
  1. Deletes the unclaimed grant mail with `mailbox.cancel_mail_by_once_key`(the `once_key` of grant order step 7 that granted the `reward` of that store transaction to that user)
  2. hook `revoke_iap`(reason `refund`, revocation list)
  3. Changes the payment record to `REFUNDED` and lowers the purchase count of `IapPurchaseUserState` by 1. For a pass, subtracts `pass_days` from `pass_end_day`. Neither goes below 0. Emits core analytics event `core_iap_refunded` with `logging.track_core_event`. Params `product_id`, `store`, `spend_amount` and `test` are the values of the payment record
  4. `audit` log. `reason` is `iap_refund` for a store notification and `iap_test_grant_revoked` for `revoke_test_grant`
  5. When that product is `Subscription`, does subscription apply with the looked-up subscription snapshot
- When `SUBSCRIPTION` and there is a subscription record of the original transaction ID, it opens the out-of-request change (`storage.run_user_transaction`) of the user of the subscription record and does record recheck. When the user of the re-read subscription record is not the user of that transaction, it changes nothing and returns HTTP 500. Otherwise it does subscription apply with the looked-up subscription snapshot
- When that user is a withdrawn user and `run_user_transaction` returns `WITHDRAWN`, it does record recheck in one game transaction and makes the same judgement: a `REFUND` whose re-read payment record is not `GRANTED` only does `claim_notify` and returns HTTP 200, and when the user of the re-read payment record (`REFUND`) or subscription record (`SUBSCRIPTION`) is not that withdrawn user, it changes nothing and returns HTTP 500. Otherwise, in the same game transaction, it does `claim_notify` and the changes below and returns HTTP 200. It does no item revocation, purchase count change, new subscription period grant, or `SubscriptionUserState` change. `delete_at` of the changed rows stays as it is. As an exception, when `state` of the changed subscription record is `ACTIVE`, `GRACE_PERIOD` or `BILLING_RETRY`, it changes `delete_at` of that subscription record and of the binding of that original transaction ID to `server-time.clock_now` + `iap.withdrawnRecordRetentionMs`. While the store continues the payment, the binding remains, and another user can receive that subscription through ownership transfer
  - `REFUND`: changes the payment record to `REFUNDED`. When that product is `Subscription`, changes `state`, `ends_at` and `auto_renew` of the subscription record to the looked-up snapshot values
  - `SUBSCRIPTION`: changes `state`, `ends_at` and `auto_renew` of the subscription record to the looked-up snapshot values
- `OTHER`, no record, `REFUND` that is not `GRANTED`: HTTP 200 without handling. A `SUBSCRIPTION` without a subscription record is handled later by the client's `VerifyPurchase` or `RecoverPurchase`
- When the handling fails, it answers HTTP 500 so that the store sends again

### real adapter

| adapter key | real adapter |
|---|---|
| `iap-apple` | `iap-apple` |
| `iap-google` | `iap-google` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `purchase_history` | payment record | `iap-apple` | `app_functionality` | `true` | `false` | `false` | `true` | `ios`, `macos` | `none` |
| `purchase_history` | payment record | `iap-google` | `app_functionality` | `true` | `false` | `false` | `true` | `android` | `none` |

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_iap_purchase` | step 5 of `CheckPurchase` | ctx, product ID value | `pass` or `GameError` | `pass` |
| `grant_iap_extra` | grant order step 7. For a subscription, each new subscription period | ctx, product ID value, transaction ID | `pass` or `GameError` | when there is an `iap_product` row whose `extra_grant` is `true`, the server does not start |
| `revoke_iap` | `REFUND` processing order step 2, ownership transfer step 5 | ctx, product ID value, transaction ID, reason(`refund`, `transfer`), revocation list | none | when there is an `iap_product` row whose `extra_grant` is `true`, the server does not start. When there is no such row, revokes the revocation list with `item-ledger.revoke_items`. The source is `IapRefund` when reason is `refund` and `IapTransfer` when it is `transfer`, and `ref` is the transaction ID |

- When `revoke_iap` is registered, the default revocation does not run. When revocation is needed, the hook calls `revoke_items` inside it. The change source of item changes inside the hook is the same source and `ref` as the default revocation
- reason `refund` covers a refund and `revoke_test_grant`, and `transfer` covers a store transaction moved to another user by ownership transfer
- revocation list: the product's `reward` minus, per item ID value, the `ItemAmount` that the immediately preceding `cancel_mail_by_once_key` returned. Items that become 0 or less are left out. Items of the deleted mail did not reach the user, so they are not revoked

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| no store adapter, receipt size exceeded | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| verification failure, adapter failure, subscription status lookup failure | `IAP_VERIFY_UNAVAILABLE` | `IAP_VERIFY_UNAVAILABLE` | `error` log |
| store transaction of another user that does not meet the ownership transfer condition | `PurchaseStatus.ALREADY_GRANTED` when there is a `GRANTED` payment record of the transaction ID, otherwise `PurchaseStatus.OTHER_USER` | none | `security` log(`reason` `already_granted`, `other_user`) |
| purchase acknowledgement failure of `iap-google`, time limit exceeded | the response stays unchanged | none | `error` log |
| ownership transfer | `PurchaseStatus.GRANTED` for a `NonConsumable` whose payment record was moved, otherwise the result after step 5 | none | `security`, `audit` log(`reason` `iap_transfer`) |
| change failure of the previous user after ownership transfer, subscription change failure of another user | the result stays unchanged | none | `error` log |
| in record recheck of a store notification, the user of the re-read record is not the user of the opened transaction | HTTP 500. Changes nothing | none | none |
| `REFUND` notification whose payment record re-read in record recheck is not `GRANTED` | HTTP 200. Only does `claim_notify` | none | none |
| `REFUNDED` store transaction of another user, test grant limit | `PurchaseStatus.INVALID` | none | `security` log(`reason` `invalid`, field `cause` `refunded_other_user`, `test_grant_limit`) |
| `revoke_test_grant` of a store transaction that does not exist, does not belong to the target user or is not a test transaction, or of a store transaction that is not `GRANTED` | `not_found`, `conflict` | none | `audit` |
| unknown SKU | `PurchaseStatus.INVALID` | none | `error` log |
| product not sold, outside the sale condition | `IAP_PRODUCT_UNAVAILABLE` | `IAP_PRODUCT_UNAVAILABLE` | none |
| `passed` of `evaluate_requirement` is `false` | `IAP_PRODUCT_LOCKED` | `IAP_PRODUCT_LOCKED` | none |
| purchase limit reached, auto-renewing subscription with an entitlement | `IAP_LIMIT_REACHED` | `IAP_LIMIT_REACHED` | none |
| age confirmation is required and the age is not confirmed yet | `AGE_CONFIRMATION_REQUIRED` | `AGE_CONFIRMATION_REQUIRED` | none |
| monthly spend limit exceeded | `IAP_SPEND_LIMIT_REACHED` | `IAP_SPEND_LIMIT_REACHED` | none |
| no daily entitlement for `ClaimIapDaily` | `IAP_DAILY_INACTIVE` | `IAP_DAILY_INACTIVE` | none |
| `ClaimIapDaily` twice on the same game day | `IAP_ALREADY_CLAIMED` | `IAP_ALREADY_CLAIMED` | none |
| `grant_iap_extra` failure | `INTERNAL` | `INTERNAL` | `error` log |
| there is an `iap_product` row whose `extra_grant` is `true`, but no `grant_iap_extra` or no `revoke_iap` | server start failure | none | `error` log |

Added `CoreError`: `IAP_VERIFY_UNAVAILABLE`, `IAP_PRODUCT_UNAVAILABLE`, `IAP_PRODUCT_LOCKED`, `IAP_LIMIT_REACHED`, `AGE_CONFIRMATION_REQUIRED`, `IAP_SPEND_LIMIT_REACHED`, `IAP_DAILY_INACTIVE`, `IAP_ALREADY_CLAIMED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `iap.maxReceiptBytes` | integer | core | content | receipt byte length limit |
| `iap.maxTransactionIdLength` | integer | core | content | transaction ID length limit |
| `iap.verifyTimeoutMs` | integer | core | content | time limit of one receipt verification call or one subscription status lookup call |
| `iap.notifyMaxBodyBytes` | integer | core | content | maximum bytes of a store notification body |
| `iap.notifyBodyReadTimeoutMs` | integer | core | content | time limit of the whole store notification body read |
| `iap.subscriptionSyncIntervalMs` | integer | core | content | interval at which `SyncSubscriptions` looks up a subscription again before expiry |
| `iap.withdrawnRecordRetentionMs` | integer | core | content | duration that payment records, bindings, subscription records, account token mappings and `OTHER_USER` records of a withdrawn user are kept before deletion |
| `iap.fakeSubscriptionPeriodMs` | integer | core | content | length of one subscription period of the fake adapter. Only DEV code reads it |
| `environments.<ENV>.secrets.iapAccountToken` | string | game | none | secret name of the key that makes the account token |
| `environments.<ENV>.secrets.iapApple` | string | game | none | name of the secret that holds the App Store Server API private key (`.p8` PEM) |
| `environments.<ENV>.secrets.iapGoogle` | string | game | none | name of the secret that holds the private key (PEM) of the `iapGoogle.serviceAccountEmail` service account |
| `iapApple.issuerId` | string | game | none | `iss` of the App Store Server API JWT |
| `iapApple.keyId` | string | game | none | `kid` of the App Store Server API JWT |
| `iapApple.appAppleId` | integer | game | none | app Apple ID compared with `appAppleId` of production store transaction info and notifications that Apple signed |
| `iapGoogle.serviceAccountEmail` | string | game | none | service account that gets the Google Play Developer API access token |
| `iapGoogle.notificationServiceAccountEmail` | string | game | none | service account compared with the OIDC token `email` of the store notification Pub/Sub push |
| `environments.<ENV>.serverUrl` | string | game | none | server address that makes the OIDC token `aud` of the store notification Pub/Sub push |
| `consent.ageConfirmation` | boolean | game | none | whether age confirmation is required |
| `purchaseLimits.monthlyBelowAge` | object | game | none | per age n (decimal string key), the monthly spend limit of users whose age band is below n. Same unit as `spend_amount` |
| `purchaseLimits.testGrants` | object? | game | none | `count` and `periodMs` of the test grant limit. When `null`, there is no limit |
| `consent.ageBandBoundaries` | array<integer> | game | none | read for the server start check of the `purchaseLimits.monthlyBelowAge` keys |
| `appId` | string | game | none | app ID compared with the app ID of the receipt. It is `bid` of the App Store Server API JWT and the package name of the Google Play Developer API |
| `environments.<ENV>.adapters.iap-apple` | string? | game | none | adapter name of store `APPLE`. When `null`, this environment has no adapter of store `APPLE` |
| `environments.<ENV>.adapters.iap-google` | string? | game | none | adapter name of store `GOOGLE`. When `null`, this environment has no adapter of store `GOOGLE` |
| `routing.externalMaxResponseBytes` | integer | core | content | maximum bytes of an adapter response body. When exceeded, `IAP_VERIFY_UNAVAILABLE` |
| `idempotency.maxNotifyIdBytes` | integer | core | content | maximum bytes of a store notification ID |

- The keys `iap-apple` and `iap-google` of the per-environment `adapters` of game settings choose the adapter. The value of `iap-apple` is `fake`, `iap-apple-sandbox` or `iap-apple`, and the value of `iap-google` is `fake` or `iap-google`. Client `PaymentCore` also chooses the store adapter with the same keys
- `iap-apple` looks for the store transaction in the production environment, and verifies a store transaction of the sandbox environment in the sandbox environment. `iap-apple-sandbox` uses only the sandbox environment
- `iap-apple` and `iap-apple-sandbox` call the App Store Server API. The bearer token is an ES256 JWT with header `kid` game settings `iapApple.keyId` and payload `iss` `iapApple.issuerId`, `aud` `appstoreconnect-v1` and `bid` `appId`, signed with the private key of secret `environments.<ENV>.secrets.iapApple`. The signed JWS of store transaction info and notifications is verified with the certificate chain up to the root certificate that the key source of the adapter returns. The value of the key source is a list of root certificates (PEM or base64 DER strings), and the key source of the server returns the Apple Root CA - G3 certificate kept in core code. When `bundleId` differs from `appId`, or `appAppleId` of production environment data differs from `iapApple.appAppleId`, the receipt verification result is `INVALID` and a notification has a wrong signature
- `iap-google` calls the Google Play Developer API with package name `appId`. The access token is the value that the token endpoint returns in exchange for an RS256 JWT with `iss` game settings `iapGoogle.serviceAccountEmail`, `scope` `https://www.googleapis.com/auth/androidpublisher` and `aud` `https://oauth2.googleapis.com/token`, signed with the private key of secret `environments.<ENV>.secrets.iapGoogle`. A store notification has a correct signature only when the `Authorization` bearer OIDC token of the Pub/Sub push request has a signature that matches a Google public key that the key source of the adapter returned, `email` is `iapGoogle.notificationServiceAccountEmail`, `email_verified` is `true`, and `aud` is `environments.<ENV>.serverUrl` + `/iap/notify/google`. The value of the key source is a JWKS object, and the key source of the server gets the Google public keys from `https://www.googleapis.com/oauth2/v3/certs`. The transaction ID is `orderId`, and for a store transaction without `orderId` (e.g. promo code redemption) it is the purchase token. The original transaction ID of a subscription is the purchase token. The purchase time is `purchaseTimeMillis` of `purchases.products` for a product and `startTime` of `purchases.subscriptionsv2` for a subscription. A response whose purchase time is missing or unreadable is an adapter call failure. Exception: when the subscription state is `SUBSCRIPTION_STATE_PENDING` or `SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED`, Google gives no `startTime`, so the purchase time is the request time of the transaction that uses that store transaction or snapshot. The adapter call happens before the transaction, so the adapter returns no purchase time
- When a key of `purchaseLimits.monthlyBelowAge` is not in `consent.ageBandBoundaries` or a value is 0 or less, the server does not start

## data

`data/tables/iap_product.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `type` | `enum<IapProductType>` | `All` |
| `sku_apple` | `string` | `All` |
| `sku_google` | `string` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `daily_reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `extra_grant` | `bool` | `All` |
| `limit_count` | `int?` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |
| `pass_days` | `int?` | `All` |
| `requirement` | `requirement` | `All` |
| `start_at` | `datetime?` | `All` |
| `end_at` | `datetime?` | `All` |
| `live_event` | `ref<live_event.id>?` | `All` |
| `offer` | `ref<offer.id>?` | `All` |
| `spend_amount` | `long` | `Server` |

- For `NonConsumable`, `limit_count` is 1. For `Subscription`, `limit_count` is `null`
- `NonConsumable` and `Subscription` rows have `reset`, `pass_days` and `offer` as `null`. When `limit_count` is `null` or `offer` is not `null`, `reset` is `null`
- `pass_days` and `limit_count`, when present, are at least 1
- `daily_reward` can be non-empty only in `Subscription` and in `Consumable` with `pass_days`
- `ResetCycle` is an enum of `server-time`
- When `reset` is `null` and there is no `offer`, the purchase count is not reset on a `ResetCycle` cycle. When `type` is `Consumable` and `live_event` exists, the round reset of `live-event` still applies
- `spend_amount` is at least 0. When `purchaseLimits.monthlyBelowAge` is not empty, `spend_amount` of a row with at least one SKU is at least 1
- When `sku_apple` or `sku_google` is an empty string, the product is not sold in that store. A non-empty SKU is unique within the same column
- When there is a row whose `reward` and `daily_reward` are empty arrays and whose `extra_grant` is `false`, or a row that violates the rules of `iap_product`, the server does not start
- The client gets the display price from the store. `spend_amount` is used only for limit calculation

`data/enums.csv`

| type | element |
|---|---|
| `IapProductType` | `Consumable`, `NonConsumable`, `Subscription` |

reserved ID: `[iap_grant_mail]` → row of `mail_template`

## DEV

- The fake `iap-apple` and `iap-google` adapters receive receipts in the format `fake:<SKU>:<transaction ID>:<account token>`. The SKU is the `sku_apple` or `sku_google` value of the request store. The app ID counts as `appId` of game settings. The result (`VALID`, `INVALID`, `PENDING`, `FAILED`) and whether it is a test transaction are set with the `testing.fake` controller; when not set, `VALID` and a test transaction
- A `Subscription` receipt of the fake adapter can add `:<original transaction ID>` at the end. When it is absent, the original transaction ID is the transaction ID. The `testing.fake` controller sets the subscription snapshot; when not set, `ACTIVE`, an expiry time of purchase time + `iap.fakeSubscriptionPeriodMs`, and `auto_renew` `true`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `send_fake_refund` | store, transaction ID, notification ID (optional. When not given, a new UUID v4) | async operation. HTTP status | none | `testing` |
| `send_fake_subscription_notify` | store, original transaction ID, subscription snapshot, notification ID (optional. When not given, a new UUID v4) | async operation. HTTP status | none | `testing` |

- The store notification body of the fake `iap-apple` and `iap-google` adapters is the UTF-8 JSON object `{"notification_id": <string>, "kind": <string>, "transaction_id": <string>}`. `kind` is one of `REFUND`, `SUBSCRIPTION`, `OTHER`, and `transaction_id` is the transaction ID for `REFUND`, the original transaction ID for `SUBSCRIPTION`, and an empty string for `OTHER`. The signature is the value of header `X-Ogw-Fake-Signature`: the lowercase hex HMAC-SHA256 of the body bytes, calculated with the 32-byte secure random fake notification key that the server instance makes at start. When the header is missing or its value differs, the signature is wrong; when the body is not in this format, the format is wrong
- The `testing.fake` controller operations of the fake `iap-apple` and `iap-google` adapters are `verify`, `lookup_subscription` and `acknowledge`. The result of `verify` is `VALID`, `INVALID`, `PENDING`, `FAILED` or `{result, test, purchased_at, app_id, device_receipt}` (fields other than `result` are optional; when not given: test transaction, request time, game settings `appId`, device receipt). The result of `lookup_subscription` is `{state, ends_at, auto_renew, latest_transaction_id, sku, purchased_at, test}` of the subscription snapshot, and fields not given take the defaults above. The `input` of an `acknowledge` call is `{transaction_id, kind}`. When controller method `hold(on)` is `true`, later `verify` and `lookup_subscription` calls do not end until `release(n)` ends n of them
- The subscription snapshot of `send_fake_subscription_notify` is used instead of the controller result for the next one subscription status lookup of that original transaction ID
- `send_fake_refund` signs a body with `kind` `REFUND`, and `send_fake_subscription_notify` a body with `kind` `SUBSCRIPTION`, with the fake notification key, sends it to `POST /iap/notify/<store>` of that server instance, and returns its HTTP status
- The purchase acknowledgement of the fake `iap-google` adapter records the transaction ID and the confirmation kind (consume, acknowledge, subscription acknowledge) in the `testing.fake` controller call record, and succeeds unless a failure was set with the controller

## test

- A valid receipt gives `GRANTED`, grants `reward` with source `Iap`, and raises the purchase count by 1
- Sending the same receipt again gives `ALREADY_GRANTED`, and items stay unchanged. The same holds for `RecoverPurchase`
- A different app ID, an unknown SKU and a `REFUNDED` store transaction of another user give `INVALID`. A `GRANTED` store transaction of another user with a social account link gives `ALREADY_GRANTED`, and an ungranted store transaction with the account token that user got with `CheckPurchase` gives `OTHER_USER`. Neither grants to the requesting user, and the payment record stays unchanged
- A store transaction that the fake adapter returned as a test transaction gives `GRANTED`, the payment record has `true` for whether it is a test transaction, and there is one `audit` log. Test transactions do not count in monthly spend
- For a user who received as many test grants as `count` of `purchaseLimits.testGrants` within `periodMs`, the next test transaction gives `INVALID`
- When `purchaseLimits.testGrants` is `null`, test transactions of the same user give `GRANTED` any number of times
- `revoke_test_grant` revokes `reward` of that test transaction and changes the payment record to `REFUNDED`. A store transaction that is not a test transaction gives `not_found`
- When user A sends `RecoverPurchase` for a `NonConsumable` store transaction of user B without a social account link, it gives `GRANTED`, the user of the payment record is A, A's purchase count rises by 1, B's purchase count falls by 1, and B gets a pending delta. When B is a withdrawn user, the result is the same without B's changes, and `delete_at` of the moved record is null. A `Consumable` store transaction under the same condition with a `GRANTED` payment record of B gives `ALREADY_GRANTED` and grants nothing to A
- `revoke_iap` called for B in ownership transfer receives reason `transfer`, and the `ItemChange` of the default revocation has source `IapTransfer` and `ref` transaction ID. `revoke_iap` of a refund notification and of `revoke_test_grant` receives reason `refund`
- When users A and B without social account links send `RecoverPurchase` for the same `NonConsumable` store transaction in the order A, B, A, B, each gives `GRANTED`, the sending user receives `reward`, and the `reward` of the previous user is revoked. The `once_key` of the four grants are in turn `iap:<store>:<transaction ID>`, `iap:<store>:<transaction ID>:t1`, `iap:<store>:<transaction ID>:t2`, `iap:<store>:<transaction ID>:t3`, and at the end `transfer_count` is 3
- When user A sends `RecoverPurchase` with a receipt that is not a device receipt for a `NonConsumable` store transaction of user B without a social account link, it gives `ALREADY_GRANTED` and the user of the payment record is B. The `iap-apple` adapter returns a receipt that is the decimal string of a transaction ID and a JWS receipt that does not pass certificate chain verification as not device receipts
- When user A, who received the `Subscription` of user B by ownership transfer, sends `RecoverPurchase` for a renewal transaction that contains B's account token, it gives `GRANTED`, and there is no `OTHER_USER` record and no `reason` `iap_transfer` log
- When user A received user B's `Subscription` by ownership transfer and the `REFUND` notification of B's payment record is handled with snapshot `REVOKED`, after commit A's subscription record and `SubscriptionUserState` are `REVOKED` and `is_subscribed`(A) is `false`. The same holds when B is a withdrawn user. `revoke_test_grant`(B) in the same situation changes A's subscription record to `REVOKED` and `ends_at` to request time, and recalculates A's `SubscriptionUserState`
- When user A sends `RecoverPurchase`, with no payment record, for a `Consumable` store transaction with the account token that user B without a social account link got with `CheckPurchase`, it grants `reward` to A and gives `GRANTED`, there is one `audit` log with `reason` `iap_transfer`, and B's state stays unchanged. When B has a social account link, it gives `OTHER_USER`, and the `OTHER_USER` records of `list_payments`(A) contain that store transaction and B's user ID
- Even when the same user sends `CheckPurchase` twice, there is one `iap_account_token` row
- After the Apple subscription is cancelled and the same product is subscribed with Google, when an Apple `EXPIRED` notification comes, `SubscriptionUserState` has `state` and `ends_at` of the Google subscription and `is_subscribed` is `true`. When the plan changes to a product with a different SKU, the previous product row and the new product row are each recalculated
- For a store transaction without an account token in `APPLE` and `GOOGLE`, when the user first bound by original transaction ID has a social account link, only that user is granted. The user who first sends a `GOOGLE` store transaction without an account token within purchase time + `iap.withdrawnRecordRetentionMs` gets `GRANTED`, and there is one payment record
- When two users with social account links concurrently send the same `APPLE` store transaction or the same `GOOGLE` store transaction without an account token, only one user gets `GRANTED` and the other user is not granted. The result of the other user is `OTHER_USER` when judged before the commit of the earlier user and `ALREADY_GRANTED` when judged after it
- When the correct user sends again a store transaction that remained `INVALID`, it gives `GRANTED`, and that store transaction has one payment record
- When the requesting user's `GRANTED` store transaction is sent again and the fake adapter returns `INVALID`, it gives `ALREADY_GRANTED` and the payment record stays `GRANTED`. After that, `send_fake_refund` of that store transaction revokes `reward` and changes the payment record to `REFUNDED`. When the fake adapter returns `INVALID` for another user's `GRANTED` store transaction, it gives `INVALID` and that payment record stays unchanged
- `PENDING` grants nothing and leaves no payment record
- Adapter `FAILED` and time limit exceeded give `IAP_VERIFY_UNAVAILABLE`, and sending the same receipt again grants
- When `add_items` fails because `max_amount` is exceeded, it grants with an `[iap_grant_mail]` mail and gives `GRANTED`, and `expires_at` of that mail is 0
- `grant_iap_extra` failure gives `INTERNAL`, and items and payment records stay unchanged
- `CheckPurchase` rejects a reached limit and a product that is not sold
- A refund notification revokes `reward` with the default hook, changes the payment record to `REFUNDED`, and makes a pending delta
- `send_fake_refund` sent twice with the same notification ID is handled only once. A notification sent with `testing.send_raw` with a wrong `X-Ogw-Fake-Signature` gives HTTP 403, and a notification with a wrong JSON format gives HTTP 400
- Raw receipts and account tokens are not in logs
- A `Subscription` purchase makes `SubscriptionUserState` `ACTIVE` with `ends_at` of the snapshot, and `is_subscribed` is `true`. When request time ≥ `ends_at`, it is `false`
- A renewal notification grants `reward` of the new transaction ID once and changes `ends_at`. The next notification of the same store transaction and `RecoverPurchase` do not grant again
- `GRACE_PERIOD` has the entitlement, and `BILLING_RETRY`, `EXPIRED` and `REVOKED` do not
- A notification with a subscription status lookup failure gives HTTP 500, and the state stays unchanged
- A subscription receipt of an original transaction ID bound to another user with a social account link gives `OTHER_USER` for an ungranted transaction ID and `ALREADY_GRANTED` for a transaction ID granted to that other user, and in both cases `SubscriptionUserState` of the requesting user stays unchanged
- `CheckPurchase` of an auto-renewing subscription with an entitlement gives `IAP_LIMIT_REACHED`
- `SyncSubscriptions` looks up, among subscription records whose `state` is `ACTIVE`, `GRACE_PERIOD` or `BILLING_RETRY`, the records whose `ends_at` has passed and the records whose `updated_at` + `iap.subscriptionSyncIntervalMs` has passed, and does not look up records that are neither, nor `EXPIRED` and `REVOKED` records. It grants the renewals in the lookup result
- `ClaimIapDaily` grants `daily_reward` once per game day, the second claim on the same game day gives `IAP_ALREADY_CLAIMED`, and claiming works again from the game day boundary. A subscription without entitlement and an inactive pass give `IAP_DAILY_INACTIVE`
- In DEV, the entitlement and the game day number of `ClaimIapDaily` of a user with a cheat time offset set are judged by the request time that includes the offset
- When `consent.ageConfirmation` is `true` and the age is not confirmed yet, `CheckPurchase` gives `AGE_CONFIRMATION_REQUIRED`
- The limit of a user whose age band is below both key ages of `purchaseLimits.monthlyBelowAge` is the smaller of the two values. When monthly spend + `spend_amount` exceeds the limit, `IAP_SPEND_LIMIT_REACHED`, and when it equals the limit, it passes. Store transactions of past game months, `REFUNDED` store transactions and test transactions are not in monthly spend. A user without a limit passes
- While the adapter verification of `VerifyPurchase` and the subscription status lookup of `SyncSubscriptions` are awaited, other requests of the same user are handled
- When one subscription status lookup of `SyncSubscriptions` fails, `IAP_VERIFY_UNAVAILABLE`, and the applied results of the successful lookups remain and come in `pending_user_state` of the next success response of that user
- When the store notification body exceeds `iap.notifyMaxBodyBytes` or the read duration exceeds `iap.notifyBodyReadTimeoutMs`, HTTP 400, and it is not handled
- When the adapter response body exceeds `routing.externalMaxResponseBytes`, `IAP_VERIFY_UNAVAILABLE`
- The `REFUND` notification of a `GRANTED` store transaction of a withdrawn user gives HTTP 200, the payment record is `REFUNDED`, and a resend with the same notification ID is not handled
- A `SUBSCRIPTION` notification with a subscription record of a withdrawn user gives HTTP 200, `state`, `ends_at` and `auto_renew` of the subscription record are the snapshot values, and there is no grant and no pending delta. When the snapshot is `EXPIRED`, `delete_at` stays unchanged; when `ACTIVE`, `delete_at` of the subscription record and of the binding is handling time + `iap.withdrawnRecordRetentionMs`. A resend with the same notification ID is not handled
- The `REFUND` notification of a `Subscription` store transaction does a subscription status lookup with the original transaction ID of the payment record before `claim_notify`, and does subscription apply with that subscription snapshot. On lookup failure, HTTP 500, and the payment record and the subscription record stay unchanged
- The revocation `ItemChange` of default `revoke_iap` has source `IapRefund` and `ref` transaction ID
- When there is an `iap_product` row whose `extra_grant` is `true` and content leaves at least one of `grant_iap_extra` and `revoke_iap` unregistered, the server does not start and an `error` log is left
- After `remove_user`, that user's payment records remain, and are deleted by expiry cleanup after `delete_at` is reached
- `has_granted_payment` is `true` for a user with a `GRANTED` payment record that is not a test transaction, and `false` for a user with only test transaction records or `REFUNDED` and `INVALID` records and for a user with no records
- When another user sends a deleted `APPLE` store transaction or `GOOGLE` store transaction without an account token, `INVALID`
- A grant of a `Consumable` with `pass_days` writes `pass_end_day` as today + `pass_days`, and the next grant while the pass is active adds `pass_days`. `is_pass_active` is `true` up to the game day before `pass_end_day` and `false` on that game day. `REFUND` of that product subtracts `pass_days` from `pass_end_day`
- Before `start_at`, from `end_at` on, with an inactive offer, and while the linked live event is not active, `CheckPurchase` gives `IAP_PRODUCT_UNAVAILABLE`, and when `passed` of `evaluate_requirement` is `false`, `IAP_PRODUCT_LOCKED`
- `reset_at` of the `IapPurchaseUserState` row made by the first grant of a product with `reset` is `server-time.get_next_reset`(`reset`, request time), the purchase count is 0 from the reset time, and `CheckPurchase` passes again. `reset_at` of a product with `offer` is the end time of that offer
- A `Consumable` product with `limit_count` 1 bound to a `live_event` with `repeat` passes `CheckPurchase` in round 2 after being granted in round 1, and a `NonConsumable` product bound to the same event gives `IAP_LIMIT_REACHED` in round 2 too
- After one `Consumable` with `reset` `Daily` is granted on game day d and one on d + 1, when the `REFUND` of the store transaction of d comes, the purchase count of d + 1 stays 1, and the `REFUND` of the store transaction of d + 1 lowers the purchase count to 0. When the `REFUND` of a `repeat` live event product store transaction granted in round 1 comes in round 2, the purchase count of round 2 stays unchanged. `reset_at` and `event_round` of the granted payment record equal the values of the `IapPurchaseUserState` row right after the grant
- Grants and refunds leave core analytics events `core_iap_granted` and `core_iap_refunded` for a user who allowed analytics
- When a `GOOGLE` store transaction of the fake `iap-google` adapter ends with `GRANTED` or `ALREADY_GRANTED`, purchase acknowledgement is called once on that store transaction after commit: consume for `Consumable`, acknowledge for `NonConsumable`, subscription acknowledge for `Subscription`. It is not called for `INVALID`, `OTHER_USER`, `PENDING` and `IAP_VERIFY_UNAVAILABLE`. On a failure set with the fake controller, the response stays unchanged and there is one `error` log
- The `REFUND` notification of a store transaction granted with an `[iap_grant_mail]` mail because `max_amount` was exceeded deletes that unclaimed mail, and `revoke_iap` receives an empty revocation list, so the balance stays unchanged. A `REFUND` after the mail was claimed does not delete the mail, and `revoke_iap` receives `reward` as the revocation list. In ownership transfer too, B's unclaimed grant mail is deleted and B's balance stays unchanged
- `core_iap_granted` of the first store transaction of a `Subscription` has `renewal` `false`, and a renewal transaction of the same original transaction ID has `true`. `Consumable` and `NonConsumable` have `false`. `store`, `spend_amount` and `test` are the values of that payment record
- When two `REFUND` notifications of the same `GRANTED` store transaction are sent concurrently with different notification IDs, both give HTTP 200, and the `reward` revocation, the purchase count decrease and `core_iap_refunded` each happen once
- When `revoke_test_grant` and the `REFUND` notification of that store transaction are sent concurrently, revocation happens once. When the notification commits first, `revoke_test_grant` gives `conflict`; when `revoke_test_grant` commits first, the notification gives HTTP 200 and changes nothing
- When, after a `REFUND` notification reads user B's `NonConsumable` payment record and before record recheck, an ownership transfer that moves that store transaction to user A commits, that notification gives HTTP 500 and the states of A and B stay unchanged. When the same notification is sent again, it revokes `reward` from A
- When, after a `SUBSCRIPTION` notification reads user B's subscription record and before record recheck, an ownership transfer that moves that subscription to user A commits, that notification gives HTTP 500 and B's state stays unchanged. When the same notification is sent again, A's `SubscriptionUserState` changes to the snapshot values
