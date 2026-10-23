# guild

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

Handles creating, finding, joining and join requests, leaving, kicking, roles and info of guilds. Content makes guild-level content state (guild experience, shared boss, contribution) in a game state kind with the guild ID as key.

## dependency

- `storage`
- `server-time`
- `logging`
- `validation`
- `public-profile`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `CreateGuild` (core rpc, `retry`). changes: `content` | `name`, `description`, `join_type`, `join_value` | `guild_id` | `INVALID_REQUEST`, `TEXT_INVALID`, `TEXT_BANNED`, `GUILD_ALREADY_MEMBER`, `GUILD_COOLDOWN`, `GUILD_NAME_TAKEN`, `GameError` of a hook | `routing`. Client content code sends it |
| `UpdateGuild` (core rpc, `retry`). changes: none | `description`, `join_type`, `join_value` | empty response | `INVALID_REQUEST`, `TEXT_INVALID`, `TEXT_BANNED`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION` | `routing`. Client content code sends it |
| `GetGuild` (core rpc, `silent`). changes: none | `guild_id` | `guild`: `GuildInfo`, `members`: list of `GuildMemberEntry` | `INVALID_REQUEST`, `GUILD_NOT_FOUND` | `routing`. Client content code sends it |
| `GetMyGuild` (core rpc, `silent`, `retry`). changes: `content` | none | `guild`, `members`, `join_requests`, `my_join_requests`, `cooldown_ends_at` | none | `routing`. Client content code sends it |
| `SearchGuilds` (core rpc, `silent`). changes: none | `name` | `guilds`: list of `GuildInfo` | `INVALID_REQUEST` | `routing`. Client content code sends it |
| `ListJoinableGuilds` (core rpc, `silent`). changes: none | `max_join_value` | `guilds`: list of `GuildInfo` | `INVALID_REQUEST` | `routing`. Client content code sends it |
| `JoinGuild` (core rpc, `retry`). changes: `content` | `guild_id` | `joined`: `true` when joined, `false` when a join request | `INVALID_REQUEST`, `GUILD_NOT_FOUND`, `GUILD_ALREADY_MEMBER`, `GUILD_COOLDOWN`, `GUILD_CLOSED`, `GUILD_FULL`, `GUILD_REQUEST_LIMIT`, `GameError` of a hook | `routing`. Client content code sends it |
| `CancelGuildJoinRequest` (core rpc, `retry`). changes: none | `guild_id` | empty response | `INVALID_REQUEST`, `GUILD_REQUEST_NOT_FOUND` | `routing`. Client content code sends it |
| `AcceptGuildJoinRequest` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION`, `GUILD_REQUEST_NOT_FOUND`, `GUILD_FULL` | `routing`. Client content code sends it |
| `RejectGuildJoinRequest` (core rpc, `retry`). changes: none | `user_id` | empty response | `INVALID_REQUEST`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION`, `GUILD_REQUEST_NOT_FOUND` | `routing`. Client content code sends it |
| `LeaveGuild` (core rpc, `retry`). changes: `content` | none | empty response | `GUILD_NOT_MEMBER`, `GUILD_LEADER_CANNOT_LEAVE` | `routing`. Client content code sends it |
| `KickGuildMember` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION` | `routing`. Client content code sends it |
| `SetGuildMemberRole` (core rpc, `retry`). changes: `content` | `user_id`, `role` | empty response | `INVALID_REQUEST`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION`, `GUILD_OFFICER_LIMIT` | `routing`. Client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `CreateGuildRequest` | `name` | `string` | `max_chars_key`: `guild.maxNameLength` |
| `CreateGuildRequest` | `description` | `string` | `max_chars_key`: `guild.maxDescriptionLength` |
| `CreateGuildRequest` | `join_type` | `GuildJoinType` | none |
| `CreateGuildRequest` | `join_value` | `int64` | `min`: 0, `max`: 2^53−1 |
| `UpdateGuildRequest` | `description` | `string` | `max_chars_key`: `guild.maxDescriptionLength` |
| `UpdateGuildRequest` | `join_type` | `GuildJoinType` | none |
| `UpdateGuildRequest` | `join_value` | `int64` | `min`: 0, `max`: 2^53−1 |
| `GetGuildRequest` | `guild_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `SearchGuildsRequest` | `name` | `string` | `max_chars_key`: `guild.maxNameLength` |
| `ListJoinableGuildsRequest` | `max_join_value` | `int64` | `min`: 0, `max`: 2^53−1 |
| `JoinGuildRequest` | `guild_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `CancelGuildJoinRequestRequest` | `guild_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `AcceptGuildJoinRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `RejectGuildJoinRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `KickGuildMemberRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `SetGuildMemberRoleRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `SetGuildMemberRoleRequest` | `role` | `GuildRole` | none |

core `rpc` response field

| message | field | type |
|---|---|---|
| `CreateGuildResponse` | `guild_id` | `int64` |
| `GetGuildResponse` | `guild` | `GuildInfo` |
| `GetGuildResponse` | `members` | `repeated GuildMemberEntry` |
| `GetMyGuildResponse` | `guild` | `GuildInfo` |
| `GetMyGuildResponse` | `members` | `repeated GuildMemberEntry` |
| `GetMyGuildResponse` | `join_requests` | `repeated PublicProfileEntry` |
| `GetMyGuildResponse` | `my_join_requests` | `repeated int64` |
| `GetMyGuildResponse` | `cooldown_ends_at` | `int64` |
| `SearchGuildsResponse` | `guilds` | `repeated GuildInfo` |
| `ListJoinableGuildsResponse` | `guilds` | `repeated GuildInfo` |
| `JoinGuildResponse` | `joined` | `bool` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_member` | ctx, user ID | `guild_id`, `role`(`GuildRole`), `joined_at`, or none | none | content handler, hook, `chat`, `ranking` |
| `lock_guild` | ctx, guild ID | `GuildInfo` of the locked guild, or none (no guild) | `FAILED`. A call from a content handler or a hook throws | content handler, hook, `chat`, `ranking` |
| `list_member_ids` | ctx or game tx, guild ID | list of member user IDs. Ascending order | empty list | content handler, hook, `ranking` |
| `get_guild_infos` | ctx or game tx, list of guild IDs | list of `GuildInfo` of the guilds that exist. Ascending order of guild ID | empty list | content handler, hook, `ranking` |
| `register_disband_listener` | function (ctx or game tx, guild ID → none) | none | none. A registration error is a server start failure | `ranking`. Called at server start |
| `set_guild_max_members` | ctx, guild ID, capacity | success flag | `false`. Exceeding the lock wait throws | content handler, hook |
| `set_member_role` | ctx, guild ID, user ID, `GuildRole` | success flag | `false`. Exceeding the lock wait throws | content handler, hook |
| `remove_user` | ctx | none | `FAILED` | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` below the minimum age, job `auth_guest_sweep`) |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_guild` | `guild_id` | columns of the guild row and `members` (list of `user_id`, `role`, `joined_at`, `active_at`) | `not_found` | operator |
| `rename_guild` | `operation_id`, `guild_id`, `name` | empty object | `not_found`, `bad_request`, `conflict` | operator |
| `set_guild_description` | `operation_id`, `guild_id`, `description` | empty object | `not_found`, `bad_request`, `conflict` | operator |
| `set_guild_member_role` | `operation_id`, `guild_id`, `user_id`, `role` | empty object | `not_found`, `bad_request`, `conflict` | operator |
| `kick_guild_member` | `operation_id`, `guild_id`, `user_id` | empty object | `not_found`, `bad_request`, `conflict` | operator |
| `disband_guild` | `operation_id`, `guild_id`, `user_id` | empty object | `not_found`, `bad_request`, `conflict` | operator |
| `import_guild` | `operation_id`, `name`, `description`, `join_type`, `join_value`, `max_members`, `members` | `guild_id` | `bad_request`, `not_found`, `conflict` | operator |

- `GuildInfo`(base proto message): `int64 guild_id`, `string name`, `string description`, `GuildJoinType join_type`, `int64 join_value`, `int64 leader_id`, `int32 member_count`, `int32 max_members`, `int64 created_at`
- `GuildMemberEntry`(base proto message): `PublicProfileEntry profile`, `GuildRole role`, `int64 joined_at`
- `GuildJoinType`(base proto enum): `Open`(joins at once), `Approval`(a `Leader` or an `Officer` receives the join request), `Closed`(accepts no join)
- `GuildRole`(base proto enum): `Leader`, `Officer`, `Member`
- `join_value`: the join condition value. Content decides its meaning, and hook `validate_guild_join` judges it. e.g. minimum level
- `max_join_value`: the maximum `join_value` that `ListJoinableGuilds` filters by. Client content code puts in the user's join condition value (e.g. level). When 0, it does not filter by `join_value`
- `get_guild` output JSON: `join_type` and `role` are element names, the `int64` columns (`guild_id`, `join_value`, `leader_id`, `created_at`, `updated_at`) and `user_id`, `joined_at`, `active_at` of `members` are decimal strings, `member_count` and `max_members` are JSON integers, and `joinable` is a JSON boolean
- admin operation field types: `guild_id` is `int64`, `name` and `description` are `string`, `role` is `enum{Leader, Officer, Member}`, `join_type` is `enum{Open, Approval, Closed}`, `join_value` is `int64`, `max_members` is `int32`, and `members` is `array<object{user_id: int64, role: enum{Leader, Officer, Member}}>`. `user_target` of `set_guild_member_role`, `kick_guild_member` and `disband_guild` is `user_id`
- `GetMyGuild` output: `guild` (`GuildInfo` of my guild. When I am not a member, an empty `GuildInfo` with `guild_id` 0), `members` (same order as `GetGuild`), `join_requests` (when I am `Leader` or `Officer`, the list of `PublicProfileEntry` of the join requests to my guild. Users without a profile are left out. Ascending order of `created_at` of the join request row, ties in ascending order of user ID. Otherwise an empty list), `my_join_requests` (list of the guild IDs I sent join requests to. Ascending order of `created_at` of the join request row, ties in ascending order of guild ID), `cooldown_ends_at` (0 when there is no cooldown)

## behavior

### tables

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `guild_guild` | `game` | `guild_id`, `name`, `normalized_name`, `description`, `join_type`, `join_value`, `leader_id`, `member_count`, `max_members`, `joinable`(`bool`), `created_at`, `updated_at` | `guild_id` | none | `(normalized_name)`, `(joinable, updated_at)` |
| `guild_name` | `game` | `normalized_name`, `guild_id` | `normalized_name` | none | none |
| `guild_member` | `game` | `user_id`, `guild_id`, `role`, `joined_at`, `active_at` | `user_id` | none | `(guild_id)` |
| `guild_join_request` | `game` | `guild_id`, `user_id`, `created_at` | `(guild_id, user_id)` | none | `(user_id)` |
| `guild_cooldown` | `game` | `user_id`, `ends_at` | `user_id` | `ends_at` | none |
| `guild_sequence` | `game` | `id`(one row with value 0), `last_guild_id` | `id` | none | none |

- `guild_member`, `guild_join_request` and `guild_cooldown` are registered with personal data user column `user_id`. Their scope is `game` because transactions of other users change the rows
- `guild_id` is an integer that increases from 1, and the ID of a disbanded guild is not given again either. The last given ID is kept in one `guild_sequence` row. ID issuance locks the key 0 row of `guild_sequence` with `storage.lock_game_row`, reads it, writes the value plus 1 to that row, and returns it as the new `guild_id`. When there is no row, the last ID counts as 0
- Name normalization is `validation.normalize_text`. Name registration inserts the `guild_name` row with an insert that writes nothing on a key conflict, and reads the `guild_id` of that key again. When it is another guild, the result is `GUILD_NAME_TAKEN`
- lock order: handling that changes member rows or guild rows, handling that inserts join request rows, and `AcceptGuildJoinRequest` and `RejectGuildJoinRequest`, which handle join requests to one guild, first lock the `guild_guild` row of that guild with `storage.lock_game_row`, then lock the `guild_member` rows of the users that the handling reads or changes in ascending order of user ID. Handling that deletes the applicant's own join request rows (deleting the join requests sent to other guilds on joining, `CancelGuildJoinRequest`, `remove_user`) locks only the applicant's `guild_member` row, and also deletes the join request rows sent to other guilds under that lock. Join request rows are read after locking the applicant's `guild_member` row
- Handling that finds the guild by my `guild_member` row (`UpdateGuild`, `AcceptGuildJoinRequest`, `RejectGuildJoinRequest`, `LeaveGuild`, `KickGuildMember`, `SetGuildMemberRole`) locks in lock order by the guild ID of my row read before locking, and after locking reads again all `guild_member` rows that the handling uses. When my re-read row does not exist or its guild ID differs from the locked guild, the result is `GUILD_NOT_MEMBER`. The role check and change use the re-read rows
- `max_members` at creation is `guild.maxMembers`. `set_guild_max_members` locks that guild row and changes `max_members` only when the capacity is at least 1 and at most `guild.maxMembersLimit` and the guild exists. When the capacity becomes less than `member_count`, it removes no member and only blocks new joins
- cooldown: when a user leaves with `LeaveGuild` or is kicked, `ends_at` of that user's `guild_cooldown` is written as request time + `guild.rejoinCooldownMs`. While `server-time.is_reached_strict`(`ends_at`) is `false`, `CreateGuild` and `JoinGuild` give `GUILD_COOLDOWN`
- disband: happens only in a guild with one member. It calls after hook `on_guild_member_changed`(`Disbanded`), calls the functions received with `register_disband_listener` in registration order, then deletes the guild row, the name row, the join request rows and the member row. The functions are called inside the disbanding transaction; when a function throws, that handling is `INTERNAL` and the guild is not disbanded. No cooldown is written
- When members change, `member_count` and `updated_at` (request time) are written together
- `joinable` tells whether `join_type` is not `Closed` and `member_count` < `max_members`. Every handling that writes `join_type`, `member_count` or `max_members` to the guild row also writes `joinable` from the written values

### create and update

`CreateGuild` processing order. On failure, nothing changes.

1. When `join_type` is `_UNSPECIFIED`, `INVALID_REQUEST`
2. When `validation.check_text`(`name`, `guild.maxNameLength`, line breaks not allowed) is `INVALID` or the code point count of `name` is less than `guild.minNameLength`, `TEXT_INVALID`; when `BANNED`, `TEXT_BANNED`. When `description` is not an empty string, it is judged the same way with `check_text`(`description`, `guild.maxDescriptionLength`, line breaks allowed)
3. Locks my `guild_member` row. When the row exists, `GUILD_ALREADY_MEMBER`
4. When within the cooldown, `GUILD_COOLDOWN`
5. hook `prepare_create_guild`(ctx, `name`). On `GameError`, that error
6. ID issuance
7. name registration with the `guild_id` of step 6. When another guild uses the name, `GUILD_NAME_TAKEN`
8. Writes the `guild_guild` row with the `guild_id` of step 6, writes me to a `guild_member` row as `Leader`, and deletes all my join request rows. after hook `on_guild_member_changed`(`Joined`)

- `UpdateGuild`: when my `guild_member` row does not exist, `GUILD_NOT_MEMBER`. It locks the guild row and my row in lock order, and when the re-read role is not `Leader`, `GUILD_PERMISSION`. It runs the check of `CreateGuild` step 1 and the `description` check of step 2, then changes the three values. Join request rows stay regardless of `join_type`

### join

`JoinGuild` processing order. On failure, nothing changes.

1. Locks the guild row. When it does not exist, `GUILD_NOT_FOUND`
2. Locks my `guild_member` row. When it exists, `GUILD_ALREADY_MEMBER`
3. When within the cooldown, `GUILD_COOLDOWN`
4. When `join_type` is `Closed`, `GUILD_CLOSED`
5. hook `validate_guild_join`(ctx, guild ID, `join_value`). On `GameError`, that error
6. `Open`: when `member_count` ≥ `max_members`, `GUILD_FULL`. Otherwise writes me as `Member`, raises `member_count` by 1 and deletes all my join request rows. after hook(`Joined`). `joined` is `true`
7. `Approval`: when I already have a join request to that guild, nothing changes. When my join request count ≥ `guild.maxJoinRequestsPerUser` or the join request count of that guild ≥ `guild.maxJoinRequestsPerGuild`, `GUILD_REQUEST_LIMIT`. Otherwise writes the join request row and calls after hook `on_guild_join_requested`. `joined` is `false`

- `CancelGuildJoinRequest`: when there is no join request row of mine to that guild, `GUILD_REQUEST_NOT_FOUND`. When there is one, deletes it
- `AcceptGuildJoinRequest` processing order
  1. Finds my guild by my `guild_member` row. When there is none, `GUILD_NOT_MEMBER`. Locks my guild row, my row and the applicant's `guild_member` row in lock order, and reads them again
  2. When my re-read role is not `Leader` or `Officer`, `GUILD_PERMISSION`
  3. When there is no join request row, `GUILD_REQUEST_NOT_FOUND`
  4. When `member_count` ≥ `max_members`, `GUILD_FULL`
  5. Writes the applicant as `Member`, raises `member_count` by 1 and deletes all the applicant's join request rows. after hook(`Joined`)
- `RejectGuildJoinRequest`: runs steps 1 to 3 of `AcceptGuildJoinRequest` and deletes the join request row
- On joining, all join request rows of that user are deleted in the same transaction, so the applicant of a remaining join request row is not a guild member

### leave, kick, role

- `LeaveGuild`: when my `guild_member` row does not exist, `GUILD_NOT_MEMBER`. Locks the guild row and my row in lock order and reads them again. When I am `Leader` and there are other members, `GUILD_LEADER_CANNOT_LEAVE`. When I am the only member, disbands. Otherwise deletes my row, lowers `member_count` by 1 and writes my cooldown. after hook(`Left`)
- `KickGuildMember`: when `user_id` is myself, `INVALID_REQUEST`. When my `guild_member` row does not exist, `GUILD_NOT_MEMBER`. Locks the guild row, my row and the target's row in lock order and reads them again. When the target is not a member of the same guild, `GUILD_NOT_MEMBER`. `Leader` kicks any other member, `Officer` kicks only `Member`, and any other case is `GUILD_PERMISSION`. Deletes the target's row, lowers `member_count` by 1 and writes the target's cooldown. after hook(`Kicked`)
- `SetGuildMemberRole`: when `user_id` is myself or `role` is `_UNSPECIFIED`, `INVALID_REQUEST`. When my `guild_member` row does not exist, `GUILD_NOT_MEMBER`. Locks the guild row, my row and the target's row in lock order and reads them again. When the target is not a member of the same guild, `GUILD_NOT_MEMBER`, and when I am not `Leader`, `GUILD_PERMISSION`
  - When changing to `Officer` and the number of `Officer` members other than the target is `guild.maxOfficers` or more, `GUILD_OFFICER_LIMIT`
  - Otherwise changes the role and `leader_id` the same way as role change
- role change (guild ID, target user ID, role): locks in lock order the guild row and, when role is `Leader`, the row of the current `Leader` and the target's row, otherwise the target's row, and reads them again. In the cases below it fails and changes nothing
  - the guild does not exist
  - the target is not a member of that guild
  - role is `_UNSPECIFIED`
  - the target is `Leader` and role is not `Leader`
  - role is `Officer` and the number of `Officer` members other than the target is `guild.maxOfficers` or more
- When the target's role is already that role, role change succeeds without changing anything, before checking the `Officer` count limit. When role is `Leader`, the target becomes `Leader`, the previous `Leader` becomes `Officer`, and `leader_id` is the target. In this case it does not check the `Officer` count limit. Otherwise it changes only the target's role. After the change, for each member whose role changed, it calls after hook `on_guild_member_changed`(`RoleChanged`) in the order target, previous `Leader`
- `set_member_role` runs role change in the transaction of ctx, and returns `true` on success and `false` on failure

### leader succession

- `active_at` of `guild_member` is the time the member last used the guild. When a member row is newly written, it is written with the same value as `joined_at`. When handling that finds the guild by my `guild_member` row, or `GetMyGuild`, succeeds and my row remains, `active_at` of my row is written as request time. This write is the last write of that handling, and in handling that does not lock in lock order, it is the only row that handling writes
- When `guild.leaderInactiveMs` is not `null`, `GetMyGuild` runs the leader succession below. It runs only when I am not the `Leader` of that guild and `active_at` of the `Leader` + `guild.leaderInactiveMs` ≤ request time
  1. Locks the guild row and all `guild_member` rows of that guild in lock order and reads them again. When the re-read rows do not meet the condition above, leader succession does not run
  2. The candidate is, among members that are not `Leader` and whose `active_at` + `guild.leaderInactiveMs` > request time, the `Officer` with the earliest `joined_at`, or, when there is no `Officer`, the `Member` with the earliest `joined_at`. When `joined_at` is equal, the member with the smaller user ID. When there is no candidate, leader succession does not run
  3. Changes the candidate to `Leader` and the previous `Leader` to `Member`, and writes the candidate to `leader_id`. Calls after hook(`RoleChanged`) in the order candidate, previous `Leader`. Leaves the guild ID, the previous `Leader` and the new `Leader` in an `info` log
- The output of `GetMyGuild` is the values after leader succession

### query

- `GetGuild`: when the guild does not exist, `GUILD_NOT_FOUND`. The member list is in the order `Leader`, `Officer`, `Member`; within the same role, ascending order of `joined_at`, ties in ascending order of user ID. `profile` is filled with `public-profile.get_public_profiles`, and members without a profile are left out
- `SearchGuilds`: when the normalized `name` is an empty string, an empty list. Otherwise returns `guild.maxSearchResults` guilds whose `normalized_name` starts with the normalized `name`, in ascending byte order of `normalized_name`. In the DB, it reads up to `guild.maxSearchResults` rows of `guild_guild` whose `normalized_name` is at least the normalized `name`, in ascending order of `normalized_name`, and uses only the rows among them that start with the normalized `name`
- `ListJoinableGuilds`: returns up to `guild.maxSearchResults` guilds whose `join_type` is not `Closed`, whose `member_count` < `max_members`, and, when `max_join_value` is not 0, whose `join_value` ≤ `max_join_value`, in descending order of `updated_at`, ties in ascending order of guild ID. In the DB, it reads up to `guild.maxSearchResults` rows of `guild_guild` whose `joinable` is `true` in that order, and uses only the rows among them that meet the `join_value` condition. So it can return fewer than `guild.maxSearchResults` guilds even when more guilds meet the condition
- `get_member` reads with `storage.db`(ctx), and `list_member_ids` and `get_guild_infos` read with `storage.db`(ctx or game tx); they write nothing

### content state

- When content changes guild-level game state, it locks the guild row with `lock_guild`, then reads and writes the game state. While locked, the members and roles of that guild do not change and no new join request row is created. An applicant's join, `CancelGuildJoinRequest` and `remove_user` can delete join request rows of that guild. When `lock_guild` returns none, that guild does not exist
- Content cleans up the content state of that user or guild in `on_guild_member_changed`. On `Disbanded`, it deletes the guild-level game state

### withdrawal

- `remove_user` locks in the order below. On exceeding the lock wait, `FAILED`
  1. Reads the `guild_member` row of that user. When the row exists, locks that guild row, and locks all `guild_member` rows of that guild, read after locking the guild row, and the `guild_member` row of that user in ascending order of user ID. When the row does not exist, locks only the `guild_member` row of that user
  2. Reads all locked `guild_member` rows again
  3. When the re-read row of that user exists, and the guild row was not locked in 1 or the guild of that row is not the guild locked in 1, changes nothing and returns `FAILED`. The caller rolls back the transaction
- After that, `remove_user` deletes the join request rows and the cooldown row of that user. When the re-read row of that user exists, it does the following
  - When not `Leader`, deletes that user's row and lowers `member_count` by 1. Writes no cooldown. Calls after hook `on_guild_member_changed`(`Left`)
  - When `Leader` and there are other members, changes to `Leader`, among the re-read rows, the `Officer` with the earliest `joined_at`, or, when there is no `Officer`, the `Member` with the earliest `joined_at`, changes `leader_id` to that member and calls after hook(`RoleChanged`) with that member, then leaves the same way as when not `Leader` and calls after hook(`Left`). When `joined_at` is equal, the member with the smaller user ID
  - When that user is the only member, disbands. The only after hook is the `Disbanded` of the disband
- The ctx of these after hooks is the ctx that `remove_user` received, and the user ID is the new `Leader` for `RoleChanged` and that user otherwise

### admin

- `get_guild`, `rename_guild` and `set_guild_description` run in a game tx opened with `storage.run_game_transaction`. When the guild does not exist, `not_found`
- `rename_guild`: when `validation.is_plain_text`(`name`, `guild.maxNameLength`) is `false` or the code point count is less than `guild.minNameLength`, `bad_request`. Banned words are not checked. After locking the guild row, it does the following
  1. When the normalized `name` equals `normalized_name` of the guild row, keeps the name row as it is and does 3
  2. Writes the new name row with name registration. When another guild uses the name, `conflict`. Deletes the name row of the previous `normalized_name`
  3. Writes `name` of the guild row as `name`, `normalized_name` as the normalized `name`, and `updated_at` as `server-time.clock_now`
- `set_guild_description`: when `description` is not an empty string and `validation.check_text`(`description`, `guild.maxDescriptionLength`, line breaks allowed) is `INVALID`, `bad_request`. Banned words are not checked
- `set_guild_member_role`, `kick_guild_member` and `disband_guild` run in the out-of-request change of `user_id` that `admin-api` opens. When the guild does not exist, `not_found`
- `set_guild_member_role`: runs role change(`guild_id`, `user_id`, `role`). When the target is not a member of that guild, or the target is `Leader` and `role` is not `Leader`, `bad_request`; at the `Officer` count limit, `conflict`
- `kick_guild_member`: locks the guild row and the target's row in lock order and reads them again. When the target is not a member of that guild or is `Leader`, `bad_request`. Like `KickGuildMember`, deletes the target's row, lowers `member_count` by 1 and writes the target's cooldown. after hook(`Kicked`)
- `disband_guild`: locks the guild row and all `guild_member` rows of that guild in lock order and reads them again. When `user_id` is not the `Leader` of that guild, `bad_request`. For each member that is not `Leader`, in ascending order of user ID, deletes its row and calls after hook(`Kicked`), then disbands with the one remaining `Leader`. Writes no cooldown
- `import_guild` creates a guild used to reproduce a PROD problem. It runs in the game tx that `admin-api` opens, in the order below. On failure, nothing changes
  1. When the environment is PROD, `conflict`
  2. When `members` is empty, or the number of members whose `role` is `Leader` is not one, or the same `user_id` appears twice, or `max_members` is less than 1 or more than `guild.maxMembersLimit`, or the member count is more than `max_members`, or the `Officer` count is more than `guild.maxOfficers`, or `join_value` is less than 0 or more than 2^53−1, or `name` violates the name rules of `rename_guild`, or `description` violates the rules of `set_guild_description`, `bad_request`
  3. Locks the members' `guild_member` rows in ascending order of user ID
  4. After getting the locks of step 3, for each member's `user_id`, when `storage.get_user_record` is none or `withdrawn_at` exists, `not_found`. After that, when any member has a `guild_member` row, `conflict`
  5. ID issuance
  6. name registration with the `guild_id` of step 5. When another guild uses the name, `conflict`
  7. Writes the `guild_guild` row with the `guild_id` of step 5, the same way as `CreateGuild` step 8. `leader_id` is the `Leader` member, `member_count` is the member count, `max_members` is the input value, and `created_at` and `updated_at` are `server-time.clock_now`. Writes a `guild_member` row for each member with its role (`joined_at` and `active_at` are the same `clock_now`), and deletes all join request rows of the members. Calls no after hook and does not check banned words

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `other_user_content` | guild name and description that the user sets | `module` | `app_functionality` | `true` | `false` | `false` | `true` | `all` | `none` |
| `gameplay_content` | guild membership and role | `module` | `app_functionality` | `true` | `false` | `false` | `true` | `all` | `none` |

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `prepare_create_guild`(handler hook) | `CreateGuild` step 5 | ctx, `name` | `pass` or `GameError` | `pass` |
| `validate_guild_join`(validation hook) | `JoinGuild` step 5 | ctx, guild ID, `join_value` | `pass` or `GameError` | `pass` |
| `on_guild_member_changed`(after hook) | after a `Joined`, `Left`, `Kicked`, `Disbanded` or `RoleChanged` change | ctx, guild ID, user ID, `GuildMemberChange` | none | does nothing |
| `on_guild_join_requested`(after hook) | after writing the join request row in `JoinGuild` step 7 | ctx (of the applicant), guild ID | none | does nothing |

- `prepare_create_guild` handles the creation cost and conditions. e.g. `item-ledger.subtract_items`, `validation.evaluate_requirement`. When a later step fails, the changes of the hook are also rolled back
- `GuildMemberChange`: `Joined`, `Left`, `Kicked`, `Disbanded`, `RoleChanged`. `RoleChanged` means the role of the user ID in the hook input changed, and the changed role is read with `get_member`
- The ctx of `on_guild_member_changed` is the ctx of the transaction that made that change. When the user ID in the hook input is the user of ctx, the hook changes that user's UserState with `storage.put_state` and `delete_state`; otherwise it sends the change with `storage.send_user_change`. e.g. for `Joined` of `JoinGuild`, `Left` of `LeaveGuild` and `Kicked` of admin operation `kick_guild_member`, the user of ctx is the changed user; for `Joined` of `AcceptGuildJoinRequest`, `Kicked` of `KickGuildMember`, `Kicked` of `disband_guild` and the target's `RoleChanged` of `SetGuildMemberRole`, the user of ctx is not the changed user
- `on_guild_join_requested` is used for join request notifications and aggregation. e.g. `push.queue_push` to the `Leader` and `Officer` members chosen with `list_member_ids` and `get_member`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation, `_UNSPECIFIED` enum value, kick or role change that targets oneself | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| plain text violation of name or description, short name | `TEXT_INVALID` | `TEXT_INVALID` | none |
| banned word in name or description | `TEXT_BANNED` | `TEXT_BANNED` | `info` log. The matched `banned_word` ID value |
| guild that does not exist | `GUILD_NOT_FOUND` | `GUILD_NOT_FOUND` | none |
| already a guild member | `GUILD_ALREADY_MEMBER` | `GUILD_ALREADY_MEMBER` | none |
| not a guild member, or the target is not a member of the same guild | `GUILD_NOT_MEMBER` | `GUILD_NOT_MEMBER` | none |
| name that another guild uses | `GUILD_NAME_TAKEN` | `GUILD_NAME_TAKEN` | none |
| capacity reached | `GUILD_FULL` | `GUILD_FULL` | none |
| join to a `Closed` guild | `GUILD_CLOSED` | `GUILD_CLOSED` | none |
| within cooldown | `GUILD_COOLDOWN` | `GUILD_COOLDOWN` | none |
| insufficient role | `GUILD_PERMISSION` | `GUILD_PERMISSION` | none |
| no join request | `GUILD_REQUEST_NOT_FOUND` | `GUILD_REQUEST_NOT_FOUND` | none |
| join request count limit | `GUILD_REQUEST_LIMIT` | `GUILD_REQUEST_LIMIT` | none |
| leaving by a `Leader` with other members | `GUILD_LEADER_CANNOT_LEAVE` | `GUILD_LEADER_CANNOT_LEAVE` | none |
| `Officer` count limit | `GUILD_OFFICER_LIMIT` | `GUILD_OFFICER_LIMIT` | none |
| capacity out of range, `set_guild_max_members` of a guild that does not exist | `false` | content decides | `error` log |
| `set_member_role` with a role change failure | `false` | content decides | none |
| lock wait exceeded in a core rpc | `FAILED` | `INTERNAL` | `error` log by `routing` |
| lock wait exceeded in `lock_guild` called by `chat` or `ranking`, lock wait exceeded in `remove_user`, the `guild_member` row of that user that `remove_user` read again is not a row of the guild locked in 1 | `FAILED` | the caller decides | none |
| lock wait exceeded in `lock_guild`, `set_guild_max_members` or `set_member_role` called by a content handler or a hook | throw | `INTERNAL` | `error` log by `routing` |
| throw of a `register_disband_listener` function | throw | `INTERNAL` | `error` log by `routing` |
| second `register_disband_listener` registration of the same function, registration outside server start | server start failure | none | `error` log |
| `get_guild`, `rename_guild`, `set_guild_description`, `set_guild_member_role`, `kick_guild_member` or `disband_guild` of a guild that does not exist | `not_found` | none | `audit` |
| plain text violation or short `name` in `rename_guild`, plain text violation in `set_guild_description` | `bad_request` | none | `audit` |
| `rename_guild` to a name that another guild uses | `conflict` | none | `audit` |
| `kick_guild_member` whose target is not a member of that guild or is `Leader`, `set_guild_member_role` that violates the `Leader` rules, `disband_guild` with a `user_id` that is not `Leader` | `bad_request` | none | `audit` |
| `set_guild_member_role` at the `Officer` count limit | `conflict` | none | `audit` |
| lock wait exceeded in an admin operation | `internal` | none | error rules of `admin-api` |
| `rename_guild`, `set_guild_description`, `set_guild_member_role`, `kick_guild_member`, `disband_guild` or `import_guild` with a different input for the same `operation_id` | `conflict` | none | `audit` |
| `import_guild` in the PROD environment, with a member that is a guild member, or with a name that another guild uses | `conflict` | none | `audit` |
| `import_guild` that violates the `members`, `max_members`, `join_value`, `name` or `description` rules | `bad_request` | none | `audit` |
| `import_guild` with a member that does not exist or is a withdrawn user | `not_found` | none | `audit` |

Added `CoreError`: `GUILD_NOT_FOUND`, `GUILD_ALREADY_MEMBER`, `GUILD_NOT_MEMBER`, `GUILD_NAME_TAKEN`, `GUILD_FULL`, `GUILD_CLOSED`, `GUILD_COOLDOWN`, `GUILD_PERMISSION`, `GUILD_REQUEST_NOT_FOUND`, `GUILD_REQUEST_LIMIT`, `GUILD_LEADER_CANNOT_LEAVE`, `GUILD_OFFICER_LIMIT`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `guild.maxMembers` | integer | core | content | guild capacity at creation. At least 1 |
| `guild.maxMembersLimit` | integer | core | content | maximum capacity that `set_guild_max_members` can set. At least 1 |
| `guild.maxOfficers` | integer | core | content | `Officer` count limit of one guild |
| `guild.minNameLength` | integer | core | content | minimum code point count of the name |
| `guild.maxNameLength` | integer | core | content | maximum code point count of the name |
| `guild.maxDescriptionLength` | integer | core | content | maximum code point count of the description |
| `guild.maxSearchResults` | integer | core | content | limit of the number of guilds that `SearchGuilds` and `ListJoinableGuilds` return. At least 1 |
| `guild.maxJoinRequestsPerUser` | integer | core | content | limit of the number of join requests one user has open concurrently. At least 1 |
| `guild.maxJoinRequestsPerGuild` | integer | core | content | limit of the number of join requests piled up in one guild. At least 1 |
| `guild.rejoinCooldownMs` | integer | core | content | duration after leaving or being kicked until creating or joining again |
| `guild.leaderInactiveMs` | integer? | core | content | when this duration has passed since `active_at` of the `Leader`, `GetMyGuild` runs leader succession. When `null`, leader succession does not run |

settings constraint

| left | factor | right |
|---|---|---|
| `guild.maxMembers` | 1 | `guild.maxMembersLimit` |
| `guild.minNameLength` | 1 | `guild.maxNameLength` |

## data

used table: `banned_word`. A table of `validation`

## DEV

none

## test

- `CreateGuild` makes me `Leader`, `member_count` 1 and `max_members` `guild.maxMembers`, and `on_guild_member_changed`(`Joined`) is called once
- The second `CreateGuild` with a name that normalizes the same gives `GUILD_NAME_TAKEN`, and of two users who create the same name concurrently, only one succeeds
- A name containing a banned word gives `TEXT_BANNED`, a name containing a line break gives `TEXT_INVALID`, and a description containing a line break passes
- A name of at least `guild.minNameLength` code points that are all `Default_Ignorable_Code_Point` gives `TEXT_INVALID` in `CreateGuild` and `bad_request` in `rename_guild` and `import_guild`, and the guild row and the name row stay unchanged
- `GameError` of `prepare_create_guild` gives that error, and no guild exists. When step 7 fails, no item change of the hook remains
- `JoinGuild` of an `Open` guild gives `joined` `true`, and at capacity `GUILD_FULL`. `Closed` gives `GUILD_CLOSED`
- `JoinGuild` of an `Approval` guild writes a join request row and gives `joined` `false`, and `AcceptGuildJoinRequest` by an `Officer` makes the applicant `Member` and deletes all other join request rows of the applicant. Acceptance by a `Member` gives `GUILD_PERMISSION`
- When the applicant's join to another guild and the acceptance by the guild that received the join request come concurrently, the applicant is in only one guild
- When two acceptances come concurrently to a guild at capacity − 1, one gives `GUILD_FULL`
- `JoinGuild` of a user who left and of a kicked user gives `GUILD_COOLDOWN` within `guild.rejoinCooldownMs`, and passes after it
- `LeaveGuild` of a `Leader` with other members gives `GUILD_LEADER_CANNOT_LEAVE`, and `LeaveGuild` of a `Leader` alone disbands, calls `on_guild_member_changed`(`Disbanded`) once, and the name can be used again
- When an `Officer` kicks an `Officer`, `GUILD_PERMISSION`
- Changing to `Leader` makes the previous `Leader` `Officer` and changes `leader_id`. Changing to `Officer` at the `Officer` count limit gives `GUILD_OFFICER_LIMIT`
- The member order of `GetGuild` is by role, `joined_at`, user ID
- `GetGuild`, `JoinGuild` and `CancelGuildJoinRequest` with `guild_id` 0, `AcceptGuildJoinRequest` and `RejectGuildJoinRequest` with `user_id` 0, and `ListJoinableGuilds` with `max_join_value` greater than 2^53−1 give `INVALID_REQUEST`, and the saved state stays unchanged
- `join_requests` of `GetMyGuild` is in ascending order of `created_at` of the join request row, ties in ascending order of user ID, and `my_join_requests` is in ascending order of `created_at`, ties in ascending order of guild ID
- `SearchGuilds` returns only guilds with the same normalized prefix, and `ListJoinableGuilds` leaves out `Closed` guilds and full guilds. When `max_join_value` is not 0, it leaves out guilds whose `join_value` is greater than that value, and when 0, it does not leave out by `join_value`. It does not return guilds older than the latest `guild.maxSearchResults` guilds whose `joinable` is `true`
- `set_guild_max_members` gives `false` for a value out of range and for a guild that does not exist, and members remain when the capacity is reduced
- `JoinGuild` of another user waits until the transaction that locked with `lock_guild` ends
- When the lock wait is exceeded while another transaction holds the lock on the guild row, `lock_guild` called by a content handler throws, the request gives `INTERNAL`, and the saved state is the value before handling. At the same time, `Withdraw` of a member of that guild gives `INTERNAL`, and that user's `guild_member` row and `withdrawn_at` are the values before handling
- In PostgreSQL, even while another transaction locks a guild that received a join request with `lock_guild`, the applicant's `CancelGuildJoinRequest` and join to another `Open` guild delete that join request row without waiting
- When a transaction that locked a guild that received a join request with `lock_guild` and the applicant's `CancelGuildJoinRequest` come concurrently, after both end, that join request row does not exist and the changes of the locking transaction remain. When the applicant's join to another `Open` guild also comes, after they end, the applicant is a member of that `Open` guild and the applicant has no join request row
- After `Withdraw` of a `Leader`, the `Officer` who joined first is `Leader`, and when there is no `Officer`, the `Member` who joined first is `Leader`. `Withdraw` of a `Leader` alone disbands
- When `Withdraw` of a `Leader` with other members and `LeaveGuild` of the `Officer` who would succeed come concurrently, after they end, `leader_id` of the guild is a `Leader` that has a `guild_member` row in that guild, and `member_count` equals the number of `guild_member` rows of that guild
- `Withdraw` of a member that is not `Leader` and `Withdraw` of a `Leader` with other members call `on_guild_member_changed` once with that user's ctx, that user ID and `Left`, and `Withdraw` of a `Leader` alone calls only `Disbanded` once. `Withdraw` of a `Leader` with other members calls `RoleChanged` once with the user ID of the new `Leader` before `Left`
- When `guild.leaderInactiveMs` is L and `active_at` of the `Leader` is T, `GetMyGuild` of another member does not run leader succession at T + L − 1, and at T + L changes the first-joined `Officer` (when none, `Member`) among members with `active_at` + L > T + L to `Leader` and the previous `Leader` to `Member`. When there is no such member or `guild.leaderInactiveMs` is `null`, it changes nothing
- `GetMyGuild` and `UpdateGuild` change my `active_at` to request time
- When `set_member_role` changes the `Leader`, the previous `Leader` is `Officer`. Giving another role to a target that is `Leader` returns `false`, and nothing changes
- `set_guild_member_role` and `kick_guild_member` give the failure defined for each failure condition. `kick_guild_member` calls `on_guild_member_changed`(`Kicked`) once and writes the target's cooldown
- The user ID that `on_guild_member_changed`(`Kicked`) of `kick_guild_member` receives is the user of ctx, the target's content UserState that the hook wrote with `put_state` remains, and the operation succeeds
- `disband_guild` calls `Kicked` for each member that is not `Leader` and `Disbanded` last, and deletes the guild, name, join request and member rows. With a `user_id` that is not `Leader`, `bad_request`, and nothing changes
- `import_guild` in STG creates a guild with the input `name`, `description`, `join_type`, `join_value`, `max_members` and `members`, and calls no after hook. `import_guild` in the PROD environment, with a member that is already a guild member, or with a number of `Leader` members other than one fails and changes nothing
- `created_at` and `updated_at` of the guild that `import_guild` created and `joined_at` and `active_at` of its members are `clock_now` of that handling
- `rename_guild` changes the name without checking banned words, and gives `conflict` for the name of another guild. After the change, `name` of `guild` in the `GetGuild` response is the new name, `SearchGuilds` with the new name returns that guild, and `CreateGuild` with the previous name succeeds. When the new name does not start with the previous name, `SearchGuilds` with the previous name does not return that guild. When the guild is renamed to a name with the same normalized value, `name` of `guild` in the `GetGuild` response changes, and that guild has one name row
- While a transaction that kicks an `Officer` locks the guild row, `AcceptGuildJoinRequest` sent by that `Officer` gives `GUILD_NOT_MEMBER` after the kick commits, and the applicant is not a member
- `KickGuildMember` of a previous `Officer` that gets the lock after being changed to `Member` gives `GUILD_PERMISSION`
- When `Withdraw` of a user who sent a join request and `AcceptGuildJoinRequest` of that join request come concurrently, after they end, the `guild_member` row and the join request row of the withdrawn user do not exist, and `member_count` of that guild equals the number of `guild_member` rows
- When two users run `CreateGuild` concurrently, the two `guild_id` differ. The `guild_id` of a guild created after a disbanded guild is greater than the ID of the disbanded guild
- `guild_id` of the `guild_name` row that `CreateGuild` and `import_guild` wrote equals `guild_id` of the `guild_guild` row that the same handling wrote
- `get_guild_infos` returns only the guilds that exist, in ascending order of guild ID
- On disband, the function of `register_disband_listener` is called once inside that transaction, and when the function throws, `INTERNAL` and the guild remains
- When a new join request is written to an `Approval` guild, `on_guild_join_requested` is called once with the applicant's ctx and the guild ID, and it is not called for `JoinGuild` of a guild already requested or for a join to an `Open` guild
- When `SetGuildMemberRole` changes a `Member` to `Officer`, `on_guild_member_changed`(`RoleChanged`) is called once with the target's user ID, and when it changes to `Leader`, twice in the order target, previous `Leader`. When the target already has that role, it is not called. `set_member_role` and admin operation `set_guild_member_role` are the same. leader succession calls it twice in the order new `Leader`, previous `Leader`
