# auth

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

Makes accounts and handles login. Owns guest login, social login token verification, issuing and verifying login tokens and access tokens, the terms agreement record, the record of age confirmation, privacy choices (ad personalization, analytics, tracking permission) and ad push consent, account link, withdrawal, web account deletion received outside the app, guest cleanup, and the query with which an operator finds a user by social account.

## dependency

- `session`
- `storage`
- `server-time`
- `logging`
- `admin-api`
- `mailbox`
- optional dependency: `live-event`, `public-profile`, `remote-config`, `ranking`, `push`, `iap`, `friend`, `guild`, `chat`, `block-report`

## API

core `rpc`. auth exports the handlers and `routing` collects them.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `Login` (core rpc, `sensitive`). changes: `ConsentUserState` | provider, credential, list of agreed terms versions | `AuthResult` | `UNAUTHORIZED`, `CONSENT_REQUIRED`, `INVALID_REQUEST`, `SOCIAL_LOGIN_INVALID`, `EXTERNAL_SERVICE_FAILED`, `BANNED`, `AGE_BELOW_MINIMUM` | `routing`. Sent by client `AuthCore` |
| `AutoLogin` (core rpc, `sensitive`). changes: `ConsentUserState` | login token(`Authorization`), list of agreed terms versions | `AuthResult` | `UNAUTHORIZED`, `CONSENT_REQUIRED`, `INVALID_REQUEST`, `BANNED`, `AGE_BELOW_MINIMUM` | `routing`. Sent by client `AuthCore` |
| `RefreshToken` (core rpc). changes: none | login token(`Authorization`), request signature | access token, access token expiry time | `UNAUTHORIZED`, `SESSION_REPLACED` | `routing`. Sent by client `AuthCore` |
| `Logout` (core rpc, `retry`). changes: none | none | none | none | `routing`. Sent by client `AuthCore` |
| `LinkAccount` (core rpc, `retry`, `sensitive`). changes: none | provider, credential | list of linked providers | `INVALID_REQUEST`, `ALREADY_LINKED`, `SOCIAL_LOGIN_INVALID`, `EXTERNAL_SERVICE_FAILED` | `routing`. Sent by client `AuthCore` |
| `Withdraw` (core rpc, `retry`). changes: `all` | none | none | `INTERNAL` | `routing`. Sent by client `AuthCore` |
| `IssueDeletionCode` (core rpc, `retry`). changes: none | none | deletion code, expiry time, web account deletion page address | none | `routing`. Sent by client `AuthCore` |
| `GetTerms` (core rpc). changes: none | none | `(item, version, url)` per terms item | none | `routing`. Sent by client `AuthCore` |
| `ConfirmAge` (core rpc, `retry`, `sensitive`). changes: `ConsentUserState`, `all` | birth year and month | `ConsentUserState` | `INVALID_REQUEST`, `INTERNAL` | `routing`. Sent by client `AuthCore` |
| `UpdateConsent` (core rpc, `retry`). changes: `ConsentUserState` | privacy choices version, `ad_personalization`, `analytics`, `tracking` | `ConsentUserState` | `INVALID_REQUEST` | `routing`. Sent by client `AuthCore` |
| `UpdatePushConsent` (core rpc, `retry`). changes: `ConsentUserState` | `push_ad`, `push_night`(`ConsentChoice`) | `ConsentUserState` | `INVALID_REQUEST` | `routing`. Sent by client `AuthCore` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `verify_access_token` | access token | `(user ID, session ID)` | `UNAUTHORIZED`, `TOKEN_EXPIRED` | `routing`, `matchmaker` |
| `prepare_link_account` | user ID, `LinkAccountRequest`, client IP | async operation. provider account ID. Also the refresh token when the provider is `APPLE` | `INVALID_REQUEST`, `SOCIAL_LOGIN_INVALID`, `EXTERNAL_SERVICE_FAILED` | `routing` |
| `web_deletion_url` | `--env` value, the port the server listens on, `environments.<ENV>.serverUrl` | web account deletion page address | none | `routing` |
| `GET /account/deletion` (route) | HTTP request, client IP | HTML page | none | `routing` |
| `POST /account/deletion` (route) | HTTP request, client IP | HTTP status, result page | processing order of web account deletion | `routing` |

- provider: `GUEST`, `APPLE`, `GOOGLE`. It is the base proto enum `LoginProvider`. `APPLE`, `GOOGLE` are the social providers. `LOGIN_PROVIDER_UNSPECIFIED` and values not defined in `LoginProvider` are not providers
- `AuthResult`, `TermsDocument` are base proto messages. `TermsDocument` is the current version and document URL of one terms item
- `Login`, `AutoLogin`, `RefreshToken`, `GetTerms` are accepted without an access token and get the handling of this spec. The rest go through the request processing order of `routing`, and `LinkAccount` calls `prepare_link_account` in the request prepare of that order

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `LoginRequest` | `provider` | `LoginProvider` | none |
| `LoginRequest` | `credential` | `string` | `max_len_key`: `auth.maxCredentialBytes` |
| `LoginRequest` | `agreements` | `repeated TermsAgreement` | `max_count`: 2 |
| `AutoLoginRequest` | `agreements` | `repeated TermsAgreement` | `max_count`: 2 |
| `LinkAccountRequest` | `provider` | `LoginProvider` | none |
| `LinkAccountRequest` | `credential` | `string` | `max_len_key`: `auth.maxCredentialBytes` |
| `ConfirmAgeRequest` | `birth_year_month` | `int32` | `min`: 0, `max`: 999912 |
| `UpdateConsentRequest` | `privacy_version` | `int32` | `min`: 0, `max`: 2^31−1 |
| `UpdateConsentRequest` | `ad_personalization` | `ConsentChoice` | none |
| `UpdateConsentRequest` | `analytics` | `ConsentChoice` | none |
| `UpdateConsentRequest` | `tracking` | `TrackingStatus` | none |
| `UpdatePushConsentRequest` | `push_ad` | `ConsentChoice` | none |
| `UpdatePushConsentRequest` | `push_night` | `ConsentChoice` | none |
| `TermsAgreement` | `item` | `TermsItem` | none |
| `TermsAgreement` | `version` | `int32` | `min`: 0, `max`: 2^31−1 |

- `TermsAgreement`(base proto message) is one agreed terms item and its version. The `max_count` 2 of `agreements` is the number of `TERMS`, `PRIVACY` of `TermsItem`

core `rpc` response field

| message | field | type |
|---|---|---|
| `LoginResponse` | `result` | `AuthResult` |
| `AutoLoginResponse` | `result` | `AuthResult` |
| `RefreshTokenResponse` | `access_token` | `string` |
| `RefreshTokenResponse` | `access_token_expires_at` | `int64` |
| `LinkAccountResponse` | `linked_providers` | `repeated LoginProvider` |
| `GetTermsResponse` | `documents` | `repeated TermsDocument` |
| `ConfirmAgeResponse` | `consent` | `ConsentUserState` |
| `UpdateConsentResponse` | `consent` | `ConsentUserState` |
| `UpdatePushConsentResponse` | `consent` | `ConsentUserState` |
| `IssueDeletionCodeResponse` | `code` | `string` |
| `IssueDeletionCodeResponse` | `expires_at` | `int64` |
| `IssueDeletionCodeResponse` | `url` | `string` |
| `AuthResult` | `user_id` | `int64` |
| `AuthResult` | `user_created_at` | `int64` |
| `AuthResult` | `login_token` | `string` |
| `AuthResult` | `access_token` | `string` |
| `AuthResult` | `access_token_expires_at` | `int64` |
| `AuthResult` | `session_signing_key` | `string` |
| `AuthResult` | `linked_providers` | `repeated LoginProvider` |
| `AuthResult` | `consent` | `ConsentUserState` |
| `AuthResult` | `remote_config` | `GetRemoteConfigResponse` |
| `AuthResult` | `public_code` | `string` |
| `TermsDocument` | `item` | `TermsItem` |
| `TermsDocument` | `version` | `int32` |
| `TermsDocument` | `url` | `string` |

admin operation. `routing` collects them and passes them to `admin-api`, and the processing order, authentication, `operation_id` rules and `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `withdraw_user` | `user_id` | empty object | `not_found`, `internal` | operator |
| `find_user_by_social_account` | `provider`, `provider_account_id` | `user_id`, `linked_at` | `bad_request`, `not_found` | operator |
| `find_user_by_public_code` | `public_code` | `user_id`, `withdrawn_at` | `bad_request`, `not_found` | operator |

- field types of the admin operations: `provider` is `enum{APPLE, GOOGLE}`, `provider_account_id` and `public_code` are `string`

## behavior

### account

- An account is one user. The user ID is an `int64` of 1 or more that the `user` table of `storage` issues. The user ID of a withdrawn user is not issued again
- A guest account is bound to one device. When its login token is lost, it is not recovered
- A social account `(provider, provider account ID)` is linked to only one user. One user has only one link per provider
- When `iap` is in the server module list, passes the function `has_social_link`(DB handle, user ID) with `iap.register_account_lookup` at server start. It returns whether that user has an `auth_social_link` row
- An account link row is inserted with an insert that does not insert when a row with the same `(provider, provider_account_id)` exists, and then the user of that key is read again. In `LinkAccount`, when that user is not the requesting user, `ALREADY_LINKED`

- `public_code` of `AuthResult` is `public_code` of `storage.get_user_record` of that user. The public code is what a person sees and types to point to a user; the user ID is not shown to a person

### Login

1. When the list of agreed terms versions has an entry whose item is not `TERMS`, `PRIVACY`, or has two entries of the same item, `INVALID_REQUEST`. Otherwise, when for any item of `GetTerms` the agreed version does not equal the current version, `CONSENT_REQUIRED`
2. When the provider value is not a provider, `INVALID_REQUEST`. When the provider is `GUEST`, `INVALID_REQUEST` when the credential is not empty; when it is empty, makes a new user
3. When the provider is a social provider and game settings have no adapter for that provider, `INVALID_REQUEST` without calling an adapter. Otherwise, outside a transaction, verifies the credential with the adapter of that provider and gets the provider account ID. A rejection is `SOCIAL_LOGIN_INVALID`, and time limit exceeded and communication failure are `EXTERNAL_SERVICE_FAILED`. When there is a linked user, it is that user. Otherwise makes a new user and inserts the account link row in one `storage.run_user_transaction` of the new user. When the user of that key read again is not the new user, deletes the new user with `storage.delete_user` in the same transaction. After this transaction commits, runs from step 4 with the user of that key
4. When the user is a ban target by `admin-api.is_banned`, does the ban login and ends with `BANNED`
5. request start: calls the operations of the request start table of `routing` in the order of the table
6. In one `storage.run_request_transaction`, records the terms agreement and recalculates `ConsentUserState`. When the recalculated `below_minimum_age` is `true`, ends with `AGE_BELOW_MINIMUM`. Otherwise opens a new session with `session.start_session` and issues a new login token. Leaves the other login token rows of that user as they are
7. `user_state` of the response is the delta that `storage.read_full_state` made in the same transaction. `item_changes`, `item_mails` are the `ItemChange`, `ItemMail` lists that `read_full_state` returned. In `AuthResult`, `consent` is the `ConsentUserState` after step 6, `user_created_at` is `created_at` of `storage.get_user_record`, and `remote_config` is the `entries`, `assignments` that `remote-config.get_client_config` returned in the same transaction. When `remote-config` is not in the server module list, they are empty `entries`, `assignments`

- ban login: in one `storage.run_request_transaction`, opens a new session with `session.start_session` and commits, then issues an access token of that session and responds with `BANNED`. `ServerError.ban`(`BanDetail` of `routing`) is the user ID, the `until_at` that `is_banned` returned, the web account deletion page address, that access token and that session signing key. Does not issue a login token, and does not do login token rotation, request start or the terms agreement record. During the ban, `routing` blocks that user's requests other than `IssueDeletionCode` with `BANNED`, so this session only gets a deletion code
- In the transaction of step 6, emits core analytics event `core_session_started` with `logging.track_core_event`. When the user of steps 4 to 7 is a new user that the request made, emits `core_user_created` before it
- When the list of unknown kind rows that `read_full_state` of step 7 or `take_response_delta` of `RefreshToken` returned is not empty, calls `logging.annotate_request_log`(ctx, field `unknown_kinds`: the list joined with `,` as a string, minimum level `warn`) in the same transaction

### AutoLogin

- Finds the login token row by the hash of the login token. When there is no row, `UNAUTHORIZED`
- When the list of agreed terms versions is not empty, checks it as in `Login` step 1. When it is empty, checks with the saved agreement records, and when an item has no record of agreeing to the current version, `CONSENT_REQUIRED`
- The rest is the same as steps 4 to 7 of `Login`. Step 6 first reads the login token row again by the hash of the login token in the same transaction, and ends with `UNAUTHORIZED` when there is no row. When there is, does login token rotation and issues the next token of the requested token

### token

- login token: a base64url string of 32 byte secure random. The server saves only its SHA-256 hash. It is the token that the login of one device keeps using, and it has no expiry time. Login tokens of several devices of one user are valid together
- login token row: `token_hash`, the hash of the previous token `previous_hash` (null when none), `session_id` of the issued session, `created_at`, the last used time `last_used_at`. `Login`, `DevLogin` issue a row whose `previous_hash` is null, and `AutoLogin` issues the next token row whose `previous_hash` is the hash of the requested token. `created_at` and `last_used_at` of an issued row are the request time
- login token rotation: `AutoLogin`, `RefreshToken` change `last_used_at` of the row R of the requested token to the request time, and delete the row that `previous_hash` of R points to. `AutoLogin` then deletes the row whose `previous_hash` is the hash of R, changes `session_id` of R to the new session ID, and issues the next token. So a device that lost the response of `AutoLogin` can `AutoLogin` again with the requested token, and a device that could not save the next token can `RefreshToken` with the requested token. When the next token is used for the first time, the requested token becomes invalid
- Only login token rotation, `Logout`, `Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age and guest cleanup delete login token rows. A ban does not delete login tokens. `Login`, `AutoLogin` of a ban target user are `BANNED`, and when the ban ends, the user does `AutoLogin` with the same login token
- access token: JWS compact, `alg` `EdDSA`(Ed25519)
  - The header is fixed to `{"alg":"EdDSA","typ":"ogw-access-v1"}`
  - The payload is JSON with only `uid`(user ID decimal string), `sid`(session ID), `exp`(expiry time, Unix ms integer). Keys are in byte order and there is no whitespace
  - The expiry time is the issue time (request time) + `auth.accessTokenTtlMs`
  - The signing key is the secret that game settings `environments.<ENV>.secrets.accessTokenKey` names. The value is the standard base64 of a 32 byte Ed25519 private key seed
- `verify_access_token` rejects before decoding when the length exceeds `auth.maxTokenBytes`. A header mismatch, a signature mismatch, a duplicate key, an unknown key, a value of a wrong type, keys not in byte order and a payload with whitespace are `UNAUTHORIZED`. Expiry is `TOKEN_EXPIRED`. Expiry is judged by whether `server-time.user_now`(the user ID of the payload) is at least `exp`
- `RefreshToken`: when `session.check_current`, `session.verify_signature`(signature name `core/RefreshToken`) pass with `user_id`, `session_id` of the login token row, reads the login token row again by the hash of the login token in one `storage.run_request_transaction`, and ends with `UNAUTHORIZED` when there is no row. When there is, does login token rotation in the same transaction and gives a new access token with the same session ID. The session signing key does not change. The response delta is taken with `storage.take_response_delta` inside that transaction. An unknown login token and a signature failure are `UNAUTHORIZED`
- The client does not interpret tokens

### LinkAccount, Logout, Withdraw

- `LinkAccount`: when the provider is not a social provider or game settings have no adapter for that provider, `prepare_link_account` returns `INVALID_REQUEST` without calling an adapter. Otherwise `prepare_link_account` verifies the credential with the social adapter outside a transaction and gets the provider account ID, and the handler links with that value. When that social account is on another user or this user already has the same provider, `ALREADY_LINKED`
- `Logout`: closes the current session with `session.end_session`, and deletes the login token rows whose `session_id` is the current session and the rows that `previous_hash` of those rows points to
- `Withdraw`: in one user transaction, calls `remove_user` of the modules among `ranking`, `push`, `iap`, `chat`, `friend`, `guild`, `block-report` that are in the server module list, in this order, then calls `logging.request_analytics_deletion`, then calls `storage.delete_user`. When `chat`, `friend`, `guild.remove_user` is `FAILED`, does not call the later operations and ends with `FAILED`, and all changes of that request are rolled back. All rows of user-scope tables are deleted and the withdrawal time stays in the `user` row. After that, access token requests of that user are `UNAUTHORIZED` because there is no session. As an exception, for `Withdraw` sent again with the same access token and request ID, `routing` answers with the withdrawn response of `idempotency`
- `user_target` of `withdraw_user` is `user_id`. In the out-of-request change of the target user that `admin-api` opened, calls the same operations as `Withdraw` in the same order. When `remove_user` is `FAILED`, does not call the later operations and the handler function returns `internal`. Used for withdrawal requests received outside the app
- Withdrawing agreement to the required terms is `Withdraw`

### terms

- The terms items are `TERMS`, `PRIVACY` of base proto enum `TermsItem`. The current version and document URL per item are game settings `termsDocuments`
- A URL must have scheme `https`, have a host, and have no user info. LOCAL also accepts scheme `http`. On violation, the server does not start
- An agreement record is a row `(user ID, item, version, agreement time)`. The same `(user ID, item, version)` is kept only once

### age and privacy choices

- Age and privacy choices do not block login. The exception is a user whose `below_minimum_age` is `true`. After login, client `AuthCore` looks at `ConsentUserState` and sends `ConfirmAge`, `UpdateConsent`, `UpdatePushConsent`. `iap` blocks purchases of users without age confirmation
- `ConsentUserState`: core UserState kind (single kind) of the base proto. Only this module writes it, with `storage.put_core_state`

| field | type | meaning |
|---|---|---|
| `age_confirmed_at` | `int64` | age confirmation time. 0 when none |
| `age_from` | `int32` | start age of the age band. 0 before age confirmation and below the first boundary |
| `age_to` | `int32` | end age of the age band. This age is not in the age band. 0 before age confirmation and at or above the last boundary |
| `child` | `bool` | the age band is below `auth.childAgeYears` |
| `below_consent_age` | `bool` | the age band is below `auth.digitalConsentAgeYears` |
| `below_minimum_age` | `bool` | game settings `consent.minimumAge` is not `null` and the age band is below that age |
| `privacy_version` | `int32` | the privacy choices version last answered. 0 when none |
| `ad_personalization` | `ConsentChoice` | ad personalization choice |
| `analytics` | `ConsentChoice` | analytics choice |
| `tracking` | `TrackingStatus` | the tracking permission state of the device last reported |
| `ad_personalization_allowed` | `bool` | whether ad personalization is allowed. Calculated below |
| `analytics_allowed` | `bool` | whether analytics events may be collected. Calculated below |
| `push_ad` | `ConsentChoice` | consent to receive ad pushes |
| `push_ad_at` | `int64` | the time `push_ad` was last changed. 0 before an answer |
| `push_night` | `ConsentChoice` | consent to receive night-time ad pushes |
| `push_night_at` | `int64` | the time `push_night` was last changed. 0 before an answer |

- base proto enum
  - `ConsentChoice`: `GRANTED`, `DENIED`. `CONSENT_CHOICE_UNSPECIFIED` when not answered
  - `TrackingStatus`: `NOT_APPLICABLE`(a platform without tracking permission), `NOT_DETERMINED`, `AUTHORIZED`, `DENIED`, `RESTRICTED`
- The age band boundaries are game settings `consent.ageBandBoundaries`. It holds integers from 1 to `auth.maxAgeYears` in ascending order without duplicates, and holds `auth.childAgeYears`, `auth.digitalConsentAgeYears` and `consent.minimumAge`(when not `null`). On violation, the server does not start
- calculation. Done in the transaction of `Login`, `AutoLogin`, `DevLogin`, `ConfirmAge`, `UpdateConsent`, `UpdatePushConsent`, and written only when a value changes
  - age: from the saved birth year and month and the UTC year and month of `server-time.clock_now`, ⌊((current year × 12 + current month) − (birth year × 12 + birth month)) / 12⌋
  - `age_from` is the largest boundary that is at most age, and `age_to` is the smallest boundary greater than age. 0 when none
  - the age band is below n: `age_confirmed_at` is not 0, `age_to` is not 0, and `age_to` ≤ n
  - `analytics_allowed`: `false` when game settings `consent.ageConfirmation` is `true` and `age_confirmed_at` is 0, or when `child`. Otherwise, when game settings `consent.privacyChoices` is `true`, `true` if `analytics` is `GRANTED`; when it is `false`, always `true`
  - `ad_personalization_allowed`: `false` when `below_consent_age`. Otherwise `true` when `ad_personalization` is `GRANTED`, `false` when `DENIED`, and when `CONSENT_CHOICE_UNSPECIFIED`, `true` only when `consent.privacyChoices` is `false`
- `ConfirmAge`: the birth year and month is a `yyyymm` integer. When the month is not 1 to 12, it is after the current UTC year and month, or the age exceeds `auth.maxAgeYears`, `INVALID_REQUEST`. For a user who already confirmed age, changes nothing and returns the current `ConsentUserState`. The first time, keeps it in `auth_age` and sets `age_confirmed_at` to the request time. When the recalculated `below_minimum_age` is `true`, calls the same operations as `withdraw_user` in the same order in the same transaction and leaves `reason` `age_blocked` in the `audit` log. When `remove_user` is `FAILED`, does not call the later operations and ends with `FAILED`, and all changes of that request are rolled back. Otherwise the response is a success and `consent` is the recalculated `ConsentUserState`. After that, requests of that user are `UNAUTHORIZED`. As an exception, for `ConfirmAge` sent again with the same access token and request ID, `routing` answers with the withdrawn response of `idempotency`
- `UpdateConsent`: when the privacy choices version differs from game settings `consent.version`, or `tracking` is `TRACKING_STATUS_UNSPECIFIED`, `INVALID_REQUEST`. When game settings `consent.privacyChoices` is `true`, `ad_personalization`, `analytics` are `GRANTED` or `DENIED`. When it is `false`, `analytics` is `CONSENT_CHOICE_UNSPECIFIED`, and `ad_personalization` is `CONSENT_CHOICE_UNSPECIFIED` or the `GRANTED`, `DENIED` that client `AdCore` received on the ads consent screen. On violation, `INVALID_REQUEST`. Keeps one row in `auth_consent_record` per changed item
- `UpdatePushConsent`: when game settings `pushConsent.adPush` is `false` or either of `push_ad`, `push_night` is `CONSENT_CHOICE_UNSPECIFIED`, `INVALID_REQUEST`. For each changed item, changes that value, sets its `_at` field to the request time, and keeps one row in `auth_consent_record`. Then, in the same transaction, calls `push.refresh_push_consent` when `push` is in the server module list
- The birth year and month is kept only in `auth_age`, and is not put in UserState or logs

### table

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `auth_login_token` | `user` | `user_id`(`int64`), `token_hash`(`string`), `previous_hash`(`string?`), `session_id`(`string`), `created_at`(`int64`), `last_used_at`(`int64`) | `token_hash` | none |
| `auth_social_link` | `user` | `user_id`(`int64`), `provider`(`string`), `provider_account_id`(`string`), `linked_at`(`int64`) | `(provider, provider_account_id)` | none |
| `auth_terms_agreement` | `user` | `user_id`(`int64`), `item`(`string`), `version`(`int32`), `agreed_at`(`int64`) | `(user_id, item, version)` | none |
| `auth_age` | `user` | `user_id`(`int64`), `birth_year_month`(`int32`), `confirmed_at`(`int64`) | `user_id` | none |
| `auth_consent_record` | `user` | `user_id`(`int64`), `seq`(`int64`), `purpose`(`string`. `ad_personalization`, `analytics`, `tracking`, `push_ad`, `push_night`), `value`(`string`. the element name of `TrackingStatus` when `purpose` is `tracking`, otherwise of `ConsentChoice`), `version`(`int32`), `recorded_at`(`int64`) | `(user_id, seq)` | none |
| `auth_apple_token` | `user` | `user_id`(`int64`), `refresh_token`(`string`), `updated_at`(`int64`) | `user_id` | none |
| `auth_deletion_code` | `user` | `user_id`(`int64`), `code_hash`(`string`), `attempts`(`int32`), `expires_at`(`int64`) | `user_id` | `expires_at` |
| `auth_deletion_ip_counter` | `game` | `ip`(`string`), `window_start`(`int64`), `count`(`int64`), `expires_at`(`int64`) | `(ip, window_start)` | `expires_at` |
| `auth_dev_account` | `user` | `user_id`(`int64`), `name`(`string`) | `name` | none. Only DEV code makes it |

- The eight tables whose scope is `user` are registered with `storage.register_table` as excluded from snapshots, and `auth_deletion_ip_counter` is registered without a snapshot flag. `auth_social_link`, `auth_terms_agreement`, `auth_age`, `auth_consent_record`, `auth_apple_token` are registered with personal data user column `user_id`
- index: `auth_login_token` has `(user_id, previous_hash)`, `(user_id, session_id)`, and `auth_social_link` has `(user_id)`
- A new user is made with `storage.create_user` in one game transaction
- `seq` of `auth_consent_record` is the largest `seq` among that user's rows + 1, and the first row is 1. When several items change in one request, rows are written in the order listed in the `purpose` column
- `version` of `auth_consent_record` is the privacy choices version of that `UpdateConsent` when `purpose` is `ad_personalization`, `analytics`, `tracking`, and 0 when it is `push_ad`, `push_night`

### external service

- The social login adapter key is `login-apple` for provider `APPLE` and `login-google` for `GOOGLE`. The per-environment `adapters` of game settings choose the value
- adapter interface: `verify(credential)` → provider account ID or rejection. `login-apple` also has `exchange(credential)` → refresh token or rejection, and `revoke(refresh token)` → success flag. `login-google` also has `exchange_desktop(desktop credential)` → ID token or rejection. The time limit of one call is `auth.socialVerifyTimeoutMs`
- `verify` checks that the credential was issued for this game. When the credential fails any one of the checks below, it is a rejection

| adapter | credential | check | provider account ID |
|---|---|---|---|
| `login-apple` | UTF-8 JSON object `{"identity_token": <string>, "authorization_code": <string>}` | the signature of the identity token matches with an Apple public key, `iss` is `https://appleid.apple.com`, `aud` is game settings `appId`, and `exp` is after `clock_now` | `sub` |
| `login-google` | Google ID token, or UTF-8 JSON object `{"authorization_code": <string>, "code_verifier": <string>, "redirect_uri": <string>}`(desktop credential) | for a desktop credential, first gets an ID token with `exchange_desktop`. The signature of the ID token matches with a Google public key, `iss` is `accounts.google.com` or `https://accounts.google.com`, `aud` is one of game settings `loginGoogle.serverClientId`, `loginGoogle.iosClientId`, `loginGoogle.desktopClientId`, and `exp` is after `clock_now` | `sub` |

- The public keys are the provider JWKS that the adapter's key source returned. The server's key source fetches them from `https://appleid.apple.com/auth/keys` for `login-apple` and from `https://www.googleapis.com/oauth2/v3/certs` for `login-google`. The fetched JWKS stays in the memory of the server instance for `auth.jwksCacheMs`, and is fetched again for an unknown `kid`
- `exchange` of `login-apple` exchanges the authorization code of the credential for a refresh token at the Apple token endpoint, and `revoke` revokes that refresh token at the Apple revoke endpoint. `client_id` of both calls is `appId`, and `client_secret` is an ES256 JWT with `iss` game settings `appleTeamId`, `kid` `loginApple.keyId`, `sub` `appId`, `aud` `https://appleid.apple.com`, signed with the private key of secret `environments.<ENV>.secrets.loginApple`
- `exchange_desktop` of `login-google` sends the desktop credential to `https://oauth2.googleapis.com/token` with `grant_type` `authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id` game settings `loginGoogle.desktopClientId`, `client_secret` the value of secret `environments.<ENV>.secrets.loginGoogleDesktop`, and returns `id_token` of the response. When `redirect_uri` is not `http://127.0.0.1:<port from 1 to 65535>` or the JSON format does not match, rejects without calling Google. The access token and the other tokens of the response are discarded without being saved. The authorization code, code verifier, client secret and tokens are not kept in logs
- When the credential is a desktop credential, `Login` and `prepare_link_account` of provider `GOOGLE` call `verify` after `exchange_desktop` outside a transaction. A rejection is `SOCIAL_LOGIN_INVALID`, and time limit exceeded and communication failure are `EXTERNAL_SERVICE_FAILED`
- `Login` and `prepare_link_account` of provider `APPLE` also call `exchange` after `verify` outside a transaction. A rejection is `SOCIAL_LOGIN_INVALID`, and time limit exceeded and communication failure are `EXTERNAL_SERVICE_FAILED`. The received refresh token is written to that user's `auth_apple_token` row in the transaction of that request. When the row exists, it is replaced
- `Withdraw`, `withdraw_user`, web account deletion and `ConfirmAge` under the minimum age read that user's `auth_apple_token` row before `storage.delete_user`, and after commit call `revoke` outside the transaction with `storage.after_commit`. A rejection, a failure or time limit exceeded only leaves an `error` log and does not change the result
- Refresh tokens are not kept in logs
- The fake adapter accepts credential `fake:<string>` and returns that string as the provider account ID. The same string is the same social account. It rejects other formats
- `exchange` of the fake `login-apple` adapter returns `fake:<provider account ID>` as the refresh token, and `revoke` succeeds. `exchange_desktop` of the fake `login-google` adapter returns `fake:<authorization_code>` as the ID token after the same `redirect_uri` check as the real adapter
- The operation names of the fake adapter controller are `verify`, `exchange`, `revoke`, `exchange_desktop`. A value set with `set_result` is the output of that operation, and before one is set, the fake behavior above applies. `input` of `calls()` is the input of that operation

### guest cleanup

- A guest account is a user without an `auth_social_link` row. Its last use time is the latest `last_used_at` among that user's login token rows, or `created_at` of `storage.get_user_record` when there is no row
- When core settings `auth.inactiveGuestDeleteAfterMs` is null, guests are not deleted
- When it is not null, the job `auth_guest_sweep`(period `auth.guestSweepIntervalMs`) that auth schedules at server start with `server-time.schedule_job` scans the users that are not withdrawn users with `storage.scan_users`, `auth.guestSweepBatchSize` users at a time in ascending user ID order. The next scan starts after the last user ID kept in the memory of the server instance, and when it reaches the end, it starts from the beginning
- A guest whose last use time + `auth.inactiveGuestDeleteAfterMs` ≤ `clock_now` is deleted in one `storage.run_user_transaction`. As an exception, when `iap` is in the server module list, a guest for whom `iap.has_granted_payment` is `true` is not deleted. Inside that change, checks the guest condition, the time condition and the payment condition again, calls the same operations as `withdraw_user` in the same order, and leaves `reason` `inactive_guest` in the `audit` log. When `remove_user` is `FAILED`, does not call the later operations, and the change function returns `INTERNAL` so that change is rolled back

### find by social account

- `find_user_by_social_account` has no `user_target`, and its role is `read`. In the game tx that `admin-api` opened, reads the row of key `(provider, provider_account_id)` of `auth_social_link` and returns its `user_id` and `linked_at`. When there is no row, `not_found`. Rows of withdrawn users do not appear because `storage.delete_user` deleted them
- When `provider_account_id` is the empty string, `bad_request`
- Used when an operator finds a user ID by a provider account ID that a player gave

- `find_user_by_public_code` has no `user_target`, and its role is `read`. In the game tx that `admin-api` opened, finds the user with `storage.find_user_by_public_code`. When the input is not a public code input, `bad_request`; when no user is found, `not_found`. Otherwise outputs that `user_id` and `withdrawn_at` of `storage.get_user_record` (null when none)

### web account deletion

Web account deletion is the web page on which a user requests the withdrawal of their own account outside the app. The page address is the current environment's `serverUrl` with one trailing `/` removed and `/account/deletion` appended, and for LOCAL it is `http://127.0.0.1:<port the server listens on>/account/deletion`. The user proves that the account is theirs with a deletion code or a linked Google account.

- `routing` collects `GET /account/deletion` and `POST /account/deletion`, and they do not go through the request processing order or access token authentication. The client IP is the value that `routing` passed to the route handler
- `IssueDeletionCode`: makes a deletion code of `auth.deletionCodeLength` characters with secure random. The characters are `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Inserts or replaces that user's `auth_deletion_code` row with `code_hash`(lowercase hex SHA-256 of the code), `attempts` 0, `expires_at`(request time + `auth.deletionCodeTtlMs`). The response is `code`, `expires_at`, `url`(the page address)
- `GET /account/deletion` returns with HTTP 200 the HTML page that auth makes in code
  - page language: looks at the language ranges of `Accept-Language` in descending order of q value, and in written order when equal. It is the tag of the first range for which game settings `supportedLanguages` has the same tag, ignoring case. When there is none, it is, from the first range for which a supported language with the same primary subtag exists, the first supported language with that primary subtag. When that also does not exist, it is game settings `sourceLanguage`
  - The page text is the text found by reading the page language translation binary of `server/build/data/` with `GameData.load_translation`, by the translation key that the `ReservedString` accessor of `DataSet` returned
  - deletion code form: `[auth_deletion_title]`, `[auth_deletion_body]`, public code input `[auth_deletion_user_id]`, deletion code input `[auth_deletion_code]`, confirmation checkbox `[auth_deletion_confirm]`, submit button `[auth_deletion_submit]`
  - Google form: present only when `adapters.login-google` of the current environment is not `null`. `[auth_deletion_google]`, confirmation checkbox `[auth_deletion_confirm]`, sign-in. When the adapter is `login-google`, the sign-in is the Google Identity Services sign-in button with client ID `loginGoogle.serverClientId`, and its callback puts the received ID token into field `credential` and sends the form. When the adapter is `fake`, the sign-in is a text input of field `credential` and submit button `[auth_deletion_submit]`
  - Both forms send to `POST /account/deletion` as `application/x-www-form-urlencoded`. The fields are `method`(`code` or `google`), `confirm`(`yes` when the checkbox is on), and `public_code`, `code` of the `code` method and `credential` of the `google` method
- result page: one text found in the page language and a link `[auth_deletion_back]` to the page address
- headers of the page and the result page: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; script-src 'nonce-<nonce>' https://accounts.google.com/gsi/client; style-src 'nonce-<nonce>' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src https://accounts.google.com/gsi/; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. `<nonce>` is the standard base64 of 16 byte secure random made per response, and the `script` and `style` elements of the page carry that nonce
- `POST /account/deletion` processing order. When a step fails, ends with that step's HTTP status and result page. When `run_game_transaction` of step 1 or `run_user_transaction` of step 4 is `FAILED`, 500 and `[auth_deletion_retry]`
  1. IP limit: one `storage.run_game_transaction` increments by 1 and reads the `count` of the `auth_deletion_ip_counter` row of the client IP and the current minute window of `server-time`, and commits. `window_start` is the window start of that minute window, and `expires_at` is the window end. When the incremented value exceeds `auth.deletionAttemptsPerMinute`, 429 and `[auth_deletion_rate_limited]`
  2. body: 400 and `[auth_deletion_failed]` when any of the following holds. `Content-Type` is not `application/x-www-form-urlencoded`. The accumulated body exceeds `routing.maxBodyBytes` or the total body read duration exceeds `routing.bodyReadTimeoutMs`. There is an unknown field or two fields of the same name. `confirm` is not `yes`. `method` is neither `code` nor `google`, or a field of that method is missing. `public_code` is not a public code input of `storage`. `code`, with whitespace and `-` removed and changed to uppercase, is not `auth.deletionCodeLength` deletion code characters. `credential` exceeds `auth.maxCredentialBytes`. The method is `google` and `adapters.login-google` of the current environment is `null`
  3. maintenance: when `admin-api.is_maintenance` is `true`, 503 and `[auth_deletion_retry]`
  4. identity check
     - `code` method: finds the user with `storage.find_user_by_public_code` in `storage.read_db`, and reads the `auth_deletion_code` row in one `storage.run_user_transaction` of that user. When no user is found, `run_user_transaction` is `WITHDRAWN`, there is no row, or `expires_at` ≤ `clock_now`, it is a failure. Compares the SHA-256 of the `code` changed in 2 with `code_hash` in constant time; when they differ, increments `attempts` by 1, deletes the row when the incremented value is `auth.deletionCodeMaxAttempts`, commits, and it is a failure. When they are equal, does 5 in the same transaction
     - `google` method: calls `verify` of that adapter outside a transaction. A rejection is a failure, and time limit exceeded and communication failure are 502 and `[auth_deletion_retry]`. When `auth_social_link` has no row (`GOOGLE`, the received provider account ID), it is a failure. When it has, does 5 in one `storage.run_user_transaction` of the user of that row. When `run_user_transaction` is `WITHDRAWN`, it is a failure
     - A failure is 403 and `[auth_deletion_failed]`. A nonexistent user, a withdrawn user, a wrong code, an expired code and an unlinked account get the same page
  5. withdrawal: calls the same operations as `withdraw_user` in the same order, and leaves `reason` `web_deletion`, `method` and the truncated IP in the `audit` log. 200 and `[auth_deletion_done]`. When `remove_user` is `FAILED`, does not call the later operations, the change function returns `INTERNAL` so that transaction is rolled back, and 500 and `[auth_deletion_retry]`

### real adapter

| adapter key | real adapter |
|---|---|
| `login-apple` | `login-apple` |
| `login-google` | `login-google` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `user_id` | user ID and login token | `module` | `app_functionality`, `account_management` | `true` | `false` | `false` | `false` | `all` | `none` |
| `user_id` | linked Apple account ID | `login-apple` | `account_management` | `true` | `false` | `false` | `true` | `ios`, `macos` | `none` |
| `user_id` | linked Google account ID | `login-google` | `account_management` | `true` | `false` | `false` | `true` | `android`, `ios`, `web`, `windows`, `macos`, `linux` | `none` |
| `other_data` | birth year and month of age confirmation | `module` | `app_functionality` | `true` | `false` | `false` | `false` | `all` | `consent.ageConfirmation = true` |

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| login without agreement to the current version | `CONSENT_REQUIRED` | `CONSENT_REQUIRED` | none |
| social credential rejection | `SOCIAL_LOGIN_INVALID` | `SOCIAL_LOGIN_INVALID` | `security` log |
| social adapter time limit exceeded, communication failure | `EXTERNAL_SERVICE_FAILED` | `EXTERNAL_SERVICE_FAILED` | `error` log |
| rejection, failure, time limit exceeded of `revoke` after `Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age | none. The result stays as it is | none | `error` log |
| unknown login token | `UNAUTHORIZED` | `UNAUTHORIZED` | `security` log. The raw token is not kept |
| `run_request_transaction` or `run_user_transaction` of `Login`, `AutoLogin`, `RefreshToken`, `DevLogin` is `WITHDRAWN` | `UNAUTHORIZED` | `UNAUTHORIZED` | none |
| no login token row when it is read again inside the transaction of `AutoLogin`, `RefreshToken` | `UNAUTHORIZED` | `UNAUTHORIZED` | none |
| failure of `session.check_current`, `session.verify_signature` in `RefreshToken` | the failure value of that operation | that failure value | `security` log |
| access token verification failure | `UNAUTHORIZED` | `UNAUTHORIZED` | `security` log by `routing` |
| access token expired | `TOKEN_EXPIRED` | `TOKEN_EXPIRED` | none |
| `Login`, `AutoLogin` of a user who is `below_minimum_age` | `AGE_BELOW_MINIMUM` | `AGE_BELOW_MINIMUM` | none |
| social account already linked, duplicate of the same provider | `ALREADY_LINKED` | `ALREADY_LINKED` | none |
| login of a ban target user | `BANNED` | `BANNED` | none |
| an item other than `TERMS`, `PRIVACY` or two of the same item in the list of agreed terms versions of `Login`, `AutoLogin`, `Login` and `LinkAccount` with a provider value that is not a provider or with a social provider without an adapter, `LinkAccount` of `GUEST`, `GUEST` `Login` with a credential, input violation of `ConfirmAge`, `UpdateConsent`, `UpdatePushConsent` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `withdraw_user` of a nonexistent or withdrawn user | 404 `not_found` | none | `audit` |
| `chat`, `friend`, `guild.remove_user` is `FAILED` in `Withdraw` or `ConfirmAge` under the minimum age | `FAILED`. Rolls back | `INTERNAL` | `error` log by `routing` |
| `chat`, `friend`, `guild.remove_user` is `FAILED` in `withdraw_user` | 500 `internal`. Rolls back | none | error rules of `admin-api` |
| `chat`, `friend`, `guild.remove_user` is `FAILED` in `POST /account/deletion` | HTTP 500, result page. Rolls back | none | `error` log |
| `find_user_by_social_account` for a social account without a linked user | 404 `not_found` | none | `audit` |
| `find_user_by_social_account` with an empty `provider_account_id` | 400 `bad_request` | none | `audit` |
| a secret cannot be read, terms URL format violation, age band boundary rule violation | server start failure | none | `error` log |
| deletion failure in guest cleanup | the job looks at that user again when it reaches the end and scans again from the beginning | none | `error` log |
| IP limit exceeded in `POST /account/deletion` | HTTP 429, result page | none | `security` log(`reason` `rate_limited_ip`). truncated IP |
| body violation in `POST /account/deletion` | HTTP 400, result page | none | none |
| `POST /account/deletion` during maintenance | HTTP 503, result page | none | none |
| identity check failure in `POST /account/deletion` | HTTP 403, result page | none | `security` log(`reason` `deletion_identity`). `method` and truncated IP |
| Google adapter time limit exceeded, communication failure in `POST /account/deletion` | HTTP 502, result page | none | `error` log |

Added `CoreError`: `UNAUTHORIZED`, `TOKEN_EXPIRED`, `CONSENT_REQUIRED`, `SOCIAL_LOGIN_INVALID`, `ALREADY_LINKED`, `EXTERNAL_SERVICE_FAILED`, `AGE_BELOW_MINIMUM`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `auth.accessTokenTtlMs` | integer | core | content | validity duration of an access token |
| `auth.maxTokenBytes` | integer | core | content | max bytes of a token accepted before decoding |
| `auth.maxCredentialBytes` | integer | core | content | max bytes of the credential of `Login`, `LinkAccount` |
| `environments.<ENV>.secrets.accessTokenKey` | string | game | none | name of the secret of the access token signing key |
| `termsDocuments` | object | game | none | `version`(integer) and `url` per `TERMS`, `PRIVACY` |
| `auth.socialVerifyTimeoutMs` | integer | core | content | time limit of one social login adapter call |
| `auth.jwksCacheMs` | integer | core | content | duration that provider public keys stay in the memory of the server instance |
| `appId` | string | game | none | `aud` of the Apple identity token and Apple `client_id` |
| `appleTeamId` | string | game | none | `iss` of the Apple `client_secret` JWT |
| `loginApple.keyId` | string | game | none | `kid` of the Apple `client_secret` JWT |
| `environments.<ENV>.secrets.loginApple` | string | game | none | name of the secret that holds the Sign in with Apple private key(`.p8` PEM) |
| `environments.<ENV>.secrets.loginGoogleDesktop` | string | game | none | name of the secret that holds the client secret of `loginGoogle.desktopClientId` |
| `loginGoogle.serverClientId` | string | game | none | server OAuth client ID accepted as `aud` of a Google ID token |
| `loginGoogle.iosClientId` | string | game | none | iOS OAuth client ID accepted as `aud` of a Google ID token. The empty string when none |
| `loginGoogle.desktopClientId` | string | game | none | Desktop app OAuth client ID accepted as `aud` of a Google ID token. The empty string when none |
| `auth.maxAgeYears` | integer | core | content | max age that `ConfirmAge` accepts |
| `auth.childAgeYears` | integer | core | content | criterion age of `child` |
| `auth.digitalConsentAgeYears` | integer | core | content | criterion age of `below_consent_age` |
| `consent.ageBandBoundaries` | array<integer> | game | none | list of age band boundary ages |
| `consent.minimumAge` | integer? | game | none | users below this age cannot log in. `null` means login is not blocked by age |
| `consent.ageConfirmation` | boolean | game | none | whether age confirmation is required |
| `consent.privacyChoices` | boolean | game | none | whether ad personalization and analytics choices are asked |
| `consent.version` | integer | game | none | version of the current privacy choices text |
| `pushConsent.adPush` | boolean | game | none | whether ad pushes are sent |
| `auth.inactiveGuestDeleteAfterMs` | integer? | core | content | duration after the last use until a guest account is deleted. null means guests are not deleted |
| `auth.guestSweepIntervalMs` | integer | core | content | guest cleanup period |
| `auth.guestSweepBatchSize` | integer | core | content | number of users that one guest cleanup run scans |
| `auth.maxDevAccountNameLength` | integer | core | content | max length of the dev account name of `DevLogin`. Only DEV code reads it |
| `environments.<ENV>.adapters.login-apple` | string? | game | none | social login adapter name of provider `APPLE`. `null` means this environment does not have that adapter |
| `environments.<ENV>.adapters.login-google` | string? | game | none | social login adapter name of provider `GOOGLE`. `null` means this environment does not have that adapter |
| `routing.externalMaxResponseBytes` | integer | core | content | max bytes of an external service response body. When a body exceeds it, that call is a failure |
| `auth.deletionCodeLength` | integer | core | content | number of characters of a deletion code |
| `auth.deletionCodeTtlMs` | integer | core | content | validity duration of a deletion code |
| `auth.deletionCodeMaxAttempts` | integer | core | content | number of times one deletion code can be entered wrong. When reached, that code is deleted. 1 or more |
| `auth.deletionAttemptsPerMinute` | integer | core | content | limit of `POST /account/deletion` per IP in one minute window |
| `environments.<ENV>.serverUrl` | string | game | none | the front part of the web account deletion page address |
| `supportedLanguages` | array<string> | game | none | the languages from which the page language of the web account deletion page is chosen |
| `sourceLanguage` | string | game | none | the page language when no supported language matches `Accept-Language` |
| `routing.maxBodyBytes` | integer | core | content | max bytes of the body of `POST /account/deletion` |
| `routing.bodyReadTimeoutMs` | integer | core | content | total time limit for reading the body of `POST /account/deletion` |

- The adapter names are `fake`, `login-apple` for `login-apple`, and `fake`, `login-google` for `login-google`. Client `AuthCore` also chooses the social adapter with the same key

## data

reserved string: `[auth_deletion_title]`, `[auth_deletion_body]`, `[auth_deletion_user_id]`, `[auth_deletion_code]`, `[auth_deletion_confirm]`, `[auth_deletion_submit]`, `[auth_deletion_google]`, `[auth_deletion_done]`, `[auth_deletion_failed]`, `[auth_deletion_retry]`, `[auth_deletion_rate_limited]`, `[auth_deletion_back]`

- `[auth_deletion_body]` tells the data that is deleted, the payment records of `iap` that are kept and not deleted, that account deletion does not cancel the store's auto-renewing subscriptions so the user must cancel them on the store's subscription management screen, and where to get a deletion code (the option screen of the app)

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `DevLogin` (core cheat). changes: `ConsentUserState` | dev account name | `AuthResult` | `UNAUTHORIZED`, `INVALID_REQUEST`, `BANNED`, `AGE_BELOW_MINIMUM` | `routing` DEV code. Sent by client `AuthCore`(`dev_login`) and `testing` |

- The DEV code of auth exports it and the DEV code of `routing` collects it. It is accepted without a session and does not check terms agreement
- A dev account name is from 1 to `auth.maxDevAccountNameLength` characters of `[a-z0-9_]`. The same name is the same user. When `auth_dev_account` has no row of that name, makes a new user and, in one `storage.run_user_transaction` of the new user, inserts the `auth_dev_account` row with an insert that does not insert when a row with the same `name` exists. When the user of that `name` read again is not the new user, deletes the new user with `storage.delete_user` in the same transaction. After this transaction commits, the user of that `name` is the user of `DevLogin`

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `DevLoginRequest` | `account_name` | `string` | `max_len_key`: `auth.maxDevAccountNameLength` |

core cheat response field

| message | field | type |
|---|---|---|
| `DevLoginResponse` | `result` | `AuthResult` |

- Does steps 4 to 7 of `Login` in the same way
- Not present on STG·PROD

## test

- Guest `Login` makes a new user and fills every field of `AuthResult`. `remote_config` equals the `GetRemoteConfig` response of the same user
- Two `Login`s with the same credential of the fake adapter give the same user, and a different credential gives a different user
- `Login` again with the social account of a withdrawn user gives a user ID different from before
- After the terms version rises, `Login`, `AutoLogin` with agreement to the previous version are `CONSENT_REQUIRED`
- `AutoLogin` with a list that holds only `TERMS` is `CONSENT_REQUIRED` regardless of the saved agreement records. `AutoLogin` with an empty list succeeds when both items have a record of agreeing to the current version, and is `CONSENT_REQUIRED` when an item has none
- `Login` and `AutoLogin` whose list of agreed terms versions has a `TERMS_ITEM_UNSPECIFIED` entry or two `TERMS` entries are `INVALID_REQUEST`, and make no user, agreement record or login token row
- After the next token received by `AutoLogin` is used for `RefreshToken` or `AutoLogin`, `AutoLogin` with the token that was requested is `UNAUTHORIZED`. Before the next token is used, `AutoLogin` with the token that was requested succeeds, and the earlier next token that was not used becomes `UNAUTHORIZED`
- After `AutoLogin` and before the next token is used, `RefreshToken` with the token that was requested gives a new access token of the session ID that that `AutoLogin` opened, and after that `RefreshToken` and `AutoLogin` with the next token succeed
- When the same user does `Login` on two devices, both login tokens are valid, access token requests and `RefreshToken` of the earlier device are `SESSION_REPLACED`, and `AutoLogin` of the earlier device succeeds and closes the session of the later device
- However far the time is moved with `advance_time`, `AutoLogin` with the login token succeeds
- `created_at` and `last_used_at` of the login token rows that `Login`, `DevLogin`, `AutoLogin` issued are the request time
- During a ban, `AutoLogin` is `BANNED` and the login token row stays, and after the ban ends, `AutoLogin` with the same token succeeds
- After `Logout`, that login token and access token are rejected
- When `Logout` of the same login token commits after `AutoLogin` or `RefreshToken` read the login token row outside a transaction and before it opens the transaction, that `AutoLogin`, `RefreshToken` is `UNAUTHORIZED` and that user has no new login token row
- An expired access token is `TOKEN_EXPIRED`, and a token with a changed signature, a payload with changed key order and a payload with an unknown key are `UNAUTHORIZED`
- The DB has no raw login token and the logs have no raw token
- `RefreshToken` gives a new access token of the same session ID and does not change the session signing key
- For a user with accumulated out-of-request changes, `pending_user_state` of the `RefreshToken` response is that pending delta, and after that the pending delta of that user is empty
- A second `LinkAccount` of the same provider and `LinkAccount` of a social account linked to another user are `ALREADY_LINKED`
- After `Withdraw`, no user-scope rows of that user remain and the next request is `UNAUTHORIZED`
- When the social adapter exceeds the time limit, `EXTERNAL_SERVICE_FAILED`, and no user is made
- `Login` and `AutoLogin` of a ban target user are `BANNED`, and `ServerError.ban` holds that user ID, `until_at` of the ban, the web account deletion page address, and the access token and session signing key of the new session. `IssueDeletionCode` sent with that access token gives a deletion code, and other requests are `BANNED`. The login token row of `AutoLogin` stays unchanged and there is no new login token row
- The settlement of an ended live event round and a started broadcast mail are in the full delta of the `Login` response
- For a user with accumulated `ItemChange`, `ItemMail` of out-of-request changes, `item_changes`, `item_mails` of the next `Login` response have those entries in the order they accumulated
- `RefreshToken` with a wrong signature is `UNAUTHORIZED`
- After `Withdraw`, that user is not in ranking query results
- After `Withdraw`, the friend link rows and guild member rows of that user and the chat messages that user sent are gone
- When `guild.remove_user` is `FAILED` because the lock wait time was exceeded while another transaction locked that user's guild row, `Withdraw` and `ConfirmAge` under the minimum age are `INTERNAL`, `withdraw_user` is 500 `internal`, `POST /account/deletion` is 500 and `[auth_deletion_retry]`, and job `auth_guest_sweep` does not delete that guest. In all cases the rows of that user have their values from before the handling, there is no `withdrawn_at`, and `revoke` is not called
- On STG·PROD, `DevLogin` is `UNAUTHORIZED`
- Two concurrent `DevLogin`s with the same new dev account name receive the same user ID, and there is one new user that is not a withdrawn user. The user made by the side that could not insert the `auth_dev_account` row has `withdrawn_at` and no user-scope rows
- After `ConfirmAge`, `age_from`, `age_to`, `child`, `below_consent_age` of `ConsentUserState` equal the calculation rules at each boundary of `consent.ageBandBoundaries`, at the boundary age and at one year below it, and the birth year and month is not in UserState or logs
- `ConfirmAge` with an age below `consent.minimumAge` succeeds and `below_minimum_age` of response `consent` is `true`, that user has no user-scope rows and the `user` row has the withdrawal time, the next request of that session and `AutoLogin` with that login token are `UNAUTHORIZED`, and `reason` `age_blocked` is left in the `audit` log. When that user has `APPLE` linked, the fake adapter receives `revoke` once
- With game settings whose boundary list is not in ascending order or does not hold `auth.childAgeYears`, `auth.digitalConsentAgeYears`, `consent.minimumAge`, the server does not start
- With game settings whose `consent.minimumAge` is `null`, the server starts, and after `ConfirmAge` of every age band, `below_minimum_age` is `false`
- A second `ConfirmAge` does not change the age band. Month 13, a future year and month, and more than `auth.maxAgeYears` are `INVALID_REQUEST`
- In the next `Login` in the UTC month that is the birth month, `age_from`, `age_to` are recalculated
- When `consent.privacyChoices` is `true`, before an answer and with `DENIED`, `analytics_allowed`, `ad_personalization_allowed` are `false`, and with `GRANTED` they are `true`. For a user who is `below_consent_age`, `ad_personalization_allowed` is `false` even with `GRANTED`, and for a user who is `child`, `analytics_allowed` is `false`. When `consent.privacyChoices` is `false` and `ad_personalization` is `DENIED`, `ad_personalization_allowed` is `false`
- When `consent.ageConfirmation` is `true`, `analytics_allowed` of a user before age confirmation is `false` regardless of the `analytics` choice, and after `ConfirmAge` with an age that is not `child`, it is recalculated by the choice. When `consent.ageConfirmation` is `false`, it follows the choice even before age confirmation
- When the version of `UpdateConsent` differs from `consent.version`, `INVALID_REQUEST`, and one `auth_consent_record` row is made per changed item
- When two `UpdateConsent`s at the same request time change the same item, that user has two `auth_consent_record` rows and their `seq` is 1, 2
- `version` of the `auth_consent_record` rows that `UpdateConsent` left is the privacy choices version of the request, and `version` of the rows that `UpdatePushConsent` left is 0
- After `Withdraw`, `auth_age`, `auth_consent_record` have no rows of that user
- The social credential verification of `LinkAccount` runs outside the user transaction, a verification rejection is `SOCIAL_LOGIN_INVALID`, and there is no account link row
- `GUEST` `Login` with a credential is `INVALID_REQUEST` and makes no user
- `Login`, `LinkAccount` whose provider is `LOGIN_PROVIDER_UNSPECIFIED` or a value not defined in `LoginProvider` are `INVALID_REQUEST` and make no user or account link row
- `LinkAccount` of `GUEST` is `INVALID_REQUEST`
- In an environment whose `adapters.login-google` is `null`, `Login` and `LinkAccount` of provider `GOOGLE` are `INVALID_REQUEST` without an adapter call
- Two concurrent `Login`s with the same new social account receive the same user ID, and there is one new user that is not a withdrawn user. The user made by the side that could not insert the account link row has `withdrawn_at` and no user-scope rows, and `core_user_created` is left only for the request of the side that inserted the account link row
- When two users do `LinkAccount` concurrently with the same social account, only one is linked and the other is `ALREADY_LINKED`
- After `withdraw_user`, the user-scope rows and push device registration rows of that user are gone and the next request is `UNAUTHORIZED`. `withdraw_user` of a nonexistent user and of a withdrawn user is `not_found`
- When `Login` of provider `GOOGLE` receives a desktop credential, it calls `exchange_desktop` of the fake adapter and then `verify` with the received ID token. A desktop credential whose `redirect_uri` is not `http://127.0.0.1:<port>` is rejected by `exchange_desktop` without calling Google and is `SOCIAL_LOGIN_INVALID`. The log of the failed request has no authorization code and no code verifier
- `Login` and `LinkAccount` of provider `APPLE` call `exchange` of the fake adapter and write the received refresh token to `auth_apple_token`. When `exchange` is rejected, `SOCIAL_LOGIN_INVALID`, and no user is made
- After `Withdraw` of a user with `APPLE` linked, the fake adapter receives `revoke` of that refresh token once. Even when `revoke` fails, `Withdraw` succeeds and an `error` log is left
- Logs have no refresh token
- `UpdatePushConsent` sets `_at` of the changed items to the request time, leaves one `auth_consent_record` row per item, and calls `push.refresh_push_consent`. When `pushConsent.adPush` is `false` or a value is `CONSENT_CHOICE_UNSPECIFIED`, `INVALID_REQUEST`
- On a test server started by giving `testing.start_test_server` the real adapter list `login-google`, `login-apple` and setting the JWKS of a test key with `set_key_source`, `verify` of the real `login-google` adapter accepts a token signed with that key whose `aud` is `loginGoogle.serverClientId` and another such token whose audience is `loginGoogle.desktopClientId`, and rejects a token whose `aud` is none of the three client IDs, a token with a different `iss`, an expired token and a token signed with another key. Real `login-apple` rejects an identity token whose `aud` is not `appId`. This test server starts without the host secret store, with the `loginApple` test value that `start_test_server` made, and provider `APPLE` `Login` with an identity token that passed `verify` is `EXTERNAL_SERVICE_FAILED` because of a communication failure of `exchange`
- Repeats `testing.advance_time`(`auth.guestSweepIntervalMs`) and `wait_background` ⌈number of users / `auth.guestSweepBatchSize`⌉ times. When `auth.inactiveGuestDeleteAfterMs` is null, nobody is deleted. When it has a value, job `auth_guest_sweep` deletes only the guests that reached last use time + that value, and users with a social link and guests that did not reach it remain. A guest that has a `GRANTED` payment record that is not a test transaction remains even when it reached it, and a guest with only records of test transactions is deleted. The next request of a deleted user is `UNAUTHORIZED`
- `Login` of a user who allowed analytics leaves core analytics event `core_session_started`, and `Login` that made a new user leaves `core_user_created` before it
- `find_user_by_social_account` for a social account linked with `LinkAccount` returns that user ID and `linked_at` to an operator that has only role `read`, and saved state stays unchanged. An unlinked account and the account of a user who did `Withdraw` are 404 `not_found`, and an empty `provider_account_id` and provider `GUEST` are 400 `bad_request`
- `IssueDeletionCode` returns a deletion code of `auth.deletionCodeLength` characters and an `expires_at` of request time + `auth.deletionCodeTtlMs`, and the DB has no raw code. When it is called again, `POST /account/deletion` with the earlier code is 403
- `POST /account/deletion` of the `code` method with a correct code is 200, that user has no user-scope rows, the next request is `UNAUTHORIZED`, and `reason` `web_deletion` is left in the `audit` log
- A wrong code is 403 and `attempts` rises by 1. After `auth.deletionCodeMaxAttempts` wrong attempts, a correct code is also 403. A code at its `expires_at` time, a nonexistent user and a withdrawn user are also 403, and the result page is the same
- The `google` method sent with a credential of the fake `login-google` adapter deletes the user linked to that Google account, and an unlinked account is 403. When `adapters.login-google` is `null`, the `GET /account/deletion` page has no Google form and the `google` method is 400
- A body without `confirm` or with an unknown field is 400 and saved state stays unchanged
- When `POST /account/deletion` from the same IP exceeds `auth.deletionAttemptsPerMinute` in one minute window, it is 429, and it is accepted again in the next minute window
- During maintenance, `POST /account/deletion` is 503 and saved state stays unchanged, and `GET /account/deletion` is 200
- When `Accept-Language` matches a supported language only in the primary subtag, the page is in that supported language, and when no language matches, the page is in `sourceLanguage`
- The page and the result page have the `Content-Security-Policy` header, and the `script` element of the page carries the nonce of that header
- `AuthResult` of `Login` and `AutoLogin` has the public code of that user, and the same one at every login
- `POST /account/deletion` with the `code` method finds the user by `public_code` written in lowercase with `-`; a `public_code` that is not a public code input is 400 and `[auth_deletion_failed]`, and a code no user has is 403 and `[auth_deletion_failed]`
- `find_user_by_public_code` gives `user_id` and `withdrawn_at` of a user and of a withdrawn user, `not_found` for a code no user has, and `bad_request` for a text that is not a public code input
