# LocalDataCore

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

Saves local data (keys and values) in the device's app storage, and reads and writes the files other modules use atomically.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `load_device_file` | none | success flag | `false` | `BootstrapCore`(`InitModules`) |
| `load_user_file` | user ID | success flag | `false` | `BootstrapCore`(`AfterLogin`) |
| `is_loaded` | file kind | whether that file kind is loaded | `false` | `UICore`, `BadgeCore` |
| `get_value` | file kind, key, default value | saved value | default value | owner of the key |
| `get_array` | file kind, key, element type | copy of the saved array | empty array | owner of the key |
| `set_value` | file kind, key, value | none | none | owner of the key |
| `set_array` | file kind, key, array | none | none | owner of the key |
| `remove_value` | file kind, key | none | none | owner of the key |
| `flush` | none | none | none | `BootstrapCore`(app exit) |
| `read_file` | path, max bytes | `FileResult` | `FileResult` whose `ok` is `false` | `DataCore`, `LocalizationCore`, `GameUpdateCore`, `AuthCore` |
| `write_file` | path, bytes | `FileResult` | `FileResult` whose `ok` is `false` | `GameUpdateCore`, `AuthCore` |
| `delete_file` | path | `FileResult` | `FileResult` whose `ok` is `false` | `GameUpdateCore` |
| `file_exists` | path | whether the file exists | `false` | `DataCore`, `LocalizationCore`, `GameUpdateCore`, `ResourceCore` |
| `get_file_size` | path | byte count | −1 | `DataCore`, `LocalizationCore`, `GameUpdateCore` |
| `list_files` | folder path | list of file names directly under the folder | empty list | `GameUpdateCore` |
| `hash_file` | path | `FileResult`. `text` is the SHA-256 in lowercase hexadecimal | `FileResult` whose `ok` is `false` | `DataCore`, `LocalizationCore`, `GameUpdateCore`, `ResourceCore` |
| `resolve_engine_path` | path | path the engine opens the file with | empty string | `ResourceCore` |

- file kind: `device` (one per device), `user` (one per user ID)
- value type: int64, float64, bool, string. array type: an array of one of those four types
- `FileResult`: `ok`, `error` (`FileError`), `bytes`, `text`
- `FileError`: `None`, `InvalidPath`, `NotFound`, `TooLarge`, `NoSpace`, `Failed`

## behavior

### app storage and path

- The app storage is the device storage area the app reads and writes. Its actual location is in the engine implementation rules
- The app storage of the browser runtime is a memory file system. It is filled with the contents of IndexedDB and mounted before `BootstrapCore.start_boot`. In the first frame that starts after an operation that changes the file system (`write_file`, `delete_file`, local data file write, backup restore) returns, saving the whole file system to IndexedDB starts. If a save is in progress at that time, it starts in the first frame that starts after that save ends. The results of file operations and local data file writes are the results of the memory file system. When an IndexedDB save fails, the engine writes an error line to the browser console (not a `LogCore` log), and the next save saves the whole file system again. How mount and save are triggered is in the engine implementation rules
- app storage root: the base folder of paths. `BootstrapCore` sets its value; before it is set, it is the app storage. `log/` of `LogCore` is also under the app storage root. How a module reads the app storage root is in the engine implementation rules
- A path is relative to the app storage root and its separator is `/`. A segment is each part of a path split by `/`
- invalid path: an empty string, a character outside `[a-z0-9_./-]`, starting or ending with `/`, an empty segment, a segment starting with `.`, ending with `.tmp` or `.bak`, a first segment of `log` or `local_data`. `log` is used by `LogCore`, `local_data` by the local data files. An empty folder path of `list_files` is the root
- An operation that receives an invalid path does not access the file system
- File operations do not treat a folder as a file. When a path is a folder, it is handled as no file at that path. As an exception, `write_file` fails with `Failed`. No operation changes that folder

### local data

- Local data holds only values whose loss does not change rewards or progress. e.g. volume, language, graphics option in `device`; badge check records, sort mode in `user`
- Not kept in local data: values the server saves or judges and their cache, personal information, secrets, tokens
- A key is `<owner>.<name>`. `<name>` is snake_case. `<owner>` is the module name for core, and a feature name or `common` for content code. e.g. `AccessibilityCore.text_scale`, `inventory.sort_mode`
- malformed key: a key whose parts split by `.` are not two, whose `<owner>` is an empty string, or whose `<name>` does not pass `UtilCore.is_snake_case`
- Only the owner's code reads and writes a key, and the owner keeps it as a constant
- One key has one value type. Writing it with another type replaces it with a value of the new type
- A written value reads the same after `release`, `init`, load. A float64 has the same bits
- `set_value`, `set_array` keep a copy of the value. Writing the same type and the same value (bits for float64, code point sequence for string, length and elements for array) does nothing
- For a missing key and a key of a different type, `get_value` returns the default value and `get_array` returns an empty array. `remove_value` does nothing for a missing key
- `get_value`, `get_array`, `set_value`, `set_array`, `remove_value` check the failure conditions in the order file kind value, whether loaded, key format, type of the saved value, and give only the failure value and log of the first matching condition

### load

- `load_device_file` is called after module `init`, and `load_user_file` after login with that user ID. Switching users is done by restart
- The local data files are `local_data/device.dat`, `local_data/user_<hash>.dat`. `<hash>` is the first 16 characters of `UtilCore.sha256_hex` of the bytes of the user ID written as an ASCII decimal string. The content is the schema version and a list of (key, value type, value). The format, the format error conditions, and the entry order that makes the same file state into the same bytes are in the engine implementation rules
- The schema version is the version of the local data file format the core defines. The first schema version is 1. The schema version stays the same when content keys and values change. When the core changes the format, it raises the schema version by 1 and adds a conversion that turns files of every previous schema version into the current format
- Load does the backup restore of the local data file before reading that file
- Load ends without waiting and makes that file kind loaded regardless of the result. Exception: `load_user_file` with user ID ≤ 0 does not make it loaded
- `is_loaded` leaves no log. A file kind before load is `false`

| case | file state | dirty | output | log |
|---|---|---|---|---|
| file read | file content | not dirty | `true` | none |
| no file | empty | not dirty | `true` | none |
| size larger than `LocalDataCore.fileMaxBytes`. Not read | empty | dirty | `false` | `error` |
| backup restore failure, read failure, format error | empty | dirty | `false` | `error` |
| schema version lower than current | file content converted to the current format | dirty | `true` | none |
| schema version higher than current | empty | not dirty. write-protected | `false` | `warn` |

### local data file write

- `set_value`, `set_array`, `remove_value` change only the file state in memory and mark that file kind dirty
- When a file kind becomes dirty and no wait is in progress, it waits `LocalDataCore.writeIntervalMs` in real elapsed time. When the wait ends, it writes all dirty file kinds. If dirty remains after writing, it waits again
- On `AppBackgroundEnteredEvent`, `flush`, `release`, it writes all dirty file kinds immediately. `release` clears the state after writing
- A write writes the whole file state with an atomic write. On success it clears dirty. On failure it keeps dirty
- When the serialized size is larger than `LocalDataCore.fileMaxBytes`, it does not write. This is a write failure
- A write-protected file kind is not written even when it becomes dirty. write-protected remains until the next load of that file kind. A file of a higher schema version is left as it is so that an app that knows that version can read it again

### file operation

- A file operation returns after it ends. Per-frame code does not call file operations
- atomic write: a write after which the target file is left with either the previous content or the new content, even when it fails or the app ends midway
  1. Writes all the new content to `<path>.tmp`
  2. If the target file exists, deletes `<path>.bak` and renames the target file to `<path>.bak`
  3. Renames `<path>.tmp` to the target file
  4. Deletes `<path>.bak`
  - If 1 or 2 fails, the target file has the previous content. If 3 fails, `<path>.bak` is renamed back to the target file. If one of 1 to 3 fails, the write fails. If only 4 fails, it is a success. When it ends, there is no `<path>.tmp`
- backup restore: renaming `<path>.bak` to the target file when the target file does not exist and `<path>.bak` exists. Every file operation does a backup restore before handling the target file. `list_files` does a backup restore for each `.bak` in the folder, and when one fails, it does not do the backup restore of the remaining `.bak` files. Backup restores that already ended are not reverted
- `NotFound` of `FileError` means the target file does not exist, and `NoSpace` means atomic write step 1 failed because the remaining device space is less than the number of bytes to write. The rule that maps the engine's failure results to `FileError` is in the engine implementation rules
- `write_file` creates missing parent folders
- When the size is more than the max bytes, `read_file` does not read and fails with `TooLarge`
- `delete_file` deletes the target file and `<path>.bak`. When neither exists, it is a success
- `list_files` excludes subfolders, `.tmp`, `.bak` and returns names in byte order. When the folder does not exist, an empty list is a success
- hash chunk size: the max number of bytes `hash_file` reads at once. The value is in the engine implementation rules. `hash_file` reads the file in pieces of at most the hash chunk size
- `resolve_engine_path` returns the path even when the file does not exist
- Only `read_file` fills `bytes` of `FileResult`, and only `hash_file` fills `text`. Other operations leave them empty

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| file kind value other than `device`, `user` | `is_loaded` returns `false`. `get_value`, `get_array` return the default value, an empty array. `set_value`, `set_array`, `remove_value` are ignored | none for `is_loaded`. `error` on every call for other operations |
| `get_value`, `get_array` of a file kind before load | default value, empty array | one `error` per file kind until `release` |
| `set_value`, `set_array`, `remove_value` of a file kind before load | ignored | one `error` per file kind until `release`, counted together with the log of `get_value`, `get_array` before load |
| loading a loaded file kind again | `false`. The file state stays the same | `error` |
| user ID ≤ 0 in `load_user_file` | `false`. The file state stays the same and the `user` file kind is not made loaded (exception to the loaded rule of `### load`) | `error` |
| `get_value`, `get_array` of a key of a different type | default value, empty array | one `warn` per file kind and key until `release` |
| `get_value`, `get_array`, `set_value`, `set_array`, `remove_value` of a malformed key | default value, empty array, ignored | one `error` per key until `release` |
| local data file write failure | keeps dirty | `error`. Once per file kind and failure cause (size exceeded, `FileError` of the atomic write). Logged again after a write of that file kind succeeds or after `release` |
| invalid path in a file operation | `InvalidPath` for operations that return `FileResult`. `false` for `file_exists`, −1 for `get_file_size`, an empty list for `list_files`, an empty string for `resolve_engine_path` | none. The caller writes it |
| missing file, size exceeded, insufficient space, other failure in a file operation | `NotFound`, `TooLarge`, `NoSpace`, `Failed` for operations that return `FileResult`. `false` for `file_exists`, −1 for `get_file_size`, an empty list for `list_files` | none. The caller writes it |
| backup restore failure | `Failed` for operations that return `FileResult`. `false` for `file_exists`, −1 for `get_file_size`, an empty list for `list_files`, an empty string for `resolve_engine_path`, the read failure of the load table for local data file load | `error` |
| invalid path in `set_test_storage_root`, `set_test_storage_root` after `init` | ignored | `error` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `LocalDataCore.writeIntervalMs` | integer | core | content | duration from becoming dirty until the local data file is written |
| `LocalDataCore.fileMaxBytes` | integer | core | content | max bytes of one local data file |

## data

none

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_storage_root` | folder path | none | core test |

- The folder path is relative to the app storage, not to the app storage root, and follows the invalid path rule of file operations
- Called only before `init`. After that, every path and local data file is relative to that folder instead of the app storage root. `release` sets it back to the app storage root
- The folder may be missing. `write_file` and local data file write create it when they create missing parent folders

## test

- For each value type and array type, a written value read after `release`, `init`, load is the same. This includes float64 `-0.0`, an empty string, non-ASCII characters, an empty array
- For a missing key, `get_value` returns the default value and `get_array` returns an empty array. A key of a different type gives the default value and one `warn` log
- For each case of the load table, file state, dirty, output, log equal the table
- Local data files of every previous schema version are kept with the core test of this module. Loading each file reads the same values as those written when that file was made, and after the next write the file's schema version is the current version
- After loading a file whose schema version is higher than current, the file bytes on the device stay the same even after `set_value`, `flush`, `release`
- Two reads, a write, and a delete on a file kind before load return the default value with one `error` log, and the file on the device stays the same
- Before `load_user_file`, `is_loaded`(`user`) is `false` with no log. After a load, including a load whose output is `false`, it is `true` (`false` after `load_user_file` with user ID ≤ 0), and after `release`, `init` it is `false`. The same holds for `device`
- After becoming dirty, the file on the device stays the same before `LocalDataCore.writeIntervalMs` and has the written value after it passes. Writing to `user` while `device` is dirty writes both together
- Writing the same type and value does not make it dirty. When the caller changes a written array, the read value stays the same
- On `AppBackgroundEnteredEvent`, `flush`, `release`, dirty file kinds are written. A file kind whose write failed stays dirty and is written again after the next wait
- When writes of one file kind fail repeatedly with the same failure cause, there is one `error` log. A failure with another failure cause, and a failure after a write succeeded, each leave one more `error` log
- A value written to the `user` file of user A does not appear in the `user` file of user B after `release`, `init`
- Files written from the same file state have the same bytes even when the order of writing keys or the device locale differs
- For each format error condition of the engine implementation rules, file state, dirty, output, log of the load equal the format error row of the load table
- For each invalid path condition, `file_exists` is `false`, `get_file_size` is −1, `list_files` is an empty list, `resolve_engine_path` is an empty string, operations that return `FileResult` give `InvalidPath`, and the app storage stays the same. The same holds for `log`, `local_data` and the paths under them
- For a path that is a folder, `file_exists` is `false`, `get_file_size` is −1, `read_file` and `hash_file` give `NotFound`, `delete_file` succeeds, `write_file` gives `Failed`, and that folder and the files in it stay the same
- For a file without read permission, `file_exists` is `true` and `read_file`, `hash_file` give `Failed`. When the remaining device space is less than the number of bytes to write, `write_file` gives `NoSpace` and the target file has the previous content
- For a file kind value other than `device`, `user`, `is_loaded` is `false` with no log, and `get_value` gives the default value and an `error` log on every call
- `get_value` with a malformed key on a file kind before load leaves only the one `error` log for before load
- Giving `set_test_storage_root` an invalid path or calling it after `init` gives an `error` log, and the base folder of paths does not change. After a missing folder is given, `write_file` writes a file under that folder
- Content written with `write_file` reads the same with `read_file`, and there is no `.tmp`. When the `.tmp` write fails, the target file has the previous content
- When only `.bak` exists without the target file, `file_exists` returns `true`, `read_file` returns the content of `.bak`, and `list_files` returns the target file name
- When only `local_data/device.dat.bak` exists without `local_data/device.dat`, `load_device_file` is `true` and reads the values written in `.bak`, and after that `local_data/device.dat` exists and `.bak` does not. The same holds for the `user` file
- `read_file` returns `TooLarge` for a file of more than the max bytes. For a missing file, `read_file`, `get_file_size` give `NotFound`, −1, and `delete_file` succeeds
- `hash_file` of an empty file is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and `hash_file` of files of hash chunk size − 1, hash chunk size, hash chunk size × 2 + 1 bytes equals `UtilCore.sha256_hex`(file bytes)
- `get_value` of malformed keys (`a`, `.b`, `a.B`) gives the default value and one `error` log per key, and `set_value` does not save
- `get_array` with element type int64 on a key written as a string array gives an empty array and a `warn` log
- The `user` file name of user ID 42 is `user_`, the first 16 characters of `UtilCore.sha256_hex`(ASCII bytes of `42`), and `.dat` joined
