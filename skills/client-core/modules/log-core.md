# LogCore

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

Writes diagnostic logs to the log file, and collects error logs and analytics events and sends them to the server's `logging` module.

## dependency

`UtilCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `log_debug`, `log_info`, `log_warn`, `log_error` | tag, message | none | none | all code |
| `track_event` | event name, parameter list | success flag | `false` | all code |
| `notify_app_state` | one of `background`, `foreground`, `quit` | none | none | `TimeCore`(`background`, `foreground`), `BootstrapCore`(`quit`. app exit) |
| `set_sender` | sender | none | none | `NetworkCore` |
| `clear_sender` | none | none | none | `NetworkCore` |
| `set_analytics_allowed` | whether analytics events may be collected | none | none | `AuthCore` |

- sender: a function that receives one `LogBatch` and returns no result. `NetworkCore` registers it after login, and it sends the received `LogBatch` to the server's `logging` module with core `rpc` `ReportClientErrors`, `ReportAnalyticsEvents`
- `LogBatch`: `errors` (list of `LogEntry`, in insertion order), `dropped_error_count`, `events` (list of `AnalyticsEvent`, in insertion order), `dropped_event_count`
- `LogEntry`: `time`(Unix ms), `level`, `tag`, `message`, `stack_trace`
- `AnalyticsEvent`: `name`, `time`(Unix ms), `params` (parameter list)
- parameter: name and value. The value type is one of int64, float64, string, bool

## behavior

### level and log entry

| level | use |
|---|---|
| `debug` | tracing the flow during development |
| `info` | main occurrences of the normal flow |
| `warn` | an abnormality after which handling can continue. Includes requests ignored by rule |
| `error` | a failure in which an operation did not achieve its purpose |

- A log operation ends without waiting and is called only on the main thread
- STG·PROD builds have no `log_debug` calls and no calculation of their arguments. The method is in the engine implementation rules. Arguments of `log_debug`, `log_info`, `log_warn` do not use expressions with side effects
- `time` is the device time. LogCore reads the device time and monotonic time directly from the device without going through `TimeCore`, and measures a duration as a difference of monotonic time
- The tag is the name of the code that wrote the log: the module name for core, and a feature name of `client/features/` or `common`, `boot`, `dev` for content code
- The message is in English. Tags, messages, event parameters do not contain secrets, tokens, raw receipt text, personal information, text the user entered
- `stack_trace` is text that joins the outer call frames, from the position that called the log operation outward, with LF. Frames inside LogCore are not included. Only `error` holds it, and it is empty text for other levels and in runtime environments that do not give frames

### log line and console

- A log line joins `time`, `level`, `tag`, `message`, `stack_trace` in this order with tabs and ends with LF. `time` is a decimal integer
- `\`, tab, LF, CR, U+0000 in tag, message, `stack_trace` are replaced with `\\`, `\t`, `\n`, `\r`, `\0`
- A build with DEV code writes log lines to the console. STG·PROD builds do not write to the console

### log file

- The log files are `log/log_<n>.txt` under the app storage root of `LocalDataCore`. `<n>` is a decimal integer of 1 or more, with at most 18 digits, that does not start with 0. A file not in this format is not treated as a log file
- LogCore handles the `log/` folder directly with the engine file API. Other modules do not use `log/`
- When the `log/` folder does not exist, `init` creates it, and it starts the file of the current largest `<n>` + 1 as the current log file
- A log line is put into the write buffer. Appending the write buffer to the end of the current log file at once and emptying it is called flush. Flush happens:
  - Right after an `error` log line is put in. Before `log_error` returns
  - When `LogCore.fileWriteIntervalMs` has passed since a line was put into an empty write buffer
  - On `background`, `quit` of `notify_app_state` and on `release`
- When putting in a line would make the current log file size (the UTF-8 byte sum of the appended lines and the write buffer) more than `LogCore.fileMaxBytes`, it flushes, starts a new file of `<n>` + 1 as the current log file, and then puts the line in
- A line larger than `LogCore.fileMaxBytes` is not put in. No new file is started either
- Each time a new file is started, when the number of log files including the current log file is more than `LogCore.fileMaxCount`, files are deleted starting from the smallest `<n>`

### send

- `error` logs go into the error queue, and events that `track_event` received go into the event queue. When a queue has `LogCore.errorQueueMaxCount`, `LogCore.eventQueueMaxCount` items, the item is not put in and the dropped count increases by 1
- When there is a sender and one or more queues are not empty, it calls the sender
  - The interval between two calls is `LogCore.sendIntervalMs` or more, and it calls in the earliest frame that interval allows
  - It does not call inside log operations and `track_event`
  - The `LogBatch` holds all items of both queues and the dropped counts, and after it is passed, the queues and dropped counts are emptied
  - `message` and `stack_trace` of the `LogBatch` hold only up to `LogCore.sendTextMaxLength` code points from the start, and `tag` only up to `LogCore.sendTagMaxLength` code points from the start
- When there is no sender, the queues and dropped counts stay as they are
- An `error` log written during a sender call is not put into the error queue. It is written to the log file
- The sender does not read the received `LogBatch` after it returns, and writes a send failure at `warn` level or lower. LogCore does not send again a `LogBatch` that could not be sent

### analytics event

- The analytics allowed state is `false` at `init` and changes only with `set_analytics_allowed`. `AuthCore` calls it with the user's analytics consent
- When the allowed state is `false`, `track_event` does not put in the event and returns `false` without a log. When it changes to `false`, the event queue and `dropped_event_count` are emptied. Error logs are sent regardless of the allowed state
- When the allowed state is `true` and all of the below are satisfied, `track_event` puts the event into the event queue and returns `true`
  - The event name passes `UtilCore.is_snake_case` and is `LogCore.eventNameMaxLength` code points or less
  - The event name does not start with `core_`. `core_` names are core analytics events that server core modules emit
  - The number of parameters is `LogCore.eventParamMaxCount` or less, and the parameter names are snake_case, `LogCore.eventParamNameMaxLength` code points or less, and differ from each other
  - String values are `LogCore.eventStringMaxLength` code points or less. Float64 values are not NaN or infinite
- The `time` of an event is the device time when `track_event` was called
- Content code defines the meaning of event names and parameters. e.g. `stage_clear`(`stage_id`, `elapsed_ms`)

### abnormal exit

- On `init` and `notify_app_state(foreground)`, it creates the `log/running` marker file. On `release`, `notify_app_state(background)`, `notify_app_state(quit)`, it deletes it. When there is no marker file to delete, it is treated as deleted
- When the marker file already exists at `init`, the previous run exited abnormally. After creating the marker anew, it writes an `error` log with tag `LogCore`, message `abnormal exit`

### lifecycle

- `release` flushes, then deletes the sender, queues, dropped counts, and sets the analytics allowed state to `false`
- Log operations before `init` and after `release` write only to the console of a build with DEV code. `track_event` returns `false`. `notify_app_state`, `set_sender`, `clear_sender` do nothing

## hook

none

## event

none

## error

A failure whose log is LogCore failure is not written with a log operation. A LogCore failure is written as an `error` line with tag `LogCore` to the console of a build with DEV code, and passed to the listener registered with `set_log_listener`.

| condition | failure value | log |
|---|---|---|
| `init` of an `init`ed LogCore | `false`. The state is not changed | LogCore failure |
| `track_event`, `notify_app_state`, `set_sender`, `clear_sender` before `init`, after `release` | `false` or none | LogCore failure |
| input of `track_event` violates the conditions of behavior | `false`. The event is not put in | one `error` log per event name until `release` |
| log folder cannot be created or read, flush failure, failure deleting an old file | `init` returns `true` | Stops writing the log file and empties the write buffer. Does not put into the write buffer until the next `init`. Puts one `LogEntry` with tag `LogCore` into the error queue. Console, sending, listener continue |
| marker file cannot be created, existing marker file cannot be deleted | none | LogCore failure. Continues |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `LogCore.fileMaxBytes` | integer | core | content | max bytes of one log file |
| `LogCore.fileMaxCount` | integer | core | content | max number of log files |
| `LogCore.fileWriteIntervalMs` | integer | core | content | duration from putting the first line into the write buffer until flush |
| `LogCore.sendIntervalMs` | integer | core | content | minimum duration between sender calls |
| `LogCore.errorQueueMaxCount` | integer | core | content | max number of items in the error queue |
| `LogCore.eventQueueMaxCount` | integer | core | content | max number of items in the event queue |
| `LogCore.sendTextMaxLength` | integer | core | content | max number of code points of one `message`, `stack_trace` held in a `LogBatch` |
| `LogCore.sendTagMaxLength` | integer | core | content | max number of code points of one `tag` held in a `LogBatch` |
| `LogCore.eventNameMaxLength` | integer | core | content | max number of code points of an event name |
| `LogCore.eventParamMaxCount` | integer | core | content | max number of parameters of one event |
| `LogCore.eventParamNameMaxLength` | integer | core | content | max number of code points of a parameter name |
| `LogCore.eventStringMaxLength` | integer | core | content | max number of code points of a string parameter value |

settings constraint

| left | factor | right |
|---|---|---|
| `LogCore.errorQueueMaxCount` | 1 | `logging.maxErrorEntries` |
| `LogCore.sendTagMaxLength` | 1 | `logging.maxStringLength` |
| `LogCore.sendTextMaxLength` | 1 | `logging.maxErrorMessageLength` |
| `LogCore.sendTextMaxLength` | 1 | `logging.maxStackTraceLength` |
| `LogCore.eventQueueMaxCount` | 1 | `logging.maxEvents` |
| `LogCore.eventNameMaxLength` | 1 | `logging.maxStringLength` |
| `LogCore.eventParamMaxCount` | 1 | `logging.maxEventParams` |
| `LogCore.eventParamNameMaxLength` | 1 | `logging.maxStringLength` |
| `LogCore.eventStringMaxLength` | 1 | `logging.maxStringLength` |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_log_listener` | listener: a function that receives level, tag, message. When it is a custom `Callable` (lambda, `bind()`), it is not registered and an `error` line with tag `LogCore` goes to the console | none | none | `UnitTestCore`, `BootstrapCore` |
| `set_test_clock` | test clock | none | none | `UnitTestCore`, `BootstrapCore` |
| `list_log_files` | none | list of log file paths. In ascending order of `<n>`. It flushes before listing | empty list | `QACore` |

- `set_log_listener` can be called before and after `init`. The listener is called before `warn`, `error` log operations return. There is one listener, and registering again replaces it. `release` deletes it
- The test clock is the same object as the test clock of `TimeCore`. When there is a test clock, LogCore reads the device time and monotonic time from the test clock instead of the device. `set_test_clock` is called only before `init`. `release` deletes it
- STG·PROD builds do not have the operations above

## test

- After the four log operations, the current log file of `list_log_files` has the log lines in call order, and their format equals the log line of behavior
- The log line of a tag and message that contain tab, LF, CR, `\`, U+0000 is one line, and reverting the escapes gives the original values
- Only the `error` log line has `stack_trace`, and its first frame is the position that called the log operation. This is checked only in runtime environments that give frames
- Each `init` writes to the file of the previous largest `<n>` + 1. When `log_2.txt`, `log_02.txt`, `log_0.txt`, and a file with a 19-digit `<n>` exist, writing one log after `init` makes `list_log_files` return only `log/log_2.txt`, `log/log_3.txt`
- When many times `LogCore.fileMaxBytes` is written, every log file is `LogCore.fileMaxBytes` or less, the number of files is `LogCore.fileMaxCount` or less, and the deleted files are the files with the smallest `<n>`. A line larger than `LogCore.fileMaxBytes` is not written, and the next line is written
- A `warn` line is not in the file before `LogCore.fileWriteIntervalMs` and is there after it passes. Right after `log_error` returns, that line and the lines before it are in the file. On `background`, `quit`, `release`, the write buffer is written to the file
- A `LogBatch` has only `error` logs and events of `track_event`. When `error` logs are written in a row, the interval between sender calls is `LogCore.sendIntervalMs` or more, the number of items is `LogCore.errorQueueMaxCount` or less, and the overflow count equals `dropped_error_count`
- The sender is not called inside `log_error` and `track_event`. An `error` log written before sender registration is in the first `LogBatch` after registration. After `clear_sender`, the sender is not called
- An `error` log written during a sender call is not in later `LogBatch` values and is in the log file
- `track_event` returns `false` and does not put in the event for a name that is not snake_case, a name starting with `core_`, duplicate parameter names, a parameter name longer than `LogCore.eventParamNameMaxLength`, a parameter count and string over the limit, NaN. Failures of the same name give one `error` log
- `message` of the `LogBatch` is cut to `LogCore.sendTextMaxLength` code points, and `tag` to `LogCore.sendTagMaxLength` code points
- When the log folder cannot be created, `init` returns `true`, and the item with tag `LogCore` and later `error` logs are passed to the sender
- When `init` runs after an exit without `release`, one `abnormal exit` `error` log is written, and when `init` runs after `release`, it is not written
- When `release` is called after `notify_app_state(quit)`, there is no `log/running` and no LogCore failure. The same holds for `release` after `notify_app_state(background)`
- Log operations before `init` and after `release` pass nothing to the log file and the sender. `init` of an `init`ed LogCore is `false`, and the log file and queues do not change
- When `init` runs after `release`, the previous sender and listener are not called and the previous queue items are not in the `LogBatch`
- A listener passed with `set_log_listener` before `init` receives `warn` logs after `init`
- `track_event` before `set_analytics_allowed(true)` and after `false` is `false` without a log, and there is no event in the `LogBatch`. When it changes to `false`, the events that were in the queue are not in later `LogBatch` values. Error logs are in the `LogBatch` regardless of the allowed state
- The listener is called for each `warn`, `error` before the operation returns, and is not called for `debug`, `info`
- Every `log_debug` call of core code is in the `log_debug` removal form of the engine implementation rules. The static check before the core test checks it
- The log line `time` of a LogCore `init`ed after `set_test_clock` is the device time of the test clock, and `LogCore.fileWriteIntervalMs` and `LogCore.sendIntervalMs` are judged by the monotonic time of the test clock
