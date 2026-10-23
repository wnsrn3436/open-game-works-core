# coupon

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

Lets a user enter a coupon code an operator made and receive the reward. Handles the use count limit, once per user, the active window, the redeem attempt limit and use records, and grants rewards with `item-ledger`.

## dependency

- `item-ledger`
- `mailbox`
- `storage`
- `server-time`
- `logging`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `RedeemCoupon` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `content` | code string | list of received `ItemAmount` | `COUPON_INVALID`, `COUPON_NOT_ACTIVE`, `COUPON_USED_UP`, `COUPON_ALREADY_REDEEMED`, `RATE_LIMITED`, `INTERNAL` | `routing`. client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `RedeemCouponRequest` | `code` | `string` | `max_len_key`: `coupon.maxCodeInputBytes` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `RedeemCouponResponse` | `items` | `repeated ItemAmount` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `count_redeem_attempt` | user ID, `RedeemCouponRequest`, client IP, request ID | async operation. `pass` | `RATE_LIMITED`, `UNAUTHORIZED`, `INTERNAL` | `routing` |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `create_coupon` | `operation_id`, `kind`, `code`, `count`, `max_uses`, `start_at`, `end_at`, `items`, `extra_id`, `memo` | `coupon_id` | `bad_request`, `conflict` | operator |
| `get_coupon` | `coupon_id`(optional), `code`(optional) | input fields of the coupon, `used_count`(for `unique`, the number of codes with `redeemed_by`), `disabled` | `bad_request`, `not_found` | operator |
| `list_coupon_codes` | `coupon_id`, `after_code`, `limit` | `codes`: list of `(code, redeemed_by, redeemed_at)`. Ascending byte order of code | `not_found` | operator |
| `disable_coupon` | `coupon_id` | empty object | `not_found` | operator |

- `kind`: `shared`(many users use one code) or `unique`(makes `count` codes, and one user uses one code)
- `code`: used only by `shared`. The empty string for `unique`
- `count`: used only by `unique`. At least 1 and at most `coupon.maxBatchCount`. 0 for `shared`
- `max_uses`: total use count limit of `shared`. 0 means no limit. 0 for `unique`
- `start_at`, `end_at`: active window. 0 ≤ `start_at` < `end_at`
- `items`: list of `ItemAmount`. When `extra_id` is 0, at least 1 and at most `coupon.maxRewardItems` items; when it is not 0, 0 or more and at most the smaller of `coupon.maxRewardItems` and `mailbox.maxAttachments`. Must pass the input check of `item-ledger`
- `extra_id`: integer 0 or more. When it is not 0, the reward is sent as a mail that holds `extra_id`, and when that mail is received, the `mailbox` hook `grant_mail_extra` grants the reward that is not an item
- `memo`: description the operator leaves. Not sent to the client
- field types: `kind` is `enum{shared, unique}`, `code`, `after_code` and `memo` are `string`, `count`, `max_uses` and `extra_id` are `int32`, `coupon_id` is `int64`
- `get_coupon` takes exactly one of `coupon_id` and `code`. When both or neither are given, `bad_request`. `code` is looked up by its normalized value
- `after_code`: when it is the empty string, returns from the first code; otherwise returns only codes after that code in byte order

## behavior

code

- code normalization: deletes leading and trailing spaces, `-` and whitespace characters (Unicode `White_Space`), and changes ASCII lowercase letters to uppercase. Saving, comparison and input all use the normalized value
- A normalized code uses only characters of `coupon.codeAlphabet` and has a length of at least `coupon.minCodeLength` and at most `coupon.maxCodeLength`. On a violation, admin operations are `bad_request` and `RedeemCoupon` is `COUPON_INVALID`
- A `unique` code picks `coupon.generatedCodeLength` characters from `coupon.codeAlphabet` with secure random. It does not use ctx random. When it collides with an existing code or a code picked earlier in the same `create_coupon`, it picks again. When one code still collides after 100 picks, `create_coupon` writes nothing and returns `conflict`
- The codes of all coupons differ from each other. When the `code` of a `shared` coupon already exists, `create_coupon` is `conflict`

redeem attempt limit

- `count_redeem_attempt` increases that user's attempt counter by one with `storage.run_user_transaction` and commits. It counts regardless of the result. The request processing order of `routing` decides when it is called. When `run_user_transaction` is `WITHDRAWN`, the result is `UNAUTHORIZED`; when it is `FAILED`, `INTERNAL`; and the count does not increase
- The counter counts per fixed window of `server-time`. The length is `coupon.attemptWindowMs` and the time is `server-time.clock_now`. When the row's `window_start` differs from the window start of the current fixed window, it treats `count` as 0, changes `window_start` to that window start, and then counts. `expires_at` is `window_start` + `coupon.attemptWindowMs`. When the attempt count in the fixed window is more than `coupon.maxAttemptsPerWindow`, the result is `RATE_LIMITED`, and it leaves a `security` log with the received request ID and the truncated IP of the client IP
- The counter is not rolled back by the success or failure of `RedeemCoupon`

`RedeemCoupon` processing order. A failure changes neither use records nor items.

1. `COUPON_INVALID` when there is no coupon for the normalized code or it is `disabled`
2. `COUPON_NOT_ACTIVE` when `server-time.is_reached`(`start_at`) is `false` or `is_reached_strict`(`end_at`) is `true`
3. `COUPON_ALREADY_REDEEMED` when this user has a record of using that coupon
4. Locks the coupon row (`shared`) or the code row (`unique`) with `storage.lock_game_row`. `COUPON_USED_UP` for `shared` when `max_uses` is not 0 and `used_count` ≥ `max_uses`, and for `unique` when `redeemed_by` is set
5. When `extra_id` is 0, `mailbox.grant_or_mail`: source `Coupon`, `ref` is the decimal string of the coupon ID, `once_key` is `coupon:<coupon ID>`, the template is reserved ID `[coupon_reward_mail]`, `args` is the empty list. `Mailed` also counts as a use. When `extra_id` is not 0, `mailbox.send_mail`: the template is `[coupon_reward_mail]`, `args` is the empty list, `attachments` is `items`, `extra_id` is the coupon's `extra_id`, `once_key` is `coupon:<coupon ID>`. `OK` and `ALREADY_SENT` count as a use, and the list of received `ItemAmount` in the response is the empty list
6. Saves the use record. For `shared`, increases `used_count` by one; for `unique`, writes `redeemed_by` and `redeemed_at`. Adds the user's use record row
7. after hook `on_coupon_redeemed`
8. One `audit` log line after commit with `storage.after_commit`: `request` `core/RedeemCoupon`, `user_id`, and the coupon ID and the normalized code in `args`

- A `RedeemCoupon` sent again with the same request ID returns the response that `idempotency` saved and does not increase the attempt counter

table

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `coupon_coupon` | `game` | `coupon_id`, `kind`, `code`, `count`, `max_uses`, `used_count`, `start_at`, `end_at`, `items`, `extra_id`, `memo`, `disabled`, `created_at` | `coupon_id` | none | none |
| `coupon_code` | `game` | `code`, `coupon_id`, `redeemed_by`, `redeemed_at` | `code` | none | `(coupon_id, code)` |
| `coupon_redemption` | `user` | `user_id`, `coupon_id`, `redeemed_at` | `(user_id, coupon_id)` | none | none |
| `coupon_attempt` | `user` | `user_id`, `window_start`, `count`, `expires_at` | `user_id` | `expires_at` | none |

- The code of a `shared` coupon is also kept as one row in `coupon_code`. `redeemed_by` is not used
- `coupon_redemption` is registered with snapshot flag `true`, and `coupon_attempt` with `false`
- `coupon_id` is an integer that increases from 1. In the game tx that `admin-api` opens, `create_coupon` first locks the `coupon_id` 0 key of `coupon_coupon` with `storage.lock_game_row`, so `create_coupon` calls are handled one after another. The judgement of duplicate codes and `unique` code generation happen after this lock. The new `coupon_id` is the largest `coupon_id` + 1, or 1 when there is no row. No row with `coupon_id` 0 is kept
- `disable_coupon` is not reverted. Rewards already granted are not taken back
- `once_key` prefix: `coupon:`

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `on_coupon_redeemed`(after hook) | `RedeemCoupon` step 7 | ctx, coupon ID | none | does nothing |

- `on_coupon_redeemed` does content's aggregation after a successful coupon use. e.g. `mission` `add_progress` for a mission that counts coupon uses

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| code that does not exist, format violation, disabled | `COUPON_INVALID` | `COUPON_INVALID` | none |
| outside the active window | `COUPON_NOT_ACTIVE` | `COUPON_NOT_ACTIVE` | none |
| this user already used it | `COUPON_ALREADY_REDEEMED` | `COUPON_ALREADY_REDEEMED` | none |
| use count limit reached, used `unique` code | `COUPON_USED_UP` | `COUPON_USED_UP` | none |
| redeem attempt limit exceeded | `RATE_LIMITED` | `RATE_LIMITED` | `security` log |
| the user transaction of `count_redeem_attempt` is `WITHDRAWN` | `UNAUTHORIZED` | `UNAUTHORIZED` | none |
| the user transaction of `count_redeem_attempt` is `FAILED` | `INTERNAL` | `INTERNAL` | `error` log |
| reward grant failure (failure of `grant_or_mail`, `INVALID_INPUT` of `send_mail`) | `INTERNAL` | `INTERNAL` | error rules of `mailbox` |
| rule violation of `create_coupon` input, format violation of the normalized code, `get_coupon` that did not get exactly one of `coupon_id` and `code` | `bad_request` | none | `audit` |
| `shared` `create_coupon` with an existing code, `unique` `create_coupon` in which one code still collided after 100 picks | `conflict` | none | `audit` |
| `get_coupon`, `list_coupon_codes`, `disable_coupon` of a coupon that does not exist | `not_found` | none | `audit` |
| violation of the server start condition of `coupon.codeAlphabet` | server start failure | none | `error` log |

Added `CoreError`: `COUPON_INVALID`, `COUPON_NOT_ACTIVE`, `COUPON_ALREADY_REDEEMED`, `COUPON_USED_UP`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `coupon.codeAlphabet` | string | core | content | character set used in codes. Chosen from ASCII uppercase letters and digits |
| `coupon.minCodeLength` | integer | core | content | minimum length of a normalized code |
| `coupon.maxCodeLength` | integer | core | content | maximum length of a normalized code |
| `coupon.generatedCodeLength` | integer | core | content | length of a `unique` code |
| `coupon.maxCodeInputBytes` | integer | core | content | byte limit of the `RedeemCoupon` code field |
| `coupon.maxBatchCount` | integer | core | content | limit on the number of codes of one `unique` coupon |
| `coupon.maxRewardItems` | integer | core | content | limit on the number of reward items of one coupon. 1 or more |
| `mailbox.maxAttachments` | integer | core | content | limit on the number of `items` of a coupon whose `extra_id` is not 0 |
| `coupon.attemptWindowMs` | integer | core | content | fixed window length of the redeem attempt counter. 1 or more |
| `coupon.maxAttemptsPerWindow` | integer | core | content | redeem attempt limit per fixed window |

settings constraint

| left | factor | right |
|---|---|---|
| `coupon.minCodeLength` | 1 | `coupon.generatedCodeLength` |
| `coupon.maxCodeLength` | 1 | `coupon.maxCodeInputBytes` |
| `coupon.generatedCodeLength` | 1 | `coupon.maxCodeLength` |

- When `coupon.codeAlphabet` is empty, or contains a character that is not an ASCII uppercase letter or digit, or a duplicate character, the server does not start

## data

reserved ID: `[coupon_reward_mail]` → row of `mail_template`

## DEV

none

## test

- Two users each receive a `shared` coupon once, and the same user's second redeem is `COUPON_ALREADY_REDEEMED`
- A `shared` coupon that reached `max_uses` is `COUPON_USED_UP`
- Only one user receives a `unique` code, and another user is `COUPON_USED_UP`. For the same user, another code of the same coupon is also `COUPON_ALREADY_REDEEMED`
- Input mixed with lowercase letters, `-` and spaces finds the same coupon as the normalized code
- Before `start_at` and from `end_at` on, the result is `COUPON_NOT_ACTIVE`, and after `disable_coupon`, `COUPON_INVALID`
- The reward is granted with source `Coupon`, and one `audit` log line with `request` `core/RedeemCoupon` is left
- `on_coupon_redeemed` is called once per successful `RedeemCoupon` with that coupon ID, and changes made inside it come in the delta of the same response. It is not called for a failed `RedeemCoupon`. When the hook throws, `RedeemCoupon` is `INTERNAL` and the use record, `used_count` and items stay as they are
- When the reward cannot be granted right away because it is over `max_amount` or an `item-ledger` validation hook rejects it, it is sent as a `[coupon_reward_mail]` mail, and the use record and `used_count` change
- When the reward grant ends in a failure of `grant_or_mail`, the result is `INTERNAL` and the use record and `used_count` stay as they are
- When the attempts in a fixed window are more than `coupon.maxAttemptsPerWindow`, a correct code is also `RATE_LIMITED`, and it is accepted again in the next fixed window. Failed attempts also count
- In the `security` log of a `RedeemCoupon` over the attempt limit, `request_id` is the request ID of that request and `ip` is the truncated IP of that client IP
- When two concurrent requests come for a coupon with `max_uses` 1, only one receives it
- `create_coupon` makes `count` distinct `unique` codes, and `list_coupon_codes` returns them all
- With `coupon.codeAlphabet` `AB` and `coupon.generatedCodeLength` 1, a `unique` `create_coupon` with `count` 3 ends with `conflict` and leaves no coupon row or code row
- `get_coupon` returns the `count` of a `unique` coupon as the `count` of `create_coupon`, and the `count` of a `shared` coupon as 0
- Creating a `shared` coupon with an existing code is `conflict`
- `get_coupon` given both or neither of `coupon_id` and `code` is `bad_request`, and `get_coupon` given a non-normalized `code` returns that coupon
- `list_coupon_codes` with an empty `after_code` returns `limit` codes from the first code, and the next call given the last code as `after_code` returns the remaining codes, each once and none missing
- Two `create_coupon` calls with the same `operation_id` make only one coupon
- Two concurrent `create_coupon` calls with different `operation_id` get different `coupon_id` values. When two `shared` creations with the same code are sent concurrently, only one is made and the other is `conflict`
- The `expires_at` of a `coupon_attempt` row is `window_start` + `coupon.attemptWindowMs`, and from that time the expiry cleanup deletes the row
- A coupon whose `extra_id` is not 0 sends one `[coupon_reward_mail]` mail that holds `items` and `extra_id`, and the use record changes. When that mail is received, `grant_mail_extra` is called with that `extra_id`
- An `extra_id` coupon with empty `items` is created, and a `create_coupon` with `extra_id` 0 and empty `items` and a `create_coupon` with non-zero `extra_id` and more than `mailbox.maxAttachments` `items` are `bad_request`
- The server does not start with settings where `coupon.codeAlphabet` has a lowercase letter
