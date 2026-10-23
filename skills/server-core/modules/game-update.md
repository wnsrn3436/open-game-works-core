# game-update

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

Keeps one signed deploy list per environment and serves the data, translation and bundle files the client receives without an app update. When there is a CDN adapter, uploads the files to the CDN and has the client receive them from the CDN.

## dependency

- `validation`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `GET /update/deploy_list.json` (route) | none | current deploy list bytes | HTTP 404 | `routing`. client `GameUpdateCore` sends it |
| `GET /update/deploy_list.json.sig` (route) | none | signature JSON of the current deploy list | HTTP 404 | `routing`. client `GameUpdateCore` sends it |
| `GET /update/files/<sha256>` (route) | none | file bytes | HTTP 404 | `routing`. client `GameUpdateCore` sends it |
| `is_data_update_ready` | app version | `true` or `false` | `false` | `routing`, `matchmaker` |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `put_update_file` | binary body, query `sha256` | `sha256`, `size` | `bad_request` | operator |
| `publish_deploy_list` | `app`, `patches` | `sequence`(decimal string) | `bad_request`, `conflict`, `external_failed` | operator |
| `get_deploy_list` | none | `deploy_list`(current deploy list JSON object), `signature`(signature JSON object) | `not_found` | operator |
| `get_update_signing_key` | none | `key_id`, `public_key` | none | operator |
| `prune_update_files` | none | `deleted`(number of deleted files) | none | operator |

- `routing` collects the routes. They skip the request processing order and authentication. `routing` adds CORS headers by the CORS rules of `routing`
- `put_update_file` is a binary body operation, and its body limit is `game-update.maxFileBytes`
- field types of admin operations: query `sha256` of `put_update_file` is `string`. `app` and `patches` of `publish_deploy_list` are `json`, and the prepare function checks them with the operator fields of the deploy list table and the rules under it

## behavior

### deploy list

A deploy list is one UTF-8 JSON object without BOM.

| field | filled by | meaning |
|---|---|---|
| `format` | server | deploy list format version. Currently 1 |
| `environment` | server | `LOCAL`, `DEV`, `STG`, `PROD` |
| `sequence` | server | the larger of the previous deploy list's `sequence` + 1 and `published_at`. `published_at` when there is no saved deploy list |
| `published_at` | server | time of the publish |
| `file_base_url` | server | leading part of the file URL |
| `app` | operator | `{min_version, recommended_version, store_url}` per platform |
| `patches` | operator | `{data_version, data_files, translation_files, bundle_files}` per app version |

- platform key: a string for which `validation.is_platform` is `true`
- `data_files`: `{name, size, sha256}` per client table binary of that `data_version`. `name` is the table binary file name that the data tool made. `translation_files`: list of `{language, name, size, sha256}`. `bundle_files`: list of `{bundle, name, size, sha256}`
- `name` is `[a-z0-9_.-]+`, does not start with `.`, does not end with `.tmp` or `.bak`, and is unique across all of `data_files`, `translation_files` and `bundle_files` of one patch entry. `language` of `translation_files` is unique within the list. `size` is 1 or more
- The bundles of an app version key are only bundles that match the code of that app version. The bundle patch check of `build` decides whether they match
- `sha256` is the lowercase hex of the SHA-256 of the file bytes. The file URL is `file_base_url` + `sha256`
- `file_base_url` is the base URL of the `cdn` adapter when there is one, otherwise relative URL `files/`. A relative URL is resolved against the deploy list URL. So without a `cdn` adapter, the file URL is `/update/files/<sha256>`

### signature

- signature JSON: `{"key_id": <key ID>, "sequence": <sequence of the deploy list>, "signature": <signature>}`. The signature is the 64-byte Ed25519 signature over the deploy list bytes as they are, written in standard base64
- The key ID is the first 16 characters of the lowercase hex of the SHA-256 of the 32-byte public key
- The `public_key` of `get_update_signing_key` is the 32-byte Ed25519 public key of the signing key written in standard base64, in the same format as the items of `updatePublicKeys`. `key_id` is the key ID of that public key
- The signing key is secret game settings `environments.<ENV>.secrets.updateSigningKey`. The value is the standard base64 of the 32-byte Ed25519 private key seed. When it cannot be read, the server does not start
- The public keys the client trusts are game settings `environments.<ENV>.updatePublicKeys`. In DEV, STG and PROD, when the public key of the signing key is not in that list, the server does not start. Only the server signs, and the private key is not taken out of the server

### file upload

- `put_update_file` saves to `game_update_file` when the body SHA-256 equals query `sha256`. When they differ, the body is empty, or the body is over the limit, `bad_request`
- When a file with the same `sha256` already exists, success without saving
- A saved file is not changed. The same URL is always the same bytes

### publish_deploy_list

Checks in the order below. On a failure, the current deploy list stays as it is. Steps 1 to 5 are done outside the transaction by the prepare function of `publish_deploy_list` (admin operation rules of `admin-api`), and the files of step 2 are read with `storage.read_db`. Step 6 is done by the handler function.

1. `bad_request` when the input is not an object with only the two fields `app` and `patches`, or breaks the format of the table. Versions and the keys of `patches` are app versions that `validation.parse_version` reads, and `min_version` ≤ `recommended_version` by `validation.compare_versions`. `store_url` is a URL with scheme `https`
2. `conflict` when the file of a referenced `sha256` does not exist or `size` differs from the saved file
3. `conflict` when the `data_version` of a `patches` entry differs from both `client_data_version` and `compat_client_data_version` that the server read at start. The server answers apps outside the two protocol hashes with `APP_UPDATE_REQUIRED`, so no patch is kept for them
4. `conflict` when the serialized deploy list is more than `game-update.maxDeployListBytes`
5. When there is a `cdn` adapter, uploads the referenced files not uploaded yet. When one file does not finish within `game-update.cdnTimeoutMs` or fails, `external_failed`
6. In the game tx that `admin-api` opened, the handler function first locks the `sequence` 0 key of `game_update_deploy_list` with `storage.lock_game_row`. This lock handles publishes and `prune_update_files` one after another. Then it runs step 2 again. `sequence` is the key of `game_update_deploy_list`, and no row with `sequence` 0 is kept. It fills the server fields, serializes in key byte order without whitespace, signs, and saves the deploy list and the signature in the game tx that `admin-api` opened

- `publish_deploy_list` is called after the server deploy. Because of the step 3 check, it cannot be published before the server. `## deploy` of the `build` skill decides the deploy order
- A rollback is also a publish, and `sequence` goes up. `## deploy` of the `build` skill decides the input for a rollback
- Only the latest `game-update.keepDeployLists` saved deploy lists are kept, and the rest are deleted
- In the game tx that `admin-api` opened, `prune_update_files` first locks the `sequence` 0 key of `game_update_deploy_list` with `storage.lock_game_row`, then deletes from `game_update_file` the files that are in no remaining deploy list. Files of the `cdn` adapter and records of `game_update_cdn_upload` are not deleted

### serving

- `GET /update/deploy_list.json` and `GET /update/deploy_list.json.sig` have `Cache-Control: public, max-age=<quotient of game-update.deployListMaxAgeMs divided by 1000>` and `Content-Type: application/json`. Both are of the same `sequence`
- `GET /update/files/<sha256>` has `Cache-Control: public, max-age=<quotient of game-update.fileMaxAgeMs divided by 1000>, immutable` and `Content-Type: application/octet-stream`
- When `<sha256>` is not 64 lowercase hex characters or the file does not exist, HTTP 404 without a body
- A server instance caches the current deploy list in memory. Job `game_update_cache`(period `game-update.cacheRefreshMs`), which game-update registers at server start with `server-time.schedule_job`, reads it again. The server instance that published replaces it right after commit with a `storage.after_commit` function registered in the game tx of that publish

### data update decision

- `is_data_update_ready` is `true` only when all the conditions below hold. When there is no current deploy list, it is `false`
  - The `patches` of the current deploy list has an entry for that app version
  - The `data_version` of that entry equals `client_data_version` or `compat_client_data_version` that the server read at start
  - `server-time.clock_now` is at least `published_at` of the current deploy list + `game-update.deployListMaxAgeMs` + `game-update.cacheRefreshMs`

### CDN adapter

- It is `adapters.cdn` per environment in game settings. When `null`, the server serves the files. `fake` works with that base URL and the set `put` result only when the `testing.fake` controller has set a base URL; when none is set, it is the same as no adapter
- Adapter names are `fake` and `cdn-r2`. interface: `base_url()` → absolute URL, `put(sha256, bytes)` → success flag
- The operation names of the fake adapter controller are `base_url` and `put`. `set_result` sets an absolute URL for `base_url` and a success flag for `put`, and `put` before one is set is `true`. The `put` `input` of `calls()` is `{sha256, bytes}`
- `cdn-r2` is Cloudflare R2. `put` sends S3-compatible API `PUT https://<accountId>.r2.cloudflarestorage.com/<bucket>/<sha256>` with AWS Signature Version 4 (region `auto`, service `s3`). `accountId`, `bucket` and the access key ID are `accountId`, `bucket` and `accessKeyId` of game settings `environments.<ENV>.cdnR2`, and the secret access key is secret `environments.<ENV>.secrets.cdn`. Headers `Content-Type` and `Cache-Control` equal those of the `GET /update/files/<sha256>` response. `base_url()` is `environments.<ENV>.cdnR2.publicBaseUrl` followed by `/`
- PROD must have a `cdn` adapter. When it does not, the adapter check of `build` blocks it
- An uploaded file is recorded in `game_update_cdn_upload` per `sha256` and is not uploaded again. The record is committed with one `storage.run_game_transaction` right after one file is uploaded. So even when step 5 ends with `external_failed`, the records of files uploaded earlier stay

### table

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `game_update_file` | `game` | `sha256`, `size`, `content`, `created_at` | `sha256` | none |
| `game_update_deploy_list` | `game` | `sequence`, `deploy_list`, `signature`, `published_at` | `sequence` | none |
| `game_update_cdn_upload` | `game` | `sha256`, `uploaded_at` | `sha256` | none |

- The three tables are registered with `storage.register_table` without a snapshot flag
- `content` of `game_update_file` is the file bytes. `deploy_list` of `game_update_deploy_list` is the signed deploy list bytes, and `signature` is the signature JSON. The current deploy list is the row with the largest `sequence`

### real adapter

| adapter key | real adapter |
|---|---|
| `cdn` | `cdn-r2` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `none` | the client receives update files from the CDN and sends no user data | `cdn-r2` | `none` | `none` | `none` | `none` | `none` | `none` | `none` |

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| deploy list format violation, file hash mismatch | `bad_request` | `audit` |
| file that does not exist, size mismatch, `data_version` that differs from both `client_data_version` and `compat_client_data_version`, size over the limit | `conflict` | `audit` |
| CDN upload failure, time limit exceeded | 502 `external_failed` | `audit`, `error` |
| `GET` of a deploy list or file that does not exist | HTTP 404 | none |
| the signing key secret cannot be read, the public key of the signing key is not in `updatePublicKeys` | server start failure | `error` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `environments.<ENV>.secrets.updateSigningKey` | string | game | none | name of the secret in the host secret store that holds the deploy list signing key |
| `environments.<ENV>.updatePublicKeys` | array<string> | game | none | list of Ed25519 public keys the client trusts for deploy list signature verification. Each item is the standard base64 of a 32-byte public key |
| `game-update.maxFileBytes` | integer | core | content | maximum bytes of the `put_update_file` body |
| `game-update.maxDeployListBytes` | integer | core | content | maximum bytes of a serialized deploy list |
| `game-update.keepDeployLists` | integer | core | content | number of latest deploy lists kept saved. 1 or more |
| `game-update.deployListMaxAgeMs` | integer | core | content | cache duration of the deploy list response |
| `game-update.fileMaxAgeMs` | integer | core | content | cache duration of the file response |
| `game-update.cacheRefreshMs` | integer | core | content | interval at which a server instance reads the current deploy list again. 1 or more |
| `game-update.cdnTimeoutMs` | integer | core | content | time limit for uploading one CDN file. 1 or more |
| `environments.<ENV>.secrets.cdn` | string | game | none | name of the secret in the host secret store that holds the R2 secret access key of `cdn-r2` |
| `environments.<ENV>.cdnR2` | object | game | none | `accountId`, `bucket`, `accessKeyId`, `publicBaseUrl` of `cdn-r2` |
| `environments.<ENV>.adapters.cdn` | string? | game | none | CDN adapter name. When `null`, this environment has no CDN adapter |
| `routing.externalMaxResponseBytes` | integer | core | content | maximum bytes of an external service response body. When it is over that, the call fails |

## data

none

## DEV

none

## test

- The published deploy list and signature are received with `GET`, and the signature verifies with the public key of `get_update_signing_key`
- The `public_key` of `get_update_signing_key` is 32 bytes after standard base64 decode, and `key_id` is the first 16 characters of the lowercase hex SHA-256 of those 32 bytes and equals `key_id` of the signature JSON
- `sequence` is the larger of the previous `sequence` + 1 and `published_at`, and it goes up also when the same input is published again. On the first publish in a DB without a deploy list, `sequence` is `published_at`
- An input that points to a file that does not exist or has a different size is `conflict`, and the current deploy list stays as it is
- A `patches` entry whose `data_version` differs from both the server's `client_data_version` and `compat_client_data_version` is `conflict`. An entry equal to `compat_client_data_version` is published
- A duplicate `name` (also across different lists of one patch entry), a `name` that starts with `.` or ends with `.tmp` or `.bak`, a duplicate `language` in `translation_files`, a wrong `name` format and an item with `size` 0 are `bad_request`
- An unknown field, a wrong version format and `min_version` > `recommended_version` are `bad_request`
- `put_update_file` whose body SHA-256 differs from the query is `bad_request` and is not saved
- Without a `cdn` adapter, `file_base_url` is `files/` and `GET /update/files/<sha256>` gives the same bytes
- When `put` of a `cdn` adapter whose base URL was set with the `fake` controller fails, the result is `external_failed` and the current deploy list stays as it is. When it succeeds, `file_base_url` is that base URL
- After a `publish_deploy_list` in which `put` of the `cdn` adapter failed on the second file, the next publish with the same input does not upload the first file again
- A deploy list that another server instance published is served within `game-update.cacheRefreshMs`
- `prune_update_files` does not delete files of remaining deploy lists
- The `Cache-Control` value of the response header is the value calculated from settings
- The `sequence` of the signature JSON equals the `sequence` of the same deploy list
- Two concurrent `publish_deploy_list` get different `sequence` values
- When `publish_deploy_list` and `prune_update_files` are sent concurrently and the publish succeeds, all files that deploy list points to remain and `GET /update/files/<sha256>` gives those bytes. When the prune got its turn first and deleted a referenced file, the publish is `conflict` and the current deploy list stays as it is
- `is_data_update_ready` is `false` before the publish and at `published_at` + `game-update.deployListMaxAgeMs` + `game-update.cacheRefreshMs` − 1, and `true` from one millisecond after that time on. When there is no patch entry for that app version, or its `data_version` differs from both the server's `client_data_version` and `compat_client_data_version`, it is `false`
- When the environment is DEV, STG or PROD and the public key of the signing key is not in `updatePublicKeys`, the server does not start. LOCAL is not checked
