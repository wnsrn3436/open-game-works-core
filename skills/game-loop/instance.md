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
- The play agent and the judge agent do not start or stop instances. They receive the instances that `ogw loop evaluate` started as input, and the judge agent gives them back with `ogw instance release`

## commands

The commands below handle the client that is not a bot client through the `QACore` automation channel.

| command | work |
|---|---|
| `ogw input <instance> <command> <argument...>` | Puts in one real input. It enters by the same path as human input. It accepts only the `QACore` built-in commands marked as input. See `ogw input --help` for the commands, arguments and timed input script format |
| `ogw input <instance> --script <file> [--video]` | Puts in the inputs of a timed input script at their written times at real speed, and returns the time and result of each input. With `--video`, it also returns the video of that period in the same format as `ogw capture --video` |
| `ogw capture <instance> [--video <ms>]` | Captures one screen as a JPEG (`captures/<instance id>-<unix ms>.jpg`; `.png` from a core before 0.3.1). With `--video`, it keeps a video of that duration. A video is a `captures/<instance id>-<unix ms>-video/` folder that holds images numbered with 5 digits from `frame-00000.jpg`, in capture order |
| `ogw log <instance>` | Shows the error log |
| `ogw telemetry <instance>` | Shows telemetry |
| `ogw step-mode <instance> <on\|off>` | Turns step mode on or off |
| `ogw step <instance> <ms> [--count <n>] [--capture] [--state]` | In step mode, advances time by ms, n times (default 1) in one call, and outputs per step the ms advanced in this call, the `device ms` after that step (the value `device ms` of `ogw telemetry <instance> --summary` has at that time: the device time since the telemetry started, which also grows between steps), and each telemetry mark added during that step with its kind and `play ms` (the `play_at` of that mark in `QACore` telemetry; `unknown` when the mark has none). With `--capture`, it captures one screen after each step in the same format as `ogw capture` and outputs its path. With `--state`, it outputs after each step the `content` of the `QACore` `get_state` of the client `main` as JSON. After a step, it does not run the remaining steps when the `scene_key`, `popups` or `panels` of the `QACore` `get_state` changed, or when a telemetry mark `Fail`, `Reward`, `Goal` or `Restart` was added, and outputs the reason and the step. When a step fails, it reads `get_state` and telemetry once more: when one of those changes happened during that step (e.g. a popup opened and paused game time, which fails the step at the command time limit), it outputs that step as ended early with the failure, the reason and, with `--capture`, its capture, does not run the remaining steps and ends with exit code 0; otherwise it outputs the failure, does not run the remaining steps and ends with exit code 1 |
| `ogw instance release <instance>` | Gives back an instance of the input of the judge agent that runs it. The evaluation stops it at its next check of that agent, so that the next agent waiting for instance slots starts sooner. It refuses an instance that is not in that input, and a caller that is not a judge agent |
| `ogw command <instance> <name> [<argument>...]` | Sends one `QACore` built-in command or content command, and prints `ok` and `result`. Used to create a state with a cheat (e.g. `set_user_state`) or to go straight to a screen (e.g. `go_to_scene`, `<feature>.open_<screen>`). See `ogw command <instance> list_commands` for the names, descriptions and arguments of content commands. It does not accept commands marked as step, `capture_screen` or `capture_video`. The play agent and the judge agent cannot use it |

## play

The play agent and the judge agent play an instance as below.

- Inputs go in only through `ogw input`
- For inputs pressed at the same time, the agent holds one down with a `_down` command, puts in the other input, and releases it with an `_up` command. e.g. attacking while moving, joystick and button
- For each scene, the agent plays in the mode that `## play mode` of that instance's `play-guide.md` (in the input file) sets
  - `free`: puts in inputs as it goes
  - `step`: turns step mode on with `ogw step-mode <instance> on` before putting in the input that enters that scene. If the scene is a realtime match, turns it on before the input that starts matching. Repeats putting in inputs and advancing time with `ogw step <instance> <step ms> --count <n> --capture`, looking at the captures it returns. n is the number of steps the agent lets pass before its next input. An input put in between steps reaches the game when it is put in, and advances game time by 1 ms per key or touch event, except in a realtime match, where game time advances only by the steps of the match While it waits for the moment of an input that the content state shows (e.g. a moving target lining up), it advances with `--state` instead of `--capture` and reads that moment from the content state, then captures the result of the input On entering a scene whose mode is not `step`, turns it off with `ogw step-mode <instance> off`. It cannot be turned off during a realtime match, so the agent turns it off after the match ends
  - `script`: after looking with a capture, writes a timed input script file and puts it in at real speed with `ogw input <instance> --script <file> --video`. Sees the result in the returned video
