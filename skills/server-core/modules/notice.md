# notice

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

Gives the client the in-game notices, banners and maintenance notices that the operator registers with admin operations, by their period and target conditions. A client can get them also before login, and gets them also during maintenance.

## dependency

- `admin-api`
- `validation`
- `storage`
- `server-time`
- `logging`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `GetNotices` (core rpc). changes: none | language | `maintenance`, `notices` | `INVALID_REQUEST`, `RATE_LIMITED` | `routing`. Client `NoticeCore` sends it |

- language: BCP 47 tag
- `maintenance`: result of `admin-api.is_maintenance`
- `notices`: list of base proto message `Notice`. field: `int64 id`, `NoticeKind kind`, `int32 priority`, `int64 start_at`, `int64 end_at`, `string title`, `string body`, `string image_url`, `int32 shortcut_id`, `string link_url`. The text is that of the chosen language

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `GetNoticesRequest` | `language` | `string` | `max_len`: 35 |

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetNoticesResponse` | `maintenance` | `bool` |
| `GetNoticesResponse` | `notices` | `repeated Notice` |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `put_notice` | `operation_id`, `notice_id`, `kind`, `priority`, `start_at`, `end_at`, `platforms`, `languages`, `min_client_version`, `max_client_version`, `texts`, `image_url`, `shortcut_id`, `link_url` | `notice_id` | `bad_request`, `not_found`, `conflict` | operator |
| `delete_notice` | `notice_id` | empty object | `not_found` | operator |
| `list_notices` | none | `notices`: list of notices not deleted. Each element is the `put_notice` input fields without `operation_id`, and `updated_at`. Ascending order of `notice_id` | none | operator |

- `notice_id`: 0 creates a new notice. A value other than 0 replaces that notice as a whole. When it does not exist, `not_found`
- `kind`: `Notice`, `Banner`, `Maintenance`. It is base proto enum `NoticeKind`
- `start_at` < `end_at`
- `platforms`: list of strings for which `validation.is_platform` is `true`. An empty list means every platform
- `languages`: list of tags of game settings `supportedLanguages`. An empty list means every language
- `min_client_version`, `max_client_version`: an app version that `validation.parse_version` reads, or an empty string (no limit). Both bounds are included
- `texts`: list of `(language, title, body)`. Exactly one row per language of game settings `supportedLanguages`. A missing, repeated or unknown language is `bad_request`
- `title` keeps the plain text conditions of `validation` and has at most `notice.maxTitleChars` code points. `body` keeps the same conditions except that U+000A is allowed, and has at most `notice.maxBodyChars` code points
- `image_url`, `link_url`: an empty string, or a URL with scheme `https`, a host and no user info
- When `environments.<ENV>.cdnR2` of the environment the server runs in has `publicBaseUrl`, the origin (scheme, host, port) of an `image_url` that is not an empty string is the origin of that `publicBaseUrl`. On violation, `bad_request`. The web build is served from that origin, so the web client gets the image without CORS
- `shortcut_id`: 0 or an ID value of the `shortcut` table
- field type: `notice_id` is `int64`, `kind` is `enum{Notice, Banner, Maintenance}`, `priority` and `shortcut_id` are `int32`, `platforms` and `languages` are `array<string>`, `min_client_version`, `max_client_version`, `image_url` and `link_url` are `string`, `texts` is `array<object{language: string, title: string, body: string}>`

## behavior

### processing

- `GetNotices` is a `NoUserRpc` and goes through the handling that `routing` sets for `NoUserRpc`. The handler judges the target conditions with the `X-Ogw-Platform` and `X-Ogw-Client-Version` values that `routing` passes
- Time judgement uses `server-time.clock_now`. A notice is visible when `start_at` ≤ `clock_now` < `end_at`
- Returns only the notices that meet every target condition
  - `platforms` is empty or contains `X-Ogw-Platform`
  - `languages` is empty or contains the chosen language
  - the app version is `min_client_version` or more and `max_client_version` or less. `validation.compare_versions` compares. When `X-Ogw-Client-Version` is an empty string (dev run), the version condition passes
- choosing the language: the requested tag when it is in `supportedLanguages`, otherwise game settings `sourceLanguage`. The comparison ignores ASCII letter case. When the notice's `texts` has no text of the chosen language, uses the `sourceLanguage` text
- Order: `priority` descending, `start_at` descending, `id` ascending. Returns up to `notice.maxNotices` notices

### maintenance

- `admin-api.set_maintenance` turns maintenance on and off. This module does not change the maintenance state
- A notice of `kind` `Maintenance` is the maintenance notice text. A scheduled maintenance is announced in advance with a `start_at` before the maintenance, and `end_at` holds the expected end time

### storage and cache

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `notice_notice` | `game` | `notice_id`, `kind`, `priority`, `start_at`, `end_at`, `platforms`, `languages`, `min_client_version`, `max_client_version`, `texts`, `image_url`, `shortcut_id`, `link_url`, `updated_at` | `notice_id` | `end_at` |
| `notice_sequence` | `game` | `id` (one row with value 0), `last_notice_id` | `id` | none |

- `notice_id` is an integer that increases from 1, and the ID of a deleted notice is also not given again. The last given ID is kept in the `notice_sequence` row whose `id` is 0. A `put_notice` that creates a new notice locks key 0 of `notice_sequence` with `storage.lock_game_row` in its game tx and reads that row. When there is no row, creates it as a row with `last_notice_id` 0. Gives `last_notice_id` + 1 as the new `notice_id` and updates the row with that value. The check of the remaining notice count also runs after this lock. Rows of deleted notices and of notices past their `end_at` are deleted
- A notice whose `end_at` the `clock_now` has reached counts as deleted even while its row remains. So it is not in `list_notices` or in the count of `notice.maxStoredNotices`, and `put_notice` and `delete_notice` of that `notice_id` are `not_found`
- A server instance caches the notice list in memory. Job `notice_cache` (interval `notice.cacheMs`), which notice sets with `server-time.schedule_job` at server start, reads it again. The server instance that made a change updates its own cache at once
- When the remaining notice count is `notice.maxStoredNotices`, `put_notice` of a new notice is `bad_request`

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| admin input rule violation | `bad_request` | none | `audit` |
| `notice_id` that does not exist | `not_found` | none | `audit` |
| `put_notice` with a different input for the same `operation_id` | `conflict` | none | `audit` |
| IP rate limit of `GetNotices` exceeded | `RATE_LIMITED` | `RATE_LIMITED` | `security` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `supportedLanguages` | array<string> | game | none | all languages that notice text must have |
| `sourceLanguage` | string | game | none | language chosen when the requested language is missing |
| `environments.<ENV>.cdnR2` | object | game | none | when it has `publicBaseUrl`, that origin is the origin that `image_url` can use |
| `notice.maxNotices` | integer | core | content | limit on the notice count that `GetNotices` returns |
| `notice.maxStoredNotices` | integer | core | content | limit on the saved notice count |
| `notice.maxTitleChars` | integer | core | content | limit on the code point count of a notice title |
| `notice.maxBodyChars` | integer | core | content | limit on the code point count of a notice body |
| `notice.cacheMs` | integer | core | content | interval at which the notice cache is read again. 1 or more |

## data

used table: `shortcut`

- the `shortcut` table that `shortcut_id` points to. `ShortcutCore` sets its header

## DEV

none

## test

- Only notices within their period come; a notice is visible at the time equal to `start_at` and not visible at the time equal to `end_at`
- For each of the platform, language and app version conditions, only a matching client gets that notice. A dev run client passes the version condition
- A request for a language that is not supported gets the `sourceLanguage` text
- The order keeps the `priority`, `start_at`, `id` rule
- `GetNotices` without an access token is handled, and also during maintenance it returns `maintenance` `true` and the `Maintenance` notice
- When `texts` misses or repeats a language, `put_notice` is `bad_request`
- On a server where `environments.<ENV>.cdnR2` has `publicBaseUrl`, `put_notice` with an `image_url` whose origin differs from that origin is `bad_request`, and with the same origin it succeeds. A server without `cdnR2` accepts an `https` `image_url`
- Within `notice.cacheMs` after `put_notice`, every server instance returns the new notice, and within the same duration after `delete_notice`, the deleted notice is gone
- Two `put_notice` calls with the same `operation_id` create only one notice. `put_notice` with a different input for the same `operation_id` is `conflict`
- A notice created after deleting the notice with the largest `notice_id` does not get the deleted ID
- When two concurrent `put_notice` calls with different `operation_id` values create new notices, they get different `notice_id` values. The first `put_notice` on a DB without a `notice_sequence` row gets `notice_id` 1
- After a language is added to `supportedLanguages`, a request for that language gets the `sourceLanguage` text of an existing notice that has no text in that language
