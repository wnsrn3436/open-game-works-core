# routing

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

Receives HTTP requests, checks them in a fixed order, makes the request ctx and calls the handler, and responds with `ResponseEnvelope`. Handles handler registration, rate limit, body limit and CORS.

## dependency

- `validation`
- `auth`
- `session`
- `storage`
- `idempotency`
- `server-time`
- `logging`
- `admin-api`
- `game-update`
- `item-ledger`
- `mailbox`
- dev dependency: `cheat`
- optional dependency: `live-event`, `shop`, `iap`, `ads-reward`, `ranking`, `tutorial`, `push`, `matchmaker`, `migration`, `user-snapshot-clone`, `gacha`, `loot-table`, `mission`, `attendance`, `coupon`, `notice`, `remote-config`, `nickname`, `public-profile`, `friend`, `block-report`, `guild`, `chat`, `play-session`, `reset-counter`, `rating`

routing is the entry point of the server process. Modules other than `testing` do not call routing and do not depend on routing. `testing` depends on routing to start test servers. A module exports the core `rpc` handlers, routes and `on_request_start` whose caller in `## API` is `routing`, and a module other than `admin-api` exports the admin operations whose caller is `operator`. routing collects them at server start.

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_handler` | `rpc` name of `service Game`, handler | none | none. A registration error is a server start failure | `register` of content `server/main.ts` |
| `register_hook` | module name, hook name, hook | none | none. A registration error is a server start failure | `register` of content `server/main.ts` |
| `register_admin_operation` | content admin operation. Its format is the same as an admin operation that a module exports (`admin-api`) | none | none. A registration error is a server start failure | `register` of content `server/main.ts` |
| `create_server` | server start arguments (the `## server start` table of the `server-core` SKILL), server module list, server build data folder, merged core settings, game settings values that core reads, content registration function `register`, whether DEV code is included and the content registration function `registerDev` when it is included, override of core settings and game settings values (optional), key source override per adapter key (optional), outgoing HTTP adapter override (optional), log line writer override (optional), fake adapter override per adapter key (optional) | server instance that has not started | Throws on an input format violation | server process entry point, `testing`, server core test |

- handler: the input is ctx and the request message, and the output is the response message or `GameError`. The type is `GameContract.<Name>Handler`, which the contract tool generated for each `rpc` of `service Game`. `storage` defines ctx
- TypeScript form of `create_server`: the input is one object, and its fields are `args` (server start arguments. `env`, `port`, `matchmaker`, `db`, `secret_file`), `server_modules`, `data_folder`, `core_settings`, `game_settings`, `register`, `dev` (whether DEV code is included), `register_dev`, `settings_overrides`, `key_sources`, `http_adapter`, `log_writer`, `fake_adapters`. The override fields are optional, and an override per adapter key is an object keyed by adapter key. `start()` returns the listened port number (`number`) or a failure reason string. The input of `dev` is the module name, the operation name, the array of operation inputs and the user ID (optional)
- What a module exports
  - core `rpc` handler: a core `rpc` name of the base proto and its handler. The input is ctx and the request message, and a core `rpc` in the request prepare table also receives the prepare value. The output is one of a response message, `GameError` and `CoreError`. The module that exports the handler defines the handler type. It goes through the request processing order of this spec as it is
  - core `rpc` handler without a token: the handler of a request among `NoAccessTokenRpc` that is not `NoUserRpc`. The input is the common header values, the body bytes, the decoded request message and the client IP. The output is the response message and the response delta, or `CoreError` (with `BanDetail` when `BANNED`), and both carry the user ID that the handler decided (none when it could not decide one) and the ctx of the request transaction that the handler opened (none when it did not open one). `server_time_at` and the `request` log use that user ID and ctx. The handler opens the user transaction with `storage.run_request_transaction`. The response delta of a handler that does not open a user transaction is empty
  - route: HTTP method, path or path prefix, route handler. Used for paths that are not game requests. e.g. `POST /iap/notify/<store>`, `GET /ads/callback/<network>`, `POST /admin/<operation>`, `GET /account/deletion`, `POST /account/deletion`, `GET /update/deploy_list.json`, `GET /update/deploy_list.json.sig`, `GET /update/files/<sha256>`, `GET /realtime`. The input of the route handler is the HTTP request and the client IP that routing decided. The spec of the exporting module defines the processing order and the response format of that path
  - `on_request_start`: an operation that receives the user ID. Called in the request start step
  - hook slot: one for each hook in the `## hook` table of the module spec for which that module has no separate registration operation. When `register` ends, routing puts the hooks received with `register_hook` into the hook slots of that module. A slot that received no hook is empty, and on an empty slot the module acts by the `default` of the hook table
  - cheat handler: a cheat written in `## DEV` of the module. The DEV code of routing collects them and handles them with the processing order of `cheat`
  - admin operation: routing does not handle it and passes it to `admin-api.register_admin_operation` at server start
- TypeScript form of the exports. They are members of the module object and the DEV object
  - core `rpc` handler: a method whose name is the core `rpc` name without `core/` (e.g. `Resync`, `Login`)
  - route: a method whose name is the route string written in the spec (e.g. `GET /update/files/<sha256>`). A `<name>` position matches one non-empty path segment. The input is the route request and the client IP, and the output is the route response, or `null` when the handler took over the connection (WebSocket). It can return a `Promise`
  - route request: `method`, `path` (the path without the query string), `query` (the query string without `?`. Empty string when there is none), `headers` (object keyed by lowercase header names), `read_body(max bytes, time limit ms)` (async. The body bytes, or `null` when the max bytes or the time limit is exceeded), `upgrade` (for a WebSocket upgrade request, `{socket, head}` (the raw socket and the bytes read after the request head). Otherwise `null`. The route handler does the handshake)
  - route response: `status`, `headers` (optional), `body` (optional. bytes or string)
  - `on_request_start`: a method of the same name
  - hook slot: member `hook_slots`. One key per hook name, and the value is the registered hook or `null`
  - admin operation: a member whose name is the admin operation name. The value is the admin operation object that `admin-api` defines
  - cheat handler: a method of the DEV object. Its name is the cheat name without `core/cheat/`

## behavior

### server start

- `create_server` makes one server instance. A server instance has the following
  - `start()`: async operation. Does the server start of this section, starts listening on `--port`, then calls `server-time.end_start()`. On success, the listened port number; on server start failure, the failure reason
  - `stop()`: async operation. Stops accepting new connections, discards in-progress requests, jobs, out-of-request changes and `storage.after_commit` functions without waiting for them, rolls back open transactions and closes the DB connections
  - `modules()`: a Map from each module name to the prepared module object (the whole module object, not member `content`). Only server core tests call it
  - `dev`: exists only on a server instance that includes DEV code. Calls a module DEV operation of that instance (`server-time.set_clock`, `wait_idle`, `storage.set_seed_provider`, the operations that `testing.call_dev` calls) with a module name, an operation name, input and a user ID (optional). For an operation that receives ctx, opens `storage.run_user_transaction` of that instance with that user ID and passes the out-of-request ctx that the change function received to the operation. When the operation returns output, the change function returns `pass` to commit, and `dev` returns that output after the commit. When the operation returns a failure value, the change function returns `CoreError` `INTERNAL` to roll back, and `dev` returns that failure value. When an operation that receives ctx is called without a user ID, the operation throws, or `run_user_transaction` is `WITHDRAWN` or `FAILED`, `dev` throws. An operation that does not receive ctx is called without opening a transaction, and its output or failure value is returned. `server-time.set_clock` and `storage.set_seed_provider` are called only after `create_server` and before `start()`. The test clock and the seed setting they set are used from the server start of `start()`. So time reads during server start and the job that runs once when server start ends also use the test clock. The two calls throw after `start()` has been called
- Only `testing` and server core tests pass overrides. A key source override changes the key source that the adapter of that adapter key uses, and an outgoing HTTP adapter override sends all outgoing HTTP of that instance to that adapter. A log line writer override is a function called for each server log line of that instance; when it is given, that instance does not write to stdout. A fake adapter override makes the instance, when that adapter key picks the fake adapter, use the received fake adapter instead of making a new fake adapter
- At server start, the server instance reads the server build data, `client_data_version`, `compat_client_data_version` when it exists, the contract generated code and the core settings, prepares the modules of the server module list in dependency order, calls registration function `register(core)` of content `server/main.ts` once, and collects what the prepared modules export. After calling `registerDev` and before calling `complete_start()` of the modules, it passes the collected admin operations and the content admin operations that content registered with `register_admin_operation` (module name `game`) to `admin-api.register_admin_operation`
- When any of the following holds, leaves an error log and the server does not start
  - An `rpc` of `service Game` has no handler
  - `register_handler` was called with an `rpc` name that is not in `service Game`
  - `register_hook` was called with a module name that routing did not prepare, or with a hook name that is not a hook slot of that module
  - The same `rpc` name or the same (module name, hook name) was registered twice
  - `register_handler`, `register_hook` or `register_admin_operation` was called outside `register`. A call inside `registerDev` is also outside `register`
  - The name of a content admin operation does not start with `game_`
  - Two modules exported the same core `rpc`, the same route or the same cheat name
  - A core `rpc` in the spec `## API` of a prepared module has no handler
  - A core `rpc` of a prepared module has no server field validator made by the contract tool. On a server instance that includes DEV code, the same applies to the core cheats of the prepared modules
  - `client_data_version` is missing or is not in the `<protocol hash>-<data hash>` format
  - `compat_client_data_version` exists and is not in the `<protocol hash>-<data hash>` format, or its protocol hash equals that of `client_data_version`
- At server start, routing registers job `storage_sweep` (period `routing.storageSweepIntervalMs`) with `server-time.schedule_job`. The job calls `storage.sweep_expired` and right after it `run_user_changes`. When either is `FAILED`, leaves an `error` log
- When a module returns a failure during server start, leaves the reason in an `error` log and the server does not start

### path

| path | handling |
|---|---|
| `POST /<rpc name>` | game `rpc`. The request processing order below |
| `POST /core/<rpc name>` | core `rpc` of a prepared module. The request processing order below. A core `rpc` of a module that was not prepared falls under other paths |
| `POST /cheat/<cheat name>`, `POST /core/cheat/<cheat name>` | In an environment that includes DEV code, the DEV code of routing handles it with the dev access check and the processing order of `cheat`. STG·PROD do not read the body and give `UNAUTHORIZED`, `security` log (`reason` `cheat_path_closed`) |
| `OPTIONS /<rpc name>`, `OPTIONS /core/<rpc name>` | CORS preflight |
| `OPTIONS /cheat/<cheat name>`, `OPTIONS /core/cheat/<cheat name>` | CORS preflight in an environment that includes DEV code. STG·PROD give HTTP 404, no body |
| route that a module exported | handling by the exporting module |
| other paths and methods | HTTP 404, no body |

### request processing order

Handles one game request in the following order. When a step fails, responds with the error of that step and ends. A request that ended before step 15 does not call the handler. The implementation keeps this order as sequential calls inside one function.

1. CORS: when there is an `Origin` header and it is not an allowed origin, HTTP 403, no CORS header
2. body limit: `INVALID_REQUEST` when there is a `Content-Encoding` header, or `Content-Type` is not `application/x-protobuf`, or the accumulated body exceeds `routing.maxBodyBytes`, or the whole body read duration exceeds `routing.bodyReadTimeoutMs`. Cuts off by accumulating the received bytes, regardless of `Content-Length`
3. common header: `INVALID_REQUEST` when a format in the table below is wrong
4. maintenance: `MAINTENANCE` when `admin-api.is_maintenance` is `true`
5. authentication: when the request name is `core/Withdraw` or `core/ConfirmAge`, first calls `idempotency.find_withdrawn_response`(`storage.read_db`, access token hash of `Authorization`, request ID, request name, `server-time.clock_now`). When it finds a saved response, skips the authentication below and steps 6 to 16 and does step 17 with those bytes. On `NAME_MISMATCH`, `INVALID_REQUEST` and a `security` log. Then calls `auth.verify_access_token`, `session.check_current` and `session.verify_signature`. A failure is the failure value of that operation. On a failure other than `TOKEN_EXPIRED`, leaves a `security` log and adds one to the IP counter. When it passes, calls `idempotency.find_committed_response`(`storage.read_db`, user ID, request ID, request name, `server-time.user_now` of that user). When it finds a saved response, skips steps 6 to 16 and does step 17 with those bytes. On `NAME_MISMATCH`, `INVALID_REQUEST` and a `security` log
6. ban: `BANNED` when `admin-api.is_banned` is `true` and the request name is not `core/IssueDeletionCode`. `ServerError.ban` carries the user ID, the `until_at` that `is_banned` returned, and `deletion_url`
7. data version: of `client_data_version` and `compat_client_data_version`, the one whose protocol hash equals that of `X-Ogw-Data-Version` is the reference version. When there is none, `APP_UPDATE_REQUIRED`. When the data hash differs from the reference version, `DATA_UPDATE_REQUIRED` only when `X-Ogw-Client-Version` is an empty string or `game-update.is_data_update_ready`(`X-Ogw-Client-Version`) is `true`; otherwise goes to the next step. As an exception, core `rpc` `FinishPlaySession`, `ContinuePlaySession` and `ReportMatchResult` go to the next step without `DATA_UPDATE_REQUIRED` when only the data hash differs. This is to receive the continue and the result of a play started before the data update. The data rows that recalculate the result do not change, by the deterministic simulation rules of `client-content`
8. rate limit: adds one to the user counter; `RATE_LIMITED` when it exceeds `routing.userRateLimitPerMinute`. `ReportClientErrors` and `ReportAnalyticsEvents` call `logging.count_report_request`(user ID) instead of the user counter and, on a failure value, end with that error
9. kill switch: `FEATURE_DISABLED` when `admin-api.is_kill_switched` is `true` for the request name of this request
10. decode: `INVALID_REQUEST` when the body cannot be decoded into the request message
11. field validation: `INVALID_REQUEST` when `validation.validate_request` fails
12. request start: calls the `on_request_start` operations of the request start table below in order. Each operation opens and closes its own user transaction. Goes to the next step even when one fails
13. transaction start: opens a user transaction with `storage.run_request_transaction` and makes ctx. Steps 14 to 16 run inside that function. `UNAUTHORIZED` on `WITHDRAWN`, `INTERNAL` on `FAILED`
14. idempotency: when `idempotency.find_response` finds a saved response, closes the transaction and responds with those bytes. On `NAME_MISMATCH`, saves nothing and gives `INVALID_REQUEST` and a `security` log
15. handler run: on `GameError` or `CoreError`, rolls back and responds with that error. When a `GameError` that a core `rpc` handler returned is not in the `(ogw.core_errors)` list of that core `rpc` in the contract generated code, responds with `INTERNAL` instead of that `GameError` and leaves the request name and the `GameError` value in an `error` log
16. commit: gets the response delta and the unknown kind row list with `storage.take_response_delta` and makes the `ResponseEnvelope`. When that list is not empty, calls `logging.annotate_request_log`(ctx, field `unknown_kinds`: the list joined with `,` as one string, minimum level `warn`). Saves with `idempotency.save_response` and `save_withdrawn_response`(ctx, access token hash of `Authorization`, the bytes of that `ResponseEnvelope`) and commits. On failure, rolls back and gives `INTERNAL`
17. response: sends the `ResponseEnvelope` with HTTP 200. Leaves one `request` log line with `logging.write`. For a request that made ctx, writes the fields and the minimum level received with `logging.take_request_log_annotation`(ctx) to that line. `logging` defines the level and the fields

request start

| order | operation |
|---|---|
| 1 | `live-event.on_request_start` |
| 2 | `mailbox.on_request_start` |
| 3 | `public-profile.on_request_start` |

- request prepare: for a core `rpc` in the request prepare table, after step 12 and before step 13, routing calls its prepare operation outside the transaction with the user ID, the request message, the client IP and the request ID as arguments in this order. The `input` of the `## API` row of the prepare operation is a leading part of these four inputs. It is also called on a resend with the same request ID. As an exception, for `RedeemCoupon` it is not called when `idempotency.has_response`(`storage.read_db`, user ID, request ID) is `true`. When the prepare operation opens a user transaction, it commits inside it. The output is a prepare value or `CoreError`. On `CoreError`, skips steps 13 to 16 and responds with that error. The prepare value is passed to that core `rpc` handler together with the request message

request prepare

| core `rpc` | prepare operation |
|---|---|
| `ClaimAdReward` | `ads-reward.wait_ad_reward` |
| `RedeemCoupon` | `coupon.count_redeem_attempt` |
| `LinkAccount` | `auth.prepare_link_account` |
| `VerifyPurchase`, `RecoverPurchase` | `iap.prepare_verify_purchase` |
| `SyncSubscriptions` | `iap.prepare_sync_subscriptions` |

- On an exception that a handler or core did not handle, routing rolls back, responds with `INTERNAL` and leaves an `error` log with the stack trace
- `storage`, `session`, `idempotency`, `validation` and `server-time` do not leave logs. routing leaves the `request`, `error` and `security` logs for failures of those modules
- For a request among `NoAccessTokenRpc` that is not `NoUserRpc`, routing calls the core `rpc` handler without a token instead of steps 5 to 9 and 12 to 16, and that handler does the handling that `auth` defines. Steps 1 to 4, 10 to 11 and 17 are the same. Rate limit is counted with the IP counter after step 4 and before step 10
  - The `Authorization` of `RefreshToken` is the login token, and `auth` checks the request signature with the session signing key of that session
  - For `Login`, `AutoLogin` and `DevLogin`, after deciding the user, `auth` calls the operations of the request start table in the same order
- `NoUserRpc` goes only through steps 1 to 3, 10 to 11 and 17. It does not do steps 4 to 9 and 12 to 16. It is handled even during maintenance. Rate limit is counted with the IP counter after step 3 and before step 10. The handler receives, without ctx, the request message, the `X-Ogw-Platform` value and the `X-Ogw-Client-Version` value, and returns the response message. It does not open a user transaction and does not save the response, and `user_state`, `pending_user_state`, `item_changes` and `item_mails` of the `ResponseEnvelope` are empty
- `ResponseEnvelope.server_time_at`: for a request that made ctx, the request time of ctx. The exception, the `cheat.SetTimeOffset` response, is defined by `cheat`. For a request that ended without ctx, the `server-time.user_now` of that user when the user was decided, and `server-time.clock_now` when it was not. The user is decided when step 5 passes and when `auth` finds the user of `Login`, `AutoLogin`, `RefreshToken` or `DevLogin`

common header

| header | format |
|---|---|
| `X-Ogw-Request-Id` | UUID v4, lowercase |
| `Authorization` | `Bearer <token>`. The access token. For `AutoLogin` and `RefreshToken`, the login token. `Login`, `GetTerms`, `GetNotices` and `DevLogin` do not have it |
| `X-Ogw-Data-Version` | `<protocol hash>-<data hash>` |
| `X-Ogw-Client-Version` | app version. A string that `validation.parse_version` reads. Empty string for a dev run |
| `X-Ogw-Platform` | platform. A string for which `validation.is_platform` is `true` |
| `X-Ogw-Timestamp`, `X-Ogw-Signature` | request signature of `session`. `NoSignatureRpc` does not have them |

### rate limit

- Counters count per minute window of `server-time`. Failed requests are also counted
- user counter: counts, per user, the requests that reached step 8. `ReportClientErrors` and `ReportAnalyticsEvents` are not counted. Cheat requests also use the same counter
- IP counter: counts, per IP, `NoAccessTokenRpc` requests and the requests that ended in step 5 with a failure other than `TOKEN_EXPIRED`. When it exceeds `routing.ipRateLimitPerMinute`, that request is `RATE_LIMITED`. A request that passed step 5 is not blocked by the IP counter
- The client IP is the peer address of the TCP connection when game settings `environments.<ENV>.trustedProxyCount` of the current environment is 0, and the n-th value from the right of `X-Forwarded-For` when it is n. When that value does not exist, the peer address of the TCP connection. LOCAL is 0. The client IP passed to route handlers is also this value
- routing does all the handling of one request of an rpc path, a cheat path or a route inside `logging.with_request_ip`(client IP, function)
- Counters are kept in the `routing_rate_counter` table, registered with `storage.register_table`: scope `game`, column `kind` (`string`. `user`, `ip`), `target` (`string`. decimal string of the user ID, or the IP), `window_start` (`int64`), `count` (`int64`), `expires_at` (`int64`), key `(kind, target, window_start)`, expiry column `expires_at`. `window_start` is the window start of that minute window, and `expires_at` is the window end. Multiple server instances use the same counter
- Each time a counter is incremented, one `storage.run_game_transaction` adds 1 to `count` of that row, reads the incremented value and commits. Concurrent increments do not overwrite each other. The count remains even when that request fails in a later step or is rolled back. When `run_game_transaction` is `FAILED`, that request does not call the handler and ends with `INTERNAL`

### CORS

- The targets are the following three. Other paths and the other routes that modules exported get no CORS header
  - rpc path: `POST /<rpc name>`, `POST /core/<rpc name>` and their preflight
  - cheat path: `POST /cheat/<cheat name>` and `POST /core/cheat/<cheat name>` in an environment that includes DEV code, and their preflight. The cheat paths of STG·PROD get no CORS header
  - update route: `GET /update/deploy_list.json`, `GET /update/deploy_list.json.sig` and `GET /update/files/<sha256>` that `game-update` exported. No preflight is accepted, and `OPTIONS` on these paths is HTTP 404
- An allowed origin is an origin whose string is exactly equal to an entry in the list for the current environment in game settings `environments.<ENV>.corsAllowedOrigins`. LOCAL allows every origin whose host is `localhost` or `127.0.0.1`
- A preflight of an rpc path or a cheat path from an allowed origin gets HTTP 204 and `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers` (all common headers and `Content-Type`. A cheat path preflight also gets `X-Ogw-Dev-Access`), and `Access-Control-Max-Age` (the quotient of `routing.corsPreflightMaxAgeMs` divided by 1000)
- A `POST` response of an rpc path or a cheat path from an allowed origin has `Access-Control-Allow-Origin: <origin>`, for both success responses and error responses
- A `GET` response of an update route from an allowed origin has `Access-Control-Allow-Origin: <origin>` regardless of the HTTP status. routing adds it to the response of the route handler. A `GET` from an origin that is not allowed gets the response of the route handler as it is, without a CORS header
- A preflight from an origin that is not allowed gets HTTP 403 and no CORS header
- Every response of the targets has `Vary: Origin`. `Access-Control-Allow-Credentials` is not sent

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| unknown path, method | HTTP 404, no body | none | none |
| origin that is not allowed | HTTP 403, no body | none | none |
| body limit, header format, decode failure, field validation failure | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| maintenance | `MAINTENANCE` | `MAINTENANCE` | none |
| user under ban | `BANNED` | `BANNED` | none |
| data version mismatch | `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED` | `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED` | none |
| rate limit exceeded | `RATE_LIMITED` | `RATE_LIMITED` | `security` log. `reason` `rate_limited_user` for the user counter and `logging.count_report_request`, `reason` `rate_limited_ip` for the IP counter |
| `run_game_transaction` of a rate counter is `FAILED` | `FAILED` from `storage` | `INTERNAL` | `error` log |
| authentication failure (except `TOKEN_EXPIRED`) | failure value of that module | error code of that module | `security` log. The raw token and signature are not logged |
| access token expiry in step 5 | `TOKEN_EXPIRED` from `auth` | `TOKEN_EXPIRED` | none. The IP counter is not incremented |
| no `user` row or withdrawn user at transaction start | `WITHDRAWN` from `storage` | `UNAUTHORIZED` | none |
| `FAILED` of `run_request_transaction` in step 13 | `FAILED` from `storage` | `INTERNAL` | `error` log |
| `CoreError` of a request prepare operation | that `CoreError`. Steps 13 to 16 are skipped | that `CoreError` | defined by the module spec of that prepare operation |
| same request ID, different request name | `NAME_MISMATCH` from `idempotency` | `INVALID_REQUEST` | `security` log (`reason` `request_name_mismatch`) |
| kill switch | `FEATURE_DISABLED` | `FEATURE_DISABLED` | none |
| cheat path `POST` in STG·PROD | `UNAUTHORIZED`. The body is not read | `UNAUTHORIZED` | `security` log (`reason` `cheat_path_closed`) |
| unhandled exception, commit failure | rolls back | `INTERNAL` | `error` log, stack trace |
| `GameError` of a core `rpc` handler that is not in `(ogw.core_errors)` of that core `rpc` | rolls back | `INTERNAL` | `error` log. request name, `GameError` value |

- Every request, except the HTTP 404 of an unknown path or method and the HTTP 403 of an origin that is not allowed, leaves one `request` log line regardless of the result
- `ServerError.ban` of a `BANNED` error response is base proto message `BanDetail` (`int64 user_id`, `int64 until_at`, `string deletion_url`, `string access_token`, `string session_signing_key`, `string public_code`). `public_code` is the public code of that user from `storage.get_user_record`. `until_at` is the time the ban ends, and 0 when it does not end. `deletion_url` is the address of the web account deletion page of `auth`. Only the ban login of `auth` fills `access_token` and `session_signing_key`, and in step 6 they are empty strings

Added `CoreError`: `INVALID_REQUEST`, `RATE_LIMITED`, `MAINTENANCE`, `BANNED`, `FEATURE_DISABLED`, `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED`, `INTERNAL`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `routing.maxBodyBytes` | integer | core | content | maximum bytes of the request body |
| `routing.bodyReadTimeoutMs` | integer | core | content | time limit for reading the whole body |
| `routing.userRateLimitPerMinute` | integer | core | content | request count limit per user in one minute window |
| `routing.ipRateLimitPerMinute` | integer | core | content | IP counter limit per IP in one minute window |
| `environments.<ENV>.trustedProxyCount` | integer | game | none | number of proxies trusted when finding the client IP in that environment |
| `environments.<ENV>.serverUrl` | string | game | none | server address from which `BanDetail.deletion_url` is made. The rule for making it is the web account deletion page address of `auth` |
| `environments.<ENV>.corsAllowedOrigins` | array<string> | game | none | allowed origin list of that environment. LOCAL allows every localhost origin |
| `routing.corsPreflightMaxAgeMs` | integer | core | content | preflight cache duration |
| `routing.externalMaxResponseBytes` | integer | core | content | maximum bytes of the response body that every external service call of every module reads |
| `routing.storageSweepIntervalMs` | integer | core | content | period at which job `storage_sweep` calls `storage.sweep_expired` and `run_user_changes` |
| `idempotency.responseRetentionMs` | integer | core | content | duration for which saved responses are kept |

## data

none

## DEV

- The DEV code of routing collects the cheat handlers that `cheat.list_cheat_handlers` returned and the cheat handlers written in `## DEV` of the modules, and handles them on the cheat paths of the path table. routing code that is not DEV code does not call cheats
- In an environment that includes DEV code, the DEV code of routing calls registration function `registerDev(core)` of content `server/dev/main.ts` once at server start, right after `register`
- In an environment that includes DEV code, `ServerError.detail` is filled in English with the failed step and the reason

## test

- For each step of the request processing order, a request that fails in that step ends with the defined error, and the handler is not called
- step order: during maintenance, a request with a wrong header is `INVALID_REQUEST`, and a request with an expired token is `MAINTENANCE`
- When two server instances made with `create_server` are started with `start` in one process with `--port` 0, they listen on different ports and do not see each other's handlers, hooks or caches. After `stop`, no connection is made to that port
- With `dev` of a server instance that includes DEV code, calling an operation that receives ctx without a user ID or with the user ID of a withdrawn user throws. When the operation returns a failure value, `dev` returns that failure value and that user's saved state stays the same
- `stop` ends without waiting for running jobs
- On the port of a started server instance, another socket cannot bind `127.0.0.1`, and a request sent to `127.0.0.1:<port>` reaches that server instance. `start()` with a `--port` that another socket holds on `127.0.0.1` gives a failure reason
- The log lines of a server instance given a log line writer override go only to that writer, and the log lines of the other server instances in the same process do not go to that writer
- A request whose `X-Ogw-Data-Version` equals `client_data_version` passes step 7 even when it differs from the data version of the server build data. When the protocol hash differs from both `client_data_version` and `compat_client_data_version`, `APP_UPDATE_REQUIRED`
- A request equal to `compat_client_data_version` passes step 7, and a request with that protocol hash and only a different data hash is `DATA_UPDATE_REQUIRED` when `is_data_update_ready` is `true`. When the protocol hash of `compat_client_data_version` equals that of `client_data_version`, the server does not start
- A body exceeding `routing.maxBodyBytes` and a body read exceeding `routing.bodyReadTimeoutMs` are cut off regardless of the `Content-Length` value and are `INVALID_REQUEST`
- An `rpc` without a handler, a duplicate registration, an `rpc` name not in `service Game`, `register_hook` with an unknown module name or hook name, and `register_handler` and `register_hook` outside `register` each block server start
- A hook registered with `register_hook` is called at the hook point of that module, and for a hook that is not registered, the module behaves by its `default`
- The core `rpc` path of a module not in the server module list is HTTP 404, and `register_hook` with that module name blocks server start
- A `GameError` or an exception of a handler does not change the saved state. An exception gives `INTERNAL` and an `error` log with the stack trace
- When a core `rpc` handler returns `CoreError` after a write, the saved state is the same as before the request, and the response is that `CoreError`
- When a hook inside a core `rpc` returns a `GameError` written for that core `rpc` in `(ogw.core_errors)`, the response is that `GameError`, and when it returns a `GameError` not written there, `INTERNAL` and an `error` log. In both cases, the saved state is the same as before the request
- The operations of the request start table are called in table order before the transaction start, and their changes are carried in the response delta of the same request. The handler is called even when an operation fails
- When two modules export the same route, the server does not start
- Changing the signature of `RefreshToken` gives `UNAUTHORIZED`
- When the user counter exceeds the limit, `RATE_LIMITED`, and requests are accepted again in the next minute window
- A request whose handler ended with `GameError` also remains in the user counter
- Even when two server instances that use the same DB receive requests of the same user concurrently, the user counter goes up by the number of requests
- A request that ended with `BANNED` in step 6 does not increment the user counter
- `IssueDeletionCode` of a user under ban is handled, the other requests are `BANNED`, and `user_id` and `until_at` of `ServerError.ban` are the values of that user and that ban, `deletion_url` is the web account deletion page address, and `access_token` and `session_signing_key` are empty strings
- After `Withdraw` succeeds, a `Withdraw` sent again with the same access token and request ID gets, without authentication and without the handler, a response whose fields other than `server_time_at` equal those of the first response. The same holds for `ConfirmAge` under the minimum age. A `Withdraw` with a different request ID, and the same request ID after `idempotency.responseRetentionMs` has passed, fail in the authentication step without calling the handler
- When a committed request is sent again with the same request ID, even when it would hit ban, data version, rate limit or kill switch, it gets the saved response without the handler and without request prepare, and the user counter does not go up. During maintenance, `MAINTENANCE`
- From an IP that sent authentication failures over the IP limit, the next authentication failure request is `RATE_LIMITED`, and a request with a valid token from the same IP is handled
- Expired access token requests are `TOKEN_EXPIRED` even when more than `routing.ipRateLimitPerMinute` are sent, and leave no `security` log
- The `reason` of the `security` log left by user counter exceeded, IP counter exceeded, a different request name with the same request ID, and a cheat path `POST` in STG·PROD is `rate_limited_user`, `rate_limited_ip`, `request_name_mismatch` and `cheat_path_closed` respectively, and the `reason` left by a request with the previous access token after another session opened is `session_replaced`
- In an environment whose `trustedProxyCount` is 2, the client IP is the second value from the right of `X-Forwarded-For`, and when `X-Forwarded-For` has only one value, the peer address of the TCP connection. In LOCAL, it is the peer address of the TCP connection even when `X-Forwarded-For` exists
- An rpc path preflight from an allowed origin gets the allowed headers, and a preflight from an origin that is not allowed gets 403 without CORS headers
- On a server that includes DEV code, a cheat path preflight from an allowed origin gets allowed headers that include `X-Ogw-Dev-Access`, and the response of a cheat path `POST` from an allowed origin has `Access-Control-Allow-Origin` equal to that origin. The cheat path `OPTIONS` of an STG·PROD server is 404 without CORS headers
- An update route `GET` from an allowed origin has `Access-Control-Allow-Origin` equal to that origin and has `Vary: Origin`, for both 200 responses and 404 responses. A `GET` from an origin that is not allowed has no `Access-Control-Allow-Origin`. `OPTIONS` of an update route is 404
- A `POST` request from an allowed origin has `Access-Control-Allow-Origin` equal to that origin, for both success responses and `INVALID_REQUEST` responses
- Every request that got a response, except the HTTP 404 of an unknown path or method and the HTTP 403 of an origin that is not allowed, leaves one `request` log line
- The HTTP 404 of an unknown path, and the HTTP 403 of a `POST` and a preflight from an origin that is not allowed, leave no `request` log
- The `request` log of a successful request for which `take_response_delta` returned unknown kind rows has level `warn` and carries those `kind` column values in `unknown_kinds`, and the response is a success
- The attempt counter of `RedeemCoupon` is committed before the transaction start and remains even when the handler ends with `GameError`, and when it exceeds the limit, the handler is not called
- When a successful `RedeemCoupon` is sent again with the same request ID, the attempt counter does not go up, and it gets a response whose fields other than `server_time_at` equal those of the first response
- `GetNotices` without an access token is handled even during maintenance, is `RATE_LIMITED` when it exceeds the IP counter limit, and its handler receives the `X-Ogw-Platform` and `X-Ogw-Client-Version` values
- `Login` from an IP over the IP counter limit is `MAINTENANCE` during maintenance, and outside maintenance it is `RATE_LIMITED` even with a body that cannot be decoded
- The admin operations that modules exported are all passed to `admin-api.register_admin_operation` at server start
- The prepare operation of the request prepare table is called outside the transaction, and while it waits, other requests of the same user are handled. When the prepare operation returns `CoreError`, the handler is not called and the response is that error
- Only operations whose caller is `operator` are collected as admin operations, and internal operations whose caller is `admin-api` are not collected
- An operation that content registered with `register_admin_operation` is passed to `admin-api` with module name `game`, and a name that does not start with `game_` and a registration outside `register` block server start
- A server that includes DEV code calls `registerDev` once after `register`, and an STG·PROD server does not call `registerDev`
- On a server instance that includes DEV code, the time of the test clock set with `dev` before `start()` is the `clock_now` of the job that runs once when server start ends, and the seed setting that was set is used from the first request. `set_clock` and `set_seed_provider` after `start()` has been called throw
- Among the server instances that the server process entry point started, one whose `--env` is `STG` or `PROD` does not start when the server code has core `dev/` or `server/dev/`
- `ResponseEnvelope.server_time_at` equals the `server-time.now` that the handler read, in a request that made ctx. In DEV, for a user whose cheat time offset is O, the errors of steps 6 to 12 and the `RefreshToken` response are `clock_now` + O, and the `GetNotices` response and errors that ended before step 5 are `clock_now`
- A request with the same protocol hash and a different data hash is handled through the handler when `is_data_update_ready` is `false`, and is `DATA_UPDATE_REQUIRED` when it is `true`. When `X-Ogw-Client-Version` is an empty string, it is always `DATA_UPDATE_REQUIRED`
- `core/FinishPlaySession`, `core/ContinuePlaySession` and `core/ReportMatchResult` requests with the same protocol hash and only a different data hash are handled through the handler even when `is_data_update_ready` is `true` or `X-Ogw-Client-Version` is an empty string, and other requests under the same condition are `DATA_UPDATE_REQUIRED`. Those three requests are `APP_UPDATE_REQUIRED` when their protocol hash differs from both `client_data_version` and `compat_client_data_version`
- When `run_game_transaction` of a rate counter is `FAILED`, the handler is not called, the result is `INTERNAL`, and an `error` log is left
