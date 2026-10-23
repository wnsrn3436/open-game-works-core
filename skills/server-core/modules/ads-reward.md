# ads-reward

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

Verifies the reward of a rewarded ad with the ad network callback and grants it. The grant is an out-of-request change and reaches the client as a pending delta.

## dependency

- `item-ledger`
- `mailbox`
- `storage`
- `idempotency`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `BeginAdReward` (core rpc, `silent`, `retry`). changes: none | placement ID value | reward notify ID | `INVALID_REQUEST`, `AD_LIMIT_REACHED`, `GameError` of the hook | `routing`. Sent by client `AdCore` |
| `ClaimAdReward` (core rpc, `silent`, `retry`). changes: none | reward notify ID | list of granted `ItemAmount` | `AD_REWARD_PENDING`, `AD_REWARD_NOT_FOUND`, `INTERNAL` | `routing`. Sent by client `AdCore` |
| `wait_ad_reward` | user ID, `ClaimAdRewardRequest` | async operation. none. When `notify_id` of the request is an `Issued` ticket of that user, changes it to `Claimed` in its own user transaction and commits. Then waits with `server-time.sleep` in steps of `ads-reward.claimPollIntervalMs`, reading the ticket, and returns when it is no longer `Claimed` or `ads-reward.claimWaitMs` has passed | none | `routing`. Called before the user transaction of `ClaimAdReward` is opened |
| `GET /ads/callback/<network>` (route) | server-side verification query of the ad network | HTTP status | HTTP status of the callback rules | `routing`. Sent by the ad network |
| `get_reward_count` | ctx, placement ID value | number of grants in the current limit period | none. An unknown placement is 0 | content handler, hook |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `BeginAdRewardRequest` | `placement_id` | `int32` | `table`: `ad_placement` |
| `ClaimAdRewardRequest` | `notify_id` | `string` | `max_len`: 36 |

core `rpc` response field

| message | field | type |
|---|---|---|
| `BeginAdRewardResponse` | `notify_id` | `string` |
| `ClaimAdRewardResponse` | `items` | `repeated ItemAmount` |

## behavior

ticket

- Each time right before it shows a loaded rewarded ad, `AdCore` sends `BeginAdReward` and passes the received reward notify ID and the user ID to the ads SDK as server-side verification custom data. Only the server makes reward notify IDs
- `BeginAdReward` processing order
  1. When the `type` of the placement is not `Rewarded`, `INVALID_REQUEST`
  2. When there is `limit_count` and the sum of the number of grants in the current limit period and the number of unexpired `Claimed` tickets of that placement (regardless of the limit period they were made in) ≥ `limit_count`, `AD_LIMIT_REACHED`
  3. hook `validate_ad_reward`
  4. Makes a ticket: reward notify ID (UUID v4), user ID, placement ID value, creation time (`server-time.clock_now`), state `Issued`, grant list (empty list). When there is an `Issued` ticket of the same user and placement, changes that ticket to `Replaced`. Does not change a `Claimed` ticket
- A ticket is an `ads_reward_ticket` row. `expires_at` is the creation time + `ads-reward.ticketTtlMs`. A ticket whose `expires_at` `clock_now` has reached counts as `Expired` regardless of `state`, and the expiry cleanup of `storage` deletes it
- ticket state: `Issued`, `Claimed`, `Granted`, `Failed`, `Replaced`, `Expired`. `Claimed` is a ticket that received `ClaimAdReward` and waits for the callback. States other than `Expired` are written in the `state` column

callback

- `routing` collects the route, and the route does not go through the request processing order or access token authentication. `<network>` is the network name of the adapter that game settings `environments.<ENV>.adapters.ads` chose. The network name is `admob` for `ads-admob` and `fake` for `fake`. An environment whose `adapters.ads` is `null` and any other `<network>` are HTTP 404
- callback processing order. When a step fails, answers with that step's HTTP status and ends
  1. IP limit: reads the `count` of the `ads_reward_ip_counter` row of the client IP and the current minute window. When there is no row, it is 0. When `count` is `ads-reward.callbackRateLimitPerMinute` or more, HTTP 429
  2. format: when the query byte length exceeds `ads-reward.maxQueryBytes` or the adapter's `parse` gives a format error, HTTP 400
  3. key: finds in the key cache the key of the key ID that `parse` extracted. When there is no usable key list, HTTP 503
  4. signature: when the key ID is not in the usable key list or the adapter's `verify` says the signature does not match, HTTP 403
- `ads_reward_ip_counter` counts only callbacks that failed at step 2 or step 4. When such a step fails, before answering with the HTTP status, one `storage.run_game_transaction` increments by 1 the `count` of the row of the client IP and the current minute window, and commits. HTTP 503 of step 3 and callbacks whose signature matched are not counted. The counter counts per minute window of `server-time`. `window_start` is the window start of that minute window, and `expires_at` is the window end. The client IP is the value that `routing` passed to the route handler
- key cache: the memory of the server instance keeps the last fetched key list and the time it was fetched. A key list whose fetch time + `ads-reward.keyCacheMs` > `server-time.clock_now` is the usable key list
  - When there is no usable key list, fetches it with the adapter's `fetch_keys`
  - When the key ID is not in the usable key list and the time the last fetch started + `ads-reward.keyRefetchIntervalMs` ≤ `clock_now`, fetches once again
  - Within a server instance, one fetch runs at a time. A callback that arrives during a fetch waits for the result of that fetch
  - When a fetch fails or does not finish within `ads-reward.keyFetchTimeoutMs`, does not change the cache and leaves an `error` log
- When the signature matches, answers HTTP 200. The result of the handling below does not change the HTTP status. Except: a DB failure and a hook throw at step 4 of the grant order are HTTP 500
- When the reward notify ID of a callback whose signature matched is not a lowercase UUID v4, or the user ID is not a decimal string without leading 0 from 1 to 2^63−1, does not grant, without `claim_notify` and without a transaction, and leaves a `warn` log
- The reward notify ID is handled only once with `idempotency.claim_notify` (source is the adapter name), in the same transaction as the grant. With `DUPLICATE`, HTTP 200 without handling
- The callback opens `storage.run_user_transaction` with the user ID of the query, and in it reads the ticket by key (user ID of the query, reward notify ID). When `run_user_transaction` is `WITHDRAWN`, there is no ticket, or the state is neither `Issued` nor `Claimed`, does not grant and leaves a `warn` log. A reward notify ID of another user has no ticket at that key
- grant order. The grant is one out-of-request change of the ticket user that the `run_user_transaction` above opened. Steps 1 to 2 run inside one `storage.run_savepoint`
  1. When there is `reward`, `mailbox.grant_or_mail`, source `AdReward`, `ref` the placement ID value, `once_key` `ad:<reward notify ID>`, template reserved ID `[ad_reward_mail]`, `args` an empty list
  2. When `extra_grant` is `true`, hook `grant_ad_extra`. On `GameError`, the savepoint function returns that `GameError` and step 1 is undone. Then, in the same transaction, changes the ticket to `Failed`, leaves an error log, and commits with `claim_notify`, without steps 3 to 5
  3. Increments the grant count by 1 and changes the ticket to `Granted`. When `grant_or_mail` of step 1 is `Granted`, keeps `reward` in the ticket's grant list. With `AlreadyApplied` or `Mailed`, the grant list is empty
  4. after hook `on_ad_rewarded`. When the hook throws, rolls back the whole callback handling and answers HTTP 500. A callback that the ad network sends again is handled in the same order as the first callback
  5. Emits core analytics event `core_ad_rewarded` with `logging.track_core_event`
- The grant count is saved in the core UserState kind `AdRewardCountUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id`(placement ID value), `int32 count`, `int64 reset_at`. `count` is read with the lazy reset of `server-time`, and its first value is 0. The next reset time is `server-time.get_next_reset`(`reset`, request time). Client `UserStateCore.get_ad_reward_count` reads it with the same rule
- The raw query and the signature are not kept in logs

claim

- `ClaimAdReward` answers by the ticket state
  - `Granted`: success. The output is the ticket's grant list. The granted change arrives as the pending delta of this response, and items granted by mail arrive as `item_mails`
  - `Issued`, `Claimed`: `AD_REWARD_PENDING`. Before that, `routing` waited outside the transaction with `wait_ad_reward`
  - `Failed`: `INTERNAL`
  - no ticket, a ticket of another user, or `Replaced`, `Expired`: `AD_REWARD_NOT_FOUND`
- A grant that comes after `AD_REWARD_PENDING` goes as a pending delta in the next successful response of that user
- `once_key` prefix: `ad:`

### table

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `ads_reward_ticket` | `user` | `user_id`, `notify_id`, `placement_id`, `state`(`Issued`, `Claimed`, `Granted`, `Failed`, `Replaced`), `items`(grant list), `created_at`, `expires_at` | `(user_id, notify_id)` | `expires_at` | `(user_id, placement_id, state)` |
| `ads_reward_ip_counter` | `game` | `ip`, `window_start`, `count`, `expires_at` | `(ip, window_start)` | `expires_at` | none |

- `ads_reward_ticket` is registered with `storage.register_table` with snapshot flag `false`, and `ads_reward_ip_counter` without a snapshot flag

### real adapter

| adapter key | real adapter |
|---|---|
| `ads` | `ads-admob` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `advertising_data` | ad unit and reward of the rewarded ad whose reward was granted | `ads-admob` | `app_functionality` | `true` | `false` | `false` | `true` | `android`, `ios` | `none` |

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_ad_reward` | step 3 of `BeginAdReward` | ctx, placement ID value | `pass` or `GameError` | `pass` |
| `grant_ad_extra` | step 2 of the grant order | ctx, placement ID value, reward notify ID | `pass` or `GameError` | when there is an `ad_placement` row whose `extra_grant` is `true`, the server does not start |
| `on_ad_rewarded`(after hook) | step 4 of the grant order | ctx, placement ID value, reward notify ID | none | does nothing |

- `on_ad_rewarded` does the content's counting after a successful grant. e.g. `mission` `add_progress` for a mission that counts ad views. That change is in the same out-of-request change as the grant, so it goes as a pending delta

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| grant limit reached | `AD_LIMIT_REACHED` | `AD_LIMIT_REACHED` | none |
| callback wait duration exceeded | `AD_REWARD_PENDING` | `AD_REWARD_PENDING` | none |
| unusable ticket | `AD_REWARD_NOT_FOUND` | `AD_REWARD_NOT_FOUND` | none |
| ticket whose grant failed | `INTERNAL` | `INTERNAL` | `error` log at grant time |
| callback signature mismatch, key ID not in the usable key list | HTTP 403 | none | `security` log(`reason` `ad_callback_signature`) |
| `BeginAdReward` of a placement that is not `Rewarded` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `validate_ad_reward` rejection | `GameError` of the hook | `GameError` of the hook | none |
| `grant_ad_extra` failure in the grant order | undoes step 1 and changes the ticket to `Failed` | none | `error` log |
| `mailbox.grant_or_mail` failure in the grant order, the ticket's placement not in `ad_placement` | same as a `grant_ad_extra` failure | none | `error` log |
| an `ad_placement` row whose `extra_grant` is `true` exists and there is no `grant_ad_extra` | server start failure | none | `error` log |
| `idempotency.maxNotifyIdBytes` less than 36 | server start failure | none | `error` log |
| callback of an environment whose `adapters.ads` is `null`, or of a `<network>` that is not the network name of the chosen adapter | HTTP 404 | none | none |
| the failure count of the callback's client IP in the current minute window reached the limit | HTTP 429 | none | `security` log(`reason` `rate_limited_ip`) |
| callback query format error, query length over `ads-reward.maxQueryBytes` | HTTP 400 | none | none |
| no usable signature key list | HTTP 503 | none | one `error` log line per fetch failure |
| DB failure in callback handling | HTTP 500 | none | `error` log |
| `on_ad_rewarded` throw in the grant order | HTTP 500, no grant. `INTERNAL` for `FakeAdCallback` | none | `error` log |
| value format error of the reward notify ID or the user ID of a callback whose signature matched, the user ID of the callback query is a nonexistent user or a withdrawn user, that user has no ticket of that reward notify ID, the ticket is not `Issued`, `Claimed` | HTTP 200, no grant | none | `warn` log |
| a callback that came again with the same reward notify ID (`DUPLICATE` of `claim_notify`) | HTTP 200, no handling | none | none |
| the access token user of `FakeAdCallback` has no ticket of that reward notify ID, or the ticket is not `Issued`, `Claimed` | `AD_REWARD_NOT_FOUND` | `AD_REWARD_NOT_FOUND` | none |

Added `CoreError`: `AD_LIMIT_REACHED`, `AD_REWARD_PENDING`, `AD_REWARD_NOT_FOUND`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `ads-reward.ticketTtlMs` | integer | core | content | duration after ticket creation during which the callback is accepted. 1 or more |
| `ads-reward.claimWaitMs` | integer | core | content | max duration that `wait_ad_reward` waits for the callback |
| `ads-reward.claimPollIntervalMs` | integer | core | content | interval at which `wait_ad_reward` reads the ticket state again. 1 or more |
| `ads-reward.maxQueryBytes` | integer | core | content | byte length limit of the callback query |
| `ads-reward.keyCacheMs` | integer | core | content | cache duration of the ad network signature key list. 1 or more |
| `ads-reward.keyRefetchIntervalMs` | integer | core | content | minimum interval for fetching the key list again when an unknown key ID arrives |
| `ads-reward.keyFetchTimeoutMs` | integer | core | content | time limit of the call that fetches the ad network signature key list. 1 or more |
| `ads-reward.callbackRateLimitPerMinute` | integer | core | content | limit per IP in one minute window on the number of callbacks whose format or signature failed. 1 or more |
| `environments.<ENV>.adapters.ads` | string? | game | none | ads adapter name. `null` means this environment has no ads adapter |
| `idempotency.maxNotifyIdBytes` | integer | core | content | max bytes of a notify ID. When it is less than 36, the server does not start |
| `routing.externalMaxResponseBytes` | integer | core | content | max bytes of an external service response body. When a body exceeds it, that call is a failure |

settings constraint

| left | factor | right |
|---|---|---|
| `ads-reward.claimWaitMs` | 2 | `NetworkCore.requestTimeoutMs` |

- The key `ads` of the per-environment `adapters` of game settings chooses the adapter. The values are `fake`, `ads-admob`. Client `AdCore` also chooses the ads adapter with the same key
- adapter interface: `parse(query)` → key ID, signed string, signature, reward notify ID, user ID, or a format error. A format error is a query that cannot be split into parameters, or a signature or key ID parameter that is missing, in a different position or in a wrong value format. The reward notify ID and the user ID are values the client sets, so `parse` does not look at their value format and returns a missing value as the empty string. `fetch_keys()` → a key per key ID, or a failure. `verify(signed string, signature, key)` → whether it matches. `fetch_keys` calls the adapter's key source
- `ads-admob` is AdMob server-side verification. In the query, `custom_data` is the reward notify ID, `user_id` is the user ID decimal string, `key_id` is the key ID, and `signature` and `key_id` are the last two parameters of the query. The signed string is the part of the query before `&signature=`, and the signature is an ECDSA P-256 SHA-256 signature written in base64url. The server's key source fetches `keys`(`keyId`, `base64`) of `https://www.gstatic.com/admob/reward/verifier-keys.json` and returns that array as the value. `base64` is an SPKI DER public key

## data

`data/tables/ad_placement.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `type` | `enum<AdType>` | `All` |
| `reward` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |
| `extra_grant` | `bool` | `All` |
| `limit_count` | `int?` | `All` |
| `reset` | `enum<ResetCycle>?` | `All` |
| `min_interval` | `duration?` | `Client` |
| `first_show_after` | `duration?` | `Client` |
| `every_n` | `int?` | `Client` |
| `suppress_if_product` | `array<ref<iap_product.id>>` | `Client` |

- `ResetCycle` is an enum of `server-time`. When `reset` is `null`, the grant count is not reset
- The pacing of client `AdCore` reads `min_interval`, `first_show_after`, `every_n`, `suppress_if_product`. In rows whose `type` is not `Interstitial`, `min_interval`, `first_show_after`, `every_n` are `null`, and in `Rewarded` rows, `suppress_if_product` is an empty array. `min_interval`, `first_show_after`, `every_n`, `limit_count` are 1 or more when present. A violation is data check `out_of_range`
- In rows whose `type` is not `Rewarded`, `reward` is an empty array, `extra_grant` is `false`, and `limit_count` is `null`
- When there is a row whose `type` is `Rewarded`, `reward` is an empty array and `extra_grant` is `false`, or a row that violates the rules of `ad_placement`, the server does not start. `Interstitial`, `Banner` rows correctly have no reward, so this check does not catch them

`data/enums.csv`

| type | element |
|---|---|
| `AdType` | `Rewarded`, `Interstitial`, `Banner` |

reserved ID: `[ad_reward_mail]` → row of `mail_template`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `FakeAdCallback` (core cheat). changes: `ItemBalanceUserState`, `MailUserState`, `AdRewardCountUserState`, `content` | reward notify ID | empty response | `AD_REWARD_NOT_FOUND` | `routing` DEV code. Sent by the fake ads adapter of client `AdCore` and by `testing` |

- `FakeAdCallback` follows the processing order of `cheat`
- Instead of signature verification, `FakeAdCallback` reads the ticket by key (user ID of the access token, reward notify ID). When there is no ticket or it is neither `Issued` nor `Claimed`, `AD_REWARD_NOT_FOUND`. Otherwise, without opening a new user transaction, it runs `idempotency.claim_notify` (source `fake`) and the grant order in the ctx of the cheat. With `DUPLICATE`, an empty response without a grant. The changed UserState, `item_changes`, `item_mails` go in that cheat response
- STG·PROD servers do not have `FakeAdCallback`
- The query of the fake ads adapter is `notify_id=<reward notify ID>&user_id=<user ID decimal string>&key_id=<key ID decimal string>&signature=<signature>`, with the parameters in this order. The signed string is the part of the query before `&signature=`, and the signature is the HMAC-SHA256 of the UTF-8 of the signed string computed with the 32 byte key of that key ID, written in base64url without padding. Value format: `key_id` is a decimal string without leading 0 from 0 to 2^63−1, and `signature` is 43 characters of canonical base64url without padding. When a parameter is missing, the order differs, or the value format of `key_id`, `signature` is wrong, it is a format error
- `fetch_keys` of the fake ads adapter returns the key list that the `testing.fake` controller (service `ads`) set. When none is set, it is one 32 byte secure random key with key ID 1 that the server instance made at start. The operation names of the controller are `parse`, `fetch_keys`, `verify`, and `calls()` records all three. `set_result` sets the `{key_id, key}` list of `fetch_keys` (key is 32 bytes), and `set_failure` sets the failure condition of `fetch_keys`. `rejected` is the same as `communication_failure`. `sign_callback`(reward notify ID, user ID, key ID) returns a query signed with that key

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `FakeAdCallbackRequest` | `notify_id` | `string` | `max_len`: 36 |

## test

- `BeginAdReward` → callback → `ClaimAdReward` grants `reward` once with source `AdReward`
- Even when the callback of the same reward notify ID comes twice, grants only once
- A callback with a wrong signature is HTTP 403 and does not grant
- Sending a query made with `sign_callback` of the `fake` controller (service `ads`) to `GET /ads/callback/fake?<query>` with `testing.send_raw` grants, and a query signed with another key and a query with a key ID that is not in the key list are HTTP 403
- On the `STG` test server, `GET /ads/callback/fake` and `GET /ads/callback/admob` are HTTP 404
- Callbacks of a ticket of another user and of `Replaced`, `Expired` tickets do not grant
- `ClaimAdReward` before the callback is `AD_REWARD_PENDING` after `claimWaitMs`, and the ticket is `Claimed`. Even when `BeginAdReward` of the same placement comes after that, the ticket does not become `Replaced`, and the grant of the late callback arrives as the pending delta of the next response
- While `wait_ad_reward` waits, other requests of the same user and the callback grant of that user are not blocked
- `BeginAdReward` of a placement that is not `Rewarded` is `INVALID_REQUEST`
- When the sum of the grant count and the `Claimed` ticket count reaches `limit_count`, `AD_LIMIT_REACHED`, and it works again after the reset time
- A placement whose `reset` is `null` stays `AD_LIMIT_REACHED` after reaching `limit_count`, even as time passes
- When the grant fails because it exceeds `max_amount`, grants by `[ad_reward_mail]` mail
- A `grant_ad_extra` failure does not change items or the grant count, the ticket is `Failed`, and a callback of the same reward notify ID that comes again is not handled
- When an `ad_placement` row whose `extra_grant` is `true` exists and content does not register `grant_ad_extra`, the server does not start and an `error` log is left
- When the number of callbacks whose format or signature failed reaches the per-IP limit, callbacks of that IP are HTTP 429 without `parse`, `fetch_keys`, `verify`, and they are accepted again in the next minute window. Callbacks from the same IP whose signature matched are not HTTP 429 even when more than the limit come, and do not increment `count`
- A callback whose signature matches and whose user ID is `x` or whose reward notify ID is 37 bytes is HTTP 200, does not grant, and does not increment `count` of `ads_reward_ip_counter`
- When `idempotency.maxNotifyIdBytes` is 35, the server does not start
- A callback within `ads-reward.keyCacheMs` after the key list was fetched does not call `fetch_keys`. Even when callbacks with unknown key IDs follow, `fetch_keys` is called once within `ads-reward.keyRefetchIntervalMs`
- For several concurrent callbacks waiting for the key list fetch, `fetch_keys` is called once
- `FakeAdCallback` does not exist on STG·PROD
- `FakeAdCallback` grants without `INTERNAL`, the delta and `item_changes` of its response have the grant, and a later `ClaimAdReward` succeeds
- When fetching the signature key list exceeds `ads-reward.keyFetchTimeoutMs`, the callback is HTTP 503
- `ClaimAdReward` returns the grant list kept in the ticket, and for a ticket granted by mail returns an empty list and that mail in `item_mails`
- `reset_at` of a `Daily` placement is `server-time.get_next_reset`(`Daily`, request time)
- A grant leaves core analytics event `core_ad_rewarded` for a user who allowed analytics
- `on_ad_rewarded` is called once per callback that granted, and the changes inside it arrive as a pending delta with the grant. It is not called for a ticket that became `Failed` or for a callback that is `DUPLICATE` in `claim_notify`. When the hook throws, the callback is HTTP 500, the ticket, grant count and items stay unchanged, and sending the same callback again grants
