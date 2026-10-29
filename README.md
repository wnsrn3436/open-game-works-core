# open-game-works

[한국어](README.ko.md)

AI agents make server-client games on top of a prebuilt core, aiming for commercial quality.

https://github.com/user-attachments/assets/fb74b4ca-cc63-430d-af79-5b5118ec9c8a

https://github.com/user-attachments/assets/9cf4f284-32c5-4f82-9c3f-13d17cbc12ec

<table>
  <tr>
    <td align="center" width="50%"><img src=".github/media/iso-survivors.gif" alt="iso-survivors gameplay"><br><a href="https://github.com/wnsrn3436/open-game-works-game-iso-survivors">iso-survivors</a>: isometric 3D horde survival</td>
    <td align="center" width="50%"><img src=".github/media/mana-clash.gif" alt="mana-clash gameplay"><br><a href="https://github.com/wnsrn3436/open-game-works-game-mana-clash">mana-clash</a>: one-on-one card battle</td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src=".github/media/pong.gif" alt="pong gameplay"><br><a href="https://github.com/wnsrn3436/open-game-works-game-pong">pong</a>: paddle game against the CPU</td>
    <td align="center" width="50%"><img src=".github/media/card-duel.gif" alt="card-duel gameplay" width="220"><br>card-duel: real-time card battle against an AI, made with a very early version of open-game-works (repository not published)</td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src=".github/media/block-stack.gif" alt="block-stack gameplay"><br><a href="https://github.com/wnsrn3436/open-game-works-game-block-stack">block-stack</a>: one-tap block stacking</td>
  </tr>
</table>

open-game-works is a harness in which AI agents make server-client games. The goal is games that reach commercial quality in both fun and completeness.

- Features that many games would rebuild the same way (infra, live ops, store policy, meta systems) are prebuilt as **core**. Agents write only the gameplay, as **content code**.
- You give one command, such as `create game: <game>`. The agent that receives it calls a sub-agent for each role and runs an edit, check and judge loop until it stops, then reports to you.
- Fun is judged by judge agents that play the game blind against the previous version. Completeness is judged by automated checks (bot playtests, profiling, UI captures).

This repository is the harness: the rules the agents follow, the skills and core module specs they read, the settings, and the CLI `ogw`. You use it from a Claude Code or Codex session opened in this folder.

## Status

Under active development. Tested only on macOS with Claude Code (Claude Opus 5.5, high effort). Codex CLI is supported in the settings but has not been tested. The `build` command has not been run yet, so no game has been built or deployed. Commands, settings and file formats can still change.

## Quick start

You need macOS on Apple silicon, Node.js 24 or later, Git, the GitHub CLI (`gh`, logged in), Docker with `docker buildx`, uv, and Claude Code (logged in). `update env` checks the rest and downloads the engine and pinned tools itself.

```sh
mkdir open-game-works && cd open-game-works
git clone https://github.com/wnsrn3436/open-game-works-core.git
git clone https://github.com/wnsrn3436/open-game-works-core-impl.git

cd open-game-works-core/tools && npm ci && cd ..
export PATH="$PWD/tools/bin:$PATH"   # add the full path to your shell profile to keep it

# a long-lived Claude Code token for the play and judge agents
claude setup-token
pbpaste | tr -d '[:space:]' | ogw secret set --harness claude-code-oauth-token

claude
```

Then, in that Claude Code session, give these commands one at a time:

```
update env
setup game: block-drop a falling-block puzzle game for mobile, in English and Korean
create game: block-drop
```

1. `update env` checks this host, installs the engine, tools and resource generation methods, and asks for your preferences. Run it once per host.
2. `setup game` creates `games/block-drop/` and asks what it cannot decide on its own. It also takes the reference game and its gameplay video (a file or a YouTube URL) here.
3. `create game` runs the loop until it stops, merges the result into main and reports. It does not wait for you midway.

To try a finished game first, clone one of the example games above into `games/` and follow its README.

## How it works

```
you -- one command --> lead agent (your Claude Code or Codex session)
  each iteration:
    1. content agent   edits design, client and server code, data, contract, play guide
    2. automated checks regression test, static check, completeness check
    3. play agents     play the game with real input and report what they saw (completeness only)
    4. judge agents    play this commit and the baseline blind (sides swapped between judges);
                       in a completeness iteration also compare with the reference game's video
    5. ogw             counts the votes, writes the defect list, decides whether to stop
  stop: success, repeated defect, oscillation, plateau, limit reached
  -> loop end record, merge into main, report to you
```

- **Two kinds of iteration.** A fun iteration tries one change aimed at fun and runs only the checks that block play. It is judged only on game feel, tension and release and no friction from a short play, so it ends in minutes. A completeness iteration fixes defects and runs every step. Success is judged only in completeness iterations.
- **Votes, not one opinion.** Several judges each pick a winner per fun element. An element is decided only when at least two thirds of the judges pick the same side in both A/B assignments. Bot telemetry from three runs per commit decides the elements it can measure.
- **Evidence order.** Automated checks rank above telemetry, and telemetry above LLM opinion. What could not be checked is recorded as unknown, not as a failure.
- **Resources and translations never block the loop.** Agents keep developing with placeholder resources while resource and translation sub-agents work in parallel.

The full rules are in [AGENTS.md](AGENTS.md), [agents/](agents) and [skills/](skills). This README is an introduction for people; where they differ, those files win.

## Commands

| command | what it does |
|---|---|
| `update env` | Checks this host, installs and measures tools and models, asks for your preferences |
| `setup game: <game> <request>` | Creates the game repository and settings, takes the reference game and its video |
| `create game: <game> [<request>]` | Makes the game through the loop |
| `update game: <game> <request>` | Changes an existing game through the loop: your feedback or a PROD fix |
| `build: <game> <DEV, STG, PROD> [<platform>...]` | Hardens the code, checks it again and builds. DEV and STG also deploy the server; you deploy PROD |
| `update core: <proposal>` | Applies a core proposal or your request and releases a new core version |
| `create client core: <engine>` | Adds a client core for another engine (Godot already exists) |
| `update harness tool: <request>` | Changes `ogw` |

What you do: give commands, read the loop end record (`records/loops/<run>/end.md`, its `## human` section has what you need to look at), answer questions outside the loop, put secrets into the host's secret store with `ogw secret set`, and deploy PROD.

## More

### Full requirements

`update env` (`ogw env check`) checks these and tells you what is missing.

| requirement | used for |
|---|---|
| macOS (arm64) or Linux (x64) | the play and judge agents run in an OS sandbox (`sandbox-exec`, `bwrap`) |
| Node.js 24 or later, Git | `ogw`, repositories and worktrees |
| GitHub CLI, logged in | fetching core releases; `write:packages` to push server images |
| Docker with `docker buildx` | PostgreSQL for tests and builds, server images |
| uv and Python | generation methods, `gdtoolkit` |
| Claude Code, logged in | the sub-agents and, if you choose, the lead agent |
| Codex CLI (optional) | the lead agent, or roles you switch to it |
| Xcode; Android SDK and JDK 17; `jsign` | iOS and macOS builds; Android builds; signing Windows builds |

Windows: enable Developer Mode and run `git config --global core.symlinks true` before cloning. The play and judge sandboxes run only on macOS and Linux, so the loop does not run on Windows.

### Workspace layout

```
<workspace>/
  open-game-works-core/            harness (run Claude Code or Codex here)
  open-game-works-core-impl/       core source
  open-game-works-core-releases/   downloaded core releases (created by the tool)
  games/<game>/                    one repository per game
  worktrees/                       created and removed by the tool
  .ogw/                            engines, tools, local models (created by update env)
```

### Settings and secrets

- Harness settings are `settings.json` with your `settings.local.json` merged over it. The local file is not committed and holds your language, the model and effort per role, loop values and per-host values. Game settings are `games/<game>/settings.json`.
- Settings hold only the names of secrets. Store values with `ogw secret set --harness <name>` (reads stdin) and view them with `ogw secret show`. The store is a separate keychain on macOS, a folder under `~/.local/share/ogw/` on Linux.
- `huggingface` (optional) is needed only for the `trellis2` method (3D models), whose weights are gated.

### Resource generation and local models

`update env` installs the methods in `settings.json` `resourceGeneration`. Images, music, sound effects and voice come from local models (`flux2-klein`, `ace-step`, `moss-sfx`, `qwen3-tts`), 3D models from `trellis2` or `blender`, and sprite animations from `sprite-gen-codex` or `sprite-gen-grok`, which count against your ChatGPT or Grok subscription usage (with an API key, each call is billed). To skip a local model, remove its method before `update env`. Without a method for a resource type, the loop runs with placeholders of that type, but STG and PROD builds are blocked.

## Contributing

Contributions are welcome. Help is wanted most on:

- **Resource generation.** The resource skill ([skills/resource/](skills/resource)) and its generation methods make the final art, animation and sound of a game. Every game benefits from better quality, a consistent style within a game and new methods for resource types that have no method yet.
- Client cores for other engines. Godot is the only one so far; Three.js, Phaser, Unity and Unreal are targets.
- Real adapters for external services (store payments, ads, push, social login), which have not been tried against the live services yet.
- The `build` command on Windows, Android and iOS.
- Games made with open-game-works, and core proposals where the core fell short.

Questions and ideas go to [Discussions](https://github.com/wnsrn3436/open-game-works-core/discussions), bugs to [Issues](https://github.com/wnsrn3436/open-game-works-core/issues). For a larger change, open one of those first. A core change starts in the module spec here and the implementation in [open-game-works-core-impl](https://github.com/wnsrn3436/open-game-works-core-impl) follows it. A change to `ogw` must pass `npm test` in `tools/` and `tools/bin/ogw docs check`. Harness files, code identifiers and commit messages are in English. Contributions are licensed under the Apache License 2.0.

## License

The harness is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). The gameplay GIFs in `.github/media/` show games made with open-game-works and are licensed under CC BY-NC-ND 4.0 (`.github/media/LICENSE`).

| repository | license |
|---|---|
| [open-game-works-core](https://github.com/wnsrn3436/open-game-works-core) | Apache-2.0 |
| [open-game-works-core-impl](https://github.com/wnsrn3436/open-game-works-core-impl) | Apache-2.0; third-party components in `licenses.json` |
| the example games | CC BY-NC-ND 4.0 for the game's own content; `client/core/` and `server/core/` stay Apache-2.0; bundled fonts stay SIL OFL 1.1; generated assets list their method and license in `resource/resources.csv` |
