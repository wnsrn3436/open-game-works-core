# migration

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

Handles the converters that change saved UserState, server state and game state items to the meaning of the current contract. Defines conversion on read, batch conversion of all users, and the migration test on samples of PROD users and game state.

## dependency

- `storage`
- `server-time`
- `logging`
- dev dependency: `user-snapshot-clone`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_converter` | kind, from version, converter | none | none. A registration error is a server start failure | `register` of content `server/main.ts` |
| `start_migration_batch` | none | `batch_id` | `conflict`, `internal` | operator |
| `get_migration_batch` | none | batch record | `not_found` | operator |
| `stop_migration_batch` | none | empty object | `not_found` | operator |

- A kind is a kind of `user_state.proto`, `server_state.proto`, `game_state.proto`. Kinds that core defines and core module tables are not targets. The core schema change of `storage` handles changes to the saved structure of core
- Game state rows are not batch targets and are converted only on read. The item ID of `convert_item` receives the key of the game state
- `start_migration_batch`, `get_migration_batch`, `stop_migration_batch` are admin operations. Migration exports them, and `routing` collects them and passes them to `admin-api`. `admin-api` does the authentication, processing order and `audit` log
- `convert_item`(DB handle, kind, item ID, saved contract version, saved bytes → converted bytes, delete, `FAILED`) is the conversion function of migration. Migration sets it with `storage.register_item_converter` at server start. Storage does not depend on migration

## behavior

### contract version

The definition and calculation of the contract version and the rules for changing the meaning of a field follow the backward compatibility of [`contract`](../../contract/SKILL.md).

### converter

- There is one converter per (kind, from version). It changes an item saved with the from version value to the meaning of from version + 1
- A converter is registered only for a (kind, from version) that needs saved values moved to another field or values changed. A change that only adds fields or only adds `deprecated` is read without a converter, and a field missing from a saved item has the default value. The constraint on rolling back a build that added a converter is the backward compatibility of [`build`](../../build/SKILL.md)
- input: the item decoded from the saved bytes as the kind message of the current contract, and the generated container and accessors of server data
- output: one message of the same kind, or delete
- A converter decides its result from its input only. It does not use the DB, external services, time or random
- `register_converter` is called only inside `register` of content `server/main.ts`. The server does not start when any of the following holds
  - the kind is not in `user_state.proto`, `server_state.proto`, `game_state.proto`
  - the from version is less than 1 or is the current contract version or more
  - the same (kind, from version) is registered twice
  - the (kind, from version) is not in `GameContract.CONVERTERS`
  - when `register` ends, a (kind, from version) of `GameContract.CONVERTERS` is not registered
  - it is called before `begin_start()` or after `complete_start()`

### convert_item

- With v the saved contract version, applies only the registered converters one after another in ascending version order from v to the current contract version − 1. Versions without a registered converter are skipped
- When a converter in the middle returns delete, the later converters are not called and the result is delete
- In the following cases the result is `FAILED`, and the `error` log keeps in `fields` `item_kind`(kind column value), `item_id`, `stored_version`(saved contract version), `from_version`(the from version that failed), `error`(the reason below). IDs and versions are decimal strings
  - the saved bytes cannot be decoded as the current kind message
  - the converter throws or returns a value that is not the same kind message
  - the `id` of the item that a list kind converter returned differs from the `id` of the input
- When the saved contract version v is higher than the current contract version c, looks up with the received DB handle the rows of `migration_converter` whose `kind` is the kind column value of that item and whose `from_version` is c or more and less than v. When there is any, `FAILED`; otherwise returns the saved bytes as they are. So when a contract version increase added no converter, a previous server still reads that item's row after a rollback
- `migration_converter`: scope `game`, columns `kind`(`string`. kind column value), `from_version`(`int64`), `registered_at`(`int64`. `server-time.clock_now` when the row is inserted), key `(kind, from_version)`. Registered with `storage.register_table`. Never deleted. When job `migration_batch` runs and this server instance has not inserted them yet, one game transaction inserts a row for each registered converter that has no row. On failure, leaves an `error` log and inserts again on the next run. Does not block server start
- `storage` uses the result of `convert_item` in read conversion. The rule for saving again is the storage format section of `storage`. On `FAILED`, that request is `INTERNAL` and the item is unchanged

### batch

A batch converts, without requests, all users who have items with a low contract version. On `DONE`, the items of all users except the users that failed conversion and were counted in `failed_count` are at `target_version`.

- A batch record is a row of the `migration_batch` table: scope `game`, columns `batch_id`(`string`. base64url of 16 bytes of secure random), `status`(`string`. `RUNNING`, `STOPPED`, `DONE`), `target_version`(`int64`), `cursor_user_id`(`int64`), `converted_users`(`int64`. sum of the numbers of users whose conversion was committed by the steps that did the step end write), `failed_users`(`string`. JSON array of user ID decimal strings. No user ID appears twice), `failed_count`(`int64`. sum of the numbers of users that failed conversion in the steps that did the step end write), `lease_owner`(`string`), `lease_until_at`(`int64`), `started_at`(`int64`), `updated_at`(`int64`), key `batch_id`. Registered with `storage.register_table`. `started_at` and `updated_at` are `server-time.clock_now` at write time
- `start_migration_batch` locks key `""` of the `migration_batch` table with `storage.lock_game_row` in one game transaction and then looks for a `RUNNING` batch. When there is one, `conflict`. Otherwise it creates a row with `status` `RUNNING`, `target_version` set to the current contract version, `cursor_user_id`, `converted_users`, `failed_count`, `lease_until_at` set to 0, `failed_users` set to `[]`, and `lease_owner` set to an empty string. So concurrent calls of `start_migration_batch` create only one batch
- step: job `migration_batch`(period `migration.batchIntervalMs`), which migration sets with `server-time.schedule_job` at server start, inserts the `migration_converter` rows and then, when there is a `RUNNING` batch and its `target_version` is at most the contract version of this server instance, takes the lease and picks up to `migration.batchSize` users in ascending user ID order among the users with a user ID larger than `cursor_user_id` that are not withdrawn users and have a row with contract version < `target_version` in `user_state` or `server_state`
  - When `target_version` is larger than the contract version of this server instance, does not take the lease and does not write the batch record. `upgrade_user_rows` converts only up to the contract version of this server instance, so a server instance whose contract version is `target_version` or more continues that batch
  - Users are picked by giving `target_version` to `storage.scan_users`
  - Before converting each user, rereads the `status` of the batch record with `storage.read_db`. When it is not `RUNNING`, does not convert that user or the later ones and ends the step
  - For each user, calls `storage.upgrade_user_rows` in one `storage.run_user_transaction`. Read conversion does the conversion and the save. When `upgrade_user_rows` is `FAILED`, the change function returns `CoreError` `INTERNAL` and rolls back that user's transaction
  - When the result of `run_user_transaction` is `COMMITTED`, increases the conversion count of that step by one. On `REJECTED` or `FAILED`, the conversion of that user failed: increases the failure count of that step by one, adds that user ID to the failed user list of that step, and leaves an `error` log with the batch ID and user ID. On `WITHDRAWN`, counts nothing. With any result, continues to the next user
  - When the step ends, does the step end write. When there is a user whose conversion was attempted, changes `cursor_user_id` to the user ID of the last attempted conversion; otherwise leaves it unchanged. In the same write, adds the conversion count of that step to `converted_users` and the failure count of that step to `failed_count`, adds the user IDs of the failed users of that step that are not in `failed_users` to it in ascending user ID order until `failed_users` has `migration.maxRecordedFailures` users, and changes `lease_until_at` to `clock_now` to release the lease. The same applies to a step that ended at a `status` reread and to a step that changed to `DONE`. The next step takes the lease in the next job period
- The batch record writes of a step are only taking the lease, the step end write, and the `DONE` write below. While converting users, it does not write the batch record. The step end write changes only `cursor_user_id`, `converted_users`, `failed_users`, `failed_count`, `lease_until_at`, `updated_at`. A step does not change `status` outside the `DONE` write
- When there is no user to pick, changes `status` to `DONE` with a conditional update that writes only to a batch record whose `status` is `RUNNING` and whose `lease_owner` is its own value. When no row changes, it does not change to `DONE`
- The lease is `lease_owner` and `lease_until_at` of the batch record. A server instance takes the lease with a conditional update in one game transaction that, only when `lease_until_at` ≤ `clock_now`, changes `lease_owner` to a new secure random value and `lease_until_at` to `clock_now` + `migration.batchLeaseMs`. When no row changes, it did not take the lease
- The step end write is a conditional update that writes only to a batch record whose `lease_owner` is its own value. When no row changes, the lease was lost, and it drops the conversion count, failure count and failed user list of that step and stops. When the server instance holding the lease stops or loses the lease, another server instance continues from `cursor_user_id` of the batch record after the lease ends. So the same user is counted in `failed_count` only once, and conversions committed by a step that lost the lease are not counted in `converted_users`
- `stop_migration_batch` changes the `status` of the `RUNNING` batch to `STOPPED`. It does not check the lease. When there is no `RUNNING` batch, `not_found`. A step in progress finishes the user it is converting now and stops at the first `status` reread after the stop is committed. In SQLite, a write transaction holds the whole DB, so the stop is committed only after the transaction of the user being converted ends
- `get_migration_batch` returns the batch record with the latest `started_at`. `failed_users` is returned as the saved JSON array. When there is no batch, `not_found`
- A batch follows the same per-user serialization as that user's requests

### migration test

The migration test applies `migrate_snapshot` to samples of PROD users and game state and checks that there is no `FAILED` record. The save schema check of `build` runs it. The procedure is `### save schema check` of [`build`](../../build/SKILL.md).

- For each converter, a server regression test converts at least one item of the from version and compares the result

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| converter | when `convert_item` converts an item of that (kind, from version) | kind message item, data | kind message item or delete | a (kind, from version) that is not registered goes to the next version without conversion |

- A converter is a hook that does not use a DB transaction. It is registered with `register_converter`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| registration error | server start failure | none | `error` |
| decode failure, converter throw, wrong output, a `migration_converter` row between the current contract version and a higher one | `FAILED`. Item unchanged | `INTERNAL` | `error` |
| user conversion failure during a batch (`FAILED` from `upgrade_user_rows`, `FAILED` from `run_user_transaction`) | that user is rolled back. `failed_count` increases at the step end write | none | `error`. batch ID, user ID |
| `start_migration_batch` while a `RUNNING` batch exists | `conflict` | none | `audit` |
| no batch record, `stop_migration_batch` when there is no `RUNNING` batch | `not_found` | none | `audit` |
| lock wait timeout on `migration_batch` and deadlock in `start_migration_batch` | `internal` | none | `audit` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `migration.batchSize` | integer | core | content | maximum number of users one batch step converts |
| `migration.batchIntervalMs` | integer | core | content | interval between batch steps. 1 or more |
| `migration.batchLeaseMs` | integer | core | content | valid duration of a batch step lease |
| `migration.maxRecordedFailures` | integer | core | content | maximum number of users kept in `failed_users` |
| `migration.testSampleCount` | integer | core | human | number of PROD users that the migration test picks and number of game state rows it picks per kind |
| `storage.userLockWaitMs` | integer | core | content | maximum duration of waiting for a per-user lock |

settings constraint

| left | factor | right |
|---|---|---|
| `migration.testSampleCount` | 1 | `user-snapshot-clone.maxSampleCount` |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `migrate_snapshot` | snapshot or game state snapshot | per record `table`, `key`, `from_version`, `result`(`OK`, `DELETED`, `UNCHANGED`, `FAILED`), `error` | `bad_request` | `testing` |

- `migrate_snapshot` applies `convert_item` to `user_state`, `server_state`, `game_state` records, and encodes the result again as the current kind message and decodes it. It does not write to the DB. The item ID of a `game_state` record is the game state key
- `result`: a record for which `convert_item` is `FAILED` or whose result cannot be encoded and decoded again is `FAILED`, and a record that got delete is `DELETED`. Any other record is `OK` when at least one converter is registered for the from versions from the saved contract version to the current contract version − 1, and `UNCHANGED` when none is. Records of other tables are `UNCHANGED`
- A snapshot format violation is `bad_request`. The format check is done with `user-snapshot-clone.check_snapshot`

## test

The contract version of core test data is 1, so converters cannot be declared. So items that need a converter are tested by building the module directly with a test contract whose contract version is 2 or more, replacing `testing.call_dev` with a direct call of `migrate_snapshot`, `advance_time` with the test clock, and `wait_background` with `storage.wait_after_commit` and `server-time.wait_idle`.

- Converters (1) and (2) are applied in order to a version 1 item, and it is saved with the current contract version. Only (2) is applied to a version 2 item
- An unregistered version is skipped and the next converter is applied
- Registration of a (kind, from version) that is not in `GameContract.CONVERTERS`, and a (kind, from version) in `GameContract.CONVERTERS` that is not registered, are server start failures
- The first request of a user who has a low contract version record put in with `user-snapshot-clone.import_user_snapshot` reads the conversion result of the converter
- When a converter returns delete, the item is deleted and goes into the delete of the delta
- When a converter throws, the request is `INTERNAL`, and the bytes and contract version of the item are unchanged
- A converter that returns a different kind message or a different `id` is `FAILED`
- Each of the four registration errors blocks server start
- A batch converts all users who have low version items and becomes `DONE`. Users whose conversion failed stay in `failed_users`, and the batch continues
- When the server instance holding the lease is stopped during a batch, another server instance continues from `cursor_user_id`
- When a step with a user whose conversion failed loses the lease before the step end write and the batch that another server instance continued becomes `DONE`, `failed_users` has no user ID twice and `failed_count` equals the number of users whose conversion failed
- `start_migration_batch` during `RUNNING` is `conflict`. Of two concurrent calls of `start_migration_batch`, only one creates a batch and the other is `conflict`
- The `target_version` of a new batch is the current contract version at the time of `start_migration_batch`
- The step of a server instance whose contract version is lower than `target_version` does not take the lease, `cursor_user_id`, `converted_users` and `lease_owner` of the batch record are unchanged, and the step of a server instance whose contract version is `target_version` finishes that batch as `DONE`
- `migrate_snapshot` called with `call_dev` does not change the DB and returns a result per record
- In `migrate_snapshot`, a record to which a converter was applied is `OK`, and a record of the current contract version and a record of a lower version with no registered converter are `UNCHANGED`
- `migrate_snapshot` applies the converter of that kind to a lower contract version `game_state` record of a game state snapshot, and when the converter throws, that record is `FAILED`
- When two server instances take the batch lease concurrently, only one takes it. After the lease ends and another server instance takes it, the earlier server instance stops without writing the batch record
- With settings where `migration.batchLeaseMs` is longer than `migration.batchIntervalMs`, doing `testing.advance_time`(`migration.batchIntervalMs`) and `wait_background` twice advances `cursor_user_id` by two steps, and `lease_until_at` of the batch record after a step ends is the `clock_now` when that step ended
- `get_migration_batch` returns the batch with the latest `started_at`, and `stop_migration_batch` is `not_found` when there is no `RUNNING` batch
- When `stop_migration_batch` is called while a step converts users, that step does not convert the next user. The `status` of the batch record is `STOPPED`, and `cursor_user_id` is the user ID of the last attempted conversion
- When `stop_migration_batch` is committed before the `DONE` write of a step with no user to pick, `status` stays `STOPPED`
- The `FAILED` error log of `convert_item` has the item ID
- When an item with a contract version higher than the current one is read, the saved bytes are read as they are when `migration_converter` has no row of that kind with a from version in between, and the result is `INTERNAL` with the item unchanged when it has one. When rows with a from version in between exist only for other kinds, the saved bytes are read as they are. After server start and `wait_background`, there is a `migration_converter` row for each registered converter
- Even when a user failed conversion, the batch becomes `DONE`, and the items of all users other than that user are at `target_version`
- During a batch, when another transaction holds the per-user lock of a user longer than `storage.userLockWaitMs`, that user is counted in `failed_count` and `failed_users`, an `error` log with the batch ID and user ID is left, and the batch continues to the next user
