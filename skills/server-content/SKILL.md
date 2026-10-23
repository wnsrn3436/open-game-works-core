---
name: server-content
description: Holds the rules of server content code for folder structure, handler and hook writing, content admin operation, populate, input validation, error response, item change, probability disclosure, collected data and server regression test. Read when writing or fixing server content code and when doing server hardening
---

# server content

Server content code is written in TypeScript. The common rules of requests, handlers, ctx and adapters are in [`server-core`](../server-core/SKILL.md).

## folder

| path | contents | writer |
|---|---|---|
| `server/core/` | server core of the core release | harness tool |
| `server/generated/` | generated code of the contract tool, the data tool and `ogw generate` | harness tool |
| `server/handlers/<RequestName>.ts` | the handler of one `rpc` | content agent |
| `server/hooks/` | hooks registered to core modules | content agent |
| `server/admin/` | content admin operations | content agent |
| `server/common/` | content code that several handlers share | content agent |
| `server/main.ts` | `export function register(core)` that registers handlers, hooks and content admin operations | content agent |
| `server/tests/` | server regression test. File names are `<topic>.test.ts` | content agent |
| `server/dev/` | cheat handlers, populate, DEV code. Cheat handlers are registered in `export function registerDev(core)` of `server/dev/main.ts`, and populate goes in `server/dev/populate.ts` | content agent |
| `server/build/` | the binary and the data version file that the data tool made | harness tool |

- Server content code is the code in `server/` except `server/core/`, `server/generated/` and `server/dev/`. Static checks treat this range as server content code
- Server code is written as ES modules (`import`, `export`)
- `server/core/`, `server/generated/` and `server/build/` are not edited
- The settings files (`settings.json`, `core-settings.json`) are not read. Gameplay values go in data `game_setting`. Static check `settings access` blocks violations
- Each `rpc` of the contract has one handler. When an `rpc` has no handler, the server does not start
- `core` of `register` and `registerDev` is an object that server core passes, and it holds per module the operations of that module. Registration operations are called only inside these two functions

## handler

1. Conditions that depend on the saved state and conditions between fields are checked. e.g. an unlock condition is judged with the `validation` operation `evaluate_requirement`. The range, length, count and data existence of a single field are declared with `(ogw.v)` of the contract and are not written again in the handler
2. When a condition is broken, a `GameError` is returned. That `GameError` must be in `(ogw.errors)` of that `rpc`
3. The saved state is changed. Items (currency and goods) are changed only with `item-ledger`
4. The response message is returned

- The code leaves no failure path unhandled
- Core handles resends of the same request ID. A handler is written assuming it runs once
- Time conditions are judged with the server time of ctx. A time the client sent is not used
- The system clock is not read (`Date.now()`, `new Date()` without arguments, `Date()` called as a function, `performance.now()`, `performance.timeOrigin`, `process.hrtime()`, `process.hrtime.bigint()`, `process.uptime()`). The time is read with the `server-time` operation `now`. Static check `system clock` blocks violations
- UserState, server state and game state do not hold real names, contact details, device IDs or IPs. A display name the user set (e.g. nickname) and text the user entered are kept only when declared in `### collected data` of a core spec or in game settings `privacy.contentData`. A user snapshot copies UserState and server state as they are
- The state of another user is read only for public kinds, with the `storage` operation `read_public_state`. Values shown to other users (profile decoration, async PvP defense deck) go in a public kind
- A change to the state of another user (gift, friend reward) is sent with the `storage` operation `send_user_change`. The apply function registered with `register_user_change` makes the change on the target side, and the apply function sends items as attachments of the `mailbox` operation `send_mail`. When the change is not applied to the target, the fail function returns it to the sending user
- `once_key` that content code passes to `item-ledger` and `mailbox` does not start with the core `once_key` prefix of [`item-ledger`](../server-core/modules/item-ledger.md)
- Values that several users share go in a game state kind and are written with the game state operations of `storage`. When several users change the same row, it is first locked with `lock_game_row`. When one transaction locks several game state rows, it locks them in byte order of the game state kind name, and within the same kind in ascending order of key
- A function body that calls `put_game_state` with a value read with `get_game_state(ctx, <kind>, <key>)` locks that row with `lock_game_row(ctx, 'game_state', [<kind>, <key>])` before that `get_game_state`. `<kind>` and `<key>` are written with the same source text as the arguments of `get_game_state`. The lock, the read and the write are in one function body, and a function written inside it is looked at separately. When the value argument of `put_game_state` holds the result of `get_game_state`, or uses a variable that leads from that result through a variable declaration, a `for ... of` or `for ... in` variable, or an assignment to that variable or its field, it writes the read value. Static check `game state lock` blocks violations
- When one transaction locks a guild row and game state rows together, it locks the guild row first with the `guild` operation `lock_guild`. The `ranking` operation `submit_guild_score` and the `chat` operation `post_system_message` (`Guild` channel) also lock the guild row, so when handling that locks game state rows calls either of them, it locks that guild row with `lock_guild` before locking the game state rows. Several guild rows are locked in ascending order of guild ID. The `chat` hook `on_chat_message_sent` is called after the channel row is locked. For a `Guild` channel, `SendChatMessage` locks that guild row first, so this hook can call `lock_guild` of that guild, and other guild rows are not locked in this hook
- When text the user entered is saved or shown to other users, it is checked with the `validation` operation `check_text`
- A result that client simulation decided is verified in the `play-session` hook `verify_play_session` and applied only in `apply_play_session`. The check of result values and the rule for using result values in reward quantities follow `### result verification` of `play-session`
- The costs of a round (entry, what `PlaySessionStartOptions` chose, continue) are subtracted with `item-ledger` in `prepare_play_session` and `continue_play_session`. They are not subtracted in `apply_play_session`
- A content `rpc` sent during a round (e.g. an item used within the round) is rejected with a `GameError` when the `play-session` operation `get_active_play_session` returns none. Otherwise it subtracts the cost with `item-ledger` and writes an in-play record of `play-session` that holds `play_session_id` of the returned record. `prepare_play_session` deletes the in-play records of the previous play session
- A round that accumulates results (score, event currency) in a live event round starts only when the latest time at which the result of that round can be handled is earlier than the end time that the `live-event` operation `get_round` returned, and otherwise a `GameError` is returned. For a round of `play-session`, `prepare_play_session` takes that time as the request time + `max_duration` of that mode. This is because a result handled after the end time comes after the settlement of that live event round
- The initial state of a new user is made by the request of `## new user` of `design.md`. Sending the same request again does not give the initial reward again
- A content `rpc` that gives the reward of a tutorial step grants it only once per (tutorial ID value, `step`), and also answers later requests for the same (tutorial ID value, `step`) with a success response. When the `tutorial` operation `get_tutorial_step` returns that `step` or more, it does not grant. Otherwise it passes `once_key` `tutorial:<tutorial ID value>:<step>` to the `item-ledger` operation `add_items` or the `mailbox` operation `grant_or_mail`, and also treats `ALREADY_APPLIED` and `AlreadyApplied` as granted. When the app ends after the reward and before the progress save, the client does that step again and sends the same `rpc` again

## hook

- Hooks of core modules are written in `server/hooks/`. The hooks that can be registered are `## hook` of that module spec. How to register them and what a hook can use follow `## hook` of [`core`](../core/SKILL.md)
- A validation hook returns `pass` or a `GameError`
- A `GameError` returned by a hook called inside a core `rpc` (e.g. `prepare_play_session`, `validate_shop_purchase`) is listed under the name of that core `rpc` in `(ogw.core_errors)` of contract `service.proto`. `routing` changes a `GameError` that is not listed into `INTERNAL`
- The `matchmaker` hook `apply_match_result` applies the rating change with the `rating` operation `apply_match_outcome`. `apply_match_mismatch` of a mode with 2 participants does not call `apply_match_outcome`, and does not change rating, ranking score or items outside the leave penalty
- The `matchmaker` hooks `apply_match_result` and `apply_match_mismatch` both add an item for that match to the content UserState kind `MatchOutcomeUserState` (single kind) of that participant. The item holds `match_id`, `status` (`MatchJudgeStatus`; `CONFIRMED` for `apply_match_result`, `MISMATCH` for `apply_match_mismatch`) and the content fields shown on the result screen. When the number of items exceeds the retention count set in data, the items added first are removed first
- leave penalty: the penalty that `apply_match_result` or `apply_match_mismatch` gives a participant in match record `participants` whose `reported_at` is 0 and whose `left_at` or `disconnected_at` is not 0. It is given only when there is another participant whose `reported_at` is not 0. A match with no report at all is treated as a match not played, and no leave penalty is given. A leave penalty does not change rating
- `replay_match` of a mode whose `result_rule` in `match_mode` is `ServerReplay` returns `reject` when `client_version` of the match record is in `TickChangedVersions`. `TickChangedVersions` is a `readonly string[]` constant that `ogw generate` exports in `server/generated/tick_changed_versions.ts`, the list of app versions of builds that hold deterministic simulation code that differs from the server. An empty `client_version` (dev run) is treated as having the same tick function as the server

## admin operation

Game-specific operations work (fixing broken content UserState, granting rewards specific to the game) goes in content admin operations.

- They are written in `server/admin/` and registered in `register` with the `routing` operation `register_admin_operation`. Their format (role, body format, input fields, `user_target`, handler function) is the same as the admin operations that modules export in `admin-api`
- The name is snake_case starting with `game_`
- The role is picked by what the operation does, following the criteria of `### role` of `admin-api`. An operation that changes the saved state is not `read`
- An operation that changes the saved state has `operation_id` in its input, and has `user_target` when it changes one user
- Content UserState is changed with the `storage` operations `put_state` and `delete_state`, and items with `item-ledger`
- A regression test calls them with the `testing` operation `send_admin`

## populate

DEV code that puts other users on the social screens and ranking screens of an instance.

- When the modules the game uses (`## module` of the `core` skill) include one of `guild`, `chat` and `ranking`, `server/dev/populate.ts` has `export async function populate(server)`. `server` is the remote test server that the runner got by calling the [`testing`](../server-core/modules/testing.md) operation `connect_server` with the URL of the instance server, `server/build/data/` and the dev access value of that instance server. Test helpers are imported from `server/core/testing/dev/index.ts`
- The runner calls it once per instance after starting the server and before starting the clients. When it throws, the instance start fails
- It logs in to dev accounts `populate_<n>` (`n` from 1) with the `testing` operation `login`, and with `send` and `send_cheat` makes the following for each module the game uses
  - `guild`: one or more guilds that have two or more members and appear in `ListJoinableGuilds`
  - `chat`: when core settings `chat.worldChannelCount` is 1 or more, one or more messages in world channel 1
  - `ranking`: for each `ranking_board` row, one or more users with a score in the current season. A content cheat handler submits the score with the `ranking` operation `submit_score`

## probability disclosure

- paid random: a request whose purpose is to decide by random the items received as the result, and that directly uses in that request an item whose `type` in the `item` table is `Currency` or an item bought with such an item (e.g. box, enhancement material). e.g. opening a box, enhancement, synthesis, gacha. The round results and rewards of `play-session` are not paid random
- Paid random uses the `gacha` request `DrawGacha`, or rolls a public loot table with the `loot-table` operation `roll`. ctx random is not used directly
- Each public loot table has a row in data `public_loot_table`

## collected data

- Core specs declare the data that core modules and adapters collect. Data that content receives through the contract and saves or shows to other users, and that the core spec declarations do not have (e.g. free text or images content received), is written as rows in game settings `privacy.contentData`. The fields of a row are the columns of the `## collected data` table of [`core`](../core/SKILL.md) without `source` and `condition`, written in camelCase. `dataType` is not written as `none`, and `platforms` is written as a list of platform names instead of `all`
- When no data is collected, `privacy.contentData` is an empty list

## hardening

At build, the server hardening agent finds and fixes the items below based on the contract. The content agent writes code without them from the start.

- A handler that does not check conditions that depend on the saved state or conditions between fields
- Conditions between fields not checked by a hook that decodes bytes the client sent (`apply_match_result`, `replay_match`, `prepare_play_session`, `continue_play_session`, `verify_play_session`, `apply_play_session`)
- `verify_play_session` and `apply_play_session` that subtract the cost of a round in `apply_play_session`, or accept into the result the effect of a choice that is not in `options` or `continues` of the record or in the in-play records of that play session
- `prepare_play_session` that starts a round that accumulates results in a live event round without checking the end time of that live event round
- `verify_play_session` that does not check result values against the data upper bounds, and `apply_play_session` that uses as reward quantities, as they are, result values that `verify_play_session` did not verify by recalculating
- `apply_match_mismatch` of a mode with 2 participants that calls the `rating` operation `apply_match_outcome` or changes rating, ranking score or items outside the leave penalty
- A leave penalty that is given in a match with no other participant whose `reported_at` is not 0, is given to a participant whose `reported_at` is not 0 or whose `left_at` and `disconnected_at` are both 0, or changes rating
- `replay_match` of a `ServerReplay` mode that does not return `reject` for a match record whose `client_version` is in `TickChangedVersions`
- User-entered text that is saved or shown to other users without `check_text`
- Code that reads and writes a game state row that several users change without `lock_game_row`, or that locks several game state rows in an order other than byte order of the game state kind name and ascending order of key
- Code that locks a guild row for the first time after locking a game state row. Guild rows are locked by `lock_guild`, the `ranking` operation `submit_guild_score` and the `chat` operation `post_system_message` (`Guild` channel). Code that locks several guild rows in an order other than ascending order of guild ID. Code in the `chat` hook `on_chat_message_sent` that locks a guild row other than the guild of the `Guild` channel of that message
- A `GameError` of a handler that is not in `(ogw.errors)` of that `rpc`, a `GameError` of a hook that is not in `(ogw.core_errors)` of that core `rpc`, and a failure path that does not return a `GameError`
- An item change outside `item-ledger`
- A tutorial reward `rpc` that grants without a `once_key` per (tutorial ID value, `step`), or that returns a `GameError` to a request for a (tutorial ID value, `step`) already granted
- A handler that uses a result the client decided. The range of judgements that decide results is `## role split with server` of [`client-content`](../client-content/SKILL.md)
- Prices, rewards and probabilities received as request values
- The handler of a paid random request deciding that random result with ctx random or with a loot table that is not a public loot table
- Use of resources outside ctx
- A content admin operation that changes the saved state without `operation_id`
- A content admin operation registered with a role that differs from what it does under the criteria of `### role` of `admin-api`
- Constants in `server/common/constants.ts` that are game data values
- A handler that receives through the contract and saves data that is not in `### collected data` of a core spec or in game settings `privacy.contentData`
- A handler that reads or changes a game state row or a target of another user chosen by a request value without checking the authority of the caller (membership, participation, ownership)
- Code that puts into a response, log or analytics event values of another user outside public kinds, secrets, or text the user entered. User-entered text shown to other users can be put in a response
- A calculation that breaks `## calculation and time` of [`server-core`](../server-core/SKILL.md). e.g. converting an `int64` value to `number`, integer division and permille application done without `validation` helpers
- A handler in which one request reads an amount proportional to the number of users or of game state rows

## regression test

When a handler is made, its regression test is written in `server/tests/` with it. Test helpers and test file rules follow [`testing`](../server-core/modules/testing.md), and `ogw check --regression` runs the tests as `### test run` of `testing` describes.

- For each success path, the response message, the UserState delta and the saved state
- For each `GameError` of `(ogw.errors)`, and for each pair of a core `rpc` and a `GameError` of `(ogw.core_errors)`, a test in which that error occurs, and a check that the saved state did not change
- Resending the same request ID and concurrent requests do not change an item twice
- Tutorial reward `rpc`: sending the same (tutorial ID value, `step`) again with another request ID gives a success response and leaves the balance as it was
- Rejection of a request that points to a target of another user, of an out-of-range value, and of input over the `(ogw.v)` upper bound
- Expected values are calculated from `design.md`, the contract and data
- When a defect is fixed, a test that fails before the fix is written first
