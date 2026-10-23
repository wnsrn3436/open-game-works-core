# nickname

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

Handles registration and change of a user's nickname. Judges the length and character rules, the banned word check, the duplicate ban, the change cooldown and the change cost, and takes the operator's forced change and user lookup by nickname.

## dependency

- `item-ledger`
- `validation`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SetNickname` (core rpc, `retry`). changes: `ItemBalanceUserState`, `NicknameUserState`, `content` | nickname string | saved nickname | `NICKNAME_INVALID`, `NICKNAME_BANNED`, `NICKNAME_TAKEN`, `NICKNAME_COOLDOWN`, `CoreError` of `item-ledger`, `GameError` of a hook | `routing`. Client content code sends it |
| `get_nicknames` | ctx, list of user IDs | list of `{user_id, nickname}` (user ID, nickname). Users without a nickname are left out; ascending order of user ID | empty list | content handler, hook, core module |
| `check_nickname` | nickname string | none | `NICKNAME_INVALID`, `NICKNAME_BANNED` | content handler |
| `find_user_ids_by_nickname` | ctx, nickname string, maximum count | list of user IDs chosen by nickname lookup. Ascending order of user ID, up to the maximum count | empty list when the input is an empty string or its code point count is more than `nickname.maxLength` | `friend` |

- The user ID list of `get_nicknames` has at most `nickname.maxLookupCount` items. With more, it throws

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SetNicknameRequest` | `nickname` | `string` | `max_chars_key`: `nickname.maxLength` |

core `rpc` response field

| message | field | type |
|---|---|---|
| `SetNicknameResponse` | `nickname` | `string` |

admin operation. `routing` collects them and passes them to `admin-api`; processing order, authentication, `operation_id` rules and the `audit` log follow `admin-api`.

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `rename_user` | `operation_id`, `user_id`, `nickname`, `reason` | empty object | `not_found`, `bad_request`, `conflict`, `internal` | operator |
| `find_user_by_nickname` | `nickname` | `users`: list of `{user_id, nickname}` | `bad_request` | operator |

- admin operation field type: `nickname` is `string`

## behavior

### rules

Checks one nickname in the order below. The check ends at the first step that fails.

1. Character rules. On violation, `NICKNAME_INVALID`
   - `validation.is_plain_text`(nickname, `nickname.maxLength`) is `true`
   - the code point count is `nickname.minLength` or more
   - every code point is one of: a character whose Unicode `Script` is in `nickname.allowedScripts`, an ASCII digit, a character of `nickname.allowedSymbols`, U+0020
   - two U+0020 do not come in a row
2. banned word. When `validation.check_text`(nickname, `nickname.maxLength`, line breaks not allowed) is `BANNED`, `NICKNAME_BANNED`
3. Duplicate. When game settings `nicknameUnique` is `true` and another user uses the normalized nickname, `NICKNAME_TAKEN`. When the normalized input equals the normalized value of that user's current nickname, this step is skipped

- `validation.normalize_text` does the normalization. Nicknames that differ only in full-width and half-width, letter case or spacing are equal after normalization
- The saved nickname is the input as it was before normalization
- `check_nickname` does only steps 1 to 2

### `SetNickname`

processing order. On failure, the nickname and the balance do not change.

1. When the input is the same string as the current nickname, nothing changes and the result is success
2. Rule check
3. When there is a current nickname and `changed_at` + `nickname.changeCooldownMs` > request time, `NICKNAME_COOLDOWN`. The first registration and the first change after an operator forced change have no cooldown
4. Cost: the change number n of this change is 0 (first registration) when there is no `NicknameUserState` row or its `nickname` is an empty string, otherwise `change_count` + 1. Subtracts, with `item-ledger.subtract_items`, the `cost` of the row with the largest `change_number` among the `nickname_cost` rows with `change_number` ≤ n. Source `Nickname`; `ref` is the decimal string of n. When there is no matching `nickname_cost` row or `cost` is an empty array, the change is free
5. name registration: when the normalized input equals the normalized value of the current nickname, changes only the `nickname` of the current nickname's `nickname_name` row to the input and does no insert or delete. When they differ: when game settings `nicknameUnique` is `true`, locks the key normalized input of `nickname_claim` with `storage.lock_game_row`, and when there is a `nickname_name` row whose `normalized` is the normalized input and whose `user_id` is not this user, `NICKNAME_TAKEN`. Then inserts the row with key (normalized input, this user's user ID) and deletes the row of the current nickname
6. Writes the input to `nickname` of `NicknameUserState`, request time to `changed_at`, n to `change_count` and `false` to `forced`

- When game settings `nicknameUnique` is `true`, the `nickname_claim` lock handles registrations of the same normalized nickname one at a time, so of two users who register the same nickname concurrently, only one succeeds

### storage

- Saves to the core UserState kind `NicknameUserState` (single kind) of the base proto. Only this module writes it, with `storage.put_core_state`. field: `string nickname`, `int64 changed_at`, `int32 change_count`, `bool forced`
- When there is no row, there is no nickname. Client content code decides the screen that asks a user without a nickname to register one
- `change_count` holds the change number n of the last `SetNickname`. An operator forced change does not increase `change_count`
- `forced` becomes `true` after an operator forced change and `false` after that user's next `SetNickname`

| table | scope | column | key | expiry column | index |
|---|---|---|---|---|---|
| `nickname_name` | `user` | `user_id`, `normalized`, `nickname` | `(normalized, user_id)` | none | `(user_id)` |
| `nickname_claim` | `game` | `normalized` | `normalized` | none | none |

- `nickname_name` is registered with snapshot flag `false`. `storage.delete_user` deletes the rows of a withdrawn user, and another user can use that nickname
- `nickname_claim` is registered without a snapshot flag, and no row is written to it. It is used only as the `lock_game_row` key of `SetNickname` step 5
- Changing game settings `nicknameUnique` leaves the key and the rows of `nickname_name` as they are. Users who came to use the same normalized nickname while it was `false` keep that nickname after it changes to `true`, and the duplicate check applies from the registrations after that
- `get_nicknames` reads from `nickname_name` with `db(ctx)` of `storage` and writes nothing

### operator forced change

- The `user_target` of `rename_user` is `user_id`. In the out-of-request change of the target user that `admin-api` opens, does step 5 of `SetNickname` and writes the input to `nickname` of `NicknameUserState`, request time to `changed_at` and `true` to `forced`. Leaves `change_count` as it is when the row exists, otherwise writes 0. The change becomes a pending delta
- A character rule violation is `bad_request`; when game settings `nicknameUnique` is `true` and another user uses the nickname, `conflict`. Does not look at banned word, cooldown or cost

### find by nickname

- nickname lookup: selects, in ascending order of user ID, the `nickname_name` rows whose `normalized` equals the input normalized with `validation.normalize_text`. Rows of withdrawn users do not appear, because `storage.delete_user` deleted them
- `find_user_by_nickname` has no `user_target`. In the game tx that `admin-api` opens, returns up to `admin-api.maxSearchRows` rows chosen by nickname lookup as `{user_id, nickname}`. When the input is an empty string or its code point count is more than `nickname.maxLength`, `bad_request`
- `find_user_ids_by_nickname` only reads, with `storage.db`(ctx)

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `nickname` | nickname | `module` | `app_functionality` | `true` | `false` | `false` | `false` | `all` | `none` |

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| character rule violation | `NICKNAME_INVALID` | `NICKNAME_INVALID` | none |
| banned word | `NICKNAME_BANNED` | `NICKNAME_BANNED` | `info` log. ID value of the matched `banned_word` |
| another user uses it | `NICKNAME_TAKEN` | `NICKNAME_TAKEN` | none |
| step 5 `nickname_claim` lock wait over the limit, deadlock (`FAILED` of `lock_game_row`) | `FAILED`. The nickname and the balance do not change | `INTERNAL` | none |
| within cooldown | `NICKNAME_COOLDOWN` | `NICKNAME_COOLDOWN` | none |
| cost cannot be subtracted (balance short, rejection by the validation hook of `item-ledger`) | failure of `item-ledger` | error rules of `item-ledger` | none |
| `get_nicknames` over its limit | throw | `INTERNAL` | `error` log by `routing` |
| `nickname_claim` lock wait over the limit or deadlock in `rename_user` | `internal` | none | `audit` |
| character rule violation in `rename_user`, `find_user_by_nickname` input that is an empty string or whose code point count is more than `nickname.maxLength` | `bad_request` | none | `audit` |
| `rename_user` to a nickname another user uses while game settings `nicknameUnique` is `true` | `conflict` | none | `audit` |
| `rename_user` of a missing or withdrawn user | `not_found` | none | error rules of `admin-api` |

Added `CoreError`: `NICKNAME_INVALID`, `NICKNAME_BANNED`, `NICKNAME_TAKEN`, `NICKNAME_COOLDOWN`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `nickname.minLength` | integer | core | content | minimum code point count |
| `nickname.maxLength` | integer | core | content | maximum code point count |
| `nickname.allowedScripts` | array<string> | core | content | allowed Unicode `Script` values. e.g. `Latin`, `Hangul`, `Han` |
| `nickname.allowedSymbols` | string | core | content | allowed symbol characters |
| `nicknameUnique` | boolean | game | none | whether duplicates of the normalized nickname are banned. Not changed after the first PROD build |
| `nickname.changeCooldownMs` | integer | core | content | duration from a change to the next change |
| `nickname.maxLookupCount` | integer | core | content | limit on the user count of one `get_nicknames` call |
| `admin-api.maxSearchRows` | integer | core | content | maximum row count that `find_user_by_nickname` returns |

settings constraint

| left | factor | right |
|---|---|---|
| `nickname.minLength` | 1 | `nickname.maxLength` |

## data

used table: `banned_word`. A table of `validation`

`data/tables/nickname_cost.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `change_number` | `int` | `All` |
| `cost` | `array<{item_id: ref<item.id>, amount: long}>` | `All` |

- `change_number` is 0 or more and unique within the table. On violation, the server does not start

## DEV

none

## test

- Each condition of the character rules gives `NICKNAME_INVALID` for one input, and the boundary lengths `nickname.minLength` and `nickname.maxLength` pass
- A banned word that differs only in letter case, full-width or spacing is `NICKNAME_BANNED`
- When game settings `nicknameUnique` is `true`, another user's nickname with the same normalization is `NICKNAME_TAKEN`; when `false`, it passes
- When game settings `nicknameUnique` is `true`, only one of two users who register the same nickname concurrently succeeds; when `false`, both succeed
- After a restart that changes only game settings `nicknameUnique`, the server starts and the `nickname_name` rows stay as they were. The nicknames of two users who registered the same normalized nickname while it was `false` stay after it changes to `true`, and a third user's registration of the same normalized nickname is `NICKNAME_TAKEN`
- The first registration has no cooldown and is free when there is no `change_number` 0 row. A change within the cooldown is `NICKNAME_COOLDOWN`
- The n-th change subtracts the cost of the matching `nickname_cost` row with source `Nickname`; when the cost is short, the result is `ITEM_NOT_ENOUGH` and the nickname stays
- When `validate_item_change` returns, for a change that subtracts a cost, a `GameError` listed in `(ogw.core_errors)` for `SetNickname`, `SetNickname` fails with that `GameError`, and the nickname and the balance stay
- After a change, another user can register the previous nickname
- After a change of letter case only, that user has one `nickname_name` row and `get_nicknames` returns the new nickname. When game settings `nicknameUnique` is `true`, another user's registration of the same normalized nickname is `NICKNAME_TAKEN`
- Another user can register the nickname of a withdrawn user
- `rename_user` changes the nickname without banned word, cooldown or cost, and creates a pending delta with `forced` `true`
- A user who got a first nickname by `rename_user` has `change_count` 0; that user's next `SetNickname` pays, without cooldown, the cost of the row with the largest `change_number` at most 1, and `change_count` becomes 1. `rename_user` of a user who has a nickname does not change `change_count`
- `get_nicknames` called by a content handler returns other users' nicknames and leaves out users without a nickname
- `find_user_by_nickname` returns the users of that nickname in ascending order of user ID also for input that differs only in letter case, full-width or spacing; a withdrawn user and a nickname that does not exist give an empty list. When game settings `nicknameUnique` is `false`, it returns all users of the same normalized nickname
- `find_user_ids_by_nickname` called by `friend`, not by content, returns the same user IDs for input that differs only in letter case, full-width or spacing, and does not exceed the maximum count
- `check_nickname` ends without a failure value for a nickname that keeps the rules and for a nickname another user uses while game settings `nicknameUnique` is `true`, returns `NICKNAME_INVALID` for a character rule violation and `NICKNAME_BANNED` for a banned word, and does not change the saved state
