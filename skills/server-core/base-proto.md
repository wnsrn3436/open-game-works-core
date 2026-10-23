# base proto table

The core agent reads this when writing or fixing the base proto. The content agent reads it when looking up a `CoreError` or a core UserState kind.

- field table
- CoreError
- core UserState kind
- base proto check

Rows of the tables of `## CoreError` and `## core UserState kind` are not deleted, and their order and numbers are not changed. A new row is added at the end of the table.

## field table

- The fields of the request messages of core `rpc`s and core cheats, and of the base proto messages reached from them, are set by the request field table of that module spec. The table for a core `rpc` is in `## API`, and the table for a core cheat in `## DEV`. The columns are `message`, `field`, `type`, `(ogw.v)`
  - Field numbers start at 1, in table order of the rows of the same message. A new field is added after the last row of that message
  - The `(ogw.v)` cell joins `<option>: <value>` entries with commas. For enum, bool, float and double fields it is `none`. A request message without fields is not written in the table
  - A limit that the game can change with core settings is written as a core settings key in the `_key` option. A number is written only for a limit that the range of the type or the format of the value sets. e.g. `max` 2^31−1 of `int32`, `max_len` 36 of a UUID v4 string, `max_len` 35 of a BCP 47 language tag (the supported length that RFC 5646 recommends to implementations)
- The fields of the response messages of core `rpc`s and core cheats are set by the response field table of that module spec. The table for a core `rpc` is in `## API`, and the table for a core cheat in `## DEV`. The columns are `message`, `field`, `type`. A response message without fields is not written in the table
  - Field numbers and new fields follow the same rules as in the request field table
  - A base proto message reached from a response message is set by the module spec that declares that type, as rows of the response field table or as a `<type> <field>` list. Field numbers in the list start at 1, in list order, and a new field is added at the end of the list

## CoreError

Every module returns `CoreError` regardless of dependency. The meaning of each value is set by `## error` of the spec of its `module`. 0 is `CORE_ERROR_UNSPECIFIED`. The `module` column matches the Added `CoreError` lines of `## error` of the module specs. `ogw docs check` compares them.

| `CoreError` | number | module |
|---|---|---|
| `INVALID_REQUEST` | 1 | `routing` |
| `RATE_LIMITED` | 2 | `routing` |
| `MAINTENANCE` | 3 | `routing` |
| `BANNED` | 4 | `routing` |
| `FEATURE_DISABLED` | 5 | `routing` |
| `APP_UPDATE_REQUIRED` | 6 | `routing` |
| `DATA_UPDATE_REQUIRED` | 7 | `routing` |
| `INTERNAL` | 8 | `routing` |
| `UNAUTHORIZED` | 9 | `auth` |
| `TOKEN_EXPIRED` | 10 | `auth` |
| `CONSENT_REQUIRED` | 11 | `auth` |
| `SOCIAL_LOGIN_INVALID` | 12 | `auth` |
| `ALREADY_LINKED` | 13 | `auth` |
| `EXTERNAL_SERVICE_FAILED` | 14 | `auth` |
| `SESSION_REPLACED` | 15 | `session` |
| `ITEM_NOT_ENOUGH` | 16 | `item-ledger` |
| `ITEM_LIMIT_EXCEEDED` | 17 | `item-ledger` |
| `MAIL_NOT_FOUND` | 18 | `mailbox` |
| `MAIL_EXPIRED` | 19 | `mailbox` |
| `SHOP_PRODUCT_UNAVAILABLE` | 20 | `shop` |
| `SHOP_LIMIT_REACHED` | 21 | `shop` |
| `SHOP_OVERFLOW_LOSS` | 22 | `shop` |
| `IAP_VERIFY_UNAVAILABLE` | 23 | `iap` |
| `IAP_PRODUCT_UNAVAILABLE` | 24 | `iap` |
| `IAP_LIMIT_REACHED` | 25 | `iap` |
| `AGE_CONFIRMATION_REQUIRED` | 26 | `iap` |
| `IAP_SPEND_LIMIT_REACHED` | 27 | `iap` |
| `IAP_DAILY_INACTIVE` | 28 | `iap` |
| `IAP_ALREADY_CLAIMED` | 29 | `iap` |
| `AD_LIMIT_REACHED` | 30 | `ads-reward` |
| `AD_REWARD_PENDING` | 31 | `ads-reward` |
| `AD_REWARD_NOT_FOUND` | 32 | `ads-reward` |
| `GACHA_BANNER_UNAVAILABLE` | 33 | `gacha` |
| `MISSION_UNAVAILABLE` | 34 | `mission` |
| `MISSION_LOCKED` | 35 | `mission` |
| `MISSION_ALREADY_CLAIMED` | 36 | `mission` |
| `MISSION_NOT_COMPLETED` | 37 | `mission` |
| `COUPON_INVALID` | 38 | `coupon` |
| `COUPON_NOT_ACTIVE` | 39 | `coupon` |
| `COUPON_ALREADY_REDEEMED` | 40 | `coupon` |
| `COUPON_USED_UP` | 41 | `coupon` |
| `NICKNAME_INVALID` | 42 | `nickname` |
| `NICKNAME_BANNED` | 43 | `nickname` |
| `NICKNAME_TAKEN` | 44 | `nickname` |
| `NICKNAME_COOLDOWN` | 45 | `nickname` |
| `MATCH_NOT_FOUND` | 46 | `matchmaker` |
| `MATCH_NOT_PARTICIPANT` | 47 | `matchmaker` |
| `MATCH_ALREADY_REPORTED` | 48 | `matchmaker` |
| `AGE_BELOW_MINIMUM` | 49 | `auth` |
| `SHOP_PRODUCT_LOCKED` | 50 | `shop` |
| `IAP_PRODUCT_LOCKED` | 51 | `iap` |
| `GACHA_BANNER_LOCKED` | 52 | `gacha` |
| `ATTENDANCE_UNAVAILABLE` | 53 | `attendance` |
| `ATTENDANCE_LOCKED` | 54 | `attendance` |
| `ATTENDANCE_ALREADY_CLAIMED` | 55 | `attendance` |
| `ATTENDANCE_COMPLETED` | 56 | `attendance` |
| `TEXT_INVALID` | 57 | `validation` |
| `TEXT_BANNED` | 58 | `validation` |
| `USER_NOT_FOUND` | 59 | `public-profile` |
| `FRIEND_ALREADY` | 60 | `friend` |
| `FRIEND_REQUEST_NOT_FOUND` | 61 | `friend` |
| `FRIEND_NOT_FOUND` | 62 | `friend` |
| `FRIEND_LIMIT` | 63 | `friend` |
| `FRIEND_TARGET_LIMIT` | 64 | `friend` |
| `FRIEND_REQUEST_LIMIT` | 65 | `friend` |
| `BLOCKED` | 66 | `block-report` |
| `BLOCK_LIMIT` | 67 | `block-report` |
| `REPORT_LIMIT` | 68 | `block-report` |
| `GUILD_NOT_FOUND` | 69 | `guild` |
| `GUILD_ALREADY_MEMBER` | 70 | `guild` |
| `GUILD_NOT_MEMBER` | 71 | `guild` |
| `GUILD_NAME_TAKEN` | 72 | `guild` |
| `GUILD_FULL` | 73 | `guild` |
| `GUILD_CLOSED` | 74 | `guild` |
| `GUILD_COOLDOWN` | 75 | `guild` |
| `GUILD_PERMISSION` | 76 | `guild` |
| `GUILD_REQUEST_NOT_FOUND` | 77 | `guild` |
| `GUILD_REQUEST_LIMIT` | 78 | `guild` |
| `GUILD_LEADER_CANNOT_LEAVE` | 79 | `guild` |
| `GUILD_OFFICER_LIMIT` | 80 | `guild` |
| `CHAT_MUTED` | 81 | `chat` |
| `CHAT_TOO_FAST` | 82 | `chat` |
| `CHAT_NOT_FRIEND` | 83 | `chat` |
| `CHAT_MESSAGE_NOT_FOUND` | 84 | `chat` |
| `PLAY_SESSION_NOT_FOUND` | 85 | `play-session` |
| `PLAY_SESSION_EXPIRED` | 86 | `play-session` |
| `PLAY_SESSION_TOO_FAST` | 87 | `play-session` |
| `PLAY_SESSION_REJECTED` | 88 | `play-session` |
| `ROOM_NOT_FOUND` | 89 | `matchmaker` |
| `ROOM_FULL` | 90 | `matchmaker` |
| `ROOM_BUSY` | 91 | `matchmaker` |
| `ROOM_NOT_HOST` | 92 | `matchmaker` |
| `ROOM_NOT_ENOUGH_PLAYERS` | 93 | `matchmaker` |
| `ROOM_PARTY_TOO_LARGE` | 94 | `matchmaker` |
| `ROOM_VERSION_MISMATCH` | 95 | `matchmaker` |
| `CHILD_RESTRICTED` | 96 | `chat` |
| `PLAY_SESSION_CONTINUE_LIMIT` | 97 | `play-session` |

## core UserState kind

The order of the table is the order of core kinds in the UserState delta. The fields are set by the spec of the owner module, and only the owner module writes them with the `storage` operations `put_core_state`, `delete_core_state`.

| kind | owner module |
|---|---|
| `ItemBalanceUserState` | `item-ledger` |
| `MailUserState` | `mailbox` |
| `ShopPurchaseUserState` | `shop` |
| `IapPurchaseUserState` | `iap` |
| `SubscriptionUserState` | `iap` |
| `AdRewardCountUserState` | `ads-reward` |
| `LiveEventEntryUserState` | `live-event` |
| `TutorialProgressUserState` | `tutorial` |
| `GachaPityUserState` | `gacha` |
| `MissionProgressUserState` | `mission` |
| `NicknameUserState` | `nickname` |
| `ConsentUserState` | `auth` |
| `AttendanceUserState` | `attendance` |
| `OfferUserState` | `offer` |
| `RatingUserState` | `rating` |
| `ResetCounterUserState` | `reset-counter` |

## base proto check

When the target is `server` or an engine, `ogw core test` compares the module specs with `open-game-works-core-impl/proto/ogw/core.proto` as below before the tests. When there is a difference, it does not run the tests, prints for each difference the spec file:line and the message, field, `rpc` or enum value of the proto, and fails. After fixing core.proto, the core agent aligns them with this result.

- For each row of a request field table and of a response field table, that message in core.proto has a field of the same name, and the type, the field number (from 1, in table order of the rows of the same message) and, for a request field table, the `(ogw.v)` option are equal. That message in core.proto has no field that is not in the table
- For each operation cell `<rpc name> (core rpc[, <option>...]). changes: <saved state>` of an `## API` table, the core service of core.proto has that `rpc`, its attached `rpc` options equal `<option>`, and its last comment line is `changes: <saved state>`. `<cheat name> (core cheat). changes: <saved state>` of a `## DEV` table is compared the same way in the core cheat service. The two services of core.proto have no `rpc` that is not in a spec
- The values of the `CoreError` enum are `CORE_ERROR_UNSPECIFIED` at 0 and `CORE_ERROR_<name> = <number>` for each row of the `## CoreError` table, and there are no other values
- The declaration order of the core UserState kind messages in core.proto is the order of the `## core UserState kind` table
