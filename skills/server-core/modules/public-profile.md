# public-profile

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

Builds the profile that other users see (nickname, the `PublicProfile` message that the game defines in `service.proto`, last access time). Also handles the target user judgement that core `rpc`s pointing to another user use.

## dependency

- `storage`
- `nickname`
- `logging`
- `server-time`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `GetPublicProfiles` (core rpc, `silent`). changes: none | `user_ids` | `profiles`: list of `PublicProfileEntry` | `INVALID_REQUEST` | `routing`. Client content code sends it |
| `FindUserByPublicCode` (core rpc). changes: none | `public_code` | `profile`: `PublicProfileEntry` of that user | `INVALID_REQUEST`, `USER_NOT_FOUND`, `RATE_LIMITED` | `routing`. Client content code sends it |
| `get_public_profiles` | ctx, list of user IDs | list of `PublicProfileEntry` | none | content handler, hook, `friend`, `block-report`, `guild`, `chat` |
| `is_active_user` | ctx, user ID | `true` when the `user` row exists and the user is not a withdrawn user | `false` | content handler, hook, `friend`, `block-report`, `chat` |
| `on_request_start` | user ID | async operation. none | none. A failure is an `error` log | `routing`, `auth` |
| `count_find_attempt` | user ID | async operation. `pass` | `RATE_LIMITED`, `UNAUTHORIZED`, `INTERNAL` | `routing` |

- `PublicProfileEntry`(base proto message): `int64 user_id`, `string nickname` (empty string when there is no nickname), `bytes profile` (bytes of the game `PublicProfile` message; empty bytes when there is no hook `build_public_profile`), `int64 last_active_at` (last access time; 0 when there is no record), `string public_code` (the public code of `storage`)
- The output list is in ascending order of user ID and leaves out users for whom `is_active_user` is `false`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `GetPublicProfilesRequest` | `user_ids` | `repeated int64` | `min`: 1, `max`: 2^63−1, `min_count`: 1, `max_count_key`: `public-profile.maxRequestCount`, `unique`: `true` |
| `FindUserByPublicCodeRequest` | `public_code` | `string` | `max_len`: 32 |

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetPublicProfilesResponse` | `profiles` | `repeated PublicProfileEntry` |
| `FindUserByPublicCodeResponse` | `profile` | `PublicProfileEntry` |

## behavior

- profile build runs inside `storage.run_read_only`. For each input user ID whose user has `is_active_user` `true`, calls hook `build_public_profile`, and fills the nickname with `nickname.get_nicknames`
- `get_public_profiles` has no limit on the user ID count. Splits the user ID list in ascending order into groups of `public-profile.maxRequestCount` users and calls `nickname.get_nicknames` once per group
- The ctx of `build_public_profile` is the ctx of the user who requested the profile. The hook reads the public kind of the target user with `storage.read_public_state`, and builds `PublicProfile` from those values and `data` of ctx. The profile of the requester's own user ID is built the same way
- `PublicProfile` is a module message, and the game that registers hook `build_public_profile` defines it
- There is no cache. Each call builds the profiles and writes nothing
- `is_active_user` judges with `storage.get_user_record`(`storage.db`(ctx), user ID)
- profile build fills `public_code` with `public_code` of `storage.get_user_record`

### find by public code

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `public_profile_find_counter` | `user` | `user_id`, `window_start`, `count`, `expires_at` | `user_id` | `expires_at` |

- `public_profile_find_counter` is registered with snapshot flag `false`
- `count_find_attempt`: in its own `storage.run_user_transaction`, sets that user's `public_profile_find_counter` row to the current minute window of `server-time` (`count` 0 when the row is of another window, `expires_at` the window end), increments `count` by 1 and commits, whatever the find gives later. When the incremented value exceeds `public-profile.findPerMinute`, the result is `RATE_LIMITED`. When `run_user_transaction` is `WITHDRAWN`, the result is `UNAUTHORIZED`; when it is `FAILED`, `INTERNAL`; and the count does not increase. `routing` calls it before the request transaction (request prepare)
- `FindUserByPublicCode`: when `storage.is_public_code_input` of `public_code` is `false`, `INVALID_REQUEST`; otherwise finds the user with `storage.find_user_by_public_code`; when no user is found or `is_active_user` of that user is `false`, `USER_NOT_FOUND`. Otherwise the response is the profile of that user, built as `GetPublicProfiles` builds it. A failed find also counts, so codes are not found by trying many

### last active

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `public_profile_activity` | `user` | `user_id`, `last_active_at` | `user_id` | none |

- `public_profile_activity` is registered with snapshot flag `false`
- `on_request_start` is called in the request start step of `routing`. Computes v = ⌊`server-time.clock_now` ÷ `public-profile.lastActiveGranularityMs`⌋ × `public-profile.lastActiveGranularityMs`. When that user's `public_profile_activity` row read with `storage.read_db` does not exist or its `last_active_at` < v, writes the larger of v and the saved value to `last_active_at` of that row in one out-of-request change opened with `storage.run_user_transaction`. On `WITHDRAWN`, does nothing. When the transaction fails, leaves an `error` log and continues handling the original request
- When `public-profile.lastActiveGranularityMs` is 0, `on_request_start` does nothing, and `last_active_at` of a profile is always 0
- profile build fills `last_active_at` with the value of that user's `public_profile_activity` row. When there is no row, 0

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `build_public_profile` | per target user in profile build | ctx(read-only), target user ID | bytes of the `PublicProfile` message | empty bytes |

- An output over `public-profile.maxProfileBytes` is handled as an output in a wrong format

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation of `user_ids` (count, element less than 1, duplicate) | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `public_code` of `FindUserByPublicCode` that is not a public code input | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| more `FindUserByPublicCode` of one user than `public-profile.findPerMinute` in one minute window | `RATE_LIMITED` | `RATE_LIMITED` | none |
| the user transaction of `count_find_attempt` is `WITHDRAWN` | `UNAUTHORIZED` | `UNAUTHORIZED` | none |
| the user transaction of `count_find_attempt` is `FAILED` | `INTERNAL` | `INTERNAL` | `error` log |
| throw of the hook, output in a wrong format, write inside the hook | throw. The message of the throw holds the target user ID | `INTERNAL` | `error` log by `routing` |
| transaction failure of `on_request_start` | none. The request continues to be handled | none | `error` log |

Added `CoreError`: `USER_NOT_FOUND`. A core `rpc` that points to another user returns it when `is_active_user` of the target user is `false`. The module spec that exposes that `rpc` decides which `rpc` makes this judgement and at which step

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `public-profile.maxRequestCount` | integer | core | content | limit on the user count of one `GetPublicProfiles`, and the user count that `get_public_profiles` passes to one `nickname.get_nicknames` call |
| `public-profile.maxProfileBytes` | integer | core | content | maximum bytes of one hook output |
| `nickname.maxLookupCount` | integer | core | content | upper bound of `public-profile.maxRequestCount` |
| `public-profile.lastActiveGranularityMs` | integer | core | content | unit that `last_active_at` is rounded down to. 0 means no record |
| `public-profile.findPerMinute` | integer | core | content | most `FindUserByPublicCode` requests of one user in one minute window. 1 or more |

settings constraint

| left | factor | right |
|---|---|---|
| `public-profile.maxRequestCount` | 1 | `nickname.maxLookupCount` |

## data

none

## DEV

none

## test

- The `profile` built from another user's public kind and the nickname come in ascending order of user ID. The requester's own user ID also comes
- User IDs that do not exist and withdrawn users are not in the output
- Passing `public-profile.maxRequestCount` × 2 + 1 users to `get_public_profiles` does not throw and returns the profiles of all active users in ascending order of user ID
- Without the hook, `profile` is empty bytes and the nickname is filled
- Reading a kind that is not a public kind with `read_public_state` or calling `put_state` inside the hook is `INTERNAL`, and the saved state stays
- `user_ids` over the limit, an empty list, an element 0 and a duplicate are `INVALID_REQUEST`
- A hook output over `public-profile.maxProfileBytes` is `INTERNAL`
- After `GetPublicProfiles`, the saved state stays and `user_state` of the response is empty
- `is_active_user` is `false` for a user that does not exist and for a withdrawn user, and `true` for an existing user
- After a request, that user's `last_active_at` is `clock_now` at request start rounded down to `public-profile.lastActiveGranularityMs`, and the next request within the same unit does not write the `public_profile_activity` row. The same holds after `Login`
- `last_active_at` of a user without a record is 0. When `public-profile.lastActiveGranularityMs` is 0, it is 0 also after a request
- Even when the transaction of `on_request_start` fails, the handler is called and one `error` log is left
- After `Withdraw`, that user has no `public_profile_activity` row
- `PublicProfileEntry` of `GetPublicProfiles` has the public code of each user
- `FindUserByPublicCode` with a user's public code (also lowercase with `-`) gives that user's profile; a code no user has and the code of a withdrawn user are `USER_NOT_FOUND`; a text that is not a public code input is `INVALID_REQUEST`
- With `public-profile.findPerMinute` 3, the 4th `FindUserByPublicCode` in one minute window is `RATE_LIMITED` also when the earlier ones were `USER_NOT_FOUND`, and the first one of the next window is handled
- After `Withdraw`, that user has no `public_profile_find_counter` row
