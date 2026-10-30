---
name: data
description: Holds the game data file layout, CSV format, type, ID name and ID value, ID registry, system table, enum, invariant, core data, translation, glossary, the code and binary the data tool generates, data version, and data check. Read when writing or fixing a data table, when filling translations, when making core read data, when reviewing the data tool, and when judging game data values of content code in hardening
---

# data

## file

| path | contents |
|---|---|
| `data/system/` | system tables. Their schema is set by this document, and the game does not change it |
| `data/tables/` | general tables. Tables that core defines and tables that the game makes |
| `data/enums.csv` | data enum definitions |
| `data/invariants.csv` | declarations of invariants between tables |
| `data/requirement_types.csv` | the requirement expression argument format per `RequirementType` element |
| `data/simulation_tables.csv` | the list of tables that deterministic simulation code reads. Made by `ogw generate` |
| `data/glossary.csv` | glossary |
| `data/translations/<language>.csv` | the translation per language |
| `data/fixtures/<name>.json` | shared formula fixtures. Their format is set by the `client-content` skill. The data tool does not read them |

- To add more values to the rows of a system table or of a table that core defines, a game uses an extension table. An extension table is a table in `data/tables/` that uses the same ID names as the original table as `id`. Along with it, `data/invariants.csv` has `child_exists` (`table` is the extension table, `column` is `id`, `child_table` is the original table, `child_column` is `id`)

## CSV format

- UTF-8, RFC 4180. Table names and column names are snake_case
- header: 4 rows
  1. column description. Can be empty. Becomes the comment of the generated code
  2. build target: `Client`, `Server`, `All`, `None`. `None` is read only by tools and is not built
  3. type
  4. column name
- Data starts at row 5. Row order has no meaning. When an order is needed, add an `order` column (`int`) and check it with invariant `order_column`
- The first column has name `id`, type `id` or `id(key)`, and build target `All`. `id(key)` is unique in the table, and `id` allows duplicates. e.g. character × level
- A column that starts with `#` is a comment column. Its header rows 2 and 3 are left empty
- A row whose `id` cell starts with `#` is not built
- Values that only the server must know (probabilities, weights, judgement criterion values) go in a column with build target `Server`

## type

| type | cell | empty cell | nullable |
|---|---|---|---|
| `int`, `long` | integer | error | `int?`, `long?` |
| `float`, `double` | real number. Decimal point `.`, no exponent notation | error | `float?`, `double?` |
| `bool` | `true`, `false` | error | none |
| `string` | text. Only values that are not shown to humans | `""` | none |
| `tstring<column,...>` | source text | no text | none |
| `vector2<int\|float>`, `vector3<...>`, `vector4<...>` | elements separated by commas | error | none |
| `enum<Type>` | element name | error | `enum<Type>?` |
| `id`, `id(key)` | ID name | error | none |
| `ref<table.column>` | a value of the target column | error | `ref<...>?` |
| `reskey` | resource key | error | `reskey?` |
| `datetime` | ISO 8601 UTC. `Z` required | error | `datetime?` |
| `duration` | a combination of `ms`, `s`, `m`, `h`, `d`. e.g. `1d2h30m` | error | `duration?` |
| `array<T>` | list of elements | empty array | none |
| `array<{<field>: <T>, ...}>` | bundle list | empty array | none |
| `requirement`, `requirement<column,...>` | condition expression | no condition. Always pass | none |

- The null of a nullable type is written as `null` in the cell. A null in a built column is built as the zero value of its data proto type (number 0, empty string, enum `None`), and code reads the zero value as null
- So for a nullable column whose null and 0 are read differently, the core spec writes in `## data` a lower bound greater than 0 for values that are not null. e.g. `delay` of `local_push`. A value of `datetime?` that is not null is greater than 0. A violation is `out_of_range`
- Text shown to humans is written only as `tstring`
- A time is written as type `datetime`, and a duration as type `duration`. Minutes or seconds are not kept as `int`. The built values are Unix ms and ms
- The data proto type of a built column and the TypeScript field type of the server generated code are in the table below. When a cell value is outside the range of that data proto type, it is `value_type`. The other rules of the server generated code are set by `## generated code` of [`server-core`](../server-core/SKILL.md), and the field types and other rules of the client generated code by the per-engine `### generated code` of [`client-core`](../client-core/SKILL.md)

| type | data proto | TypeScript |
|---|---|---|
| `int`, `int?`, `id`, `id(key)`, `requirement`, `requirement<...>` | `int32` | `number` |
| `long`, `long?`, `datetime`, `datetime?`, `duration`, `duration?` | `int64` | `bigint` |
| `float`, `float?` | `float` | `number` |
| `double`, `double?` | `double` | `number` |
| `bool` | `bool` | `boolean` |
| `string`, `tstring<...>`, `reskey`, `reskey?` | `string` | `string` |
| `enum<Type>`, `enum<Type>?` | data enum `Type` | `GameData.Type` |
| `ref<table.column>`, `ref<table.column>?` | same as the row of the target column type | same as the row of the target column type |
| `vector2<int>`, `vector3<int>`, `vector4<int>` | `Vector2Int`, `Vector3Int`, `Vector4Int` | `GameData.Vector2Int`, `GameData.Vector3Int`, `GameData.Vector4Int` |
| `vector2<float>`, `vector3<float>`, `vector4<float>` | `Vector2`, `Vector3`, `Vector4` | `GameData.Vector2`, `GameData.Vector3`, `GameData.Vector4` |
| `array<T>` (T is not an array) | `repeated` of the data proto type of T | array of the TypeScript type of T |
| `array<array<T>>` | `repeated` of `<Table><Column>List` | `<TypeScript type of T>[][]` |
| `array<{<field>: <T>, ...}>` | `repeated` of `<Table><Column>Item`. An item bundle list is `repeated` of `ogw.core.ItemAmount` | `GameData.<Table><Column>Item[]`. An item bundle list is `CoreContract.ItemAmount[]` |

- A vector message is a fixed message that the data tool puts in the data proto. `Vector2Int`, `Vector3Int`, `Vector4Int` have `int32` fields, and `Vector2`, `Vector3`, `Vector4` have `float` fields, as many as their components, from field 1 in the order `x`, `y`, `z`, `w`. The elements of a cell are in this order
- The array separator is a comma for numbers, `id`, `ref`, `bool`, `enum`, `datetime`, `duration`, and a line break for `string`, `reskey`, vector. There is no `array<tstring>`
- A nested array `array<array<T>>` is allowed only when T is a type separated by commas. A nullable T is also allowed. The outer level is separated by line breaks and the inner level by commas, and an empty line is an empty inner array. There are no three or more levels. e.g. a line `[slime],[bat]` and a line `[golem]` in an `array<array<id>>` cell
- A bundle list `array<{<field>: <T>, ...}>` is an array of bundles of named fields. A field type T is a type separated by commas or its nullable. `string`, `tstring`, `reskey`, vector, and array do not become fields. In a cell, bundles are separated by commas, and the fields in a bundle are separated by spaces in header order. e.g. header `array<{monster: ref<monster.id>, count: int}>`, cell `[slime] 5, [bat] 2`
- The message `<Table><Column>Item` of a bundle list is made in the data proto by the data tool. Generated code reads it by field name. e.g. `row.waves[0].count`
- For a bundle list of type `array<{item_id: ref<item.id>, amount: long}>` (item bundle list), the data tool does not make a message and puts `import "ogw/core.proto";` in that data proto. The element `CoreContract.ItemAmount` of the generated code is made by the contract tool. `amount` of this bundle list is not checked against the range of `long` and is read as a big integer of the contract. When it is not a big integer, it is `value_type`. The data tool carries that value in `amount`, `big_amount` of `ItemAmount` with the big encoding of the contract. The upper bound of the value is checked by the data check of `item-ledger`
- A quantity that can exceed 2^53−1 is written as the amount of that item in `amount` of an item bundle list (`array<{item_id: ref<item.id>, amount: long}>`). e.g. upgrade cost cell `[gold] 2500000000000000000000` of an idle game
- The inner array of a nested array is, in the data proto, `repeated` of the wrapper message `<Table><Column>List` that the data tool makes. `<Table><Column>List` has only one field, field 1 `repeated <element type> values`. The generated code has no `<Table><Column>List` type, and the field is a two-dimensional list
- When the target column of `ref` is `id(key)`, it points to one row, otherwise to a group of rows
- `[...]` in a `string`, integer, `id`, or `ref` value is an ID name and is replaced with the ID value at build time. The values are cells of that type, elements of an `array` and of a nested array whose element is that type, and bundle list fields of that type. `tstring` and `reskey` are not replaced. When an ID name in a `string` or integer value is in the `id` column of no table and is not the ID name of a `requirement` row that the data tool made, it is `ref_missing`
- `None` of every enum is 0. `None` is not written in cells. When an `enum<Type>` cell is empty or `None`, it is `value_type`. The absence of a value in an `enum<Type>?` cell is `null` and is built as `None`. Code reads it as `None`
- The core spec writes in `## data` the meaning of `null` for each `enum<Type>?` column

### requirement expression

A `requirement` cell writes a condition, such as an unlock condition or a start condition, as an expression. The judgement rules are set by the spec of `RequirementCore`.

- One condition is `<RequirementType element>(<argument>)`. The arguments are set by the row of that element in `data/requirement_types.csv`: when `target` is not `none`, the target comes first, and when `value` is `true`, the criterion value (integer) comes after it. The target is an ID name of that table when `target` is `ref<<table>.id>`, and an element name of that enum when it is `enum<<Type>>`. e.g. `Level(10)`, `QuestCleared([quest_a])`, `ItemCount([item_b], 3)`
- `&` passes when all pass, and `|` passes when even one passes. Grouping is with parentheses. `&` and `|` are not mixed inside one pair of parentheses. e.g. `Level(10) & (QuestCleared([quest_a]) | ItemCount([item_b], 3))`
- `data/requirement_types.csv` has one header row `element,target,value,#comment`. When it does not exist, the data tool makes a file with only the header
  - `element`: a `RequirementType` element. One row per `RequirementType` element of `data/enums.csv`
  - `target`: one of `none`, `ref<<table>.id>`, `enum<<Type>>`. e.g. `ref<quest.id>`, `enum<ResetCycle>`
  - `value`: `true` when it takes a criterion value, otherwise `false`
  - `#comment`: the meaning of the target and the criterion value
- The data tool turns the expression into rows of the `requirement` table and builds them, and the cell value becomes the ID value of the top condition. An empty cell is 0. The target is converted to an ID value or enum value and put in `target_id`, and the criterion value in `value`. What is missing is 0
- The build target of a `requirement` row that the data tool made is the union of the build targets of the cells and rows below. `Client` and `Server` together are `All`, and `None` is not included in the union. When the union is empty, the row is not built. So a condition of a column whose build target is `Server` is not in the client build data, and a condition of a column whose build target is `Client` is not in the server build data
  - the cell that holds the expression that made that row
  - a cell that wrote the ID name of that row in its value
  - a `requirement` row that has that row in `children`
- The build target of a cell is the build target of its column. The `value` cell of `game_setting` and `reserved_id` has the `target` of its row
- The ID name of a row is made by the data tool as `[req__<table>__<column>__<row key>__<number>]`
  - `<row key>`: for a table whose first column is `id(key)`, the inside of the ID name of `id`. For a table whose first column is `id`, the column type is written as `requirement<column,...>`, and the values of the columns in `<...>` are joined with `__` in this order. The column rules of `<...>` are the same as for `tstring<...>`. An ID name is its inside, an integer is decimal (a negative number is `n` followed by the absolute value), and an enum element is snake_case. An ID name written in an `int` column cell also uses its inside
  - `<number>`: the position of a `requirement` row that the expression made, counted from 1 at the top row in pre-order (the row, then `children` from the left)
- Errors
  - syntax error, unknown type, argument count and kind that do not match the `data/requirement_types.csv` row of that type, element not in the target enum: `value_type`
  - ID name not in the target table: `ref_missing`
  - two rows with the same `<row key>` in the same table and column: `duplicate`
  - `requirement<...>` of a table whose first column is `id(key)`, `requirement` of a table whose first column is `id`: `structure`
  - `data/requirement_types.csv`: a `RequirementType` element without a row is `required_missing`, an `element` not in `RequirementType` and a `target` that points to a table or enum that does not exist are `ref_missing`, two rows of the same `element` are `duplicate`, and a `target` or `value` with a wrong format is `structure`

## ID

- The inside of an ID name is `[a-z0-9_]+`. It is named so that the target can be recognized. A number is used only when the number is the target itself. e.g. `[skill_fireball]`, `[stage_12]`
- The same ID name is the same ID value in every table
- An ID value is an `int32` of 1 or more. 0 means there is no target
- The game repo keeps the ID registry as the single file `id_registry.json` on its `id-registry` branch. It is a JSON object from ID name to ID value, and its keys are in byte order
  - Only the data tool reads and writes this branch. Other agents and the content agent do not check out or edit this branch
  - An issued mapping is not changed or deleted. It is kept even when a branch is discarded or the ID name is deleted from data
- When an ID name is changed, the new ID name gets a new ID value. After the first PROD build, an ID name that went out to PROD is not changed
- ID names are not put in the built client data

## system table

`data/system/` of every game holds only the tables below. They follow the column order, names, types, and build targets.

### game_setting.csv

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `target` | `string` | `None` |
| `data_type` | `string` | `None` |
| `value` | `string` | `All` |

- Holds gameplay values that content code uses as a single value. e.g. maximum stamina per day
- `target` is one of `All`, `Client`, `Server`. It is the build target that the row goes into
- `data_type` is a type notation. `tstring`, nullable types, `requirement<column,...>`, nested arrays, and bundle lists are not used. Using one is `value_type`
- The data tool reads `value` as a cell of `data_type` and writes the built `value` in the built format below. The accessor reads only the built format and returns it as a value of `data_type`
  - `int`, `long`, `datetime`, `duration`: decimal integer. A negative number has `-` in front. `datetime` is Unix ms, and `duration` is ms
  - `float`, `double`: decimal number with decimal point `.`. No exponent notation
  - `bool`: `true` or `false`
  - `enum<Type>`: decimal integer of the element value
  - `id`, `id(key)`, `requirement`: decimal integer of the ID value. An empty `requirement` is `0`
  - `ref<table.column>`: the built format of the target column type
  - `string`: the text with the ID names in it replaced with ID values
  - `reskey`: the text of the cell as it is
  - vector: the built formats of the components joined with commas without spaces
  - `array<T>`: the built formats of the elements joined with the array separator of T. An empty array is the empty string

### reserved_id.csv

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `target` | `string` | `None` |
| `value` | `string` | `All` |

- Links a reserved ID that code points to to an ID name. e.g. `[tutorial_reward]` → `[sword_basic]`
- `target` has the same meaning as `target` of `game_setting`
- The `target` of a reserved ID row that a core spec sets holds `Client` when the module that set that name is a client core module, and `Server` when it is a server core module. `All` holds both. A violation is `out_of_range`. When the data tool puts in a required reserved row, it writes a value that holds only what must be held
- When `value` is empty, it is `empty_required`. As an exception, when `## data` of the core spec writes `required when game settings <path> is <JSON value>` for a reserved ID and that value in game settings differs from that JSON value, `value` can be empty. Then that accessor returns 0. The ID name of a `value` that is not empty must be in the `id` column of another table, and a reserved ID that a core spec sets as `<reserved ID> → row of <table>` must be in the `id` column of that table. A violation is `ref_missing`

### reserved_string.csv

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `text` | `tstring<id>` | `All` |

- Text that code shows directly. e.g. error message, button name. Text that belongs to a table goes in a `tstring` column of that table
- A row whose `text` is empty is `empty_required`

### reserved_sound.csv

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `sound` | `reskey` | `Client` |

- A sound that code plays directly. A sound that belongs to a table goes in a `reskey` column of that table

## enum and invariant

`data/enums.csv` has one header row `type,element,value,#comment`.

- `type` and `element` are PascalCase. `value` is 1 or more and unique within the same `type`. `None`=0 is added by the data tool

`data/invariants.csv` has one header row `kind,table,column,group,min,max,child_table,child_column`.

| kind | meaning |
|---|---|
| `key_range` | `table.column` (integer) has every integer from `min` to `max`. Per group value when `group` is set. `min`, `max` are integers or integer ID names of `game_setting` |
| `child_exists` | for each value of `table.column`, `child_table.child_column` has one or more rows with the same value |
| `order_column` | `column` (integer) is unique within the group (within the whole table when there is no group), from 1 without gaps |

- Content code reads the rows and values that an invariant guarantees without handling for the case where they are missing

## core data

- core data: the table headers, enum elements, invariants, and required reserved rows that the core specs of the modules the game uses (`## module` of the `core` skill), in the core version that game settings picks, set in `## data`. Required reserved rows are the system table rows of the reserved names written in `## data` of that core spec. For a table of another module that the core spec reads or points to with ref in `## data`, the header and the elements of the enums that header uses are put in as core data even when that module is not a module the game uses. This rule is applied again to the tables put in this way.

- The data tool puts in missing core data on every run
  - tables that core defines: when `data/tables/` has no file, it makes a file with only the header. It makes no file for the `requirement` table that the data tool makes at build time
  - enums whose elements a core spec sets: adds missing elements to `data/enums.csv`. `value` starts at 1 in the order written in the core spec. The added rows go at the end of the file in the module order of `core-spec.json`, and within one module in the order written in the spec
  - invariants: adds missing rows to `data/invariants.csv`
  - required reserved rows: adds missing rows to the system table. The value cells other than `target` of `reserved_id` are left empty, and the content agent fills them
- When core data has the `banned_word` table, the data tool remakes the rows of `data/tables/banned_word.csv` from the banned word list files on every run
  - banned word list file: `records/setup/banned-words/<language>.txt` of the `--game` folder. `<language>` is a language tag of game settings `supportedLanguages` as it is. No rows are made for a language without a file
  - From each line, the trailing U+000D and the leading and trailing spaces are removed. Each line whose result is not the empty string is one row. `id` is `[banned_<language key>_<line number>]`, `word` is that result, and `match` is `Contains`. `<language key>` is the language tag in lowercase with `-` replaced by `_`, and `<line number>` is the line number counted from 1 in that file
  - The row order is the order of `supportedLanguages`, and within it the order of line numbers. No other rows are kept
- A game does not change core data other than the value cells of required reserved rows, and does not edit `data/tables/banned_word.csv`. When the header (except comment columns) of a table that core defines differs, or an element or `value` of an enum whose elements a core spec sets differs, it is `structure`
- For an enum whose elements a core spec says the game sets, the game writes the elements in `data/enums.csv`

## translation

- The data tool makes the translation key as `<table>.<tstring column>.<key column value>...`. e.g. `[knight]`, 3 of `character_level.desc: tstring<id,level>` → `character_level.desc.[knight].3`
  - The columns of `tstring<...>` can only be columns of ID names, integers, or enum elements
  - A different source text for the same key is an error
  - built key: the translation key of the table binary, the translation binary, and the generated code is the key with the ID names of key column values replaced with ID values and the enum elements with enum values. An ID name written in an `int` column cell is also replaced with its ID value. e.g. `character_level.desc.17.3` when the ID value of `[knight]` is 17. Translation files and data check results use the key before replacement
- `data/translations/<language>.csv` is one file per language. One header row `key,source,source_hash,current_hash,text`, rows in byte order of key
  - translation input: the source text of a row, and the `source` and that language cell of each glossary row that matches that source text. The translation input of the source language file is only the source text
  - `current_hash` is the hash of the current translation input, and `source_hash` is the `current_hash` at the time of translation
  - In the source language file, `text` equals source and `source_hash` equals `current_hash`. Only the data tool writes this file
- The data tool aligns the translation files before build. It aligns the glossary first
  - new key: adds a row and leaves `text` and `source_hash` empty
  - every key: sets `source` and `current_hash` to the current values
  - removed key: deletes the row
- missing translation: a row whose `text` is empty in a translation file, and an empty `<language>` cell in the glossary. A stale translation is a row whose `text` is not empty and whose `source_hash` differs from `current_hash`
- Only the translation sub-agent writes the `text` of missing translations and stale translations and the `<language>` cells of the glossary. Only `ogw translation done` writes `source_hash` of translation files, and only the data tool writes `current_hash` of translation files and `source_hash` of the glossary. Other agents do not change these
- In the translation binary, the `text` of a key that is a missing translation is the source text
- `ogw translation todo <game> <language>`: after running `ogw data <game>`, outputs the glossary rows whose cell of that language is empty (line number, `source`, `id_name`, `note`) and the missing translation and stale translation rows of the translation file of that language (`key`, `source`, the current `text` when stale, and for each glossary row that matches that source text, `source` and that language cell). It changes nothing else
- `ogw translation done <game> <language> [--keep <key>...]`: after running `ogw data <game>`, sets `source_hash` of the rows below in the translation file of that language to the `current_hash` of that row, and outputs the remaining missing translation and stale translation rows and the data check lines of the translation file of that language and of the glossary. When `ogw data` fails, it does not change `source_hash`, outputs those data check lines, and fails
  - a row whose `text` is not the empty string and differs from the `text` of the row of the same key in HEAD. When HEAD has no row of that key, it is treated as different
  - stale translation rows of the keys written in `--keep`
- A text to which core gives values uses only the format arguments that `## data` of the core spec sets. The texts to which core gives values are reserved strings that a core spec sets, `mail_template` rows that a reserved ID a core spec sets or a `ref<mail_template.id>`, `ref<mail_template.id>?` column of a table that core defines points to, and `tstring` columns of tables that core defines for which `## data` of the core spec writes format arguments or `none`. A text for which no format argument is written or `none` is written has no arguments. The core spec writes the value kind of each format argument in the form `{<name>}` (`<kind>`). `<kind>` is one of `integer`, `real`, `string`. e.g. format argument `{count}` (`integer`). In every language, the formatter of that argument accepts that value kind in the format table. A violation is `translation_format`

### writing style

- Source text and every translation are written as games made in that language write that kind of text, in the form and tone `## writing style` of `design.md` gives it, or, where it gives none for that kind, as games made in that language write it: not a sentence of another language carried over word by word, and a translation does not take the form of its source (e.g. a ko state notification `열쇠 필요`, not `열쇠가 필요하다`; en `Bought {name}`, not `{name} bought`, for ko `{name} 구매`)
- A text fits the element that shows it at the text size of that element, in every supported language. For source text, a shorter wording comes before a smaller size or a wider element. A translation that does not fit is made to fit by the content agent with the size or width of the element, as only the translation sub-agent writes translations

### format

- Source text does not write values that data, server, or code sets. Such a value is received as a format argument, and the code that shows that text passes it. e.g. `points` in `{points}점을 먼저 내면 승리` is the value of `[points_to_win]`
- A format argument is `{name}` or `{name:formatter}`. The set of argument names must be the same in every language of the same key. The formatter can differ per language
- input prompt token: `{action:<action>}`. `<action>` is the action name (snake_case) of client `InputCore`. An input prompt token is not a format argument, and client `LocalizationCore` replaces it with the input prompt of that action. A spot `{action}` whose name is `action` and that has no `:` is `translation_format`
- The `<action>` set of the input prompt tokens must be the same in every language of the same key. When `<action>` is not snake_case, it is `translation_format`. When the text of a `tstring` column whose build target is `Server` has an input prompt token, it is `translation_format`
- The value kinds are `integer` (64-bit integer), `real` (64-bit real number), and `string` (string). The value kinds a formatter accepts and its result are in the table below

| formatter | integer | real | string | result |
|---|---|---|---|---|
| none | yes | yes | yes | an integer is decimal without separators. A real number is rounded to two decimal places (half away from 0), trailing zeros and the decimal point are removed, and when the result is 0 no sign is written. A string as it is |
| `n` | yes | yes | no | the result of `none` with the thousands separator of the culture rule in the integer part |
| `compact` | yes | no | yes | the `compact` rule below. A string accepts only a big integer of the contract |
| `ordinal` | yes | no | no | the ordinal of the culture rule |
| `plural:<singular>/<plural>` | yes | yes | no | singular when the value is 1, otherwise plural |
| `date`, `datetime` | yes | no | no | the time of the Unix ms value plus the timezone offset, in the format of the culture rule |
| `duration` | yes | no | no | the absolute value of the ms value in the largest unit that is not 0 among day, hour, minute, second, and the next unit. The next unit is omitted when it is 0. Less than 1 second is dropped. When the result is 0, it is `0` with the second unit, without a sign. When the result is not 0 and the value is negative, `-` in front. A number and its unit are joined, and units are separated by one space |
| Korean particle (`은/는`, `이/가`, `을/를`, `와/과`, `으로/로`) | yes | yes | yes | the value followed by the particle. e.g. `{name:이/가}`. The particle is chosen by the final consonant of the last character. When the last character is a digit, it is read as the sound of that one digit, and when it is a Latin letter, as the Korean name of that letter regardless of case. Of the Latin letters, only `L`, `M`, `N`, `R` have a final consonant. `으로/로` is `로` when the final consonant is `ㄹ`. An empty value and a last character that is not Hangul, a digit, or a Latin letter have no final consonant |

- `compact`: writes the absolute value a of value v shortened with the `compact` units of the culture rule, and puts `-` in front when v is negative
  - The units are a list of exponent e and notation pairs. Of the units with 10^e ≤ a, the unit with the largest e is chosen. When there is no such unit, the result is the `n` result of a
  - q = a ÷ 10^e. When the chosen unit is the last unit of the list and the integer part of q has 5 or more digits, it is exponent notation. Otherwise the whole integer part of q is written, the fraction part is written truncated toward 0 until the significant digits together with the integer part are 3, trailing zeros and the decimal point are removed, and then the unit notation is appended
  - Exponent notation is `<m′>e<k>`, with k such that a = m × 10^k (1 ≤ m < 10), and m′, which is m truncated toward 0 to 3 significant digits with trailing zeros and the decimal point removed
  - The decimal point is the decimal point of the culture rule. e.g. 1234 in `en` is `1.23K`, 999999 is `999K`, and 99999999 in `ko` is `9999만`
- A real number without a decimal point (e.g. `20`) is written the same as an integer. The minimum integer value is written as the maximum value instead
- The timezone offset of `date`, `datetime` is set by the spec of the core module that makes the text
- The culture rule is looked up in the table below by the language `code` of the text. When it is not found, the last subtag is removed and it is looked up again, and when it is not found to the end, `en` is used

| item | `ko` | `en` | `ja` | `zh-Hans` |
|---|---|---|---|---|
| thousands separator, decimal point | `,` `.` | `,` `.` | `,` `.` | `,` `.` |
| `ordinal` | `<number>번째` | `<number>` + `st`/`nd`/`rd`/`th`. `th` when the last two digits of the absolute value are from 11 to 13 | `<number>番目` | `第<number>` |
| `duration` unit | `일` `시간` `분` `초` | `d` `h` `m` `s` | `日` `時間` `分` `秒` | `天` `小时` `分钟` `秒` |
| `compact` unit (exponent e, notation) | `4` `만`, `8` `억`, `12` `조`, `16` `경` | `3` `K`, `6` `M`, `9` `B`, `12` `T` | `4` `万`, `8` `億`, `12` `兆`, `16` `京` | `4` `万`, `8` `亿`, `12` `万亿` |
| `date` | `yyyy.MM.dd` | `MM/dd/yyyy` | `yyyy/MM/dd` | `yyyy/M/d` |
| `datetime` | `yyyy.MM.dd HH:mm` | `MM/dd/yyyy HH:mm` | `yyyy/MM/dd HH:mm` | `yyyy/M/d HH:mm` |

- `<number>` is the integer result without a formatter. It includes the minus sign
- A string conversion that does not use the culture rule does not depend on the locale
- The results of client and server are aligned with core test fixture `text-format`

## glossary

`data/glossary.csv` has one header row `source,id_name,note,source_hash,<language>...`. `<language>` is each language of game settings `supportedLanguages` other than `sourceLanguage`.

- One row each for the name of a target that has an ID name and for a term the game newly made
- The name of a target that has an ID name is a value of the `name` column (`tstring`) of a table that has an `id` column. The row has that ID name in `id_name`
- The `name` of the `language` table is the name of that language written in that language. e.g. `English`, `日本語`
- `source_hash` is the hash of the `source` that the data tool last aligned. Aligning the glossary: for a row whose `source_hash` differs from the hash of the current `source` (new rows included), all `<language>` cells are emptied and `source_hash` is set to the current hash. After that, for a row whose `id_name` is in `id` of the `language` table, every `<language>` cell is set to `source`
- match: when a source text contains the `source` of a glossary row as a case-sensitive substring, that glossary row matches that source text
- The translation sub-agent renders the `source` of a glossary row that matches the source text as the cell of that language in that row

## data tool

The data tool is in the core release, and the harness tool `ogw data <game>` calls it with the core version of game settings.

binary build: `ogw instance start` (including the worktree of `--commit`) and `ogw build run` call the data tool as a binary build after `ogw generate`, and `ogw check` calls it as a binary build when it starts. A binary build does not put in core data, make `banned_word` rows, align translations, or issue ID values, and does not change committed files. It fails when putting in core data, making `banned_word` rows, or aligning translations would change a file, or when there is an ID name that is not in the ID registry. Then `ogw data <game>` is run and committed, and the step is done again. Its result is all the generation target files that are not committed.

| generation target | location | commit |
|---|---|---|
| data proto, client code | `client/generated/data/` | yes |
| data proto, server code | `server/generated/data/` | yes |
| DEV accessor | `client/dev/generated/data/`, `server/dev/generated/data/` | yes |
| table binary, translation binary, `data_version` | `client/build/data/`, `server/build/data/` | no |
| data version `client_data_version` of the Client build target | `server/build/data/` | no |
| Client build target data version `compat_client_data_version` of the PROD data tag | `server/build/data/` | no |

- The `client/` paths of location are paths under the logical folder of `## folder` of [`client-content`](../client-content/SKILL.md)
- Generated code (`<Table>` is the table name in PascalCase): per table, the row type `<Table>Row`, the empty row whose fields are all default values, and the container `<Table>Table` that holds all rows and finds rows by ID value; enum types; the accessors `GameSetting`, `ReservedId`, `ReservedString` (client and server), `ReservedSound` (client); the load entry point that loads the built binaries into containers and accessors; the functions that find rows and key column values by table name and column name when client `DataCore` makes a derived container. Row types, `<Table><Column>Item`, containers, and enum types are in the `GameData` namespace
- The namespaces, types, and methods of the generated code are set by `### generated code` of the per-engine implementation rules of [`client-core`](../client-core/SKILL.md) for the client, and by `## generated code` of [`server-core`](../server-core/SKILL.md) for the server
- A container gives the list of all rows in table binary order. For a table whose first column is `id(key)`, it finds the one row of an ID value and returns the empty row when there is none; for a table whose first column is `id`, it finds the list of rows of an ID value in table binary order and returns an empty list when there is none. The returned rows and lists are objects that the container holds and are not made anew per call. The caller does not change them. The empty row is the same object per table
- accessor: one per key, and its name is the ID name without the brackets. `ReservedId` returns the ID value, `ReservedString` the built translation key, and `ReservedSound` the resource key
- The generated code holds the tables, enums, and reserved rows of every module in `core-spec.json`, regardless of whether the game uses the module, because the core code that goes into a game also has code of modules the game does not use. Of those, what is not in data is not put in data and is made as below
  - table: a table whose header is `columns` of `core-spec.json` and that has no rows. The container returns an empty list and the empty row
  - enum: an enum in `enums` of `core-spec.json` has its elements in that order from 1. An enum that a column type of `core-spec.json` points to but that is not in `enums` has only `None`
  - reserved row: of the accessors, `ReservedId` returns 0, and `ReservedString` and `ReservedSound` return the empty string. The same holds for the accessor of a reserved row that is not in that build target
- DEV accessors are DEV code. They find an ID value by ID name and an ID name by ID value (client and server), and set `GameSetting` test values (client). A missing ID name returns 0, and a missing ID value returns the empty string
- The ID registry issuing method, reading of `core-spec.json`, processing order, binary format, data proto format, hash calculation, core test data, and CLI are in [tool.md](tool.md)

### data check

- One result line has the format `<file>:<line>:<column> <ERROR|WARN> <code> <message>`

| code | condition |
|---|---|
| `structure` | a file is not UTF-8, RFC 4180. The format of the header, the first column, a comment column, `data/enums.csv`, `data/invariants.csv`, `data/requirement_types.csv`, `data/simulation_tables.csv`, `data/glossary.csv`, or a translation file differs from this document. The schema of a system table differs from this document. The header of a table that core defines or an enum whose elements a core spec sets differs from core data. `data/tables/requirement.csv` exists. ID registry `id_registry.json` does not pass the ID registry format check of the data tool (`## ID registry` of [tool.md](tool.md)) |
| `bad_name` | a table name or column name is not snake_case. The inside of an ID name is not `[a-z0-9_]+`. An enum `type` or `element` is not PascalCase |
| `reserved_name` | a table name, column name, enum `type`, enum `element`, or ID name that becomes an accessor name equals a reserved word of the programming language of the generated code or a built-in type name of an engine. The inside of an ID name that becomes an accessor name starts with a digit. The beginning of the inside of an ID name written in data is `req__`, the same as the names the data tool makes. An `element` of `data/enums.csv` is `None`. A type name that the data tool makes (`<Table>Row`, `<Table>Table`, `<Table><Column>Item`, `<Table><Column>List`, enum `type`, `Translation`, `TranslationEntry`, `TableNames`) equals another of them, equals another type name of the generated code (e.g. `Vector2`, `Vector2Int`, `DataSet`, `GameSettingAccessor`, `ReservedIdAccessor`), or equals a message or enum name of the game contract (the proto in `contract/`) and the base proto, a client core type name (per-engine `### generated code` of [`client-core`](../client-core/SKILL.md)), or a global name that the server generated code uses (`Map`, `Number`, `Uint8Array`, `Object`, `Array`, `String`, `Boolean`, `Error`, `Set`, `Promise`, `BigInt`). Enum value names of the data proto equal each other. A table name or enum `type` of data equals a table name or enum `type` of `core-spec.json` that is not core data |
| `value_type` | a cell value cannot be read as the column type. An `enum<Type>` cell is empty or `None`. An `enum<Type>?` cell is `None`. The syntax, type, or arguments of a requirement expression are wrong. A `reskey` value is not in the resource key format of [`resource`](../resource/SKILL.md). A cell value violates the format a core spec sets for it. The `target` of `game_setting` or `reserved_id` is not one of `All`, `Client`, `Server`. A `value` of `reserved_id` that is not empty is not an ID name |
| `empty_required` | a cell of a type whose empty cell is an error (except `enum<Type>`) is empty. A value that this document or a core spec says cannot be empty is empty |
| `duplicate` | values that this document or a core spec sets as unique overlap. e.g. `id(key)` column, enum `element` and `value` within the same `type`, different source texts of the same translation key |
| `ref_missing` | the row that an ID name or `ref` value points to does not exist, or is not a row of the table that this document or a core spec sets. The enum element, table, or enum that `element` or `target` of `data/requirement_types.csv` points to does not exist |
| `required_missing` | a row that this document or a core spec says must exist is missing. Invariant `key_range` or `child_exists` is violated |
| `out_of_range` | a value is outside the range or combination that this document or a core spec sets |
| `order` | invariant `order_column` is violated |
| `cycle` | following `ref` or requirement sub-conditions returns to the same row |
| `resource_missing` | the resource of a `reskey` value does not exist. WARN in the loop, ERROR in build |
| `translation_format` | a format argument or input prompt token rule is violated |
| `translation_missing` | a row or cell that is a missing translation. Always WARN |
| `translation_stale` | a row that is a stale translation. Always WARN |
| `glossary_missing` | the name of a target that has an ID name is not in the glossary. Name columns whose build target is `None` are not checked. The name is in the glossary when there is a glossary row whose `id_name` is that ID name and whose `source` is the text of that name |
| `banned_word_missing` | `--modules` has one of `nickname`, `guild`, `chat`, and among the languages of game settings `supportedLanguages` there is a language whose `records/setup/banned-words/<language>.txt` does not exist or holds only empty lines. One line per language; `<file>` is that file path, and `<line>` and `<column>` are `1`. Always WARN |
| `protocol_change` | a forbidden change of the data version |
| `prod_change` | compared with the data of the PROD data tag, a value has changed that `## data` of a core spec, [`resource`](../resource/SKILL.md), or `## data version` of this document says cannot change after the first PROD build. e.g. the schedule of a `live_event` row that has started, a deleted resource key, a value of a row that was in a table of `data/simulation_tables.csv` |

- A code for which the table does not write WARN is ERROR
- The TypeScript reserved words of `reserved_name` are the ECMAScript reserved words, the reserved words of strict mode and of modules, `constructor`, `prototype`, `__proto__`. A contextual keyword such as `type` is not a reserved word
- The rules for table rows, cell values, and reserved rows that `## data` of a core spec sets are also run as data checks. e.g. the `code` set of the `language` table equals game settings `supportedLanguages`. The data tool runs the checks of each module in `--modules`. As an exception, the BCP 47 format of `code` of the `language` table (violation: `value_type`) and the uniqueness of its lowercased values (violation: `duplicate`) are checked by the data tool regardless of modules, because these values become translation binary file names, and the module check does not output these two again. A violation of a rule for which the core spec writes no code is `out_of_range`
- A new data rule is added to the data check. No separate check command is made

## data version

- The data version is `<protocol hash>-<data hash>` per build target. The two hashes are SHA-256 lowercase hex of 64 characters, and the data version is the 129 characters that join them with one `-`. A data version not in this format is a format violation
  - protocol hash: the hash of the generated data proto file of that build target. It changes on column addition, deletion, name, build target, and type, table addition and deletion, and enum element change. It does not change when only proto comments change
  - data hash: the hash of the table binary of that build target. The translation binary and the `data_version` file are not included
- The client sends the data version of the Client build target with every request. The server compares that value with `client_data_version`, `compat_client_data_version`, and the judgement follows step 7 of the request processing order of `routing`. So a server that changed the protocol hash also accepts the app of the last PROD build. The support of that app is ended by `min_version` of the deploy list
- Within the same protocol hash, these are forbidden: deleting a row that an accessor points to, changing `data_type` of `game_setting`, narrowing `target`, changing between `id` and `id(key)`. The data tool blocks them with `protocol_change`
- PROD data tag: of the `prod-<version>` tags and the tags `prod-<app version>-bundle-<n>` of PROD bundle patches that hold data (`## bundle patch` of [`build`](../build/SKILL.md)), the tag on the latest commit on main
- After the first PROD build, the forbidden changes above are checked against the data of the PROD data tag
- After the first PROD build, when an ID name that was in a table in the data of the PROD data tag is not in the `id` column of that table in the current data, the data tool blocks with `protocol_change`. The `requirement` table that the data tool makes and the `banned_word` table are not checked. A row that will no longer be used is not deleted; a column value of that table keeps it from being used. e.g. `end_at` of `shop_product`
- `data/simulation_tables.csv` has one header row `table`. In each row, `table` is one table name of `data/tables/` or `data/system/`. `ogw generate` makes it from the deterministic simulation code of [`client-content`](../client-content/SKILL.md), and the game does not edit it. When the file does not exist, the data tool reads it as having no rows. A missing table is `ref_missing`, and two rows of the same `table` are `duplicate`
- After the first PROD build, for a table that is in `data/simulation_tables.csv` now or at the PROD data tag, the data tool blocks with `prod_change` when, in the row of an ID name that was in the PROD data tag data (for a table whose first column is `id`, the group of rows of that ID name), the value of a cell of a column that was also in the PROD data tag data changes. Comment columns and columns with build target `None` are not looked at

## content code rules

- Content code does not write game data values. Numbers, text, resource keys, ID names, and ID values are not written in code. Exceptions: `0`, `1`, `-1`, `2`, `0.5`, the empty string, log messages, test code, structure constants in the `constants` file
- Structure constants are not game data but numbers that the code structure sets. e.g. the divisor of a modulo, vector components, color components, bit masks. Values of balance, pacing, presentation duration, reward, price, and probability are not structure constants. Structure constants are kept only as named constant declarations in the client constants file and in `server/common/constants.ts`, and each declaration has a comment on the same line with the reason it is not game data. The path of the client constants file is set by `## feature folder` of the `client-content` per-engine rules of game settings `engine`: [Godot](../client-content/engines/godot.md)
- Reserved IDs, settings, text, and sounds are called only through the generated accessors
- Table values are read through the generated containers. Lookup helpers are made by content code
- The automated check blocks violations of the rules above
