# validation

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

Runs, before the handler, the field validators that the contract tool generated from `(ogw.v)` declarations, and provides the helpers that a handler uses to check conditions that cannot be declared, normalization and banned word checks of text written by humans, integer calculation helpers that give the same results as the client, and the condition judgement of the `requirement` table.

## dependency

- `storage`
- `item-ledger`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `validate_request` | request name, decoded request message | `pass` | the failed field path and rule | `routing` |
| `validate_message` | message name (`MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions`), decoded message | `pass` | the failed field path and rule | `matchmaker`, `play-session` |
| `is_in_range` | integer, min, max | `true` when it is at least min and at most max | `false` | content handler, hook, core module |
| `has_table_id` | table name, ID value | `true` when it is in `id` of that table in the server build data | `false` | content handler, hook, core module |
| `is_unique` | list, key function | `true` when all keys differ | `false` | content handler, hook, core module |
| `is_plain_text` | string, maximum code point count | `true` when it keeps all plain text conditions below | `false` | content handler, hook, core module |
| `normalize_text` | string | normalized string | none | content handler, hook, core module |
| `check_text` | string, maximum code point count, whether line breaks are allowed | `TextCheckResult.OK` | a failure element of `TextCheckResult`. For `BANNED`, together with the matched `banned_word` ID value | content handler, hook, core module |
| `is_kind_consistent` | message, kind field name, list of field names used per kind element | `true` when all fields other than the kind field and the fields of the selected kind are default values | `false` | content handler, hook, core module |
| `floor_div` | `a`, `b`: int64 | equals `UtilCore.floor_div` | equals `UtilCore.floor_div` | content handler, hook, core module |
| `floor_mod` | `a`, `b`: int64 | equals `UtilCore.floor_mod` | equals `UtilCore.floor_mod` | content handler, hook, core module |
| `apply_permille` | value: int64, permille: int64 | equals `UtilCore.apply_permille` | equals `UtilCore.apply_permille` | content handler, hook, core module |
| `big_floor_div` | `a`, `b`: bigint | the same number as `UtilCore.big_floor_div` | `null` when `b` ≤ 0 | content handler, hook, core module |
| `big_apply_permille` | value: bigint, permille: bigint | the same number as `UtilCore.big_apply_permille` | none | content handler, hook, core module |
| `is_platform` | string | `true` when it is one of `android`, `ios`, `web`, `windows`, `macos`, `linux` | `false` | content handler, hook, core module |
| `parse_version` | string | `major`, `minor`, `patch` (3 integers) when it is a version | none when it is not a version | content handler, hook, core module |
| `compare_versions` | `a`, `b`: output of `parse_version` | negative when `a` is lower than `b`, 0 when equal, positive when higher | none | content handler, hook, core module |
| `register_requirement_judge` | `RequirementType` element, judge hook | none | none. A registration error is a server start failure | `register` of content `server/main.ts` |
| `evaluate_requirement` | ctx, requirement ID value | `passed`, `failed_requirement_id` | a requirement ID that is not 0 and is not in the `requirement` table throws | content handler, hook, core module |

- Helpers have no state and do not receive ctx. The handler converts a failure into a `GameError`
- The int64 inputs and outputs of `floor_div`, `floor_mod`, `apply_permille` are `bigint`. The inputs and outputs of `big_floor_div`, `big_apply_permille` are `bigint` without a range limit, used for values that can be outside int64 (the values of a big encoding pair of the contract). `is_in_range` receives the three integers as `number` or `bigint` and compares them as `bigint`
- The calculations of `floor_div`, `floor_mod`, `apply_permille`, `big_floor_div`, `big_apply_permille` equal the operations of the same name of client `UtilCore`. For the same input, client and server give the same number
- output of `evaluate_requirement`: `passed` (pass flag), `failed_requirement_id` (ID value of the first failed condition. 0 when `passed` is `true`)
- TypeScript shape: `check_text` is `{result, banned_word_id}` (`result` is a `TextCheckResult` element, `banned_word_id` is 0 when not `BANNED`), `apply_permille` is `{success, value}`, `parse_version` is `{major, minor, patch}` (`bigint`). The list of field names used per kind element of `is_kind_consistent` is a `ReadonlyMap` keyed by kind value
- version: a string of the format `<major>.<minor>.<patch>`, where each of the three parts is `0` or a decimal integer that does not start with `0`. App versions and core versions have this format
- `compare_versions` compares the integers in the order major, minor, patch
- A field path is the field names joined with `.`, with `[index]` appended for a `repeated` element. e.g. `items[2].count`

`TextCheckResult`

| element | meaning |
|---|---|
| `OK` | keeps the plain text conditions and has no banned word |
| `INVALID` | violates a plain text condition |
| `BANNED` | has a banned word |

## behavior

### validator

- `validate_request` calls the validator that the contract tool generated per `rpc`. The meaning of the options follows the field validation table of the contract. The limits of `_key` options are in the validator that the contract tool generated with the merged core settings values of that game. validation does not read settings at runtime
- `max_chars` counts the code points of a value that is valid UTF-8
- `min` and `max` of an `int64` field are compared as `bigint`
- A validator checks all fields of the request message, and when a field type is a message, checks the fields inside it by the same rules
- What a validator always checks outside the declared options
  - The value of an enum field is a value defined in that enum. When it is a defined value, `_UNSPECIFIED` also passes
  - A `string` field is valid UTF-8
  - An ID value of 0 for a `table` option fails
- It stops at the first failure and returns that field path and rule. The rule name is the option name (for a `_key` option, the name without `_key`), or `enum` or `utf8`
- A field with an unknown field number is not checked
- The targets of `validate_request` are all request messages of game `rpc` and the request messages of the core `rpc` for which the contract tool made a validator. The targets of `validate_message` are `MatchResult`, `MatchInputLog`, `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions` of the game contract, and it throws for any other message name
- The request messages of game cheats and of the core cheats for which the contract tool made a validator are checked by the same rules by a validator that the contract tool made as DEV generated code. In the processing order of `cheat`, the DEV code of `routing` calls that validator
- The existence check of a `table` option uses the server build data

### helper

- `has_table_id` throws for a table name that is not in the server build data. The request ends with `INTERNAL` and `routing` leaves an `error` log
- `is_unique` compares the integers or strings that the key function returned
- plain text conditions
  - It is valid UTF-8
  - The code point count is at least 1 and at most the maximum code point count
  - It has no C0 control (U+0000 to U+001F), U+007F, C1 control (U+0080 to U+009F), U+2028, U+2029 or Unicode `Bidi_Control` character
  - It has no whitespace character (Unicode `White_Space`) at the start or end
  - The normalized string is not an empty string
- `is_kind_consistent` is `false` when the kind field is `_UNSPECIFIED`. A kind element not in the list is also `false`
- normalization (`normalize_text`): converts to NFKC, applies the locale-independent Unicode lowercase mapping, and deletes all Unicode `White_Space` characters and `Default_Ignorable_Code_Point` characters. Strings that differ in full-width and half-width, upper and lower case, and spacing are equal after normalization
- `check_text` judges in the order below and returns the first result that applies
  1. When it violates a plain text condition, `INVALID`. When line breaks are allowed, it judges with U+000A removed from the C0 controls
  2. When the normalized string matches any one `banned_word` row, `BANNED`. When several rows match, the row with the smallest ID value. `Contains` means that the normalized `word` is inside the normalized string, and `Exact` means that the two are equal
- Only the server does banned word judgement. The client does not receive the banned word list

### requirement evaluation

- The rules for condition, combination, stop item and first failed condition equal the condition and combination rules of `RequirementCore`. For the same `requirement` row and the same judge hook results, `passed` and `failed_requirement_id` equal those of `RequirementCore.evaluate`
- self judgement is the judge hook of that type. A judge hook is called inside `storage.run_read_only`, and uses only the `data` of ctx, reads of the UserState and server state of ctx (`storage.get_state`, `list_state`), and the operations of core modules that have `hook` in `caller` and do not write saved state. e.g. `item-ledger.get_balance`, `check_items`, `iap.is_subscribed`, `reset-counter.get_count`, `mission.get_progress`, `shop.get_purchase_count`. The balance of a recovery item is read with `get_balance`
- There is no cache. It judges on every call
- At server start, when any non-`None` `RequirementType` element that appears in the `requirement` rows of the server build data has no judge hook, the server does not start
- When the same type is registered twice, `None` is registered, or a registration is made outside `register`, the server does not start
- When a requirement ID value is not 0 and is not in the `requirement` table, it throws. When a judge hook throws or returns a value that is not a bool, it throws. The request ends with `INTERNAL`

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| requirement judge (handler hook) | when `evaluate_requirement` does the self judgement of a condition of that type | ctx, `requirement` row | pass flag | none. Registration is required for a type that appears in `requirement` rows |

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| validator failure | does not call the handler | `INVALID_REQUEST` | none |
| unknown table in `has_table_id` | throw | `INTERNAL` | none |
| unknown message name in `validate_message` | throw | `INTERNAL` | none |
| unknown requirement ID, a throw or wrong output of a judge hook, a write inside a judge hook | throw | `INTERNAL` | none |
| missing judge hook, registration error | server start failure | none | none |
| a `banned_word` row whose normalized `word` is an empty string | server start failure | none | none |

- validation leaves no log. `routing` logs a request failure, and the server start of `routing` logs a server start failure

Added `CoreError`: `TEXT_INVALID`, `TEXT_BANNED`. Used when a core module that called `check_text` returns `INVALID` or `BANNED` as a request failure

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `supportedLanguages` | array<string> | game | none | list of language tags of the banned word list files that make the `banned_word` rows |

## data

- The `requirement` table and the `RequirementType` and `RequirementLogic` enums. `RequirementCore` defines the headers and row rules

`data/tables/banned_word.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `word` | `string` | `Server` |
| `match` | `enum<BannedWordMatch>` | `Server` |

- The data tool makes the rows from `records/setup/banned-words/<language>.txt` (`## core data` of [`data`](../../data/SKILL.md))

`data/enums.csv`

| type | element |
|---|---|
| `BannedWordMatch` | `Contains`, `Exact` |

## DEV

- In an environment that includes DEV code, the `ServerError.detail` of a validator failure is `<field path>: <rule>`

## test

- Per option, the boundary values (min, max, min−1, max+1, length limit, element count limit) separate pass and failure exactly
- `max_len` counts in UTF-8 bytes, and `max_chars` counts in code points
- The limit of a `_key` option equals the merged core settings value of that game. When a core settings value changes and the contract tool runs again, the validator limit changes
- A `table` option rejects a nonexistent ID value and 0
- A `unique` option rejects duplicate elements
- An undefined enum value and invalid UTF-8 are rejected
- The fields of a message inside a message are also checked
- `validate_message` checks the declarations of `MatchResult` and `MatchInputLog` by the same rules as a request message, and throws for another message name
- A request whose validator failed does not call the handler and does not change saved state
- One string per character category of the plain text conditions is rejected
- `is_kind_consistent` rejects a message that has a value in a field that is not selected
- For each case of core test fixture `requirement-evaluation` (ID name of the requirement row, judge hook result per condition, expected `passed`, `failed_requirement_id`), the result of `evaluate_requirement` equals the expected value. The fixture has a case with requirement ID value 0 (no judge hook call, `passed` `true`, `failed_requirement_id` 0). The `RequirementCore` test uses the same fixture
- The judge hooks of the items after a stop item are not called
- `put_state` inside a judge hook throws, the request is `INTERNAL`, and saved state is unchanged
- The balance of a recovery item that a judge hook read with `item-ledger.get_balance` is the value that reflects the recovery at that request time, and saved state is unchanged
- `evaluate_requirement` called inside `validate_item_change` judges the balance before the change with an item holding condition judge hook, and that item change does not end with `INTERNAL`
- When there is no judge hook for a type that appears in `requirement` rows, the server does not start
- With a type that appears only in expressions of columns whose build target is `Client`, the server starts without a server judge hook, and with a type that appears in an expression of a column whose build target is `Server` or `All`, the server does not start without a judge hook
- `floor_div`, `floor_mod`, `apply_permille`, `big_floor_div`, `big_apply_permille` give the same numbers as the items for the same operations in `## test` of `UtilCore`. When `b` of `big_floor_div` is 0, it is `null`
- When a judge hook reads a row of a contract version lower than the current one, it does not throw, receives the converted value, and the saved row is unchanged
- `normalize_text` converts two strings that differ only in full-width and half-width, upper and lower case, and whitespace to the same value
- `check_text` returns `INVALID` for a plain text condition violation, and `BANNED` and the ID value of that row for a string that contains the `word` of a `Contains` row and for a string equal to an `Exact` row. An `Exact` row does not block a longer string
- When line breaks are allowed, a U+000A in the middle passes, and when they are not allowed, it is `INVALID`
- When there is a row whose normalized `word` is an empty string, the server does not start
- For `Contains` row `bad`, `ba` U+200B `d`, `b` U+00AD `ad` and `b` U+2060 `ad` are `BANNED`, and strings that hold U+202E and U+2066 are `INVALID`. An emoji string that holds U+200D and U+FE0F is `OK`. For a string of only U+3164 and a string of only U+200B, `is_plain_text` is `false` and `check_text` is `INVALID`
- `validate_message` checks the declarations of `PlaySessionResult`, `PlaySessionStartOptions`, `PlaySessionContinueOptions` by the same rules as a request message
- `parse_version` reads `1.0.0` and `0.10.2`, and is none for `01.0.0`, `1.0`, `1.0.0.0`, `1.-1.0` and an empty string. `compare_versions` judges `1.10.0` higher than `1.9.0`
- On a server made from a game contract that does not define `MatchInputLog`, `validate_message` (`MatchInputLog`, a message decoded from empty bytes) is `pass`
