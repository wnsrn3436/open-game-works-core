# idempotency

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

Returns the saved response unchanged to a request that comes again with the same request ID, and handles external service callbacks and notifications inside core only once by notify ID.

## dependency

- `storage`
- `server-time`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `find_response` | ctx | saved response bytes with `server_time_at` changed, or none | `NAME_MISMATCH` | `routing` |
| `find_committed_response` | DB handle, user ID, request ID, request name, response time | saved response bytes with `server_time_at` changed to the received response time, or none | `NAME_MISMATCH` | `routing` |
| `save_response` | ctx, response bytes | none | none | `routing` |
| `save_withdrawn_response` | ctx, access token hash, response bytes | none | none | `routing` |
| `find_withdrawn_response` | DB handle, access token hash, request ID, request name, response time | saved response bytes with `server_time_at` changed to the received response time, or none | `NAME_MISMATCH` | `routing` |
| `has_response` | DB handle, user ID, request ID | `true` when there is a saved response | `false` | `routing` |
| `claim_notify` | ctx or game tx, source, notify ID | `FIRST`, `DUPLICATE` | none | `iap`, `ads-reward` |

- The source names the side that creates the notify ID. e.g. `iap-apple`, `ads-admob`
- The access token hash takes the SHA-256 of the UTF-8 bytes of the access token string, as lowercase hex
- Each notify ID is a string of at least 1 byte and at most `idempotency.maxNotifyIdBytes` bytes. Outside that range, `claim_notify` throws. The module that receives a callback checks the length before `claim_notify`, and does not call `claim_notify` with a notify ID outside that range

## behavior

### request ID

- Targets are requests authenticated with an access token and cheat requests. `NoAccessTokenRpc` is not saved
- The key is `(user ID, request ID)`
- `routing` calls `find_response` after it opens the user transaction. For a cheat request, the DEV code of `routing` calls it the same way. Because of per-user serialization, when the same request ID is in handling, the later request finds the saved response after the earlier request ends
- When there is a saved row and the request name equals, the handler is not called. `find_response` returns the saved `ResponseEnvelope` with only `server_time_at` changed to `request_time` of ctx. The delta, `item_changes`, `item_mails` and body equal the first response
- When the request name of the saved row differs, the result is `NAME_MISMATCH`. The saved response stays unchanged. `routing` decides the response and the log
- `has_response` only checks whether a saved row of `(user ID, request ID)` exists. It does not look at the request name. A row whose `expires_at` has been reached counts as no row
- The time that `find_response`, `find_committed_response` and `has_response` compare with `expires_at` is `server-time.clock_now`
- `routing` calls `find_committed_response` with a `storage.read_db` handle after authentication and before the user transaction. It looks only at committed saved rows, and its judgement equals that of `find_response`. It does not find the same request ID while that request is in handling; `find_response` finds that request
- `save_response` and `save_withdrawn_response` save only success responses. When the received `ResponseEnvelope` has `error`, they do not save it. Because error responses are not saved, a resend with the same request ID is handled again from the start
- `save_response` does not save when `user_deleted` of ctx is `true`. The response of a request that called `storage.delete_user` (`Withdraw`, `ConfirmAge` below the minimum age) is not kept in `idempotency_response`; it is kept as a withdrawn response
- `created_at` of a saved row is `server-time.clock_now` at `save_response`, and `expires_at` is `created_at` + `idempotency.responseRetentionMs`. `storage.sweep_expired` deletes expired rows
- When `idempotency.responseRetentionMs` is at most 2 × `session.signatureWindowMs` or at most `NetworkCore.maxRetryAgeMs` + `NetworkCore.requestTimeoutMs`, the server does not start

### notify ID

- When there is no row of `(source, notify ID)` or the row is expired, `claim_notify` records it with one upsert statement and returns `FIRST`; when there is an unexpired row, it returns `DUPLICATE`
- `idempotency_notify` is a `game` scope table and is also used in a user transaction. The calling module calls `claim_notify` in the same transaction as the handling. When the handling is rolled back, the record is also gone, and the next resend is handled again
- On `DUPLICATE`, the calling module does not handle it and sends a success response
- `created_at` of a record is `clock_now` at `claim_notify`, and `expires_at` is `created_at` + `idempotency.notifyRetentionMs`. `idempotency.notifyRetentionMs` is longer than the sender's resend period

### withdrawn response

- withdrawn response: the success response of a request whose ctx has `user_deleted` `true`. Because that user's session and user scope rows are deleted and it cannot be found by `(user ID, request ID)`, the key is `(access token hash, request ID)`
- `save_withdrawn_response` writes a row to `idempotency_withdrawn_response` only when `user_deleted` of ctx is `true`, and does nothing when it is `false`. `created_at` is `server-time.clock_now`, and `expires_at` is `created_at` + `idempotency.responseRetentionMs`
- `find_withdrawn_response` looks only at committed rows whose `expires_at` the received response time has not reached. When that row's request name equals, it returns the saved `ResponseEnvelope` with only `server_time_at` changed to the received response time; when it differs, `NAME_MISMATCH`; when there is no row, none

### table

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `idempotency_response` | `user` | `user_id`(`int64`), `request_id`(`string`), `request_name`(`string`), `response`(`bytes`), `created_at`(`int64`), `expires_at`(`int64`) | `(user_id, request_id)` | `expires_at` |
| `idempotency_notify` | `game` | `source`(`string`), `notify_id`(`string`), `created_at`(`int64`), `expires_at`(`int64`) | `(source, notify_id)` | `expires_at` |
| `idempotency_withdrawn_response` | `game` | `token_hash`(`string`), `request_id`(`string`), `request_name`(`string`), `response`(`bytes`), `created_at`(`int64`), `expires_at`(`int64`) | `(token_hash, request_id)` | `expires_at` |

- The three tables are registered with `storage.register_table`. `idempotency_response` is excluded from snapshots

## hook

none

## event

none

## error

idempotency leaves no log.

| condition | failure value | error code | log |
|---|---|---|---|
| same request ID, different request name | `NAME_MISMATCH`. `routing` leaves a `security` log | `INVALID_REQUEST` | none |
| notify ID length violation | throw | none | none |
| `idempotency.responseRetentionMs` violates the server start check | server start failure | none | none |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `idempotency.responseRetentionMs` | integer | core | content | duration a saved response is kept |
| `session.signatureWindowMs` | integer | core | content | allowed time difference of a request signature. Read only for the server start check |
| `NetworkCore.maxRetryAgeMs` | integer | core | content | maximum elapsed duration within which the client can send again with the same request ID. Read only for the server start check |
| `NetworkCore.requestTimeoutMs` | integer | core | content | timeout of one client send. Read only for the server start check |
| `idempotency.notifyRetentionMs` | integer | core | content | duration a handled notify ID is kept |
| `idempotency.maxNotifyIdBytes` | integer | core | content | maximum bytes of a notify ID |

## data

none

## DEV

none

## test

- For a request sent twice with the same request ID, the handler is called once, and the fields of the two responses other than `server_time_at` are equal
- After `advance_time`, `server_time_at` of the response to a request sent again with the same request ID is the request time of the resent request, and the delta and body equal the first response
- A request with the same request ID that arrives while the first request is in handling receives the first response
- Sending a different request name with the request ID of request A does not call the handler, gives `INVALID_REQUEST`, and keeps A's saved response
- An error response is not saved, and a resend with the same request ID calls the handler again
- After `Withdraw` succeeds, `idempotency_response` has no row of that user, and `idempotency_withdrawn_response` has one row of that access token hash and request ID
- The same request ID of different users does not affect the other user
- `find_committed_response` returns a committed saved row with only `server_time_at` changed; a different request name gives `NAME_MISMATCH`, and a missing row gives none
- A saved response past its retention duration is deleted, and after that the same request ID is handled as a new request
- A saved response whose `expires_at` has passed but that is not yet deleted is not found. A request with the same request ID calls the handler, and a new response is saved
- `claim_notify` of a notify ID whose `expires_at` has passed but that is not yet deleted returns `FIRST`
- The second `claim_notify` of the same notify ID returns `DUPLICATE`
- The notify ID of rolled-back handling returns `FIRST` on the next resend
- The server does not start with core settings where `idempotency.responseRetentionMs` equals 2 × `session.signatureWindowMs` or equals `NetworkCore.maxRetryAgeMs` + `NetworkCore.requestTimeoutMs`
- For a user with a cheat time offset set, `created_at` of the saved response is `clock_now`, and before `clock_now` reaches `created_at` + `idempotency.responseRetentionMs`, the saved response is returned for the same request ID
- `find_withdrawn_response` returns a committed row with only `server_time_at` changed; a different request name gives `NAME_MISMATCH`, and a missing row or a row whose `expires_at` the received response time has reached gives none
- `save_withdrawn_response` with `user_deleted` of ctx `false` writes no row
