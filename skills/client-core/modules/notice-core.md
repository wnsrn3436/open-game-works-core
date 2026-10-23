# NoticeCore

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

Receives the notices, banners and maintenance notices of server core `notice` with core `rpc` `GetNotices` and caches them, saves the read state on the device, and reports unread notices through `BadgeCore`. When maintenance is on during the boot before login, it shows the maintenance notice and makes the boot wait until the maintenance ends.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `LocalizationCore`, `NetworkCore`, `UICore`, `BadgeCore`

- server dependency: `notice`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `wait_maintenance_clear` | none | async operation. none | none | `BootstrapCore`(`Login` stage) |
| `fetch` | force flag | async operation. success flag | `false` | core, content code |
| `is_maintenance` | none | last received `maintenance` | `false` | content code |
| `list_active` | `NoticeKind`, caller buffer | number filled | `0` | content code |
| `get_notice` | notice ID | `CoreContract.Notice` | none | content code |
| `is_read` | notice ID | read flag | `false` | content code |
| `mark_read` | notice ID | none | none | content code |
| `load_image` | notice ID | async operation. image object | none | content code |

### type

| type | contents |
|---|---|
| `CoreContract.Notice` | base proto message defined by server core `notice`. `id`, `kind`, `priority`, `start_at`, `end_at`, `title`, `body`, `image_url`, `shortcut_id`, `link_url` |
| `NoticeKind` | base proto enum. `Notice`, `Banner`, `Maintenance` |
| image object | 2D texture of the engine. The format is in the engine implementation rules |
| image downloader | an interface with `download(URL, max bytes)` and `cancel()`. `download` sends an HTTP `GET` that does not follow redirects, waits, and returns the result (`Done`, `ConnectionFailed`, `TooLarge`, `Cancelled`), the HTTP status (0 when there is no response), and the body bytes. When the body is more than the max bytes, it stops receiving and the result is `TooLarge`. `cancel()` ends a `download` in progress with `Cancelled` |

## behavior

### fetch

- `fetch` sends `GetNotices` (language = `LocalizationCore.get_language_code`) with `NetworkCore.send_auth` (empty authorization, no signature). It also sends before login and during maintenance
- When the force flag is `false` and the elapsed time since the last successful fetch is less than `NoticeCore.cacheTtlMs`, it does not send and returns `true`. The elapsed time is the real elapsed time since the last successful fetch plus every `background_ms` of `AppForegroundReturnedEvent` received after it
- When a fetch is in progress, it does not send again and waits for that result together with it
- On success, it replaces the whole cache with `maintenance` and `notices` of the response. When the notice list differs from the previous cache (the `id` set, or any field of the same `id`, differs), it emits `NoticesChangedEvent`
- On failure, it keeps the cache and returns `false`. It does not display anything on screen
- automatic fetch: on receiving `AppForegroundReturnedEvent`, it fetches with force flag `false`

### active notice

- active: `TimeCore.is_synced` is `true`, `TimeCore.is_reached`(`start_at`) is `true`, and `TimeCore.is_reached`(`end_at`) is `false`. Before the first sync there is no active notice
- `list_active` fills the active notices of that kind in response order (the `priority`, `start_at`, `id` order the server set)
- Content code decides how to show notices
- Whether a notice is active is judged when the operation is called. Content code takes down a banner when `end_at` passes while it is showing

### read state and badge

- The read state is in the `device` file of `LocalDataCore`, key `NoticeCore.read_ids`. It is not in the `user` file because it is also used before login
- `mark_read` adds the notice ID. When it is already there, it does nothing
- On fetch success, it deletes from `read_ids` the IDs that are not in the received list
- badge: under the badge of reserved ID `[notice_badge]`, it puts `BadgeCore.set_item`(badge, notice ID, 1) for each active unread notice of kind `Notice`. Other items are deleted with `BadgeCore.clear_item`. `Banner`, `Maintenance` are not put in the badge
- When the badge is matched again: fetch success, `mark_read`, the frame in which `TimeCore.is_reached` becomes `true` for the `start_at` or `end_at` of one of the cached notices

### maintenance notice

- `wait_maintenance_clear` processing order
  1. Fetches with force flag `true`. On failure, it returns. When login fails, the login failure handling of `BootstrapCore` takes over
  2. When `maintenance` is `false`, it returns
  3. Opens the maintenance popup, waits until it closes, then goes to 1. It gets the close through the hidden callback, regardless of whether the button was pressed
- maintenance popup: `UICore.open_system_popup`. One button `[notice_retry]`. Back input does not close it
- The body and extra text of the maintenance popup are set from the first notice of `list_active`(`Maintenance`) when the popup opens. When that notice exists, the body is `[notice_maintenance_until]` formatted with `{end_at}` = the `end_at` of that notice, and the extra text is the `title` and `body` of that notice joined with a line break. When there is none, the body is `[notice_maintenance]` and the extra text is an empty string
- When the maintenance popup cannot be opened, it writes an error log, waits `NoticeCore.maintenanceRetryMs` in real elapsed time, then goes to 1
- After login, when another request ends with `MAINTENANCE` and the app restarts through the title button of the `PopupRestart` popup (`[network_error_maintenance]`) of `NetworkCore`, `wait_maintenance_clear` of the new boot opens the maintenance popup

### image

- `load_image` receives the image with `download`(`image_url` of that notice, `NoticeCore.imageMaxBytes`) of the image downloader and decodes it as PNG or JPEG. It decodes only when the result is `Done` and the HTTP status is 200; otherwise it is a failure
- A URL that is not `https` is not accepted. A build with DEV code also accepts an `http` URL whose host is `127.0.0.1`. This is for tests that use the loopback HTTP server of `UnitTestCore`
- When `download` has not ended in the first frame in which `TimeCore.get_real_time` has increased by `NoticeCore.imageTimeoutMs` or more since `download` started, it calls `cancel()` and fails
- The image downloader is the one received with `set_image_downloader`, and when none was received, the default image downloader made with the engine HTTP client. The engine mapping is in the engine implementation rules
- Received images are kept in memory per notice ID. When the `image_url` of the same notice changes or the notice leaves the cache, the image is discarded

### release

- Stops a fetch in progress and ends it as a failure. For a `load_image` in progress, it calls `cancel()` and ends it as a failure. A `wait_maintenance_clear` in progress returns. Deletes the cache, the images, and the image downloader received with `set_image_downloader`. Does not close an open maintenance popup. `UICore` closes and destroys popups. Does not delete `read_ids`

## hook

none

## event

| event | when | payload |
|---|---|---|
| `NoticesChangedEvent` | after a fetch success changed the notice list | none. The new list is read with `list_active` |

## error

| condition | failure value | log |
|---|---|---|
| `GetNotices` failure | `false`. Cache unchanged | `NetworkCore` writes it |
| `get_notice`, `load_image` of a notice ID not in the cache | each failure value | warn |
| the notice ID of `mark_read` is not in the cache | none. Not saved | warn |
| `image_url` is an empty string or a URL that is not accepted, size exceeded, timeout, another `download` result that is not `Done`, an HTTP status other than 200, decode failure | none | error |
| `[notice_badge]` is not in the `badge` table | no badge items set | error once until `release` |
| the maintenance popup cannot be opened | fetches again after waiting | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `NoticeCore.cacheTtlMs` | integer | core | content | duration in which a fetch with force flag `false` does not send again |
| `NoticeCore.maintenanceRetryMs` | integer | core | content | duration until fetching again when the maintenance popup could not be opened |
| `NoticeCore.imageMaxBytes` | integer | core | content | max bytes of a notice image response |
| `NoticeCore.imageTimeoutMs` | integer | core | content | time limit for receiving a notice image |
| `TimeCore.reachMarginMs` | integer | core | content | ms added to the reach judgement of `TimeCore`. Used for the expected times of tests |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `NoticeCore.read_ids` | `array<int64>` | list of read notice IDs |

reserved ID

| name | used by |
|---|---|
| `[notice_badge]` | → row of `badge`. Unread notice items are placed under this badge |

- The `persist` of the `badge` row that `[notice_badge]` points to is `false`. A violation is data check `out_of_range`

reserved string

| name | used by |
|---|---|
| `[notice_maintenance]` | maintenance popup body when there is no active `Maintenance` notice |
| `[notice_maintenance_until]` | maintenance popup body when there is an active `Maintenance` notice |
| `[notice_retry]` | button of the maintenance popup |

format argument

| text | arguments |
|---|---|
| `[notice_maintenance_until]` | `{end_at}`(`integer`) |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_image_downloader` | image downloader | none | core test |

- `set_image_downloader` is called before `init`

## test

- A fetch with force flag `false` within `cacheTtlMs` is `true` without a request, and a fetch after it passes and a fetch with force flag `true` send `GetNotices`. Two fetches called at the same time make one request
- Even when the real elapsed time after the last successful fetch is less than `cacheTtlMs`, when that plus the background time after it is `cacheTtlMs` or more, the automatic fetch on the return to foreground sends `GetNotices`
- `GetNotices` goes through `send_auth` without an access token, and its language is the current language `code`
- Only a fetch that changed the list emits `NoticesChangedEvent`, once. A failed fetch does not change the cache
- When the server time is `start_at` + `TimeCore.reachMarginMs`, the notice is active, and 1 less, it is not. At `end_at` + `TimeCore.reachMarginMs` it is not active, and 1 less, it is active. `list_active` filters by kind and keeps the response order
- For each active unread `Notice` there is an item under `[notice_badge]`, the item is removed on `mark_read` and in the frame `end_at` is reached, and `Banner` and `Maintenance` have no item
- An ID marked with `mark_read` has `is_read` `true` after `release`, `init`, and when it leaves the received list, it is deleted from `read_ids`
- When `maintenance` is `true`, `wait_maintenance_clear` opens the maintenance popup, and when it receives `false` after the button, it returns. Even when the maintenance popup is closed by `UICore.close_all_popups`, it fetches again. When the fetch fails, it returns without a popup. When there is an active `Maintenance` notice, the body is `[notice_maintenance_until]` formatted with the `end_at` of the first notice, and the extra text is the `title` and `body` of that notice. A popup opened when the server time is that `end_at` + `TimeCore.reachMarginMs` has the `[notice_maintenance]` body and empty extra text
- `load_image` returns none and an error log for `http://example.com/a.png`, a response of the loopback HTTP server larger than `NoticeCore.imageMaxBytes`, and a 404 response. For a PNG response of the loopback HTTP server, it returns an image object
- When `load_image` starts with a test image downloader that never ends and `UnitTestCore.advance_clock` moves the real elapsed time by `NoticeCore.imageTimeoutMs` − 1, it still waits. In the frame after moving 1 more, `cancel()` is called once and `load_image` returns none and an error log
- A fetch and a `load_image` during `release` end as failures, and `wait_maintenance_clear` returns
