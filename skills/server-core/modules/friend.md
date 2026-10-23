# friend

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

Handles friend relations between users (request, accept, decline, cancel, remove), the friend list, and finding users by nickname. Content makes gifts and rewards sent to friends with user changes of `storage`.

## dependency

- `storage`
- `server-time`
- `logging`
- `nickname`
- `public-profile`
- `block-report`

## API

core `rpc`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SendFriendRequest` (core rpc, `retry`). changes: `content` | `user_id` | `state`: `FriendState` with that user after handling | `INVALID_REQUEST`, `USER_NOT_FOUND`, `BLOCKED`, `FRIEND_ALREADY`, `FRIEND_LIMIT`, `FRIEND_TARGET_LIMIT`, `FRIEND_REQUEST_LIMIT` | `routing`. client content code sends it |
| `AcceptFriendRequest` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `FRIEND_REQUEST_NOT_FOUND`, `FRIEND_LIMIT`, `FRIEND_TARGET_LIMIT` | `routing`. client content code sends it |
| `DeclineFriendRequest` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `FRIEND_REQUEST_NOT_FOUND` | `routing`. client content code sends it |
| `CancelFriendRequest` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `FRIEND_REQUEST_NOT_FOUND` | `routing`. client content code sends it |
| `RemoveFriend` (core rpc, `retry`). changes: `content` | `user_id` | empty response | `INVALID_REQUEST`, `FRIEND_NOT_FOUND` | `routing`. client content code sends it |
| `GetFriends` (core rpc, `silent`). changes: none | none | `friends`: list of `FriendEntry` | none | `routing`. client content code sends it |
| `SearchUsers` (core rpc). changes: none | `nickname` | `users`: list of `PublicProfileEntry` | `INVALID_REQUEST`, `CHILD_RESTRICTED` | `routing`. client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SendFriendRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `AcceptFriendRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `DeclineFriendRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `CancelFriendRequestRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `RemoveFriendRequest` | `user_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `SearchUsersRequest` | `nickname` | `string` | `max_chars_key`: `nickname.maxLength` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `SendFriendRequestResponse` | `state` | `FriendState` |
| `GetFriendsResponse` | `friends` | `repeated FriendEntry` |
| `SearchUsersResponse` | `users` | `repeated PublicProfileEntry` |

internal operation

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `are_friends` | ctx, two user IDs | `true` when they are friends | `false` | content handler, hook, `chat` |
| `list_friend_ids` | ctx, user ID | list of the friend user IDs of that user. Ascending order | empty list | content handler, hook, `chat` |
| `remove_user` | ctx | none | `FAILED` | `auth`(`Withdraw`, `withdraw_user`, web account deletion, `ConfirmAge` under the minimum age, job `auth_guest_sweep`) |

- `FriendState`(base proto enum): `Friend`, `Sent`(request the caller sent), `Received`(request the caller received)
- `FriendEntry`(base proto message): `PublicProfileEntry profile`, `FriendState state`, `int64 updated_at`

## behavior

### tables

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `friend_link` | `game` | `user_id`, `other_id`, `state`(`FriendState` element name), `created_at`, `updated_at` | `(user_id, other_id)` | none |
| `friend_count` | `game` | `user_id`, `friend_count`, `sent_count`, `received_count` | `user_id` | none |

- Both tables are registered with `storage.register_table` with personal data user column `user_id`. The scope is `game` because one transaction changes rows of two users
- The relation of two users A and B is two link rows. `(A, B)` is the `FriendState` A sees, and `(B, A)` is the `FriendState` B sees. The state pair of the two rows is (`Sent`, `Received`) or (`Friend`, `Friend`), and the two rows are written and deleted together in the same transaction
- `created_at` is the request time of the first request, and `updated_at` is the request time at which the state last changed
- When there is no count row, all three counts are 0
- Handling that changes the relation of two users first locks the `friend_count` rows of the two users with `storage.lock_game_row`, smaller user ID first, and then reads the link rows

### request

`SendFriendRequest` processing order. A failure changes nothing.

1. `INVALID_REQUEST` when `user_id` is the caller's own
2. Locks the two count rows and reads the `(caller, target)` link row
3. `USER_NOT_FOUND` when `public-profile.is_active_user` is `false`
4. `BLOCKED` when `block-report.is_blocked_either` is `true`
5. `FRIEND_ALREADY` when the state is `Friend`. When it is `Sent`, success with `Sent` without changing anything
6. When the state is `Received`, runs steps 2 to 5 of `AcceptFriendRequest` and succeeds with `Friend`
7. `FRIEND_LIMIT` when the caller's `friend_count` ≥ `friend.maxFriends`. `FRIEND_REQUEST_LIMIT` when the caller's `sent_count` ≥ `friend.maxSentRequests`. `FRIEND_TARGET_LIMIT` when the target's `friend_count` ≥ `friend.maxFriends` or the target's `received_count` ≥ `friend.maxReceivedRequests`
8. Writes a `Sent` row at `(caller, target)` and a `Received` row at `(target, caller)`, and increases the caller's `sent_count` and the target's `received_count` by 1. Success with `Sent`

`AcceptFriendRequest` processing order. A failure changes nothing.

1. Locks the two count rows and reads the `(caller, target)` link row. `FRIEND_REQUEST_NOT_FOUND` when the state is not `Received`
2. `FRIEND_LIMIT` when the caller's `friend_count` ≥ `friend.maxFriends`
3. `FRIEND_TARGET_LIMIT` when the target's `friend_count` ≥ `friend.maxFriends`
4. Changes the state of both rows to `Friend` and their `updated_at` to the request time
5. Decreases the caller's `received_count` and the target's `sent_count` by 1, and increases both `friend_count` by 1

- `DeclineFriendRequest`: locks the two count rows; `FRIEND_REQUEST_NOT_FOUND` when `(caller, target)` is not `Received`. Deletes the two rows and decreases the caller's `received_count` and the target's `sent_count` by 1
- `CancelFriendRequest`: locks the two count rows; `FRIEND_REQUEST_NOT_FOUND` when `(caller, target)` is not `Sent`. Deletes the two rows and decreases the caller's `sent_count` and the target's `received_count` by 1
- `RemoveFriend`: locks the two count rows; `FRIEND_NOT_FOUND` when `(caller, target)` is not `Friend`. Deletes the two rows and decreases both `friend_count` by 1
- block: at server start, registers a function with `block-report.register_block_listener`. The function locks the two count rows, deletes the link rows of the two users, and decreases the counts according to the deleted state. On a lock wait timeout on a count row, the function throws
- `remove_user` deletes the rows of an other user who is a withdrawn user. So `AcceptFriendRequest`, `DeclineFriendRequest`, `CancelFriendRequest` and `RemoveFriend` do not judge the target user. The caller's own `user_id` also has no link row, so it is `FRIEND_REQUEST_NOT_FOUND` or `FRIEND_NOT_FOUND`

### list and search

- `GetFriends` returns all of the caller's link rows in the order of state `Friend`, `Received`, `Sent`; within the same state, in descending order of `updated_at`, ties in ascending order of user ID. `profile` is filled with `public-profile.get_public_profiles`, and rows without a profile are left out
- `SearchUsers` is `CHILD_RESTRICTED` when `chat.allowChild` is `false` and `child` of that user's `ConsentUserState`(owner `auth`) read with `storage.get_state` is `true`. Otherwise, from the users that `nickname.find_user_ids_by_nickname`(ctx, `nickname`, `nickname.maxLookupCount`) returned, it leaves out the caller and users for which `block-report.is_blocked_either` is `true`, and returns up to `friend.maxSearchResults` users in ascending order of user ID with `get_public_profiles`
- `are_friends` and `list_friend_ids` read link rows with `storage.db`(ctx) and write nothing

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `gameplay_content` | friend relations | `module` | `app_functionality` | `true` | `false` | `false` | `true` | `all` | `none` |

### withdrawal

- `remove_user` runs in the order below. `FAILED` on a lock wait timeout
  1. Reads the user's link rows to get the list of other users
  2. Locks the `friend_count` rows of the user and of all the other users in ascending order of user ID
  3. Reads the user's link rows again. When there is an other user not locked in step 2, changes nothing and returns `FAILED`. The caller rolls back the transaction
  4. Deletes all link rows read again, decreases each other user's counts according to the deleted state, and deletes the user's count row

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `on_friend_changed`(after hook) | after a `FriendChange` change | ctx, other user ID, `FriendChange` | none | does nothing |

- `FriendChange`: `Requested`(sent a request in step 8 of `SendFriendRequest`), `Accepted`(accepted a received request in `AcceptFriendRequest` or in step 6 of `SendFriendRequest`), `Declined`(`DeclineFriendRequest`), `Canceled`(`CancelFriendRequest`), `Removed`(`RemoveFriend`)
- The hook is called once after the change, inside the transaction that made the change. It is not called for a `SendFriendRequest` that changed nothing (already `Sent`), for relations deleted by a block, or for `remove_user`
- ctx is the ctx of the user who sent the rpc. The hook sends changes to the other user's UserState with `storage.send_user_change`
- Examples of what the hook does: `push.queue_push` to the other user, the caller's `mission.add_progress`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `(ogw.v)` violation, own `user_id` in `SendFriendRequest` | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| target that does not exist or is a withdrawn user | `USER_NOT_FOUND` | `USER_NOT_FOUND` | none |
| block between the two users | `BLOCKED` | `BLOCKED` | none |
| already friends | `FRIEND_ALREADY` | `FRIEND_ALREADY` | none |
| no received or sent request | `FRIEND_REQUEST_NOT_FOUND` | `FRIEND_REQUEST_NOT_FOUND` | none |
| not friends | `FRIEND_NOT_FOUND` | `FRIEND_NOT_FOUND` | none |
| the caller's friend count limit | `FRIEND_LIMIT` | `FRIEND_LIMIT` | none |
| the target's friend count or received request count limit | `FRIEND_TARGET_LIMIT` | `FRIEND_TARGET_LIMIT` | none |
| the caller's sent request count limit | `FRIEND_REQUEST_LIMIT` | `FRIEND_REQUEST_LIMIT` | none |
| `SearchUsers` of a child user when `chat.allowChild` is `false` | `CHILD_RESTRICTED` | `CHILD_RESTRICTED` | none |
| lock wait timeout on a count row in a core rpc | `FAILED` | `INTERNAL` | `routing` writes an `error` log |
| lock wait timeout on a count row in `remove_user`, a link row that `remove_user` read again has an other user that was not locked | `FAILED` | the caller decides | none |
| lock wait timeout on a count row in the block listener function | throw | `INTERNAL` | `routing` writes an `error` log |

Added `CoreError`: `FRIEND_ALREADY`, `FRIEND_REQUEST_NOT_FOUND`, `FRIEND_NOT_FOUND`, `FRIEND_LIMIT`, `FRIEND_TARGET_LIMIT`, `FRIEND_REQUEST_LIMIT`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `friend.maxFriends` | integer | core | content | friend count limit per user |
| `friend.maxSentRequests` | integer | core | content | limit on the number of sent requests one user has waiting for a response |
| `friend.maxReceivedRequests` | integer | core | content | limit on the number of received requests one user has not answered |
| `friend.maxSearchResults` | integer | core | content | limit on the number of users `SearchUsers` returns |
| `nickname.maxLength` | integer | core | content | maximum code point count of `SearchUsersRequest.nickname` |
| `nickname.maxLookupCount` | integer | core | content | maximum count passed to `find_user_ids_by_nickname` |
| `chat.allowChild` | boolean | core | content | when `false`, `SearchUsers` of a user whose `child` of `ConsentUserState` is `true` is `CHILD_RESTRICTED` |

## data

none

## DEV

none

## test

- When A requests B, A is `Sent` and B is `Received`; when B accepts, both are `Friend`, both users' `friend_count` is 1, and their `sent_count` and `received_count` are 0
- While B has a request to A, A's `SendFriendRequest` returns `Friend`
- Decline, cancel and remove delete the two link rows and return the counts to their values before handling
- A request sent twice to the same target is `Sent`, and the link rows and counts stay as they are
- A `SendFriendRequest` the caller sends to itself, and `AcceptFriendRequest`, `DeclineFriendRequest`, `CancelFriendRequest` and `RemoveFriend` with `user_id` 0 are `INVALID_REQUEST`, and the link rows and counts stay as they are
- On reaching each limit, the result is `FRIEND_LIMIT`, `FRIEND_TARGET_LIMIT` or `FRIEND_REQUEST_LIMIT`, and nothing changes
- A request between two users where one has blocked the other is `BLOCKED`. When `BlockUser` is done between friends, the two link rows are gone and both `friend_count` decrease by 1
- When two users request each other concurrently, after both end both link rows are `Friend`
- When two other users concurrently accept two requests sent by a user whose friend count is `friend.maxFriends` − 1, only one succeeds and the other is `FRIEND_TARGET_LIMIT`
- `GetFriends` is in the order `Friend`, `Received`, `Sent`, and rows of the same state are in descending order of `updated_at`
- `SearchUsers` leaves out the caller and users in a block relation, and returns at most `friend.maxSearchResults` users
- When `chat.allowChild` is `false`, `SearchUsers` of a `child` user is `CHILD_RESTRICTED`, and when it is `true`, it returns the result
- After `Withdraw`, that user's link rows are gone, and the relations with that user are removed from the other users' counts
- When `BlockUser` and `SendFriendRequest` between the same two users arrive concurrently, after both end there is no link row between the two users, and the counts of the two users equal their numbers of link rows
- When the target user's `Withdraw` and a `SendFriendRequest` to that user arrive concurrently, after both end there is no link row that contains the withdrawn user, and the sender's `sent_count` equals the number of the sender's `Sent` link rows
- For each request, accept, decline, cancel and remove, `on_friend_changed` is called once with that `FriendChange`, and for a `SendFriendRequest` to another user from whom a request was received, it is called once with `Accepted`. It is not called for a `SendFriendRequest` to a user already in `Sent`, for `BlockUser` or for `Withdraw`
- When `on_friend_changed` throws, the result is `INTERNAL`, and the link rows and counts are the values before handling
- When a lock wait timeout happens while another transaction holds the lock on the other user's `friend_count` row, the `Withdraw` of a user who is friends with that other user is `INTERNAL`, and that user's link rows, counts and `withdrawn_at` are the values before handling. At the same time, `BlockUser` targeting that other user is `INTERNAL`, and the block row and link rows are the values before handling
