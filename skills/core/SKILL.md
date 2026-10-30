---
name: core
description: Holds the rules common to client core and server core (spec format, module dependency, lifecycle, hook, event, error handling, core settings, data used by core, collected data) and core version, release, license manifest and the `update core` procedure. Read when making, fixing or reviewing core, when content code registers a hook or handles a core failure, and when the lead agent of `setup game` decides the modules the game uses
---

# core

The procedures of core version, release, license manifest, core test and the core commands (`create contract tool`, `create server core`, `create client core`, `update core`) are in [command.md](command.md). The core agent and the lead agent of a core command read it.

## module

- Client core and server core are divided into modules. One module corresponds to one spec
- A module name is the name the code calls it by. A client core module is an engine class, so its name is PascalCase with `Core` appended. e.g. `UICore`. A server core module is a TypeScript file, so its name is kebab-case. e.g. `item-ledger`
- A module can depend on other modules. Circular dependency is forbidden. The cycle judgement does not include the modules of an `optional dependency:` line or the modules that a spec lists as depended on only by DEV code
- Core does not depend on content code. Content code passes only hooks, callbacks and data to core
- The modules the game uses are `BootstrapCore`, `routing`, `migration`, `user-snapshot-clone`, the `client` and `server` modules of game settings `coreModules`, and the dependency closure of these modules. The dependency closure follows the modules of `## dependency` and the server modules written on the `server dependency:` line of a client module. The harness tool makes the module list of `BootstrapCore` from this
- A client module writes the server modules it calls through a core `rpc`, a route or a matchmaker connection on the `server dependency:` line of `## dependency`. It also writes the server modules without which it cannot do the work of its `## purpose`. It does not write the server modules that only DEV code calls
- When a module calls another module only when that module is one the game uses, it writes that module on the `optional dependency:` line of `## dependency`. A server module takes the server module list as the module list. The dependency closure does not follow the modules of this line. When that module is not in the list, the module does not call its operations
- The dependency closure also does not follow the modules that `## dependency` lists as depended on only by DEV code. Those modules are prepared only in the environments that include DEV code
- DEV module: a module that is reached from the modules the game uses by following the dependency closure and the modules listed as depended on only by DEV code, and that is not a module the game uses. e.g. `QACore` (the DEV code of `BootstrapCore` depends on it), `cheat` (the DEV code of `routing` depends on it). Game settings `coreModules` does not list a module that another module lists as depended on only by DEV code
- prepared module: a module that one run prepares. In the environments that include DEV code (LOCAL, DEV), these are the modules the game uses and the DEV modules; in STG and PROD, the modules the game uses. The harness tool makes the server module list, the game settings values core reads and the core settings type file from the prepared modules. `ogw generate` writes them with the prepared modules of LOCAL, and `ogw build run` writes them again with the prepared modules of that environment in the STG and PROD build artifact and server image
- The generated code that core references is only the following
  - from the code the data tool makes: the row types of the tables core defines, `<Table><Column>Item`, `<Table><Column>List`, containers, the types of the enums that `## data` of a core spec points to, vector types, the accessors `GameSetting`, `ReservedId`, `ReservedString`, `ReservedSound`, the load entry point, `DataSet` of the server, the functions that client `DataCore` calls when it makes derived containers, DEV accessors
  - the code the contract tool makes
  - from the harness tool: the resource key list, the core settings values, the game settings values core reads, the module list of `BootstrapCore`, the `client/dev/` registration list, the license manifest of the game
  - build info
- The data tool makes the generated code of every table, enum and reserved row of `core-spec.json`, whether or not the module is one the game uses. So all core code that goes into the game finds the generated code above. The rules are in `## data tool` of [`data`](../data/SKILL.md)
- Core code does not contain resource key strings or file paths of game resources. For a game resource that core uses, core receives the resource key as a core settings value, an operation argument or a system table value
- Core has no resource files. A resource that core uses without a game resource is made in code or is a built-in engine resource. Default screen elements made in code (dim, loading icon, default popup) are not placeholder resources
- Core code, comments, logs and tests do not contain harness paths, role names or game names

## spec

A spec writes the public API, behavior and error handling independent of the engine. Client core specs are in [`client-core`](../client-core/SKILL.md), server core specs in [`server-core`](../server-core/SKILL.md). Engine-specific names, types and ways of running are in the engine-specific implementation rules.

A spec file has the headings below in this order. A heading with no content for it says `none`.

| heading | contents |
|---|---|
| `## purpose` | The work this module owns. One or two sentences |
| `## dependency` | All modules it depends on, written as dependency lines |
| `## API` | The operation table. Columns are `operation`, `input`, `output`, `failure value`, `caller` |
| `## behavior` | The behavior rules of operations and lifecycle. A module that implements a real adapter puts the adapter table before `### collected data` |
| `## hook` | The hook table. Columns are `hook`, `when`, `input`, `output`, `default` |
| `## event` | The event table. Columns are `event`, `when`, `payload` |
| `## error` | A table with one row per failure condition. Columns are `condition`, `failure value`, `log`. A module with a row whose failure ends in an error code puts `error code` after `failure value`. For a failure without a failure value, `failure value` holds the handling at that point. Below the table, a line that starts with "Added `CoreError`: " gives the names of the values a server module adds. Their numbers are set by the `## CoreError` table of the [base proto table of `server-core`](../server-core/base-proto.md) |
| `## settings` | The core settings keys and game settings items this module reads. Columns are `key`, `type`, `source`, `owner`, `meaning`. `type` is one of the JSON schema type names `integer`, `number`, `string`, `boolean`, `object`, `array<T>`. When the value can be `null`, `?` follows the type. e.g. `integer?`. A `game` item that can be left out of game settings, where leaving it out means something other than the empty value of its type, gets `?`, and `meaning` gives the meaning of `null`. The value that means no resource key is the empty string. `source` is `core` (a core settings key) or `game` (the path of a game settings item. For an item that exists per environment, the path has `<ENV>` in the place of the environment). `owner` holds the core settings owner of the key (`content`, `human`) for a key whose `source` is `core`, and `none` for a `game` item. Values are only in `core-settings.json` and game settings. The settings constraint table this module writes goes below the settings table |
| `## data` | The system table rows and tables this module reads. Table definitions, enum tables, used table lines, reserved names, format argument tables. The invariant table of the invariants this module sets. Invariants are written only in this table. The line above the table is `data/invariants.csv`, and the columns are `kind`, `table`, `column`, `group`, `min`, `max`, `child_table`, `child_column`. One row is one row of `data/invariants.csv`; a cell without a value is empty, and a cell with a value is written as a code span. The `LocalDataCore` key table of the keys this module uses (columns `file kind`, `key`, `type`, `meaning`) |
| `## DEV` | The table of operations that exist only in DEV code. Columns are `operation`, `input`, `output`, `caller`; when there is an operation whose `output` does not start with `none` or that has a failure value, `failure value` goes after `output`. The differences between the DEV build and the STG and PROD builds |
| `## test` | The list of behaviors that core tests check |

- Operation names are snake_case verb phrases. e.g. `open_panel`. The engine-specific implementation converts them to the engine's convention
- element name: the value used when an enum element is saved, sent or written to a log as a string. For enums of the base proto and the game contract, it is the full enum value name with its prefix. e.g. `APPLE` of `LoginProvider` is `LOGIN_PROVIDER_APPLE`. For a data enum, it is the `element` of `data/enums.csv`; for other enums, it is the element exactly as the spec writes it. e.g. `High` of `QualityLevel` is `High`. Reading is case-sensitive
- An operation, callback or method that the caller waits on until it ends is an async operation. Its `output` cell in the table starts with `async operation.`
- component: a core class attached to a UI element. e.g. `UIButton`. The operations of a component are written in the `### component` table inside `## API`. Columns are `component`, `operation`, `input`, `output`, `failure value`, `caller`. The behavior of the operations is written in `## behavior`
- Every behavior and error of a spec is written so that it can be judged. Numbers are written as core settings keys, and the spec does not write their values
- A spec points to an operation, event or hook of another module with the single code span `` `<Module>.<name>` ``. `<Module>` is the module name, and `<name>` is a name in the `## API`, `## DEV`, `## event` or `## hook` table of the target spec, or `init` or `release`. e.g. `NetworkCore.send`, `storage.run_user_transaction`. A code span that starts with a module name and `.` is one of this reference, a core settings key and a `LocalDataCore` key
- The modules and code that call an operation are set only by the `caller` cell of that operation's row. An operation that another module calls has that module in `caller`, and an operation that can be called inside a hook has `hook` in `caller`
- A table header is written only in `## data` of the one spec that defines the table. Other specs point to it by table name
- The implementation does not change before the spec changes

### tool-read form

`ogw core spec` (`## core spec file` of [command.md](command.md)) reads only the forms below from a spec. It does not read inside code fences. The same content is not written again as sentences outside these forms.

- lifecycle sentence: a line of `## purpose` that contains `has no lifecycle`
- operation table: a table of `## API` whose header starts with `operation`, `input`. Only the rows whose `operation` cell is operation name code spans joined by `, ` are read. The `input` cell is `none`, or one description per input, split at `, ` outside parentheses and code spans. An input whose description contains `translation key` is an input that receives a translation key
- dependency line: a line of `## dependency` that, after removing the leading `- ` and, when present, the label `server dependency: ` or `optional dependency: `, starts with a module name code span, and whose list of code spans joined by `, ` ends at the line end or at `. `. A comment that starts with `(` and ends with `)` can follow a code span directly. A line with the label `dev dependency: ` in place of those labels has the same form, and its modules are modules that only DEV code depends on. A line where a code span is directly followed by a character other than `, `, `(`, `. ` or the line end (e.g. `` `NetworkCore` is ``) is not a dependency line
- table definition: a line of `## data` that starts with `` `data/tables/<table>.csv` ``, and the table right after it. The table header starts with `column`, `type`, `build target`, and in each row these three cells are one code span each. As an exception, a row whose `column` starts with `#` is a comment column, and its other cells are not read. The row order is the column order of the CSV header
- enum table: the table right after the `` `data/enums.csv` `` line in `## data`. Columns are `type`, `element`. The `element` cell starts with a list of element code spans joined by `, `, or, for an enum whose elements the game sets, starts with `set by the game`. The list ends at the cell end or at `. `. When the line is `` `data/enums.csv`: none``, there is no table
- invariant table: the table right after the `` `data/invariants.csv` `` line. Its format is set by the `## data` row of the `## spec` table
- used table line: a line of `## data` that starts with `used table: `, followed by a list of the code spans, joined by `, `, of names of tables whose table definition is outside this module. The list ends at the line end or at `. `. It lists every table of another module that this module reads but does not point to with a `ref<...>` type of its own table definitions or with the `→` of a reserved name
- reserved name: the two forms below in `## data`. `<kind>` is one of `reserved ID`, `reserved string`, `reserved sound`
  - list line: a line that, without the leading `- `, starts with `<kind>` values joined by `, ` and then `: `, followed by `none` or a list of ID name code spans joined by `, `. The list ends at the line end or at `. `. A comment that starts with `(` and ends with `)` can follow each ID name code span directly, and when `<kind>` is `reserved ID` alone, `` → row of `<table>` `` can follow
  - table: a line that is exactly one `<kind>`, and the table right after it whose first column is `name`. In each row, the `name` cell is ID name code spans joined by `, `. The second cell of a `reserved ID` table can start with `` → row of `<table>` ``
  - `` → row of `<table>` `` means that the ID name the reserved ID points to must be a row of that table. When the text after `. ` of a list line or the second cell of a table contains ``required when game settings `<path>` is `<JSON value>` ``, the reserved IDs of that line or row are required only under that condition
- format argument table: a line of `## data` that is exactly `format argument`, and the table right after it. Columns are `text`, `arguments`. The `text` cell is the ID name code span of a reserved string or reserved ID, or `` `<table>.<column>` `` of a table core defines. The `arguments` cell is `` `{<name>}`(`<kind>`) `` joined by `, `, or `none`. `<kind>` is one of the value kinds `integer`, `real`, `string` of `### format` in [`data`](../data/SKILL.md). Every text that core gives values to and that has format arguments is written in this table
- adapter table: the table right after the heading of `## behavior` whose whole line is `### real adapter`. Columns are `adapter key`, `real adapter`, and in each row the two cells are one code span each. `real adapter` is the name of a real adapter this module implements (`## adapter` of [`server-core`](../server-core/SKILL.md))
- settings table: the first table of `## settings`. Its format is set by the `## settings` row of the `## spec` table
- settings constraint table: a line of `## settings` that is exactly `settings constraint`, and the table right after it. Its format is set by settings constraint in `## core settings`
- collected data table: the `### collected data` table of `## behavior`. Its format is set by `## collected data`

## lifecycle

- A client core module has one instance in the game. A caller calls operations by the module name and does not create or keep an instance
- The lifecycle is `init` and `release`. The init check is an operation that returns whether the module is in the `init` state, and every module with a lifecycle has one. `BootstrapCore` sets the call order by dependency order. A module without state has no lifecycle
- A module without a lifecycle writes `has no lifecycle` in `## purpose` of its spec. The client core modules other than `BootstrapCore` and those modules have a lifecycle
- A spec does not write `init` and `release` in `## API`. The additional work of that module's `init` and `release` and the state it keeps after `release` are written in `## behavior`
- `init` ends without waiting. A preparation that has to wait is a separate operation, called in the boot order
- `release` returns the module to its state before `init`. It deletes the registered hooks, callbacks, event subscriptions and the engine objects the module made, and stops the async operations in progress. A stopped operation returns a failure value to the caller and does not call callbacks
- When a module is destroyed by app exit without `release`, it is cleaned up the same way as by `release`
- A module after `release` can be `init` again, and behaves the same as a module after its first `init`
- As an exception, a state that the spec says is kept after `release` is not deleted by `release` and stays after the next `init`. e.g. the pending token of `AuthCore`
- An operation call before `init` or after `release` leaves an error log and returns a failure value. The init check and `release` work without a log
- As an exception, an operation that the spec says is called before `init` works before `init` and after `release`, and a call after `init` leaves an error log and is ignored. An operation whose spec writes the behavior before `init`, after `init` and after `release` separately follows that spec
- `init` of a module that is already `init` leaves an error log and returns a failure
- A server core module is prepared once at server process start and holds no state per request. State between requests is in the DB. The exception is a state that the spec says is in process memory. That state is lost when the process ends, and a new process starts with that state empty. The spec writes any separate work done when it is lost. e.g. the queue and rooms of `matchmaker`, the match session of `p2p-signaling`, caches

## hook

Content code registers hooks in core: functions that take over game-specific decisions and handling.

- hook kinds
  - validation hook: core calls it right before changing state. It returns `pass` or an error code. When core receives an error code, it does not change the state and fails with that error code
  - handler hook: core hands it a game-specific calculation or handling. e.g. calculating the contents of a reward grant, choosing the first screen after login
  - after hook: core calls it after changing state. It returns no result. A server after hook is called inside the transaction that changed the state, and content changes content state with that transaction. e.g. counting with `add_progress` in `mission` after a core rpc succeeds
- The hook table of a spec writes, per hook, when it is called, its input, its output, and the behavior when it is not registered (`default`)
- Client content code registers hooks in the content initialization of the boot order. Registering an already registered hook again leaves an error log and ignores the later registration
- owner hook: a client core hook that the spec marks as an owner hook below the hook table. Content code can register an owner hook also outside content initialization, as a function of an object of a scene or prefab. That object is the owner. While the owner is alive, the hook is a registered hook. When the owner is destroyed, core deletes that registration without a log, and the hook behaves as `default` until the next registration. Registering a function that has an owner to a hook that is not an owner hook leaves an error log and does not register it. The destruction of a client object and its detection follow `## engine` of [`client-core`](../client-core/SKILL.md)
- Server content code registers hooks inside `register` of `server/main.ts`. The registration operation is `register_hook` in `routing`, and a hook registered per key is registered with the registration operation of its module (`register_requirement_judge` in `validation`, `register_converter` in `migration`, `register_user_change` in `storage`). Every registration error (a module not in the server module list, a hook name or key that does not exist, a second registration of the same target, a call outside `register`) is a server start failure
- When a core module hands handling to another core module, it registers through an operation whose caller is limited to that module, not through a hook. e.g. `AuthCore` registers the session provider with `NetworkCore`
- A hook does not call async operations. A server hook is called inside the DB transaction core opened and uses only the DB access of that transaction. It does not call external services
- When a hook throws or its output format is wrong, core leaves an error log and ends that operation as a failure. The server returns an internal error response
- When content has to do work that a hook cannot do, a core proposal is written

## event

- Core tells content code about things through events. When a result has to come back, a hook is used, not an event
- A callback that the caller passed to an operation is not an event. When the callback's object is destroyed and it cannot be called, it is not called and one error log is left. `UtilCore`, which does not call `LogCore`, skips it without a log
- An event subscriber unsubscribes at the `release` or destruction of the subscribed object

## error handling

- A client core operation returns a failure as a failure value. The spec sets the shape of the failure value per operation: a success flag, a result holding a success flag and the result, a fallback value the caller can use as is, a failure element of the result enum
- The module that detects a failure leaves an error log. Failures of the same cause are logged only once. Gameplay continues
- A real number input used in a calculation, comparison or range judgement that is NaN or infinity is handled as an out-of-range input
- An unrecoverable failure is passed to the fatal error handling of `BootstrapCore`. The fatal error handling shows an error screen that a human sees. The restart path is opened only after the UI ready of `BootstrapCore`, and an error screen without a restart path tells the human to run the app again
- The failure of an async operation is reported as the failure value of its completion result
- Server core returns an error response for every failure. The error code format follows [`contract`](../contract/SKILL.md). An unhandled exception is returned as an internal error response and leaves an error log with the request ID
- Neither client nor server uses exceptions for control flow

## core settings

- Core settings are in `open-game-works-core-impl/settings/core-settings.json`, with the JSON schema `core-settings.schema.json`. A key is `<module name>.<camelCase>`. e.g. `NetworkCore.retryCount`
- `core-settings.schema.json` is an object schema of JSON Schema draft 2020-12. It has one property per key, all keys in `required`, and `additionalProperties` is `false`. The core agent edits it together with `core-settings.json` in the commit that adds or changes a key
- The `core` object of game settings overrides core settings values. Objects are merged per key; arrays and values are replaced whole
- Core settings hold only values that have a default all games can share. Values that each game has to set (reference resolution, first scene, terms documents, secret names) are game settings items, and core reads them as the values the harness tool makes from game settings
- The `core` of game settings is written only to change core settings defaults
- core settings owner: who edits a core settings key in game settings `core`. `content` means the content agent edits it in the loop, and `human` means only a human edits it (the one exception is the `UnitTestCore.testTimeLimitMs` that `ogw game init` writes into a new game's settings draft, which step 10 of `game-setup` shows the human). The keys that automated checks, telemetry and the judge use for judgement, and the keys that set the conditions under which the play and the judge of the loop play (e.g. DEV network simulation values), are `human`; the rest are `content`. `owner` of spec `## settings` holds that value, and `core-settings.schema.json` puts `"x-owner": "human"` on the keys whose `owner` is `human`
- The game settings values the harness tool passes to core are all items whose `source` is `game` in `## settings` of the core specs of the prepared modules (`## module`). An item missing from game settings gets the `default` of the game settings schema; when there is no `default`, an item whose type ends in `?` gets `null`, and the rest get the empty value of the type (the empty string for `string`, 0 for `integer` and `number`, `false` for `boolean`, an empty list for `array<T>`, an empty object for `object`). An item with `<ENV>` in its path is passed per environment of game settings `environments`. The build artifact and the server image hold only those of the build's environment
- Core code does not contain core settings values. Overridden values are checked with `core-settings.schema.json` and the settings constraints of that core version
- settings constraint: a condition between two core settings keys that JSON schema cannot express, `left` value × `factor` ≤ `right` value. A spec writes a settings constraint only as a settings constraint table in `## settings` of the module spec of one of the two keys. The same condition is written in only one spec. A settings constraint table is the line `settings constraint` and the table right after it, and one row is one condition. Columns are `left`, `factor`, `right`. `left` and `right` are a code span of one core settings key each, and `factor` is an integer of 1 or more. e.g.:

  ```
  settings constraint

  | left | factor | right |
  |---|---|---|
  | `NetworkCore.requestTimeoutMs` | 2 | `InputBlockCore.maxDurationMs` |
  ```

- `ogw core release` merges the settings constraints of all modules into the release asset `core-settings-constraints.json`. This file is a JSON array whose items are `{"left": "<core settings key>", "factor": <integer>, "right": "<core settings key>"}`
- `ogw game check` evaluates the condition of each item of `core-settings-constraints.json` of that core version with the core settings values merged with game settings `core`, and fails when any item is violated
- Duration values are integers in ms, and byte sizes are integers
- The value range of a core settings key follows the rules below, and `core-settings.schema.json` writes it with `minimum`, `maximum`, `exclusiveMinimum`. A spec writes only a range that differs from these rules, in `meaning` of `## settings`, and a key with a written range follows only that range instead of these rules
  - `integer` and `number` keys are 0 or more
  - An `integer` key whose name ends in `Count`, `Size`, `Length`, `Bytes`, `Chars` or `Max` is 1 or more
  - A key whose name ends in `FactorPermille` is 1000 or more. Other keys whose name ends in `Permille` are 1000 or less
  - A key whose name ends in `Opacity` is 1 or less

## data used by core

- Core receives the text it shows to humans as reserved strings and the sounds it plays as reserved sounds. Naming rules and table format follow [`data`](../data/SKILL.md)
- The general tables core defines are in `data/tables/`. e.g. the tutorial step table. The enum elements and invariants core sets are written in `## data` of the spec
- The rules for putting the reserved names, table headers, enum elements and invariants written in `## data` of a spec into game data and checking them follow core data in [`data`](../data/SKILL.md)
- The rules for table rows, cell values and reserved rows written in `## data` of a spec are data checks. The binary build fails on a data check ERROR, and then `ogw instance start`, `ogw check` and `ogw build run` stop and do not start a server with that data. When a spec writes `the server does not start` in a data rule, it means this result. A server module does not check those rules again at server start, and the `## test` items of those rules are checked with data tool tests

## collected data

The store privacy disclosure is based on collected data. The build makes the store answers from these declarations.

- A module that saves data the user inputs or that it reads from the device, or sends it off the device, writes that data in the `### collected data` table at the end of `## behavior` of its spec. Data that goes to the server is written by the server module that receives and saves it, and data that goes to another company without passing through the server is written by the client module that sends it
- For each real adapter name (`## adapter` of [`server-core`](../server-core/SKILL.md)), the core specs together have one or more rows whose `source` is that name. An adapter that collects no data has one row whose `data type` is `none`
- Columns of the `### collected data` table

| column | value |
|---|---|
| `data type` | One value of the data type table below |
| `description` | The data collected. One sentence |
| `source` | `module` or a real adapter name. With an adapter name, it is collected only in environments that chose that adapter or the adapter whose name is that name with `-sandbox` appended |
| `purposes` | A list of values of the purpose table below |
| `linked` | Whether it is saved or sent tied to a user ID or account |
| `tracking` | Whether it is combined with other companies' data and used for ad targeting or passed to a data broker |
| `shared` | Whether it is passed to another company that is not a service provider handling it on behalf of the operator |
| `optional` | Whether the user can use the game without giving that data |
| `platforms` | The list of platforms where it is collected, or `all` |
| `condition` | `none` or `<game settings path> = <JSON value>`. It is collected only in games where that game settings value is that JSON value. A game settings item that is not written counts as the `default` of the game settings schema |

- In a row whose `data type` is not `none`, `linked`, `tracking`, `shared`, `optional` are `true` or `false`
- A row whose `data type` is `none` has `none` in `purposes`, `linked`, `tracking`, `shared`, `optional`, `platforms`, `condition`

data type

| data type | meaning |
|---|---|
| `none` | No data is collected |
| `user_id` | An ID that points to a user or account. e.g. user ID, login token, social account ID |
| `device_id` | An ID that points to a device. e.g. push device token, advertising ID |
| `nickname` | A name the user sets that other users see |
| `purchase_history` | Purchase records |
| `product_interaction` | Analytics events, records of screen and button use |
| `gameplay_content` | Saved game state, scores, ranks, friend and guild relationships |
| `in_app_messages` | Messages and report texts the user sends to other users or the operator |
| `other_user_content` | Content the user writes or uploads that is not another value of this table |
| `crash_data` | Crash and error records |
| `performance_data` | Records of run duration, frames, loading duration |
| `advertising_data` | Records of the ads the user saw and ad responses |
| `coarse_location` | Approximate location derived from the IP address |
| `other_data` | Personal data that is not another value of this table. e.g. year and month of birth |

purpose

| purpose | meaning |
|---|---|
| `app_functionality` | Providing game features |
| `account_management` | Creating and managing accounts |
| `analytics` | Usage analysis |
| `product_personalization` | Content or recommendations that differ per user |
| `developer_communications` | Operational notices the operator sends |
| `developer_advertising` | The operator's own ads and marketing notices |
| `third_party_advertising` | Display of other companies' ads |
| `fraud_prevention` | Fraud prevention, security, legal compliance |

- The data content collects is written in game settings `privacy.contentData`. The rules are in `## collected data` of [`server-content`](../server-content/SKILL.md)

## DEV code

- The DEV code of core is in `dev/` folders and is not included in STG and PROD builds. Core code that is not DEV code does not call DEV code
- Operations of DEV code are written only in `## DEV` of the spec
