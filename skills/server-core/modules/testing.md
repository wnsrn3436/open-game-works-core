# testing

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

Provides the test helper that server regression tests, server core tests and the content's populate use. The test helper starts isolated test servers, sends requests as real HTTP requests, and sets the time, the random seed and the fake adapters.

## dependency

- `routing`
- `auth`
- `session`
- `storage`
- `server-time`
- `logging`
- `cheat`
- `item-ledger`
- `game-update`
- optional dependency: `iap`, `ranking`, `tutorial`, `push`, `matchmaker`, `p2p-signaling`, `migration`, `attendance`, `offer`, `ads-reward`, `rating`

## API

none

## behavior

- The whole `testing` module is DEV code. Its code is in `server/core/testing/dev/` and is not included in STG and PROD builds
- `server/core/testing/dev/index.ts` exports each operation of the `## DEV` table under its operation name, and exports `StartFailure`. An operation receives the inputs of its `input` cell as positional arguments in that order, and an optional input that is not given is `undefined` in its position
- Server regression tests and the content's populate use only the operations of the test helper. They do not change core's private fields, DB connections, clock or random functions directly, and do not use files, environment variables, the network or the system clock directly. They get fixtures and data through the test helper
- In addition to the test helper, server core tests call `routing.create_server`, the `start`, `stop`, `modules` and `dev` of that server instance, and the operations of `## API` and `## DEV` of module specs

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| the server start job run of a LOCAL test server does not end within `testing.backgroundWaitTimeoutMs` | throw. Stops the instance and deletes the temporary folder and DB, as for a start failure | none |
| test server start failure | Cleans up the created temporary DB, temporary folder and port, and throws. When the cleanup fails, adds that failure to the `message` of `StartFailure` and throws | none |
| failure of the instance stop or the DB deletion in `stop_test_server` | Throws after doing the rest of the cleanup | none |
| fixture path violation, size exceeded, nonexistent shared fixture, nonexistent core test fixture | throw. That test fails | none |
| an operation called with a stopped test server | throw. That test fails | none |
| a settings override with a nonexistent key or a different type | throw. That test fails | none |
| `connect_server` connection failure, an operation or a `send` argument that the remote test server does not accept | throw | none |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `testing.maxFixtureBytes` | integer | core | human | maximum bytes of a fixture file |
| `testing.backgroundWaitTimeoutMs` | integer | core | human | maximum wait duration of `wait_background` |
| `testing.defaultStartAt` | integer | core | human | first clock of a test server started without a start time. Unix ms |
| `environments.<ENV>.adapters` | object | game | none | adapter names per environment. A `STG` test server treats it as an empty object |
| `environments.<ENV>.updatePublicKeys` | array<string> | game | none | list of public keys for deploy list signature verification. A `STG` test server treats it as the one public key of a new signing key |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `start_test_server` | start time (optional), DB kind (optional. `sqlite`, `postgresql`), environment (optional. `LOCAL`, `STG`), matchmaker flag (optional), real adapter list (optional. a real adapter or sandbox adapter name per adapter key), settings overrides (optional. a value per core settings key or game settings path), content registration function `register` (optional), `registerDev` (optional), server module list (optional), server build data folder (optional) | async operation. test server | a start failure throws | test |
| `stop_test_server` | test server | async operation. none | none | test |
| `restart_test_server` | test server, content registration function `register` (optional), `registerDev` (optional) | async operation. the test server switched to a new server instance | a start failure throws | test |
| `start_peer_server` | test server | async operation. a new test server that uses the same DB (peer) | a start failure throws | test |
| `login` | test server, dev account name | async operation. test session | a failure throws | test, the content's populate |
| `send` | test session, request name of a game `rpc` or core `rpc`, request message, request ID (optional), timestamp (optional), seed (optional), header overrides (optional), raw body (optional) | async operation. `ResponseEnvelope` and the decoded response message | none | test, the content's populate |
| `send_cheat` | test session, request name of the cheat, cheat request message | async operation. `ResponseEnvelope` and the decoded response message | none | test, the content's populate |
| `connect_server` | server URL, server build data folder, dev access value | async operation. remote test server | throws when it cannot connect | runner |
| `send_raw` | test server, HTTP method, path, header, body | async operation. HTTP status, header, body | none | test |
| `read_user_state` | test server, user ID | async operation. all committed UserState of that user | none | test |
| `read_server_state` | test server, user ID | async operation. all committed server state of that user | none | test |
| `set_time` | test server, Unix ms | none | none | test |
| `advance_time` | test server, ms | none | a negative value throws | test |
| `fake` | test server, service name | fake adapter controller | an unknown service throws | test |
| `set_key_source` | test server, adapter key, the value the key source returns (the public key list or root certificate of the module spec that defines that adapter) or a failure condition (time limit exceeded, communication failure) | none | an adapter key not in the real adapter list throws | test |
| `wait_background` | test server | async operation. none | a timeout throws | test |
| `hold_game_row_lock` | test server, table name, key value | async operation. an async function that releases the held lock | none | test |
| `start_peer_process` | a PostgreSQL LOCAL test server without a real adapter list, the module export that makes the content registration function (`{module: <module URL>, name: <export name>}`) | async operation. peer process: `remote` that sends requests, `reached` and `open` of the gates, `stop` | a test server with a real adapter list, and a start failure, throw | server core test |
| `stop_peer_processes` | none | async operation. none | none | server core test |
| `hold_db` | PostgreSQL test server or PostgreSQL connection string, SQL and parameter list | async operation. holder: the backend pid of the connection that opened the transaction, `release` that ends that transaction | a DB failure throws | server core test |
| `hold_lock_key` | PostgreSQL test server or PostgreSQL connection string, int64 key | async operation. holder | a DB failure throws | server core test |
| `until_blocked_by` | PostgreSQL test server or PostgreSQL connection string, backend pid, count (optional, default 1) | async operation. none | a timeout throws | server core test |
| `game_row_lock_id` | table name, key value | the int64 key of the transaction advisory lock that `storage.lock_game_row` takes on that row. Passed to `hold_lock_key` | none | server core test |
| `gates_of` | gate folder, a function that returns whether the process waiting at the gates is alive, the name of that process | `reached` and `open` of the gates | none | server core test |
| `wait_at_gate` | gate folder, gate name, note (optional) | none. Marks the gate as reached and blocks the thread until that gate opens | none | server core test |
| `start_http2_test_server` | a function that decides the answer per request (received request → status and body) | async operation. HTTP/2 test server: `origin` (`https://localhost:<port>`), list of received requests (ALPN protocol, header, body), `close` | none | server core test |
| `http1_connect` | origin | async operation. the result of a TLS connection that offers only HTTP/1.1 through ALPN: `connected` or the error code of the refused connection | none | server core test |
| `load_data` | none | the container and accessors of the server build data, the server DEV accessor of the data tool | none | test |
| `read_fixture` | relative path | file bytes | a violation throws | test |
| `read_shared_fixture` | shared formula name | bytes of `<name>.json` in the shared fixture folder | a nonexistent file or a name that violates the format throws | test |
| `read_core_fixture` | core test fixture name | bytes of `<name>.json` in the core fixture folder | a nonexistent file, a name that violates the format, or a run without a core fixture folder throws | test |
| `non_integer_values` | none | list of values for checking that integer fields reject them | none | test |
| `read_logs` | test server, kind (optional), level (optional) | list of the log lines that the log line writer of that test server received | none | test |
| `call_dev` | test server, module name, operation name, input, user ID (optional) | async operation. the output or failure value of that operation | an operation outside the list, and the cases where `dev` of `routing` throws, throw | test |
| `send_admin` | test server, admin operation name, JSON body or binary body and query, operator name (optional), admin secret override (optional) | async operation. HTTP status, header, response body | none | test |
| `connect` | test server | async operation. WebSocket connection | throws when it cannot connect | test |
| `send_frame` | WebSocket connection, `MatchmakerFrame` or raw bytes | none | a closed connection throws | test |
| `read_frame` | WebSocket connection, maximum wait ms | async operation. the received `MatchmakerFrame` or the connection end | a timeout throws | test |
| `close` | WebSocket connection | none | none | test |
| `core_test_register` | the `core` that the content registration function received, list of `service Game` `rpc` names not to register (optional) | none | none | server core test |
| `core_test_register_dev` | the `core` that the content registration function received | none | none | server core test |
| `new_core_test_server_input` | DB kind (optional. `sqlite`, `postgresql`. `OGW_DEFAULT_DB` when not given) | async operation. the server start input of a core test that calls `routing.create_server` directly: that DB kind, a new test DB and its connection, secret values, core settings defaults, server module list, server build data folder, `core_test_register` and `core_test_register_dev`, server root, `drop` that deletes that DB | a DB failure throws | server core test |
| `core_test_server_paths` | none | the part of the server start input that does not create a DB: core settings defaults, server module list, server build data folder, server root | none | server core test |
| `db_kind_of` | test server | the DB kind of that test server (`sqlite`, `postgresql`) | none | server core test |
| `default_db_kind` | none | the default DB kind of this run (`OGW_DEFAULT_DB`). Does not create a DB | none | server core test |
| `register_false_judges` | the `core` that the content registration function received | none | none | server core test |
| `register_required_hooks` | the `core` that the content registration function received, list of excluded hooks (optional. `<module>.<hook>` strings) | none | none | server core test |

- test session: holds the user ID, access token, login token and session signing key
- `start_test_server`, `restart_test_server` and `start_peer_server` throw `StartFailure` on a start failure. `StartFailure` is a subclass of `Error`; its `message` holds the reason of the server start failure, and its field `logs` is the list of objects read as JSON from the log lines that the log line writer of that server instance received
- peer process: a separate process that starts `routing.create_server` with the test server's DB, secret file, settings, server module list, server build data, and a test clock at that test server's time. It does not accept a test server with a real adapter list: the key source set with `set_key_source` does not reach another process. The peer process creates a new fake adapter per fake adapter key of the test server: results and failure conditions set with the test server's `fake` controller do not reach the peer process, and fake adapter calls of the peer process are not recorded in that controller's `calls()`. It is used to make one request hold a transaction and a lock and wait without blocking the thread of the test process. That export is a function that receives a peer context and returns the content registration function. `wait(gate name, note(optional))` of the peer context calls `wait_at_gate` at that gate in the peer process folder, and `modules()` is `modules()` of the peer process server instance. So the content registration function can mark a gate as reached inside a hook and wait until the test opens that gate. A test file calls `stop_peer_processes` at the end of each test
- `hold_db` opens a transaction on a connection opened with `storage.open_pg_session`, runs the SQL in order, and leaves the transaction open. `hold_lock_key` is a `hold_db` that takes the transaction advisory lock of that key. Given a connection string, they open on that DB instead of the test server: core tests that create a server instance on a test DB without a test server (e.g. `migration`) also use them. `until_blocked_by` waits until the sessions that wait, directly or behind another waiter, for a lock that the backend pid holds in that DB reach that count
- `hold_game_row_lock` opens a transaction on the test server's DB with a connection other than the server instance's, and takes the lock that `storage.lock_game_row` takes with that table and key value. In SQLite it opens that transaction with `BEGIN IMMEDIATE` and blocks all other write transactions. The returned function rolls back that transaction
- TypeScript shape
  - A test server has the fields `url`, `port`, `dev_access`, and a test session has `user_id` (`bigint`), `access_token`, `login_token`, `session_signing_key`
  - The output of `send` and `send_cheat` is `{envelope, response}`, and `response` is `null` for an error response. The output of `send_raw` is `{status, headers, body}`, the output of `send_admin` is `{status, headers, body, json}`, and `json` is the body read as JSON, or `null` when it is not JSON
  - The JSON body of `send_admin` is a JSON value or a JSON text string. A binary body is `{binary: Uint8Array, query: object}`, and `query` holds string values keyed by input field name
  - An output element of `read_user_state` and `read_server_state` is `{kind, item_id, value}` (`kind` is the kind message name, `value` is the decoded kind value), in the kind order of the contract, and in ascending order of item ID within the same kind
  - An output element of `read_logs` is a log line read as a JSON object. The input of `call_dev` is an array of operation inputs. The output of `load_data` is `{data, dev}`, and `dev` is `{find_id_value, find_id_name}`. `read_frame` returns `null` when the connection has ended. An element of `non_integer_values` is a JSON text string
- gate: the gate that the peer process of `start_peer_process` uses. When a core test starts its own child process (e.g. `migration`), the child calls `wait_at_gate` and the test uses `reached` and `open` received from `gates_of`
- HTTP/2 test server: a TLS server that listens on `127.0.0.1` with a self-signed test certificate that testing holds, and accepts only HTTP/2: it refuses a client that does not offer `h2` through ALPN. While it runs, that certificate is added to the default CA certificates of the process so that the global `fetch` reaches it without other options, and `close` restores the default CA certificates
- fake adapter controller: its methods are `set_result(operation name, result)`, `set_failure(operation name, failure condition)` and `calls()`. A failure condition is one of `timeout`, `communication_failure`, `rejected`, or `null`, which clears the set failure condition. A set result and failure condition are used for every call of that operation until set again, and when a failure condition is set, the call fails instead of returning the result. `calls()` is the list of `{operation, input}` per received call, in the order received. The services are `login-apple`, `login-google`, `iap-apple`, `iap-google`, `ads`, `push-fcm`, `push-apns`, `turn`, `cdn`, `analytics`. The operation names and the format of results and `input` are defined by the spec of the module that uses that adapter (`auth`, `iap`, `ads-reward`, `push`, `p2p-signaling`, `game-update`, `logging`). A controller method that exists for one service only is also defined by that module spec. E.g. `sign_callback` of `ads`. `fake` for a service in the real adapter list throws
- `call_dev` calls `dev` of the server instance of the test server with the module name, operation name, input and user ID, and returns its result. Transaction, commit and rollback, and throw follow `dev` of `routing`. It calls only the operations whose `called by` is `call_dev` in the testing DEV operation table below, and throws for any other operation. An operation whose `called by` is `test helper` is called only inside the test helper. The rows of this table equal the operations in the `## DEV` tables of server module specs that are not core cheats and have `testing` in the `caller` cell, and `ogw docs check` compares them

  testing DEV operation

  | module | operation | called by |
  |---|---|---|
  | `item-ledger` | `set_balance` | `call_dev` |
  | `iap` | `send_fake_refund` | `call_dev` |
  | `iap` | `send_fake_subscription_notify` | `call_dev` |
  | `ranking` | `close_season_now` | `call_dev` |
  | `tutorial` | `set_tutorial_step` | `call_dev` |
  | `matchmaker` | `create_test_match` | `call_dev` |
  | `migration` | `migrate_snapshot` | `call_dev` |
  | `attendance` | `set_attendance` | `call_dev` |
  | `offer` | `set_offer` | `call_dev` |
  | `rating` | `set_rating` | `call_dev` |
  | `server-time` | `set_clock` | `test helper` |
  | `server-time` | `wait_idle` | `test helper` |
  | `storage` | `set_seed_provider` | `test helper` |
  | `storage` | `wait_after_commit` | `test helper` |
  | `storage` | `open_pg_session` | `test helper` |

### isolation

- `start_test_server` creates, per test server, a new temporary folder, a new DB, a free port, and new secret values of the server start arguments that `## adapter` of [`server-core`](../SKILL.md) defines. The additional secrets a test server gets are the admin secrets of the operators `read`, `ops`, `economy`, `release`, each having one role only, and, per adapter in the real adapter list, the secrets that `## settings` of the module spec defining that adapter names in `environments.<ENV>.secrets`. The secret values of the adapters in the real adapter list are new test values in the format that spec defines. E.g. `loginApple` of `login-apple` is the `.p8` PEM of a new P-256 key. It does not read the paths, keys or accounts of another running server. The exception is the peer of `start_peer_server`
- `stop_test_server` on an original test server stops the instance and deletes the temporary folder and DB. When the instance stop or the DB deletion fails, it throws after doing the rest of the cleanup
- The environment is the environment given to `start_test_server`, and `LOCAL` when not given
  - `LOCAL`: starts as a server instance with DEV code included. Adapter keys in the real adapter list use that adapter, and the other external services are fake adapters
  - `STG`: starts as a server instance without DEV code. The test helper in the test process is not DEV code included in that server instance. It treats game settings `environments.STG.adapters` as empty. The clock is the system clock, and it does not accept a start time. `login` sends a guest `Login` that agreed to the current terms version. `send_cheat`, `call_dev`, `fake`, `set_time`, `advance_time`, `wait_background` and a seed given to `send` throw. Behavior that differs only in STG and PROD is tested with this test server. It treats `environments.STG.updatePublicKeys` as the one public key of a new deploy list signing key
- When the matchmaker flag is `true`, it starts as a server instance given the server start argument `--matchmaker`. `connect` connects to `GET /realtime` of that test server over WebSocket
- The real adapter list is passed by putting, per adapter key, its name into `environments.<ENV>.adapters` of the settings overrides. An adapter in the real adapter list uses the key source received through the key source override of `routing.create_server`. That key source returns the value or failure set with `set_key_source`, and is a communication failure before one is set
- All outgoing HTTP of a test server is a communication failure through the outgoing HTTP override of `create_server`
- `start_test_server` creates a new log line writer per test server and a new fake adapter per adapter key not in the real adapter list, and passes them through the log line writer override and the fake adapter override of `create_server`. `read_logs` returns the lines that writer received, and the `fake` controller handles those fake adapters
- `send_admin` sends `POST /admin/<operation>` with the given operator of that test server (`ogw` when not given) and its admin secret. When an admin secret override is given, it sends that value
- When the DB kind is not given, it is the `OGW_DEFAULT_DB` that the test runner gave. A core test does not read `OGW_DEFAULT_DB` directly and uses the DB kind of `new_core_test_server_input` or `db_kind_of`. `postgresql` creates a new database per test server in the PostgreSQL of the `OGW_POSTGRESQL` that the test runner gave. In a run without `OGW_POSTGRESQL`, `start_test_server` throws when the DB kind is `postgresql`
- `start_peer_server` starts a server instance that `routing.create_server` creates with the same DB, all secret values of the server start arguments, environment, server module list, server build data, real adapter list and key source, and settings overrides as the original test server, and with the fake adapters of the original test server, and under `LOCAL` sets the test clock of the original test server. The port, scheduler, process memory (cache, lease values, seed setting) and log line writer are separate, and it does not take `--matchmaker`. The `fake` controller of the peer is the same as that of the original test server
- `set_time` and `advance_time`, called on either the original test server or the peer, change the clock of both, and both schedulers start due jobs. `wait_background` waits only for those of the test server it is called on
- `stop_test_server` on a peer stops only the peer. `stop_test_server` and `restart_test_server` on the original test server also stop its peers. `stop_test_server` stops through `stop` of `create_server`
- `restart_test_server` calls `stop` on the original server instance, creates a new server instance with `routing.create_server`, and calls `start` on it. The new server instance uses the same DB, settings overrides, environment, server module list, server build data, all secret values of the server start arguments, real adapter list and key source, fake adapters and `fake` controller, log line writer, and matchmaker flag as the original, and under `LOCAL` sets the same test clock. The time of the test clock stays as it was before the restart. When `register` and `registerDev` are given it uses those functions, otherwise the previous functions. The port, scheduler and process memory (cache, lease values, seed setting) are created anew. So test sessions from before the restart keep working unchanged
- A test server is a server instance created with `routing.create_server` inside the test process. `--port` is 0. Several test servers can run together in one process without affecting each other
- Settings overrides are passed as the core settings and game settings value overrides of `routing.create_server`. When a key is in neither the merged core settings nor the game settings values that core reads, or the type of a value differs from that key, `start_test_server` throws
- A test server prepares the modules of the server module list given to `start_test_server`, or, when none was given, of the server module list the test runner gave. The test server of a server core test that has neither prepares all server modules. For the server build data folder too, the folder given to `start_test_server` takes precedence over the folder the test runner gave
- A test server passes the `register` and `registerDev` given to `start_test_server` as the content registration functions of `routing.create_server`. A function not given is, for a server regression test, `register` of the game's `server/main.ts` or `registerDev` of `server/dev/main.ts`. For a server core test that runs without a game, `register` is `core_test_register` and `registerDev` is `core_test_register_dev`. When `core_test_register` receives a name list, it does not register the handlers of those `rpc`: the core test registers those handlers in its own registration function. `core_test_register` registers, per `service Game` `rpc` of the core test data, a handler that returns an empty response message, and calls `register_false_judges` and `register_required_hooks`. `register_false_judges` registers, per `RequirementType` element of the server build data, a judge hook of `validation` that returns `false`. `register_required_hooks` registers, outside the list of excluded hooks, the hooks of modules in the server module list that server start requires to be registered depending on data rows (`grant_ad_extra`, `grant_attendance_extra`, `grant_iap_extra`, `grant_mission_extra`, `grant_shop_extra`, `continue_play_session` that return `pass`, `revoke_iap` that does nothing, `replay_match` that returns `reject`). `core_test_register_dev` registers, per `service Cheat` `rpc`, a cheat handler that returns an empty response message. A server core test that gives its own `register` calls `register_false_judges` and `register_required_hooks` in that `register`. A test that tests the server start failure when such a hook is missing puts that hook in the list of excluded hooks. `registerDev` is passed only to a test server with DEV code included
- The DB of a test server keeps the transaction semantics of `storage` unchanged. Nested transactions of the same user are rejected, and concurrent transactions are serialized

### request

- `send` sends a real HTTP request. When no request ID is given, it creates a new UUID v4. Giving the same request ID can test idempotency
- When no timestamp is given, it uses the `user_now` of that user. `session.sign_request` creates the signature with the key of the test session. Header overrides and the raw body are applied after the signature is created
- `X-Ogw-Data-Version` is the `client_data_version` that the test server read at start
- A given seed is used as the random seed of that request. When none is given, it is secure random
- Requests of `NoAccessTokenRpc` are sent without an access token, and requests of `NoSignatureRpc` without a signature
- `login` on a `LOCAL` test server sends `auth.DevLogin`. `login` and `send_cheat` put the dev access value of that test server in header `X-Ogw-Dev-Access`

### time and random

- A `LOCAL` test server sets, before `start()` of the server instance, the test clock with `server-time.set_clock` and the seed setting with `storage.set_seed_provider`. The same applies to the server instances that `start_peer_server` and `restart_test_server` create
- The test clock is a `ClockAdapter` of `server-time`. When `set_time` and `advance_time` end, it calls every listener registered with `subscribe`, so one test clock is shared by several server instances of a test server and its peers
- The clock of a `LOCAL` test server is the test clock. When `start_test_server` gets no start time, it is `testing.defaultStartAt`
- `set_time` and `advance_time` change the test clock of that test server. The clock of the next requests and out-of-request changes changes, and the scheduler of `server-time` starts due jobs at once and ends each `sleep` that reached that time. They do not wait for the jobs to end. The clock of another test server that is not a peer of that test server does not change
- The test clock and the seed setting are not available outside test servers. A server instance that the server process entry point started does not receive the test clock or the seed setting

### other

- `wait_background` waits until all out-of-request changes started on that test server have ended and `storage.wait_after_commit` and `server-time.wait_idle` have ended
- For a test server whose environment is `LOCAL`, `start_test_server`, `restart_test_server` and `start_peer_server` return after running `wait_background` on the server start job run. So a test that changes the clock right after start does not overlap the server start job run
- `load_data` reads the server build data folder that the test runner gave. It throws when there is no folder. A test reads data values through this container to calculate expected values, and converts ID names to ID values with its DEV accessor. It does not read or parse data files directly
- `read_fixture` reads only regular files under `fixtures/` next to the calling test file. An absolute path, a path containing `..`, a path through a symbolic link, a target that is not a regular file, and a file of more than `testing.maxFixtureBytes` throw. There is no write operation
- `read_shared_fixture` reads only `<name>.json` in the shared fixture folder that the test runner gave (the game's `data/fixtures/`). The name is snake_case parts joined with `.`. It throws when the folder or file does not exist or is more than `testing.maxFixtureBytes`
- `read_core_fixture` reads only `<name>.json` in the core fixture folder that the test runner gave (`open-game-works-core-impl/fixtures/`). The name is kebab-case. The test runner gives the core fixture folder to server core tests only. It throws when the folder or file does not exist or is more than `testing.maxFixtureBytes`
- `non_integer_values` holds `true`, `false`, `1.0`, `1.5`, `"1"`, `null`
- Test helper operations do not retry failures
- `call_dev` that calls an operation of a module not in the server module list of the test server, and `fake` for a service whose adapter-using module is not in that list, throw

### remote

- `connect_server` returns a remote test server that sends to a LOCAL server instance with DEV code included, which the server process entry point started at that URL. It does not start or stop the server process
- A remote test server accepts only `login`, `send` and `send_cheat`. Other operations, and a timestamp, seed, header overrides or raw body given to `send`, throw
- `login` sends `auth.DevLogin`. `login` and `send_cheat` put the dev access value that `connect_server` received in header `X-Ogw-Dev-Access`
- `X-Ogw-Data-Version` is the `client_data_version` of the received server build data folder
- The timestamp is the `ResponseEnvelope.server_time_at` that the test session received last, plus the duration elapsed since then

### test run

The harness tool runs server core tests and server regression tests with vitest. The `package-lock.json` of `ogw` pins the vitest version. When the checkout has `server/package-lock.json` and `server/node_modules/` was not installed from that file, the harness tool runs `npm ci` in `server/` before the tests.

- test file: `server/core/<module>/tests/*.test.ts` for server core tests, `*.test.ts` under the game's `server/tests/` for server regression tests. A test file uses `describe`, `it`, `expect` as vitest globals and does not import `vitest`. It imports the test helper from `server/core/testing/dev/index.ts`
- The test runner gives a new temp folder per vitest run as `TMPDIR` (`TMP`, `TEMP` on Windows): runs that run together (the SQLite run and the PostgreSQL run of one module) do not see each other's temp files
- The test runner passes inputs in the environment variables below. Only the test helper reads them

  | environment variable | value | when |
  |---|---|---|
  | `OGW_SERVER_MODULES` | absolute path of the server module list file (the game's `server/generated/server_modules.json`) | server regression test |
  | `OGW_SERVER_DATA` | absolute path of the server build data folder (`server/build/data/`) | every run |
  | `OGW_SHARED_FIXTURES` | absolute path of the shared fixture folder (the game's `data/fixtures/`) | server regression test |
  | `OGW_CORE_FIXTURES` | absolute path of the core fixture folder (`open-game-works-core-impl/fixtures/`) | server core test |
  | `OGW_POSTGRESQL` | connection string of the PostgreSQL in which test servers create new databases. It is a PostgreSQL that the test runner starts and discards per run, and since it keeps no data, `fsync` and `full_page_writes` are off | a run that provides PostgreSQL |
  | `OGW_DEFAULT_DB` | DB kind of `start_test_server` without a given DB kind. `sqlite` or `postgresql` | every run |

- Server core tests run once per module with `OGW_DEFAULT_DB` `sqlite` and once with `postgresql`, and both runs get `OGW_POSTGRESQL`. Server regression tests get `OGW_DEFAULT_DB` `postgresql` and `OGW_POSTGRESQL` when `ogw check` has `--db postgresql`, and otherwise only `OGW_DEFAULT_DB` `sqlite`
- result: per run, the harness tool makes from the vitest result one JSON in the same format as the result file of [`unit-test-core`](../../client-core/modules/unit-test-core.md). `kind` is `core` or `regression`, `engine` is `server`, `warn_counts` is an empty object. The `name` of a test is the test file path relative to the checkout root, followed by `::` and the describe names and test name joined with ` > `. The `skipped` and `todo` of vitest are `skip`. Each test file that vitest reports with status `failed` but that has no `fail` test (e.g. a file that could not be loaded, a file that threw in `beforeAll` or `afterAll`) is a run failure per file, and zero tests is run failure `no tests`
- judgement: a run passes when every test is `pass` or `skip`, there is no run failure, and there is at least one test. When vitest ends with a nonzero exit code and there is no `fail` test and no other run failure, that exit code counts as a run failure. In server regression tests, `skip` is also a failure

## test

- The global `fetch` reaches a server started with `start_http2_test_server` over HTTP/2, and that request is recorded in the list. `http1_connect` returns the error code of the refused connection, and after `close` the default CA certificates of the process equal those before the start
- A failure condition set with the `fake` controller of the test server is not used for a request sent to a peer process, and that call is not in `calls()` of the controller
- Calling `start_peer_process` with a test server that has a real adapter list throws without starting a process
- Two test servers in the same process do not see each other's users, DB, clock or logs
- A test server that fails midway through start leaves no temporary folder, DB or port
- A test server without a given DB kind uses the DB of `OGW_DEFAULT_DB`, and in a run without `OGW_POSTGRESQL`, `start_test_server` with DB kind `postgresql` throws
- Two requests with the same seed give the same random results, and the seeds of concurrent requests do not mix
- The request time of a request after `advance_time` is later by that amount
- UserState remains after `restart_test_server`
- After moving the clock with `set_time`, setting the next result with the `fake` controller and calling `restart_test_server`, `send` with a test session from before the restart is handled without `UNAUTHORIZED` and its request time is the moved clock time, the set fake result is used for the next call, and `read_logs` returns the lines from before and after the restart together
- The modules of a test server use a core settings value given as a settings override, also after `restart_test_server`, and another test server in the same process uses the default value. An override of a nonexistent key throws
- Handlers registered by the `register` given to `start_test_server` handle the requests of that test server. When `restart_test_server` gets a different `register`, the new server instance uses the handlers of that function, and otherwise the handlers of the previous function
- `login`, `send` and `send_cheat` succeed on a remote test server from `connect_server` with the URL and dev access value of a test server started with `start_test_server`. `login` on a remote test server from `connect_server` with a different dev access value throws. `set_time` and a seed given to `send` on a remote test server throw
- A request to the original test server reads UserState written by a request sent to the peer from `start_peer_server`, and the reverse also holds
- `advance_time` on the original test server also makes the request time of the peer later by that amount, and the due jobs of both instances run. After the peer stops, the original test server still receives requests
- `read_logs` of the peer and of the original test server each return only the log lines that each wrote, and a fake adapter call made on the peer is in the record of the `fake` controller of the original test server
- A request whose signature is wrong because of overridden headers is `UNAUTHORIZED`
- A result and failure condition set on a fake adapter are used for the next call, and the call is recorded
- `read_fixture` throws for each kind of path violation and for size exceeded
- `read_shared_fixture` returns the bytes of the file of that name in the shared fixture folder, and throws for a nonexistent name and a name that violates the format
- `read_core_fixture` returns the bytes of the file of that name in the core fixture folder, and throws for a nonexistent name, a name that violates the format, and a run without a core fixture folder
- `wait_background` returns after the out-of-request change ends
- A request that locks with `lock_game_row` a game row locked with `hold_game_row_lock` is `INTERNAL`, and the same request after releasing with the returned function is handled
- The `Error` that `start_test_server` throws on a start failure holds the failure reason and the `error` log line of the server start failure
- When `advance_time` passes the period of job `storage_sweep` and `wait_background` is called, expired rows are deleted, and when it does not pass it, they remain
- After `advance_time` past the `send_at` of a scheduled push and a call to `wait_background`, that push has been sent once
- Jobs of a `LOCAL` test server do not run even when real time passes
- A nested transaction of the same user on a test server is rejected
- A server instance that the server process entry point started does not receive the test clock or the seed setting
- A subscription snapshot set with the fake controller is used in handling the next `VerifyPurchase` and `send_fake_subscription_notify` through `call_dev`
- `call_dev` throws for an operation outside the list
- When `set_balance` through `call_dev` with a user ID returns an output, `read_user_state` reads the committed balance. When it returns a failure value (`UNKNOWN_ITEM`), `call_dev` returns that value and the saved state of that user is unchanged. `call_dev` with the user ID of a withdrawn user throws
- On a `STG` test server, a cheat path request is `UNAUTHORIZED`, and `send_cheat` and `call_dev` throw
- A `STG` test server starts inside the test process that contains the test helper and does not call `registerDev`
- When `HELLO` is sent with `connect` and `send_frame` to a test server whose matchmaker flag is `true`, `read_frame` receives `HELLO_ACK`. `connect` to a test server whose matchmaker flag is `false` throws
- `send_admin` calls an admin operation as the operator of the test server, an overridden secret gets 401, and an operation of the `economy` role called as operator `read` gets 403
- A `turn` relay and a `cdn` base URL set with the `fake` controller are used in the next call
- On a test server with `login-google` in the real adapter list, only a token signed with a key set with `set_key_source` passes `verify`, before `set_key_source` `Login` is `EXTERNAL_SERVICE_FAILED`, and an external service call outside the key source is a communication failure. `set_key_source` for an adapter key outside the real adapter list throws
- A test server with `login-apple` in the real adapter list starts without reading the host secret store
- With a key list fetch failure set with the `fake` controller (service `ads`), `GET /ads/callback/fake` is HTTP 503
