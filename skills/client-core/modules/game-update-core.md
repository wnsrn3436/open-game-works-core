# GameUpdateCore

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

Checks the app version with the signed deploy list that the server `game-update` module gives, and downloads the data, translation and resource bundle files that fit this app version and the built-in data. When the server requires an app update or a data update during the run, it opens an update popup.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `ResourceCore`, `DataCore`, `LocalizationCore`, `UICore`, `NetworkCore`

- server dependency: `game-update`
- `NetworkCore` is used only for the `UpdateRequiredEvent` subscription. The deploy list and files are downloaded with `UpdateDownloader`
- `ResourceCore` and `LocalizationCore` are used only for the `DownloadedBundle` and `DownloadedTranslation` types

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `check_update` | `UpdateSource` | async operation. success flag | `false` | `BootstrapCore`(`Update`) |
| `bytes_total` | none | total bytes to download | 0 | content code |
| `bytes_done` | none | total bytes downloaded | 0 | content code |
| `downloaded_data` | none | `DownloadedData` of `DataCore` | none | `BootstrapCore`(`ApplyUpdate`) |
| `downloaded_translations` | none | list of `DownloadedTranslation` of `LocalizationCore` | empty list | `BootstrapCore`(`ApplyUpdate`) |
| `downloaded_bundles` | none | list of `DownloadedBundle` of `ResourceCore` | empty list | `BootstrapCore`(`ApplyUpdate`) |
| `set_in_play` | whether a round is in progress (`bool`) | none | none | content code |

- `check_update` is accepted only once per `init`. A second call gives an error log and `false`
- `UpdateSource`: `app_version`, `environment`, `platform`, `game_update_url`, `update_trust_keys` (list of key IDs and Ed25519 public keys). `BootstrapCore` fills it from the build info fields of the same names
- `UpdateDownloader`: the interface that downloads the deploy list and files. `download(URL, max bytes)` sends a `GET` with no added request header (headers that the browser adds by itself are not counted). This is so that no CORS preflight happens on the web. `download` waits and returns a `DownloadStatus` (`Done`, `ConnectionFailed`, `TooLarge`, `Cancelled`), the HTTP status (0 when there is no response) and the body bytes. It does not follow an HTTP redirect and returns the HTTP status of the redirect response. The same holds in a browser runtime, and when the browser hides the HTTP status of the redirect response (`opaqueredirect`), the HTTP status is 0. When the body goes over max bytes, it stops the download and the status is `TooLarge`. `received_bytes()` is the number of bytes that the `download` in progress has received so far. `cancel()` ends the `download` in progress with `Cancelled`

## behavior

### deploy list

- The deploy list URL is `game_update_url`. The signature file URL is the deploy list URL + `.sig`
- The structure of the deploy list, the signature format and the file URL follow the server `game-update` module. Fields that GameUpdateCore uses: `format`, `environment`, `sequence`, `file_base_url`, `app`, `patches`
- The deploy list is external input. Only a deploy list whose size is at most `GameUpdateCore.deployListMaxBytes` and that passes signature verification and the format check is used
- The signature file is at most `GameUpdateCore.signatureMaxBytes`. It passes only when `key_id` is in `update_trust_keys` and the signature over all deploy list bytes verifies with that Ed25519 public key. There is no settings, environment branch or DEV branch that skips signature verification
- When the `sequence` of the signature file differs from the `sequence` of the deploy list, it downloads the deploy list and the signature file again, once. When they still differ, it is a signature verification failure
- format check: `format` is 1, `environment` equals `environment` of `UpdateSource`, `sequence` is at least `GameUpdateCore.sequence_<env>` of the `LocalDataCore` `device` file. `<env>` is `environment` of `UpdateSource` in lowercase. Only the items this app uses (the platform entry of `app`, the app version entry of `patches`) are checked for the following: field structure and type, version is `<major>.<minor>.<patch>`, `data_version` is in the format of `data` skill `## data version`, `name` is `[a-z0-9_.-]+`, does not start with `.`, does not end with `.tmp` or `.bak`, and is unique across `data_files`, `translation_files` and `bundle_files` of the patch entry, `language` of `translation_files` is unique, `size` is at least 1 and at most `GameUpdateCore.fileMaxBytes`, `sha256` is 64 lowercase hex characters
- When the check passes, it saves `sequence` to `GameUpdateCore.sequence_<env>`
- A file URL is `file_base_url` + `sha256`. When `file_base_url` is a relative URL, it is resolved against the deploy list URL

### check_update

1. When `app_version` or `game_update_url` is an empty string, it leaves an info log, downloads nothing, and the result is `true`
2. Downloads the deploy list and the signature file and validates them
3. app version check
4. file update
5. `true`

The app version check compares with the platform entry of `app`. Versions compare the three numbers from the front.

| app version | handling |
|---|---|
| no platform entry | warn log. Goes to file update |
| less than `min_version` | forced update popup. `check_update` does not finish |
| at least `min_version` and less than `recommended_version` | optional update popup |
| at least `recommended_version` | goes to file update |

- store redirect: opens `store_url` with the default app of the device. When the platform is `web`, it moves the current page to `store_url`. The `store_url` of web is the entry page that web hosting of the `build` skill defines, so it opens the version in service now. When it cannot open it, it leaves an error log

### file update

- patch entry: the item of `patches` whose key is `app_version`. When there is none, it leaves an info log, treats it as having no file to download, and does the download folder cleanup below
- When `data_version` of the patch entry equals `DataCore.get_builtin_data_version`, it does not download `data_files` and `translation_files`. When the protocol hash (before the first `-`) differs, it leaves an error log and does not download them
- The files to download are in the order `data_files`, `translation_files`, `bundle_files`, and in list order within a list. It downloads them one at a time
- download folder: `game_update/` under the app storage root of `LocalDataCore`. Only GameUpdateCore writes to it, and only during `check_update`. File operations go through `LocalDataCore`. The path of a downloaded file is `game_update/<name>`
- resume: when a downloaded file with the same `name` exists, it compares the size with `LocalDataCore.get_file_size`, and only when the sizes are equal compares the SHA-256 with `LocalDataCore.hash_file`. When both are equal, it does not download the file. The hash is calculated again per `check_update`
- file download: downloads at most `size` bytes, and when the size and `UtilCore.sha256_hex` are equal, writes the file to `game_update/<name>` with `LocalDataCore.write_file`. When they differ, it does not write
- The query operations give results only after all files to download are saved. They do not give a partly downloaded state
- When it finishes, it deletes the files in the download folder that are not files to download, with `LocalDataCore.list_files` and `delete_file`. For a file it cannot delete, it leaves an error log and continues. When there is no patch entry, it deletes all files in the download folder, `downloaded_data` is none, and `downloaded_translations` and `downloaded_bundles` are empty lists. So that app runs on the built-in data and resources
- It does not download new files during the run. The `check_update` after a restart downloads a new patch
- GameUpdateCore does not apply downloaded files to other modules. `BootstrapCore` applies them with the update reboot

### fetch failure

| failure | reserved string |
|---|---|
| connection failure, stall timeout, HTTP status other than 200, redirect | `[game_update_download_failed]` |
| signature verification failure, format check failure, max bytes exceeded, size or SHA-256 differs | `[game_update_invalid_file]` |
| not enough storage space | `[game_update_no_space]` |
| other save failure | `[game_update_save_failed]` |

- stall timeout: the received bytes do not grow for `GameUpdateCore.stallTimeoutMs` after the download starts or after the received bytes last grew. It cancels that download and discards a result that arrives after that
- For each failure, it writes the reserved string name, the URL and the HTTP status (0 when there is no response) to the error log
- On a failure, it opens the fetch failure popup. `[game_update_retry]` retries from the failed download. Saved files are not downloaded again. There is no limit on the number of retries

### update error

- Subscribes to `NetworkCore.UpdateRequiredEvent`. When the error code is `APP_UPDATE_REQUIRED`, it opens the forced update popup, and when it is `DATA_UPDATE_REQUIRED`, the new data popup
- in play: after content code calls `set_in_play`(`true`) and before it calls `set_in_play`(`false`). A `DATA_UPDATE_REQUIRED` received in play does not open the new data popup and is remembered, and at `set_in_play`(`false`), when one is remembered, it opens the new data popup. `APP_UPDATE_REQUIRED` opens the popup right away even in play. This is so that the result request of the round reaches the server before the restart
- While a forced update popup or a new data popup that GameUpdateCore opened is open, it opens no more popups

### update popup

All are `UICore` system popups and do not close with back input.

| popup | body | button | button action | closed without button |
|---|---|---|---|---|
| forced update | `[game_update_app_update_required]` | `[game_update_go_to_store]` | opens again after store redirect | opens again |
| optional update | `[game_update_recommended]` | `[game_update_go_to_store]`, `[game_update_later]` | opens again after store redirect / goes to file update | same as `[game_update_later]` |
| fetch failure | reserved string of the failure | `[game_update_retry]` | retries | `RestartRequestedEvent`. `check_update` is `false` |
| new data | `[game_update_data_update_required]` | `[game_update_restart]` | `RestartRequestedEvent` | `RestartRequestedEvent` |

- When it cannot open a popup, it leaves an error log. For the forced update or fetch failure popup, it ends `check_update` with `false`. For the optional update popup, it treats it as `[game_update_later]`
- A button choice and a close are handled only once per popup

### progress rate

- `bytes_total`: the sum of `size` of the files to download, excluding files skipped by resume. It is 0 before the resume check
- `bytes_done`: the sum of `size` of the files saved in this `check_update` + the received bytes of the file being downloaded. A file downloaded again counts from 0
- GameUpdateCore does not show the progress rate on screen. Content code of the title scene shows it

### query

- `downloaded_data` is none when there is no downloaded data. The files of `DownloadedData` are the paths and SHA-256 of `data_files`, and its data version is `data_version` of the patch entry
- `downloaded_translations` is, per `translation_files` item, the language, path, SHA-256 and `data_version` of the patch entry
- `downloaded_bundles` is, per `bundle_files` item, `bundle`, path and SHA-256
- A query before `check_update` finishes with `true` gives an error log and the failure value
- The same call returns the same result. The list order is the list order of the deploy list

### lifecycle

- `release` cancels the download in progress and deletes the downloaded deploy list, the query results, the progress rate, the `check_update` call record, the `UpdateDownloader` it was given, the event subscriptions, the in play state and the remembered `DATA_UPDATE_REQUIRED`. A waiting `check_update` ends with `false`. Downloaded files are not deleted

## hook

none

## event

none. Publishes `EventCore.RestartRequestedEvent`

## error

| condition | failure value | log |
|---|---|---|
| second `check_update` | `false` | error |
| failure in the fetch failure table | popup. Waits for a retry | error |
| cannot open the forced update or fetch failure popup | `check_update` is `false` | error |
| no platform entry, no patch entry | none. Continues | warn, info |
| the protocol hash of the patch differs from the built-in data | does not download data and translations | error |
| download folder cleanup fails | none | error |
| query before `check_update` succeeds | none, empty list | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `GameUpdateCore.stallTimeoutMs` | integer | core | content | duration without growth of the received bytes after which a download counts as failed |
| `GameUpdateCore.deployListMaxBytes` | integer | core | content | maximum bytes of the deploy list |
| `GameUpdateCore.signatureMaxBytes` | integer | core | content | maximum bytes of the signature file |
| `GameUpdateCore.fileMaxBytes` | integer | core | content | maximum `size` of one file that the deploy list can list |

settings constraint

| left | factor | right |
|---|---|---|
| `game-update.maxDeployListBytes` | 1 | `GameUpdateCore.deployListMaxBytes` |
| `game-update.maxFileBytes` | 1 | `GameUpdateCore.fileMaxBytes` |
| `GameUpdateCore.fileMaxBytes` | 1 | `DataCore.downloadedFileMaxBytes` |
| `GameUpdateCore.fileMaxBytes` | 1 | `LocalizationCore.downloadedFileMaxBytes` |

## data

reserved string

| name | used by |
|---|---|
| `[game_update_app_update_required]` | forced update popup body |
| `[game_update_recommended]` | optional update popup body |
| `[game_update_data_update_required]` | new data popup body |
| `[game_update_download_failed]`, `[game_update_invalid_file]`, `[game_update_no_space]`, `[game_update_save_failed]` | fetch failure popup body |
| `[game_update_go_to_store]`, `[game_update_later]`, `[game_update_retry]`, `[game_update_restart]` | button |

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `GameUpdateCore.sequence_<env>` | `int64` | largest `sequence` of the deploy lists downloaded and used in the `<env>` environment. `<env>` is `local`, `dev`, `stg`, `prod`. 0 when there is none |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_downloader` | `UpdateDownloader` | none | core test |

- `set_downloader` is called before `init`. When it is not called, an `UpdateDownloader` made with the engine HTTP client is used

## test

Every test uses a fake `UpdateDownloader` or the loopback HTTP server of `UnitTestCore`, and a deploy list signed with a test trust key.

- When the app version is less than `min_version`, the forced update popup opens and `check_update` does not finish. It opens again after the button and after a close without a button
- When it is at least `min_version` and less than `recommended_version`, the optional update popup opens, and after `[game_update_later]` and after a close, file update continues
- When `app_version` or `game_update_url` is an empty string, `UpdateDownloader` is not called and the result is `true`
- When there is no signature, the `key_id` is outside the trust keys, the signature is wrong, or one byte of the deploy list changes, it is a `[game_update_invalid_file]` failure
- When the `sequence` of the signature file differs from the deploy list, it downloads both again once, and when they still differ, it is a `[game_update_invalid_file]` failure
- For each format check item, a deploy list that violates only that item is a `[game_update_invalid_file]` failure. This includes a `sequence` smaller than the saved `sequence` and a different `environment`
- Even when `GameUpdateCore.sequence_dev` has a large value, a deploy list whose `environment` is `STG` is compared only with `GameUpdateCore.sequence_stg` and passes, and its `sequence` is saved to `GameUpdateCore.sequence_stg`
- A deploy list whose patch entry has the same `name` in `data_files` and `bundle_files`, or whose `name` starts with `.` or ends with `.tmp` or `.bak`, is a `[game_update_invalid_file]` failure, and nothing is written to `game_update/`
- When `data_version` of the patch entry equals the built-in one or the protocol hash differs, data and translations are not downloaded and `downloaded_data` is none. When there is no patch entry, no file is downloaded, all files of the download folder downloaded before are deleted, `downloaded_data` is none, and `downloaded_translations` and `downloaded_bundles` are empty lists
- The order of downloading the files to download is the list order of `data_files`, `translation_files`, `bundle_files`
- A downloaded file with the same size and SHA-256 is not downloaded again, and when the size differs, it is downloaded again without calculating the hash
- On a response with a wrong size or SHA-256, `game_update/<name>` does not change
- When it fails at a middle file, the query is in the previous state, and after `[game_update_retry]` it downloads from the failed file
- On the test clock, it is not a failure even when the received bytes do not grow until `GameUpdateCore.stallTimeoutMs` − 1, and it is a failure at the stall timeout. A result that arrives after that is discarded
- A redirect response is not followed and is a `[game_update_download_failed]` failure. The loopback server gets no second request. The same holds in a browser run
- After it finishes, the download folder has only the files to download
- `bytes_total` and `bytes_done` are calculated without the files skipped by resume, and they are equal when it finishes
- When the fetch failure popup closes without a button, `RestartRequestedEvent` is published once and `check_update` is `false`
- `APP_UPDATE_REQUIRED` of `UpdateRequiredEvent` opens the forced update popup and `DATA_UPDATE_REQUIRED` opens the new data popup, and a second event while it is open does not change the number of popups
- The button of the new data popup publishes `RestartRequestedEvent` once
- After `set_in_play`(`true`), two `UpdateRequiredEvent` events with `DATA_UPDATE_REQUIRED` open no popup, and `set_in_play`(`false`) opens one new data popup. `APP_UPDATE_REQUIRED` in play opens the forced update popup right away. `set_in_play`(`false`) after an in play period that received no `DATA_UPDATE_REQUIRED` opens no popup
- A second `check_update` gives an error log and `false`
- When `release` runs during a download, the waiting `check_update` is `false` and the downloaded files remain
