# ChatCore

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

Receives and caches the channel list and messages of server core `chat`, and sends messages. Keeps a read seq per channel and reports the unread count through `BadgeCore`.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `NetworkCore`, `BadgeCore`

- server dependency: `chat`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `start` | none | none | none | `BootstrapCore`(`AfterLogin` stage) |
| `refresh_channels` | none | async operation. success flag | `false` | content code |
| `get_channel_count` | none | number of items in the last received channel list | 0 | content code |
| `get_channel` | index | `CoreContract.ChatChannelEntry` | none | content code |
| `get_unread_count` | `ChatChannelKind`, channel key | unread count | 0 | content code |
| `mark_read` | `ChatChannelKind`, channel key | none | none | content code |
| `watch_channel` | `ChatChannelKind`, channel key | success flag | `false` | content code |
| `unwatch_channel` | `ChatChannelKind`, channel key | none | none | content code |
| `get_message_count` | `ChatChannelKind`, channel key | number of messages in the cache | 0 | content code |
| `get_message` | `ChatChannelKind`, channel key, index | `CoreContract.ChatMessage` | none | content code |
| `has_older` | `ChatChannelKind`, channel key | whether older messages can be received | `false` | content code |
| `load_older` | `ChatChannelKind`, channel key | async operation. success flag | `false` | content code |
| `send_message` | `ChatChannelKind`, channel key, `ChatMessageKind`, text | async operation. `ChatSendResult` | `ChatSendResult` with success flag `false` | content code |

### type

| type | contents |
|---|---|
| `CoreContract.ChatMessage`, `CoreContract.ChatChannelEntry` | base proto message that server core `chat` defines |
| `ChatChannelKind`, `ChatMessageKind` | base proto enum that server core `chat` defines |
| channel key | the request `channel_key` of server core `chat`. The channel number for `World`, 0 for `Guild`, the other user's ID for `Direct` |
| `ChatSendResult` | success flag, the sent `CoreContract.ChatMessage`(none on failure), error code(the error code when `RequestFailure` of `NetworkCore` is `ServerError`, otherwise 0) |
| `ChatMessagesChange` | `Reset`(replaced the whole cache), `Appended`(added at the end), `Prepended`(added at the front), `Removed`(deleted) |

- `channel_key` of a channel list item is the channel ID of server core `chat`, so for a `Guild` item it is the guild ID. When that item is passed to an operation, the channel key is 0
- Messages in the cache are in ascending seq order and the index starts at 0

## behavior

### channel list

- `start` starts channel list polling and read seq management. At the start it reads `ChatCore.read_seqs` and `ChatCore.read_initialized` from the `user` file of `LocalDataCore`
- channel list polling: sends core `rpc` `GetChatChannels` with `NetworkCore.send`. It waits, in real elapsed time, `poll_after_ms` of the response on success or `ChatCore.failureRetryMs` on failure, then sends again. There is always at most one `GetChatChannels` being sent
- `refresh_channels` ends the wait, sends at once and returns that result. When one is being sent, it does not send a new one and waits for that result together. Before `start`, it is `false`
- On `AppForegroundReturnedEvent`, it ends the waits of the channel list and of the watched channels and sends at once. During background, real elapsed time does not increase, so it does not send
- On success it replaces the whole channel list with `channels` of the response. When it differs from the previous list (item count, or any field of the item at the same index differs), it emits `ChatChannelsChangedEvent`
- When `GetChatChannels` fails with `ServerError` `CHILD_RESTRICTED`, it stops channel list polling and all message polling and does not send again until `release`. The channel count is 0. When the list changed, it emits `ChatChannelsChangedEvent`; it does not change read seqs. After that, `refresh_channels`, `watch_channel`, `load_older` send nothing and are `false`, and `send_message` sends nothing and is a failed `ChatSendResult` with error code `CHILD_RESTRICTED`. These calls leave no log

### read seq and badge

- read seq: the last seq read, per channel. The key is `ChatChannelKind` and the channel ID of server core `chat`(the guild ID for `Guild`). A `World` channel has no read seq
- When it receives the channel list, it sets read seqs in the order below
  1. When `ChatCore.read_initialized` is `false`, set the read seq of each received item to its `last_seq` and write `ChatCore.read_initialized` as `true`
  2. Set an item without a read seq to its `last_seq` for `Guild` and to 0 for `Direct`
- It does not delete the read seq of a channel that is not in the received list. When a channel that the server left out of the list (an old channel, a channel beyond the list count, a channel with a blocked user) appears again, it counts unread with that read seq
- Times when a read seq is raised. A read seq does not decrease
  - When a watched channel receives messages: to the largest seq of the cache
  - `mark_read`: to the larger of `last_seq` of that item in the channel list and the largest seq of the cache
  - `send_message` success: to the seq of the sent message
- unread count = max(0, `last_visible_seq` of the list item − read seq). It is 0 for a channel not in the list and for a `World` channel
- badge: under the badge of reserved ID `[chat_badge]`, for each item with an unread count of 1 or more, it sets `BadgeCore.set_item`(badge, item key, unread count). It deletes other items with `BadgeCore.clear_item`. The item key is the other user's ID for `Direct` and −1 for `Guild`. It updates them at the end of a frame in which a read seq or the channel list changed
- At the end of a frame in which a read seq changed, it saves `ChatCore.read_seqs`. The element per channel is `<ChatChannelKind element name>:<channel key>=<read seq>`, with channel key and read seq as decimal integers. When reading, it leaves a warn log for an element with a wrong format and discards it

### watch

- `watch_channel` puts that channel in the watch list and sends the first request at once. When it is already watched, it does nothing and is `true`. When the number of watched channels is `ChatCore.maxWatchedChannels`, it is `false`. Content code watches only channels shown on screen
- Each channel has a new message cursor, an old message cursor and a deleted message cursor. All are 0 at first. A `Guild` channel also keeps the last received guild ID
- first request: `GetChatMessages`(`after_seq` 0, `before_seq` 0, `after_delete_seq` 0). On success it replaces the cache with `messages`, sets the new message cursor to `last_seq`, the old message cursor to `first_seq`, the deleted message cursor to `last_delete_seq` and the guild ID of a `Guild` channel to `channel_key`, and emits `ChatMessagesChangedEvent`(`Reset`, message count)
- poll: the next `GetChatMessages` of a watched channel. It waits, in real elapsed time, `poll_after_ms` when the previous request succeeded or `ChatCore.failureRetryMs` when it failed, then sends. When the first request has not succeeded, it sends the first request again; otherwise it sends `GetChatMessages`(`after_seq` = new message cursor, `before_seq` 0, `after_delete_seq` = deleted message cursor)
- poll success processing order
  1. For a `Guild` channel whose response `channel_key` differs from the kept guild ID, discard the response, return the cache and cursors to their initial state, emit `ChatMessagesChangedEvent`(`Reset`, 0), then send the first request at once
  2. Delete the seqs of `deleted_seqs` from the cache. When the deleted count is 1 or more, `ChatMessagesChangedEvent`(`Removed`, deleted count)
  3. Append, in ascending seq order, the messages of `messages` whose seq is larger than the largest seq of the cache. When the added count is 1 or more, `ChatMessagesChangedEvent`(`Appended`, added count)
  4. When the new message cursor was 0, set the old message cursor to `first_seq`. Set the new message cursor to `last_seq` and the deleted message cursor to `last_delete_seq`
- When a request of a `Guild` channel ends with `GUILD_NOT_MEMBER`, it returns the cache and cursors to their initial state. When the cache had messages, it emits `ChatMessagesChangedEvent`(`Reset`, 0)
- `unwatch_channel` removes that channel from the watch list and deletes its cache and cursors. It discards the result of a request in progress and emits no event

### older messages

- `has_older` is `true` when the channel is watched and the old message cursor is more than 1
- `load_older`: `false` when the channel is not watched. When `has_older` is `false`, it sends nothing and is `true`. Otherwise it sends `GetChatMessages`(`after_seq` 0, `before_seq` = old message cursor, `after_delete_seq` 0). When a `load_older` is in progress, it does not send a new one and waits for that result together
- On success it prepends, in ascending seq order, the messages of `messages` whose seq is smaller than the smallest seq of the cache, and sets the old message cursor to `first_seq`. When the added count is 1 or more, it emits `ChatMessagesChangedEvent`(`Prepended`, added count). When `channel_key` of a `Guild` channel differs from the kept guild ID, it discards the response and is `false`
- On failure it leaves the cache and cursors as they are and is `false`

### send

- `send_message` sends core `rpc` `SendChatMessage` with `NetworkCore.send`. The failure callback returns `false`, so the default handling of `NetworkCore` applies
- On success it raises the read seq, and when that channel is watched, it ends the poll wait and sends at once. The sent message is not put in the cache directly; it is received by the poll
- It also sends to a channel that is not watched

### release

- Stops polling and ends `refresh_channels`, `load_older`, `send_message` in progress as failures. Deletes the channel list, watch list, cache, cursors and the read seqs in memory, and returns to the state before `start`. It does not delete the saved `ChatCore.read_seqs`, `ChatCore.read_initialized`

## hook

none

## event

| event | when | payload |
|---|---|---|
| `ChatChannelsChangedEvent` | After the list changes through channel list polling or `refresh_channels` | none. Read the new list with `get_channel` |
| `ChatMessagesChangedEvent` | After the cache of a watched channel changes | `ChatChannelKind`, channel key, `ChatMessagesChange`, number of changed messages |

- Content code calls `UIScrollList.set_items` of `UICore` for `Reset` and `Removed`, `append_items` for `Appended`, and `prepend_items` for `Prepended`

## error

| condition | failure value | log |
|---|---|---|
| `watch_channel`, `send_message` before `start` | each failure value | error |
| `start` called twice | ignored | warn |
| `_UNSPECIFIED` kind, channel key that does not fit the kind(less than 1 for `World`, not 0 for `Guild`, less than 1 for `Direct`) | each failure value | error |
| `watch_channel` at the watch count limit | `false` | warn |
| `load_older`, `get_message` of a channel that is not watched | each failure value | warn |
| `get_message`, `get_channel` with an index out of range | none | warn |
| `GetChatChannels`, `GetChatMessages`, `SendChatMessage` failure | each failure value. Polling waits, then sends again | `NetworkCore` leaves it |
| `GetChatChannels` fails with `CHILD_RESTRICTED` | channel count 0. Sends no `GetChatChannels`, `GetChatMessages`, `SendChatMessage` until `release` | `NetworkCore` leaves it |
| `[chat_badge]` is not in the `badge` table | sets no badge | error once until `release` |
| `ChatCore.read_seqs` element with a wrong format | discards that element | warn |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `ChatCore.maxWatchedChannels` | integer | core | content | limit on the number of channels watched concurrently |
| `ChatCore.failureRetryMs` | integer | core | content | real elapsed time waited after a request fails before sending again |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `user` | `ChatCore.read_seqs` | `array<string>` | read seq per channel |
| `user` | `ChatCore.read_initialized` | `bool` | whether read seqs were set from the first channel list |

reserved ID

| name | used by |
|---|---|
| `[chat_badge]` | → row of `badge`. Channel items with unread go under this badge |

- `persist` of the `badge` row that `[chat_badge]` points to is `false` and `display` is `Count`. A violation is data check `out_of_range`

## DEV

none

## test

- After `start`, `GetChatChannels` is sent, and the next request is sent after `poll_after_ms` of the response has passed in real elapsed time. After a failure, it is after `ChatCore.failureRetryMs`. There is no request during background, and a request is sent right after the return to foreground. Two concurrent `refresh_channels` calls make one request
- For a user whose `ChatCore.read_initialized` is `false`, the first list has all unread 0 and `read_initialized` becomes `true`. After that, the unread of a newly appearing `Direct` item is `last_visible_seq` and that of a new `Guild` item is 0, and when `last_visible_seq` of that channel increases by 2, unread is 2. Even when `last_seq` increases, when `last_visible_seq` is at most the read seq, unread is 0 and there is no item of that channel under `[chat_badge]`
- For each item with unread 1 or more, there is an item with that count under `[chat_badge]`, and it is removed after `mark_read`. The item key of a `Guild` item is −1
- Read seqs are the same after `release`, `init`, `start`, the element of a channel dropped from the list stays in the saved value, and when that channel appears again, unread is counted with the remaining read seq
- After `watch_channel`, the messages of the first request are in the cache in ascending seq order and there is one `Reset` event. The next poll is sent with `after_seq` = previous `last_seq` and `after_delete_seq` = previous `last_delete_seq`, and adds only new messages with `Appended`. When a seq that is in the cache comes again, it is in the cache only once
- When a message appears after the first request of an empty channel, the next poll is sent with `after_seq` 0 and adds the received messages with `Appended`, and the old message cursor is that `first_seq`
- The messages of `deleted_seqs` are removed from the cache and the count of the `Removed` event is the deleted count
- `load_older` is sent with `before_seq` = old message cursor, prepends only smaller seqs and emits a `Prepended` event. When the old message cursor is 1 or 0, `has_older` is `false` and a `load_older` after that is `true` without a request. Two concurrent `load_older` calls make one request
- When a watched channel receives messages, the unread of that channel becomes 0
- After `send_message` succeeds, the poll of that channel is sent without waiting, and the sent message enters the cache once through the poll. When it ends with `CHAT_TOO_FAST`, the error code of `ChatSendResult` is that value
- When the response `channel_key` of a `Guild` channel changes, the first request is sent after `Reset`(0), and on `GUILD_NOT_MEMBER` the cache becomes empty
- After `unwatch_channel`, no request of that channel is sent and a response that was in progress emits no event. A `watch_channel` beyond `ChatCore.maxWatchedChannels` is `false`
- When `GetChatChannels` ends with `CHILD_RESTRICTED`, the channel count is 0, and after that no request is sent even when the polling wait passes or through `AppForegroundReturnedEvent`, `refresh_channels`, `watch_channel`, `load_older`, `send_message`. `refresh_channels`, `watch_channel`, `load_older` are `false` and the error code of `send_message` is `CHILD_RESTRICTED`. After `release`, `init`, `start`, `GetChatChannels` is sent again
- `load_older`, `send_message`, `refresh_channels` during `release` end as failures, and there is no request after that
