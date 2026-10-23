# AuthCore

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

Handles the screen flow of terms agreement, age confirmation, privacy choices, ad push consent and the tracking permission request, and handles guest login, social login, auto login, login token storage, the install marker, account recovery, access token refresh, account link, the persistent storage request and link prompt for web guests, account switch, logout, withdrawal, and getting the deletion code for web account deletion. It passes consent results to `LogCore`, reports them through `get_consent` and `ConsentChangedEvent`, and passes the session that login opened to `NetworkCore`.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `LocalizationCore`, `UICore`, `MessageCore`, `NetworkCore`, `UserStateCore`

- server dependency: `auth`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_storage_scope` | storage scope text. Called before `init` | none | none | `BootstrapCore`(`InitModules`) |
| `set_social_adapter` | social `LoginProvider`, social adapter. Called before `init` | none | none | `BootstrapCore`(`InitModules`) |
| `boot_login` | none | async operation. `LoginResult` | `LoginResult` with `Failed` | `BootstrapCore`(`Login`) |
| `prepare_terms` | none | async operation. `TermsStatus` | `Failed` | content code |
| `open_terms_document` | `TermsItem` | async operation. success flag | `false` | content code |
| `prepare_consent` | none | async operation. `ConsentResult` | `Failed` | `boot_login`, content code |
| `open_privacy_choices` | none | async operation. success flag | `false` | content code |
| `is_privacy_choices_enabled` | none | game settings `consent.privacyChoices` | `false` | content code |
| `get_consent` | none | `ConsentInfo` | `ConsentInfo` with `age_confirmed` `false`, `age_from` and `age_to` 0, `child` and `below_consent_age` `true`, `ad_personalization_allowed` and `analytics_allowed` `false`, `tracking` `TRACKING_STATUS_UNSPECIFIED`, `push_ad` and `push_night` `CONSENT_CHOICE_UNSPECIFIED` | `AdCore`, `PushCore`, content code |
| `update_push_consent` | `push_ad`, `push_night`(`ConsentChoice`) | async operation. success flag | `false` | `prepare_consent`, `PushCore` |
| `is_ad_push_enabled` | none | game settings `pushConsent.adPush` | `false` | content code |
| `report_ad_consent` | `personalized` of ads adapter `request_ad_consent` | async operation. success flag | `false` | `AdCore` |
| `login` | `LoginProvider` | async operation. `LoginResult` | `LoginResult` with `Failed` | `boot_login`, core test |
| `is_provider_supported` | `LoginProvider` | whether it can be used in this build and platform | `false` | `PaymentCore`, content code |
| `is_logged_in` | none | whether there is a session | `false` | core, content code |
| `get_user_id` | none | user ID | `0` | core, content code |
| `get_access_token` | none | async operation. success flag, access token, `RequestFailure` on failure | `false`, empty token, `RequestFailure` | `RealtimeCore` |
| `refresh_access_token` | none | async operation. success flag, access token, `RequestFailure` on failure | `false`, empty token, `RequestFailure` | `RealtimeCore` |
| `get_login_remote_config` | none | `remote_config` of `AuthResult` of the last login success response (`GetRemoteConfigResponse`: `entries`, `assignments`) | `GetRemoteConfigResponse` with empty `entries`, `assignments` | `RemoteConfigCore` |
| `list_linked_providers` | caller buffer | count filled | `0` | `PaymentCore`, content code |
| `link_account` | social `LoginProvider` | async operation. `LinkStatus` | `Failed` | content code |
| `switch_account` | social `LoginProvider` | async operation. `LoginResult` | `LoginResult` with `Failed` | content code |
| `logout` | none | async operation. none | none | content code |
| `withdraw` | none | async operation. success flag | `false` | content code |
| `issue_deletion_code` | none | async operation. `DeletionCodeResult` | `DeletionCodeResult` whose success flag is `false` | `BootstrapCore`(login failure popup), content code |

### type

| type | contents |
|---|---|
| `LoginProvider` | enum of base proto. `GUEST`, `APPLE`, `GOOGLE` |
| `TermsStatus` | `Agreed`, `Refused`, `Failed` |
| `LoginResult` | `LoginStatus`, user ID (only for `Success`, `Banned`), ban end time (only for `Banned`. 0 when the ban does not end), deletion page address (only for `Banned`. Otherwise an empty string), error code (only when `Failed` is a server error. Otherwise `0`) |
| `LoginStatus` | `Success`, `NoToken`, `Cancelled`, `Rejected`, `ConsentRequired`, `Banned`, `AgeBlocked`, `Failed` |
| `LinkStatus` | `Success`, `Cancelled`, `AlreadyLinked`, `Failed` |
| `ConsentInfo` | `age_confirmed`(whether `age_confirmed_at` is not 0), `age_from`, `age_to`, `child`, `below_consent_age`, `ad_personalization_allowed`, `analytics_allowed`, `tracking`(`TrackingStatus` of this device), `push_ad`, `push_night` |
| `ConsentResult` | `Done`, `AgeBlocked`, `Failed` |
| `DeletionCodeResult` | success flag, `code`, `expires_at`, `url`. On failure, `code` and `url` are empty strings and `expires_at` is 0 |

## behavior

### terms

- The terms items are `TERMS` and `PRIVACY` of base proto enum `TermsItem`. The agreed version is saved on the device per item
- `prepare_terms`
  1. Sends `GetTerms` with `send_auth`. When it fails, `Failed`. Per item, the current version and the document URL are `version` and `url` of the `TermsDocument` in response `documents` whose `item` is that item
  2. The document URL of every item must pass the document URL check. Otherwise, error log and `Failed`
  3. When the saved version equals the current version for every item, `Agreed` without a screen
  4. Otherwise it opens the terms popup with `UICore.open_popup` and waits until it closes. When it cannot open it, error log and `Failed`
  5. When the popup closes with confirm and every item is on, it saves the current version per item and returns `Agreed`. Otherwise `Refused` without changing the saved values
- document URL check: the scheme is `https`, there is a host, and there is no user info. A build that contains DEV code also accepts scheme `http`
- The terms popup is the prefab of game settings `termsPopup`, and its root is the core `TermsPopup` class. `TermsPopup` points to a toggle and a view-document button per item and to a confirm button. When any of them is missing, the param check of the popup fails
  - `TermsPopup` binds the text of the elements to `[auth_terms_title]`, `[auth_terms_agree_terms]`, `[auth_terms_agree_privacy]`, `[auth_terms_view]`, `[auth_terms_confirm]` with `LocalizationCore.bind_text`
  - The view-document button opens the URL of that item with the OS URL open. It does not draw the document inside the popup
  - When the popup closes in a way other than confirm, `Refused`
- The saved agreed versions go in the `Login` and `AutoLogin` requests. When `prepare_terms` has not returned `Agreed` since the current `init`, `login`, auto login and `switch_account` are `Failed` without a request
- `open_terms_document`: sends `GetTerms` with `send_auth` and opens the received document URL of that item with the OS URL open. When `GetTerms` fails, `false`. When the URL does not pass the document URL check or the OS cannot open the URL, error log and `false`. It does not change the saved agreed versions

### login

- `login`
  - `GUEST`: sends `Login` without a credential
  - social: waits for the sign-in of the social adapter. `Cancelled` gives `Cancelled` without a request; a failure gives `Failed` without a request. On success, it sends `Login` with the received credential
- `login` while there is a session is `Failed` without a request. Social login from content code goes through `switch_account`
- auto login: when there is a pending token it uses that; otherwise it reads the storage item. `NotFound` gives `NoToken` without a request; another failure gives `Failed` without a request. When it cannot get a login token from the read value (the value is not a UTF-8 JSON object, or `login_token` is not a non-empty string), it leaves an error log and gives `Rejected` without a request. When there is a token, it sends `AutoLogin` with the login token in `Authorization`
- new account login: `login(GUEST)`
- `boot_login`
  1. Checks the install marker. When the check fails, returns `Failed`
  2. Reads the age block marker. When it exists, returns `AgeBlocked` without a request. On a read failure other than `NotFound`, returns `Failed`
  3. Calls `prepare_terms`. On `Refused`, calls it again. On `Failed`, returns `Failed`
  4. Does auto login. On `NoToken` it does new account login, on `Rejected` account recovery, and uses that result
  5. When the result is `ConsentRequired` for the first time in this `boot_login`, goes to 3. When it is not `Success`, returns the result
  6. Calls `prepare_consent`. On `Done` it returns the result of 4, on `AgeBlocked` a `LoginResult` with `AgeBlocked`, on `Failed` a `LoginResult` with `Failed`
- `Login`, `AutoLogin`, `RefreshToken`, `GetTerms` are sent with `NetworkCore.send_auth`. Only `RefreshToken` gets a signature
- Server errors are converted to `LoginStatus`

| error code | `LoginStatus` |
|---|---|
| `UNAUTHORIZED`, `TOKEN_EXPIRED` | `Rejected`. Does not delete the storage item |
| `CONSENT_REQUIRED` | `ConsentRequired`. The caller calls `prepare_terms` again |
| `BANNED` | `Banned` |
| `AGE_BELOW_MINIMUM` | `AgeBlocked` |
| other, communication failure | `Failed` |

- login success order
  1. Writes the new login token and `linked_providers` of the response as the storage item
  2. Keeps the access token, `access_token_expires_at`, the session signing key, the login token of the response, the user ID, the linked provider list, `consent` and `remote_config` in the session in memory, and does consent apply. Calls `UserStateCore.set_user_created_at` with `user_created_at` of the response
  3. Passes its own `SessionProvider` to `NetworkCore.set_session_provider`
  4. Emits `LoginCompletedEvent`
- When 1 fails, `login` returns `Failed` and keeps the previous session and storage item. `switch_account` follows the `switch_account` rules. Auto login does 2 to 4 and returns `Success`. It then keeps the new token in memory as a pending token, together with the login token that the `AutoLogin` sent, and writes it again on `AppBackgroundEnteredEvent`, `AppForegroundReturnedEvent`, `AppQuitEvent`, `release` and token refresh success until a write succeeds. When the write succeeds, it deletes the login token kept with the pending token. In the other cases that delete the pending token, it also deletes the login token kept with it
- `NetworkCore` passes the UserState delta of the response to `UserStateCore`
- The user ID, ban end time and deletion page address of `Banned` are `user_id`, `until_at`, `deletion_url` of the ban detail of `RequestFailure`. When there is no ban detail, they are 0, 0 and an empty string
- ban session: when there is no session, `Login` or `AutoLogin` ends with `BANNED`, and `access_token` of the ban detail is not an empty string, it keeps that user ID, `access_token` and `session_signing_key` in memory as a ban session. A ban session is not a session. It is not passed to `NetworkCore.set_session_provider`, and `is_logged_in` is `false`. It is deleted on login success and on `release`

### login token storage

- The login token is kept only in memory (the session and the pending token) and in OS secure storage. A client run in a browser without OS secure storage keeps it in the browser storage of that game origin instead of OS secure storage. It is not kept in files or in `LocalDataCore`
- There is one storage item per scope, and its value is the UTF-8 JSON object `{"login_token": <login token>, "linked_providers": [<LoginProvider element name>, ...]}`. `linked_providers` is the linked provider list in memory at the time of the write. Writing a pending token uses the same format
- When `linked_providers` of a read storage item is missing or not an array, it counts as an empty list, and elements that are not a `LoginProvider` element name are discarded with a warn log. The recovery provider of account recovery is decided from the remaining elements
- The storage item name contains the scope text received with `set_storage_scope`. When the scope text is an empty string, the storage is not used and every operation is `Failed`
- The results of read, write and delete are `Ok`, `NotFound`, `Denied`, `Unsupported`, `Failed`. They do not block the main thread and do not show an OS authentication screen. When authentication is needed, `Denied`
- Storage operations run one at a time, in the order they started. On `release`, the async operations of callers waiting for a storage operation end as failures. That storage operation is not cancelled, and its late result is discarded
- When a storage operation has not ended at `release` (including a pending token write that `release` started), the first storage operation after `init` again starts after it ends
- The time limit of a storage operation (`AuthCore.storageCallTimeoutMs`) is measured as real elapsed time while `TimeCore` runs. The time while `TimeCore` is stopped after `release` is not counted, and counting continues after a new `TimeCore.init`
- The access token and the session signing key are kept only in memory

### install marker

- The install marker is the file `auth/installed` under the app storage root of `LocalDataCore`. It is deleted with the app, while the storage item in OS secure storage remains on some platforms
- check: when `LocalDataCore.read_file`(`auth/installed`, 1) succeeds, the check is done. On `NotFound`, it deletes the storage item (`NotFound` also counts as success) and writes the 1 byte `1` with `LocalDataCore.write_file`. Any other read failure, a delete failure or a write failure is a check failure
- So after the app is deleted and installed again, no platform uses a remaining login token

### account recovery

- When auto login is `Rejected`, it opens the account recovery popup without deleting the storage item. The recovery provider is the first provider in `linked_providers` of the storage item whose `is_provider_supported` is `true`. The order is `APPLE`, `GOOGLE`
- The account recovery popup is opened with `UICore.open_system_popup`. It has no back button
  - When there is a recovery provider: body `[auth_recover_linked]`, and the buttons are the one of `[auth_recover_login_apple]`, `[auth_recover_login_google]` for that provider and `[auth_recover_new]`
  - Otherwise: body `[auth_recover_guest]`, button `[auth_recover_new]`
- The button of the recovery provider does `login`(recovery provider). On `Cancelled` or `Failed`, it opens the account recovery popup again. Any other result is the result of account recovery
- `[auth_recover_new]` opens the new-start confirm popup: body `[auth_recover_new_confirm]`, buttons `[auth_recover_new_ok]`, `[auth_recover_back]`, back button `[auth_recover_back]`. `[auth_recover_new_ok]` deletes the storage item and does new account login, and its result is the result of account recovery. `[auth_recover_back]` opens the account recovery popup again
- When the account recovery popup or the new-start confirm popup closes with only the hidden callback called and no button callback, it opens the account recovery popup again
- When it cannot open a popup or cannot delete the storage item, it leaves an error log, and the result of account recovery is `Failed`

### access token

- remaining time = `access_token_expires_at` − server time of `TimeCore`
- `SessionProvider.get_access_token`: when the remaining time is `AuthCore.tokenRefreshMarginMs` or less, it refreshes and then returns the token. Without a session, it fails with a `RequestFailure` whose `FailureKind` is `ConnectionFailed`; when the refresh fails, it fails with the `RequestFailure` of that `RefreshToken`
- `SessionProvider.refresh_access_token`: refreshes regardless of the remaining time
- `get_access_token` is the same as `SessionProvider.get_access_token`, and `refresh_access_token` is the same as `SessionProvider.refresh_access_token`
- A refresh sends `RefreshToken` with the login token that the `AutoLogin` sent, kept with the pending token, when there is a pending token; otherwise with the login token in the session in memory. It does not read the storage item. This is because sending with the pending token makes the server invalidate the token in the storage item, so the account is lost when the app ends before the save. On success, it replaces the access token and the expiry time with `access_token` and `access_token_expires_at` of the response. When a refresh is in progress, it does not send a new one and uses that result
- Each frame, when there is a session and the remaining time is `AuthCore.tokenRefreshMarginMs` or less, it refreshes. When this refresh fails, it does no frame refresh until the next `AppForegroundReturnedEvent` or the next refresh success
- On `AppForegroundReturnedEvent`, it refreshes when there is a session
- When a refresh gets `UNAUTHORIZED` or `TOKEN_EXPIRED`, it deletes the session in memory and the pending token, passes none to `NetworkCore.set_session_provider`, emits `SessionEndedEvent(Rejected)`, and emits `EventCore.RestartRequestedEvent`. It does not delete the storage item
- When a refresh gets `SESSION_REPLACED`, or `SessionProvider.notify_session_replaced` is called while there is a session, it deletes the session in memory, passes none to `NetworkCore.set_session_provider`, emits `SessionEndedEvent(Replaced)`, and opens the session replaced popup. It does not delete the pending token and the storage item
- session replaced popup: `UICore.open_system_popup`, body `[auth_session_replaced]`, one button `[auth_go_to_title]`, back button none. The button emits `RestartRequestedEvent`. While it is open, it is not opened again. When it cannot be opened, it leaves an error log and emits `RestartRequestedEvent`

### age and privacy choices

- Uses `ConsentUserState`, which server `auth` saves and calculates. `ConsentChoice` and `TrackingStatus` are enums of base proto. AuthCore does not save it on the device
- The age block marker is the file `auth/age_blocked` under the app storage root of `LocalDataCore`. A write writes the 1 byte `1` with `LocalDataCore.write_file`, and a read is `LocalDataCore.read_file`(`auth/age_blocked`, 1). AuthCore does not delete this file. It is deleted with the app
- `prepare_consent`. Without a session, `Failed`. It does the following in order, and when a sent request fails, it ends with `Failed`
  1. When game settings `consent.ageConfirmation` is `true` and `age_confirmed_at` is 0, it opens the age popup. It sends `ConfirmAge` with the birth year and month received on confirm
  2. When `below_minimum_age` is `true`, server `auth` has deleted that account. It deletes the session in memory, the pending token and the storage item, writes the age block marker, passes none to `NetworkCore.set_session_provider`, emits `SessionEndedEvent(AgeBlocked)`, and ends with `AgeBlocked`. A failure to delete the storage item or to write the age block marker only leaves an error log
  3. When game settings `consent.privacyChoices` is `true` and `privacy_version` of `ConsentUserState` differs from game settings `consent.version`, it opens the privacy popup and sends `UpdateConsent` with the received choices and the device tracking state
  4. When game settings `pushConsent.adPush` is `true` and `push_ad_at` is 0, it opens the push consent popup and calls `update_push_consent` with the received choices
  5. When the platform is `ios`, game settings `consent.trackingRequest` is `true`, `ad_personalization_allowed` is `true` and the device tracking state is `NOT_DETERMINED`, it shows the OS tracking permission request (iOS App Tracking Transparency) and waits for the answer
  6. When the device tracking state differs from `tracking` of `ConsentUserState`, it sends `UpdateConsent` with the current choices and that state
  7. `Done`
- `open_privacy_choices`: `false` when there is no session or `consent.privacyChoices` is `false`. It opens the privacy popup with the current choices as initial values and sends `UpdateConsent` with the received choices
- The choices in `UpdateConsent`: when `consent.privacyChoices` is `false`, `analytics` is `CONSENT_CHOICE_UNSPECIFIED` and `ad_personalization` is the value in `ConsentUserState`. When it is `true`, they are the values received from the popup or in `ConsentUserState`. `privacy_version` is `consent.version`
- `report_ad_consent`: without a session, `false`. When the `ConsentChoice` of the received flag (`true` is `GRANTED`, `false` is `DENIED`) equals `ad_personalization` of `ConsentUserState`, `true` without a request. When it differs, it sends `UpdateConsent` with that value in `ad_personalization` and the current values for the rest. The failure callback of this `UpdateConsent` returns `true`, and the failure is not displayed on screen
- `update_push_consent`: `false` without a request when there is no session, game settings `pushConsent.adPush` is `false`, or a value is `CONSENT_CHOICE_UNSPECIFIED`. It sends `UpdatePushConsent`. On success, it tells the result per changed item with `MessageCore.show_toast`. When `push_ad` changes to `GRANTED`, `[auth_push_ad_granted]`; when it changes to `DENIED`, `[auth_push_ad_denied]`; for `push_night`, `[auth_push_night_granted]`, `[auth_push_night_denied]`. Format argument `{date}` is that `_at` value of the response
- device tracking state: on platform `ios`, the value the OS gives; on other platforms, `NOT_APPLICABLE`
- The age popup is the prefab of game settings `agePopup`, and its root is the core `AgePopup` class. It points to the year input, the month input and the confirm button. The text is bound to `[auth_age_title]`, `[auth_age_year]`, `[auth_age_month]`, `[auth_age_confirm]`, `[auth_age_invalid]` with `LocalizationCore.bind_text`
  - On confirm, when the year input is not a 4-digit number, the month is not from 1 to 12, the year and month are after the UTC year and month of the server time of `TimeCore`, or the age is more than `auth.maxAgeYears`, it does not close the popup and shows `[auth_age_invalid]`. The age is counted from that UTC year and month with the same formula as the age calculation of server `auth`
  - When the popup closes in a way other than confirm, it opens again
- The privacy popup is the prefab of game settings `privacyPopup`, and its root is the core `PrivacyChoicesPopup` class. It points to the ad personalization toggle, the analytics toggle and the confirm button. The text is bound to `[auth_privacy_title]`, `[auth_privacy_ad_personalization]`, `[auth_privacy_analytics]`, `[auth_privacy_confirm]`
  - A toggle that is on is `GRANTED`, and off is `DENIED`. In `prepare_consent` the popup opens with both off
  - When the popup closes in a way other than confirm, both are sent as `DENIED`
- The push consent popup is the prefab of game settings `pushConsentPopup`, and its root is the core `PushConsentPopup` class. It points to the ad push toggle, the night ad push toggle and the confirm button. The text is bound to `[auth_push_title]`, `[auth_push_ad]`, `[auth_push_night]`, `[auth_push_confirm]`
  - A toggle that is on is `GRANTED`, and off is `DENIED`. The popup opens with both off
  - When the popup closes in a way other than confirm, both are sent as `DENIED`
- The three popups are opened with `UICore.open_popup`. When one cannot be opened or an element is missing, error log and failure value
- How each engine maps the elements that `TermsPopup`, `AgePopup`, `PrivacyChoicesPopup`, `PushConsentPopup` point to and the elements each text is bound to is in the per-engine implementation rules
- `ConfirmAge`, `UpdateConsent`, `UpdatePushConsent` are sent with `NetworkCore.send`. On success, it replaces `ConsentUserState` in memory with `consent` of the response and does consent apply
- consent apply: passes `analytics_allowed` of `ConsentInfo` to `LogCore.set_analytics_allowed`, and emits `ConsentChangedEvent` when the value changed
- `get_consent`: without a session, the failure value. `ad_personalization_allowed` is `true` only when the value in `ConsentUserState` is `true` and the device tracking state is `AUTHORIZED` or `NOT_APPLICABLE`. `age_confirmed` and `tracking` are as in the type table, and the other fields are the values of the fields with the same name in `ConsentUserState`
- When the session ends or on `release`, it deletes `consent` in memory and calls `LogCore.set_analytics_allowed(false)`

### account

- `link_account`: after the sign-in of the social adapter, sends `LinkAccount` with `NetworkCore.send`. `ALREADY_LINKED` is `AlreadyLinked`; a cancelled sign-in is `Cancelled`. On success, it replaces the linked provider list with `linked_providers` of the response and writes the storage item again. A failure of this write only leaves an error log
- `switch_account`: sends `Login` with the social provider. When `Login` succeeds, it does 1 of the login success order and, regardless of the result of 1, emits `SessionEndedEvent(Switch)` and `RestartRequestedEvent`. This is because the UserState delta of the response already belongs to another account. When 1 succeeds, it returns `Success` with the user ID of the response after emitting the two events. When 1 fails, it returns `Failed`, and the storage item stays that of the previous account, so auto login after restart goes to the previous account. A sign-in failure or cancel and a `Login` failure or rejection keep the current session and storage item
- `logout`: sends `Logout` with `send` and, regardless of the result, deletes the storage item, the pending token and the memory session. Then it emits `SessionEndedEvent(Logout)`, `RestartRequestedEvent`
- `withdraw`: sends `Withdraw` with `send`. On success, it deletes the same things as logout, deletes the `LocalDataCore` `device` keys `AuthCore.terms_version`, `AuthCore.privacy_terms_version` with `remove_value`, and then emits `SessionEndedEvent(Withdraw)`, `RestartRequestedEvent`. On failure, it deletes nothing
- `issue_deletion_code`: when there is a session, it sends `IssueDeletionCode` with `NetworkCore.send`. When there is no session and there is a ban session, it sends it with `NetworkCore.send_auth`, with `AuthSendOptions` whose `authorization` is the access token of the ban session, `sign` is `true`, and `signing_key` is the session signing key of the ban session. When there is neither, it fails without a request. On success, it returns `code`, `expires_at`, `url` of the response. The user enters the user ID and `code` on the server `auth` web account deletion page at that `url`
- The failure callbacks of `link_account`, `logout`, `withdraw`, `issue_deletion_code` return `true`. The caller displays the failure
- Passing `GUEST` to `link_account` or `switch_account` gives `Failed` without a request
- `is_provider_supported`: `GUEST` is always `true`. A social provider is `true` when the social adapter of that provider was received by the rules of the social adapter table

### web guest

- persistent storage request: when the platform is `web`, at the start of `boot_login` it asks the browser not to delete the storage of that origin automatically. It does not wait for the result. When it cannot request or the request is refused, it leaves an info log and continues
- link prompt: when the platform is `web` and the linked provider list is empty when `boot_login` returns `Success`, before returning it increments `LocalDataCore` `device` key `AuthCore.web_guest_logins` by 1 and writes it. When the incremented value is a multiple of `AuthCore.webLinkPromptLogins` and `is_provider_supported(GOOGLE)` is `true`, it opens the link prompt popup and waits until it closes. On web, the only social provider with a real adapter is `GOOGLE`
- The link prompt popup is opened with `UICore.open_system_popup`. body `[auth_web_link_body]`, buttons `[auth_web_link_google]`, `[auth_web_link_later]`, back button `[auth_web_link_later]`
  - `[auth_web_link_google]` waits for `link_account(GOOGLE)`. When the result is `AlreadyLinked` or `Failed`, it shows `[auth_web_link_failed]` with `MessageCore.show_toast`
  - `[auth_web_link_later]` closes the popup without a request
- When it cannot open the link prompt popup, it leaves an error log. Regardless of the result of the link prompt, `boot_login` returns `Success`

### social adapter

- The social adapter of the client does the sign-in of the provider and returns a credential

| provider | adapter key | platforms with real adapter |
|---|---|---|
| `APPLE` | `login-apple` | `ios`, `macos` |
| `GOOGLE` | `login-google` | `android`, `ios`, `web`, `windows`, `macos`, `linux` |

- When the value of that key in build info `adapters` is `fake`, the fake adapter is used; when it is the same name as that key, the real adapter is used on the platforms in the table. Otherwise there is no social adapter for that provider
- Server `auth` defines the credential format. `login-apple` contains the identity token and the authorization code that Apple sign-in gave
- `login-google` returns the ID token received by signing in with game settings `loginGoogle.serverClientId` on `android` and `web`, and with `loginGoogle.iosClientId` on `ios`
- On `windows`, `macos`, `linux`, `login-google` returns the authorization code received through installed app OAuth as a credential that the server can exchange. It does not handle a client secret. When any step below fails, or step 3 does not end within `AuthCore.desktopSignInTimeoutMs` from step 1, it closes the listener and fails
  1. Opens an HTTP listener on `127.0.0.1` on a free port that the OS picks. The redirect URI is `http://127.0.0.1:<port>`
  2. Makes the code verifier and `state`, each as unpadded base64url of 32 secure random bytes. Opens with the system browser the URL `https://accounts.google.com/o/oauth2/v2/auth` with query `client_id`(game settings `loginGoogle.desktopClientId`), `redirect_uri`, `response_type` `code`, `scope` `openid`, `code_challenge`(unpadded base64url of the SHA-256 of the code verifier), `code_challenge_method` `S256`, `state`
  3. When the listener first receives a request with `state` or `error` in the query, it sends an HTTP 200 `text/html; charset=utf-8` response whose body is the translation of `[auth_google_desktop_done]` and closes the listener. When `state` differs from the value of step 2, `error` is present, or `code` is missing, it fails
  4. Returns the UTF-8 JSON object `{"authorization_code": <code>, "code_verifier": <code verifier>, "redirect_uri": <redirect URI>}` as the credential. The code and the code verifier are not logged
- `release` deletes the received social adapters and the scope text
- The fake adapter returns `fake:<fake account name>` as the credential without a screen. The fake account name is the value set with `set_fake_social_account`; when it is not set, `AuthCore.fake_account` of the `LocalDataCore` `device` file. When that value is missing, it creates a UUID v4 at first use and saves it

### release

- Deletes the session in memory, `remote_config` and a refresh in progress, and passes none to `NetworkCore.set_session_provider`. It does not delete the storage item and the agreed versions
- The pending token and unfinished storage operations are exceptions that `release` does not delete. When a pending token remains, it starts a storage item write and does not wait for the result. That result is discarded, so the pending token remains even when the write succeeds. Both remain after `init` again

### real adapter

| adapter key | real adapter |
|---|---|
| `login-apple` | `login-apple` |
| `login-google` | `login-google` |

## hook

none

## event

| event | when | payload |
|---|---|---|
| `LoginCompletedEvent` | end of the login success order | user ID |
| `SessionEndedEvent` | when the session ends by `logout`, `withdraw`, `Login` success of `switch_account`, refresh rejection, session replacement, or being below the minimum age | `SessionEndReason`: `Logout`, `Withdraw`, `Switch`, `Rejected`, `Replaced`, `AgeBlocked` |
| `ConsentChangedEvent` | when consent apply changes `ConsentInfo` | `ConsentInfo` |

## error

| condition | failure value | log |
|---|---|---|
| document URL check failure of `prepare_terms`, popup cannot be opened | `Failed` | error |
| `GetTerms` failure of `prepare_terms` | `Failed` | `NetworkCore` leaves it |
| login before `prepare_terms` returns `Agreed` | `Failed`. no request | error |
| `login` while there is a session | `Failed`. no request | error |
| document URL check failure of `open_terms_document`, URL cannot be opened | `false` | error |
| `GetTerms` failure of `open_terms_document` | `false` | `NetworkCore` leaves it |
| `set_storage_scope`, `set_social_adapter` after `init` | ignored | error |
| provider whose `is_provider_supported` is `false` | `Failed`. no request | error |
| `GUEST` passed to `link_account`, `switch_account` | `Failed`. no request | error |
| server error and communication failure of `Login`, `AutoLogin` | `LoginStatus` in the table | `NetworkCore` leaves it |
| storage operation failure | as in behavior | error. Logs only the operation and the result, not the token or the original OS error text |
| login token cannot be obtained from the read storage item | auto login is `Rejected`. no request | error. The read value is not logged |
| element of `linked_providers` of the read storage item that is not a `LoginProvider` element name | discards that element | warn |
| `SessionProvider` query without a session | `RequestFailure` whose `FailureKind` is `ConnectionFailed` | error |
| `RefreshToken` failure of a refresh | `RequestFailure` of that `RefreshToken` | `NetworkCore` leaves it |
| `get_user_id` called without a session | `0` | error |
| `prepare_consent`, `open_privacy_choices`, `get_consent`, `update_push_consent`, `report_ad_consent` without a session. `issue_deletion_code` without a session and without a ban session | failure value | error |
| age popup, privacy popup or push consent popup cannot be opened, `ConfirmAge`, `UpdateConsent`, `UpdatePushConsent` failure | failure value | error. `NetworkCore` leaves request failures |
| `update_push_consent` when `pushConsent.adPush` is `false`, `CONSENT_CHOICE_UNSPECIFIED` value | `false`. no request | error |
| install marker check failure, age block marker read failure other than `NotFound` | `boot_login` is `Failed` | error. Logs only the result of `LocalDataCore` |
| account recovery popup, new-start confirm popup, session replaced popup or link prompt popup cannot be opened | as in behavior | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `AuthCore.tokenRefreshMarginMs` | integer | core | content | the access token is refreshed when the remaining time is this value or less |
| `AuthCore.webLinkPromptLogins` | integer | core | content | interval, in `boot_login` successes, at which the link prompt popup opens for a web guest |
| `AuthCore.storageCallTimeoutMs` | integer | core | content | time limit of a login token storage operation. When it is exceeded, that operation ends with `Failed`, the adapter is told to discard that operation, and the next operation starts. 1 or more |
| `AuthCore.desktopSignInTimeoutMs` | integer | core | content | time limit for which `login-google` sign-in on `windows`, `macos`, `linux` waits for the browser redirect |
| `auth.maxAgeYears` | integer | core | content | maximum age the age popup accepts. The same key as server `auth.ConfirmAge` |
| `termsPopup` | string | game | none | resource key of the terms popup prefab |
| `agePopup` | string | game | none | resource key of the age popup prefab |
| `privacyPopup` | string | game | none | resource key of the privacy popup prefab |
| `consent.ageConfirmation` | boolean | game | none | whether age confirmation is required |
| `consent.privacyChoices` | boolean | game | none | whether the ad personalization and analytics choices are asked |
| `consent.version` | integer | game | none | version of the current privacy choices text |
| `consent.trackingRequest` | boolean | game | none | whether the tracking permission is requested on iOS |
| `pushConsent.adPush` | boolean | game | none | whether ad push is sent. When `true`, ad push consent is asked |
| `pushConsentPopup` | string | game | none | resource key of the push consent popup prefab |
| `loginGoogle.serverClientId` | string | game | none | OAuth client ID that the `login-google` adapter uses on `android`, `web` |
| `loginGoogle.iosClientId` | string | game | none | OAuth client ID that the `login-google` adapter uses on `ios` |
| `loginGoogle.desktopClientId` | string | game | none | Desktop app OAuth client ID that the `login-google` adapter uses on `windows`, `macos`, `linux` |

## data

reserved string: `[auth_terms_title]`, `[auth_terms_agree_terms]`, `[auth_terms_agree_privacy]`, `[auth_terms_view]`, `[auth_terms_confirm]`, `[auth_age_title]`, `[auth_age_year]`, `[auth_age_month]`, `[auth_age_confirm]`, `[auth_age_invalid]`, `[auth_privacy_title]`, `[auth_privacy_ad_personalization]`, `[auth_privacy_analytics]`, `[auth_privacy_confirm]`, `[auth_tracking_usage]`, `[auth_push_title]`, `[auth_push_ad]`, `[auth_push_night]`, `[auth_push_confirm]`, `[auth_push_ad_granted]`, `[auth_push_ad_denied]`, `[auth_push_night_granted]`, `[auth_push_night_denied]`, `[auth_recover_linked]`, `[auth_recover_guest]`, `[auth_recover_login_apple]`, `[auth_recover_login_google]`, `[auth_recover_new]`, `[auth_recover_new_confirm]`, `[auth_recover_new_ok]`, `[auth_recover_back]`, `[auth_session_replaced]`, `[auth_go_to_title]`, `[auth_web_link_body]`, `[auth_web_link_google]`, `[auth_web_link_later]`, `[auth_web_link_failed]`, `[auth_google_desktop_done]`

format argument

| text | arguments |
|---|---|
| `[auth_push_ad_granted]` | `{date}`(`integer`) |
| `[auth_push_ad_denied]` | `{date}`(`integer`) |
| `[auth_push_night_granted]` | `{date}`(`integer`) |
| `[auth_push_night_denied]` | `{date}`(`integer`) |

- The build uses `[auth_tracking_usage]` as the text of the iOS tracking permission request (`NSUserTrackingUsageDescription`). Core does not show it at run time
- The `{date}` value of `[auth_push_ad_granted]`, `[auth_push_ad_denied]`, `[auth_push_night_granted]`, `[auth_push_night_denied]` is the time of the change

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `AuthCore.terms_version` | `int64` | agreed version of `TermsItem` `TERMS`. 0 when there is none |
| `device` | `AuthCore.privacy_terms_version` | `int64` | agreed version of `TermsItem` `PRIVACY`. 0 when there is none |
| `device` | `AuthCore.web_guest_logins` | `int64` | number of times `boot_login` returned `Success` without a linked provider on platform `web`. 0 when there is none |
| `device` | `AuthCore.fake_account` | `string` | default fake account name of the fake adapter. Empty string when there is none |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `dev_login` | dev account name | async operation. `LoginResult` | `LoginResult` with `Failed` | `BootstrapCore`(`Login`), core test |
| `set_fake_social_account` | fake account name | none | none | core test, `QACore` |
| `expire_access_token` | none | none | none | core test, `QACore` |
| `set_fake_tracking_status` | `TrackingStatus` | none. The device tracking state and the answer to the tracking permission request become this value | none | core test |
| `use_dev_token_storage` | none | none. After that, in a run that the per-engine implementation rules define as one that uses DEV token storage, it uses DEV token storage instead of login token storage | none | `BootstrapCore`(`InitModules`), core test |

- `dev_login` sends `DevLogin` with `NetworkCore.send_auth_cheat`. It does not do the terms check and the install marker check. After success, it does 2 to 4 of the login success order. It does not read or write the storage item and the pending token
- `expire_access_token` sets the expiry time in memory to the current server time
- DEV token storage is the storage that keeps the token in a run that contains DEV code and cannot use the login token storage of the engine. The storage location and when it is used are in the per-engine implementation rules

## test

- When the saved version equals the current version, `prepare_terms` is `Agreed` without a popup; when it differs, it opens the popup. When both toggles are on at confirm, it saves the version and is `Agreed`; otherwise it is `Refused`, and the saved values are unchanged
- With a `GetTerms` failure, an `http` URL (STG and PROD builds), an empty host, a URL with user info, or a popup that cannot be opened, it is `Failed` without a popup
- `login` before `prepare_terms` is `Failed` without a request
- `open_terms_document` opens the URL of that item received with `GetTerms`, and the saved agreed version is unchanged. A `GetTerms` failure and a document URL check failure do not open the URL and give `false`
- The login request contains the saved agreed versions
- `boot_login`: without a storage item, it sends `Login` of `GUEST` as new account login without `AutoLogin`. Storage `Denied` and `Failed` give `Failed` without a request
- When `AutoLogin` gets `UNAUTHORIZED`, the account recovery popup opens without deleting the storage item and without `Login`. When `linked_providers` has a usable provider, the popup has the button of that provider and `[auth_recover_new]`; otherwise it has only `[auth_recover_new]`
- When the storage item value is not JSON or has no `login_token`, `boot_login` leaves an error log without `AutoLogin` and opens the account recovery popup. The storage item is unchanged until `[auth_recover_new_ok]`. When there is no `login_token`, `linked_providers` is `["LOGIN_PROVIDER_GOOGLE", 7]` and `is_provider_supported(GOOGLE)` is `true`, the popup has the `[auth_recover_login_google]` button and there is one warn log
- A new start in account recovery deletes the storage item and does new account login only after `[auth_recover_new_ok]` of the new-start confirm popup. `[auth_recover_back]` and cancelling the recovery provider login open the account recovery popup again
- When the account recovery popup and the new-start confirm popup are closed by `UICore.close_all_popups`, the storage item is not deleted and the account recovery popup opens again
- When there is no install marker file, `boot_login` deletes the storage item, writes the install marker, and does new account login without `AutoLogin`. When there is an install marker, it does not delete the storage item. When the install marker read fails with a failure other than `NotFound`, it does not delete the storage item and is `Failed`
- `boot_login`: when the terms popup closes with `Refused`, it opens again. When it gets `ConsentRequired` twice, it returns `ConsentRequired`
- `CONSENT_REQUIRED`, `BANNED` are `ConsentRequired`, `Banned`. The user ID, ban end time and deletion page address of `Banned` are `user_id`, `until_at`, `deletion_url` of the ban detail
- A cancel and a failure of social sign-in are `Cancelled` and `Failed` without a request
- After login, the files in app storage (including `LocalDataCore` files and log files) do not contain the login token and access token strings
- After login, `release` and `init` again, `boot_login` is `Success` with the same user ID through `AutoLogin` without a popup
- The login success order is save, memory, `set_session_provider`, `LoginCompletedEvent`, in that order
- A token save failure in `login` is `Failed`, the previous session and storage item are unchanged, and there is no `RestartRequestedEvent`. A token save failure in `switch_account` is `Failed`, the storage item stays that of the previous account, `SessionEndedEvent(Switch)` and `RestartRequestedEvent` occur once each, and the user ID of auto login after restart is the user ID of the previous account. A save failure of auto login is `Success`; a refresh before the save sends `RefreshToken` with the token that `AutoLogin` sent, the next background entry or foreground return saves the new token, and a refresh after the save uses the new token
- When there is a pending token, after `release` and `init` again, `boot_login` sends `AutoLogin` with the pending token instead of the storage item
- When the remaining time is more than the margin, `get_access_token` does not refresh; when it is the margin or less, it refreshes once. Several queries during a refresh get one refresh request and the same token
- After a frame refresh failure, there is no frame refresh until the next foreground return. One refresh goes on each foreground return
- On `UNAUTHORIZED` of a refresh, the storage item is not deleted, there is no session, and `SessionEndedEvent(Rejected)` and `RestartRequestedEvent` occur once each
- On `SESSION_REPLACED` of a refresh, there is `SessionEndedEvent(Replaced)` and one session replaced popup, `RestartRequestedEvent` occurs once after the button is pressed, and the pending token and storage item are unchanged
- Calling `SessionProvider.notify_session_replaced` twice in a row gives one `SessionEndedEvent(Replaced)` and one session replaced popup
- When a refresh gets `MAINTENANCE`, `get_access_token` fails with a `ServerError` `RequestFailure` of that error code, and the session and storage item are unchanged
- `logout` deletes the storage item regardless of the request result and emits `RestartRequestedEvent` once. A `withdraw` success and a `switch_account` whose `Login` succeeded also emit `RestartRequestedEvent` once. A `withdraw` failure, and a cancel or `Login` failure of `switch_account`, do not change the user ID and storage item, and there is no `RestartRequestedEvent`
- `ALREADY_LINKED` of `link_account` is `AlreadyLinked`, and the linked provider list is unchanged
- After a `withdraw` success, `AuthCore.terms_version` and `AuthCore.privacy_terms_version` are absent, and after restart `prepare_terms` opens the terms popup. A `withdraw` failure and `logout` do not change the two values
- `login` with the same fake account name of the fake adapter, then `release`, `init` and `login` again gives the same user ID. `login` while there is a session is `Failed` without a request, and the user ID and storage item are unchanged
- Without `set_fake_social_account`, the fake adapter credentials of two runs with different app storage roots differ, and in one run the credential is the same after `release`, `init`
- A storage item of another scope text cannot be read
- `release` while waiting for a storage operation ends the caller with a failure, and the late result does not enter the new session
- When there is a pending token, and `init` again and `boot_login` happen before the storage item write that `release` started ends, the storage item write of that `boot_login` starts after the write of `release` ends, and after it ends the storage item is the value that `boot_login` wrote
- `dev_login`, `set_fake_social_account`, `expire_access_token`, `set_fake_tracking_status` and the fake adapter are absent from STG and PROD builds
- When `consent.ageConfirmation` is `true` and `age_confirmed_at` is 0, `boot_login` opens the age popup and sends `ConfirmAge`. When age confirmation was done, it does not open it
- When `below_minimum_age` of `consent` of the `ConfirmAge` response is `true`, `boot_login` is `AgeBlocked`, there is no session, pending token or storage item, and the `auth/age_blocked` file exists. A `boot_login` after that is `AgeBlocked` without a request. A `boot_login` whose `AutoLogin` got `AGE_BELOW_MINIMUM` is also `AgeBlocked` and does not write `auth/age_blocked`
- When `pushConsent.adPush` is `true` and `push_ad_at` is 0, the push consent popup opens with both toggles off, and `UpdatePushConsent` goes. There is one toast per changed item, and `date` is that `_at` of the response. When `pushConsent.adPush` is `false`, the popup does not open
- When `report_ad_consent` has the same value as the current `ad_personalization`, there is no request; when it differs, an `UpdateConsent` that changes only `ad_personalization` goes
- When the `UpdateConsent` of `report_ad_consent` ends with a communication failure or `ServerError`, the result is `false` without a popup or toast
- For each platform of the social adapter table and each value of build info `adapters`, `is_provider_supported` matches the rules of the table
- In a real `login-google` adapter test on platform `windows`, `macos`, `linux`, the URL captured from opening the system browser has `client_id` `loginGoogle.desktopClientId`, `code_challenge_method` `S256`, and `redirect_uri` `http://127.0.0.1:<port>`. Sending a different `state` to that redirect URI fails and closes the listener; with no request, it fails at `AuthCore.desktopSignInTimeoutMs` and closes the listener
- After a `link_account` success, `linked_providers` of the storage item is the list of the response
- `dev_login` does not read or write the storage item
- After `dev_login`, calling `expire_access_token` and then `get_access_token` sends `RefreshToken` with the login token of the `DevLogin` response, which succeeds, and there is no storage item read
- A refresh after a `switch_account` success and before restart sends `RefreshToken` with the login token of the previous session
- A `switch_account` whose `Login` and token save succeed emits `SessionEndedEvent(Switch)` and `RestartRequestedEvent` and then returns `Success` and the user ID of the response, and at that time `get_user_id` is the user ID of the previous account
- A confirm in the age popup with year `199`, month 13, a future year and month, or a year and month whose age is more than `auth.maxAgeYears` leaves the popup open without a request and shows `[auth_age_invalid]`
- When `privacy_version` of `ConsentUserState` differs from `consent.version`, the privacy popup opens with both toggles off, and closing it other than by confirm sends `UpdateConsent` with both `DENIED`. When they are the same, it does not open
- On `ios`, the tracking permission request shows once, only when `consent.trackingRequest`, `ad_personalization_allowed` and `NOT_DETERMINED` all hold, and when the answer differs from `tracking` of `ConsentUserState`, `UpdateConsent` goes
- `ad_personalization_allowed` of `get_consent` is `false` when the device tracking state is `DENIED`, even when the server value is `true`
- `get_consent` called without a session returns a `ConsentInfo` equal to the failure value of the API table in every field, and there is one error log
- On login success and on `UpdateConsent` success, `LogCore.set_analytics_allowed` is called with `analytics_allowed`; on `logout` and `release`, it is called with `false`
- When `consent.ageConfirmation` is `true`, after a login whose `consent` has `age_confirmed_at` 0, `LogCore.set_analytics_allowed` is called with `false`, and after `ConfirmAge` success it is called with `analytics_allowed` of response `consent`
- When `ConfirmAge` or `UpdateConsent` fails, `boot_login` is `Failed`
- When the platform is `web`, there is one persistent storage request per `boot_login`, and when it cannot request, it leaves an info log and `boot_login` continues
- When the platform is `web` and there is no linked provider, `AuthCore.web_guest_logins` increases by 1 on each `Success` of `boot_login`, and the link prompt popup opens only in a `boot_login` where that value is a multiple of `AuthCore.webLinkPromptLogins`. When there is a linked provider or the platform is not `web`, the value is unchanged and there is no popup
- `[auth_web_link_google]` of the link prompt popup sends `LinkAccount` once, and on `ALREADY_LINKED` there is one `[auth_web_link_failed]` toast. `[auth_web_link_later]` and back input close the popup without a request. In every case, `boot_login` is `Success`
- `issue_deletion_code` sends `IssueDeletionCode` once and returns `code`, `expires_at`, `url` of the response. Without a session and a ban session, it fails without a request, and when the request fails, it fails. After `AutoLogin` ends with `BANNED` with a ban detail that has `access_token`, `is_logged_in` is `false`, and `issue_deletion_code` sends `IssueDeletionCode` once with `send_auth`, with the access token of the ban session and a signature made with its session signing key. After login success and after `release`, there is no ban session
- `is_privacy_choices_enabled` and `is_ad_push_enabled` return game settings `consent.privacyChoices` and `pushConsent.adPush` as they are, for each of `true` and `false`
