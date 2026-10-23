# NetworkCore

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

Sends contract `rpc`s to the server, handles the response envelope, handles failures by request kind, and passes UserState deltas to `UserStateCore`.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `UserStateCore`, `InputBlockCore`, `UICore`, `MessageCore`

- server dependency: `session`, `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_server_info` | server base URL, app version, platform | success flag | `false` | `BootstrapCore`(`InitModules`) |
| `set_session_provider` | `SessionProvider` or none | none | none | `AuthCore` |
| `send` | request message, success callback, failure callback, `SendOptions` | async operation. success flag | `false` | core, content code |
| `resync` | none | async operation. success flag | `false` | content code |
| `send_auth` | request message, `AuthSendOptions` | async operation. `AuthSendResult` | failed `AuthSendResult` | `AuthCore`, `NoticeCore` |
| `notify_server_error` | error code | none | none | `RealtimeCore` |

### type

| type | contents |
|---|---|
| request kind | Set by `rpc` options. No option is `Interaction`, only `(ogw.retry)` is `Retry`, and with `(ogw.silent)` it is `Silent` (`SilentRetry` when retry is also present) |
| `SendOptions` | `sensitive` (default `false`). When on, the body is not written to logs and request records. Only core turns it on. A request with `rpc` option `(ogw.sensitive)` is treated as on regardless of this value |
| `SessionProvider` | `get_access_token()`: waits and returns a success flag, an access token, and `RequestFailure` on failure. `refresh_access_token()`: waits and returns a newly received result regardless of the remaining time. `get_signing_key()`: the session signing key. An empty value when there is none. `notify_session_replaced()`: tells that the server rejected a request of this session with `SESSION_REPLACED` |
| success callback | input: response message. output none |
| failure callback | input: `RequestFailure`. output: whether handled. `true` when handled |
| `RequestFailure` | `FailureKind`, error code (only for `ServerError`. Otherwise `0`), request name, HTTP status (`0` when there is no response), server detail (empty string when there is none), ban detail (`ServerError.ban` when the error code is `BANNED`. Otherwise none) |
| `FailureKind` | `Timeout`, `ConnectionFailed`, `InvalidResponse`, `ServerError` |
| `AuthSendOptions` | `authorization`: the token to put in `Authorization`. When it is empty, the header is not added. `sign`: whether to attach a request signature. `signing_key`: the session signing key used for the signature |
| `AuthSendResult` | success flag, response message, `RequestFailure` |
| `ErrorDisplay` | `ErrorDisplayKind`, translation key |
| `ErrorDisplayKind` | `None`, `Toast`, `Popup`, `PopupRestart` |

- Callbacks can be omitted. A failure callback that is missing or not called counts as `false`
- The caller does not keep `RequestFailure` outside the failure callback

## behavior

### request send

- Requests that `send` receives are put into a queue and sent one at a time in the order received. The next request starts sending only after the previous request ends. Because the queue starts the next request after the caller of the ended request has resumed, a request received in between is in the queue until the next frame
- Each call to `send` makes a new request ID (UUID v4, lowercase). When the same request is sent again, it uses the first request ID and the same body
- Right before sending again with the same request ID, when the elapsed time since the start of the first send is `NetworkCore.maxRetryAgeMs` or more, it does not send again. The elapsed time is the larger of the monotonic time difference and the device time difference. A retry of the retry popup and `SilentRetry` are handled the same as when the retry count is used up, and the resend after `TOKEN_EXPIRED` and the resend of failure flow step 4 are not done and it goes to the next step of the failure flow
- send attempt processing order
  1. Waits for `SessionProvider.get_access_token`. On failure, it does not do 2 to 4. When the error code of the received `RequestFailure` is `SESSION_REPLACED`, it ends as a failure without the failure callback and default handling. `AuthCore` does the display. Otherwise, it goes from step 2 of the failure flow with that `RequestFailure` when the `FailureKind` of the received `RequestFailure` is `ServerError`, and with `ConnectionFailed` otherwise
  2. Fills the common headers: `X-Ogw-Request-Id`, `Authorization` (access token), `X-Ogw-Data-Version` (data version of `DataCore`), `X-Ogw-Client-Version` (app version given to `set_server_info`), `X-Ogw-Platform` (platform given to `set_server_info`), `X-Ogw-Timestamp` (server time estimate of `TimeCore`. Device time before the first sync), `X-Ogw-Signature` (request signature made with the session signing key). The format and the signature calculation follow the server core `routing`, `session` modules. `Content-Type` is `application/x-protobuf` and `Content-Encoding` is not added
  3. Passes a game `rpc` as `POST <base URL>/<rpc name>` and a core `rpc` as `POST <base URL>/core/<rpc name>`, with the protobuf bytes of the request message as the body, to `NetworkTransport`
  4. Waits for the result
- `send_auth` is not put into the queue and is sent immediately. It does not wait for an access token, and attaches `Authorization` and the signature as `AuthSendOptions` says. The signature key is `signing_key` of `AuthSendOptions` when that is not empty, and `SessionProvider.get_signing_key` when it is empty. It does not do token expiry handling, input block, screen display, `RequestCompletedEvent`. Response processing 1 to 4, failure flow 3 (`UpdateRequiredEvent`), and the failure log are the same as `send`, and the result is returned only as `AuthSendResult`. When the `rpc` has a retry option, on a communication failure it sends again without a screen with the same count and retry delay as `SilentRetry`
- `NetworkTransport` does not follow HTTP redirects, and stops receiving when the response is more than `NetworkCore.responseMaxBytes`
- The timeout is `NetworkCore.requestTimeoutMs` after the send starts. On timeout, it calls `NetworkTransport.cancel` with the handle of that send, and discards a result that arrives after that

### response processing

The response envelope is handled in the order below.

1. For the responses below, it calls `TimeCore.sync_server_time` with `server_time_at` and the monotonic times when it passed the request to `NetworkTransport` and when it received the result
   - Every response received while there is no `SessionProvider`. This includes success responses and error responses, and `Login`, `AutoLogin`, `GetTerms`, `GetNotices` responses. So the `X-Ogw-Timestamp` of the first signed request after login is the server time synced with the login response
   - Success responses received while there is a `SessionProvider`, other than `Login`, `GetTerms`, `GetNotices`. The time of an excluded response can be a value the server made before it determined the user of that session
2. When there is an error, it does not apply the delta and goes to the failure flow
3. Decodes the body as the response message
4. Passes the `user_state` delta with source `Response`, and then the `pending_user_state` delta with source `Pending`, to `UserStateCore.apply_delta`, passes `item_changes` to `UserStateCore.notify_item_changes`, and then `item_mails` to `UserStateCore.notify_item_mails`. When `apply_delta` returns `false`, it does not do the rest of this step and step 5, and ends as a failure whose `FailureKind` is `InvalidResponse`. It does not do the failure flow. `UserStateCore` writes the log
5. Passes the response message to the success callback

- The following are `InvalidResponse`: HTTP status other than 200, redirect, size limit exceeded, envelope or body decode failure, error code 0 or less
- An error code of 1 or more that is not in `CoreError` and `GameError` of this build is also `ServerError`
- Content code does not change UserState based on the response message. UserState changes only through the delta of 4

### failure flow

1. When the error code is `TOKEN_EXPIRED` and this request was not sent again by this handling, it waits for `SessionProvider.refresh_access_token`. On success, it stops the failure flow and sends again once with the same request ID. When the wait ended outside the session end state and failed: when the error code of the received `RequestFailure` is `SESSION_REPLACED`, it ends as a failure without the failure callback and default handling, and `AuthCore` does the display. Otherwise, it goes from step 2 with that `RequestFailure` when the `FailureKind` of the received `RequestFailure` is `ServerError`, and with `ConnectionFailed` otherwise
2. When the error code is `SESSION_REPLACED`, it calls `SessionProvider.notify_session_replaced` and ends as a failure. It does not do the failure callback and default handling. `AuthCore` does the display
3. When the error code is `APP_UPDATE_REQUIRED` or `DATA_UPDATE_REQUIRED`, it emits `UpdateRequiredEvent` and ends as a failure. It does not do the failure callback and default handling
4. When it is a communication failure and this request has not been sent again by this step, it sends again once with the same request ID and body without a screen and stops the failure flow. When the server handled the first request, the saved response arrives
5. When the request kind is `SilentRetry`, it is a communication failure, and retries remain, it waits for the retry delay without a screen, sends again with the same request ID and body, and stops the failure flow
6. Calls the failure callback. When it returns `true`, it ends
7. Does the default handling

| request kind | communication failure (`Timeout`, `ConnectionFailed`, `InvalidResponse`) | `ServerError` |
|---|---|---|
| `Interaction` | error popup | `ErrorDisplay` |
| `Retry` | retry popup when retries remain, retry exhausted popup when they are used up | `ErrorDisplay` |
| `Silent`, `SilentRetry` | none | none |

- The retry count is the number of times one request was sent again, up to `NetworkCore.retryCount`. The resends of 1 and 4 are not counted
- `notify_server_error` handles an error code received outside a request (the matchmaker connection of `RealtimeCore`) the same as failure flow steps 2, 3. For `SESSION_REPLACED`, it calls `notify_session_replaced` when there is a `SessionProvider`, and for `APP_UPDATE_REQUIRED` or `DATA_UPDATE_REQUIRED`, it emits `UpdateRequiredEvent`. Other codes do nothing. It writes no log
- retry delay: the duration waited before sending again automatically. The first retry delay of a request is `NetworkCore.retryDelayMs`, and the next retry delay is the smaller of the previous retry delay × `NetworkCore.retryDelayFactorPermille` ÷ 1000 rounded down and `NetworkCore.retryDelayMaxMs`. It is measured in the real elapsed time of `TimeCore`. A request waiting for the retry delay is a request being sent. A retry of the retry popup and the resends of 1 and 4 are sent immediately without a retry delay
- Every failure writes one log, except a request discarded in the session end state, a request stopped at response processing step 4, and a request that ended with a failure that `SessionProvider` returned in send attempt step 1 or failure flow step 1. The content is `FailureKind`, error code, request name, HTTP status. Failures of `ReportClientErrors`, `ReportAnalyticsEvents`, a `ServerError` for which the failure callback returned `true`, a `ServerError` of `send_auth`, and `SESSION_REPLACED` are warn, and other failures are error. The module that sent the request does not log that failure again

`ErrorDisplay` of `ServerError`

| error code | `ErrorDisplay` |
|---|---|
| `UNAUTHORIZED`, `TOKEN_EXPIRED` | `PopupRestart`, `[network_error_session]` |
| `MAINTENANCE` | `PopupRestart`, `[network_error_maintenance]` |
| `BANNED` | `PopupRestart`, `[network_error_banned]` |
| `RATE_LIMITED` | `Toast`, `[network_error_rate_limited]` |
| `FEATURE_DISABLED` | `Toast`, `[network_error_feature_disabled]` |
| other codes of 1 or more (`CoreError`, `GameError`, codes not in this build) | result of hook `error_display` |

Handling of `ErrorDisplayKind`: `None` displays nothing. `Toast` shows a `MessageCore` toast. `Popup`, `PopupRestart` open the popups below.

| popup | text | button | back input |
|---|---|---|---|
| error popup | the one of `[network_error_timeout]`, `[network_error_connection]`, `[network_error_invalid_response]` for the `FailureKind` | confirm | confirm |
| `Popup` | key of `ErrorDisplay` | confirm | confirm |
| `PopupRestart` | key of `ErrorDisplay` | title | ignored |
| retry popup | same as error popup | retry | ignored |
| retry exhausted popup | same as error popup | title | ignored |

- The button texts are confirm `[network_confirm]`, retry `[network_retry]`, title `[network_go_to_title]`. confirm only closes. retry sends again immediately with the same request ID and body. title emits `EventCore.RestartRequestedEvent`
- Popups are opened with `UICore.open_system_popup`. Toasts and popups get diagnostic wording appended: the error code in STG·PROD builds, and the error name, error code, request name, HTTP status, server detail in a build with DEV code
- When the retry popup cannot open or closes without retry being pressed, it writes an error log and ends as a failure

### session-bound work

- `AuthCore` passes a `SessionProvider` on login success and none when the session ends
- On receiving a `SessionProvider`, it registers the sender with `LogCore.set_sender`, and on receiving none, it calls `LogCore.clear_sender`
- session end state: the state after receiving none following a `SessionProvider`. It ends on receiving the next `SessionProvider` or on `release`
- When it receives none and enters the session end state, it discards all requests in the queue. When there are discarded requests, it writes one warn log with the number discarded. A request that starts a send attempt in the session end state (including resends), and a request whose wait in send attempt step 1 or failure flow step 1 ended in the session end state, are also discarded without a log
- A discarded request ends as a failure without the success callback, failure callback, default handling. `send` is `false` and the success flag of `RequestCompletedEvent` is `false`
- The sender sends the received `LogBatch` with `send`. When there are `errors` or `dropped_error_count` is greater than 0, it sends core `rpc` `ReportClientErrors` (`errors`, `dropped_error_count`), and when there are `events` or `dropped_event_count` is greater than 0, it sends core `rpc` `ReportAnalyticsEvents` (`events`, `dropped_event_count`). Both `rpc`s are `SilentRetry`. `LogEntry` goes into the same-named fields of base proto `ClientErrorEntry`, `AnalyticsEvent` of `LogCore` into the same-named fields of base proto `AnalyticsEvent`, and `time` goes into `time_at`. One parameter is one `AnalyticsParam`: the name is `key`, and value types int64, float64, string, bool are `kind` `INT`, `DOUBLE`, `STRING`, `BOOL` with `int_value`, `double_value`, `string_value`, `bool_value`
- After the first sync, on receiving `TimeCore.AppForegroundReturnedEvent`, it sends core `rpc` `Resync` with `send` when there is a `SessionProvider`. `Resync` is `Silent`, its response body is empty, and the envelope holds `server_time_at` and the pending delta. The envelope of a `Resync` whose `full` is `true` holds a `full` delta that has the whole UserState in `user_state`
- `resync` sends core `rpc` `Resync` with `send`. Other than this, core sends `Resync` by itself only on the return from background. Content code calls `resync` at a moment when it may receive the pending delta
- full resync flag: turned on when a request that `send` received, whose request kind is not `Retry`, ends as a failure with a communication failure, or when a request stops at response processing step 4, because the server may have committed that request while the delta was not received. A request discarded in the session end state does not turn it on
- The request field `full` of `Resync` is the value of the full resync flag when the first send attempt of that `Resync` starts. When a `Resync` whose `full` is `true` ends with success, the flag is turned off. Receiving `set_session_provider` and `release` also turn the flag off

### input block and loading icon

- While one of the below is true, it sets one block with reason tag `network` through `InputBlockCore`. The pass list is `UICore.get_block_pass_list`
  - The request being sent is `Interaction` or `Retry`
  - No request is having its result handled, and there is an `Interaction` or `Retry` request in the queue
- When all conditions become false, it releases the block. Response processing and the failure flow happen after the block is released
- The block elapsed time of the block (max duration of `InputBlockCore`) counts only during one `NetworkTransport` call. Each time it passes a request to `NetworkTransport` while the block is the active block, it calls `InputBlockCore.restart_timer`. While waiting for `get_access_token`, `refresh_access_token` of `SessionProvider` and for the retry delay, it sets `InputBlockCore.set_timer_hold`(`network`, `true`), and when the wait ends, it sets it to `false`
- When the block lasts more than `NetworkCore.loadingIconDelayMs` in real elapsed time, it shows the loading icon of `UICore`, and takes it down when the block is released

### end

- A request ends as a success when it finishes up to the success callback, and as a failure when it finishes the failure flow. A request stopped at response processing step 4 ends as a failure. A request sent again ends with the result of the resend. It does not wait for opened popups and toasts to close. A request that opened a retry popup ends with the result of the resend made by pressing retry
- It is a success even when there is no success callback or its object is destroyed
- On ending, it emits `RequestCompletedEvent` once. The output of `send` is the success flag

### release

- Calls `NetworkTransport.cancel` with every handle being sent, and discards the queue and the requests being handled. Discarded requests do not call callbacks or emit events, and `send` is `false`. Results that arrive after that are discarded
- Releases the block, calls `InputBlockCore.set_timer_hold`(`network`, `false`), and takes down the loading icon. Deletes the values of `set_server_info` and the `SessionProvider`, and calls `LogCore.clear_sender`

### log

- Access tokens, session signing keys, signatures are not logged at any level
- Request bodies and response bodies are logged only at debug level in a build with DEV code. The bodies of `send_auth` and `sensitive` requests are not logged

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `error_display` | default handling of a `ServerError` that the `ErrorDisplay` table sets to the hook | error code, request name | `ErrorDisplay` | `Popup`, `[network_error_general]` |

- It is a handler hook

## event

| event | when | payload |
|---|---|---|
| `RequestCompletedEvent` | when a request that `send` received ends | request name, success flag |
| `UpdateRequiredEvent` | when an `APP_UPDATE_REQUIRED` or `DATA_UPDATE_REQUIRED` response is received, when `notify_server_error` receives that code | error code |

## error

| condition | failure value | log |
|---|---|---|
| `error_display` hook throws | `Popup`, `[network_error_general]`, the same as when the hook returns a wrong output | error |
| the base URL of `set_server_info` is not a URL with scheme `https` (a build with DEV code also accepts scheme `http`) or has a query or fragment, the platform is not `android`, `ios`, `web`, `windows`, `macos`, `linux`, the app version is neither an empty string nor `<major>.<minor>.<patch>` | `false`. Not changed | error |
| sending without a base URL | `ConnectionFailed` | error |
| sending of `send` without a `SessionProvider` when not in the session end state | `ConnectionFailed` | error |
| request in the session end state | discarded and ends as a failure. No callbacks and no default handling | one warn when there are requests discarded on entering the session end state |
| request message is not a contract `rpc` request | `false`. Not sent | error |
| request failure | failure flow | level of the failure flow |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `NetworkCore.requestTimeoutMs` | integer | core | content | duration from the start of a send until timeout |
| `NetworkCore.retryCount` | integer | core | content | max number of times one request is sent again |
| `NetworkCore.retryDelayMs` | integer | core | content | first retry delay |
| `NetworkCore.retryDelayFactorPermille` | integer | core | content | factor multiplied into the next retry delay. permille |
| `NetworkCore.retryDelayMaxMs` | integer | core | content | max value of the retry delay |
| `NetworkCore.maxRetryAgeMs` | integer | core | content | max elapsed time since the start of the first send within which a request can be sent again with the same request ID |
| `NetworkCore.loadingIconDelayMs` | integer | core | content | duration from setting the block until the loading icon is shown |
| `NetworkCore.responseMaxBytes` | integer | core | content | response byte size limit |
| `NetworkCore.devRequestRecordCount` | integer | core | content | number of request records. Only DEV code reads it |
| `InputBlockCore.maxDurationMs` | integer | core | content | block elapsed time at which the forced release of `InputBlockCore` happens. Tests wait longer than this |

settings constraint

| left | factor | right |
|---|---|---|
| `NetworkCore.requestTimeoutMs` | 2 | `InputBlockCore.maxDurationMs` |

## data

reserved string: `[network_confirm]`, `[network_retry]`, `[network_go_to_title]`, `[network_error_timeout]`, `[network_error_connection]`, `[network_error_invalid_response]`, `[network_error_session]`, `[network_error_maintenance]`, `[network_error_banned]`, `[network_error_rate_limited]`, `[network_error_feature_disabled]`, `[network_error_general]`

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_transport` | `NetworkTransport`. Called before `init` | none | none | core test, `UnitTestCore`, `BootstrapCore` |
| `force_failure` | one communication failure of `FailureKind`. none clears it | none | none | `QACore` |
| `force_delay` | delay in ms. `0` clears it | none | none | `QACore` |
| `get_request_records` | caller buffer | number filled | `0` | `QACore` |
| `send_auth_cheat` | request message of `service CoreCheat`, `AuthSendOptions` | async operation. `AuthSendResult` | failed `AuthSendResult` | `AuthCore`(`dev_login`) |
| `set_dev_access` | dev access value | none | none | `BootstrapCore` |
| `send_cheat` | request message of `service Cheat` or `service CoreCheat`, success callback, failure callback | async operation. success flag | `false` | `QACore`(`SetTimeOffset`, `SetUserState`, `DeleteUserState`, `SetItemBalance`, `SetMissionProgress`, `SetResetCounter`), the fake adapter of `AdCore` (`FakeAdCallback`), `client/dev/` content code |

- `NetworkTransport`: the interface through which NetworkCore sends requests. It has `send(handle, URL, header, body)` (waits; returns the handle, result, HTTP status, response bytes) and `cancel(handle)`. Each send uses a new handle. Several `send` calls can run at the same time, and one `send` does not cut off the send of another handle. `cancel(handle)` cuts off only the send of that handle. A result whose handle differs from the handle being waited for is discarded. When `set_transport` is not called, a `NetworkTransport` made with the engine HTTP client is used. `release` deletes a `NetworkTransport` passed with `set_transport`
- `send_auth_cheat` is the same as `send_auth` and sends to `POST <base URL>/core/cheat/<rpc name>`
- When the value received with `set_dev_access` is not an empty string, `send_cheat` and `send_auth_cheat` put that value in header `X-Ogw-Dev-Access`. Other requests do not get it. That value is not written to logs and request records, and `release` deletes it
- `send_cheat` goes through the same queue, session headers, response processing, delta apply as `send`, and sends a game cheat to `POST <base URL>/cheat/<rpc name>` and a core cheat to `POST <base URL>/core/cheat/<rpc name>`. The request kind is `Interaction`
- A send started during `force_failure` becomes that failure without the token lookup and `NetworkTransport`
- During `force_delay`, the result of `NetworkTransport` is treated as received after the delay. The timeout judgement and time sync also use that time
- A request record holds, for each ended request, the request name, request kind, success flag, last error code, request body, last response body. In a run with DEV code, NetworkCore keeps them from `init` without calls from other modules. The bodies of `send_auth` and `sensitive` requests are empty bytes. It keeps the latest `NetworkCore.devRequestRecordCount` records in the order they ended

## test

- A block is set as soon as an `Interaction`, `Retry` request is received, and when there are only `Silent`, `SilentRetry` requests, there is no block and no loading icon
- While the block of an `Interaction` request is the active block, pressing a button of a system popup opened with `UICore.open_system_popup` calls that button callback
- After the block is set, there is no loading icon before `NetworkCore.loadingIconDelayMs` and there is one after
- During time sync, delta apply, callbacks, popups there is no block and no loading icon
- Of two requests received in a row, the later one is passed to `NetworkTransport` after the earlier one ends, and they are handled in the order received
- A success response goes in the order time sync, `apply_delta`, success callback, `RequestCompletedEvent`
- A response for which `apply_delta` of the `user_state` delta is `false` does not pass the `pending_user_state` delta and item notifications, ends as an `InvalidResponse` failure without success callback, failure callback, popup, resend, and the success flag of `RequestCompletedEvent` is `false`. For `send_auth` it is a failed `AuthSendResult` with `InvalidResponse`
- `Login`, `GetTerms`, `GetNotices` responses and error responses (including `MAINTENANCE`, `UNAUTHORIZED`, `TOKEN_EXPIRED`, `GameError`) received while there is a `SessionProvider` do not call `sync_server_time`. Success responses and error responses of `Login`, `AutoLogin`, `GetTerms`, `GetNotices` received while there is no `SessionProvider` call it. After a `Login` success response before the first sync, the `X-Ogw-Timestamp` of the first `send` is not the device time but the server time synced with that response
- An error response does not call `apply_delta`. A body decode failure and an error code of 0 or less are `InvalidResponse` and do not apply the delta. Codes from 1 to 999 not in this build and codes of 1000 or more are `ServerError` and are displayed with hook `error_display`, and a `Retry` request is also not sent again and there is no retry popup
- A result that arrives after a timeout is not handled. HTTP 500, redirect, size limit exceeded are `InvalidResponse`
- For each send, `get_access_token` is called once, and the header has request ID, token, data version, app version, platform, timestamp, signature, `Content-Type: application/x-protobuf`, and no `Content-Encoding`. The timestamp before the first sync is the device time. When the token lookup fails without a `ServerError`, it is `ConnectionFailed` without `NetworkTransport`. When it fails with `MAINTENANCE` of `RefreshToken`, it is a `MAINTENANCE` failure without `NetworkTransport`, and an `Interaction` request gets `PopupRestart`, `[network_error_maintenance]`
- A `send` called again uses a new request ID, and a request sent again by retry uses the first request ID and body
- When retry of the retry popup is pressed after `NetworkCore.maxRetryAgeMs` has passed since the start of the first send, the request is not passed to `NetworkTransport` and the retry exhausted popup appears. The same holds when only the device time advances by that much
- On `TOKEN_EXPIRED`, it sends again once with the same request ID after `refresh_access_token`, and a `TOKEN_EXPIRED` that comes again follows the failure flow from step 2 without `refresh_access_token`. This resend does not count toward the retry count
- An `Interaction` request whose `refresh_access_token` after `TOKEN_EXPIRED` failed with `MAINTENANCE` is not sent again and fails with `PopupRestart`, `[network_error_maintenance]`. A request whose refresh failed without a `ServerError` does the resend of step 4 with `ConnectionFailed`
- A request whose `refresh_access_token` after `TOKEN_EXPIRED` failed with `SESSION_REPLACED` ends as a failure without `notify_session_replaced`, failure callback, popup
- When `set_session_provider`(none) is received while waiting for `refresh_access_token` after `TOKEN_EXPIRED`, that request ends without resend, failure callback, popup, log, and `send` is `false`
- An update error emits `UpdateRequiredEvent` once, and there is no failure callback and no popup
- When the failure callback returns `true`, there is no popup and no toast
- A `ServerError` for which the failure callback returned `true` and a `ServerError` of `send_auth` give one warn log, and an unhandled `ServerError` and a communication failure give one error log
- An `Interaction` request that ended because `get_access_token`, or `refresh_access_token` after `TOKEN_EXPIRED`, failed with a `MAINTENANCE` `RequestFailure` has 0 failure logs of NetworkCore
- A request with a communication failure goes again once with the same request ID and body without a screen, and when that resend succeeds, it ends as a success without popup and failure callback. That resend does not count toward the retry count, and a communication failure after it follows the handling of the request kind
- An `Interaction` request whose token lookup failed with `SESSION_REPLACED` ends as a failure without failure callback and popup
- `SESSION_REPLACED` of a server response calls `notify_session_replaced` once and ends as a failure without failure callback and popup
- `notify_server_error`(`SESSION_REPLACED`) calls `notify_session_replaced` once, `APP_UPDATE_REQUIRED` and `DATA_UPDATE_REQUIRED` emit `UpdateRequiredEvent` of that code once, and `BANNED` does nothing. None of the three writes a log
- When `ReportClientErrors`, `ReportAnalyticsEvents` end with a communication failure, it is a warn log and the error queue of `LogCore` does not grow. While there is no connection, a `ReportClientErrors` failure does not go into `errors` of the next `LogBatch`
- For each request kind and failure of the table, the default handling equals the table. A `Silent` failure has only the callback and the log
- When a `Retry` request sent again `NetworkCore.retryCount` times fails every time, the retry exhausted popup appears and it ends as a failure, and title emits `RestartRequestedEvent` once. `SilentRetry` sends again the same number of times without a screen and ends as a failure
- A `SilentRetry` request with a failure callback that returns `true` sends again without a screen on each communication failure, and the failure callback is called once, on the failure after sending again `NetworkCore.retryCount` times. A `ServerError` is not sent again and calls the failure callback once
- The automatic resend of a `SilentRetry` request happens after the retry delay, and the retry delays are in turn `NetworkCore.retryDelayMs`, then previous value × `NetworkCore.retryDelayFactorPermille` ÷ 1000, and do not exceed `NetworkCore.retryDelayMaxMs`. During the retry delay there is no `NetworkTransport` call and the next request is not sent. The same holds for `send_auth` with a retry option. Retry of the retry popup sends without a retry delay
- When the retry popup cannot open or closes without retry, there is an error log, a failure, and the start of sending the next request
- In a popup with a title button, back input does not close the popup
- A `CoreError` outside the table such as `NICKNAME_TAKEN`, a `GameError`, and a code not in this build are displayed as the result of `error_display`, and without the hook it is `Popup`, `[network_error_general]`. For codes in the table, the hook is not called
- An `Interaction` request and a `Retry` request that failed with `FEATURE_DISABLED` are not sent again, show one `[network_error_feature_disabled]` toast without hook `error_display`, and have no popup
- The diagnostic wording in a build with DEV code and in STG·PROD builds equals behavior
- Logs have no token, signing key, signature, STG·PROD build logs have no body, and the bodies of a request with `sensitive` on and of a `(ogw.sensitive)` request are in no build log
- `RequestCompletedEvent` is once per request, and its success flag equals the output of `send`. It is a success even when the callback is missing or destroyed
- When the `LogBatch` the sender received has only `errors`, it sends one `ReportClientErrors`, and when it has both, it sends both `rpc`s. When `events` is empty and only `dropped_event_count` is greater than 0, `ReportAnalyticsEvents` holds that count
- `send_auth` does not wait for the queue, attaches `Authorization` and the signature as `AuthSendOptions` says, and has no block and no popup. It passes the delta of the login response to `apply_delta`. It makes the signature with `signing_key` when that is not empty, and with `SessionProvider.get_signing_key` when it is empty. `ServerError.ban` of a `BANNED` error response is in the ban detail of `RequestFailure`
- When `release` happens during a send, `NetworkTransport` is cancelled, the block is released, `send` is `false`, and the results after that get no callback, time sync, event
- When none is received after a `SessionProvider`, two `Interaction` requests in the queue end with `send` `false` without `NetworkTransport`, failure callback, popup, `RequestCompletedEvent` is once per request with success flag `false`, and there is one warn log. A request sent with `send` after that and retry of the retry popup are also `false` without `NetworkTransport` and popup, with no log. A `send` after receiving a new `SessionProvider` is passed to `NetworkTransport`
- When the block of a request being sent is released by `InputBlockCore.release_all`, another block is set, and then the response arrives, there is no error log and that other block is the active block
- The block of an `Interaction` request for which `get_access_token` waited longer than `InputBlockCore.maxDurationMs` and then `NetworkTransport` gave the result within `NetworkCore.requestTimeoutMs` is not released by forced release. Even when three `Interaction` requests received in a row each take `NetworkCore.requestTimeoutMs` − 1, there is no forced release
- `send_cheat` keeps the queue order, goes to the cheat path, and passes the delta of the response to `apply_delta`
- After `set_dev_access`, the `X-Ogw-Dev-Access` of `send_cheat` and `send_auth_cheat` requests is that value, `send` and `send_auth` requests do not have that header, and logs do not have that value
- `force_failure`, `force_delay`, request records, `send_cheat`, `set_dev_access` equal behavior and do not exist in STG·PROD builds
- In a build without DEV code, `set_server_info` with an `http` base URL is `false` and writes an error log. A build with DEV code accepts it
- After an `Interaction`, `Silent`, `SilentRetry` request ends with a communication failure, the `Resync` of the return from background and the `Resync` of `resync` go with `full` `true`, and a `Resync` after that `Resync` succeeds is `full` `false`. A `Resync` after a communication failure of a `Retry` request, a `ServerError` failure, or a request discarded in the session end state is `full` `false`
- A `Resync` after a request stopped at response processing step 4 is `full` `true`. When a `Resync` with `full` `true` ends with a communication failure, the next `Resync` is also `full` `true`
- After the full resync flag is turned on, when `set_session_provider` is received or `release`, `init` happen, the next `Resync` is `full` `false`
- The `user_state` of a `Resync` response with `full` `true` is passed to `UserStateCore.apply_delta`, and the cache keeps only the upserts of that delta
