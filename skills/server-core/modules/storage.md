# storage

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

Handles DB transactions, savepoints, per-user serialization, and the ctx and ctx random of each transaction, saves UserState, server state and game state, and makes the UserState delta and pending delta from saved changes. Also handles reading public kinds of other users, user change, the DB adapter that uses SQLite and PostgreSQL with the same semantics, and the base tables.

## dependency

- `server-time`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_state` | ctx, kind, item ID | value or none | misuse throws | content handler, hook, core module |
| `list_state` | ctx, list kind | list of values in ascending order of item ID | misuse throws | content handler, hook, core module |
| `put_state` | ctx, value | none | misuse throws | content handler, hook, core module |
| `delete_state` | ctx, kind, item ID | none. Does nothing for an item that does not exist | misuse throws | content handler, hook, core module |
| `put_core_state` | ctx, core kind value | none | misuse throws | owner module of that core kind |
| `delete_core_state` | ctx, core kind, item ID | none | misuse throws | owner module of that core kind |
| `read_public_state` | ctx, list of user IDs, public kind | list of `(user ID, value)` in ascending order of user ID. For a single kind one value, for a list kind a list of values in ascending order of item ID | misuse throws | content handler, hook, core module |
| `get_game_state` | ctx, game state kind, key | value or none | misuse throws | content handler, hook |
| `list_game_state` | ctx, game state kind, above this key, maximum count | list of values in ascending order of key | misuse throws | content handler, hook |
| `put_game_state` | ctx, value, expiry time (0 means none) | none | misuse throws | content handler, hook |
| `delete_game_state` | ctx, game state kind, key | none. Does nothing for a row that does not exist | misuse throws | content handler, hook |
| `run_user_transaction` | user ID, change function | async operation. `COMMITTED`, `WITHDRAWN`, `REJECTED` | `FAILED` | core module |
| `run_request_transaction` | user ID, request fields (`request_name`, `request_id`, `silent`, `retry`, `session_id`, `client_version`, `platform`), function | async operation. result of the function | `FAILED`, `WITHDRAWN` | `routing`, `auth` |
| `take_response_delta` | ctx | response delta, list of `kind` column values of skipped unknown kind rows | misuse throws | `routing`, `auth` |
| `add_item_change` | ctx, `ItemChange` | none | misuse throws | `item-ledger` |
| `add_item_mail` | ctx, `ItemMail` | none | misuse throws | `mailbox` |
| `run_rollback_transaction` | user ID, function | async operation. result of the function | `FAILED`, `WITHDRAWN` | `matchmaker` |
| `run_game_transaction` | function | async operation. result of the function | `FAILED` | core module |
| `run_savepoint` | ctx, function | `pass` or the failure code of the function (`GameError` or `CoreError`) | none | core module |
| `with_hook_change_source` | ctx, `ItemChangeSource` element, ref, function | result of the function | none | core module |
| `check_hook_output` | hook name, hook output | `pass` when the output is `pass`, that value when it is `GameError` | none. When neither, throws with a message containing the hook name | core module |
| `run_read_only` | ctx or game tx, function | result of the function | none | `validation`, `admin-api`, `public-profile` |
| `lock_game_row` | ctx or game tx, table name, key value | none | `FAILED`. A call from a content handler or hook throws | core module, content handler, hook |
| `after_commit` | ctx or game tx, function | none | an invalid ctx or tx throws | core module |
| `on_commit` | ctx or game tx, synchronous function | none | an invalid ctx or tx throws | core module |
| `send_user_change` | ctx, target user ID, change name, payload bytes | none | misuse throws | content handler, hook, core module |
| `register_user_change` | change name, apply function, fail function | none | none. A registration error is a server start failure | `register` of content `server/main.ts`, core module |
| `run_user_changes` | none | async operation. number of applied rows | `FAILED` | `routing` |
| `db` | ctx or game tx | DB handle | an invalid ctx or tx throws | core module |
| `read_db` | none | read-only DB handle | none | core module |
| `create_user` | game tx | new user ID | none | `auth` |
| `delete_user` | ctx | none | none | `auth` |
| `get_user_record` | DB handle, user ID | `created_at`, `withdrawn_at`, or none | none | `admin-api`, `auth`, `item-ledger`, `public-profile`, `guild`, `user-snapshot-clone` |
| `set_user_created_at` | ctx, time | none | none | `user-snapshot-clone` |
| `scan_users` | DB handle, above this user ID, maximum count, contract version v (optional) | list of user IDs of users that are not withdrawn users, in ascending order | none | `migration`, `auth` |
| `sample_users` | DB handle, maximum count | list of user IDs picked from users that are not withdrawn users, in ascending order | none | `user-snapshot-clone` |
| `read_full_state` | ctx | delta holding all UserState of that user, the list of `ItemChange` and the list of `ItemMail` accumulated with the deleted pending delta, list of `kind` column values of skipped unknown kind rows | none | `auth`, `session` |
| `read_user_rows` | ctx | list of raw rows of the snapshot target rows | none | `user-snapshot-clone` |
| `replace_user_rows` | ctx, list of raw rows | number of replaced rows | an unknown table or a format violation throws | `user-snapshot-clone` |
| `read_game_rows` | DB handle, game state kind, list of keys | list of `game_state` raw rows of those keys | none | `user-snapshot-clone` |
| `sample_game_rows` | DB handle, game state kind, maximum count | list of raw rows picked from the `game_state` rows of that kind | none | `user-snapshot-clone` |
| `replace_game_rows` | game tx, list of raw rows | number of replaced rows | a format violation throws. Exceeding the lock wait is `FAILED` | `user-snapshot-clone` |
| `upgrade_user_rows` | ctx | number of changed items | `FAILED` | `migration` |
| `register_table` | table name, scope, column list (name, column type), key column list, expiry column, snapshot flag, personal data user column (optional), index list (optional) | none | none. A registration error is a server start failure | core module |
| `export_user_rows` | DB handle, user ID | for each table given a personal data user column, the list of rows in which that column is the user ID | none | `admin-api` |
| `register_item_converter` | converter function (DB handle, kind, item ID, saved contract version, saved bytes → converted bytes, delete, `FAILED`) | none | none. Calling it twice is a server start failure | `migration` |
| `sweep_expired` | none | async operation. number of deleted rows | `FAILED` | `routing` |
| `random_u32` | ctx or random instance | integer at least 0 and less than 2^32 | none | content handler, hook, core module |
| `random_int` | ctx or random instance, min, max | integer at least min and at most max | an input violation throws | content handler, hook, core module |
| `random_weighted` | ctx or random instance, list of weights | picked index | an input violation throws | content handler, hook, core module |
| `random_shuffle` | ctx or random instance, count n | permutation of 0 to n−1 | an input violation throws | content handler, hook, core module |
| `create_random` | seed(`int64`) | random instance | none | `matchmaker`, hook |
| `make_purpose_seed` | purpose name, base(`int64`) | seed(`int64`) | none | `matchmaker`, hook |
| `canonical_json` | JSON value | canonical JSON string | a non-finite number and a value with no JSON format throw | core module |

- A kind is a generated kind type. A UserState kind is a kind of `user_state.proto`, a server state kind a kind of `server_state.proto`, and a game state kind a kind of `game_state.proto`. The item ID of a single kind is 0. The key of a game state kind is the `key` field of that message and is 0 or more
- A public kind is a kind of `user_state.proto` whose message option `(ogw.public)` is `true`. A core kind is not a public kind
- A core kind is a UserState kind of the base proto. The list and the owner modules are in `## core UserState kind` of the base proto table that `## base proto` of [`server-core`](../SKILL.md) points to
- misuse: an unknown kind, a negative item ID for a list kind, an item ID other than 0 for a single kind, a value that is not a kind message, `put_state` and `delete_state` on a core kind, `put_core_state` and `delete_core_state` on a kind that is not a core kind, a write inside a `run_read_only` function, an invalid ctx, `read_public_state` of a kind that is not a public kind, a user ID count of `read_public_state` more than `storage.maxPublicReadCount`, a negative game state key, a maximum count of `list_game_state` less than 1 or more than `storage.maxGameStateList`, `lock_game_row` to which a content handler or hook passed a table other than `game_state`, `lock_game_row` to which a core module passed a table other than the tables registered with scope `game`, a change name that is not registered, a user change target that is less than 1 or is the user of the ctx, a payload more than `storage.userChangeMaxBytes`. A misuse throws, and the request ends with `INTERNAL`
- The value that a misuse and `replace_user_rows` and `replace_game_rows` throw is an instance of class `StorageMisuse` that the entry file exports
- A content handler and a hook pass table name `game_state` and key value `(game state kind, key)` to `lock_game_row`. Exceeding the wait in that call throws, and the request is `INTERNAL`. A core module passes a table that it registered with scope `game` by `register_table`, and exceeding the wait in that call is `FAILED`
- Input violations of `random_int`: min > max, max − min is 2^32 or more. Input violations of `random_weighted`: an empty list, a negative or non-integer weight, a sum of 0, a sum more than 2^32. Input violations of `random_shuffle`: n is less than 0 or more than `storage.maxShuffleCount`. `random_int`, `random_weighted` and `random_shuffle` draw with the same algorithm (`bounded`) as `UtilCore.range_int`, `pick_weighted` and `shuffle_indices` respectively
- random instance: a PCG32 sequence that `create_random` makes from a seed. When it is passed to `random_u32`, `random_int`, `random_weighted` or `random_shuffle` instead of ctx, they draw from that sequence instead of the ctx random. `create_random` and `make_purpose_seed` use the same algorithm as the operations of the same name in `UtilCore`
- The change function of `run_user_transaction` receives an out-of-request ctx and returns `pass` or a failure code (`GameError` or `CoreError`). On a failure code, rolls back, and the result is `REJECTED`
- `run_rollback_transaction` opens the same user transaction as `run_user_transaction`, calls the function with an out-of-request ctx, and always rolls back regardless of the result. It makes no delta and no pending delta
- The function of `run_game_transaction` receives a game tx. When the function returns a failure code (`GameError` or `CoreError`), rolls back and returns that value. For any other result, commits and returns that result. So when the result to commit is a number, the function returns the number wrapped in an object. When the function throws, rolls back and throws
- The functions passed to `run_request_transaction`, `run_user_transaction` and `run_game_transaction`, and the apply function and fail function of a user change, are synchronous functions. They do not return a promise
- DB handle: `db(ctx)` of a user transaction, `db(tx)` of a game transaction, or the handle of `read_db`. With a DB handle, a core module reads and writes, by parameterized SQL, only the tables it registered with `register_table`. The `user` table is read only with `get_user_record`, `scan_users` and `sample_users`
- A DB handle has one method, `query(sql, parameter list)`, and it is synchronous. Both reads and writes use this method, and it returns the list of result rows. A row is an object keyed by column name, and the values are `bigint` for `int64`, `number` for `int32`, `boolean` for `bool`, `string` for `string`, `Uint8Array` for `bytes`, and `null` for null. In both DBs, parameters are written as numbers from `$1`, and the same number can be used again. `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` is used in both DBs
- TypeScript form of `register_table`: a column is `{name, type}`, the expiry column is `null` when there is none, and the snapshot flag of a scope `game` table is `null`. A core module calls `register_table` in `create_<module>` or `begin_start()`
- The key value of `lock_game_row` is an array of the key column values in key column order. It is an array also when there is one key column. For table `game_state` it is `[game state kind, key]`
- The scope is `user` (first column `user_id`. Deleted at withdrawal) or `game`. The snapshot flag is given only to a `user` scope table, and when it is `true`, user snapshot clone copies its rows
- personal data user column: the name of the user ID column of that table. Given only to a table that holds personal data of that user. Can be given for scope `user` and `game`. When given, the rows of that table go into `export_user_rows`
- The column types are `int64`, `int32`, `bool`, `string` and `bytes`. `?` after a type accepts null. The first column of a scope `user` table is `user_id`(`int64`). A `user` scope table with snapshot flag `true` has `user_id` in its key columns. The expiry column is an `int64` column
- index list: per index, a list of column names, and the list order is the column order of the index. The schema step of server start makes them in both DBs as indexes with the same column order. The index name is `ix_` followed by the first 16 characters of the SHA-256 hex of the UTF-8 bytes of `<table name>:<column list>`, and `<column list>` is the column names joined with commas. For each query that cannot select rows with only a leading part of the key column list (the columns continuing from the first column), a module spec writes in that table definition an index that starts with the condition column or sort column of that query
- `check_hook_output` treats a safe integer `number` of 1000 or more as `GameError`
- canonical JSON: a JSON string written with object keys in UTF-8 byte order and without whitespace. `bigint` is a JSON integer, `Uint8Array` is a standard base64 string, and an object field whose value is `undefined` is left out.
- The output of `export_user_rows` is an array of rows per table name. A row is an object keyed by column name, `int64` is a decimal string, and bytes are standard base64. Rows are in ascending order of key column values. Writes nothing

## behavior

### ctx

ctx is the handling scope of one user transaction. One request or one out-of-request change is one user transaction. The operations of a core module that run inside a transaction receive ctx as the first input.

| field | meaning |
|---|---|
| `user_id` | user ID of that transaction. For a request, the value obtained from the access token |
| `request_name` | request name of the contract. Empty string for an out-of-request change |
| `request_id` | request ID. Empty string for an out-of-request change |
| `silent`, `retry` | `rpc` option values. `false` for an out-of-request change |
| `session_id` | session ID of the access token. Empty string for an out-of-request change and for a request without a session |
| `client_version`, `platform` | values of `X-Ogw-Client-Version`, `X-Ogw-Platform`. Empty string for an out-of-request change |
| `request_time` | time set with `server-time.user_now` when the transaction opens. A handler reads it with `server-time.now` |
| `data` | generated containers and accessors of the server build data |
| `data_version` | data version of the server build data. The format is `<protocol hash>-<data hash>` |
| `user_deleted` | `true` when `delete_user` was called in that transaction, otherwise `false` |
| `hook_change_source` | `(source, ref)` passed while the function of `with_hook_change_source` runs. When nested, the inner value. Otherwise none |
| `seed` | seed of the ctx random of that transaction. A 64-bit value |

- ctx is invalid after the transaction ends. Handlers and hooks do not keep ctx outside the transaction
- The TypeScript type of ctx is interface `RequestCtx` that `server/core/storage/request_ctx.ts` exports. Its fields are the fields of the table above. A request ctx and an out-of-request ctx have the same type
- random: the algorithm is PCG32, and it produces the same sequence as the random of `UtilCore`. The seed is a 64-bit value made with secure random per transaction and is `seed` of the ctx. `routing` records the seed of a request in `seed` of the `request` log as a decimal string

### transaction

- One request is one transaction. The handler run, delta collection, clearing the pending delta and saving the response are committed together or rolled back together
- out-of-request change: a change of the state of one user outside request handling. e.g. mailbox arrival, ads reward grant, admin grant, ranking season reward. One is one `run_user_transaction`
  - When the target user has no `user` row or is a withdrawn user, does not call the change function, and the result is `WITHDRAWN`
  - The request time of an out-of-request ctx is the time the transaction opened, and the random seed is made new
  - Changed UserState accumulates as a pending delta
- `run_request_transaction` opens the user transaction of one request, makes ctx from the input user ID and request fields, and calls the function. When the target user has no `user` row or has `withdrawn_at`, does not call the function, and the result is `WITHDRAWN`. When the function returns `GameError` or `CoreError`, rolls back and returns that value. For any other result, commits and returns that result. So when the result to commit is a number, the function returns the number wrapped in an object. When the function throws, rolls back and throws
- per-user serialization: transactions of the same user run one at a time. A later transaction waits for the commit or rollback of the earlier transaction. When it waits more than `storage.userLockWaitMs`, `FAILED`, and the request is `INTERNAL`
- A read inside a transaction sees the values that transaction wrote
- Opening a user transaction or game transaction again inside a user transaction throws. The state of another user is read with `read_public_state` and changed after commit with `send_user_change`
- A user transaction writes the `user` scope rows of that user and `game` scope rows. It does not write `user` scope rows of another user
- `lock_game_row` locks one `game` scope row until that user transaction or game transaction ends. For a row that another transaction locked, it waits, and beyond `storage.userLockWaitMs` it is `FAILED`. Locking the same row again does nothing
- `lock_game_row` locks the key value even when the row of that key does not exist yet. Duplicate judgements before a row is created are also handled one after another
- When PostgreSQL aborts a transaction with a deadlock (SQLSTATE `40P01`) or a serialization failure (SQLSTATE `40001`), it is handled the same as exceeding the lock wait. During `lock_game_row`, `lock_game_row` is `FAILED`, and a call from a content handler or hook throws. During any other query, rolls back the transaction, and the operation that opened that transaction is `FAILED`. An aborted transaction is not committed
- A core module sets in its spec one order in which it locks several rows with `lock_game_row` in one transaction
- A game transaction writes only `game` scope tables and does not take the per-user lock. It only reads `user` scope rows
- The handle of `read_db` reads only committed rows, outside a transaction. A write with that handle is a misuse. Reads before a user transaction opens (the session, cheat time offset and committed saved response of `routing` step 5, and the ban of step 6) use this handle
- `after_commit` registers a function to the transaction of that ctx or game tx. When the transaction commits, calls each function once, outside the transaction, in registration order, and the response of the request does not wait for the functions. Functions registered in a rolled-back transaction, in `run_rollback_transaction`, or in a range that `run_savepoint` reverted are discarded without being called. When a function throws, discards that exception and calls the next function. The module that registered the function leaves the failure log of the function
- `on_commit` registers a synchronous function to the transaction of that ctx or game tx. When the transaction commits, calls each function once in registration order, within the turn in which that commit finished, before the `after_commit` functions. Return values are discarded. The discard ranges and the handling of throws are the same as `after_commit`. `stop()` of `routing` does not discard the `on_commit` functions of a committed transaction. Use: logs left only for committed changes

### savepoint

- `run_savepoint` opens a savepoint inside the user transaction and calls the function. When the function returns `pass`, releases the savepoint and keeps the changes
- When the function returns a failure code (`GameError` or `CoreError`), reverts all changes after the savepoint (UserState, server state, module table rows, delta records, items accumulated in `item_changes` and `item_mails`) and returns that failure code. The transaction continues
- When the function throws, throws as it is. A savepoint can be opened again inside a savepoint

### read only

- `run_read_only` keeps that ctx or game tx read-only until the function ends. Inside the function, `put_state`, `delete_state`, `put_core_state`, `delete_core_state`, `put_game_state`, `delete_game_state`, `send_user_change` and a write with the handle that `db` returned are misuses

### public state

- `read_public_state` reads public kinds of other users. It reads the `user_state` rows of those users over the transaction connection of the ctx and does not take the locks of those users. Rows of other users are committed values, and rows of the ctx user are the values that transaction wrote
- The read conversion of the read rows is the same as inside a `run_read_only` function. It only returns the converted value and does not save it again
- Users without a value, users without a `user` row and withdrawn users are left out of the result
- Writes nothing. No delta and no pending delta are made

### game state

- game state is the saved state of the whole game that does not belong to a user. It is kept in the `game_state` base table, one row per game state kind and key
- Any user transaction reads and writes it. When several user transactions change the same row (e.g. shared boss HP, per-guild progress), each first locks that row with `lock_game_row`, reads it, then writes. Reads and writes without a lock can overwrite the changes of another transaction
- When the expiry time of `put_game_state` is not 0, that value is `expires_at` of the row. `get_game_state` and `list_game_state` treat a row with `expires_at` ≤ `server-time.clock_now` as none, and `sweep_expired` deletes it
- The maximum count of `list_game_state` is at least 1 and at most `storage.maxGameStateList`
- `above this key` of `list_game_state` accepts every int64 value. With −1, returns from key 0. The negative game state key of misuse does not apply to this value
- It does not go into the delta or the pending delta. A handler puts values to send to the client in the response message
- It is not a target of user snapshot or `delete_user`. Personal data is not kept in game state. Only the game state snapshot of `user-snapshot-clone` reads and writes it as raw rows

### user change

A user change is a change of the saved state of another user by the transaction of one user. It is committed together with the sending transaction and applied after commit as an out-of-request change of the target user. e.g. a gift sent to a friend, a reward sent to guild members

- A change name is snake_case. A name that a core module registers starts with `<module name>.`, and a name that content registers has no `.`
- `register_user_change` attaches an apply function and a fail function per change name. A core module calls it at server start, and content calls it in `register` of `server/main.ts`
- `send_user_change` writes a `user_change` row with `phase` `apply` and `next_attempt_at` = `server-time.clock_now` in the transaction of the ctx, and attaches the application of that row with `after_commit`. When the transaction rolls back, there is neither the row nor the application
- row processing order
  1. When `phase` is `apply`, opens `run_user_transaction` of the target user. Inside it, locks that row with `lock_game_row` and reads it, and when there is no row or `phase` is not `apply`, does nothing. Otherwise calls the apply function, and on `pass` deletes the row. The changes become the pending delta of the target user
  2. When the result of 1 is `REJECTED` or `WITHDRAWN`, in one game transaction changes `phase` of that row to `fail`, `fail_reason` to `rejected` (the failure code in `fail_code`) or `withdrawn`, and `attempts` to 0, and does 3
  3. When `phase` is `fail`, opens `run_user_transaction` of the sending user, locks that row and reads it, and when there is no row, does nothing. Otherwise calls the fail function and deletes the row. When the sending user is `WITHDRAWN`, deletes the row with a game transaction
  4. When the result of 1 or 3 is `FAILED`, in one game transaction increases `attempts` by 1 and changes `next_attempt_at` to `clock_now` + the retry interval. The first retry interval is `storage.userChangeRetryInitialMs`, and each later interval is the previous interval multiplied by `storage.userChangeRetryFactorPermille` and divided by 1000. The interval does not exceed `storage.userChangeRetryMaxIntervalMs`. When `attempts` of `phase` `apply` reaches `storage.userChangeRetryMaxAttempts`, changes the row as in 2 with `fail_reason` `failed` and does 3. When `attempts` of `phase` `fail` reaches it, deletes the row
- When the apply function or fail function throws, rolls back that transaction and handles it the same as `FAILED`
- When handling a selected row throws outside the apply function and fail function (e.g. the write of that row itself), that server instance leaves the `change_id` of that row out of the selection of later `run_user_changes` until the process ends. The `routing` `error` log of that run records the `change_id`
- Job `storage_sweep` of `routing` calls `run_user_changes`. It selects up to `storage.userChangeBatchSize` rows whose `name` is a change name registered in this server instance and whose `next_attempt_at` ≤ `clock_now`, in ascending order of `next_attempt_at`, and applies them one at a time. Rows with a name that is not registered are neither selected nor changed, and the server instance that registered that name applies them. Even when several server instances select the same row, the lock and row check of 1 and 3 let the apply function and fail function run to the end only once per row
- The application order is not guaranteed even for user changes between the same sending user and target user
- storage leaves no log of user changes. The side that registered the apply function and fail function leaves it

### UserState delta

- A transaction records the writes and deletes of UserState and makes a delta. For a request it makes it at `take_response_delta`, and for an out-of-request change right before commit
  - A written item goes into upsert with its value at commit time. A write that did not change the value does not go in
  - A deleted item goes into delete. An item written then deleted goes only into delete, and an item deleted then written goes only into upsert
  - An item that did not exist from the start and is written then deleted does not go in
- Server state kinds do not go into the delta
- The delta is `UserStateDelta` of the contract. `kind` of an entry is the kind message name, and the format and entry order follow the UserState section of [`contract`](../../contract/SKILL.md)
- Handlers and core modules do not make the delta

### pending delta

- The delta of an out-of-request change accumulates in `pending_delta` with order number `seq`. `seq` is the largest `seq` of the `pending_delta` rows of that user read inside that user transaction + 1, and 1 when there is no row
- The response delta is the values carried in `user_state`, `pending_user_state`, `item_changes` and `item_mails` of `ResponseEnvelope`. For a success response, it is made with `take_response_delta`. `user_state` is the delta of that request, and `pending_user_state` is the delta that merges all pending deltas of that user in order number order. The pending delta rows are deleted in the same transaction
- When the same item is in both deltas, it goes into both with its saved value at commit time. An item that does not exist at commit time goes only into delete
- `item_changes` puts the `ItemChange` of the pending delta rows in order number order, then the `ItemChange` of that request. `item_mails` is the same. `ItemChange` and `ItemMail` of the ctx are in the order in which `item-ledger` and `mailbox` added them with `add_item_change` and `add_item_mail`. Those of an out-of-request change accumulate in its pending delta row at commit
- `take_response_delta` is called once per ctx. After that, a UserState write, `add_item_change`, `add_item_mail` and `take_response_delta` on that ctx are misuses
- `delta` of `pending_delta` is the UTF-8 bytes of a JSON object that holds `items` (`[kind column value, item ID]` per written or deleted item), `item_changes` and `item_mails` of one out-of-request change. `ItemChange` and `ItemMail` are written with the proto3 JSON mapping. Item values are not included. The response carries, per item, its saved value at the commit time of that response
- An error response does not carry the pending delta and does not delete it
- The delta that `read_full_state` makes has `full` field `true`. The client clears the existing UserState and applies it. Deletes the pending delta rows in the same transaction, and returns the `ItemChange` and `ItemMail` accumulated with the deleted pending delta in accumulation order
- `take_response_delta` of a ctx that called `read_full_state` carries the delta that `read_full_state` made in `user_state` and an empty delta in `pending_user_state`, and puts the lists that `read_full_state` returned before the lists of that request in `item_changes` and `item_mails`. A UserState write on that ctx after `read_full_state` is a misuse

### storage format

- A value is saved as the protobuf bytes of the kind message, together with the contract version at save time
- `game_state` rows also follow the same storage format and the read conversion below. The game state key is passed as the item ID of the converter function
- When the contract version of a read row is lower than the current contract version, uses the result of the converter function registered with `register_item_converter`. For converted bytes, returns that value and saves it again with the current contract version in that transaction. For delete, deletes that item and returns none. For `FAILED`, throws. Inside a `run_read_only` function, only returns the converted value or none and does not save again or delete. So no delta and no pending delta are made either
- Saving again and deleting a `game_state` row are a conditional update and a conditional delete that write only to a row whose `contract_version` and `value` are still those of the read row. When no row changed, another transaction changed that row in between, and it writes nothing and returns the converted value or none
- `upgrade_user_rows` does the read conversion on all `user_state` and `server_state` rows of that user whose contract version is lower than the current one. When even one is `FAILED`, returns `FAILED` without throwing. The caller rolls back the transaction
- When no converter function is registered, a row of a lower version is read as it is with the current contract message
- Also when the contract version of a read row is higher than the current one, passes it to the registered converter function together with the DB handle of that transaction. When the converter function returns bytes, reads that value with the current contract message and does not save it again. For `FAILED`, throws. When no converter function is registered, reads that row as it is with the current contract message. A write of that item saves it with the current contract version
- unknown kind row: a row of `user_state`, `server_state` or `game_state` whose `kind` column value is not a kind of the current contract. It appears when the server of a build that knows that kind writes it and the server is then rolled back to a previous build. storage does not delete or change unknown kind rows. `read_full_state`, `take_response_delta` and `upgrade_user_rows` skip unknown kind rows and unknown kind items of pending delta `items`, and `read_full_state` and `take_response_delta` return the list of skipped `kind` column values. `read_user_rows`, `read_game_rows` and `sample_game_rows` also include unknown kind rows as raw rows

### base table

| table | scope | column | key |
|---|---|---|---|
| `user` | `game` | `user_id`(`int64`. issued from 1), `created_at`(`int64`), `withdrawn_at`(`int64?`. null when none) | `user_id` |
| `user_state` | `user` | `user_id`(`int64`), `kind`(`string`), `item_id`(`int64`), `value`(`bytes`), `contract_version`(`int64`), `updated_at`(`int64`) | `(user_id, kind, item_id)` |
| `server_state` | `user` | `user_id`(`int64`), `kind`(`string`), `item_id`(`int64`), `value`(`bytes`), `contract_version`(`int64`), `updated_at`(`int64`) | `(user_id, kind, item_id)` |
| `pending_delta` | `user` | `user_id`(`int64`), `seq`(`int64`), `delta`(`bytes`), `created_at`(`int64`) | `(user_id, seq)` |
| `storage_schema` | `game` | `name`(`string`), `definition`(`string`) | `name` |
| `game_state` | `game` | `kind`(`string`), `key`(`int64`), `value`(`bytes`), `contract_version`(`int64`), `updated_at`(`int64`), `expires_at`(`int64?`. null when none) | `(kind, key)` |
| `user_change` | `game` | `change_id`(`int64`. issued from 1), `name`(`string`), `sender_id`(`int64`), `target_id`(`int64`), `payload`(`bytes`), `phase`(`string`. `apply`, `fail`), `fail_reason`(`string`. `rejected`, `withdrawn`, `failed`. Empty string when `apply`), `fail_code`(`int32`), `attempts`(`int32`), `next_attempt_at`(`int64`), `created_at`(`int64`) | `change_id` |

- The `kind` column value is the kind name in snake_case. The expiry column of `game_state` is `expires_at`
- The column type notation is the column type of `register_table`
- `fail_code` is the number of the failure code that the apply function returned (`CoreError` from 1 to 999, `GameError` 1000 or more) when `fail_reason` is `rejected`, and 0 otherwise
- A module table name is `<module name with - replaced by _>_<name>`. e.g. `item_ledger_history`. A table not registered with `register_table` is not used
- `delete_user` deletes the rows of that user from the registered `user` scope tables and the `user` scope tables among the base tables, and writes the request time to `user.withdrawn_at`. The `user` row stays
- After `delete_user`, `take_response_delta` of that ctx returns an empty response delta
- `get_user_record` is none when there is no `user` row. When v is given, `scan_users` returns only users that have a row with contract version < v in `user_state` or `server_state`
- `sample_users` picks with one query, by secure random and without duplicates, up to the maximum count of users from the users that are not withdrawn users. When there are fewer users than the maximum count, all of them
- `set_user_created_at` changes `created_at` of the `user` row of the ctx user to that time. It makes no delta and no pending delta

### schema

- creating and changing registered tables: at server start, for each registered table, reads the row of the table name from `storage_schema`. When there is no row, creates the table and the registered indexes. When there is a row, adds the registered columns that are not in `definition` of the row. An added column is of a `?` type. Creates the registered indexes that are not in `definition` of the row. Indexes only in `definition` of the row are left as they are, and the server starts. When the columns only in `definition` of the row are all of a `?` type, they are left as they are, and the server starts. That server does not read or write those columns, and those columns of rows that server inserts are null. So a previous server can be started again after a server that added a `?` column. A non-`?` column only in `definition`, a column type change, a key column change and a scope change are server start failures. Writes, as JSON in `definition` of that row, the list merging the columns of the row and the registered columns, the key columns, and the list merging the indexes of the row and the registered indexes
- The creation of base tables and the core schema changes are applied at server start in the order contained in the core release, and the applied core schema version is written to `definition` of the `storage_schema` row whose `name` is `base`. When the core schema version of the `base` row is higher than the highest core schema version of that core release, nothing is changed and server start fails. The failure reason contains both versions
- The core schema version is an integer from 1 and increases by 1 per core schema change. The highest core schema version of a core release is kept in `open-game-works-core-impl/server/core/storage/core-schema-version` (one line with a decimal integer). The commit that adds a core schema change raises that value in the same commit, and `storage` does not read that file and keeps a constant equal to that value
- schema lock: server start does the base table creation, the core schema changes, and the creation and change of registered tables in one transaction, and at the start of that transaction takes the schema lock, one per DB. PostgreSQL calls `pg_advisory_xact_lock` with one constant of the core code as the key, and SQLite opens that transaction with `BEGIN IMMEDIATE`. When it waits more than `storage.schemaLockWaitMs`, server start fails. `storage_schema` is read after the lock is taken, and when there is no `storage_schema` table, the base tables are created first. When even one step fails, rolls back, and server start fails. So server instances started together on the same DB apply the schema one at a time, and a later instance reads the `storage_schema` that an earlier instance committed

### expiry

- expiry cleanup `sweep_expired`: a storage maintenance delete. It is neither a user transaction nor a game transaction, and takes neither the per-user lock nor the lock of `lock_game_row`. For each table given an expiry column, regardless of scope, deletes the rows with expiry column ≤ `server-time.clock_now` with one delete statement. The delete of one table is one DB transaction. Job `storage_sweep` of `routing` calls it
- `sweep_expired` can delete an expired row that a user transaction read, during that transaction. So a module that uses a table given an expiry column keeps the rules below
  - A row with expiry column ≤ `clock_now` counts as a row that does not exist, also before it is deleted
  - A write that creates a row or increments a counter does not write back the read value but uses one upsert statement, and the value after the write is read from that statement

### raw row

A raw row is the row format that the snapshot and the game state snapshot of `user-snapshot-clone` use: `table`, `key`, `contract_version`, `value`(bytes).

- target rows of `read_user_rows` and `replace_user_rows`: the rows of that user in `user_state`, `server_state`, and the `user` scope tables registered with snapshot flag `true`. `pending_delta` is not a target
- `user_state`, `server_state`: `key` is `<kind column value>/<item_id>`, and `contract_version` and `value` are the saved values as they are
- other tables: `key` is the JSON array of the key column values without `user_id`, `contract_version` is 0, and `value` is the bytes of the JSON object of all columns without `user_id`, written in UTF-8. In the JSON, `int64` is a decimal string and bytes are standard base64
- `read_user_rows` returns them in byte order of `table`, `key` and does not do the read conversion. Writes nothing
- `replace_user_rows` deletes all target rows of that user and saves the raw rows with that user ID. `contract_version` is kept as received. For a table that is not a target, or a `key` or `value` in a wrong format, throws and changes nothing. Makes no delta and deletes the pending delta
- `replace_user_rows` checks the raw rows of tables other than `user_state` and `server_state` against the currently registered columns. A `?` column not in `value` is saved as null. The following are format violations
  - `value` is not a JSON object, holds `user_id` or a column name that is not registered, or lacks one of the non-`?` columns
  - The JSON type of a column value differs from the column type. `int64` is a decimal integer string, `int32` a JSON integer, `bool` a JSON boolean, `string` a JSON string, and `bytes` a standard base64 string. A `?` column also accepts `null`
  - `key` differs from the JSON array of the key column values of `value` (except `user_id`) in key column order
- When the raw row list of `replace_user_rows` has two or more raw rows with the same `table` and `key`, it is a format violation
- raw row of `game_state`: `key` is `<kind column value>/<key>`, and `contract_version` and `value` are the saved values as they are
- `read_game_rows` returns the rows of the key list in that kind that are not expired, in byte order of `key`. Keys that do not exist are left out. Does not do the read conversion and writes nothing
- `sample_game_rows` picks, by secure random and without duplicates, up to the maximum count from the rows of that kind that are not expired, and returns them in byte order of `key`. When there are fewer rows than the maximum count, all of them. Does not do the read conversion and writes nothing
- `replace_game_rows` first takes, per raw row, in `key` byte order of the raw rows, the same lock as `lock_game_row`(`game_state`, `[game state kind, key]`). Exceeding the lock wait is `FAILED`, as for `lock_game_row` of a core module. Then, per raw row, deletes the `game_state` row of the same kind and key, and writes `contract_version` and `value` as received and `expires_at` as null. When `table` is not `game_state`, the kind of `key` is not a kind of `game_state.proto`, the key is not an integer of 0 or more, or two or more raw rows have the same `key`, throws and changes nothing

### DB adapter

- LOCAL is SQLite, and DEV·STG·PROD are PostgreSQL. As exceptions, a LOCAL instance that the runner starts with PostgreSQL is PostgreSQL, and the test server of `testing` uses the DB kind that `start_test_server` set. For LOCAL and the test server, the runner or `start_test_server` gives the DB location as a server start argument, and for the rest it is the secret that game settings `environments.<ENV>.secrets.db` points to
- The two adapters follow the same interface and keep the same transaction semantics
  - SQLite: the journal mode is WAL. On one write connection, opens each transaction with `BEGIN IMMEDIATE` and serializes all write transactions. `BEGIN IMMEDIATE` opens with busy timeout 0. When another server instance that opened the same file has a write transaction open, retries without blocking the thread and waits up to `storage.userLockWaitMs`, and beyond that, `FAILED`. As an exception, `BEGIN IMMEDIATE` of the schema step of server start is synchronous, so it blocks the thread and waits up to `storage.schemaLockWaitMs`. Meanwhile no other work of the server instance runs. `read_db` is a read connection separate from the write connection
  - PostgreSQL: `READ COMMITTED`, and at transaction start locks the `user` row with `SELECT ... FOR UPDATE`. `read_db` is a connection that has opened no transaction. The lock wait of a `read_db` query is up to `storage.userLockWaitMs`, and beyond that, a DB failure
  - The PostgreSQL adapter keeps, per server instance, up to `storage.dbMaxConnections` connections that open transactions, besides the `read_db` connection. When all are in use, a transaction waits for a free connection up to `storage.userLockWaitMs`. The wait for a free connection and the lock wait of that transaction together stay within `storage.userLockWaitMs` (the same for the autocommit statements of `sweep_expired`). Beyond that, `FAILED`
  - The PostgreSQL adapter waits up to `storage.dbAnswerWaitMs` for a connection and for the part of a statement's answer beyond the lock wait. As an exception, a statement inside the schema lock transaction of server start waits for that part up to `storage.schemaAnswerWaitMs`: index creation on a large table takes build time, not lock wait. Beyond that, closes that connection, and it is a DB connection failure. After that, until a background connection succeeds, the `read_db` queries, transaction starts, transaction statements and new connections of that server instance are DB connection failures without waiting. The background connection makes the first attempt right away, and the next attempt `storage.dbAnswerWaitMs` after the start of the previous attempt. Query and transaction functions are synchronous, so other work of the server instance stops during this wait
- Queries use only SQL that gives the same result in both DBs. Values are passed only as parameters
- Comparison (`=`, `<`, `>`) of `string` column values and `ORDER BY` are in UTF-8 byte order in both DBs. PostgreSQL creates `string` columns with `COLLATE "C"`, and SQLite uses the default collation `BINARY`
- `int64` values are saved with an integer type. Values of 2^53 or more also stay unchanged
- Saved values remain after a restart

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `gameplay_content` | the state of the game saved in UserState, server state and game state | `module` | `app_functionality` | `true` | `false` | `false` | `false` | `all` | `none` |

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| user change apply(handler hook) | row processing order step 1 | out-of-request ctx of the target user, sending user ID, payload | `pass` or failure code (`GameError`, `CoreError`) | none. Registration is required for the change name of `send_user_change` |
| user change fail(handler hook) | row processing order step 3 | out-of-request ctx of the sending user, target user ID, payload, failure reason (`rejected` and the failure code, `withdrawn`, `failed`) | none | none. Registration together with the apply function is required |

- The two functions are attached per change name with `register_user_change`. When the same name is registered twice, a name that breaks the rules is registered, or content registers outside `register`, the server does not start
- The apply function and fail function are called inside `with_hook_change_source`(that ctx, `UserChange`, `<change name>:<change_id>`). The change source of items that content changes inside it is source `UserChange`, ref `<change name>:<change_id>`
- The fail function gives back to the sending user what is to be returned (e.g. the sent items)

## event

none

## error

storage leaves no logs. It returns failures to the caller as a throw or a failure value, and for a request failure `routing` leaves the `error` log. The callers of `take_response_delta` and `read_full_state` record skipped unknown kind rows in the `request` log.

| condition | failure value | error code | log |
|---|---|---|---|
| misuse, random input violation | throw | `INTERNAL` | none |
| user lock wait exceeded, wait for the write transaction of another server instance on SQLite exceeded | `FAILED` | `INTERNAL` | none |
| nested transaction | throw | none | none |
| `FAILED` of the converter function | throw. The saved row does not change | none | none |
| a table of the same name registered twice, a table name that breaks the rules, a snapshot flag on a `game` scope table, a missing snapshot flag on a `user` scope table, a personal data user column not in the table, a key column, expiry column or index column not in the column list, an empty index, two indexes with the same column list, a `user` scope table whose first column is not `user_id`, a non-`?` column added to an existing table, a non-`?` column only in `definition`, a change of column type, key column or scope, a converter function registered twice, a core schema version of the `base` row higher than that of the core release, schema lock wait exceeded | server start failure | none | none |
| game row lock wait exceeded, PostgreSQL deadlock, serialization failure | `FAILED` | `INTERNAL` | none |
| `lock_game_row` wait exceeded or deadlock of a content handler or hook | throw | `INTERNAL` | none |
| change name registration error | server start failure | none | none |
| `FAILED` of a user change application, throw of the apply function or fail function | retries. After the maximum attempts, moves to the `fail` phase or deletes the row | none | none |
| DB connection failure | server start failure. `FAILED` while running | `INTERNAL` while running | none |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `storage.userLockWaitMs` | integer | core | content | maximum duration to wait for the per-user lock |
| `storage.dbMaxConnections` | integer | core | content | limit on the number of connections the PostgreSQL adapter uses for transactions in one server instance. 1 or more. Each queued request of one user holds one connection, so when it is small, one user starves other users. number of server instances × (this value + 1) must be below PostgreSQL `max_connections` |
| `storage.dbAnswerWaitMs` | integer | core | content | maximum duration to wait for a PostgreSQL connection and for the part of a statement answer beyond the lock wait. 1 or more |
| `storage.schemaLockWaitMs` | integer | core | content | maximum duration that server start waits for the schema lock |
| `storage.schemaAnswerWaitMs` | integer | core | content | maximum duration to wait for the part of a statement answer beyond the lock wait inside the schema lock transaction of server start. 1 or more |
| `storage.maxShuffleCount` | integer | core | content | largest n of `random_shuffle` |
| `storage.maxPublicReadCount` | integer | core | content | limit on the number of users in one `read_public_state` |
| `storage.maxGameStateList` | integer | core | content | upper bound of the maximum count of `list_game_state`. 1 or more |
| `storage.userChangeMaxBytes` | integer | core | content | maximum bytes of a user change payload |
| `storage.userChangeBatchSize` | integer | core | content | limit on the number of rows applied in one `run_user_changes` |
| `storage.userChangeRetryInitialMs` | integer | core | content | interval until the first retry of a user change |
| `storage.userChangeRetryFactorPermille` | integer | core | content | multiplier of the user change retry interval. permille |
| `storage.userChangeRetryMaxIntervalMs` | integer | core | content | largest user change retry interval |
| `storage.userChangeRetryMaxAttempts` | integer | core | content | maximum number of attempts in one phase of a user change. 1 or more |
| `environments.<ENV>.secrets.db` | string | game | none | name of the secret in the host secret store that holds the PostgreSQL connection string of DEV, STG, PROD |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_seed_provider` | function (request ID → seed or none) | none | a call after server start has begun throws | `testing` |
| `wait_after_commit` | none | async operation. none | none | `testing` |
| `open_pg_session` | PostgreSQL connection string | async operation. session: backend pid, `query` that receives SQL and parameters and runs them on that connection, `close` that closes the connection | a connection failure throws | `testing` |

- A request for which the provider returned a seed makes its random from that seed. When none, secure random
- `wait_after_commit` waits until all `after_commit` functions and user change applications started so far end
- `open_pg_session` opens one new connection with the same wire protocol implementation as the PostgreSQL adapter of storage. It is unrelated to the connection pool of the server instance and has no lock wait limit. Code outside storage does not connect to PostgreSQL through internal files of storage and uses this operation

## test

- On PostgreSQL, when 50 or more requests that several users send concurrently to the test server and its two peers lock the same `game_state` row with `lock_game_row`, read it and add 1, each request ends with a response or with the `GameError` that the handler returned, the value of the row is the number of accepted requests, and the values that the accepted requests locked and read are each value from 0 to the accepted count − 1 once. Writes of requests that ended with `GameError` do not remain
- On PostgreSQL, when 50 or more requests that several users send concurrently to the test server and a peer process lock the same `game_state` row with `lock_game_row`, read it and add 1, each request ends with a response or with the `GameError` that the handler returned, and the value of the row is the number of accepted requests
- On PostgreSQL, a transaction that waited for a free connection is `FAILED` when that wait and the lock wait together exceed `storage.userLockWaitMs`. The same for the statements of `sweep_expired`
- On PostgreSQL, even when a statement inside the schema lock transaction of server start does not answer for longer than `storage.dbAnswerWaitMs`, server start succeeds when it answers within `storage.schemaAnswerWaitMs`, and the statements of later requests wait with `storage.dbAnswerWaitMs`
- Even when `stop()` is called while an `after_commit` function registered earlier in a committed transaction is still running, the `on_commit` function of that transaction was called once at commit. The `on_commit` function of a rolled-back transaction is not called
- Two concurrent requests of the same user are handled one after another, and the result equals the value of applying the two requests one after another
- After a `GameError` and an exception of the handler, `user_state`, `server_state` and `pending_delta` equal those before the request
- A value written inside a transaction is read in the same transaction
- `read_db` does not see rows of another transaction before commit and sees them after commit. A write with the `read_db` handle throws
- The delta equals the difference of the saved values before and after the transaction, including the cases of write then delete, delete then write, and writing the same value
- A server state kind change is not in the delta
- An out-of-request change accumulates as a pending delta, is carried in the next success response and is then deleted. After an error response it remains
- `ItemChange` and `ItemMail` of two out-of-request changes are carried in `item_changes` and `item_mails` of the next success response in order number order, before those of that request
- When the function of `run_request_transaction` returns `CoreError`, no writes remain. For a user ID without a `user` row and for a withdrawn user, the function is not called and the result is `WITHDRAWN`
- A UserState write and `add_item_change` after `take_response_delta` throw
- `read_full_state` of a user with accumulated pending `ItemChange` and `ItemMail` returns those lists in accumulation order and deletes them together with the pending delta rows
- `take_response_delta` of a ctx that called `read_full_state` carries that delta with `full` `true`, an empty `pending_user_state`, and the `ItemChange` and `ItemMail` lists that `read_full_state` returned, and a UserState write on that ctx after `read_full_state` throws
- For a user with a `user_state` row of a kind not in the current contract and a pending delta row whose `items` holds an item of that kind, `read_full_state` and `take_response_delta` make the delta without that kind and return that `kind` column value, that `user_state` row remains, and `read_user_rows` includes that row
- An out-of-request change started during request handling of the same user is applied after that request commits
- `run_user_transaction` of a withdrawn user and of a user ID without a `user` row is `WITHDRAWN` and makes no rows
- Writes of a `run_rollback_transaction` function do not remain after it ends, and there is no pending delta either
- A nested user transaction throws
- Each kind of misuse throws, and the request is `INTERNAL`
- A core kind write by content and a write of a kind that is not a core kind by an owner module are rejected
- After `GameError` or `CoreError` of a `run_savepoint` function, only the changes inside the savepoint are reverted, and the earlier changes and the transaction remain. The delta has no reverted item
- A write inside a `run_read_only` function throws, for ctx and for game tx each
- When two user transactions lock the same game row with `lock_game_row`, they are handled one after another, and exceeding the wait is `FAILED`
- When a game transaction locks a row that another game transaction locked with `lock_game_row`, it is handled after the earlier transaction ends
- When two user transactions lock a key without a row with `lock_game_row`, they are handled one after another
- On PostgreSQL, when `storage.dbMaxConnections` + 1 transactions of users that another transaction locked are opened concurrently, the transaction connections do not exceed `storage.dbMaxConnections`, and a transaction that does not get a connection within `storage.userLockWaitMs` is `FAILED`
- On PostgreSQL, when two user transactions lock two game rows with `lock_game_row` in opposite orders, one is `FAILED` and its writes do not remain, and the other is committed
- `read_user_rows` includes only the rows of tables with snapshot flag `true` and of `user_state` and `server_state`, and does not change saved rows. After `replace_user_rows`, `read_user_rows` equals the raw rows put in
- `replace_user_rows` saves a `?` column not in `value` as null. A column that is not registered, a missing non-`?` column, a JSON value that differs from the column type, a raw row whose `key` differs from `value`, and two raw rows with the same `table` and `key` throw, and the rows of that user do not change
- `read_game_rows` returns the saved bytes and contract version as they are and does not change rows. After `replace_game_rows`, `read_game_rows` of the same keys equals the raw rows put in. When even one raw row has a wrong format or two raw rows have the same `key`, throws and no row changes
- `replace_game_rows` of a `game_state` row that a user transaction locked with `lock_game_row` and read writes after that transaction ends. `put_game_state` written with the value that transaction read does not overwrite the value of `replace_game_rows`
- `sample_game_rows` returns only rows of that kind that are not expired, without duplicates, up to the maximum count, and returns all of them when there are fewer rows than the maximum count. It does not change rows
- After `upgrade_user_rows`, all rows of that user are at the current contract version
- `scan_users` does not return withdrawn users, and when v is given, returns only users that have a row of a lower version
- `sample_users` does not return withdrawn users, returns up to the maximum count without duplicates, and returns all of them when there are fewer users than the maximum count
- After `delete_user`, the registered `user` scope tables have no rows of that user, and `user.withdrawn_at` is set
- After `set_user_created_at`, `created_at` of `get_user_record` is that time, and there is no delta and no pending delta
- `export_user_rows` returns, from the `user` and `game` scope tables given a personal data user column, only the rows in which that column is that user, and has no rows of tables not given the column
- Reading a row of a lower version saves the converted value and the current contract version, and with a delete result the item is deleted. With `FAILED`, the row does not change
- When one transaction locks a `game_state` row of a lower version with `lock_game_row` and writes a new value, and before it commits another transaction reads that row with `get_game_state` without locking, after both transactions end the row has the value that the locking transaction wrote and the current contract version
- Random operations with the same seed produce the same sequence, equal to the test vector of `UtilCore`. A random input violation throws
- 6 calls of `random_u32` on a random instance made with `create_random`(42) equal the seed `42` `next_uint32` row of the `UtilCore` test vector, `random_shuffle`(10) of a newly made `create_random`(42) equals the seed `42` `shuffle_indices(10)` row of the test vector, and `make_purpose_seed` equals the two `make_purpose_seed` rows of the test vector
- ctx `hook_change_source` inside `with_hook_change_source` is the passed value, the outer value when the inner range ends, and none when all end
- An operation called with the ctx of an ended transaction throws, and the saved state does not change
- A row whose expiry column has passed is deleted by the cleanup
- `sweep_expired` deletes the expired rows of `user` scope tables and `game` scope tables without the per-user lock. A row written with upsert on a key where an expired row remains has the new value, and `sweep_expired` does not delete that row afterwards
- A table is created with the registered columns and key columns. On restart with a definition that adds one `?` column, that column of existing rows is null. On a later restart with the previous definition without that column, the server starts, the values of that column in existing rows stay unchanged, and that column of newly inserted rows is null. With a definition that removes a non-`?` column and with a definition that changes a column type, the server does not start
- `check_hook_output` returns `pass` and 1000 for `'pass'` and 1000, and throws for 999, 1.5, `null` and `'ok'`
- On SQLite and PostgreSQL, reading the rows with `string` column `B`, `a`, `é`, `가` with `ORDER BY` gives this order, and a `>=` condition with parameter `a` selects `a`, `é`, `가`
- An index given to `register_table` exists in SQLite and PostgreSQL with that name and column order. On restart with a definition that adds one index, that index is created, and on restart with the previous definition without that index, the server also starts and the index remains. With an index on a column not in the column list, an empty index, or two indexes with the same column list, the server does not start
- With a DB whose `base` row has a core schema version higher than the highest core schema version of the core release, the server does not start and the `base` row stays unchanged
- The value of `open-game-works-core-impl/server/core/storage/core-schema-version` equals the highest core schema version that `storage` applies
- When `start` of two server instances that `routing.create_server` made is called together on the same empty DB, both start, there is one of each base table and registered table, and the rows of `storage_schema` equal the registered definitions. Also when one instance starts together with a definition that adds one `?` column, both start and that column is added once
- An `int64` value larger than 2^53 is read back unchanged after save
- Saved values remain after a restart
- Functions registered with `after_commit` are called once each in registration order after commit. Functions registered in a rolled-back transaction, in `run_rollback_transaction` or in a reverted savepoint are not called. Even when a function throws, the commit result and the next function are unaffected
- Reading a row of a lower version inside a `run_read_only` function returns the converted value, and the saved row, contract version, delta and pending delta do not change
- `read_public_state` returns public kinds of another user as committed values, and throws for a kind that is not a public kind and for a user ID count over the limit. Withdrawn users and users without a value are left out, and the saved rows and the delta stay unchanged
- A row that the transaction of one user wrote with `put_game_state` is read by the transaction of another user. When two user transactions lock the same game state row with `lock_game_row` and each add 1, it rises by 2
- For a game state row past its expiry time, `get_game_state` is none, and the expiry cleanup deletes it. Game state changes are not in the delta
- `lock_game_row` that a content handler called with a table other than `game_state` throws
- When the request that called `send_user_change` commits, the apply function is called once for the target user and a pending delta of the target user is made. When the sending request rolls back, the apply function is not called
- When the apply function returns `GameError`, no changes of the target user remain, and the fail function is called once with `rejected` and that code. When the target user is a withdrawn user, the fail function is called with `withdrawn`. When the sending user is also a withdrawn user, only the row is deleted
- Even when there are more than `storage.userChangeBatchSize` rows with `phase` `apply` and `fail` of names that are not registered, `run_user_changes` does not change or delete those rows, and applies the rows of registered names after them
- Even when the server instance stops after commit and before application, the next `run_user_changes` applies the change. Even when two server instances apply the same row, the apply function returns `pass` only once
- When an application is `FAILED`, it is retried at the retry intervals, and after `storage.userChangeRetryMaxAttempts` attempts the fail function is called with `failed`
- `next_attempt_at` of the row of `send_user_change` called by a user with a cheat time offset is `clock_now`, and `next_attempt_at` after an application that is `FAILED` is `clock_now` + `storage.userChangeRetryInitialMs`
- `send_user_change` with a change name that is not registered, a target that is the user's own user ID, or a payload over the limit throws
- The `ItemChange` source of an item that content changed inside the apply function is `UserChange`, and ref is `<change name>:<change_id>`
- When the converter function returns bytes for a row of a contract version higher than the current one, that value is read, and the saved row and contract version stay unchanged
