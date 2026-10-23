# instance

The `ogw` commands that start and handle instances, and how the play agent and the judge agent play an instance.

## start and stop

- `ogw instance start <game> [--commit <sha>] [--platform <platform>] [--fixture <file>] [--db postgresql]` starts an instance and returns its id and address. With `--commit`, it starts the instance from a worktree of that commit. `ogw instance stop <id>` stops it
- `--platform` names the platform the client emulates. When omitted, it is the first item of game settings `buildPlatforms`
- `--fixture` names a save fixture file. `ogw instance start` returns an instance on which every step of the save fixture has been called. If any step fails, it stops the instance and fails
- The runner allocates a separate server process, DB (with `--db postgresql`, a disposable PostgreSQL container of the harness settings `tools.postgresql` image; otherwise SQLite) and port for each instance. The number of concurrent instances does not exceed harness settings `maxConcurrentInstances`. Instances that sub-agents started also count. When the `ogw agent` job of a sub-agent ends (success, failure and `ogw agent stop` all count), the tool first ends the jobs that agent started with `--background` that are still running (e.g. an `ogw instance start` waiting for a slot), then stops the instances that agent started
- When the number of concurrent instances is `maxConcurrentInstances`, `ogw instance start` waits until a slot frees up, and fails when the wait exceeds harness settings `instanceWaitTimeoutMs`. When it fails inside `ogw loop evaluate`, the tool stops every instance it started and every agent it called, and ends with a failure. The lead agent then redoes that step from the start. The content agent and the resource sub-agent run the same command once more, and if it fails again, they do not make the check they would make with that instance. The content agent writes that check in report `## unverified`, and the resource sub-agent leaves that resource key `final` and writes `unverified`(reason) in place of the capture path in the report
- The client of a started instance that is not a bot client logs in with a dev account and starts without the terms popup. As an exception, an instance that the play agent or the judge agent receives and that was started without a save fixture starts as a new user from the terms
- A bot client means a headless client that the runner starts on an instance (including the instance of a bot playtest) in addition to the one client. A realtime game gets an opponent bot client, and a game whose used modules (`## module` of the `core` skill) include one of `friend`, `guild`, `chat` gets a social bot client
- If the game has `server/dev/populate.ts`, the runner creates the state of other users with `## populate` of [`server-content`](../server-content/SKILL.md) before it starts the client
- The network latency and packet loss of a realtime game are emulated with core settings
- The play agent and the judge agent do not start or stop instances. They receive the instances that `ogw loop evaluate` started as input

## commands

The commands below handle the client that is not a bot client through the `QACore` automation channel.

| command | work |
|---|---|
| `ogw input <instance> <command> <argument...>` | Puts in one real input. It enters by the same path as human input. It accepts only the `QACore` built-in commands marked as input. See `ogw input --help` for the commands, arguments and timed input script format |
| `ogw input <instance> --script <file> [--video]` | Puts in the inputs of a timed input script at their written times at real speed, and returns the time and result of each input. With `--video`, it also returns the video of that period in the same format as `ogw capture --video` |
| `ogw capture <instance> [--video <ms>]` | Captures one screen. With `--video`, it keeps a video of that duration. A video is a `captures/<instance id>-<unix ms>-video/` folder that holds PNGs numbered with 5 digits from `frame-00000.png`, in capture order |
| `ogw log <instance>` | Shows the error log |
| `ogw telemetry <instance>` | Shows telemetry |
| `ogw step-mode <instance> <on\|off>` | Turns step mode on or off |
| `ogw step <instance> <ms>` | In step mode, advances time by that many ms |
| `ogw command <instance> <name> [<argument>...]` | Sends one `QACore` built-in command or content command, and prints `ok` and `result`. Used to create a state with a cheat (e.g. `set_user_state`) or to go straight to a screen (e.g. `go_to_scene`, `<feature>.open_<screen>`). See `ogw command <instance> list_commands` for the names, descriptions and arguments of content commands. It does not accept commands marked as step, `capture_screen` or `capture_video`. The play agent and the judge agent cannot use it |

## play

The play agent and the judge agent play an instance as below.

- Inputs go in only through `ogw input`
- For inputs pressed at the same time, the agent holds one down with a `_down` command, puts in the other input, and releases it with an `_up` command. e.g. attacking while moving, joystick and button
- For each scene, the agent plays in the mode that `## play mode` of that instance's `play-guide.md` (in the input file) sets
  - `free`: puts in inputs as it goes
  - `step`: turns step mode on with `ogw step-mode <instance> on` before putting in the input that enters that scene. If the scene is a realtime match, turns it on before the input that starts matching. Repeats looking with a capture, putting in inputs and advancing time with `ogw step <instance> <step ms>`. On entering a scene whose mode is not `step`, turns it off with `ogw step-mode <instance> off`. It cannot be turned off during a realtime match, so the agent turns it off after the match ends
  - `script`: after looking with a capture, writes a timed input script file and puts it in at real speed with `ogw input <instance> --script <file> --video`. Sees the result in the returned video
