# UnitTestCore

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

Handles the conventions of core tests and client regression tests, test setup, the fake network and test clock, real input injection, and test runs and the result file. The whole module is DEV code.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `NetworkCore`, `InputCore`, `UICore`, `RealtimeCore`, `BootstrapCore`

- Depending on `BootstrapCore` is an exception for a DEV module. It calls only `start_boot` and `shutdown`

## API

none

## behavior

### test kind

| kind | location | data read | target |
|---|---|---|---|
| core test | next to that module in `open-game-works-core-impl/` | core test data | items of `## test` in the core spec |
| regression test | `client/tests/` of the game | game data built by the data tool | features of content code |

- A test is one function. The test name is `<test file path>::<function name>` and is unique within a run
- Test discovery and expected value comparison use those of the engine test framework. The framework is in the engine-specific implementation rules
- Core tests do not reference content code, game data, or game resources. Core test data has the system tables, the tables core defines, and the required reserved rows of every module
- A test does not depend on the results or the run order of other tests

### test setup

Before each test starts, the following runs in order.

1. `release` all modules with `BootstrapCore.shutdown`
2. Delete from app storage the files that did not exist at run start, and delete the `GameSetting` test values and the test settings
3. Create a new fake network and test clock
4. Empty the collected logs
5. Replacement registration: pass the test clock to `TimeCore.set_test_clock` and `LogCore.set_test_clock`, the fake network to `NetworkCore.set_transport`, and the log collector to `LogCore.set_log_listener`. This runs before `init` of the target module

- When, after step 2, there is an unchecked error log produced after the previous test ended, it is recorded as one run failure. The message has the previous test name (`before run` for the first test) and the log. The results of the previous test and the next test do not change
- Module initialization is one of two: the test calls `init` directly in module list order, or the test calls `start_test_boot` with a test module list (test boot)
- A test that puts in the test module list an entry that is not a static func of a module class (e.g. a method of an object in the test) ends that boot with `BootstrapCore.shutdown` before it returns. Otherwise the `shutdown` of the next test setup calls the entry of a freed object
- test boot: `start_test_boot` calls `BootstrapCore.start_boot` with a `BootTestReplacements` of `BootstrapCore` that holds the test clock, fake network, and log collector of this test and the received fake realtime transport and server URL (`http://127.0.0.1` when omitted). The boot after a restart or an update reboot also uses the same test replacements
- For the adapters and transports of a module, the test implementation is passed with the `set_*` operation of that module before `init`

### external connection

- Tests do not connect to real servers or external services. The fake network receives server requests
- fake network: an implementation of `NetworkTransport` of `NetworkCore`. Per request name, it reports the results the test registered, one at a time in registration order. A result is an immediate result (send result, HTTP status, response bytes) or pending
- For a request with no result left to use, it reports a connection failure and records that test as failed
- The fake network records received requests (name, header, body bytes) in the order received, and cancels as a count
- The UserState of a regression test is prepared with the UserState delta of a `ResponseEnvelope` the fake network reports. Tests do not change the internals of `UserStateCore`
- loopback HTTP server: used by tests that check real HTTP behavior (redirect, size, disconnection). It is created inside the test host. It gives the registered response per path under the base URL, gives 404 for a path not registered, and records received requests in order. When the test ends, UnitTestCore deletes it from the test host
- When the test ends, UnitTestCore deletes a WebSocket relay the test opened from the test host (`DELETE /ws-servers/<n>`)
- fake realtime transport: a transport implementation of `RealtimeCore`. At the next `poll` it emits the transport notices added with `add_realtime_notice`, in the order added. It records received transport operation calls in the order received. `send_packet` returns the result set with `set_realtime_send_result` for that participant index, and success when none is set. A test decides the behavior of other participants with these notices and results. It also receives and records the transport DEV operations `force_close_peer`(participant index) and `force_close_matchmaker`, and at the next `poll` emits, respectively, peer lost for that participant and matchmaker lost with error code 0. `lockstep_time` always returns none

### test host

- test host: the HTTP server that the tool running the tests starts per run on a free port of `127.0.0.1`. The run receives that URL (`http://127.0.0.1:<port>`) as input. UnitTestCore does not listen on a socket, so that browser runs also use the same path
- test host request

  | request | body | response |
  |---|---|---|
  | `POST /servers` | none | 201. `{"base_url": "<test host URL>/servers/<n>/files"}`. `n` counts up from 1 within the run |
  | `PUT /servers/<n>/responses` | `{"path": "<path after base URL>", "status": <int>, "headers": [["<name>", "<value>"], ...], "body": "<base64>"}` | 204. replaces the earlier response of the same path |
  | `GET /servers/<n>/requests` | none | 200. `[{"path": "<path>", "headers": [["<name>", "<value>"], ...], "body": "<base64>"}, ...]` holding the requests that server received, in the order received |
  | `DELETE /servers/<n>` | none | 204. later requests under that base URL get 404 |
  | `PUT /result` | result JSON | 204. the tool writes it as the result file |
  | `PUT /released` | `{"run_id": "<run ID>"}` | 204 |
  | `POST /ws-servers` | none | 201. `{"url": "ws://127.0.0.1:<port>/ws/<n>/client", "control_url": "ws://127.0.0.1:<port>/ws/<n>/control"}`. `n` counts up from 1 within the run |
  | `DELETE /ws-servers/<n>` | none | 204. closes the connections of that WebSocket relay with code 1001. later connections to that relay get 404 |
  | `POST /input` | `{"type": "click", "x": <CSS px>, "y": <CSS px>}` or `{"type": "key", "key": "<DOM key value>"}` | 204 after the tool puts that input into the page in a browser run. When it cannot put it in, 500 `{"error": "<English>"}`, and the tool records the cause as a failure of that run. 400 when the body differs from the format. 404 in a native run regardless of the body |
  | `GET /app/<path>` | none | web export file of the browser run |

- A server number that does not exist and a request not in the table get 404
- WebSocket relay: a server that tests checking a real WebSocket connection (e.g. the matchmaker connection) use by the same path in native runs and browser runs. The client connects to `url` or to an address that appends a path and query to it, and the test connects to `control_url`
  - Per client connection, the relay reports to the control connection with JSON text frames: connection `{"event": "open", "conn": <number counting up from 1 within the relay>, "path": "<path and query after url>", "protocols": ["<subprotocol the client offered>", ...]}`, received frame `{"event": "message", "conn": <number>, "binary": <bool>, "data": "<base64>"}`, close `{"event": "close", "conn": <number>, "code": <int>, "reason": "<string>"}`
  - The control sends a frame to that client with `{"op": "send", "conn": <number>, "binary": <bool>, "data": "<base64>"}` and closes that connection with `{"op": "close", "conn": <number>, "code": <int>, "reason": "<string>"}`. For a control frame the relay cannot carry out (not a JSON object, a number with no open client connection, an unknown `op`, a code that cannot be used in a close frame (outside 1000~1003, 1007~1014, 3000~4999) or a reason of more than 123 bytes), the relay does nothing and sends `{"event": "error", "message": "<English>"}` to the control
  - The relay accepts the first of the subprotocols the client offered. There is one control connection per relay, and a second control connection is closed with code 1008. Notices before the control connects are kept in order and sent when the control connects. When the control connection closes, the relay closes its client connections with code 1001
- In a browser run the tool puts `POST /input` into the page with DevTools `Input.dispatchMouseEvent`(left button press and release, click count 1) or `Input.dispatchKeyEvent`(key press and release). The browser receives it as human input, so it gives the page user activation (e.g. audio resume, fullscreen request)
- The page of a browser run and the loopback HTTP servers are on the one origin of the test host, so there is no CORS

### time, random, storage

- test clock: the clock that `TimeCore` and `LogCore` read instead of the device. Monotonic time starts at 0, and device time starts at the fixed value of the engine-specific implementation rules. It changes only through test clock operations
- `advance_clock` moves device time by that duration, and also moves monotonic time by that duration when it is not device sleep. Device sleep is handled as background progress. After that, when the init check of `TimeCore` is `true`, it calls `TimeCore.step_test_frame`(duration, background progress flag, device sleep flag), and when it is `false`, it does not. The background progress flag passed is `true` when the background progress flag of the input is `true` or it is device sleep. For background progress, `TimeCore` handles that duration as time spent in the background
- Durations the engine measures itself (engine timer, animation) do not follow the test clock
- The random seed is a fixed value written in the test code. The seed is not set from the device clock or engine random
- For `GameSetting` values, tests set test values with the DEV accessor of the data tool. Test setup deletes them
- test settings: values of core settings keys or game settings paths set with `set_test_settings`. When a module reads a core settings or game settings value and the test settings have that key, it uses that value. They are set before `init` of the target module. Test setup deletes them
- `set_invalid_test_settings` is `set_test_settings` without the type check of the value. Core tests that check whether module `init` fails on a settings value with a wrong type use it

### input

- Test input is put in with `InputCore.inject_device_input`. The input enters at the very front of engine input handling and passes the same path as human input
- Tests do not call input handlers, click functions of UI elements, or engine input signals directly. An automated check blocks it

### log

- collected logs: the level and tag of the logs the log collector received in the current test
- Logs whose count was received with `check_logs` become checked logs. A test with an unchecked error log left fails
- A test with an unchecked engine script runtime error left fails. The result has `checked_script_errors` (the checked count) per test, and only when the number of `SCRIPT ERROR:` lines in the engine output equals their sum does the tool not treat the run as failed because of those lines. An engine script runtime error that occurs between tests (after one test ends and before the next test setup) is a run failure
- The error log count is asserted with `check_logs` only when the expected value is not 0

### async wait

- The completion of an async operation is waited for with its completion result or an event. It is not waited for with a polling loop that has a frame count limit. An automated check blocks it
- A condition without an event (e.g. boot stage, a message of a loopback socket, accumulated WebRTC signals) is checked every frame without a frame count limit, and the wait ends when the module is released with `release`. The test time limit also calls `release` on the module
- A core test that waits by frames for a flow that first loads a resource loads that resource beforehand with `ResourceCore.preload` and waits for its result. A test that needs the loading state waits for the result of that load
- `wait_frames` is used only for targets whose progress is decided by engine frames (tween, layout, deferred call)
- event latch: created before the action that raises the event, and when waited on, ends at once when the event has already occurred. Its result holds whether the event had already occurred before the wait. A latch created before `EventCore` is initialized with `init` subscribes when it receives the init notice of `EventCoreDev`. `release` deletes that registration, so UnitTestCore registers again at each test boot and each time `EventCore` is released with `release` during a test (restart, update reboot)

### run and result file

- test run: a native run starts the engine from the command line, and a browser run opens the web export in a headless browser. A browser run runs only core tests. The method is in the engine-specific implementation rules. The input is the run target (all, or a list of files and folders), run ID, test host URL, shared fixture folder, and core fixture folder. The shared fixture folder exists only for regression tests of a native run and is `data/fixtures/` of the game. The core fixture folder exists only for core tests and holds the files of `open-game-works-core-impl/fixtures/`
- A native run is a `headless pass` that does not draw the screen. As an exception, render tests among core tests run only in a `render pass` that draws the screen. A render test is a core test that reads pixels or captures of the drawn screen, and whether a test is a render test is decided by the test file name that the engine-specific implementation rules set. A render pass runs only render tests. A browser run draws the screen, so it also runs render tests
- At the start of a run, the run calls `init` on UnitTestCore, records the file list of app storage, and hides the test runner's own GUI for the whole run (it does not receive input over the test screen or appear in captures), and at the end it calls `release`. `release` resets the replacements the last test setup put in (test clock, log collector, fake transport) to none with the DEV operation of each module, and deletes the files not in the record
- A core test that calls `release` on a module directly and calls `init` again does not call `release` on `LogCore` or `TimeCore`: the replacements of test setup are put in only at test setup and test boot
- One test must end within `UnitTestCore.testTimeLimitMs`, and the whole run within `UnitTestCore.runTimeLimitMs`. A test that exceeds its limit fails, and when the whole run exceeds its limit, the remaining tests do not run and it is recorded as a run failure. When a test that exceeded the time limit does not end within another `UnitTestCore.testTimeLimitMs` after that (e.g. it waits on a signal that never fires), that test fails, and as when the whole run exceeds its limit, the remaining tests do not run and it is recorded as a run failure. This is because the test framework cannot stop a test function and so cannot run the next test
- failure: assert failure, throw, unchecked error log, request with no result to use, time limit exceeded
- skip: only core tests are skipped. A test is skipped with `require_platform` in a run whose current platform is outside the list, and render tests are skipped in a headless pass. The platform of a browser run is `web`. Regression tests have no skip
- exit code: 0 when all tests are pass or skip, there is no run failure, and there is at least one test, otherwise 1. A browser run has no exit code, and the tool applies the same rule to the result it receives. The engine timer starts after the engine is up, so when the tool does not receive the result within `UnitTestCore.runTimeLimitMs` plus the boot duration the engine-specific implementation rules set, counted from when it starts the process or opens the page, it treats that run as failed
- result: one UTF-8 JSON. At the end of the run it is sent to the test host with `PUT /result`, and the tool writes it as the result file
- After `release` finishes (for a run whose `init` failed, after sending its result; for a run that exceeded the whole-run time limit, after `release` and before ending), the run sends `PUT /released` and then writes one line `UnitTestCore released run <run ID>` to the engine output. This line is the last line UnitTestCore writes in that run. When the request fails, the test host request failure row of `## error` applies, and the exit code does not change

  ```
  {
    "run_id": "<string>",
    "kind": "core" | "regression",
    "engine": "<engine>",
    "started_at": <Unix ms>,
    "finished_at": <Unix ms>,
    "results": [
      { "name": "<test name>", "status": "pass" | "fail" | "skip", "duration_ms": <int>, "message": "<English. empty string when pass>", "checked_script_errors": <int> }
    ],
    "run_failures": [ { "message": "<English>" } ],
    "warn_counts": { "<log tag>": <int> }
  }
  ```

- A test file that cannot be loaded is a run failure per file. When there are 0 tests, it is run failure `no tests`
- Repeating the run on the same commit gives the same result per test

### lifecycle

- Only the test run calls `init` and `release` of UnitTestCore. The module list and reverse release of `BootstrapCore` do not handle UnitTestCore

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| `advance_clock` with a negative duration | does nothing | error |
| `release_pending` with no pending request | `false` | none |
| a test host request fails | failure value | error |
| `put_page_click`, `put_page_key`(test host 404) in a native run | `false` | none |
| `put_page_key` with an empty key | `false` | error |
| `require_platform` called in a regression test | that test fails | error |
| `set_test_settings` with a key not in core settings or in the game settings values core reads, or with a value whose type differs from that key, `set_test_settings` called in a regression test | `false`. that test fails | error |
| `set_invalid_test_settings` with a key not in core settings or in the game settings values core reads, `set_invalid_test_settings` called in a regression test | `false`. that test fails | error |
| `read_shared_fixture` with no shared fixture folder or no file of that name, `read_shared_fixture` called in a core test | empty string. that test fails | error |
| `read_core_fixture` with no core fixture folder or no file of that name, `read_core_fixture` called in a regression test | empty string. that test fails | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `UnitTestCore.testTimeLimitMs` | integer | core | human | time limit of one test |
| `UnitTestCore.runTimeLimitMs` | integer | core | human | time limit of a whole test run |

## data

none

## DEV

The whole module is DEV code. STG and PROD builds do not have UnitTestCore, `client/tests/`, or core test data.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `add_result` | request name, send result, HTTP status, response bytes | none | none | test |
| `open_ws_relay` | none | async operation. `url` and `control_url` of a test host WebSocket relay | both empty strings | test |
| `put_page_click` | CSS px position in the page | async operation. whether the test host put a left click into the page of the browser run | `false` | test |
| `put_page_key` | DOM `key` value | async operation. whether the test host put a key press into the page of the browser run | `false` | test |
| `add_pending` | request name | none | none | test |
| `release_pending` | request name, send result, HTTP status, response bytes | success flag. reports to the earliest pending request of that name | `false` | test |
| `make_response` | `ResponseEnvelope` | response bytes | none | test |
| `received_requests` | none | list of received requests | empty list | test |
| `cancel_count` | none | number of cancels received | 0 | test |
| `advance_clock` | duration ms, background progress flag, device sleep flag(`false` when omitted) | none | none | test |
| `set_device_time` | Unix ms | none. monotonic time unchanged | none | test |
| `tap` | game coordinates | none. puts in a press and release with `InputCore.inject_device_input` | none | test |
| `tap_anchor` | anchor name, anchor key(optional) | success flag. when `UICore.get_anchor_rect`(anchor name, anchor key) gives a visible rectangle, `tap` at its center | `false` | test |
| `check_logs` | level(`warn`, `error`), tag | number of unchecked logs of that level and tag | 0 | test |
| `check_script_errors` | none | number of engine script runtime errors not yet checked in this test. the returned errors become checked errors | 0 | test |
| `latch_event` | event type | latch | none | test |
| `wait_latch` | latch | async operation. whether the event had already occurred before the wait | none | test |
| `wait_frames` | frame count | async operation. none | none | test |
| `start_http_server` | none | async operation. base URL of a loopback HTTP server created in the test host | empty string | test |
| `add_http_response` | base URL, path, HTTP status, header list, body bytes | async operation. success flag | `false` | test |
| `http_requests` | base URL | async operation. list of received requests(path, header, body) | empty list | test |
| `create_fake_realtime` | none | new fake realtime transport | none | test |
| `add_realtime_notice` | fake realtime transport, transport notice, payload | none | none | test |
| `set_realtime_send_result` | fake realtime transport, participant index, success flag | none | none | test |
| `realtime_calls` | fake realtime transport | list of received transport operation calls(name, input) | empty list | test |
| `require_platform` | platform list | none. when the current platform is not in the list, ends that test as skip | none | core test |
| `set_test_settings` | core settings key or game settings path that core reads, value | success flag | `false` | core test |
| `set_invalid_test_settings` | core settings key or game settings path that core reads, value | success flag | `false` | core test |
| `start_test_boot` | content entry, module list, fake realtime transport(optional), server URL(optional), update downloads(optional. that field of `BootTestReplacements`) | none | none | test |
| `read_shared_fixture` | shared formula name | content string of `<name>.json` in the shared fixture folder | empty string | regression test |
| `read_core_fixture` | core test fixture name | content string of `<name>.json` in the core fixture folder | empty string | core test |

## test

- A test that does not end even after the time limit is fail, the tests after it do not run, and there is one run failure that contains that test name
- Through a WebSocket relay, open(path, protocols), message(binary, text), and close of a client connection arrive at the control in order. Notices before the control connects arrive when it connects. `send` and `close` of the control reach the client, and a control frame the relay cannot carry out gives an `error` notice. When the test ends, the connections of that relay close with code 1001
- In a browser run, `put_page_click` and `put_page_key` are `true` and arrive in the page as human input (`navigator.userActivation.isActive` is `true`), and the engine receives the press and release. In a native run they are `false` without an error log
- Even when the previous test ends with a module still initialized by `init`, `init` of that module succeeds in the next test
- `check_script_errors` returns the number of script runtime errors not yet checked in that test and makes those errors checked. A test with an unchecked error left fails, and `checked_script_errors` per test in the result is the number checked in that test. A script runtime error between tests is a run failure
- The result of running test files one at a time and the result of running all of them at once are the same per test
- A file the previous test wrote to app storage does not exist at the start of the next test, and when the run ends, files that did not exist at its start are gone and files that existed remain
- `TimeCore` and `LogCore` initialized by the test with `init` use the test clock, `NetworkCore` uses the fake network, and `LogCore` uses the log collector. The same holds in the first boot of `start_test_boot`, the boot after a restart, and the boot after an update reboot, and `RealtimeCore` uses the passed fake realtime transport
- The fake network reports results of the same name in registration order, and `received_requests` is in the order received. A request with no result gets a connection failure, and that test is recorded as failed
- A pending request has no result before `release_pending` and gets the input result after it. Without a pending request it is `false`. A cancel while pending increases `cancel_count` by 1
- Without `advance_clock`, the monotonic time and device time of `TimeCore` are unchanged; with d both increase by d; with d as device sleep only device time increases by d; and a negative value leaves them unchanged after an error log
- In a test that did not run `init` on `TimeCore`, `advance_clock` moves only the test clock without an error log. In a test that ran `init` on `TimeCore`, d with background progress flag `false` and device sleep makes `TimeCore` handle background entry and return, and the background elapsed time is d
- `tap` delivers a press and release over a UI element to that element, and does not deliver them when there is a block over that element
- During a run the test runner GUI is hidden, and `tap` is delivered to a UI element at the place of that GUI. That GUI place is where a test runner GUI element that blocks the pointer sits inside the visible game area. The test runner GUI is laid out with the screen size at run start, so that place differs per run kind
- When anchor keys 7 and 9 are set on two `UIButton` elements with a `UIAnchor` of the same anchor name, `tap_anchor`(name, 9) clicks only the element with key 9 and returns `true`, and `tap_anchor`(name, 8) returns `false` without a click
- A test with an unchecked error log left is recorded as failed, and when all are checked it does not fail because of logs
- An error log produced by the `release` of the previous test remains as a run failure in the next test setup, and the results of the two tests do not change
- With any of a failed test, a test file that could not be loaded, or 0 tests, the exit code is 1, and when all pass it is 0
- In a headless pass render tests are recorded as skip, and in a render pass only render tests run and are recorded as pass or fail
- The result file has the format above and contains every test that ran
- A test that exceeds `UnitTestCore.testTimeLimitMs` is fail, and the next test runs
- A latch created before the event and waited on after the event ends at once with already-occurred `true`, and when waited on before the event, it ends after the event with `false`
- Two loopback HTTP servers get different base URLs and each records only the requests it received, a path not registered gets 404, and when the test ends that base URL gets 404
- `require_platform` records a core test whose current platform is not in the list as skip, and in a regression test it gives fail
- A module initialized with `init` after `set_test_settings` reads the set value, and in the next test that key reads the value without test settings. A key that does not exist, a value with a different type, and a call in a regression test give `false` and an error log, and that test fails
- `read_shared_fixture` returns the content of the file of that name in the shared fixture folder, and a name that does not exist and a call in a core test give an empty string and an error log, and that test fails
- `read_core_fixture` returns the content of the file of that name in the core fixture folder, and a name that does not exist and a call in a regression test give an empty string and an error log, and that test fails
- The fake realtime transport emits the added notices at the next `poll` in the order added, `realtime_calls` returns the received calls in order, and `send_packet` of a participant set with `set_realtime_send_result` gives that result
