# RemoteConfigCore

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

Receives and keeps the config values, feature flags and experiment assignments that server core `remote-config` chose, through the login response and core `rpc` `GetRemoteConfig`, and gives typed getters with the type and default value declared in data.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `NetworkCore`, `AuthCore`

- server dependency: `remote-config`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_bool` | key ID value | value | `default_value` of that key. `false` for an unknown key | core, content code |
| `get_int` | key ID value | value (int64) | `default_value` of that key. `0` for an unknown key | core, content code |
| `get_string` | key ID value | value | `default_value` of that key. Empty string for an unknown key | core, content code |
| `get_group` | experiment ID value | assigned group name | empty string | content code |
| `has_received` | none | whether server values were received at least once in this boot | `false` | content code |
| `refresh` | none | async operation. success flag | `false` | content code |

- key ID value is an ID value of the `remote_config_key` table. Content code gets it through a reserved ID accessor
- experiment ID value is an ID value of the `experiment` table that server core `remote-config` defines. Content code gets it through a reserved ID accessor

## behavior

### value

- value selection: the value of that key when the received entries have it; otherwise `default_value` of `remote_config_key` read as `type`
- Before server values are received (before login, title scene), every getter gives `default_value`
- When the getter's type differs from that key's `type`, it is a type mismatch
- Getters do not allocate memory. `get_string` returns the kept string
- Content code decides when to read again after a value changes. It does not change the rules of a round in progress (battle, stage) midway

### fetch

- login: on receiving `AuthCore.LoginCompletedEvent`, applies the entry list and assignment list of `AuthCore.get_login_remote_config`
- `refresh`: sends `GetRemoteConfig` with `NetworkCore.send`. On success, applies `entries` and `assignments` of the response. When a `refresh` is in progress, it does not send a new one and waits for that result together
- automatic refresh: on receiving `AppForegroundReturnedEvent`, when logged in and the elapsed time since the last apply is at least `RemoteConfigCore.refreshIntervalMs`, runs `refresh`. The elapsed time is the real elapsed time since the last apply plus all `background_ms` of `AppForegroundReturnedEvent` received after it
- apply: replaces entries and assignments as a whole with the received lists. The received lists are not deltas
  - An entry whose `key_id` is not in `remote_config_key` is discarded (when the server uses new data)
  - An entry whose `value.kind` is not the `RemoteConfigValueKind` that corresponds to that key's `type` is discarded. Server core `remote-config` defines the correspondence
  - When the same `key_id` comes twice, the first entry is used
- When at least one key's value changed by the apply (new value compared with previous value. The previous value is `default_value` before anything is received), raises `RemoteConfigChangedEvent` once. It also raises it when only assignments changed

### release

- Ends the `refresh` in progress as a failure and deletes the received entries and assignments. After `init` again, every getter gives `default_value`. Received values are not saved on the device

## hook

none

## event

| event | when | payload |
|---|---|---|
| `RemoteConfigChangedEvent` | after an apply changed a value or an assignment | none. New values are read with getters |

## error

| condition | failure value | log |
|---|---|---|
| getter with a key ID value not in `remote_config_key` | the unknown key value of the API table | error once per key until `release` |
| getter type differs from the key `type` | same as the unknown key value | error once per key until `release` |
| `key_id` of a received entry is not in the table | entry discarded | warn once per key until `release` |
| `value.kind` of a received entry does not correspond to the key `type`, the same `key_id` twice | entry discarded | error |
| `refresh` before login | `false`. No request is sent | warn |
| `GetRemoteConfig` failure | `false`. Values unchanged | `NetworkCore` leaves it |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `RemoteConfigCore.refreshIntervalMs` | integer | core | content | minimum duration since the last apply for automatic refresh on background return |

## data

used table: `remote_config_key`, `experiment`

- `remote_config_key` table, `experiment` table and enum `RemoteConfigType`. Server core `remote-config` defines the headers. The client receives only keys whose `client` is `true`. Client data has only rows whose `client` is `true`, so a getter for a key whose `client` is `false` is a getter for a key not in `remote_config_key`

## DEV

none

## test

- Before login a getter gives `default_value`, and after `LoginCompletedEvent` it gives the entry value of the login response
- A key without an entry gives `default_value`. A key missing from the list after an apply returns to `default_value`
- An entry with a `key_id` not in the table or with a `value.kind` that does not correspond to the key `type` is discarded and the other entries are applied. When the same `key_id` comes twice, the first value is used
- `RemoteConfigChangedEvent` comes once only for an apply that changed a value, and not when the same list is applied again
- Two concurrent `refresh` calls make one request. A failed `refresh` does not change values
- A background return after `refreshIntervalMs` has passed sends `GetRemoteConfig`, and one before that does not
- Even when the real elapsed time since the last apply is less than `refreshIntervalMs`, a background return sends `GetRemoteConfig` when that time plus the background elapsed time after it is at least `refreshIntervalMs`
- A wrong getter type gives the unknown key value and one error log
- `get_group` returns the group name of the assignment, and an empty string for an experiment ID value without an assignment
- After `release` and `init`, getters give `default_value`
