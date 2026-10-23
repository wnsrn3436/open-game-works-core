# session

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

Keeps one session per user and checks the request signature with the session signing key. Login opens the session and gives the access token and the session signing key together.

## dependency

- `storage`
- `server-time`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `start_session` | ctx | `session_id` (session ID), `signing_key` (session signing key) | none | `auth` |
| `end_session` | ctx | none | none | `auth`, `user-snapshot-clone` |
| `check_current` | user ID, session ID | `pass` when it is the current session | `UNAUTHORIZED`, `SESSION_REPLACED` | `routing`, `auth`, `push`, `matchmaker` |
| `verify_signature` | user ID, session ID, signature name, request ID, `X-Ogw-Timestamp`, `X-Ogw-Signature`, body | `pass` | `UNAUTHORIZED`, `SESSION_REPLACED` | `routing`, `auth` |
| `sign_request` | session signing key, signature name, request ID, `X-Ogw-Timestamp`, body | `X-Ogw-Signature` value by the request signature rules | none | `testing` |
| `Resync` (core rpc, `silent`). changes: none | `full` | empty response | none | `routing`. Client `NetworkCore` sends it |

- session exports the handler of `Resync`, and `routing` collects it

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ResyncRequest` | `full` | `bool` | none |

## behavior

### session

- A session opens on a successful `Login`, `AutoLogin` or `DevLogin`, and ends when the next session of that user opens, when it is closed with `end_session`, or when its session record is deleted by withdrawal. `end_session` is called on `Logout` and on the import and the clone wipe of `user-snapshot-clone`. `RefreshToken` does not change the session
- A user has one session. When a new session opens, the access token and the session signing key of the previous session become invalid. The login token follows the login token rules of `auth` and does not become invalid when a new session opens
- session record: `user_id` (`int64`), `session_id` (`string`. base64url of 16 bytes of secure random), `signing_key` (`string`. base64url of 32 bytes of secure random), `started_at` (`int64`. `server-time.now`(ctx)). Registered with `storage.register_table` as table `session_current` (`user` scope, key `user_id`, excluded from snapshots)
- `start_session` deletes the previous session record of that user and writes a new record
- `check_current`: `UNAUTHORIZED` when there is no session record, `SESSION_REPLACED` when the session ID of the record differs
- `check_current` and `verify_signature` read the session record with `storage.read_db`
- The client keeps the session signing key only in memory

### Resync

- `Resync` is a request that does not change the saved state. It goes through the request processing order of `routing` as it is. So the envelope carries the server time, the changes of the request start step and the accumulated pending delta
- When `full` is `true`, the handler calls `storage.read_full_state`(ctx). `### pending delta` of `storage` defines its response delta

### request signature

- Every request except `NoSignatureRpc` has the following headers
  - `X-Ogw-Timestamp`: the server time that the client estimated. A decimal integer of Unix ms, with no sign and no leading zeros, less than 2^63. 0 is `0`
  - `X-Ogw-Signature`: the HMAC-SHA256 of the signature input, written in lowercase hex. The HMAC key is the UTF-8 bytes of the session signing key string
- The signature input is the UTF-8 string that joins with `\n`, in this order, the signature name, the request ID, the `X-Ogw-Timestamp` value and the lowercase hex of the SHA-256 of the body
  - The signature name is the request name of the contract. e.g. `ClaimQuestReward`, `core/RefreshToken`, `core/cheat/SetTimeOffset`
- `verify_signature` reads the session record once, checks the following conditions in order and returns the failure value of the first condition that holds. When no condition holds, `pass`
  1. A header is missing or its format is wrong: `UNAUTHORIZED`
  2. There is no session record of that user: `UNAUTHORIZED`
  3. The session ID of the record differs from the session ID of the input: `SESSION_REPLACED`
  4. The signature differs: `UNAUTHORIZED`. The comparison is done in constant time
  5. The absolute value of the difference between `X-Ogw-Timestamp` and the comparison time exceeds `session.signatureWindowMs`: `UNAUTHORIZED`. The comparison time is `server-time.user_now`
- Even when the signature matches, the server does the judgement. The signature checks only the origin of the request and whether it was tampered with

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| no session, signature mismatch, timestamp outside the window | `UNAUTHORIZED` | `UNAUTHORIZED` | none |
| request of the previous session after another session opened | `SESSION_REPLACED` | `SESSION_REPLACED` | none |

- session leaves no logs. `routing` leaves the `security` log of failures

Added `CoreError`: `SESSION_REPLACED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `session.signatureWindowMs` | integer | core | content | allowed difference between `X-Ogw-Timestamp` and the comparison time |

## data

none

## DEV

- In an environment that includes DEV code, the cheat time offset of the user goes into the comparison time `user_now`

## test

- After a second login, an access token request of the first session and `RefreshToken` with the login token of the first session are `SESSION_REPLACED`
- After `Logout`, a request of that session is `UNAUTHORIZED`
- A request in which one byte of the body, the request ID, the signature name or the timestamp was changed is `UNAUTHORIZED`
- A timestamp inside the window boundary gives `pass`, and one 1ms outside it gives `UNAUTHORIZED`
- `verify_signature` treats the `X-Ogw-Signature` that `sign_request` made as `pass`
- After a second login, `verify_signature` of a request signed with the session ID and the session signing key of the first session is `SESSION_REPLACED`
- The signature name is the request name, and the signatures of a game `rpc` and a core `rpc` with the same name do not pass on each other's requests
- Even after `RefreshToken`, a signature with the same session signing key passes
- The accumulated pending delta is carried in `pending_user_state` of the `Resync` response, and the saved state stays the same
- For a user with accumulated pending delta and pending `ItemChange`, the `user_state` of the `Resync` response with `full` `true` has `full` `true` and holds all UserState of that user, `pending_user_state` is empty, `item_changes` is that `ItemChange`, and after that the user has no pending delta rows
- The log does not contain the raw signature of a request whose signature check failed
