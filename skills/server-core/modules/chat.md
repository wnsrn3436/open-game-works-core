# chat

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

Saves text chat of world channels, guild channels and direct channels between friends, and lets client `ChatCore` receive it by polling. Handles fetching earlier messages, the caller's channel list, banned words, hiding messages of blocked users, send interval, mute, message reports, delivery of deleted messages, room invite messages, system messages that content writes, and message deletion by guild `Leader` and `Officer`.

## dependency

- `storage`
- `server-time`
- `logging`
- `validation`
- `nickname`
- `public-profile`
- `block-report`
- optional dependency: `friend`, `guild`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SendChatMessage` (core rpc, `retry`). changes: `content` | `channel_kind`, `channel_key`, `message_kind`, `text` | `message`: the sent `ChatMessage` | `INVALID_REQUEST`, `CHILD_RESTRICTED`, `USER_NOT_FOUND`, `BLOCKED`, `CHAT_NOT_FRIEND`, `GUILD_NOT_MEMBER`, `CHAT_MUTED`, `CHAT_TOO_FAST`, `TEXT_INVALID`, `TEXT_BANNED`, `GameError` of the hook | `routing`. client `ChatCore` sends it |
| `GetChatMessages` (core rpc, `silent`). changes: none | `channel_kind`, `channel_key`, `after_seq`, `before_seq`, `after_delete_seq` | `messages`: list of `ChatMessage`, `last_seq`, `poll_after_ms`, `first_seq`, `channel_key`, `deleted_seqs`, `last_delete_seq` | `INVALID_REQUEST`, `CHILD_RESTRICTED`, `GUILD_NOT_MEMBER` | `routing`. client `ChatCore` sends it |
| `ReportChatMessage` (core rpc, `retry`). changes: none | `channel_kind`, `channel_key`, `seq`, `reason_id` | empty response | `INVALID_REQUEST`, `CHILD_RESTRICTED`, `GUILD_NOT_MEMBER`, `CHAT_MESSAGE_NOT_FOUND`, `REPORT_LIMIT` | `routing`. client content code sends it |
| `GetChatChannels` (core rpc, `silent`). changes: none | none | `channels`: list of `ChatChannelEntry`, `poll_after_ms` | `CHILD_RESTRICTED` | `routing`. client `ChatCore` sends it |
| `DeleteGuildChatMessage` (core rpc, `retry`). changes: none | `seq` | empty response | `INVALID_REQUEST`, `CHILD_RESTRICTED`, `GUILD_NOT_MEMBER`, `GUILD_PERMISSION`, `CHAT_MESSAGE_NOT_FOUND` | `routing`. client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SendChatMessageRequest` | `channel_kind` | `ChatChannelKind` | none |
| `SendChatMessageRequest` | `channel_key` | `int64` | `min`: 0, `max`: 2^63−1 |
| `SendChatMessageRequest` | `message_kind` | `ChatMessageKind` | none |
| `SendChatMessageRequest` | `text` | `string` | `max_chars_key`: `chat.maxTextLength` |
| `GetChatMessagesRequest` | `channel_kind` | `ChatChannelKind` | none |
| `GetChatMessagesRequest` | `channel_key` | `int64` | `min`: 0, `max`: 2^63−1 |
| `GetChatMessagesRequest` | `after_seq` | `int64` | `min`: 0, `max`: 2^63−1 |
| `GetChatMessagesRequest` | `before_seq` | `int64` | `min`: 0, `max`: 2^63−1 |
| `GetChatMessagesRequest` | `after_delete_seq` | `int64` | `min`: 0, `max`: 2^63−1 |
| `ReportChatMessageRequest` | `channel_kind` | `ChatChannelKind` | none |
| `ReportChatMessageRequest` | `channel_key` | `int64` | `min`: 0, `max`: 2^63−1 |
| `ReportChatMessageRequest` | `seq` | `int64` | `min`: 1, `max`: 2^63−1 |
| `ReportChatMessageRequest` | `reason_id` | `int32` | `table`: `report_reason` |
| `DeleteGuildChatMessageRequest` | `seq` | `int64` | `min`: 1, `max`: 2^63−1 |

core `rpc` response field

| message | field | type |
|---|---|---|
| `SendChatMessageResponse` | `message` | `ChatMessage` |
| `GetChatMessagesResponse` | `messages` | `repeated ChatMessage` |
| `GetChatMessagesResponse` | `last_seq` | `int64` |
| `GetChatMessagesResponse` | `poll_after_ms` | `int64` |
| `GetChatMessagesResponse` | `first_seq` | `int64` |
| `GetChatMessagesResponse` | `channel_key` | `int64` |
| `GetChatMessagesResponse` | `deleted_seqs` | `repeated int64` |
| `GetChatMessagesResponse` | `last_delete_seq` | `int64` |
| `GetChatChannelsResponse` | `channels` | `repeated ChatChannelEntry` |
| `GetChatChannelsResponse` | `poll_after_ms` | `int64` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `remove_user` | ctx | none | `FAILED` | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age, job `auth_guest_sweep`) |
| `post_system_message` | ctx, `ChatChannelKind`, channel ID, `text` | the written `ChatMessage` | none. A lock wait timeout is a throw | content handler, hook |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `list_chat_messages` | `channel_kind`(`enum{World, Guild, Direct}`), `key_a`, `key_b`, `after_seq`, `limit` | `messages`: list of message rows. Ascending order of `seq` | `bad_request` | operator |
| `delete_chat_message` | `channel_kind`, `key_a`, `key_b`, `seq` | empty object | `not_found` | operator |
| `mute_chat_user` | `user_id`, `until_at`, `reason` | empty object | `bad_request`, `not_found` | operator |
| `unmute_chat_user` | `user_id` | empty object | `not_found` | operator |

- `ChatChannelKind`(base proto enum): `World`, `Guild`, `Direct`
- `ChatMessageKind`(base proto enum): `Text`(text written by a human), `RoomInvite`(invite whose `text` is a room code of `matchmaker`), `System`(message written by `post_system_message`)
- `channel_key`: the channel number for `World`, 0 for `Guild`, the other user's ID for `Direct`
- channel ID: value that points to a channel from the receiving user's side. The channel number for `World`, the guild ID for `Guild`, the other user's ID for `Direct`
- `ChatMessage`(base proto message): `ChatChannelKind channel_kind`, `int64 channel_key`(channel ID), `int64 seq`, `int64 sender_id`, `string sender_nickname`, `ChatMessageKind message_kind`, `string text`, `int64 created_at`. The `sender_id` of a `System` message is 0
- The `sender_nickname` of `ChatMessage` is the sender's current nickname, read with `nickname.get_nicknames` when the response is made. User IDs are split into calls of `nickname.maxLookupCount` each. It is the empty string when there is no nickname. The `sender_nickname` of a message whose `sender_id` is 0 is the empty string and is not looked up with `get_nicknames`
- `ChatChannelEntry`(base proto message): `ChatChannelKind channel_kind`, `int64 channel_key`(channel ID), `int64 last_seq`, `int64 last_at`(`created_at` of the last message. 0 when there is no message), `PublicProfileEntry profile`(the other user's profile for `Direct`, an empty message for `Guild`), `int64 last_visible_seq`(seq of the last message the receiving user can see)
- `reason_id`: ID value of the `block-report` table `report_reason`
- The `user_target` of `mute_chat_user` and `unmute_chat_user` is `user_id`. When `until_at` is 0, the mute does not end. `unmute_chat_user` also succeeds when there is no mute row
- field types of admin operations: `channel_kind` of `delete_chat_message` is the same `enum{World, Guild, Direct}` as in `list_chat_messages`, and `key_a`, `key_b`, `after_seq`, `seq` are `int64`

## behavior

### channel

- A channel is stored as `(kind, key_a, key_b)`. `World` is `(World, channel number, 0)`, `Guild` is `(Guild, guild ID, 0)`, `Direct` is `(Direct, smaller user ID, larger user ID)`
- child check: `CHILD_RESTRICTED` when `chat.allowChild` is `false` and `child` of that user's `ConsentUserState`(owner `auth`) read with `storage.get_state` is `true`. Passes when there is no row
- channel resolution. A failure ends with that error
  - `INVALID_REQUEST` when `channel_kind` is `_UNSPECIFIED`
  - `World`: `INVALID_REQUEST` when `channel_key` is not at least 1 and at most `chat.worldChannelCount`. When `chat.worldChannelCount` is 0, there is no world chat
  - `Guild`: `INVALID_REQUEST` when `guild` is not in the server module list or `channel_key` is not 0. `GUILD_NOT_MEMBER` when `guild.get_member` is none. Otherwise the channel is that guild ID
  - `Direct`: `INVALID_REQUEST` when `friend` is not in the server module list, or `channel_key` is less than 1 or is the caller's own ID

### send

`SendChatMessage` processing order. A failure changes nothing.

1. child check, channel resolution. For `Direct`, then `USER_NOT_FOUND` when the other user's `public-profile.is_active_user` is `false`, `BLOCKED` when `block-report.is_blocked_either` is `true`, and when `friend.are_friends` is `false`, calls `is_active_user` again: `USER_NOT_FOUND` when it is `false`, otherwise `CHAT_NOT_FRIEND`
2. `CHAT_MUTED` when the caller has a mute row and `until_at` is 0 or `server-time.is_reached_strict`(`until_at`) is `false`
3. `CHAT_TOO_FAST` when the caller's `last_sent_at` + `chat.minIntervalMs` > request time
4. text check
   - `Text`: `TEXT_INVALID` when `validation.check_text`(`text`, `chat.maxTextLength`, line breaks not allowed) is `INVALID`, `TEXT_BANNED` when it is `BANNED`
   - `RoomInvite`: `INVALID_REQUEST` when it is a `World` channel, the length of `text` is not `matchmaker.roomCodeLength`, or it has a character not in `matchmaker.roomCodeAlphabet`
   - `System`, `_UNSPECIFIED`: `INVALID_REQUEST`
5. hook `validate_chat_send`. On `GameError`, that error
6. For `Guild`, locks the guild row decided in step 1 with `guild.lock_guild` and reads `get_member` again. `GUILD_NOT_MEMBER` when `lock_guild` is none, or the value read again is none or its guild ID is not the locked guild. Then locks the channel row with `storage.lock_game_row`. For `Direct`, after locking, calls the other user's `public-profile.is_active_user` and `friend.are_friends` again: `USER_NOT_FOUND` when `is_active_user` is `false`, `CHAT_NOT_FRIEND` when `are_friends` is `false`. Then increases `last_seq` by 1 and writes `last_at` as the request time. Writes the message row with that seq
7. Writes the caller's `last_sent_at` as the request time
8. after hook `on_chat_message_sent`

### receive

- `GetChatMessages` runs the child check and resolves the channel. For `Direct`, it does not look at friendship, blocks or the other user's withdrawal. `INVALID_REQUEST` when `after_seq` and `before_seq` are both non-zero
- selection: when `after_seq` is non-zero, seqs greater than `after_seq` from the smallest; when `before_seq` is non-zero, seqs less than `before_seq` from the largest; when both are 0, the channel's seqs from the largest. It selects `chat.maxFetchCount` of them
- From the selected rows, leaves out deleted messages, messages with `expires_at` ≤ request time, and messages whose sender is in `block-report.list_blocked_ids`(the caller), and returns the rest in ascending order of seq
- `last_seq` is the largest seq of the selected rows. When no row is selected, it is `after_seq`. `first_seq` is the smallest seq of the selected rows. When no row is selected, it is 0
- `channel_key` is the channel ID of the resolved channel and equals the `channel_key` of `ChatMessage`
- deleted messages: when `after_seq` is non-zero, `deleted_seqs` is the list of `seq` of the rows selected from the channel's `chat_deletion` rows with `delete_seq` > `after_delete_seq`, `chat.maxFetchCount` of them in ascending order of `delete_seq`, and `last_delete_seq` is the largest `delete_seq` of the selected rows. When no row is selected, it is `after_delete_seq`. When `after_seq` is 0, `deleted_seqs` is the empty list and `last_delete_seq` is the `last_delete_seq` of the channel row. When there is no channel row, it is 0
- `poll_after_ms` is `chat.pollIntervalMs`. It is the duration client `ChatCore` waits until the next request
- Writes nothing

### report

`ReportChatMessage` processing order.

1. child check, channel resolution
2. `CHAT_MESSAGE_NOT_FOUND` when the message row of that seq does not exist, is deleted, or has `expires_at` ≤ request time
3. `INVALID_REQUEST` when the sender is the caller or `message_kind` is `System`
4. `block-report.add_report`(sender, `reason_id`, `Chat`, `ref`, empty comment, `text` of the message). `ref` is `<ChatChannelKind element name>:<key_a>:<key_b>:<seq>`. `REPORT_LIMIT` on `LIMIT`, `INVALID_REQUEST` on `INVALID_INPUT`

### channel list

`GetChatChannels` runs the child check and writes nothing.

- When `guild` is in the server module list and the caller is a guild member (`guild.get_member`), the one item of that guild channel comes first. When there is no channel row, `last_seq` and `last_at` are 0
- After it, when `friend` is in the server module list, puts the first `chat.maxChannelListCount` of the `Direct` channel rows the caller is in that have `last_at` + `chat.retentionMs` > request time and whose other user is not in `block-report.list_blocked_ids`(the caller), in descending order of `last_at`, ties in ascending order of the other user's ID. `profile` is filled with `public-profile.get_public_profiles`, and items without a profile are left out
- The `last_visible_seq` of an item is the largest seq among the channel's message rows that are not deleted, have `expires_at` > request time, and whose sender is not in `block-report.list_blocked_ids`(the caller). When there is no such row, it is 0
- `poll_after_ms` is `chat.channelPollIntervalMs`

### delete

message deletion: locks the channel row with `storage.lock_game_row`, sets `deleted` of the message row to `true`, increases `last_delete_seq` of the channel row by 1, and writes a `chat_deletion` row with that value as `delete_seq`. The `seq` of the `chat_deletion` row is the seq of the deleted message, and its `expires_at` is that message's `expires_at`.

`DeleteGuildChatMessage` processing order. A failure changes nothing.

1. child check
2. `INVALID_REQUEST` when `guild` is not in the server module list
3. `GUILD_NOT_MEMBER` when the caller's `guild.get_member` is none
4. Locks that guild row with `guild.lock_guild` and reads `get_member` again. `GUILD_NOT_MEMBER` when it is none or not the locked guild, `GUILD_PERMISSION` when the role is not `Leader` or `Officer`
5. Locks that guild channel row with `storage.lock_game_row`. `CHAT_MESSAGE_NOT_FOUND` when the message row of that seq does not exist, is deleted, or has `expires_at` ≤ request time
6. message deletion. Leaves the deleting user ID, the guild ID and the seq in an `info` log

- Handling that locks a guild row and a channel row together in one transaction (`SendChatMessage` on a `Guild` channel, `DeleteGuildChatMessage`, `post_system_message` on a `Guild` channel) locks the guild row first

### system message

`post_system_message` processing order. On a failure, returns none, leaves an `error` log and writes nothing.

1. channel: for `World`, fails when the channel ID is not at least 1 and at most `chat.worldChannelCount`. For `Guild`, fails when `guild` is not in the server module list or `guild.lock_guild`(ctx, channel ID) is none. Any other kind fails
2. Fails when `text` is the empty string or its UTF-8 byte count is more than `chat.maxSystemTextBytes`
3. Locks the channel row as in send step 6, writes `last_seq` and `last_at`, and writes the message row. `sender_id` is 0 and `message_kind` is `System`. The `channel_key` of the returned `ChatMessage` is the channel ID

- Does not look at the child check, mute, send interval, banned words or hooks
- A lock wait timeout on the guild row or the channel row is a throw, not none, and the request is `INTERNAL`
- Content decides the format of `text`. client content code makes the screen text from that format

### tables

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `chat_channel` | `game` | `kind`, `key_a`, `key_b`, `last_seq`, `last_at`, `last_delete_seq` | `(kind, key_a, key_b)` | none | `(kind, key_b)` |
| `chat_message` | `game` | `kind`, `key_a`, `key_b`, `seq`, `sender_id`, `message_kind`, `text`, `deleted`, `created_at`, `expires_at` | `(kind, key_a, key_b, seq)` | `expires_at` | `(sender_id)` |
| `chat_sender` | `user` | `user_id`, `last_sent_at` | `user_id` | none | none |
| `chat_mute` | `user` | `user_id`, `until_at`, `reason`, `muted_at` | `user_id` | none | none |
| `chat_deletion` | `game` | `kind`, `key_a`, `key_b`, `delete_seq`, `seq`, `expires_at` | `(kind, key_a, key_b, delete_seq)` | `expires_at` | none |

- `chat_message` is registered with personal data user column `sender_id`. `expires_at` is `created_at` + `chat.retentionMs`
- `chat_sender` and `chat_mute` are registered with snapshot flag `false`
- seq and `delete_seq` increase from 1 per channel

### withdrawal

- `remove_user` runs in the order below. `FAILED` on a lock wait timeout
  1. Reads the `Direct` channel rows the user is in to get the list of other users. When `friend` is in the server module list, adds the users of `friend.list_friend_ids`(ctx, that user). `auth` calls this before `friend.remove_user`, so the friend link rows are still there
  2. For each other user, locks the `Direct` channel key with that user with `storage.lock_game_row`, in ascending order of `(key_a, key_b)`. Also locks keys without a row
  3. Reads the `Direct` channel rows the user is in again. When there is a row with a key not locked in step 2, changes nothing and returns `FAILED`. The caller rolls back the transaction
  4. Deletes the message rows the user sent, and the channel rows, message rows and `chat_deletion` rows of the `Direct` channels read again
- The lock in step 2 uses the same key as the channel row lock in step 6 of `SendChatMessage`. So a friend's first `Direct` message either commits before the withdrawal and is deleted in step 4, or comes after the withdrawal's commit and is `USER_NOT_FOUND` because `is_active_user` is `false`
- Message rows deleted by `remove_user` leave no `chat_deletion` row, so they do not appear in `deleted_seqs` of `GetChatMessages`

### admin

- `list_chat_messages` and `delete_chat_message` run in a game tx opened with `storage.run_game_transaction`. `list_chat_messages` also returns deleted messages with `deleted`, and the rule for `limit` is the body rules of `admin-api`. A row is an object keyed by column name, and `kind` is the value of input `channel_kind` (`World`, `Guild`, `Direct`)
- `delete_chat_message` locks the channel row with `storage.lock_game_row`, then reads the message row and runs message deletion. `not_found` when there is no row; when the message is already deleted, success without changing anything
- `mute_chat_user` writes nothing and returns `bad_request` when `until_at` is less than 0. Otherwise it writes the target user's mute row with `until_at`, `reason` and `muted_at`(request time). `unmute_chat_user` deletes the mute row

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `in_app_messages` | chat message | `module` | `app_functionality` | `true` | `false` | `false` | `true` | `all` | `none` |

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `validate_chat_send`(validation hook) | `SendChatMessage` step 5 | ctx, `ChatChannelKind`, channel ID, `ChatMessageKind`, `text` | `pass` or `GameError` | `pass` |
| `on_chat_message_sent`(after hook) | `SendChatMessage` step 8 | ctx, the written `ChatMessage` | none | does nothing |

- `validate_chat_send` judges content's spam blocking and send conditions. e.g. repeats of the same text, a level condition
- `on_chat_message_sent` does content's notifications and aggregation. e.g. `push.queue_push` to the `Direct` other user, the caller's `mission.add_progress`
- `post_system_message` does not call the two hooks

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation, channel resolution violation, `DeleteGuildChatMessage` when `guild` is not in the server module list, non-zero `after_seq` and `before_seq`, `RoomInvite` format violation, `message_kind` that is `System` or `_UNSPECIFIED`, report of the caller's own message or a `System` message | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| `Direct` other user that does not exist or is a withdrawn user | `USER_NOT_FOUND` | `USER_NOT_FOUND` | none |
| block with the `Direct` other user | `BLOCKED` | `BLOCKED` | none |
| `Direct` other user is not a friend | `CHAT_NOT_FRIEND` | `CHAT_NOT_FRIEND` | none |
| not a guild member of the `Guild` channel, `DeleteGuildChatMessage` by a user who is not a guild member | `GUILD_NOT_MEMBER` | `GUILD_NOT_MEMBER` | none |
| chat core rpc of a child user when `chat.allowChild` is `false` | `CHILD_RESTRICTED` | `CHILD_RESTRICTED` | none |
| muted | `CHAT_MUTED` | `CHAT_MUTED` | none |
| within the send interval | `CHAT_TOO_FAST` | `CHAT_TOO_FAST` | none |
| plain text violation of `text` | `TEXT_INVALID` | `TEXT_INVALID` | none |
| banned word in `text` | `TEXT_BANNED` | `TEXT_BANNED` | `info` log. ID value of the matched `banned_word` |
| rejection by hook `validate_chat_send` | `GameError` of the hook | `GameError` of the hook | none |
| the message to report or delete does not exist | `CHAT_MESSAGE_NOT_FOUND` | `CHAT_MESSAGE_NOT_FOUND` | none |
| role in `DeleteGuildChatMessage` is not `Leader` or `Officer` | `GUILD_PERMISSION` | `GUILD_PERMISSION` | none |
| channel or `text` violation of `post_system_message` | none. Writes nothing | content decides | `error` log |
| report count limit | `REPORT_LIMIT` | `REPORT_LIMIT` | log of `block-report` |
| lock wait timeout on a channel row or guild row outside `post_system_message` and `remove_user` | `FAILED` | `INTERNAL` | `routing` writes an `error` log |
| lock wait timeout on a channel row in `remove_user`, `remove_user` did not lock the key of a `Direct` channel row it read again | `FAILED` | the caller decides | none |
| lock wait timeout on a channel row or guild row in `post_system_message` | throw | `INTERNAL` | `routing` writes an `error` log |
| `delete_chat_message` of a message that does not exist | `not_found` | none | `audit` |
| `mute_chat_user` with `until_at` less than 0 | `bad_request` | none | `audit` |
| body rules violation of `list_chat_messages`; `mute_chat_user` or `unmute_chat_user` of a user that does not exist or a withdrawn user | `bad_request`, `not_found` | none | error rules of `admin-api` |

Added `CoreError`: `CHAT_MUTED`, `CHAT_TOO_FAST`, `CHAT_NOT_FRIEND`, `CHAT_MESSAGE_NOT_FOUND`, `CHILD_RESTRICTED`. `friend.SearchUsers` also uses `CHILD_RESTRICTED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `chat.worldChannelCount` | integer | core | content | number of world channels. 0 or more. When 0, there is no world chat |
| `chat.maxTextLength` | integer | core | content | maximum code point count of a `Text` message |
| `chat.minIntervalMs` | integer | core | content | minimum interval between messages one user sends |
| `chat.maxFetchCount` | integer | core | content | number of messages one `GetChatMessages` selects |
| `chat.pollIntervalMs` | integer | core | content | `poll_after_ms` of `GetChatMessages` |
| `chat.retentionMs` | integer | core | content | duration a message is kept after it is sent |
| `chat.allowChild` | boolean | core | content | whether a user whose `child` of `ConsentUserState` is `true` uses chat core rpcs and `friend.SearchUsers`. When `false`, `CHILD_RESTRICTED` |
| `chat.maxChannelListCount` | integer | core | content | limit on the number of `Direct` items `GetChatChannels` returns |
| `chat.channelPollIntervalMs` | integer | core | content | `poll_after_ms` of `GetChatChannels` |
| `chat.maxSystemTextBytes` | integer | core | content | maximum UTF-8 bytes of a `System` message `text` |
| `nickname.maxLookupCount` | integer | core | content | number of users passed to one `get_nicknames` call |
| `matchmaker.roomCodeLength` | integer | core | content | length of a `RoomInvite` `text` |
| `matchmaker.roomCodeAlphabet` | string | core | content | character set used in a `RoomInvite` `text` |
| `block-report.maxEvidenceBytes` | integer | core | content | upper bound of `chat.maxTextLength` × 4 |

settings constraint

| left | factor | right |
|---|---|---|
| `chat.maxTextLength` | 4 | `block-report.maxEvidenceBytes` |
| `matchmaker.roomCodeLength` | 1 | `chat.maxTextLength` |

## data

used table: `banned_word`, `report_reason`. `banned_word` is a table of `validation`, and `report_reason` is a table of `block-report`

## DEV

none

## test

- A message sent to a `World` channel arrives in `GetChatMessages` of the same channel in ascending order of seq, and `last_seq` is the largest seq
- When the sender's nickname changes with `SetNickname` or `rename_user` after the message is sent, the `sender_nickname` of that message in `GetChatMessages` is the new nickname. The `sender_nickname` of a `System` message is the empty string
- `after_seq` 0 returns the latest `chat.maxFetchCount` messages, and `after_seq` n returns only seqs greater than n
- A channel number outside `chat.worldChannelCount` and a non-zero `Guild` `channel_key` are `INVALID_REQUEST`
- Send and receive on a `Guild` channel by a user who is not a guild member are `GUILD_NOT_MEMBER`, and a member's message is only in that guild channel
- `Direct` to a user who is not a friend is `CHAT_NOT_FRIEND`, to a user in a block relation `BLOCKED`, and to a withdrawn user `USER_NOT_FOUND`. `Direct` messages between two users arrive in `GetChatMessages` of both, and `channel_key` is each one's other user's ID
- Messages of a user the caller blocked are not in `GetChatMessages`, and `last_seq` goes up to the seq of those messages
- Text containing a banned word is `TEXT_BANNED`, text containing a line break is `TEXT_INVALID`, and there is no message row
- A second send within `chat.minIntervalMs` is `CHAT_TOO_FAST`
- After `mute_chat_user`, a send is `CHAT_MUTED`, and after `until_at` passes or after `unmute_chat_user`, it sends
- `mute_chat_user` with `until_at` less than 0 is `bad_request`, there is no mute row, and that user's send is handled
- When two users send to the same channel concurrently, their seqs do not overlap
- A room code format violation of `RoomInvite` and a `RoomInvite` on a `World` channel are `INVALID_REQUEST`
- On a test server without `guild` in the server module list, send, receive and report on a `Guild` channel and `DeleteGuildChatMessage` are `INVALID_REQUEST`, `GetChatChannels` has no guild item, `post_system_message` on a `Guild` channel returns none with an `error` log, and `World` channels are handled
- On a test server without `friend` in the server module list, send, receive and report on a `Direct` channel are `INVALID_REQUEST`, `GetChatChannels` has no `Direct` item, and `World` channels are handled
- `ReportChatMessage` makes one report with the message's text as evidence; the caller's own message is `INVALID_REQUEST`, and a seq that does not exist is `CHAT_MESSAGE_NOT_FOUND`
- After `delete_chat_message`, the message is not in `GetChatMessages` and is in `list_chat_messages` with `deleted` `true`
- A message whose `chat.retentionMs` has passed is not in `GetChatMessages` and is deleted by the expiry cleanup
- After `Withdraw`, the messages that user sent and that user's `Direct` channels are gone
- A `SendChatMessage` sent while the other user's `Withdraw` holds the lock on the `Direct` channel row is `USER_NOT_FOUND` after that `Withdraw` commits, and after that there is no `Direct` channel row or message row whose key contains the withdrawn user
- Between friends without a `Direct` channel row, when one user's `Withdraw` and the friend's first `SendChatMessage` to that user arrive concurrently, after both end there is no `Direct` channel row or message row whose key contains the withdrawn user, and `SendChatMessage` is a success or `USER_NOT_FOUND`
- In step 1 of a `Direct` `SendChatMessage` to a friend, when that friend's `Withdraw` commits after `is_active_user` is read and before `are_friends` is read, the result is `USER_NOT_FOUND`
- After the `Withdraw` of a user who sent a message to a `World` channel, the seq of that message is not in `messages` or `deleted_seqs` of a `GetChatMessages` another user sends with a non-zero `after_seq`
- When `chat.allowChild` is `false`, `GetChatChannels`, `GetChatMessages`, `SendChatMessage`, `ReportChatMessage` and `DeleteGuildChatMessage` of a `child` user are `CHILD_RESTRICTED`, and no message row, report or deletion is made. When `true`, they are handled. A user without a `ConsentUserState` row is handled. `post_system_message` called in that user's ctx writes the message
- `before_seq` n selects `chat.maxFetchCount` seqs less than n from the largest and returns them in ascending order of seq; `first_seq` is the smallest of them, and 0 when no row is selected. A non-zero `after_seq` and `before_seq` together are `INVALID_REQUEST`
- The `channel_key` of the `GetChatMessages` response for a `Guild` channel is the guild ID
- After `delete_chat_message` and `DeleteGuildChatMessage`, the seq appears once in `deleted_seqs` of a `GetChatMessages` with a non-zero `after_seq`, and `last_delete_seq` has increased by 1. The `deleted_seqs` of a request with `after_seq` 0 is empty and `last_delete_seq` is the value of the channel row
- `GetChatChannels` returns the caller's guild item first, then `chat.maxChannelListCount` `Direct` items in descending order of `last_at`, leaving out channels with a user the caller blocked and channels where `chat.retentionMs` has passed since the last message. The `last_seq` and `last_at` of an item are the seq and `created_at` of the last message, and the `profile` of a `Direct` item is the other user's profile
- When `validate_chat_send` returns `GameError`, the result is that error and the message rows and `last_sent_at` stay as they are. `on_chat_message_sent` is called once with the sent message
- The `last_visible_seq` of a `GetChatChannels` item is the largest seq after leaving out messages of users the caller blocked, deleted messages and messages whose `chat.retentionMs` has passed, and 0 when there are only such messages. `last_seq` is the largest seq including those messages
- `DeleteGuildChatMessage` is `GUILD_PERMISSION` for a `Member`, `GUILD_NOT_MEMBER` for a user who is not a guild member, and `CHAT_MESSAGE_NOT_FOUND` for an already deleted message
- `post_system_message` writes a `System` message with `sender_id` 0 at the next seq, also in the ctx of a muted user. A `Direct` channel, an out-of-range `World` channel, a guild that does not exist, an empty `text` and a `text` more than `chat.maxSystemTextBytes` return none with an `error` log and leave no row. `System` in `SendChatMessage` and `ReportChatMessage` of a `System` message are `INVALID_REQUEST`
- When a lock wait timeout happens while another transaction holds the lock on the guild row, `post_system_message` on a `Guild` channel throws, the request is `INTERNAL`, and there is no message row
- `SendChatMessage` on a `Guild` channel locks the guild row before the channel row. A `SendChatMessage` sent while another transaction holds that guild row with `lock_guild` waits until that commit, and when that transaction kicked the sender, it is `GUILD_NOT_MEMBER` and there is no message row. While `on_chat_message_sent` calls `lock_guild` of the same guild, `post_system_message` and `DeleteGuildChatMessage` of the same guild arriving at the same time all finish
