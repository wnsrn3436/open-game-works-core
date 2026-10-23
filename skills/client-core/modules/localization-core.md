# LocalizationCore

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

Sets the current language, turns translation keys into text of that language, makes text with format arguments filled in, turns input prompt tokens into the input prompt of the action, and applies the per-language font as the default font.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `LocalDataCore`, `ResourceCore`, `DataCore`, `InputCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `resolve_language` | none | ID value of the current language | `0` | `BootstrapCore`(`LoadData`) |
| `load_translation` | list of `DownloadedTranslation`. An empty list when there is no downloaded translation | async operation. success flag | `false` | `BootstrapCore`(`LoadData`) |
| `load_fonts` | none | async operation. success flag | `false` | `BootstrapCore`(`LoadData`) |
| `load_prompt_icons` | none | async operation. success flag | `false` | `BootstrapCore`(`LoadData`) |
| `get_text` | translation key, inline icon height (0 when omitted) | text | empty string | core, content code |
| `format` | translation key, `FormatArgs`, inline icon height (0 when omitted) | text | empty string | core, content code |
| `bind_text` | UI text element, translation key | none | none | core, content code |
| `unbind_text` | UI text element | none | none | core, content code |
| `get_language` | none | ID value of the current language | `0` | core, content code |
| `get_language_code` | none | `code` of the current language | empty string | core, content code |
| `list_languages` | caller buffer | number filled | `0` | content code |
| `select_language` | ID value of a language | success flag | `false` | content code, `QACore` |
| `set_text_scale` | text scale permille | none | none | `AccessibilityCore` |
| `get_text_scale` | none | text scale permille | `1000` | core, content code |

### type

| type | contents |
|---|---|
| `FormatArgs` | Holds one value per name. Value kinds are integer (64-bit), float (64-bit), string. Operations are `clear`, `set_int(name, value)`, `set_float(name, value)`, `set_string(name, value)`. Setting the same name again replaces the value |
| `DownloadedTranslation` | language `code`, app storage path, SHA-256, data version. `GameUpdateCore` makes it |

- The caller makes a `FormatArgs` once and reuses it after `clear`. `format` does not change `FormatArgs`

## behavior

### language

- A language is one row of the `language` table, and operations take and return a language as the ID value of `id`
- `resolve_language` sets the first matching language in the order below as the current language
  1. The language saved in `LocalizationCore.language` of the `LocalDataCore` `device` file
  2. The language that matches the device language tag
  3. The language whose `code` is game settings `sourceLanguage`
- The device language tag is `<language>[-<script>][-<region>][-<variant>]`. How the engine reads it from the device is in the engine implementation rules. The candidates below are compared with `code` in order, ignoring case. A candidate that contains a subtag the tag does not have and a candidate already compared are skipped
  1. the whole device language tag 2. `<language>-<script>-<region>` 3. `<language>-<region>` 4. `<language>-<script>` 5. `<language>`
  - e.g. `zh-Hant-TW` → `zh-TW` → `zh-Hant` → `zh`. `ca-ES-valencia` → `ca-ES` → `ca`
- `resolve_language` is called once after `init`. When it is called again, it writes an error log, does not change the current language, and returns its ID value
- `load_translation`, `load_fonts`, `get_language`, `get_language_code` before the current language is set return the failure value
- `list_languages` fills the rows of the `language` table in `order` order
- `select_language` only saves the language to `LocalizationCore.language`. It does not change the current language, translation, font. After success the caller reports a restart (content code with `BootstrapCore.request_restart`), and after the restart `resolve_language` picks the saved language

### translation

- `load_translation` keeps only one translation binary, that of the current language, in memory. The format of the translation binary is defined by `## processing` of `tool.md` of the [`data`](../../data/SKILL.md) skill
- downloaded translation file: the one in the list whose language `code` equals the `code` of the current language. When it exists, it is used first. When it fails any condition below, an error log is written and the translation binary in the build is used. The translation binary in the build is found by the translation binary file name of the current language at the location of `DataCore.get_builtin_location`, and read with the same engine file API as the built-in data of `DataCore`
  - The file size is `LocalizationCore.downloadedFileMaxBytes` or less. The size is checked before reading
  - The SHA-256 matches and decoding succeeds
  - The data version equals the data version of `DataCore`
- On success, it discards the previous translation, the format parse cache, and the log records of missing keys and input prompt tokens, and rewrites all bound UI text elements
- When neither can be used, it returns `false` and keeps the previous translation
- When it is called while a `load_translation` is in progress, it writes an error log and returns `false`. The one in progress continues
- The translation key that `get_text`, `format`, `bind_text` receive is a `tstring` field value of generated code, the result of a `ReservedString` accessor, or a translation key that a core operation returned. When content code passes a string literal in place of a translation key, static check `data literal` blocks it
- An empty translation key from an empty `tstring` cell is an empty string and is not an error
- A missing key (a key not in the current translation, including lookups before load) writes an error log once per key per load and returns an empty string

### format

- Format argument syntax, formatter results, culture rules follow the format of [`data`](../../data/SKILL.md). Culture rules are looked up by the `code` of the current language, and the timezone offset of `date`, `datetime` is the device timezone offset
- The parse result that splits text into pieces, argument slots, input prompt token slots is made and cached per key at the first `get_text` or `format` of that key
- The length of `get_text` and `format` results is the number of Unicode code points, and an inline icon counts as one code point. Pieces from the one that makes the length more than `LocalizationCore.maxFormattedLength` onward are dropped and an error log is written
- A `}` without a matching `{` is written as the character itself. A `{` without a matching `}` makes everything up to the next `{` or the end of the text one error slot
- error slot: no value for the name, a value kind that does not match the formatter, an unknown formatter, braces that do not fit the syntax, a NaN or infinite float, a `date`·`datetime` result year that is not from 1 to 9999, a string value of `compact` that is not a big integer (`UtilCore.big_is_valid` is `false`). For each error slot, an error log is written and that slot is left empty

### input prompt token

- input prompt token: `{action:<action>}` in text. `<action>` is an action name of `InputCore`. Syntax and data check follow the format of [`data`](../../data/SKILL.md). An input prompt token is not a format argument and does not become an error slot
- Each time `get_text` and `format` make a result, they replace input prompt tokens with the result of `InputCore.get_prompt`(action) at that time. When the inline icon height is greater than 0 and `icon` is an icon loaded by `load_prompt_icons`, it is an inline icon of that height; otherwise it is the display name
- display name: the `get_text` result of `name_key` of `InputPrompt` when it is not none, and `input` when it is none
- An input prompt token whose `get_prompt` is `false` leaves that slot empty and writes an error log once per action per load
- When the input prompt token `<action>` of game data text is not in the game's action list, static check `action reference` blocks it
- rich text element: a UI text element that can draw inline icons. inline icon: an icon drawn together with characters in a rich text element. The inline icon height is in the same unit as the font size of the UI text element. The engine mapping of both is in the engine implementation rules
- `load_prompt_icons` loads every `icon` of the `input_prompt` table that is not `null` into the global scope of `ResourceCore`. When any icon is loaded as a fallback resource, it writes an error log and returns `false`, and that icon is not used as an inline icon
- When it is called while a `load_prompt_icons` is in progress, it writes an error log and returns `false`. The one in progress continues
- A caller that wrote the results of `get_text` and `format` itself receives `InputCore.InputPromptChangedEvent` and decides whether to write them again

### font

- The font chain is the list of the `font` of the current language followed by the `font` of the languages reached by following `fallback`. The same resource key is added only once
- `load_fonts` loads the fonts of the font chain into the global scope of `ResourceCore` and applies the chain as the default font. A character is looked up from the first font of the chain onward
- When any font of the chain is loaded as a fallback resource, it writes an error log and returns `false`. It applies the chain with the fallback resource in that position
- When it is called while a `load_fonts` is in progress, it writes an error log and returns `false`
- Content code does not set a font on a UI text element separately. Decorative lettering is made as an image resource
- `release` reverts the default font application

### text scale

- The text scale is in permille and is 1000 at `init`. It changes only through `set_text_scale`
- The font size of every UI text element is the size set on that element × text scale ÷ 1000 rounded down, and 1 when it is less than 1. It is also applied to existing elements in the frame the text scale changes. The engine mapping is in the engine implementation rules
- `set_text_scale` with the same value does nothing
- `release` sets the text scale back to 1000

### text binding

- `bind_text` binds a translation key to a UI text element. On binding, on `load_translation` success, and each time it receives `InputCore.InputPromptChangedEvent`, it writes the `get_text` result as that element's text. The inline icon height is that element's font size for a rich text element, and 0 otherwise
- In the frame the text scale changes, it rewrites the bound rich text elements
- When a bound rich text element enters the tree, it is rewritten in that frame, because the font size is set when it enters the tree
- `init` subscribes to `InputPromptChangedEvent`
- `unbind_text` removes the binding and does not change the element's text. `bind_text` with an empty translation key binds and writes an empty string
- When the element is destroyed, the binding is deleted
- For text with format arguments, the `format` result is written to the element. If that element is bound, it is first unbound with `unbind_text`

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| no matching language in `resolve_language` | `0`. No current language | error |
| `load_translation`, `load_fonts`, `get_language`, `get_language_code` when there is no current language | failure value of the table | error |
| downloaded translation file cannot be used | continues with the translation in the build | error |
| no translation binary could be loaded | `false`. Previous translation kept | error |
| missing key | empty string | error once per key per load |
| format error slot, result length exceeded | text with that slot or the exceeding pieces left empty | error |
| ID value not in the `language` table in `select_language` | `false`. Not saved | error |
| fallback resource in the font chain | `false` | error |
| fallback resource for `icon` of `input_prompt` | `load_prompt_icons` returns `false`. That icon is not used as an inline icon | error |
| input prompt token whose `InputCore.get_prompt` is `false` | text with that slot left empty | error once per action per load |
| value of `set_text_scale` less than 1 | text scale unchanged | error |
| second `resolve_language` after `init` | ID value of the current language. The current language is not changed | error |
| `load_translation` while a `load_translation` is in progress, `load_fonts` while a `load_fonts` is in progress, `load_prompt_icons` while a `load_prompt_icons` is in progress | `false`. The one in progress continues | error |

- `BootstrapCore` decides whether it is an unrecoverable failure

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `sourceLanguage` | string | game | none | `code` of the language picked when neither the saved language nor the device language matches |
| `supportedLanguages` | array<string> | game | none | list of the `code` of the languages the game ships |
| `LocalizationCore.downloadedFileMaxBytes` | integer | core | content | byte size limit of the downloaded translation file |
| `LocalizationCore.maxFormattedLength` | integer | core | content | limit of the length (number of code points) of `get_text`, `format` results |

## data

used table: `input_prompt`

`data/tables/language.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `code` | `string` | `All` |
| `name` | `tstring<id>` | `Client` |
| `font` | `reskey` | `Client` |
| `fallback` | `ref<language.id>?` | `Client` |
| `order` | `int` | `Client` |

- There is one row per language of game settings `supportedLanguages`. `code` is a BCP 47 tag
- `name` is the name shown on the language selection screen

`data/invariants.csv`

| kind | table | column | group | min | max | child_table | child_column |
|---|---|---|---|---|---|---|---|
| `order_column` | `language` | `order` | | | | | |

Reads the `icon` column of the `input_prompt` table (`InputCore`)

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `LocalizationCore.language` | `int64` | ID value of the selected language |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_device_language` | device language tag. An empty string clears the override | none | core test |

- In a build with DEV code, the missing key result is `‼ <translation key>`, a format error slot gets `‼ ` and the original argument text (e.g. `‼ {count:n}`), and the slot of an input prompt token whose `InputCore.get_prompt` is `false` gets `‼ ` and the original token text (e.g. `‼ {action:jump}`). In STG·PROD builds it is an empty string
- The tag of `set_test_device_language` is used in place of the device language tag until `release`

## test

- When there is a saved language, the current language is set to it regardless of the device language
- Device language tag candidate order: `zh-Hans-CN`→`code` `zh-Hans`, `zh-Hant-TW`→`zh-TW`, `ca-ES-valencia`→`ca`
- When no language matches, game settings `sourceLanguage`; when that is also missing, `0` and an error log
- `select_language` only saves and does not change the current language and text. After restart, the selected language is the current language
- For each of hash mismatch, data version mismatch, size exceeded of the downloaded translation file, an error log and use of the build translation. A file that exceeds the size is not read
- After a `load_translation` failure, the previous text still appears
- A missing key gives an empty string (`‼ <key>` in a build with DEV code), and the error log is once per key per load
- An empty translation key gives an empty string with no log
- Core test fixture `text-format` is the vector below. The `input` of a case is `{"kind": "<kind>", "value": "<value>", "text": "<text>", "language": "<code>"}` and `expected` is the result string or `null`
  - `kind` is `int`, `float`, `string` by whether table `value` is an integer, float, string. The test puts the value into name `v` with `set_int`, `set_float`, `set_string` of `FormatArgs`
  - `value` writes integers and floats also as decimal strings, and a float NaN is `NaN`
  - `error log and empty slot` in the table is `expected` `null`. When it is `null`, that slot is an error slot and an error log is written
  - In one row of the table, columns with several values are paired by the same position into one case each, and a column with one value is used for every case of that row
  - For each case, the `format` result equals `expected` (device timezone offset 0). The server `push` test uses the same fixture

| value | text | language | result |
|---|---|---|---|
| integer `1234567` | `{v}`, `{v:n}` | `ko`, `ja` | `1234567`, `1,234,567` |
| float `1234.567`, `1234.5`, `-0.001` | `{v}`, `{v:n}`, `{v}` | `en` | `1234.57`, `1,234.5`, `0` |
| integer `1`, `2`, `3`, `11`, `12`, `13`, `21`, `112`, `-12`, `-23` | `{v:ordinal}` | `en` | `1st`, `2nd`, `3rd`, `11th`, `12th`, `13th`, `21st`, `112th`, `-12th`, `-23rd` |
| integer `-3` | `{v:ordinal}` | `ko`, `ja`, `zh-Hans` | `-3번째`, `-3番目`, `第-3` |
| integer `3` | `{v:ordinal}` | `ko-KR`, `zh-Hant-TW` | `3번째`, `3rd` |
| integer `266400000`, `-500`, `-3723000` | `{v:duration}` | `ko` | `3일 2시간`, `0초`, `-1시간 2분` |
| integer `266400000` | `{v:duration}` | `en`, `zh-Hans` | `3d 2h`, `3天 2小时` |
| integer `1704442140000` | `{v:date}`, `{v:datetime}` | `zh-Hans`, `ja` | `2024/1/5`, `2024/01/05 08:09` |
| integer `1700000000000` | `{v:date}` | `en` | `11/14/2023` |
| integer `1`, `2` | `{v:plural:item/items}` | `en` | `item`, `items` |
| string `사과`, integer `2`, string `서울`, integer `7`, string `Seoul`, string `집` | `{v:으로/로}` | `ko` | `사과로`, `2로`, `서울로`, `7로`, `Seoul로`, `집으로` |
| string `HP`, `Sam`, `cm`, integer `10` | `{v:이/가}` | `ko` | `HP가`, `Sam이`, `cm이`, `10이` |
| string: empty string, `!` | `{v:이/가}` | `ko` | `가`, `!가` |
| integer `0`, `999`, `1234`, `12345`, `999999`, `1000000`, `-1500` | `{v:compact}` | `en` | `0`, `999`, `1.23K`, `12.3K`, `999K`, `1M`, `-1.5K` |
| integer `1234`, `12345`, `99999999`, `123456789012` | `{v:compact}` | `ko` | `1,234`, `1.23만`, `9999만`, `1234억` |
| integer `123456789` | `{v:compact}` | `ja` | `1.23億` |
| integer `1234567890123` | `{v:compact}` | `zh-Hans` | `1.23万亿` |
| string `5000000000000000`, `99999999999999999`, `12345678901234567890`, `-12345678901234567890` | `{v:compact}` | `en` | `5000T`, `9.99e16`, `1.23e19`, `-1.23e19` |
| string `12a`, `007` | `{v:compact}` | `en` | error log and empty slot |
| integer `1` | `{v}}` | `en` | `1}` |
| float NaN, integer `253402300800000` | `{v}`, `{v:date}` | `en` | error log and empty slot |

- When the device timezone offset is 9 hours, the `date` result of time `t` equals the result of `t` + 9 hours at offset 0
- After `format`, the values of `FormatArgs` stay the same
- `get_text` and `format` whose result length is more than `LocalizationCore.maxFormattedLength` give the text with the pieces from the exceeding one onward dropped, and an error log. A character outside the BMP counts as one code point, and an inline icon as one
- After `load_fonts`, the character lookup order of the default font equals the font chain, and when two languages have the same `font`, that font is in the chain only once. After `release`, the default font is the same as before `init`
- After `set_text_scale`(1500), the font size of a UI text element set to size 20 is 30, an element made after that is the same, and after `release` it is 20. 0 gives an error log and no change
- The text of a bound element equals the `get_text` result at binding and at `load_translation` success, the text of an element unbound with `unbind_text` does not change, and the text of an element bound with an empty translation key is an empty string
- `get_text` with inline icon height 0 of text with an input prompt token gives the display name of the input prompt of `InputCore`, and calling it again after changing the input device with `InputCore.set_test_device` gives the display name for that device. When there is no `input_prompt` row, it is prompt input
- After `load_prompt_icons`, `get_text` with an inline icon height greater than 0 replaces an input prompt that has an icon with an inline icon of that height, and an input prompt without an icon with its display name. Before `load_prompt_icons`, it is the display name
- `format` of text that contains both an input prompt token and a format argument replaces both, and there is no error log
- The input prompt token of an action whose `get_prompt` is `false` is an empty slot (`‼ {action:<action>}` in a build with DEV code), and the error log is once per action per load
- The text of a bound element is rewritten with the new input prompt after `InputPromptChangedEvent`. The inline icon height of a bound rich text element is that element's font size, and after `set_text_scale` it is rewritten with the new font size
- When `icon` of `input_prompt` is loaded as a fallback resource, `load_prompt_icons` is `false` with an error log, and the input prompt of that icon is the display name. For every other `icon`, `ResourceCore.is_loaded` is `true`
