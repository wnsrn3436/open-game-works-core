# mailbox

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

Sends mail to a user mailbox and lets the client read mail and claim attachments. Also handles the grant that sends by mail the items that could not be granted directly because they exceed `max_amount`.

## dependency

- `item-ledger`
- `storage`
- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `send_mail` | ctx, mail input | mail ID | failure element of `MailResult` | content handler, hook, `admin-api`, `ranking`, `coupon`, `rating` |
| `grant_or_mail` | ctx, `ItemAmount` list, change source, mail template ID value, mail `args` | `Granted`, `AlreadyApplied`, or `Mailed` and a mail ID list | `UNKNOWN_ITEM`, `INVALID_AMOUNT`, `UNSUPPORTED_ITEM` from `item-ledger` `add_items`, `INVALID_INPUT` from `MailResult` | content handler, hook, `iap`, `ads-reward`, `gacha`, `mission`, `coupon`, `shop`, `attendance` |
| `broadcast_mail` | game tx, mail input, start time | broadcast ID | failure element of `MailResult` | `admin-api` |
| `mail_input_from_json` | JSON value of a mail input | mail input | `INVALID_INPUT` from `MailResult` | `admin-api` |
| `cancel_mail_by_once_key` | ctx, `once_key` | `ItemAmount` list that joins the `attachments` of the deleted mails in mail ID ascending order | empty list | `iap` |
| `cancel_broadcast` | game tx, broadcast ID | success flag | `false` | `admin-api` |
| `on_request_start` | user ID | none | none. A failure leaves an `error` log | `routing`, `auth` |
| `ReadMail` (core rpc, `retry`). changes: `MailUserState` | mail ID | empty response | `MAIL_NOT_FOUND` | `routing`. Client content code sends it |
| `ClaimMail` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `content` | mail ID | claimed `ItemAmount` list | `MAIL_NOT_FOUND`, `MAIL_EXPIRED`, `CoreError` from `item-ledger`, `GameError` from a hook | `routing`. Client content code sends it |
| `ClaimAllMail` (core rpc, `retry`). changes: `ItemBalanceUserState`, `MailUserState`, `content` | none | claimed mail ID list, claimed `ItemAmount` total list, unclaimed mail count | none | `routing`. Client content code sends it |

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `ReadMailRequest` | `mail_id` | `int64` | `min`: 1, `max`: 2^63−1 |
| `ClaimMailRequest` | `mail_id` | `int64` | `min`: 1, `max`: 2^63−1 |

core `rpc` response field

| message | field | type |
|---|---|---|
| `ClaimMailResponse` | `items` | `repeated ItemAmount` |
| `ClaimAllMailResponse` | `mail_ids` | `repeated int64` |
| `ClaimAllMailResponse` | `items` | `repeated ItemAmount` |
| `ClaimAllMailResponse` | `unclaimed_count` | `int32` |

- A core module that sends to another user opens that user's out-of-request change with `storage.run_user_transaction` and calls `send_mail`. Content handlers and hooks send with `storage.send_user_change` and call `send_mail` in its apply function. The change becomes that user's pending delta
- `on_request_start` is called in the request start step of `routing` and does the work of the request start rules
- mail input
  - `template_id`: ID value of `mail_template`
  - `args`: `MailArg` list. Fills the format arguments of the template text. A `MailArg` is a `name` and one value. The value is an integer or a string. In the JSON of an admin operation, the type of `args` is `array<object{name: string, value: object union{int_value: int64, text_value: string}}>`
  - TypeScript forms that content code and core modules call: `send_mail(ctx, input)`, whose `input` is an object keyed by mail input field names, and `grant_or_mail(ctx, items, source, template_id, args)`. Both `args` are `MailArg[]`, and a passed `MailArg` is `{ name: string; int_value: bigint }` for an integer and `{ name: string; text_value: string }` for a string. `mailbox` sets `kind`
  - TypeScript forms of the output: `send_mail` returns `{result, mail_id}` (`result` is a `MailResult` element, `mail_id` is the mail ID for `OK` and `ALREADY_SENT` and 0 otherwise), and `broadcast_mail` returns `{result, broadcast_id}` (`broadcast_id` is 0 when the result is not `OK`). `grant_or_mail` returns `{result: 'Granted'}`, `{result: 'AlreadyApplied'}`, `{result: 'Mailed', mail_ids}`, or `{result}` with the failure value in `result`
  - JSON value of a mail input: an object keyed by mail input field names. Only `template_id` is required, and a missing field is the empty value of its type. An `int64` value is a JSON integer or a decimal integer string. When the format is wrong, the result of `mail_input_from_json` is `INVALID_INPUT`
  - Among content code calls of `send_mail` and `grant_or_mail`, in a call that picks the template ID value with a `ReservedId` accessor and passes `args` as an array literal, the static check `format args` blocks the call when the name set of `args` differs from the format argument name set of `title` and `body` of that `mail_template` row, or when the formatter of a format argument does not accept the value kind of its `MailArg`
  - `attachments`: `ItemAmount` list. May be empty
  - `extra_id`: when not 0, the ID value passed to hook `grant_mail_extra` on claim
  - `expire_ms`: duration from the sent time to expiry. When 0, `mailbox.defaultExpireMs`
  - `no_expiry`: when `true`, the mail's `expires_at` is 0 and `expire_ms` is not used. When `false`, `expires_at` is the sent time + `expire_ms`. Only the `send_mail` that step 3 of `grant_or_mail` calls receives `true`. Passing `true` to any other `send_mail` or to `broadcast_mail` is `INVALID_INPUT`
  - `once_key`: when not empty, mail with the same `once_key` is sent to the same user only once
- When a `once_key` that content code passed (in the mail input of `send_mail`, in the change source of `grant_or_mail`) starts with the core `once_key` prefix of `item-ledger`, the module changes nothing, throws and leaves an `error` log. The request is `INTERNAL`

`MailResult`

| element | meaning |
|---|---|
| `OK` | sent |
| `ALREADY_SENT` | That user has a `mailbox_once_key` row with the same `once_key`. The mail ID is the `mail_id` of that row |
| `INVALID_INPUT` | `template_id` is not in the table, or `args` or `attachments` exceed a limit, or `expire_ms` is less than 0 or more than `mailbox.maxExpireMs`, or `no_expiry` is `true` outside `grant_or_mail`, or `args` has a `MailArg` with a non-default value in a field that its `kind` does not select, or `attachments` do not pass `item-ledger.check_add_items`, or the `once_key` of `broadcast_mail` is not empty |

## behavior

- `once_key` prefix: `broadcast:`, `mail:`

mail

- Mail is saved as the base proto core UserState kind `MailUserState` (list kind). Only this module writes it, with `storage.put_core_state` and `delete_core_state`. Fields: `int64 id` (mail ID), `int32 template_id`, `repeated MailArg args`, `repeated ItemAmount attachments`, `int32 extra_id`, `int64 sent_at`, `int64 expires_at`, `bool read`. `MailArg` is a base proto message with fields `string name`, `MailArgKind kind`, `int64 int_value`, `string text_value`, numbered 1 to 4 in this order. `MailArgKind` is a base proto enum with elements `Int` and `Text`. An integer `MailArg` has `kind` `Int` and its value in `int_value`, and a string `MailArg` has `kind` `Text` and its value in `text_value`. A field that `kind` does not select has the default value (0, empty string)
- The mail ID is an integer that increases from 1 within a user. The last issued mail ID is kept in `mailbox_mail_counter`. The ID of a deleted mail is also never issued again
- `next_expires_at` of `mailbox_mail_counter` is at most the smallest `expires_at` among that user's mails whose `expires_at` is not 0, and can be 0 only when there is no such mail. Its first value is 0. When a mail whose `expires_at` is not 0 is sent, the same transaction changes `next_expires_at` to that `expires_at` when it is 0 or larger than that `expires_at`
- When a mail with a non-empty `once_key` is sent, the same transaction inserts a (user ID, `once_key`, mail ID) row into `mailbox_once_key`. This row is never deleted. It stays when the mail is claimed or deleted by expiry, so a mail with the same `once_key` is not created again. The mail ID of `ALREADY_SENT` is the `mail_id` of that row
- The mail states are `Unread`, `Read`, `Claimed`. A `Claimed` mail is deleted from the `MailUserState` kind with `storage.delete_core_state`. The claim is recorded in `item-ledger` history and the `info` log
- A mail is expired when `expires_at` is not 0 and `server-time` `is_reached_strict(expires_at)` is `true`. A mail whose `expires_at` is 0 does not expire. An expired mail is deleted with `delete_core_state` without its attachments being claimed. It is deleted at that user's `on_request_start`

claim

- `ReadMail` sets `read` to `true`. When it is already `true`, it changes nothing and succeeds
- `ClaimMail` processing order. On failure, mail and items are not changed
  1. `MAIL_NOT_FOUND` when the mail does not exist, `MAIL_EXPIRED` when it is expired
  2. When there are `attachments`, `item-ledger.add_items` with source `Mail`, `ref` the mail ID, and `once_key` `mail:<mail ID>`
  3. When `extra_id` is not 0, hook `grant_mail_extra`
  4. Ends the mail as `Claimed`
- `ClaimMail` also deletes a mail without attachments and `extra_id`
- In step 2 of `ClaimMail` and `ClaimAllMail`, `ALREADY_APPLIED` from `add_items` equals `OK`
- `ClaimAllMail` handles the unexpired mails in mail ID ascending order, from the front up to `mailbox.maxClaimAllCount` mails, one at a time with steps 2 to 4 of `ClaimMail`. Each mail is handled inside `storage.run_savepoint`, and on the results below the function returns a failure code so that only that mail's changes are rolled back. That mail stays and is counted in the unclaimed mail count. Then it goes to the next mail
  - `item-ledger.add_items` returns a result other than `OK` and `ALREADY_APPLIED`. The failure code follows the error rules of `item-ledger`
  - hook `grant_mail_extra` returns `GameError`
  - `extra_id` is not 0 but hook `grant_mail_extra` is not registered. The failure code is `INTERNAL`
- In `ClaimAllMail`, a DB failure or a throw ends the whole request with `INTERNAL`
- The unclaimed mail count of `ClaimAllMail` is the sum of the number of mails handled but left and the number of unexpired mails not handled because they come after the first `mailbox.maxClaimAllCount` mails. Mails not handled stay as they are
- The claimed `ItemAmount` list of `ClaimMail` is the `attachments` passed to `add_items` in step 2, unchanged. When there are no `attachments`, it is an empty list
- The claimed `ItemAmount` total list of `ClaimAllMail` is the claimed `ItemAmount` lists of `ClaimMail` of every claimed mail added per item ID value, in item ID value ascending order

grant or mail

`grant_or_mail` processing order. The change source is the change source of `item-ledger`.

1. When the `once_key` of the change source is not empty and a `mailbox_once_key` row with the same `once_key` exists, `Mailed` and the mail ID list of the `mailbox_once_key` rows of that `once_key` and of `<once_key>:<k>`. Does not call `add_items` and does not add `ItemMail`
2. `item-ledger.add_items`(list, change source). `Granted` on `OK`, `AlreadyApplied` on `ALREADY_APPLIED`
3. When `add_items` returns `LIMIT_EXCEEDED` or `REJECTED`, calls `send_mail` for each chunk made by splitting the list in order into `mailbox.maxAttachments` items each. The template is the received template ID value, `args` is the received `args`, and `attachments` is that chunk. When the `source` of the change source is `Iap`, `no_expiry` is `true`; otherwise `no_expiry` is `false` and `expire_ms` is 0 (`mailbox.defaultExpireMs`). The `once_key` of the k-th chunk is the `once_key` of the change source when k is 1, and `<once_key>:<k>` when k is 2 or more. When the `once_key` of the change source is empty, all are empty strings. Before calling `send_mail`, when a `mailbox_once_key` row of `<once_key>:<k>` exists for any k of 2 or more, sends no mail, leaves one `error` log line and returns `INVALID_INPUT`. When all are `OK`, `Mailed` and the mail ID list
4. Any other `add_items` result and `INVALID_INPUT` from `send_mail` are returned as they are

- On `Mailed`, adds the base proto message `ItemMail` (`int64 mail_id`, `ItemChangeSource source`, `string ref`, `repeated ItemAmount items`) to ctx with `storage.add_item_mail`. `source` and `ref` are the values of the change source, and `items` is that mail's chunk. One `ItemMail` per sent mail. In a request it goes into `item_mails` of that response, and in an out-of-request change it accumulates together with the pending delta
- The granted `ItemAmount` list of the caller response is, on `Granted`, the list passed to `add_items` in step 2, unchanged, and on `Mailed` and `AlreadyApplied`, an empty list. The amount that went in, the amount that did not go in because of `max_amount`, and the `Convert` substitute grant are in `ItemChange` of `item_changes`, and the items of `Mailed` are in `ItemMail` of `item_mails`
- `AlreadyApplied` is the result that changed nothing because a grant with the same `once_key` already exists. The caller treats it as granted
- `grant_or_mail` leaves no records and logs other than what `add_items` and `send_mail` leave and the `error` log of the `once_key` collision in step 3

cancel

- `cancel_mail_by_once_key` deletes with `delete_core_state` the mails left in `MailUserState` among the mails sent to the user of ctx with `once_key` and `<once_key>:<k>` (k from 2 until there is no `mailbox_once_key` row of `<once_key>:<k>`). Claimed mails are already deleted, so it does not delete them
- `mailbox_once_key` rows are not deleted. So `send_mail` and `grant_or_mail` with the same `once_key` do not create the mail again
- For each deleted mail, writes the mail ID and `once_key` to the `info` log

broadcast

- A broadcast is a mail sent to all users. It is not saved per user but kept as one `mailbox_broadcast` row
- `broadcast_mail` locks the row with `id` 0 of `mailbox_broadcast_counter` with `storage.lock_game_row` in the game tx, sets the broadcast ID to `last_broadcast_id` + 1 of that row (1 when there is no row), writes it to `last_broadcast_id` and inserts the broadcast row. The ID of a broadcast deleted by expiry is also never issued again
- The `mail` of a broadcast row is the received mail input written as a JSON string, and the type of `args` is the JSON type of the mail input. Its `expire_ms` is the received `expire_ms`, changed to `mailbox.defaultExpireMs` when 0. `expires_at` is `start_at` + that `expire_ms`, and `cancelled` is `false` at first
- Users created after the broadcast start time also receive it
- The `once_key` of the mail input that `broadcast_mail` receives is an empty string. When it is not empty, `INVALID_INPUT`
- `cancel_broadcast` locks that broadcast row with `storage.lock_game_row` in the game tx. When there is no row, `false`; otherwise it writes `cancelled` as `true` and returns `true`. It creates no more mail for users whose mail is not created yet. Mails already created stay

request start

`on_request_start` does the following in one out-of-request change of that user opened with `storage.run_user_transaction`. The change becomes a pending delta and goes into the response of that request. When `WITHDRAWN`, does nothing.

1. Only when `next_expires_at` is not 0 and `is_reached_strict(next_expires_at)` is `true`, reads the `MailUserState` list, deletes the expired mails, and changes `next_expires_at` to the smallest `expires_at` among the remaining mails whose `expires_at` is not 0 (0 when there is none)
2. For each `mailbox_broadcast` row where `cancelled` is `false` and `start_at` ≤ request time < `expires_at`, when that user's `mailbox_once_key` has no `broadcast:<broadcast ID>` row, calls `send_mail` with the `mail` of that row to create the mail. The `once_key` is `broadcast:<broadcast ID>`. When `send_mail` returns `INVALID_INPUT`, skips that broadcast and leaves an `error` log

- When the transaction fails, leaves an `error` log and continues handling the original request. The `on_request_start` of the next request does it again

table

| table | scope | column | key | expiry column |
|---|---|---|---|---|
| `mailbox_mail_counter` | `user` | `user_id`, `last_mail_id`, `next_expires_at` | `user_id` | none |
| `mailbox_once_key` | `user` | `user_id`, `once_key`, `mail_id` | `(user_id, once_key)` | none |
| `mailbox_broadcast` | `game` | `broadcast_id`, `mail`, `start_at`, `cancelled`, `created_at`, `expires_at` | `broadcast_id` | `expires_at` |
| `mailbox_broadcast_counter` | `game` | `id`, `last_broadcast_id` | `id` | none |

- The four tables are registered with `storage.register_table`. `mailbox_mail_counter` and `mailbox_once_key` are registered with snapshot flag `true`, and `mailbox_broadcast` and `mailbox_broadcast_counter` without the snapshot flag

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `grant_mail_extra` | step 3 of `ClaimMail` | ctx, `extra_id`, mail ID | `pass` or `GameError` | `ClaimMail` of a mail whose `extra_id` is not 0 ends with `INTERNAL`, and `ClaimAllMail` counts that mail as unclaimed. Leaves an error log |

- With `grant_mail_extra`, content grants a reward that is not an item (e.g. one piece of equipment). Items are sent in `attachments`

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| mail ID that does not exist | `MAIL_NOT_FOUND` | `MAIL_NOT_FOUND` | none |
| `ClaimMail` of an expired mail | `MAIL_EXPIRED` | `MAIL_EXPIRED` | none |
| attachment grant failure | failure from `item-ledger` | error rules of `item-ledger` | none |
| in `ClaimAllMail`, an unclaimed mail, and a mail not handled because it comes after the first `mailbox.maxClaimAllCount` mails | not a failure. The mail stays and is counted in the unclaimed mail count | none | none |
| `UNKNOWN_ITEM`, `INVALID_AMOUNT`, `UNSUPPORTED_ITEM`, `INVALID_INPUT` from `grant_or_mail` | that value | `INTERNAL` for a request of a core module; content decides for a content handler | `error` log of `item-ledger` and `send_mail`. For the `once_key` collision in step 3, the `error` log of `grant_or_mail` |
| input error of `send_mail` | `INVALID_INPUT` | content decides | `error` log |
| a `once_key` that content code passed to `send_mail` or `grant_or_mail` and that starts with the core `once_key` prefix of `item-ledger` | none. Throws and the request is `INTERNAL` | `INTERNAL` | `error` log |

Added `CoreError`: `MAIL_NOT_FOUND`, `MAIL_EXPIRED`

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `mailbox.defaultExpireMs` | integer | core | content | expiry duration of a mail whose `expire_ms` is 0 |
| `mailbox.maxExpireMs` | integer | core | content | upper limit of `expire_ms` |
| `mailbox.maxArgs` | integer | core | content | limit on the number of `args` of one mail |
| `mailbox.maxArgLength` | integer | core | content | limit on the byte length of `text_value` of one string `MailArg` |
| `mailbox.maxAttachments` | integer | core | content | limit on the number of `attachments` of one mail. 1 or more |
| `mailbox.maxClaimAllCount` | integer | core | content | limit on the number of mails one `ClaimAllMail` handles |

- When `mailbox.defaultExpireMs` is less than 1 or more than `mailbox.maxExpireMs`, the server does not start

## data

`data/tables/mail_template.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `title` | `tstring<id>` | `Client` |
| `body` | `tstring<id>` | `Client` |

- Client content code finds the row by `template_id`, fills the format arguments with `args` and displays it. In `LocalizationCore` `FormatArgs`, it puts the `int_value` of an integer `MailArg` with `set_int` and the `text_value` of a string `MailArg` with `set_string` into `name`
- Free text that an operator writes is sent with a template that has only one format argument. e.g. the body `{text}` of `[mail_notice]` and a string `MailArg` whose `name` is `text`

## DEV

none

## test

- `send_mail` creates a `MailUserState` delta, and `send_mail` in an out-of-request change creates a pending delta of the target user
- An integer `MailArg` and a string `MailArg` stay in `MailUserState` with their `kind`, `int_value` and `text_value` unchanged. A `MailArg` with a non-default value in a field that its `kind` does not select is `INVALID_INPUT`
- The second `send_mail` with the same `once_key` is `ALREADY_SENT` and there is one mail
- `send_mail` and `grant_or_mail` that content code calls with a `once_key` starting with the core `once_key` prefix of `item-ledger` throw, the request is `INTERNAL`, and mail and balance are unchanged
- `ClaimMail` grants the attachments with source `Mail` and deletes the mail
- The same mail cannot be claimed twice. The second claim is `MAIL_NOT_FOUND`
- When the attachment grant fails with `ITEM_LIMIT_EXCEEDED`, the mail stays and the balance is unchanged
- A mail past its expiry time is deleted without an attachment grant at `on_request_start` of that user's next request, and `ClaimMail` in that request is `MAIL_NOT_FOUND`
- `ClaimAllMail` leaves only the failed mails and claims the rest
- The `items` of `ClaimMail` equals the mail's `attachments` also when a `Discard` item overflows, and the `items` of `ClaimAllMail` holds the attachments of the claimed mails added per item ID value, in item ID value ascending order
- In `ClaimAllMail`, a mail whose attachments could not be claimed because they exceed `max_amount` and an `extra_id` mail for which `grant_mail_extra` is not registered stay and are counted in the unclaimed mail count, the other mails are claimed, and the request succeeds
- With `mailbox.maxClaimAllCount` + 1 unexpired mails, `ClaimAllMail` claims the `mailbox.maxClaimAllCount` mails with the smaller mail IDs, the mail with the largest mail ID stays, and `unclaimed_count` is 1
- The ID of a mail sent after a mail is claimed and deleted is larger than the ID of the deleted mail
- When `grant_mail_extra` returns `GameError`, the attachment grant of that mail is also rolled back
- A broadcast becomes a mail only once, in the first request where start time ≤ request time < `expires_at` of that broadcast row, and comes as a delta of that response, and users created after the start also receive it. It is also carried in the `Login` response
- The original request succeeds when `on_request_start` fails
- A user who first comes after `cancel_broadcast` does not receive the mail
- After a `once_key` mail is claimed and deleted and more than `mailbox.maxExpireMs` has passed, `send_mail` with the same `once_key` is `ALREADY_SENT`, returns that mail ID and creates no mail. The `mailbox_once_key` row is included in the user snapshot clone
- `broadcast_mail` after a broadcast deleted by expiry gets a broadcast ID larger than the deleted ID, and a user who received the mail of the deleted broadcast also receives the mail of the new broadcast
- Two `broadcast_mail` handled concurrently get different broadcast IDs. `cancel_broadcast` of a broadcast ID that does not exist is `false`
- A mail input over a limit and a mail input whose `expire_ms` is less than 0 are `INVALID_INPUT`
- A broadcast whose `expire_ms` is 0 becomes a mail in the first request before start time + `mailbox.defaultExpireMs`, and a user who first comes after that time does not receive it. `broadcast_mail` with a non-empty `once_key` is `INVALID_INPUT` and no broadcast row is created
- When `grant_or_mail` can grant, it is `Granted` and there is no mail and no `item_mails`
- `grant_or_mail` of a list in which a `Discard` item overflows is `Granted`, the granted `ItemAmount` list of the caller response equals the passed list, and the amount that went in and the overflowed amount are in `ItemChange` of `item_changes`
- In `grant_or_mail` of a list of at most `mailbox.maxAttachments` items, when `add_items` is `LIMIT_EXCEEDED` or `REJECTED`, it sends one mail with the same list as attachments and the same `once_key` and is `Mailed`, the balance is unchanged, and the response's `item_mails` has one `ItemMail`
- When a mail with the same `once_key` exists, `grant_or_mail` returns `Mailed` and that mail ID list without `add_items` and does not add it to `item_mails`
- The server does not start with core settings where `mailbox.defaultExpireMs` is 0 or larger than `mailbox.maxExpireMs`
- Request start of a user who has no mail whose `expires_at` is not 0 does not read the `MailUserState` list. With two mails of different expiry times, a request after the earlier mail expires deletes only the earlier mail, and `next_expires_at` is the `expires_at` of the later mail
- A mail sent by `grant_or_mail` with change source `Iap` has `expires_at` 0, and after `mailbox.maxExpireMs` has passed, `on_request_start` does not delete it and it can be claimed with `ClaimMail`. A mail sent by `grant_or_mail` with any other source expires at the sent time + `mailbox.defaultExpireMs`
- When content code `send_mail` and admin operations `send_mail` and `broadcast_mail` pass `no_expiry` as `true`, the result is `INVALID_INPUT` and no mail and no broadcast row are created
- An `ItemMail` created by `grant_or_mail` in an out-of-request change comes in `item_mails` of that user's next successful response
- `UNKNOWN_ITEM`, `INVALID_AMOUNT`, `UNSUPPORTED_ITEM` from `grant_or_mail` come back as they are, without mail
- `grant_or_mail` of a change source whose `add_items` with the same `once_key` is already applied is `AlreadyApplied`, and balance, mail and `item_mails` are unchanged
- `grant_or_mail` of a list longer than `mailbox.maxAttachments` creates, without `INVALID_INPUT`, one mail and one `ItemMail` per chunk and holds every item of the chunks. The second call with the same change source creates no more mail and returns the same mail ID list
- After content calls `send_mail` with `once_key` `gift:2`, when `grant_or_mail` of a list of `mailbox.maxAttachments` + 1 items with `once_key` `gift` gets `LIMIT_EXCEEDED` from `add_items`, the result is `INVALID_INPUT`, there is no new mail, `ItemMail` or `mailbox_once_key` row, and one `error` log line is left
- `cancel_mail_by_once_key` deletes the two mails that `grant_or_mail` sent in two chunks, returns the `attachments` of the two mails in mail ID ascending order and creates a `MailUserState` delete delta. A claimed mail is not in the list. After that, `grant_or_mail` with the same `once_key` does not create the mail again
