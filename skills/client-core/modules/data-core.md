# DataCore

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

Picks the built client data from downloaded data or built-in data, validates it and loads it into the generated containers, and lets content code make derived containers and look them up.

## dependency

`UtilCore`, `LogCore`, `LocalDataCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `load` | `DownloadedData`. none when there is no downloaded data | async operation. success flag | `false` | `BootstrapCore`(`LoadData`) |
| `is_loaded` | none | whether it is after a successful `load` and before `release` | `false` | all code |
| `get_data_version` | none | data version of the loaded data | empty string | `NetworkCore`, `LocalizationCore`, `QACore`, `RealtimeCore` |
| `get_builtin_data_version` | none | data version of the built-in data | empty string | `GameUpdateCore` |
| `get_builtin_location` | none | location from which the built-in data is read | none | `LocalizationCore` |
| `build_derived_containers` | none | success flag | `false` | `BootstrapCore`(`ContentInit`) |
| `make_index` | table, 1 to 3 key columns | `DataIndex` | empty `DataIndex` | content code inside the `build_derived` hook |
| `make_group` | table, 1 to 3 key columns | `DataGroup` | empty `DataGroup` | content code inside the `build_derived` hook |
| `get_row` | `DataIndex`, key values | row | the empty row of that table | all code |
| `has_row` | `DataIndex`, key values | whether the row exists | `false` | all code |
| `get_rows` | `DataGroup`, key values | list of rows. read-only | empty list | all code |
| `has_rows` | `DataGroup`, key values | whether the key exists | `false` | all code |

- `DownloadedData`: data version, file list (app storage path, SHA-256). `GameUpdateCore` makes it
- key column: a column whose type is `int`, `long`, `id`, `id(key)` or `enum`, and a `ref` column whose target column is a key column
- empty row: the row of the row type that the data tool generates for that table, with every field at the default value. There is one per table, and it also exists before `init` and after `release`
- key values: 1 to 3 values that hold, as int64, the value of each key column passed to `make_index` or `make_group`, in that key column order. An `enum` column gives the enum value, an `id` or `id(key)` column the ID value, an `int` or `long` column its value, and a `ref` column a value by the same rule as its target column. Their count equals the number of key columns of that container

## behavior

### source

- built-in data: the client table binaries put into the build and their `data_version`. Files in the built-in data location are read with the engine file API, not through `LocalDataCore`. The engine-specific implementation rules name the API
- downloaded data: one set of client table binaries that `GameUpdateCore` downloaded and put in app storage
- `load` loads the downloaded data when there is downloaded data and it passes all validations below, and the built-in data otherwise. It empties the containers it was making from the downloaded data before it loads the built-in data
  1. The data version is in the format of `data` skill `## data version`
  2. The protocol hash equals the protocol hash of the built-in data
  3. The list of file names equals the list of table binary names of the built-in data. Translation binaries and `data_version` are not included. Order is not checked. A file name is the part of the path after the last `/`
  4. Every file is at most `DataCore.downloadedFileMaxBytes` by `LocalDataCore.get_file_size`. A file over it is not read
  5. Every file is read with `LocalDataCore.read_file`, and `UtilCore.sha256_hex` equals the SHA-256 in `DownloadedData`
  6. Every file decodes successfully
- DataCore does not call `GameUpdateCore`. It receives downloaded data only as the input of `load`

### load

- `load` does the following in order through the load entry point the data tool generates
  1. Decodes the table binaries and makes the containers of all tables. If even one table fails, that source fails
  2. Prepares the generated accessors (`GameSetting`, `ReservedId`, `ReservedString`, `ReservedSound`)
- It makes all tables at once. It does not lazy-load a table when the table is first used
- `load` runs once per `init`. To switch to another data version, `release`, `init` and `load` run again. The only paths that switch are the restart and the update reboot of `BootstrapCore`
- When it cannot load the built-in data either, it empties all containers and returns `false`. This is an unrecoverable failure, and `BootstrapCore` handles it as a fatal error
- It keeps the built-in data version when it first reads it and does not read it again before `release`. It also keeps a read failure
- Containers, accessors and derived containers are read only after a successful `load` and before `release`. The `init` of a core module does not read them
- No code other than generated code and DataCore changes containers, their rows or derived containers

### derived container

- derived container: a container made from the values of generated containers and accessors. e.g. list of rows per column value, cumulative value per level
- `BootstrapCore` calls `build_derived_containers` once, after a successful `load` and after `content_init` of the content entry registers hooks. It calls the registered `build_derived` hooks and locks the derived containers when the hooks finish
- Content code makes derived containers only inside the `build_derived` hook. It does not make them at lookup
- `make_index` makes a `DataIndex` that holds one row per combination of key column values. When the same key has two or more rows, it puts in none of those rows and leaves an `error` log per key, and `build_derived_containers` returns `false`
- `make_group` makes a `DataGroup` that holds a list of rows per combination of key column values. The list of rows follows the row order of the table
- A lookup finds one key with an ID value lookup on a generated container or with `get_row`, `get_rows`, `has_row`, `has_rows`. A lookup by the ID value of the first column (`id`, `id(key)`) uses the generated container and is not made again as a derived container. Code does not iterate a container to pick a value. A value obtained by iteration is made as a derived container inside the hook
- A lookup does not create a new collection or result object. Two lookups of the same key return the same object
- missing data: there is no row that matches the key. A lookup before `init`, after `release` or before `build_derived_containers` is also missing data. A key whose list of rows is empty is not missing data
- Data that may not exist is checked first with `has_row` or `has_rows`. e.g. the row of the next level
- Whether a lookup result is the empty row is checked by whether it is the same object as the empty row

### release

- `release` empties the containers, the values kept by accessors, the derived containers, the kept data version and built-in data version, and the missing data log record, and resets the built-in data location to the default location
- The default built-in data location is the location of the data put into the build. The location format is in the engine-specific implementation rules

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `build_derived` | `build_derived_containers` | none | success flag | does nothing and succeeds |

- When the hook returns `false`, `build_derived_containers` returns `false`. `BootstrapCore` handles it as a fatal error

## event

none

## error

| condition | failure value | log |
|---|---|---|
| `build_derived` hook throws | `build_derived_containers` is `false` | error |
| downloaded data validation 3 to 6 fails | loads the built-in data | `error` |
| downloaded data validation 1 or 2 fails | loads the built-in data | none |
| cannot load the built-in data, cannot read the built-in data version | `load` is `false`. The containers are empty | `error` |
| second `load` | `false`. The containers and data version stay as they are | `error` |
| `get_data_version` before `load` or after a failed `load` | empty string | `error` |
| `get_builtin_data_version` that has kept a read failure | empty string | `error` per call |
| `build_derived_containers`·`make_index`·`make_group` before a successful `load`, a second time, or outside the hook | `false`, empty container | `error` |
| the number of key columns is outside 1 to 3, the table or column does not exist, or the type is not a key column type | empty container | `error` |
| duplicate key in a `DataIndex` | does not put in the duplicate rows. `build_derived_containers` is `false` | `error` per key |
| missing data of `get_row`, `get_rows` | empty row, empty list | one `error` per (container, key) until `release` |
| missing data of `has_row`, `has_rows` | `false` | none |
| the number of key values of `get_row`, `get_rows`, `has_row`, `has_rows` differs from the number of key columns of that container | empty row, empty list, `false` | `error` per call |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `DataCore.downloadedFileMaxBytes` | integer | core | content | maximum bytes of one downloaded data file |

## data

none. DataCore loads all tables but does not decide its behavior by the values of tables.

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_data_location` | location | none | core test |

- It is called only before `init`. `release` resets it to the default location. A `release` before `init` also resets it
- A core test switches it to the location of the core test data

## test

- When downloaded data passes validation, it loads from the downloaded data and `get_data_version` is the version of the downloaded data
- When the files of downloaded data are all the table binaries of the built-in data and there are no translation binaries and no `data_version` file, validation 3 passes
- A `load` without downloaded data loads from the built-in data, and `get_data_version` equals `get_builtin_data_version`
- In each of the following cases of downloaded data, it loads from the built-in data and the containers have no row that exists only in the downloaded data: the protocol hash differs, the version has no `-`, the version has two or more `-`, the hash of the version has an uppercase letter or a character outside hex, the hash is not 64 characters, the version has CR or LF, the SHA-256 of one file differs, one file cannot be read, one file fails to decode, 0 files, one file of the built-in data is missing, one file is larger than `DataCore.downloadedFileMaxBytes` (that file is not read). Only the cases of validation 3 to 6 leave an `error` log
- When it can load neither the downloaded data nor the built-in data, the result is `false`, empty containers and an empty `get_data_version`
- When the built-in data version cannot be read, `get_builtin_data_version` gives an `error` log and an empty string per call, and a `load` without downloaded data is `false`
- After a successful `load`, every table container of the core test data has the same row count as the core test data, and the `GameSetting` accessor has the values of the core test data
- After `release`, the containers, the values kept by accessors, the derived containers and the data version are empty, and after `init` it can load downloaded data of another version
- `is_loaded` returns `false`, `true`, `false`, `false` without a log before `load`, after a success, after a failure and after `release`
- `get_row` of a `DataIndex` that the `build_derived` hook made with `make_index` returns the row of the key, and the same object for the same key twice. A key that does not exist gives the empty row and an `error` log, and the second time gives no log. `has_row` gives no log
- For a key whose list of rows in `make_group` is empty, `get_rows` returns an empty list without a log and `has_rows` is `true`
- `get_row` of a `make_index` made with two key columns returns the row for key values that hold the values of the two columns in column order, and key values in swapped order do not find a row whose two values differ. An `enum` key column is found by enum value. `get_row`, `get_rows`, `has_row`, `has_rows` whose number of key values differs from the number of key columns give an empty row, an empty list, `false` and an `error` log
- `make_index` on a table with a duplicate key does not put in the duplicate rows and leaves an `error` log per key, and `build_derived_containers` is `false`
- `make_index` given a `ref` column whose target column is `string` as a key column gives an empty container and an `error` log. `get_row` of a `make_index` made with a `ref` column whose target column is `id(key)` finds the row by ID value
- When the hook returns `false`, `build_derived_containers` is `false`. When no hook is registered, it is `true`
- `make_index` outside the hook and a second `build_derived_containers` give an empty container, `false` and an `error` log
- After `set_test_data_location`, `get_builtin_location` is that location, and after `release` it is the default location
- The `init` of a core module does not read containers, accessors or derived containers
- No core code other than generated code and DataCore changes containers or rows. The static check before the core test checks this
