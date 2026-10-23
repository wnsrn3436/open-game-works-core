# user-snapshot-clone

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

Exports the saved state of one PROD user and PROD game state rows chosen by kind and key as a snapshot by only reading them, and overwrites STG or DEV with that snapshot so that a PROD problem can be reproduced. The samples of PROD users and game state that `migration` tests use are also obtained with it.

## dependency

- `validation`
- `storage`
- `session`
- `server-time`
- `logging`

## API

These are admin operations. user-snapshot-clone exports them, and `routing` collects them and passes them to `admin-api`. `admin-api` does the authentication, the processing order and the `audit` log.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `export_user_snapshot` | `user_id` | snapshot | `not_found`, `conflict` | operator |
| `sample_user_ids` | `count` | `user_ids` | `bad_request` | operator |
| `import_user_snapshot` | `target_user_id`, `snapshot` | `replaced_records`, `data_version_matches`, `data_version` | `bad_request`, `not_found`, `conflict` | operator |
| `list_clones` | none | `clones` (list of clone records) | none | operator |
| `wipe_clone` | `target_user_id`, `cloned_at` (optional) | empty object | `not_found` | operator |
| `export_game_state` | `kind`, `keys` | game state snapshot | `bad_request`, `conflict` | operator |
| `sample_game_state` | `kind`, `count` | game state snapshot | `bad_request`, `conflict` | operator |
| `import_game_state` | `target_key` (optional), game state snapshot | `replaced_records`, `data_version_matches`, `data_version` | `bad_request`, `conflict` | operator |

- `import_user_snapshot` is a binary body operation. `target_user_id` is a query, the body is the UTF-8 bytes of the snapshot JSON, and the body limit is `user-snapshot-clone.maxSnapshotBytes`
- The `count` of `sample_user_ids` is `int32`
- The `kind` of `export_game_state` and `sample_game_state` is `string` (game state kind name. e.g. `GuildBossGameState`). `keys` is `array<int64>`, and the `count` of `sample_game_state` is `int32`
- `import_game_state` is a binary body operation. `target_key` (`int64`) is a query, the body is the UTF-8 bytes of the game state snapshot JSON, and the body limit is `user-snapshot-clone.maxSnapshotBytes`

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `check_snapshot` | snapshot or game state snapshot (JSON value), whether it is a game state snapshot | `OK` | `bad_request` | `migration` DEV code |

- `check_snapshot` does check 2 of `import_user_snapshot`. For a game state snapshot, the snapshot table is the table without `source_user_id` and `user_created_at`. It reads and writes nothing

## behavior

### snapshot

A snapshot is one JSON object.

| field | type | meaning |
|---|---|---|
| `format` | JSON integer | snapshot format version. 1 now |
| `app_id` | JSON string | `appId` of game settings |
| `source_environment` | JSON string | environment of the exporting server |
| `source_user_id` | decimal integer string | exported user ID |
| `user_created_at` | decimal integer string | `created_at` of the `user` row of the exported user |
| `exported_at` | decimal integer string | export time. It is `server-time.clock_now` |
| `contract_version` | JSON integer | contract version of the exporting server |
| `data_version` | JSON string | server data version of the exporting server |
| `core_version` | JSON string | core version of the exporting server |
| `records` | JSON array | list of the records below. In byte order of `table`, `key` |
| `sha256` | JSON string | lowercase hex SHA-256 of the UTF-8 of `storage.canonical_json` of `records` |

record: a raw row of `storage` written as a JSON object with only the four fields `table`, `key`, `contract_version`, `value`. `table` (JSON string), `key` (JSON string) and `contract_version` (JSON integer) are the raw row values as they are, and `value` (JSON string) is the standard base64 of the raw row bytes

### included rows

- included rows: all raw rows that `storage.read_user_rows` returns. These are the rows of `user_state`, `server_state` and the `user` scope tables registered with snapshot flag `true`. e.g. UserState kinds, `server_state.proto` kinds, `ItemBalanceUserState`, `GachaPityUserState`, `MissionProgressUserState`, `NicknameUserState`, `SubscriptionUserState`, `ConsentUserState`, mailbox mail, shop purchase counts, gacha draw records, coupon use records, the `once_key` of items and mail
- Criterion for registering a table as excluded from the snapshot: authentication and session, device registration, consent and age check records, request handling records, history, operation records, logs, indexes for duplicate judgement across users. e.g. login token, social account link, terms consent record, age check record (`auth_age`), privacy choice record (`auth_consent_record`), session record, push device registration, idempotency response, `item-ledger` history, coupon input attempt counter, nickname duplicate judgement row (`nickname_name`), chat mute (`chat_mute`), client log
- Because `nickname_name` is not included, the nickname of `NicknameUserState` of a cloned user does not enter the duplicate judgement of the target environment. It enters from the next `SetNickname`
- `game` scope rows and shared areas that many users use together (ranking score, match record, iap payment record and subscription record, coupon and coupon code, notice, remote config override and experiment) are not included
- The excluded tables hold provider account IDs, device tokens and IPs. So the snapshot has none of those values. A display name the user set (e.g. the nickname of `NicknameUserState`) and text the user entered and that is kept in UserState or server state are in the snapshot

### export_user_snapshot

1. `user_target` is `user_id`. For a nonexistent user and a withdrawn user, `admin-api` ends with `not_found` before the handler function
2. In one user transaction of that user, reads the included rows with `storage.read_user_rows` with the saved bytes and contract version unchanged, and puts the `created_at` read with `storage.get_user_record` in `user_created_at`. It does no read conversion and writes nothing
3. When the serialized snapshot is more than `user-snapshot-clone.maxSnapshotBytes`, `conflict`

- Export only reads. Because of per-user serialization, the requests of that user wait during the export
- It can be called in every environment

### sample_user_ids

- `count` is at least 1 and at most `user-snapshot-clone.maxSampleCount`
- Chooses with `storage.sample_users` (`count`) in the game tx that `admin-api` opened. It reads nothing other than user records

### import_user_snapshot

Checks in the order below, and on a failure changes nothing.

1. When the environment is PROD, `conflict`
2. When the body is not one JSON object, or the name or type of a snapshot field differs from the snapshot table, or the field name or type of a record differs from the record definition, or `format` is not 1, or `validation.parse_version` cannot read `core_version`, or `sha256` does not match, `bad_request`
3. When `app_id` differs from the `appId` of this server, `conflict`
4. When `contract_version` or the `contract_version` of any record is greater than the contract version of this server, or `core_version` is higher than the core version of this server, `conflict`. The core version comparison is `validation.compare_versions`
5. When the `table` of a record is not a table of the included rows, or `key` or `value` violates the raw row format that `storage.replace_user_rows` checks, `bad_request`

`user_target` is `target_user_id`. For a nonexistent user and a withdrawn user, `admin-api` ends with `not_found` before the handler function. When checks 1 to 5 pass, it does the following in the out-of-request change of the target user that `admin-api` opened.

1. Replaces the included rows of the target user with the records through `storage.replace_user_rows`. `contract_version` stays as the record value. The read conversion of `storage` converts items of a lower version when they are read. Pending deltas are also deleted
2. Changes the `created_at` of the target user to the `user_created_at` of the snapshot with `storage.set_user_created_at`
3. Closes the session of the target user with `session.end_session`. The client logs in again and receives all UserState
4. Writes the clone record of the target user. When one exists, replaces it

- Rows of excluded tables (the login token, social account link and push device registration of the target user) stay as they are. So a device that was logging in as the target user plays in the cloned state when it logs in again
- Output `replaced_records` is the number of saved records, `data_version_matches` is whether the `data_version` of the snapshot equals that of this server, and `data_version` is the server data version of this server
- The `args` of the `audit` log keep `source_environment`, `source_user_id`, `sha256`, `target_user_id` instead of the snapshot

### game state snapshot

A game state snapshot is a JSON object with the fields of the snapshot table other than `source_user_id` and `user_created_at`. `records` are `game_state` raw rows of `storage`, and `sha256` is made the same way as for a snapshot.

- `export_game_state`
  1. When `kind` is not a kind of `game_state.proto`, or `keys` is empty or has more than `user-snapshot-clone.maxSampleCount` keys, or has a key less than 0 or duplicate keys, `bad_request`
  2. Reads with `storage.read_game_rows` (`kind`, `keys`) in the game tx that `admin-api` opened. It does no read conversion and writes nothing
  3. When the serialized game state snapshot is more than `user-snapshot-clone.maxSnapshotBytes`, `conflict`
- `export_game_state` can be called in every environment
- `sample_game_state`: when `kind` is not a kind of `game_state.proto`, or `count` is not from 1 to `user-snapshot-clone.maxSampleCount`, it is `bad_request`. Chooses with `storage.sample_game_rows` (`kind`, `count`) in the game tx that `admin-api` opened. When the serialized game state snapshot is more than `user-snapshot-clone.maxSnapshotBytes`, it is `conflict`. It can be called in every environment
- `import_game_state` does checks 1 to 4 of `import_user_snapshot`. The snapshot table of check 2 is the table without `source_user_id` and `user_created_at`. Then, in the cases below, it is `bad_request`. On a failure it changes nothing
  - The `table` of a record is not `game_state`, or the kind of `key` is not a game state kind of this server
  - `target_key` is given and there is not exactly one record, or `target_key` is less than 0
- When the checks pass, writes the records with `storage.replace_game_rows` in the game tx that `admin-api` opened. When `target_key` is given, it writes the record with its `key` changed to `<kind column value>/<target_key>` and the value of field `int64 key = 1` of `value` changed to `target_key`. When `replace_game_rows` is `FAILED`, it is `internal`. It does not write a clone record
- Output `replaced_records` is the number of written records, `data_version_matches` is whether the `data_version` of the game state snapshot equals that of this server, and `data_version` is the server data version of this server
- The `args` of the `audit` log keep `source_environment`, the key list of the records, `sha256`, `target_key` instead of the game state snapshot

### clone wipe

- clone record: `target_user_id`, `source_environment`, `source_user_id`, `cloned_at` (`server-time.clock_now` at import), `expires_at` (`cloned_at` + `user-snapshot-clone.cloneRetentionMs`). Table `user_snapshot_clone_record` has scope `game`, key `target_user_id`, no expiry column, personal data user column `target_user_id`, index `(expires_at)`, and is registered with `storage.register_table`
- clone wipe: in the out-of-request change of the target user, reads the clone record again. When there is no clone record, it changes nothing. When there is one, it deletes all included rows with `storage.replace_user_rows` (empty list), closes the session with `session.end_session`, and deletes the clone record. When the target user is a withdrawn user and so the result is `WITHDRAWN`, it locks `target_user_id` of `user_snapshot_clone_record` with `storage.lock_game_row` in a game transaction, reads the clone record again, and when there is one, deletes only the clone record. Only a clone wipe that deleted a clone record leaves `reason` `clone_wiped`, `target_user_id`, `source_user_id` in the `audit` log
- A clone wipe leaves the `created_at` of the `user` row of the target user at the value that the import set
- Job `user_snapshot_clone_sweep` (period `user-snapshot-clone.sweepIntervalMs`), which user-snapshot-clone sets with `server-time.schedule_job` at server start, reads the clone records with `expires_at` ≤ `clock_now` with `storage.read_db`, and does a clone wipe per record. This clone wipe changes nothing when the `expires_at` of the clone record read again inside the transaction is greater than `clock_now`. So a clone imported again after the job read it is not deleted
- `list_clones` returns all clone records in ascending order of `target_user_id`
- `wipe_clone` has no `user_target`. So even when the target user is a withdrawn user, it does not end before the handler function. The prepare function does the clone wipe of `target_user_id` outside a transaction. When `cloned_at` is given, that clone wipe changes nothing when the `cloned_at` of the clone record read again differs from that value. When that clone wipe did not delete a clone record, it is `not_found`. When the transaction of the clone wipe is `FAILED`, the prepare function throws and it is 500 `internal`. The handler function reads and writes nothing and returns an empty object
- A clone whose source environment is PROD and whose source user is a withdrawn user or does not exist in PROD is found by harness tool `ogw clone sweep`, each time `ogw deploy` deploys a game that has a PROD tag to DEV or STG, with `list_clones` of the target environment and `admin-api.get_user` of PROD, and deleted with a `wipe_clone` carrying the `cloned_at` read from `list_clones`

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| nonexistent user, withdrawn user | `not_found` | `audit` |
| size exceeded for an exported snapshot and game state snapshot, `import_user_snapshot` and `import_game_state` in PROD, `app_id` mismatch, contract version greater than the server's, core version higher than the server's | `conflict` | `audit` |
| snapshot format violation, `sha256` mismatch, a table that is not included | `bad_request` | `audit` |
| `kind` or `keys` violation in `export_game_state`, `kind` or `count` violation in `sample_game_state`, game state snapshot format violation, a record outside `game_state`, `target_key` violation | `bad_request` | `audit` |
| save failure during import | `internal`. The rows of the target user and the `game_state` rows do not change | `audit`, `error` |
| `wipe_clone` with no clone record or with a different `cloned_at` | `not_found` | `audit` |
| failure of the clone wipe of an expired clone | done again in the next period | `error` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `user-snapshot-clone.maxSnapshotBytes` | integer | core | content | maximum bytes of a serialized snapshot, a serialized game state snapshot and an import body |
| `user-snapshot-clone.maxSampleCount` | integer | core | content | maximum of the `count` of `sample_user_ids` and `sample_game_state` and of the number of keys of `export_game_state` |
| `appId` | string | game | none | app ID written to snapshot `app_id` and compared at import |
| `coreVersion` | string | game | none | core version of this server, written to snapshot `core_version` and compared at import |
| `user-snapshot-clone.cloneRetentionMs` | integer | core | content | duration that an imported clone is kept before it is deleted |
| `user-snapshot-clone.sweepIntervalMs` | integer | core | content | period for finding expired clones. 1 or more |
| `admin-api.maxBodyBytes` | integer | core | content | maximum bytes of the JSON body of `admin-api`. The import body is limited by `user-snapshot-clone.maxSnapshotBytes`, not by this value |

## data

none

## DEV

none

## test

- Export holds the included rows with the saved bytes and contract version unchanged, and does not hold the rows of excluded tables
- Before and after export, all table rows of the source user are the same. Items of a lower contract version are not written again either
- After import, the included rows of the target user equal the snapshot, and the rows of excluded tables, other than the rows of `session`, are the same as before the import
- When a snapshot is imported that holds an unclaimed mail with the same mail ID as a mail that the target user received with `ClaimMail`, `ClaimMail` of that mail grants the attachments without `ALREADY_APPLIED`
- After import, a request with the previous access token of the target user fails, and after logging in again, all UserState is the snapshot values
- The `user_created_at` of an exported snapshot is the `created_at` of the source user. After import, the `created_at` of `get_user_record` of the target user and the `user_created_at` of the `AuthResult` of a new login are that value, and the balance of a recovery item for which the source user has no row and `initial_amount` < `recovery_cap` equals that of the source user at the same time. After a clone wipe, `created_at` is also that value
- When a record of a lower contract version is imported, that record is saved with the contract version it came with
- Import of a snapshot and of a game state snapshot whose `data_version` differs from this server succeeds, `data_version_matches` is `false`, and `data_version` is the server data version of this server
- Import in the PROD environment is `conflict`, and the rows do not change
- A snapshot with `sha256` changed to a wrong value, a snapshot with a different `app_id`, a snapshot with a contract version higher than the server's, and a snapshot with a core version higher than the server's are rejected, and the rows do not change
- A snapshot whose `format` or `contract_version` is a string, a snapshot whose `exported_at` is a JSON integer, and a snapshot with a record whose `contract_version` is a string are `bad_request`, and the rows do not change. An exported snapshot keeps the types of the snapshot table
- When a snapshot is imported into a server that registered more `?` columns than the server that made the snapshot, those columns are saved as null. A record with an unregistered column, a missing non-`?` column, or a JSON value that differs from the column type is `bad_request`, and the rows do not change
- Import of a user snapshot with two records with the same `table` and `key`, and of a game state snapshot with two records with the same `key`, is `bad_request`, and the rows do not change
- When import fails during save, the rows of the target user are the same as before the import
- `sample_user_ids` does not return withdrawn users and has no duplicates
- Export of a user that is more than `maxSnapshotBytes` is `conflict`
- Import of a snapshot larger than `admin-api.maxBodyBytes` and at most `user-snapshot-clone.maxSnapshotBytes` succeeds, and a body of more than `user-snapshot-clone.maxSnapshotBytes` is 400 `bad_request`
- After import, a clone record exists and appears in `list_clones`. When `advance_time` moves past `cloned_at` + `user-snapshot-clone.cloneRetentionMs` and `wait_background` waits, job `user_snapshot_clone_sweep` deletes all included rows of the target user, closes the session and deletes the clone record. The rows of excluded tables remain
- `wipe_clone` does the same deletion, and a target with no clone record is `not_found`
- When the same target user is imported again before a `wipe_clone` carrying the `cloned_at` that `list_clones` returned, that `wipe_clone` is `not_found`, and the new clone record and the imported rows remain
- When the same target user is imported again after job `user_snapshot_clone_sweep` read an expired clone record and before the clone wipe, that clone wipe deletes nothing, and the new clone record and the imported rows remain
- When two `wipe_clone` for the same target are sent concurrently, one does the clone wipe and the other is `not_found`
- `wipe_clone` of a target user that became a withdrawn user after import is 200, the clone record is deleted, and `reason` `clone_wiped` is left in the `audit` log. Calling it again is `not_found`. Even when two `wipe_clone` of a withdrawn target user are sent concurrently, only one is 200
- `export_game_state` holds the `game_state` rows of that kind and keys with the saved bytes and contract version unchanged, and does not change the source rows. Nonexistent keys are left out
- `sample_game_state` holds only rows of that kind, without duplicates, up to `count`, and holds all of them when there are fewer rows than `count`
- After `import_game_state`, the `game_state` row of that key equals the record. An import with `target_key` writes to the row of that key, and the `key` of the value read with `get_game_state` is `target_key`. `import_game_state` in PROD is `conflict`, and the rows do not change
- The `cloned_at` of the clone record imported into a target user with a cheat time offset is `clock_now`, and regardless of the offset, when `clock_now` reaches `expires_at`, job `user_snapshot_clone_sweep` deletes that clone
