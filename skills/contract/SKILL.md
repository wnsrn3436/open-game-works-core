---
name: contract
description: Holds the contract (protobuf) file layout, writing rules, request options and field validation options, response envelope, UserState delta, error code, realtime message, backward compatibility, and the code the contract tool generates. Read when writing or fixing the contract, when checking code against the contract in hardening, and when making, fixing or reviewing the contract tool
---

# contract

## file

A game's contract is in `contract/`.

| file | contents |
|---|---|
| `service.proto` | the `rpc`s of `service Game` and their request messages and response messages, and module messages |
| `user_state.proto` | kinds of saved user state that are sent to the client |
| `server_state.proto` | kinds of saved user state that are not sent to the client |
| `game_state.proto` | kinds of saved state of the whole game that do not belong to a user. Not sent to the client |
| `error.proto` | `enum GameError` |
| `realtime.proto` | realtime messages exchanged between clients |
| `cheat.proto` | the `rpc`s of `service Cheat` and their request messages and response messages. Generated only as DEV code |

- The base proto that core uses (envelope, core `rpc`, core error, core option) is in the core release, and the contract tool puts the `--base-proto` folder on the import path. Its contents and the rules for using it are `## base proto` of [`server-core`](../server-core/SKILL.md). A game does not edit the base proto. The base proto does not use data enums or types generated from data
- module message: a game message that a core module handles as bytes. These are `MatchResult` and `MatchInputLog` for `matchmaker`, `PlaySessionResult`, `PlaySessionLoadout`, `PlaySessionStartOptions`, `PlaySessionContinueOptions` for `play-session`, and `PublicProfile` for `public-profile`. The module messages that a game using a module must define are set by that module's spec. The contract tool blocks with an error when a module message that a module in `--modules` requires to be defined is not in `service.proto`. A module message that is not defined is generated as a message without fields, and its validator always passes
- A file that is not used is not created. When `contract/` has a file or folder other than the files in the table, the contract tool blocks with an error
- Messages and enums other than the ones in the table (e.g. item message, kind enum) go in any game contract file. Game contract files import each other. As exceptions, a file other than `cheat.proto` does not import `cheat.proto`, and a message of `cheat.proto` does not use a type in `server_state.proto` or `game_state.proto` as a field type. A type of a file other than `cheat.proto` does not reach, by following field types, a type in the DEV type set of the base proto ([tool.md](tool.md)). On a violation, the contract tool blocks with an error

### base proto file

The base proto is two files under the import path root.

| file | package | contents |
|---|---|---|
| `ogw/options.proto` | `ogw` | core option declarations |
| `ogw/core.proto` | `ogw.core` | all of the base proto other than core options. Includes `service Core`, `service CoreCheat` and their messages |

- The contract tool and the data tool also put protobuf's `google/protobuf/descriptor.proto` on the import path
- A game contract file adds `import "ogw/options.proto";` when it uses a core option, and `import "ogw/core.proto";` when it uses a message or enum of the base proto. A base proto type is written as `ogw.core.<name>`
- `ogw/core.proto` follows the writing rules except the package rule. The field numbers of a base proto message whose fields this document sets as a `<type> <field>` list (`ResponseEnvelope`, `ServerError`, `UserStateDelta`, `UserStateEntry`) start at 1 in list order. A new field is added at the end of the list
- `ogw/options.proto` holds only option declarations and is not a target of the writing rules. Its content is exactly as below. The fields of `FieldRules` are proto2 `optional` so that whether an option was written can be told apart

```proto
syntax = "proto2";
package ogw;

import "google/protobuf/descriptor.proto";

extend google.protobuf.FileOptions {
  repeated string core_errors = 51001;
}

extend google.protobuf.MethodOptions {
  optional bool silent = 51002;
  optional bool retry = 51003;
  optional string errors = 51004;
  optional bool sensitive = 51007;
}

extend google.protobuf.MessageOptions {
  optional bool public = 51005;
  repeated int64 converters = 51008;
}

extend google.protobuf.FieldOptions {
  optional FieldRules v = 51006;
}

message FieldRules {
  optional int64 min = 1;
  optional int64 max = 2;
  optional int64 max_len = 3;
  optional int64 max_chars = 4;
  optional int64 min_count = 5;
  optional int64 max_count = 6;
  optional string table = 7;
  optional bool unique = 8;
  optional string min_key = 9;
  optional string max_key = 10;
  optional string max_len_key = 11;
  optional string max_chars_key = 12;
  optional string max_count_key = 13;
}
```

e.g. the beginning of a game contract file, and options

```proto
syntax = "proto3";
package game;

import "ogw/options.proto";
import "ogw/core.proto";

service Game {
  // receives the quest reward
  // changes: QuestUserState, ItemBalanceUserState
  rpc ClaimQuestReward(ClaimQuestRewardRequest) returns (ClaimQuestRewardResponse) {
    option (ogw.retry) = true;
    option (ogw.errors) = "GAME_ERROR_QUEST_NOT_COMPLETED";
  }
}

message ClaimQuestRewardRequest {
  int32 quest_id = 1 [(ogw.v) = {table: "quest"}];
  repeated int32 slot_ids = 2 [(ogw.v) = {max_count: 10, min: 1, max: 100, unique: true}];
}

message ClaimQuestRewardResponse {
}

// reward preview on the quest list screen
message QuestRewardPreview {
  int32 quest_id = 1;
  repeated ogw.core.ItemAmount items = 2;
}
```

## writing rules

- Written in proto3. The package is `game`
- The contract does not use nested message, nested enum, `oneof`, `map`, `optional`, group, or streaming `rpc`
  - A list of keys and values is written as `repeated` of a top-level item message. The receiving side rejects duplicate keys
  - Values of several kinds are written as a kind enum and a field per kind. A field that is not selected must be the default value, and a wrong combination is rejected
- The game contract and the base proto use only the scalar types `int32`, `int64`, `float`, `double`, `bool`, `string`, `bytes`. The contract tool blocks other scalar types (e.g. `uint64`, `fixed64`, `sfixed64`, `sint64`) with an error
- Message and enum names are PascalCase and unique across all contract files. Field names are snake_case
- PascalCase: a name that matches `^[A-Z][A-Za-z0-9]*$` and does not have two uppercase letters in a row. e.g. `UiState` matches and `UIState` does not
- Options are only the core options this document sets and `deprecated`. `deprecated` is used on file, `service`, `rpc`, message, field, enum, and enum value. The contract tool blocks other options with an error
- A message or enum name of the game contract is not the name of an `rpc` of `service Game` or `service Cheat` followed by `Handler` or `Error`. The server generated code makes a type of that name for each such `rpc`. On a violation, the contract tool blocks with an error
- An enum value name is `<ENUM_NAME>_<VALUE>`. `<ENUM_NAME>` is the enum name and `<VALUE>` is the name of the value, both written in UPPER_SNAKE. e.g. `LOGIN_PROVIDER_APPLE` of `LoginProvider`. The first value is `<ENUM_NAME>_UNSPECIFIED = 0`
- The contract tool checks, separately in the game contract and in the base proto, that enum value names are unique in the package, and blocks with an error when they overlap
- A base proto enum value name that a spec or skill writes without the prefix refers to the value whose name is that name converted to UPPER_SNAKE with the prefix added. e.g. `IapRefund` of `ItemChangeSource` is `ITEM_CHANGE_SOURCE_IAP_REFUND`
- When a name equals a reserved word of a generation target language or a built-in type name of an engine, the contract tool blocks with an error. It also blocks with an error when a message or enum name of the game contract equals a message or enum name of the data proto or a client core type name (per-engine `### generated code` of [`client-core`](../client-core/SKILL.md)). It also blocks with an error when a message or enum name of the base proto equals a client core type name
- A time is `int64` Unix ms, and a duration is `int64` ms. Field names end in `_at`, `_ms`. When a field whose name ends in `_at` or `_ms` is not `int64`, the contract tool blocks with an error
- A state with a duration saves the start time (`started_at`) and the ID value of its target, and its end is calculated with the duration in data. An effect without an end leaves the duration in data empty
- Only a state whose end time is fixed at the moment it is decided and must not change when data changes saves the end time (`ends_at`). e.g. a purchased period pass, an active window an operator set, mail expiry
- Currency, quantity and probability are written as integers. A multiplier is a permille integer
- big integer: a decimal integer string that is `0`, or a string of ASCII digits that starts with `1` to `9` and can have `-` in front
- A quantity that can exceed 2^53−1 is carried in big encoding in a pair of an `int64 <name>` field and a `string big_<name>` field. When the absolute value of value v is 2^53−1 or less, `<name>` is v and `big_<name>` is the empty string. Otherwise `<name>` is 0 and `big_<name>` is the big integer of v. The receiving side reads the value of `big_<name>` when it is not the empty string, and `<name>` as the value when it is empty. The contract tool checks, for each `string` field whose name starts with `big_`, that the same message has an `int64` field whose name is that name without `big_`
- A field that points to a target in data is an `int32` that holds an ID value. Field names end in `_id`
- The game contract does not import the data proto. When it imports it, the contract tool blocks with an error. A data enum value is put in an `int32` field, and the field comment writes the `type` of the data enum. When `min`, `max` are declared on that field, they are set to the range of values accepted from that enum
- The meaning is written as a comment above each `rpc`, message, and field. An `rpc` comment writes what the server does, and its last line writes the saved state that the handler and hooks can change as `changes: <saved state>`. When it changes no saved state, it is `changes: none`. Changes in the request start step and pending delta delivery are not written. When the last line does not start with `changes:` or nothing follows `changes:`, the contract tool blocks with an error. The `changes:` values of the core `rpc`s and core cheats of the base proto are set by `## request` of [`server-core`](../server-core/SKILL.md)

## request

- One request is one `rpc`. The services that have `rpc`s are `service Game` for game `rpc`s, `service Cheat` for game cheats, `service Core` for the core `rpc`s in the base proto, and `service CoreCheat` for core cheats
- An `rpc` name is a PascalCase verb phrase. e.g. `ClaimQuestReward`. Core and game can use the same name
- In every service, the request message is `<Name>Request` and the response message is `<Name>Response`. They exist even when empty. The name of any other message does not end in `Request` or `Response`
- transport: `POST /<Name>` for a game `rpc` and `POST /core/<Name>` for a core `rpc`. The body is the protobuf bytes of the request message
- cheat: `POST /cheat/<Name>` for a game cheat and `POST /core/cheat/<Name>` for a core cheat
- The request name is the path without the leading `/`: `<Name>` for a game `rpc`, `core/<Name>` for a core `rpc`, `cheat/<Name>` for a game cheat, `core/cheat/<Name>` for a core cheat. Even when core and game have the same `rpc` name, their request names differ. Request signature, kill switch, log, saved response, and the failure information of the client refer to a request by its request name
- `rpc` options
  - `(ogw.silent) = true`: a request sent without user action. When it fails, client core does not display the failure on screen
  - `(ogw.retry) = true`: on a communication failure, client core sends it again with the same request ID. The server returns the response saved for the same request ID. The `rpc`s of `service Game` and `service Core` whose `changes:` is not `none` carry this option. The exceptions are the core `rpc`s `Login`, `AutoLogin`, `RefreshToken`, which are sent with `NetworkCore.send_auth`. On a violation, the contract tool blocks with an error. So the delta of a saved state change whose response was lost is received with the saved response of the request sent again, and when a `Retry` request uses up its resends, it goes to the title through the retry exhausted popup and the delta is received with the full delta of login. When a request that is not `Retry` ends with a communication failure, `NetworkCore` sends the next core `rpc` `Resync` with `full` and receives the full delta
  - `(ogw.sensitive) = true`: the request body has a token, receipt, social login credential, or personal information. The server does not keep `request_body` in the `request` log of that request, and client core does not keep the body of that request in the log and the request record. A game `rpc` also carries it when its request message has such a value
  - `(ogw.errors)`: lists, separated by commas, the full names of the `GameError` values this request can return. e.g. `(ogw.errors) = "GAME_ERROR_NOT_ENOUGH_GOLD,GAME_ERROR_QUEST_NOT_COMPLETED"`. The contract tool blocks with an error a name that is not in `GameError`, a name written twice, and `GAME_ERROR_UNSPECIFIED`. Core errors are not listed
- File option `(ogw.core_errors)` of `service.proto`: lists, per core `rpc`, the `GameError` values that a content hook can return for a core `rpc`. One option is one core `rpc`, and its value is the core `rpc` name, `:`, and the full names of `GameError` values joined with commas. e.g. `option (ogw.core_errors) = "StartPlaySession:GAME_ERROR_NO_LIVES,GAME_ERROR_STAGE_LOCKED";`. The contract tool blocks with an error an `rpc` name that is not in base proto `service Core`, the same core `rpc` written in two options, a name that is not in `GameError`, a name written twice in one option, and `GAME_ERROR_UNSPECIFIED`
- Every request has a request ID. When the same request is sent again, it uses the first request ID
- Server core handles the common header, authentication, request signature, and request ID. Content code does not handle headers

## field validation

Input constraints are declared in field option `(ogw.v)`. The contract tool generates a validator that runs on the server before the handler. A request that violates a declaration does not call the handler and ends with core error `INVALID_REQUEST`.

| option | target type | meaning |
|---|---|---|
| `min`, `max` | integer | range of the value |
| `max_len` | `string`, `bytes` | byte length limit |
| `max_chars` | `string` | code point count limit |
| `min_count`, `max_count` | `repeated` | range of the element count |
| `table` | ID value `int32` | the value must be in `id` of that data table |
| `unique` | `repeated` | no duplicate elements |

- The fields of request messages, `MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions` and the messages reachable from them declare the options below. When one is missing, the contract tool blocks with an error
  - `string`: `max_len` or `max_chars`
  - `bytes`: `max_len`
  - `repeated`: `max_count`
  - integer: `min` and `max`, or `table`
- `min`, `max`, `max_len`, `max_chars`, `table` of a `repeated` field are checked per element
- The contract tool treats the tables in `TableNames` of `server/generated/data/game_data.proto` as the tables of the server build target. The `table` option of a game contract field, and the `table` option of a base proto message field reachable from a request message of the game contract and from `MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions`, point to a table of the server build target. Otherwise the contract tool blocks with an error. For a core `rpc` or core cheat of the base proto, when even one table of the `table` options reachable from its request message is not in the server build target, the contract tool does not make the server field validator of that `rpc`
- The base proto can use `min_key`, `max_key`, `max_len_key`, `max_chars_key`, `max_count_key`, which write a core settings key instead of a number. The value is a core settings key name, and the number is the integer of that key in the core settings values the contract tool received when it makes code. The game contract does not use `_key` options
- The contract tool also generates the validators of `MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions`, because `matchmaker` and `play-session` decode the bytes of these messages sent by the client and pass them to hooks
- A condition that cannot be declared (a condition that depends on saved state, a condition between fields) is checked by the handler and returned as a `GameError`

## response

- Every response comes in `ResponseEnvelope` of the base proto. Its fields are `int64 server_time_at`, `ServerError error`, `UserStateDelta user_state` (the UserState delta changed by this request), `UserStateDelta pending_user_state` (the UserState delta changed by out-of-request changes), `repeated ItemChange item_changes` (list of item changes from this request and out-of-request changes), `repeated ItemMail item_mails` (list of items sent by mail because this request and out-of-request changes could not grant them directly), `bytes body` (response message bytes)
- A server error is also returned with HTTP 200 and the envelope. Only a failure where the envelope cannot be made has an HTTP status other than 200
- `user_state`, `pending_user_state`, `item_changes`, `item_mails`, `body` of an error response are empty. The saved state did not change

## UserState

- A UserState kind is a top-level message named `<Name>UserState` and is only in `user_state.proto`. e.g. `QuestUserState`
  - list kind: a kind with field `int64 id = 1`. e.g. quest, equipment
  - single kind: has no `id`. e.g. profile, settings
- A UserState kind that core defines (e.g. item balance `ItemBalanceUserState`) is set by the spec of that server module. A game does not define items as a UserState kind
- A UserState delta is base proto message `UserStateDelta` (`bool full`, `repeated UserStateEntry entries`). `UserStateEntry` is `string kind` (kind message name. e.g. `QuestUserState`), `int64 id` (item ID of a list kind. 0 for a single kind), `bytes value` (protobuf bytes of the kind message for an upsert, empty bytes for a delete), `bool deleted`
- Entries are ordered in kind order (the order of `## core UserState kind` of [base proto table of `server-core`](../server-core/base-proto.md), then the declaration order of `user_state.proto`), and within the same kind, upserts in ascending order of item ID, then deletes in ascending order of item ID. The client applies entries in entry order
- The delta of a login response, and `user_state` of a response of the core `rpc` `Resync` whose request field `full` is `true`, have `full` `true` and hold the whole UserState. The client clears its cache and applies it
- Changes sent to the client go only as UserState deltas. Server core makes the delta from the changes to saved state. A handler does not make deltas
- UserState changed by an out-of-request change (`### transaction` of [`storage`](../server-core/modules/storage.md)) accumulates as a pending delta and is carried in `pending_user_state` of the next success response of that user. When the same item is in both deltas, both get the same value as of commit time
- A UserState delta is the state after the change, not the amount of change. The amount of item change comes as `ItemChange` in `item_changes`. Its fields are set by `item-ledger`, and its order is the order `item-ledger` recorded. Items sent by mail come as `ItemMail` (mail ID, `ItemChangeSource`, `ref`, list of `ItemAmount`) in `item_mails`
- A server state kind is a top-level message named `<Name>ServerState` and is only in `server_state.proto`. Server state kinds are not put in deltas. Enum names do not end in `UserState`, `ServerState`, `GameState`. Server-only values for judgement (next reward seed, fraud detection counter) go in a server state kind
- A kind of `user_state.proto` with message option `(ogw.public) = true` is a public kind. Handlers and hooks of other users read it with the `storage` operation `read_public_state`. A public kind holds only values that can be shown to other users, and holds no personal information and no server-only values for judgement. e.g. profile decoration, async PvP defense deck
- A game state kind is a top-level message named `<Name>GameState` and is only in `game_state.proto`. It has field `int64 key = 1`. It holds values that several users share (e.g. shared boss HP, guild-level progress). Game state kinds are not put in deltas
- The names of the UserState, server state, and game state kinds of a game differ from base proto kind names. When one is the same, the contract tool blocks with an error

## error code

- An error is base proto `ServerError` (`int32 code`, `string detail`, `BanDetail ban`). `code` holds both core errors and game errors. `ban` is filled only when `code` is `BANNED`, and `BanDetail` is set by [`routing`](../server-core/modules/routing.md)
  - core error: `CoreError` of the base proto. From 1 to 999, and the names and numbers are the `## CoreError` table of [base proto table of `server-core`](../server-core/base-proto.md). e.g. `INVALID_REQUEST`, `UNAUTHORIZED`, `TOKEN_EXPIRED`, `RATE_LIMITED`, `MAINTENANCE`, `INTERNAL`
  - game error: `GameError` of `error.proto`. The values other than `GAME_ERROR_UNSPECIFIED` (0) are 1000 or more. `<VALUE>` writes the failure reason. e.g. `GAME_ERROR_NOT_ENOUGH_GOLD`, `GAME_ERROR_QUEST_NOT_COMPLETED`. Even when the game contract has no `GameError`, the server generated code has a `GameError` with only `GAME_ERROR_UNSPECIFIED`
- `detail` is filled only in an environment that includes DEV code
- The text and behavior the client shows when it receives a game error are set by client content code. The text is written as a reserved string

## realtime

- `realtime.proto` defines only messages between clients. It does not know the transport (P2P connection, a later server-authoritative realtime server)
- `RealtimeCore` sends and receives realtime messages only as bytes. Content code sends with encode of the generated `RealtimeMessage` and receives with its decode
- A message is written as the kind enum of `RealtimeMessage` and a field per kind
- A received message is external input. The receiving content code checks its format and range, and discards a message that does not match
- Content code picks the channel per message, from `Reliable` and `Unreliable`

## backward compatibility

After the first PROD build, compatibility is kept by comparing with the contract of the last PROD build. The comparison targets are the game contract and the base proto, and the `_key` options of the base proto are compared by their filled numbers. The contract tool compares them and blocks a change that breaks compatibility with an error.

- Compatible changes are a new `rpc`, a new message, a field with a new field number, a new enum value, a name added to `(ogw.errors)` and `(ogw.core_errors)`, an `(ogw.core_errors)` option added for a core `rpc`, `(ogw.retry)` added to an `rpc`, a change of `(ogw.sensitive)`, a new kind added to `user_state.proto`, `(ogw.public)` added to a kind, an `(ogw.converters)` value added to a kind
- Changes that break compatibility are deleting, renaming, changing the field number of, or changing the type of an `rpc`, message, field, or enum value; an `rpc` option change other than adding `(ogw.retry)`, changing `(ogw.sensitive)`, or adding a name to `(ogw.errors)`; removing a name from `(ogw.errors)` and `(ogw.core_errors)`; removing `(ogw.public)` from a kind; removing an `(ogw.converters)` value from a kind; a change that narrows a validation option (including a change where game settings `core` narrows the number of a base proto `_key` option); a change that adds, to an existing request message, `MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions` or a message reachable from them, a field whose default value does not pass field validation (a field that declares `table`, a `min` greater than 0, a `max` less than 0, or a `min_count` greater than 0)
- An `rpc` or field that is no longer used is kept with `deprecated = true`
- The server handles the requests of every supported app version. A new field that is missing from a request is read as the default value
- The contract version is the version of the saved structure, an integer of 1 or more. The contract tool sets it and puts it in the server generated code as a constant. The content agent does not set it
  - When there is no `prod-<version>` tag, it is 1
  - When there is one, with P the contract version of the last PROD build: P when the definitions (except comments and `(ogw.converters)`) of the UserState, server state, and game state kinds of the game contract and of the messages and enums reachable from them equal those of that build, and P + 1 when they differ
- The meaning of a field is not changed. When the meaning changes, the existing field is kept with `deprecated = true` and a new field is added. So a change of meaning in a kind and the messages and enums reachable from it always raises the contract version
- Saved UserState, server state, and game state are saved together with the contract version at save time. When the structure changes, a migration is used. The migration method follows the migration spec of [`server-core`](../server-core/SKILL.md)
- For each from version for which a converter is registered for a UserState, server state, or game state kind of the game, the kind message gets one line `option (ogw.converters) = <from version>;`. The value is 1 or more, less than the current contract version, and does not repeat within one kind. When it is written on another message or breaks these rules, the contract tool blocks with an error. The contract tool outputs the written (kind, from version) list to the server generated code and the converter list file ([tool.md](tool.md)). `migration` does not start the server when this list differs from the registered converters

## contract tool

The contract tool is in the core release, and the harness tool `ogw contract <game>` calls it with the core version of game settings. The generated code is written to `client/generated/contract/`, `server/generated/contract/`, and to `client/dev/generated/contract/`, `server/dev/generated/contract/`, which are DEV code. The generated code is committed and not edited by hand.

- The generated code puts the types of the base proto in the `CoreContract` namespace, the types of the game contract in `GameContract`, the base proto types of the DEV generation target in `CoreCheatContract`, and the types of `cheat.proto` in `GameCheatContract`. e.g. `CoreContract.LoginRequest`. So types of the base proto and the game contract do not collide even when they have the same name
- The namespaces, types, and methods of the generated code are set by `### generated code` of the per-engine implementation rules of [`client-core`](../client-core/SKILL.md) for the client, and by `## generated code` of [`server-core`](../server-core/SKILL.md) for the server
- When the contract is edited, the generated code goes in the same commit. When the generated code differs from the contract, the automated check blocks it
- The contents per generation target, the checks before generation, and the CLI are in [tool.md](tool.md)
