---
name: server-core
description: Holds the list of server core modules and the spec per module, and the rules common to server core (folder structure, request handling, base proto, generated code, handler, DB adapter, external service adapter, log, time, integer calculation, DEV code, server start, server image). Read when making, fixing or reviewing server core, and when looking up a core module's spec before server content code uses that module. The lead agent of `build` reads `server-image.md` when deploying the server
---

# server core

The common rules (spec format, hook, error handling, core settings) follow [`core`](../core/SKILL.md). Server core is written in TypeScript and kept in `open-game-works-core-impl/server/core/`. The generated code that core tests use is kept in `open-game-works-core-impl/server/generated/` and `open-game-works-core-impl/server/dev/generated/`. Their relative positions equal those of the game's `server/core/`, `server/generated/`, `server/dev/generated/`, so the import paths of core code are also the same in the game.

## folder

The structure of `open-game-works-core-impl/server/core/`. The game's `server/core/` is the same.

```
server/core/
  start.ts                 server process entry point. Not a module
  Dockerfile               server image build file. Not a module
  <module>/                one module. The folder name is the module name
    index.ts               entry file of the module. Exports what the module exports
    adapters/              real adapter, sandbox adapter, clock adapter
    dev/                   DEV code of that module
    tests/                 core tests. The file name is `<topic>.test.ts`
```

- `server/package.json` is `{"type": "module"}`, and next to it is `server/package-lock.json`, made from that file. Both are kept in `open-game-works-core-impl/server/` and in the game's `server/`
- `cheat` and `testing`, whose whole module is DEV code, keep all module code in `dev/`, and their entry file is `dev/index.ts`
- A fake adapter is DEV code, so it is kept in `dev/adapters/`
- When a file outside `tests/` of a module folder imports a file of another module folder, it references that module. When a file in `dev/` does, it is a DEV code reference. A core test in `tests/` imports files of the modules the test needs. The test helpers of `testing` are the exception: they are imported from `testing/dev/index.ts`
- Test servers and fixtures that the core tests of several modules share (e.g. an HTTP/2 test server and a test certificate) are DEV operations of `testing` and are not copied per module
- The files of another module folder that a file outside `tests/` of a module folder imports are only that module's entry file (`index.ts`; for a file in `dev/`, also `dev/index.ts`) and the files whose path this document or the module spec states. Any other file is an internal file of that module. As an exception, `testing` also imports internal files of other modules. The static check of `ogw core test server` checks relative imports
- The values (exports that are not types) that another module imports from the entry file are only those whose names the module spec sets: `create_<module>`, `create_<module>_dev`, the operations of `## API` or `## DEV`, and the enums, classes and constants the spec defines. When an operation is exported as a function, that function behaves the same as the module object's method of the same name. The entry file exports types even when the spec does not name them
- `server-time`: clock adapter `system` is `server-time/adapters/system_clock.ts`, the scheduler of `schedule_job` and `sleep` is `server-time/scheduler.ts`, and `network_time_limit` is `server-time/network_time_limit.ts`. The test clock is `testing/dev/test_clock.ts`. In core code outside `tests/`, the only file that reads the system clock is `system_clock.ts`, and the only files that use timers are `scheduler.ts` and `network_time_limit.ts`. The static check of `ogw core test` checks this
- `server.tgz` is `open-game-works-core-impl/server/core/` without the `tests/` of each module folder

## module

| module | spec | role |
|---|---|---|
| `routing` | [routing](modules/routing.md) | request processing order, handler registration, rate limit, body limit, CORS |
| `validation` | [validation](modules/validation.md) | running the contract's field validators, check helpers that handlers use, text normalization and banned word check, integer calculation helpers, judgement of `requirement` conditions |
| `auth` | [auth](modules/auth.md) | guest login, dev login, social login token verification, login token and access token, consent to terms, age check, personal information choices, ad push consent record, withdrawal, web account deletion, guest cleanup, finding a user by social account |
| `session` | [session](modules/session.md) | game session, session signing key, request signature check |
| `storage` | [storage](modules/storage.md) | per-request transaction, per-user serialization, saving UserState, server state and game state, reading public kinds, user change, pending delta, DB adapter |
| `idempotency` | [idempotency](modules/idempotency.md) | returning again the response saved by request ID |
| `server-time` | [server-time](modules/server-time.md) | server time, request time and time judgement, cheat time offset, game day and reset period boundaries, lazy reset, fixed window, scheduler |
| `logging` | [logging](modules/logging.md) | server log, collecting and saving the error logs and analytics events that the client sends, server analytics events and core analytics events |
| `cheat` | [cheat](modules/cheat.md) | cheat request handling. DEV code |
| `admin-api` | [admin-api](modules/admin-api.md) | operations API: grant, revocation, ban, maintenance, kill switch, user lookup, content admin operation |
| `user-snapshot-clone` | [user-snapshot-clone](modules/user-snapshot-clone.md) | cloning a PROD user to another environment |
| `migration` | [migration](modules/migration.md) | saved state schema migration and its testing |
| `matchmaker` | [matchmaker](modules/matchmaker.md) | matching, room and party, match creation, applying match results, DEV lockstep match |
| `p2p-signaling` | [p2p-signaling](modules/p2p-signaling.md) | signaling for P2P connections |
| `item-ledger` | [item-ledger](modules/item-ledger.md) | add and subtract transactions of items (currency and goods), recovery of recovery items, group item, timed item, big item, handling amounts over `max_amount`, history |
| `mailbox` | [mailbox](modules/mailbox.md) | user mailbox, claiming attached items, granting by mail the items that could not be granted at once |
| `shop` | [shop](modules/shop.md) | purchase of products defined in data, sale condition, purchase limit, purchase count reset |
| `iap` | [iap](modules/iap.md) | store receipt verification, grant, duplicate grant prevention, recovery of incomplete purchases, refund, subscription state and entitlement, sale condition, pass and daily reward, monthly spend limit, test transactions |
| `offer` | [offer](modules/offer.md) | limited-time offers that a trigger turns on per user |
| `ads-reward` | [ads-reward](modules/ads-reward.md) | ads reward verification and grant |
| `live-event` | [live-event](modules/live-event.md) | schedule, participation, settlement and active window of live events |
| `ranking` | [ranking](modules/ranking.md) | ranking board, score submission by users and guilds, query, season reward |
| `rating` | [rating](modules/rating.md) | saving rating per rating rule, Elo update from match results, season soft reset, tier and tier season reward |
| `tutorial` | [tutorial](modules/tutorial.md) | saving tutorial progress |
| `loot-table` | [loot-table](modules/loot-table.md) | drawing with ctx random from weighted reward tables defined in data, probability disclosure of public loot tables |
| `gacha` | [gacha](modules/gacha.md) | draw, pity, agreement of the disclosed probabilities with the probabilities used for judgement |
| `mission` | [mission](modules/mission.md) | progress counters of missions and achievements, reset, claiming completion rewards |
| `attendance` | [attendance](modules/attendance.md) | attendance calendar, attendance reward received once per game day |
| `reset-counter` | [reset-counter](modules/reset-counter.md) | counts that return to 0 every reset period, and their limits |
| `coupon` | [coupon](modules/coupon.md) | coupon code input, use count limit, reward |
| `notice` | [notice](modules/notice.md) | in-game notice, banner, maintenance notice |
| `remote-config` | [remote-config](modules/remote-config.md) | config values and feature flags changed without a data patch, experiment group |
| `nickname` | [nickname](modules/nickname.md) | nickname registration and change, finding a user by nickname |
| `public-profile` | [public-profile](modules/public-profile.md) | the nickname and game-defined profile shown to other users, last access time, target user judgement |
| `friend` | [friend](modules/friend.md) | friend request, accept, delete, friend list, finding a user by nickname |
| `block-report` | [block-report](modules/block-report.md) | block, report, report handling |
| `guild` | [guild](modules/guild.md) | creating a guild, joining and join request, leaving, kick, role, guild information |
| `chat` | [chat](modules/chat.md) | saving and polling text chat of world, guild and direct channels, getting earlier messages, my channel list, system message, banned word, mute, report, message deletion by guild `Leader` and `Officer` |
| `play-session` | [play-session](modules/play-session.md) | start, continue and end of one single-player play whose result client simulation decides, and verification and applying of its result |
| `push` | [push](modules/push.md) | device token registration, push scheduling, target selection, push text format, send record |
| `game-update` | [game-update](modules/game-update.md) | serving the deploy list and the data, translation and bundle files |
| `testing` | [testing](modules/testing.md) | test helpers that server regression tests, server core tests and content populate use |

- The state of a server core module is kept in the server instance that the `routing` operation `create_server` made, not in module global variables. State is every value a module keeps in process memory while the server instance runs. e.g. registered handlers and hooks, cache, provider, clock adapter, DB connection, the queue and rooms of `matchmaker`, the match sessions of `p2p-signaling`, the last user ID of job `auth_guest_sweep`. Several server instances in one process do not affect each other
- A server instance prepares only the modules in the server module list that the harness tool made (the server modules among the prepared modules, `## module` of the `core` skill). `routing` does not register the core rpcs, routes and admin operations of modules outside the list
- For the module format, the module entry file exports `create_<module name in snake_case>(input)`. The input is `settings`, `modules`, `server`. `settings` is an object that holds the merged values keyed by the core settings keys and game settings paths of `## settings` of that module spec. `modules` is an object that holds, keyed by module name, the module objects of the modules among that module's `dependencies` and `optionalDependencies` that are in the server module list. `server` is an object that the `routing` operation `create_server` makes once and passes as the same value to every module. The returned module object has the `## API` operations as methods of the same names. The names and formats of the members exported to `routing` are set by `## API` of [routing](modules/routing.md)
- Among the keys of `settings`, a game settings item whose path has `<ENV>` is a key that keeps `<ENV>` as it is. e.g. `environments.<ENV>.adapters`. The value is the value of the `--env` environment. LOCAL has no environment in game settings, so `environments.<ENV>.adapters` is the LOCAL value of `## adapter`, and any other item is the empty value of its type. An item whose LOCAL value the module spec sets has that value
- Fields of `server`

  | field | value |
  |---|---|
  | `env` | `--env` value |
  | `db` | `--db` value. `null` when not received |
  | `dev` | `true` for a server instance that includes DEV code |
  | `matchmaker` | `true` when `--matchmaker` was received |
  | `server_modules` | server module list |
  | `data` | the `DataSet` made from the server build data with `GameData.load_data_set` |
  | `data_version` | data version of the server build data |
  | `client_data_version`, `compat_client_data_version` | the two values of the server build data. `null` when there is no `compat_client_data_version` |
  | `read_data_file(name)` | file adapter. The bytes of file `name` in the server build data folder. `null` when there is none |
  | `read_secret(name)` | secret adapter. For the LOCAL server and test servers, the value of key `name` in the `--secret-file` file; otherwise, the value of secret `name` in the host secret store. `null` when there is none. A synchronous function. A module reads a secret whose name is set in game settings `environments.<ENV>.secrets.<key>` with `name` `<key>` when `db` is not `null` (LOCAL server and test server), and with that game settings value as `name` when it is `null` |
  | `fetch` | outgoing HTTP adapter. Same signature as global `fetch`. Sends over HTTP/2 to servers that require HTTP/2 (e.g. APNs). When `create_server` has an outgoing HTTP adapter override, that adapter |
  | `write_log_line(line)` | log line writer. Writes one line to the function of the log line writer override of `create_server` when there is one, otherwise to stdout |
  | `key_sources` | the key source override of `create_server` per adapter key. An adapter key that is not overridden is absent |
  | `fake_adapters` | the fake adapter override of `create_server` per adapter key. An adapter key that is not overridden is absent |
  | `port()` | the listening port number. 0 before `start()` listens |

- In TypeScript, operations and hooks receive the inputs of the `input` cell as positional arguments in that order, and the position of an optional input that is not given is `undefined`. An async operation returns a `Promise`. With two or more outputs, the output is an object with one field per output, and the field names are the names that the `output` cell writes as code spans. none is `null`, `pass` is the string `'pass'`, the output of a hook that returns `pass` together with one other output is that one other output (e.g. the `gacha` hook `grant_gacha_result` returns a list of `ItemAmount`), a deletion (the output of the conversion function of `storage` and of a converter of `migration`) is the string `'DELETE'`, and a failure code (`GameError`, `CoreError`) is that enum value (`number`) of the generated code. Other failure values and outputs that a spec writes by name (e.g. `FAILED`, `COMMITTED`, `NAME_MISMATCH`, the elements of `ItemChangeResult`) are their name strings. Enum values of base proto and data are the enum values of the generated code, and the values of other enums that a spec defines (e.g. `GuildMemberChange` of `guild`, `MatchSource` of `matchmaker`) are element name strings
- The `core` of content `register(core)` and `registerDev(core)` holds one object per module in the server module list, keyed by module name. That object is the module object's member `content` when the module object has one, otherwise the module object. A module that has an operation that behaves differently when content code calls it than when a core module calls it (e.g. the change source `source` of `item-ledger`, the core `once_key` prefix check) has the member `content`. `content` has, as methods of the same names, all of that module's operations whose `caller` includes content code (content handler, hook, `register` of content `server/main.ts`), and only those. The object passed to `registerDev` of a server instance that includes DEV code also holds that module's `## DEV` operations
- The lifecycle methods of a module object are `begin_start()`, `complete_start()`, `stop()`. At server start, the server instance makes the modules in dependency order, calls `begin_start()` of every module in dependency order, calls content `register(core)`, and calls `complete_start()` in dependency order. `complete_start()` returns `null` on success, and the reason string on server start failure. Only `server-time` has one more lifecycle method, `end_start()`. The server instance calls `end_start()` after `complete_start()` of every module has succeeded and it has started listening on the port. When server start fails, it is not called. The registration operations through which a module passes a function to another module (`iap.register_account_lookup`, `guild.register_disband_listener`, `block-report.register_block_listener`) are called in `create_<module>` or `begin_start()`. The receiving module returns a registration error as a server start failure from its own `complete_start()`, and a registration after `complete_start()` throws. `stop()` is called in reverse dependency order when the server instance stops. A lifecycle method with nothing to do does nothing
- A module that has DEV code exports `create_<module name in snake_case>_dev(module object)` from `dev/index.ts`. The returned object has the `## DEV` operations as methods of the same names. A server instance that includes DEV code calls `create_<module>_dev` once per such module after making the modules and before `begin_start()`; a server instance that does not include DEV code does not call it. Besides the `## API` operations and lifecycle methods, a module object can have members that only that module's DEV code calls. `cheat` and `testing` have only `create_<module>` in the entry file `dev/index.ts`

## request

- One request is one `rpc` of the contract, and one handler of content code handles it. Handler registration follows [routing](modules/routing.md)
- A module spec writes a core `rpc` in the operation cell of the `## API` table as `<rpc name> (core rpc, <option>). changes: <saved state>`. `<option>` is the attached `rpc` options (`silent`, `retry`, `sensitive`); with no option it is `<rpc name> (core rpc). changes: <saved state>`. A core cheat is written in the operation cell of the `## DEV` table as `<cheat name> (core cheat). changes: <saved state>`
- `<saved state>` is the comma-separated list of the saved state that the handling of that request can change. Its elements are written in this order: core UserState kind names (in the order of `## core UserState kind` of [base-proto.md](base-proto.md)), `content`, `all`. When nothing changes, it is `none`
  - `content`: saved state that content defined can change. It includes the changes of the content hooks that the request calls and the changes of the core operations that those hooks called. It is not added when the request calls only validation hooks, hooks called inside the `storage` operations `run_read_only` or `run_rollback_transaction`, hooks that receive a read-only ctx, and hooks that a spec states do not change saved state
  - `all`: all saved state of that user can be deleted with the `storage` operation `delete_user`
  - Writes to tables that a core module registered with the `storage` operation `register_table`, changes in the request start step and in request prepare, and pending delta delivery are not written
- The last comment line `changes:` of a core `rpc` and of a core cheat in the base proto is that operation's `<saved state>`
- A handler uses only the request context (hereafter ctx) that core passes. It does not use resources outside ctx (files, network, environment variables, global mutable state). The rules for handling another user's state and state shared by several users are in `## handler` of [`server-content`](../server-content/SKILL.md)
- A handler returns a response message on success and a `GameError` on failure. Exceptions are not used to pass failures
- The user ID is taken only from the access token. A user ID in the request body is not used
- Data values such as price, reward and probability are not taken from the request. The server reads them from data
- The handler checks again even the conditions that the client already checked
- The only random used for judgement is the ctx random. Core makes the seed per request and keeps it in the log
- A core module calls content hooks inside the `storage` operation `with_hook_change_source`. The source and ref are the values that `## hook` of that spec sets. When it sets none, they are the values of the change source that the module passes to `item-ledger` or `mailbox` in the same handling, and when it passes none either, `with_hook_change_source` is not used. Items that content changed inside the hook are recorded with this change source
- A core module judges the output of a content hook whose output is `pass` or `GameError` with `storage.check_hook_output`
- The handler function of a content admin operation is included in the spec caller `content handler`
- Request sets that specs refer to by name. Their elements are request names
  - `NoAccessTokenRpc`: received without an access token. `core/Login`, `core/AutoLogin`, `core/RefreshToken`, `core/GetTerms`, `core/GetNotices`, `core/cheat/DevLogin`
  - `NoSignatureRpc`: received without a request signature. `core/Login`, `core/AutoLogin`, `core/GetTerms`, `core/GetNotices`, `core/cheat/DevLogin`
  - `NoUserRpc`: handled without a user, without going through `auth`. `core/GetNotices`
  - `NoAccessTokenRpc` is the `ReadonlySet<string>` constant `NO_ACCESS_TOKEN_RPC` that the entry file of `storage` exports. Other modules judge `NoAccessTokenRpc` with this constant

## base proto

The base proto is the proto that a core release includes. It holds the request and response messages of core `rpc`s and core cheats, `ResponseEnvelope`, `ServerError`, `CoreError`, `UserStateDelta`, `UserStateEntry`, the core UserState kinds, the core options (`(ogw.silent)`, `(ogw.retry)`, `(ogw.sensitive)`, `(ogw.errors)`, `(ogw.core_errors)`, `(ogw.v)`, `(ogw.public)`, `(ogw.converters)`), and the types that a module spec declares as base proto messages or enums. Its files, package and imports are set by `### base proto file` of [`contract`](../contract/SKILL.md). What `contract` sets is written by `create contract tool` of [`core` command](../core/command.md), and the rest by `create server core`.

- The fields and elements of a base proto message or enum are set by the one module spec that declares that type. `ResponseEnvelope`, `ServerError`, `UserStateDelta`, `UserStateEntry` and the core options are set by [`contract`](../contract/SKILL.md). Other modules use them by name, regardless of dependency
- The format of the request field tables and response field tables of module specs, the names, numbers and modules of `CoreError`, the order and owner modules of the core UserState kinds, and the base proto check in which `ogw core test` compares the specs with `core.proto` are in [base-proto.md](base-proto.md)

## generated code

The TypeScript that the contract tool and the data tool make. One namespace is one module file. Content code imports a whole module with `import * as <namespace> from "<path>"`.

| namespace | file |
|---|---|
| `CoreContract` | `server/generated/contract/core_contract.ts` |
| `GameContract` | `server/generated/contract/game_contract.ts` |
| `CoreCheatContract` | `server/dev/generated/contract/core_cheat_contract.ts` |
| `GameCheatContract` | `server/dev/generated/contract/game_cheat_contract.ts` |
| `GameData` | `server/generated/data/game_data.ts` |
| `GameDataDev` | `server/dev/generated/data/game_data_dev.ts` |

- A message is an exported class. The constructor without arguments sets every field to its default value. Field names are the proto field names. `<Table>Row` and `<Table><Column>Item` of the data proto are also classes under the same rules

  | proto | TypeScript | default |
  |---|---|---|
  | `int32`, `float`, `double` | `number` | `0` |
  | `int64` | `bigint` | `0n` |
  | `bool` | `boolean` | `false` |
  | `string` | `string` | `""` |
  | `bytes` | `Uint8Array` | empty `Uint8Array` |
  | enum | that enum | the member whose value is 0 |
  | message | that class or `null` | `null` |
  | `repeated` | array of the element type | empty array |

- The TypeScript type of a data proto field follows the `## type` table of [`data`](../data/SKILL.md). A vector message of the data proto is a class that `GameData` exports, and its fields `x`, `y`, `z`, `w` are `number`. The default value of a vector field of a data row is an object whose components are all 0
- The methods of a contract message class are `encode(): Uint8Array` and `static decode(bytes: Uint8Array): <class> | null`. When the format differs from the contract, `decode` returns `null`
- An enum is the exported const object `export const <Enum> = { ... } as const;` and the type alias of the same name `export type <Enum> = (typeof <Enum>)[keyof typeof <Enum>];`. `<namespace>.<Enum>.<member>` is a value and `<namespace>.<Enum>` is a type. The members of a proto enum are the proto value names as they are. e.g. `GameContract.GameError.GAME_ERROR_NOT_ENOUGH_GOLD`. A data enum is exported by `GameData`, its members are the `element` values as they are, and `None` is 0. e.g. `GameData.RequirementType.ItemCount`
- `GameContract` exports, per `rpc` of `service Game`, and `GameCheatContract` exports, per `rpc` of `service Cheat`, the handler type `type <Name>Handler = (ctx: RequestCtx, request: <Name>Request) => <Name>Response | <Name>Error` and `<Name>Error`, the union type of the `GameError` members written in `(ogw.errors)` of that `rpc`. `<Name>Error` of an `rpc` without `(ogw.errors)` is `never`. `RequestCtx` is the ctx type that `### ctx` of `storage` sets, and the generated code imports it from the file that `storage` sets. `CoreContract` and `CoreCheatContract` make no handler types. The handler types of core `rpc`s and core cheats are set by the server core module that exports those handlers
- A namespace that has `rpc`s (`CoreContract`, `GameContract`, `CoreCheatContract`, `GameCheatContract`) exports `RPCS: readonly CoreContract.RpcInfo[]`, with one item per `rpc` of its service, in proto declaration order. `RpcInfo` is an interface that `CoreContract` exports, and its fields are `name` (request name), `request_class`, `response_class` (the classes of the request message and response message), `silent`, `retry`, `sensitive` (`boolean` of the `rpc` option), `errors` (the `GameError` values of `(ogw.errors)`; an empty array when there are none), `validate` (the field validator of that request message; `null` when the contract tool did not make one)
- field validator: the function `validate_<message name>(message: <class>, data: GameData.DataSet): CoreContract.ValidationFailure | null`, exported per checked message. It returns `null` when the message passes. `ValidationFailure` is an interface that `CoreContract` exports, and its fields are `path: string` (field path), `rule: string` (rule name). The field path and rule name are set by `### validator` of `validation`. A `table` option is checked with the container of that table in `data`
- `GameContract.CORE_ERRORS: ReadonlyMap<string, readonly GameContract.GameError[]>` maps, for each core `rpc` that has `(ogw.core_errors)`, the request name (`core/<Name>`) to the list of `GameError` values written there
- `CoreContract.KINDS` and `GameContract.KINDS` are `readonly CoreContract.KindInfo[]` with one item per UserState, server state and game state kind of each. `KindInfo` is an interface that `CoreContract` exports, and its fields are `name` (kind message name), `kind_class` (kind class), `store` (one of `"user_state"`, `"server_state"`, `"game_state"`), `column` (the `kind` column value of `storage`), `is_list` (`true` for a list kind, which has field `int64 id = 1`), `is_public` (`true` for a public kind). The order is the order of `store` above; within the same `store`, core UserState kinds are in the order of `## core UserState kind` of [base-proto.md](base-proto.md), and the others in proto declaration order
- The kind classes of UserState and server state, `CoreContract.ItemChange`, `CoreContract.ItemMail`, and the cheat request message classes of `CoreCheatContract` and `GameCheatContract` also have the proto3 JSON conversion methods `to_json(): unknown` (JSON value) and `static from_json(json: unknown): <class> | null`. When the format differs from the contract, `from_json` returns `null`
- `GameContract.CONTRACT_VERSION: number` is the contract version
- `GameContract.CONVERTERS: readonly { kind: string; from_version: number }[]` has one item per (kind message name, from version) written with `(ogw.converters)` of [`contract`](../contract/SKILL.md), in the same order as the converter list file `converters.json`
- The identifier of a UserState, server state or game state kind is its kind class. e.g. `GameContract.QuestUserState`, passed to the `storage` operation `get_state`
- An instance of the class `DataSet` that `GameData` exports holds the containers and accessors. The `data` of ctx, and the containers and accessors that the `testing` operation `load_data` returns, are a `DataSet`. Its properties are `<Table>Table` per table and the accessors `GameSetting`, `ReservedId`, `ReservedString`
  - The methods of `<Table>Table` are `all_rows()`, `empty_row()`; a table whose first column is `id(key)` also has `get_row(id: number)`, `has_row(id: number)`, and a table whose first column is `id` also has `get_rows(id: number)`, `has_rows(id: number)`. Returned lists are `readonly` arrays
  - Each accessor has a method `<accessor name>()` per key. The return type is `number` for `ReservedId`, `string` (the built translation key) for `ReservedString`, and for `GameSetting` the field type of the column whose type is that row's `data_type`. e.g. `ctx.data.ReservedId.tutorial_reward()`, `ctx.data.ReservedString.auth_deletion_title()`
- The load entry point is `GameData.load_data_set(files: ReadonlyMap<string, Uint8Array>): DataSet | null`. It returns `null` on failure. Each server instance makes one `DataSet`
- The load entry point of the translation binary is `GameData.load_translation(bytes: Uint8Array): ReadonlyMap<string, string> | null`. The output is a map from built translation key to text, and `null` when the bytes do not decode as `Translation`. Core modules read the translation binary only with this function
- DEV accessor: `GameDataDev.find_id_value(id_name: string): number` and `GameDataDev.find_id_name(id_value: number): string`
- The files that `ogw generate` writes to `server/generated/` are the files below and the `TickChangedVersions` file of [`server-content`](../server-content/SKILL.md)

  | file | contents |
  |---|---|
  | `core_settings.json` | the merged core settings values and the game settings values that core reads. Same content as the client's `core_settings.json` |
  | `server_modules.json` | server module list. A JSON array of the names of the server modules among the prepared modules, in byte order of the names |
  | `resource_keys.json` | resource key list. Same content as the client's resource key list file |
  | `resource_key.ts` | resource key constants. `export const <constant name>: string` per resource key. Content code imports it with `import * as ResourceKey from "<path>"` |

## adapter

- Server code uses DB, files, secrets, external services, outgoing HTTP and the system clock only through adapters
- The same adapter interface has a fake adapter, a sandbox adapter and a real adapter. The choice is the per-environment `adapters` of game settings. LOCAL has no environment in game settings, and has every adapter key that is in at least one of DEV, STG, PROD, with the value `fake`
- The keys of `adapters` are `login-apple`, `login-google`, `iap-apple`, `iap-google`, `ads`, `push-fcm`, `push-apns`, `turn`, `cdn`, `analytics`. Client and server use the same keys. Only the server uses `turn`, `cdn`, `analytics`
- A real adapter name contains the provider. e.g. `iap-apple`, `cdn-r2`. A sandbox adapter name is the real adapter name with `-sandbox` appended. The fake adapter name is `fake`. The usable names are set by the module spec that uses that key
- A fake adapter runs the same verification as the real adapter (game, account, product, transaction), and test helpers can set its result
- `create_fake_adapter(adapter key)`, which `dev/adapters/fake.ts` of the module that uses that adapter key exports, makes a fake adapter. The output is `adapter` (the fake adapter) and `controller` (the fake adapter controller that the `testing` operation `fake` returns). When a server instance chose the fake adapter for an adapter key and `server.fake_adapters` has no value for that key, `create_<module>_dev` of that module makes it with this function. In a server instance that does not include DEV code, this is a server start failure. A fake adapter call with failure condition `timeout` does not end until the `network_time_limit` signal of the calling module is aborted; `communication_failure` and `rejected` fail at once
- The real adapters and sandbox adapters that verify signatures with public keys (`login-apple`, `login-google`, `iap-apple`, `iap-apple-sandbox`, `iap-google`, `ads-admob`) receive a key source when made. A key source is a function that returns the provider's public key list or root certificate that the adapter uses for signature verification, and returns a fetch failure or an exceeded time limit as a failure. In TypeScript, a key source is an async function without input; its output is that value, and its failure values are `timeout`, `communication_failure`. The server passes a key source that gets the value from the source that the module spec setting that adapter states. The test server of `testing` passes, through the key source override of the `routing` operation `create_server`, a key source that returns the values that the test set
- DB adapter: SQLite (LOCAL) and PostgreSQL (DEV, STG, PROD). The transaction semantics (one request = one transaction, per-user serialization, reading one's own writes) are the same on both DBs
- An external service call has a total time limit and fails when it exceeds it. The time limit is a core settings key of the calling module. When the response body exceeds `routing.externalMaxResponseBytes`, reading stops and the call counts as a failure
- Adapters read secrets from the host secret store. When they cannot be read, the server does not start. The LOCAL server and the test server of `testing`, regardless of environment, do not read the host secret store and receive the secret values in the file of server start argument `--secret-file`. Those values are made anew at each start by the runner that starts the server or by the `testing` operation `start_test_server`. The received secrets are `accessTokenKey`, the admin secret of operator `ogw`, which has every role, `updateSigningKey`, `iapAccountToken`, `devAccess`, and the connection string of the PostgreSQL DB when one is used; a test server also receives the secrets that `start_test_server` sets

## log

- One line is one JSON object. The levels are `debug`, `info`, `warn`, `error`
- Every line has the common fields `time` (Unix ms), `level`, `kind`, `user_id`, `request_id`, `request` (the request name of the contract; for an admin request, the admin operation name), `message`. A missing value is `null`
- `kind`: `request` (one line per request), `error`, `security`, `audit` (operations actions and grants), `game` (logs that content code leaves), `core` (the `debug`, `info`, `warn` logs that core modules leave and that are not `request`, `security`, `audit`)
- Messages are in English
- Logs do not contain secrets, tokens, raw receipts, personal information, request bodies and response bodies. Exceptions: `request_body` of the `request` log that `logging` sets (not kept for a request with the `rpc` option `(ogw.sensitive)`), the verified admin input in `audit` logs, the truncated IP in `security` and `audit` logs
- truncated IP: the client IP address with only the first 24 bits kept for IPv4 and the first 48 bits for IPv6, and the remaining bits set to 0. When a log keeps an IP, it uses only the truncated IP

## calculation and time

- Currency, quantities and times are calculated as integers. A multiplier is a permille integer
- `int64` values (`int64` of the contract and data generated code, `int64` columns of `storage`) are calculated as `bigint` and not converted to `number`
- A big encoding pair of the contract is read and written as one `bigint` value
- Integer division, remainder and permille application in handlers and hooks use the `validation` operations `floor_div`, `floor_mod`, `apply_permille`. Division and permille application of values that can be outside int64 (values of big encoding pairs) use the `validation` operations `big_floor_div`, `big_apply_permille`. Core modules use the ⌊ ⌋ and ceil calculations written in the spec as they are
- A time is Unix ms and a duration is ms. The system clock is read only through the adapter of `server-time`, and periodic handling and waiting for a duration use only the `server-time` operations `schedule_job` and `sleep`. The time limit of network input and output is measured only with the `server-time` operation `network_time_limit`
- Times (Unix ms), durations (ms), game day numbers and period numbers in the server core API (operation inputs and outputs, ctx fields, hook inputs and outputs, test helpers) are `bigint`. e.g. `request_time` of ctx; in `server-time`, `now`, `clock_now`, `user_now`, the target of `is_reached`, `get_day_number`, `get_period_number`, the period of `schedule_job`, the ms of `sleep`; the expiry time of the `storage` operation `put_game_state`; the `testing` operations `set_time`, `advance_time`. The min, max and output of the `storage` operation `random_int` are also `bigint`
- Core settings values and game settings values are read as `number`. They are converted with `BigInt` when calculated with `bigint` values
- Game day numbers, dates, reset period boundaries and period numbers are set with the `server-time` operations `get_day_number`, `get_period_start`, `get_next_reset`, `get_period_number`
- Conversion and comparison of strings, numbers and times are independent of locale
- DB queries pass values only as parameters

## DEV code

- DEV code (e.g. cheat, test helper, fake callback) is kept only in `server/dev/` and in `dev/` of core module folders
- Whether DEV code is included is decided per server instance. A server instance started by the server process entry point includes DEV code when the server code has core's `dev/` or `server/dev/`. For the test server of `testing`, the environment of `start_test_server` decides
- A server instance whose `--env` is `STG` or `PROD` does not start when it includes DEV code

## server start

The server process entry point is `server/core/start.ts`. It is started with `node core/start.ts <server start arguments>` with `server/` as cwd. The entry point calls the `routing` operation `create_server` with the server start arguments below and runs `start` on that server instance. `create_server` also makes the test server of `testing`, with the same arguments.

| argument | value | rule |
|---|---|---|
| `--env` | `LOCAL`, `DEV`, `STG`, `PROD` | Always received. For `DEV`, `STG`, `PROD`, the server uses the values of that environment from game settings |
| `--port` | port number | 8080 when omitted. 0 means a port that is free on all addresses and on `127.0.0.1` together. The server instance listens on this port on all addresses and also binds `127.0.0.1`: on macOS a listener on all addresses does not block `127.0.0.1`, so another socket (e.g. a published Docker port) takes the requests to `127.0.0.1`. Giving a port that another socket has bound on `127.0.0.1` is a server start failure |
| `--matchmaker` | none | Received only by the server instance that opens `/realtime` in a realtime game |
| `--db` | SQLite file path or `postgresql` | Received only by the LOCAL server and test servers, and required for them. With `postgresql`, the server uses the PostgreSQL connection string in key `db` of the `--secret-file` file, and does not start when that key is missing. The PostgreSQL connection string contains a password, so it is not put on the command line |
| `--secret-file` | file path | Received only by the LOCAL server and test servers. The file is a JSON object that holds every secret value that `## adapter` lists as received through a server start argument; the key is `<secret key>` and the value is the secret value string. `<secret key>` is `accessTokenKey`, `updateSigningKey`, `iapAccountToken`, `devAccess`, and `db` when `--db` is `postgresql`; for the admin secret of an operator it is `adminSecret.<operator name>` (e.g. `adminSecret.ogw`), and for an adapter secret that a test server also receives it is that secret's `environments.<ENV>.secrets` key. The server reads the file at start, and does not start when it cannot read the file or the file is not a JSON object |

## server image

The contents of the server image that the DEV, STG and PROD servers run in, and the container run rules, are in [server-image.md](server-image.md).
