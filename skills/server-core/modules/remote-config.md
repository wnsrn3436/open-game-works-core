# remote-config

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

Handles config values and feature flags that the operator changes without a data patch, and the experiment group of each user. Keys, types and default values are declared in data, and the operator overrides values or opens experiments with admin operations.

## dependency

- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_config` | ctx, key ID value | `RemoteConfigValue` | Throws on an unknown key ID value | content handler, hook |
| `get_client_config` | ctx | `entries` (`RemoteConfigEntry` list of every key whose `client` is `true`), `assignments` (`ExperimentAssignment` list) | none | `auth` |
| `GetRemoteConfig` (core rpc, `silent`). changes: none | none | `entries`, `assignments`. The result of `get_client_config` | none | `routing`. Client `RemoteConfigCore` sends it |

- A key ID value is an ID value of the `remote_config_key` table. Content code gets it with a reserved ID accessor
- `RemoteConfigValue` (base proto message): `RemoteConfigValueKind kind`, `bool bool_value`, `int64 int_value`, `string string_value`. Only the field of `kind` has a value
- `RemoteConfigValueKind` (base proto enum): `REMOTE_CONFIG_VALUE_KIND_UNSPECIFIED`, `BOOL`, `INT`, `STRING`. Their names correspond, in this order, to `Bool`, `Int` and `String` of data enum `RemoteConfigType`. The server and the client compare the key's `type` with `kind` by this correspondence
- `RemoteConfigEntry` (base proto message): `int32 key_id`, `RemoteConfigValue value`
- `ExperimentAssignment` (base proto message): `int32 experiment_id` (ID value of the `experiment` table), `string group`

core `rpc` response field

| message | field | type |
|---|---|---|
| `GetRemoteConfigResponse` | `entries` | `repeated RemoteConfigEntry` |
| `GetRemoteConfigResponse` | `assignments` | `repeated ExperimentAssignment` |

admin operation. `routing` collects them and passes them to `admin-api`; the processing order, authentication, `operation_id` rules and `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_config_value` | `key_id`, `value` | empty object | `not_found`, `bad_request` | operator |
| `clear_config_value` | `key_id` | empty object | `not_found` | operator |
| `put_experiment` | `operation_id`, `experiment_id`, `salt`, `start_at`, `end_at`, `key_ids`, `groups` | `experiment_id` | `not_found`, `bad_request`, `conflict` | operator |
| `stop_experiment` | `experiment_id` | empty object | `not_found` | operator |
| `list_remote_config` | none | `overrides`, `experiments` | none | operator |

- `key_id`: ID value of `remote_config_key`. `not_found` when it does not exist
- `value`: JSON value. When the type is `Bool`, a bool; when `Int`, an integer (an `int64` decimal string is also accepted); when `String`, a string of at most `remote-config.maxStringBytes`. When it is wrong, `bad_request`
- `experiment_id`: ID value of the `experiment` table. `not_found` when it does not exist. When an experiment with that ID value already exists, replaces it entirely and writes `false` to `stopped`
- `salt`: a non-empty string. Changing it changes the group assignment
- `key_ids`: `key_id` list. 1 or more, no duplicates
- `groups`: `(name, weight, values)` list. 2 or more and at most `remote-config.maxGroups`. `name` is unique within the experiment, `weight` is an integer of 1 or more, and `values` are values in the same order and number as `key_ids`. Each value follows the `value` rules
- `start_at` < `end_at`. When another experiment not stopped with `stop_experiment` overlaps in both period and key, `conflict`. A stored experiment that is not in the `experiment` table is excluded from the overlap check. Before the overlap check, locks key 0 of `remote_config_experiment` with `storage.lock_game_row` in the game tx that `admin-api` opened. Experiment ID values are 1 or more, so there is no row with key 0. So the overlap checks and writes of concurrently called `put_experiment` are handled one at a time
- field type: `key_id` and `experiment_id` are `int32`, `value` is `json`, `salt` is `string`, `key_ids` is `array<int32>`, and `groups` is `array<object{name: string, weight: int32, values: array<json>}>`
- `overrides` of `list_remote_config` is the row list of the `remote_config_override` table, and `experiments` is the row list of the `remote_config_experiment` table. Keys are ID values. The values of `value` and `groups` are JSON values
- `stop_experiment` is `not_found` for an `experiment_id` that is not in the `experiment` table or has no saved experiment

## behavior

value selection. The value of one key is the first one decided in the following order.

1. When an experiment that has that key is active, the value of the group that the user is assigned to. When two or more active experiments have that key, the value of the experiment with the smallest `experiment_id`
2. The value overridden with `set_config_value`
3. `default_value` of `remote_config_key`

- An experiment is active when `start_at` ≤ request time < `end_at` and it has not been stopped with `stop_experiment`. The request time is `server-time.now`
- group assignment: reads the first 8 bytes of `SHA-256(<salt> ":" <user ID decimal string>)` as a big-endian unsigned integer h, and r = h mod (sum of weights). Accumulating the weights in `groups` order, it is the first group where r < the cumulative sum. The same user, the same salt and the same `groups` always give the same group
- Within one request, the same key has the same value. The cache used is the one at the time the transaction is opened
- `assignments` of `get_client_config` contains only the active experiments that have one or more keys whose `client` is `true`

storage and cache

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `remote_config_override` | `game` | `key_id`, `value`, `updated_at` | `key_id` | none |
| `remote_config_experiment` | `game` | `experiment_id`, `salt`, `start_at`, `end_at`, `key_ids`, `groups`, `stopped`, `updated_at` | `experiment_id` | none |

- Each server instance caches the two tables in memory. Job `remote_config_cache` (period `remote-config.cacheMs`), which remote-config registered with `server-time.schedule_job` at server start, reads them again. The server instance that made a change updates its own cache right away
- Overrides and experiment values of keys deleted from data, and experiments deleted from the `experiment` table, are not used. At server start, leaves one `warn` log line per such key and experiment
- When the type of a key in data changed and a saved value does not match it, that saved value is not used and the value is chosen by the next order of value selection. Leaves a `warn` log at server start

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| unknown key ID value in `get_config` | throw | `INTERNAL` | `error` log by `routing` |
| admin input rule violation | `bad_request` | none | `audit` |
| key or experiment that does not exist | `not_found` | none | `audit` |
| period and key overlap with an experiment not stopped with `stop_experiment` | `conflict` | none | `audit` |
| deleted key and experiment, saved value whose type does not match | the saved value is not used | none | `warn` log |
| `default_value` of a `String` key exceeding `remote-config.maxStringBytes` | server start failure | none | `error` log |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `remote-config.maxStringBytes` | integer | core | content | byte limit of a `String` value |
| `remote-config.maxGroups` | integer | core | content | limit on the number of groups of one experiment. 2 or more |
| `remote-config.cacheMs` | integer | core | content | interval for reading the override and experiment cache again. 1 or more |

## data

`data/tables/remote_config_key.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `type` | `enum<RemoteConfigType>` | `All` |
| `default_value` | `string` | `All` |
| `client` | `bool` | `All` |

- `default_value` is read by `type`: `Bool` is `true` or `false`, `Int` is a `long` integer, and `String` is a string. A violation is data check `value_type`. When the `default_value` of a `String` key exceeds `remote-config.maxStringBytes`, the server does not start
- Only keys whose `client` is `true` are sent to the client. A row whose `client` is `false` goes only into build target `Server` and is not in client data. A value that the client must not know (e.g. a judgement criterion value) gets `false`

`data/tables/experiment.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |

- One experiment is one row. Content code gets the experiment ID value with a reserved ID accessor. The operator passes that ID value as `experiment_id` of `put_experiment`

`data/enums.csv`

| type | element |
|---|---|
| `RemoteConfigType` | `Bool`, `Int`, `String` |

## DEV

none

## test

- When there is neither an override nor an experiment, returns `default_value`
- After `set_config_value`, every server instance returns the new value within `remote-config.cacheMs`, and after `clear_config_value`, `default_value`
- An active experiment takes precedence over an override. Outside the period and after `stop_experiment`, it is the override or `default_value`
- The group assignment for the same user and the same salt is the same regardless of server instance and restart
- For each case of core test fixture `remote-config-group`, the group assignment equals the expected value. `input` is `{"salt": <string>, "groups": [{"name": <string>, "weight": <integer>}, ...], "user_ids": [<user ID>, ...]}`, and `expected` is `{"group_by_user": {"<user ID>": "<group name>", ...}, "count_by_group": {"<group name>": <number of users among user IDs from 1 to 10000 assigned to that group>, ...}}`. `group_by_user` has one entry per user ID of `user_ids`
- A `value` of the wrong type, and `groups` whose number of `values` differs from `key_ids`, are `bad_request`
- `put_experiment` that overlaps in period and key with an experiment not stopped with `stop_experiment` is `conflict`
- When two `put_experiment` calls with different `experiment_id` and `operation_id` that overlap in period and key are sent concurrently, only one succeeds and the other is `conflict`
- `put_experiment` that overlaps in period and key with an experiment stopped with `stop_experiment` succeeds. When an experiment stopped with `stop_experiment` is replaced by `put_experiment` with the same `experiment_id`, it is active again within its period
- When `set_config_value`, `clear_config_value` or `put_experiment` receives a key ID value not in `remote_config_key`, `not_found`
- A key whose `client` is `false` is not in the `GetRemoteConfig` and `Login` responses
- The client data that the data tool made has no `remote_config_key` row whose `client` is `false`, and the server data has it
- For each entry of the `GetRemoteConfig` and `Login` responses, `value.kind` is the value that corresponds to that key's `type`, and only that field has a value
- Within one request, the value of the same key stays the same even when the cache changes
- An override of a deleted key is not used, and a `warn` log is left
- `put_experiment` with an `experiment_id` not in the `experiment` table is `not_found`
- The `experiment_id` of `assignments` in the `GetRemoteConfig` and `Login` responses is an ID value of the `experiment` table
