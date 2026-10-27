# open-game-works harness

A harness for making server and client games of commercial quality, in which AI agents write only content code on top of a prebuilt core. The readers of this document and of the harness are AI agents.

## purpose

- The goal is fun and completeness of commercial quality. The judge agent judges fun by playing, and automated checks judge completeness
- A game is developed in a loop. The loop runs until it reaches fun and completeness of commercial quality
- Features that would be written again the same way in many games are built in advance as core. Core holds only features outside the gameplay loop: infra, live ops, store policy, meta system. The gameplay loop is written as content code. The content agent focuses only on content
- What automated checks can verify must be verified by automated checks. Problems are caught at the time the code is written
- No approximate check is built for a property that a tool cannot judge exactly (e.g. which value a piece of wording states). That rule goes in the document read by the agent that does the work, and into the check targets of the judging agents (hardening agent, review agent)
- The harness tool does the work that needs no judgement: reading and writing structured files (settings, record, JSON, CSV), counting, calculation, comparison, transcription, random, managing schedules and the number of concurrent runs, state transitions. Agents do only the work that needs judgement
- Work items that do not wait for each other's results run together
- The harness holds only what agents use in their work. This saves tokens and reduces what agents forget

## terms

- core: the implementation of features that many games share. There is a client core and a server core
- client core: the core implementation of the client. There is a separate one per engine
- server core: the core implementation of the server. It includes the API server and the realtime server
- spec: a document that states the public API, behavior and error handling of core. It is kept in the harness, independent of engine
- content code: game code other than core and generated code. There is client content code and server content code
- gameplay loop: the play rules specific to that game and their calculation. e.g. combat, puzzle rules, idle production calculation, real-time synchronized simulation
- infra: the base that every game runs on. Server request handling and save, login, network and realtime connection, update, client UI, input, presentation tools, platform integration, development and test tools
- live ops: operating a released game without an app update. e.g. maintenance, notice, kill switch, item grant and revocation, ban, coupon, live event, remote config, push, bundle patch
- store policy: the rules that app stores, platforms and law require of a released game. e.g. receipt verification and refund handling, consent to terms, age check, account deletion, probability disclosure, store privacy disclosure, tracking permission
- meta system: a system outside the gameplay loop that handles progress, reward, competition and relationships. e.g. item, shop, mailbox, mission, attendance, gacha, ranking, rating, friend, guild
- contract: the message definitions between client and server and between client and client (realtime). Written in protobuf
- data: game data table(CSV), translation, glossary, ID registry
- resource: every file that a game loads by resource key at runtime and that is not code, data or contract
- resource key: the key that identifies a resource. Code loads resources only by resource key
- final resource: a resource the game finally uses. The resource sub-agent makes it, and it replaces the placeholder resource with the same resource key. Scenes, prefabs and tween presets are final resources that the content agent makes
- placeholder resource: a temporary resource that fills the place of a final resource during development. It is replaced by the final resource with the same resource key. Scenes, prefabs and tween presets have no placeholder
- scene: a screen-unit group that is loaded at once. e.g. lobby screen, battle screen
- panel: a UI screen unit pushed onto a stack inside a scene. e.g. shop, inventory, mailbox
- prefab: a group of objects reused in many places. e.g. enemy character, UI button
- bundle: a package downloaded without an app update. It holds resources and data, and holds no code
- bundle patch: sending only a bundle to an installed app without an app update
- ID name: a name enclosed in square brackets. e.g. `[sword_basic]`. Data uses ID names
- ID value: the int mapped to an ID name. Built data, contract messages and save data use only ID values
- ID registry: the mapping of ID names to ID values. A mapping once issued is not deleted from the registry, even when its branch is discarded or the ID name is deleted from data. An ID value is not changed and is not given again to another ID name
- reserved ID: a reserved name that code refers to. A system table of data links it to an ID name. e.g. `[tutorial_reward]` → `[sword_basic]`
- dev run: a run that starts the engine project as it is, without a build
- instance: one set of a game run that the loop starts as a dev run. It consists of one server set and one or more clients
- realtime game: a game where `RealtimeCore` is in game settings `coreModules` or in their dependency closure
- brief: the document that declares the identity of the game
- design doc: the document that holds the whole current design state of the game. e.g. core loop, system, progression, economy. It is not completed in advance
- play guide: the document, given by the content agent to the play agent, that states the controls and flow of the game
- baseline game: another commit of our game that the judge agent compares with this instance. Which commit it is, the `game-loop` skill decides in the loop and the `build` skill decides in build
- reference game: another game that the success judgement compares with. A human picks it in `setup game` and gives it as gameplay video
- loop: the repetition in which the content agent edits, the play agent plays, the judge agent writes the judge result, and the harness tool decides success
- hardening: the work in which, at build time, the server and client hardening agents fix content code based on the contract. Its target is every problem caused by the content agent also writing the server. e.g. missing server input validation, authoritative logic in the client, handling that differs from the contract
- DEV code: all code used only for development. e.g. cheat, debug screen, automation channel. It is kept only in `client/dev/` and `server/dev/`
- automation channel: the DEV code channel through which bots and tools read the state of a running game and put in input
- automated check: every check that a tool runs without judgement by a human or an LLM. e.g. regression test, completeness check, build-time check
- bot playtest: the automated check in which a bot runs a scenario written by the content agent through the automation channel up to its goal
- core proposal: a proposal in which the content agent states what core lacks. A human orders it applied with the `update core` command
- runner: the harness tool that starts and stops instances. It handles the server process, clients, DB and ports
- lead agent: the agent that receives a command and is responsible for it to the end. It calls sub-agents
- harness settings: `settings.json` of the harness repo `open-game-works-core/` with local harness settings merged over it. Values that apply to the whole harness and values that differ per host
- local harness settings: `settings.local.json` of the harness repo. It is not committed, and holds the harness settings values of one user and one host
- core settings: the core defaults in `open-game-works-core-impl/`
- game settings: `games/<game>/settings.json`. Values per game. They can override core settings values, and a value not overridden uses the core settings default
- external service: a service that we do not start and that an outside company operates. e.g. store payment, ads, push notification, social login, analytics, CDN
- secret: every value whose exposure lets someone gain access. e.g. API key, certificate, signing key, DB password
- adapter: the implementation that connects an external service and core. One interface has a fake adapter, a sandbox adapter and a real adapter

## repo

```
<workspace root>/
  open-game-works-core/            harness. This repo. Harness tool in tools/
  open-game-works-core-impl/       core source. GitHub releases are published from here
  open-game-works-core-releases/   cache of fetched core releases. One folder per version
  games/<game>/            game repo. One per game
  worktrees/<game>/<id>/   worktree of a game repo, created and deleted by the harness tool
  worktrees/_core/<id>/    worktree of open-game-works-core-impl, created and deleted by the harness tool
```

- This repo holds no game code and no core code. The harness tool (TypeScript) is in `tools/`
- `README.md`, `README.ko.md` and `.github/media/` of this repo, of `open-game-works-core-impl/` and of each game repo are introductions for humans and not harness files. Agents do not read them or edit them, and harness files do not refer to them
- `open-game-works-core-impl/`, `open-game-works-core-releases/`, `games/` and `worktrees/` in documents mean the folders that harness settings `paths.coreImpl`, `paths.coreReleases`, `paths.games` and `paths.worktrees` point to. Tools read these paths only from harness settings and do not write them in code
- A game records only its core version. At dev run and build, the tool looks for that version in `open-game-works-core-releases/` and, when it is not there, fetches it from the GitHub release. Fetched files are checked by hash
- The specs of this repo are of one core version: the core version of the harness, which is the highest `core-v<version>` tag that the harness HEAD contains (`ogw core release` puts the tag on the harness commit whose specs that core was made from). A command on a game fails when the core version of the game is higher than the core version of the harness or lower than harness settings `minCoreVersion`, and the commands that run the agents that write or harden game code (`ogw loop next`, `ogw build start`) fail unless it is the core version of the harness. The failure names the two ways out: raise the core of the game with `ogw core upgrade`, or use the harness at the tag `core-v<core version of the game>`
- When harness settings `useLocalCore` is `true`, the harness tool uses `open-game-works-core-impl/` instead of the release of the game's core version, and does not start loop iterations or builds. It is set to `true` only while developing core

A game repo is structured as below.

```
games/<game>/
  contract/      contract(proto)
  data/          CSV table, translation, glossary, shared formula fixture
  resource/      placeholder resource and final resource
  client/        client content code. DEV code in client/dev/
  server/        server content code. DEV code in server/dev/
  brief.md       brief
  design.md      design doc
  play-guide.md  play guide
  records/       every file that agents and tools write as process records. e.g. hardening record, core proposal, loop iteration record, loop end record
  builds/        build artifacts. Not committed
  settings.json  game settings
```

## layer

### client core

- The implementation is kept per engine in `open-game-works-core-impl/client/<engine>/`. The first engine is Godot
- Target engines: Godot, Three.js, Phaser, Unity, Unreal
- Per-game definitions come in through data and hooks

### server core

- Written in TypeScript
- User items are changed only through the item ledger API
- Realtime starts as P2P. The realtime message contract and the transport are kept separate, so that it can be changed to a server-authoritative realtime server
- The DB is behind an adapter. LOCAL uses SQLite; DEV, STG and PROD use PostgreSQL

### data

- Tables are written in CSV, and the data tool generates data proto and code from the CSV headers
- Content code does not contain game data values. Code does not write ID names or ID values directly. It uses the generated accessors of reserved IDs
- There is one ID registry, on the dedicated branch `id-registry` of the game repo. It is one regardless of work branches. The harness tool first creates that branch, and after that only the data tool writes to it. That branch is read by the data tool and by `ogw build run`, which writes build info `ad_units`. Issuing is done one at a time under a file lock. The same ID name gets the same ID value
- A text column holds source text in the source language of game settings. The tool makes translation keys. When source text changes, its translations are marked stale
- Translation is given to one translation sub-agent per language, and they run together. A translation sub-agent receives only the missing translations and stale translations of its language. The loop does not wait for translation and runs with source text
- The names of targets that have an ID name, and terms the game newly coins, have their translations fixed by the per-game glossary in `data/`. When the name of a target that has an ID name is not in the glossary, a tool check catches it
- A tool checks that the format arguments (`{count}`) of the source text are in the translation exactly the same

### resource

- Resource categories are 2D, 3D, animation, VFX, audio, haptics, typography, map, scene, prefab, platform. The resource types of each category are set by the `resource` skill as the `<type>` of the resource key
- The content agent puts in placeholder resources and continues development. Final resources are given to resource sub-agents in parallel
- A resource sub-agent chooses from external generation service, local generation model, procedural resource and pinned resource catalog. The generation methods that can be used are in harness settings

### contract

- Written in protobuf. The contract tool generates client code and server code
- In the loop, only the content agent edits the contract. Hardening agents only read the contract

## loop

0. In iteration 1 of `create game`, before any other work, the content agent writes `brief.md` from the request saved in `setup game`. The content agent decides the items that the human's request does not have
1. The content agent edits `design.md`, client content code, server content code, data and contract together
2. Regression tests, static checks, completeness checks and row simulation run. Regression tests are all the tests that the content agent wrote together with the features it made
3. The play agent reads `play-guide.md`, plays the instance with real input, then gives feedback. Feedback is written per observation, not as a total score
4. Judge agents play in new contexts and write judge results comparing with the baseline game and the gameplay video of the reference game. Several judge agents judge an iteration with the sides `A` and `B` swapped between them, and the harness tool counts their votes per element. Each iteration, the harness tool writes the judge results, the votes and the defect list into the loop iteration record, and decides success from the votes and the completeness check
5. When the loop stops, the lead agent reports to the human with the loop end record. A human makes builds with the `build` command. The human's feedback becomes the input of the next loop through `update game`. The loop does not wait for the human midway

- An iteration is a fun iteration or a completeness iteration. A fun iteration tries one change aimed at fun and runs only the checks that block play, so that it is short; a completeness iteration fixes defects and runs every check. Success is judged only in a completeness iteration
- `brief.md` is written or edited only in iteration 1 of the loop. To change it, a human requests it with `update game`. An edit keeps to the brief
- The content agent edits `play-guide.md` together with the game
- When it starts work, the content agent reads `design.md` before the code
- The play agent plays several instances of the same commit in parallel. Steps 3 and 4 run together
- The play agent and the judge agent are not shown `brief.md` or `design.md`. The harness tool passes the name and gameplay video of the reference game to the judge agent separately
- The order of evidence for judgement is automated check > telemetry > LLM opinion. What could not be checked is recorded as unknown, not as failure
- When the loop stops, the reason is written in the loop end record in `records/`. The reason is one of success, repeated defect, oscillation, plateau, limit reached, and the harness tool decides it from the loop iteration records. When a human makes the loop stop, the reason is stopped by human
- Resource work and translation work do not make the loop wait. The success judgement does not look at no placeholder; when there was unfinished resource work or translation work that the iteration meeting the success conditions did not see, a confirmation iteration runs in which the content agent edits nothing, and success is judged again on the state with that work merged. Only a state checked that way goes into main
- Whatever the reason the loop stops, the lead agent waits until the resource work and translation work in progress finish, then reports. When placeholder resources, missing translations or stale translations still remain, it reports failure
- Server content code validates every input on the server and returns an error response for every failure. It is written knowing it will be hardened
- AI checks are done with dev runs, not builds

### completeness check

Completeness is judged by the five elements below, and all of them are checked by automated checks.

| element | meaning | check |
|---|---|---|
| no blocker | There is no problem that blocks progress. e.g. crash, softlock, error screen | bot playtest |
| performance | Target FPS holds, and loading time ends within the limit | runtime profiling |
| no placeholder | There is no placeholder resource, missing translation or stale translation | project check |
| full flow | From first launch through tutorial, main loop, save and reconnect, play continues without a break. Reconnect is recovery after a server communication failure, and for a realtime game it also includes reconnection after a peer disconnect during a match, a matchmaker disconnect and an app restart. It also includes room match for a realtime game that starts matches through rooms, and the flow of exchanges with other users for a game that uses `friend`, `guild` or `chat` | bot playtest |
| UI quality | In every supported resolution, safe area and language, UI is not clipped and does not overlap, and the on-screen keyboard does not cover the text input that has focus. Text keeps to a few sizes, is not too small and stands out from what is behind it, and panels and popups are neither one flat color nor mostly empty. When gamepad is supported, the buttons of every screen can be pressed with the gamepad | capture per resolution, language and on-screen keyboard, and gamepad focus check |

## hardening and build

1. The server hardening agent and the client hardening agent harden based on the contract
2. When a hardening agent meets a problem that is solved only by editing outside its own folder (`server/` or `client/`), it does not fix it and writes it in the hardening record in `records/`. Within the build command, the work goes back to the loop, the content agent fixes it, then hardening runs again
3. Loop steps 2 to 4 run once with the hardened code. The DB is PostgreSQL. When one of regression test, static check, no blocker, full flow does not pass, or the judge result is worse than the baseline game, the work goes back to the loop
4. The game is built

- The hardening result is committed. The next loop continues on top of the hardened code
- When the build does not finish within the build retry limit, it stops and reports to the human
- A build is for handing to humans. The target platforms are chosen in the command. When omitted, they are all build platforms of game settings. Build platforms are set in `setup game`
- STG and PROD builds go as far as signed artifacts. A DEV build makes the platforms that have no signing values with the free signing of the `build` skill. DEV and STG builds also deploy the server of that environment, and a human deploys PROD

## environment

| environment | purpose | server | DB | external service | DEV code |
|---|---|---|---|---|---|
| LOCAL | loop | one per instance | SQLite | fake adapter | included |
| DEV | DEV builds handed to humans | one shared | PostgreSQL | the adapters that game settings `environments.DEV.adapters` chooses | included |
| STG | checking with the same code as PROD, checking PROD problem fixes | one shared | PostgreSQL | sandbox adapter. Real adapter for keys without a sandbox adapter and for `push-apns` | excluded |
| PROD | service | shared | PostgreSQL | real adapter | excluded |

- A PROD problem is reproduced in an instance started from the latest main, and the fix is made on the latest main
- To reproduce a PROD problem, PROD users are cloned by snapshot. PROD is not affected
- Backward compatibility is kept from the first PROD build. Contract, data and save schema are checked against the last PROD build. When it cannot be kept, a migration is written and tested with a PROD user clone

## branch

The branches of a game repo are run as below.

- main is always the latest code that passed the loop
- `create game` and `update game` make one work branch per command, and when the loop ends they merge the commit that `game-loop` chose into main
- For one game, only one command of `create game`, `update game` and `build` is in progress. While a command is in progress, the harness tool blocks the start of a new command
- A work branch and a build's branch are merged into main only when the main commit that the branch was made from is the current HEAD of main. Otherwise they are not merged and the human gets a report
- A build commits the hardening result to main and tags that commit. The tag is `dev-<version>`, `stg-<version>` or `prod-<version>`, and the version format is `<major>.<minor>.<patch>`. The tag of a bundle patch build is `<lowercase environment>-<app version>-bundle-<n>`; in DEV and STG, `<n>` is the sequence number of the bundle patch for that environment and app version, starting from 1, and in PROD it is the `<n>` of the `stg-<app version>-bundle-<n>` tag that the PROD build started from
- A PROD build is made only from a commit checked on STG
- No hotfix branch that branches off a PROD tag is made
- The `id-registry` branch holds only the ID registry and is not merged with any other branch

## command

| command | description |
|---|---|
| `update harness tool: <request>` | Edits `ogw` to apply the request |
| `create contract tool` | Makes the contract tool and the data tool. The two tools are released with the same version as core |
| `create server core` | Makes the server core and releases it |
| `create client core: <engine>` | Makes the client core of that engine from the spec and releases it |
| `update env` | Checks this host, and gets local models and programs and runs them. When they do not match harness settings, proposes a revision to the human. Asks the human for the preference settings |
| `setup game: <game> <request>` | Creates the game repo and game settings and saves the request. Fills the required items of game settings and the items that become required by condition, gets the reference game and gameplay video, gets the banned word list, and tells the items that use the default and the resource types that this host cannot make |
| `create game: <game> [<request>]` | Makes a game that finished `setup game` through the loop. `<request>` is a request added to the saved request |
| `update game: <game> <request>` | Edits a made game through the loop. Includes the human's feedback and PROD problem fixes |
| `update core: <proposal>` | Applies an accepted core proposal and releases it as a new version. `<proposal>` is a core proposal file or a human's request |
| `build: <game> <DEV, STG, PROD> [<platform>...] [--version <version>] [--bundle-for <app version>]` | Hardens and builds. `--version` sets the version of a DEV or STG build, and in a PROD build picks the STG build of that version. `--bundle-for` makes the bundle patch to send to that app version |

- The agent that receives a command is the lead agent of that command

## role

| role | description |
|---|---|
| content agent | In the loop, writes the brief, design doc, client and server content code, scenes, prefabs, data, contract, regression tests, bot playtest scenarios, play guide and the content items of game settings |
| resource sub-agent | Makes final resources as the content agent directs |
| translation sub-agent | Makes missing translations and stale translations |
| play agent | Plays an instance with real input and gives feedback |
| judge agent | Plays in a new context and writes the judge result comparing with the baseline game and the gameplay video of the reference game |
| server hardening agent | At build, hardens server content code based on the contract |
| client hardening agent | At build, hardens client content code based on the contract |
| core agent | Makes and edits core |
| review agent | Reviews the code of core, contract tool, data tool and harness tool against the defining documents and writes findings. Does not edit code |

- The content agent does not make or edit core. What core does not have is written as content code. When core falls short, the content agent writes a core proposal in `records/` to propose it to the human

## settings

Settings are kept as JSON, and each settings file has a JSON schema.

| settings | contents |
|---|---|
| harness settings | `schemas/harness-settings.schema.json` defines the items. e.g. agent CLI per role (Claude Code or Codex), model and effort, repo paths, whether to use local core, resource generation methods, values that differ per host (`hosts`. e.g. max concurrent instances) |
| core settings | core default |
| game settings | `schemas/game-settings.schema.json` defines the items. e.g. engine, core version, core module list, app ID, source language, build platforms, signing, base resolution, terms documents, server address and deploy host per environment, adapter, secret names, core settings overrides |

- Agents do not open settings files or JSON schemas directly, and read and write them only through `ogw settings`. Before writing, `ogw settings set` checks the schema, the conditions, the owner permission of the calling role and, for a role other than the lead agent, that no changed path is equal to or below a path of game settings `humanDecided` (the values a human decided), and does not write when a check does not pass. `ogw settings set` takes several `<path> <JSON value>` pairs and checks once the result of writing all of them. Values that keep the conditions only when changed together are written at once
- Settings are filled one value at a time, so a missing required value does not block a write of `ogw settings set`. `ogw settings list --missing` and `ogw game check` catch missing required values
- Harness settings values that differ per host are kept in `hosts` as one item per host id. `ogw settings` reads and writes a path without `hosts.<host id>.` (e.g. `maxConcurrentInstances`) as the path in the item of this host. Such a harness settings value that documents refer to, and that the harness tool reads and writes, is the value in the item of this host
- The schema `x-owner` of a path follows the value of the deepest node, among the schema nodes that reach that path, that declares `x-owner`
- The merge of local harness settings over `settings.json` merges object values key by key and replaces arrays and other values whole. The schema and condition checks of `ogw settings set` run on the merged value. Without `settings.local.json`, `settings.json` alone is harness settings
- A harness settings path is local-scope when a schema node that reaches it declares `x-scope` `local` (e.g. `humanLanguage`, `agents`, `hosts`, `loopStop`, `loop`). `ogw settings set` writes a local-scope path, and a path that local harness settings already hold, to `settings.local.json`, and every other path to `settings.json`. A removed value is removed from both files. The committed values of local-scope paths in `settings.json` are generic defaults for every user
- The default of a value that exists only in game settings is in the JSON schema of game settings
- Secrets go in no settings. Settings hold only the names of secrets, and the values are read from the secret store of the host that runs

## rules

- Time is in UTC. Timestamps are handled as Unix milliseconds and durations as milliseconds. Conversion to the local timezone is done only for display
- A time interval includes its start time and does not include its end time. Reaching a time means that the current time is that time or later
- What is not known is not made up. Inside the loop, the agent writes an assumption in `records/` and continues. Outside the loop, the lead agent asks the human. When asking, it gives a recommendation together with its evidence (document, specification, reproduced cause), and asks separately per topic. When there is no evidence, it states that fact
- A failure is fixed after its cause is reproduced and checked. A fix whose cause was not checked is not reported as fixed, and the unchecked cause is written in the result file or the report (inside the loop, an assumption in `records/`). When a fix raised a time value, skipped a test or avoided the failing condition, that fact is written together with the reason for doing so without fixing the cause
- Reports and questions to the human, the `--human` file of `ogw loop end-record` and the `--reason` file of `ogw build report` are written in harness settings `humanLanguage`
- Sub-agents do not ask the human. Outside the loop, a sub-agent writes what it does not know in the result file that `agents/<role>.md` defines, and the lead agent asks the human about it
- Outside the loop, no file, rule or behavior outside the scope of the command is made. When one is needed, the lead agent first asks the human, and a sub-agent writes it as a proposal in its result file
- Content that can go in the harness is kept in the harness, not in memory
- `ogw agent`, `ogw agent retry`, `ogw check`, `ogw simulate`, `ogw instance start`, `ogw instance measure`, `ogw loop evaluate`, `ogw loop sync`, `ogw build run`, `ogw deploy`, `ogw core test`, `ogw review run`, `ogw code check`, `ogw core fetch`, `ogw game reference`, `ogw core upgrade`, `ogw core try`, `ogw core release`, `ogw core pin-engine`, `ogw env install-engines`, `ogw generation install`, `ogw generation measure`, `ogw generation run`, `ogw video` run with `--background`. The tool starts the work and returns a job id at once. A job is one run of a command started with `--background`. A job of `ogw agent` or `ogw agent retry` is waited for with `ogw agent wait <id>`, and any other job with `ogw job wait <id>`. When a wait or `ogw review wait` ends with exit code 75, the job is still running, so the same command is called again. The shell call that calls a wait gets a time limit longer than harness settings `jobWaitTimeoutMs`
- The harness is used from both Codex and Claude Code. `CLAUDE.md` imports this document (`@AGENTS.md`), and `.claude/skills` and `.agents/skills` are links to `skills/`

## harness writing rules

- The guiding document is [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
  - Do not write what Claude already knows
  - In a skill description, write what the skill does and when to use it
  - Keep a SKILL.md body at 500 lines or less
  - Keep references at most one level deep from SKILL.md
  - Give a reference file of more than 100 lines a table of contents at the top
  - Use only one term for one concept
  - Do not list several methods; give one default
- Write harness files in English. Concept names (term, section heading, table header, state value) are the defined terms
- Write industry-standard abbreviations as abbreviations. e.g. DB, API, ID, UI, CSV. Do not coin new abbreviations
- Write code identifiers and file names in English
- A list names every item it knows. When a list cannot be complete, define the criterion and give the list as examples under it. Do not end a list with a word that stands for the items not named
- Do not use words that cannot be judged: properly, appropriately, as much as possible, as far as possible, sufficiently, if possible
- Write only the current design. Do not mention previous designs or what was removed
- Do not write the same content in two places. Do not write sentences that point to a position within the same document
- Put each piece of content only in the documents read by the agents that need it
- When the same mistake happens twice, do not add a sentence; make it an automated check
- Do not write settings values in prose. Point to the settings file
- When a harness file is edited, align in the same change the other harness files that refer to the changed names and rules
- After editing harness files, run `ogw docs check` and make it pass
- document priority: this document > settings > `agents/<role>.md` > `skills/<skill>/SKILL.md` > reference files of a skill

## skill

| skill | reader | contents |
|---|---|---|
| `host-env` | lead agent of `update env` | host check, installing local models and programs, measurement, harness settings revision proposal, preference settings |
| `game-setup` | lead agent of `setup game` | making the game repo and game settings, saving the request, reference game and gameplay video, banned word list, host capability check |
| `game-loop` | lead agent of `create game`, `update game` and `build`, lead agent of `update env` (only `performance.md`), content agent, resource sub-agent, play agent, judge agent (these four only `instance.md`) | work branch, raising the core version, sub-agent calls, runner, instance commands, running automated checks, measurement, loop iteration record, loop stop judgement, loop end record, report, PROD problem reproduction |
| `game-design` | content agent, lead agent of `update core` | brief, design doc, play guide, core proposal, assumptions in the loop, criteria for deciding without asking the human |
| `contract` | content agent, hardening agent, core agent, review agent, lead agent of `create contract tool` | proto writing rules, error code, backward compatibility, code that the contract tool generates |
| `data` | content agent, translation sub-agent, core agent, review agent, hardening agent | CSV format, type, ID, system table, translation, glossary, code generated from data, data check |
| `resource` | content agent, resource sub-agent, core agent, lead agent of `build` | resource key, placeholder resource, resource request, final resource production, resource rights |
| `client-content` | content agent, client hardening agent, server hardening agent, core agent, resource sub-agent (only `## folder`) | client content code writing rules, role split with server, shared formula, deterministic simulation, tick simulation, scene and prefab, DEV code, automation channel connection, bot playtest scenario and save fixture, row simulation, client regression test, client hardening targets |
| `server-content` | content agent, server hardening agent | server content code writing rules, input validation, error response, collected data of content, server regression test, server hardening targets |
| `core` | core agent, review agent, content agent, lead agent of `setup game`, `create contract tool`, `create server core`, `create client core` and `update core` | rules common to core (spec format, hook, error handling, core settings, collected data), core version and release, license manifest, `update core` |
| `client-core` | core agent, review agent, content agent, resource sub-agent, client hardening agent | client core spec per module, implementation rules per engine |
| `server-core` | core agent, review agent, content agent, server hardening agent, lead agent of `build` (only `server-image.md`) | server core spec per module, adapter, server start, server image |
| `build` | lead agent of `build`, hardening agent, lead agent of `setup game`, core agent | hardening, build-time check, environment, build and signing per platform, store privacy disclosure, server image, web hosting, tag, bundle patch, backward compatibility check, DEV and STG deploy and PROD deploy order |

- Agent definitions per role are in `agents/<role>.md`. Sub-agents are started only with `ogw agent`. The lead agent calls them, or an `ogw` command that the lead agent ran calls them. No native agent definitions of the agent CLI (`.claude/agents`, `.codex/agents`) are kept
- The judgement criteria for fun are in `agents/judge.md`
