# cheat

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

In an environment that includes DEV code, handles cheat requests with which QA, bot playtest and the automation channel change UserState and server time to given values. This whole module is DEV code.

## dependency

- `storage`
- `server-time`

cheat does not depend on `routing`. The DEV code of `routing` collects cheat handlers and handles cheat requests in the processing order of this spec

## API

none

## behavior

- The body of a cheat request is the protobuf bytes of the cheat request message, and the response is `ResponseEnvelope`. The path table of `routing` decides the path

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `X-Ogw-Dev-Access` is missing or differs from the dev access value, client IP outside `environments.DEV.devAllowedCidrs` | `UNAUTHORIZED`. Does not read the body | `UNAUTHORIZED` | `security` log(`reason` `dev_access`) |
| unknown cheat name | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| the time resulting from `SetTimeOffset` is out of range | `INVALID_REQUEST` | `INVALID_REQUEST` | none |
| unknown kind in `SetUserState`, invalid JSON, JSON key that is not a field of the kind message, value that does not match the kind | `INVALID_REQUEST` | `INVALID_REQUEST` | none |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `routing.maxBodyBytes` | integer | core | content | byte limit of the `kind` and `value_json` fields of core cheats |
| `environments.<ENV>.secrets.devAccess` | string? | game | none | name of the secret that holds the dev access value. Exists only in DEV; when `null`, that environment has no dev access value |
| `environments.<ENV>.devAllowedCidrs` | array<string>? | game | none | CIDR list of the client IPs from which the DEV server accepts cheat requests. When `null`, it does not block by IP |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_cheat_handler` | cheat name, cheat handler | none | none. A registration error is a server start failure | `registerDev` of content `server/dev/main.ts` |
| `list_cheat_handlers` | none | list of elements, one per core cheat and per cheat content registered, each with `name`(cheat name), `request_name`(request name), `core`(`true` for a core cheat), `rpc`(that `rpc` item of `CoreCheatContract.RPCS` or `GameCheatContract.RPCS`), `handler`(cheat handler) | none | `routing` DEV code |
| `get_time_offset` | user ID, DB handle | offset ms. 0 when there is none | none | `server-time`. cheat registers it at server start with `server-time.register_offset_provider` |
| `SetTimeOffset` (core cheat). changes: none | `offset_ms` | empty response | `INVALID_REQUEST` | `routing` DEV code. client `QACore`, bots and `testing` send it |
| `SetUserState` (core cheat). changes: `content` | kind name, item ID, `value_json` | empty response. The changed item is in the delta | `INVALID_REQUEST` | `routing` DEV code. client `QACore`, bots and `testing` send it |
| `DeleteUserState` (core cheat). changes: `content` | kind name, item ID | empty response. The deleted item is in the delta | `INVALID_REQUEST` | `routing` DEV code. client `QACore`, bots and `testing` send it |

- cheat handler: input is ctx and the cheat request message, output is the cheat response message or `GameError`. The output of a core cheat handler also includes `CoreError`. The type of a content cheat handler is `GameCheatContract.<Name>Handler`, which the contract tool generates per `rpc` of `service Cheat` in `contract/cheat.proto`. The type of a core cheat handler is decided by the module that defines that core cheat
- When an `rpc` of `service Cheat` has no handler, or there is an unknown name, a duplicate registration or a registration after `registerDev` has ended, the server does not start
- Core cheats that other core modules add are the operations marked `(core cheat)` in the `## DEV` table of that module's spec. The DEV code of `routing` collects them, and the path table of `routing` decides the path
- `## DEV` operations of a core module that are not `(core cheat)` are not cheats. The caller column of that operation decides who calls it

core cheat request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SetTimeOffsetRequest` | `offset_ms` | `int64` | `min`: −2^63, `max`: 2^63−1 |
| `SetUserStateRequest` | `kind` | `string` | `max_len_key`: `routing.maxBodyBytes` |
| `SetUserStateRequest` | `item_id` | `int64` | `min`: 0, `max`: 2^63−1 |
| `SetUserStateRequest` | `value_json` | `string` | `max_len_key`: `routing.maxBodyBytes` |
| `DeleteUserStateRequest` | `kind` | `string` | `max_len_key`: `routing.maxBodyBytes` |
| `DeleteUserStateRequest` | `item_id` | `int64` | `min`: 0, `max`: 2^63−1 |

### dev access

On a server instance that includes DEV code, the DEV code of `routing` checks the items below before it reads the body of a cheat request (`DevLogin` included). When any one is violated, it does not read the body, answers `UNAUTHORIZED` and leaves a `security` log(`reason` `dev_access`).

- Header `X-Ogw-Dev-Access` equals the dev access value. The comparison is constant-time. The dev access value is the value of secret `environments.DEV.secrets.devAccess` when `--env` is `DEV`; for a LOCAL server and the test server of `testing`, it is the value of key `devAccess` in the file of server start argument `--secret-file`
- When `--env` is `DEV` and game settings `environments.DEV.devAllowedCidrs` is not `null`, the client IP that `routing` decided is in one of those CIDRs
- The dev access value and the header value are not written to the log

### processing order

The DEV code of `routing` handles cheat requests other than `DevLogin` in the request processing order of `routing`, with only the differences below.

- Skips step 4 maintenance, step 6 ban, step 7 data version, step 9 kill switch and step 12 request start
- Step 8 rate limit uses the same user counter as game requests
- Steps 10 and 11 decode into the cheat request message and run the validator
- Step 15 calls the cheat handler inside `storage.with_hook_change_source`(ctx, `Cheat`, cheat name). The change source of items content changes inside it is source `Cheat`, ref cheat name
- `DevLogin` gets the handling `routing` defines for `NoAccessTokenRpc`. The other cheats need a session

### rules

- The target of a cheat is only the user of the access token. No input points to another user
- `SetTimeOffset`: sets that user's cheat time offset to `offset_ms`. It does not add. The offset is kept in table `cheat_time_offset`(scope `user`, column `user_id`(`int64`), `offset_ms`(`int64`), key `user_id`, snapshot flag `false`), registered with `storage.register_table`. `INVALID_REQUEST` when `clock_now` + `offset_ms` is less than 0 or is 2^63 or more. The offset enters the request time from the next request. The `ResponseEnvelope.server_time_at` of this response is the value the DEV code of `routing` decides after commit with `server-time.user_now`(user ID, `storage.read_db`): `clock_now` at response time + the new `offset_ms`
- `SetUserState`: decodes `value_json` with the proto3 JSON mapping of that kind message and writes the item as exactly that value. It does not add. For a list kind, the `id` in the JSON must equal the item ID. Integer fields take ID values
- `DeleteUserState`: deletes that item. For an item that does not exist, it does nothing
- Core kinds (UserState kinds that core defines. e.g. `ItemBalanceUserState`) are not changed with `SetUserState` or `DeleteUserState`; that is `INVALID_REQUEST`. When the owner module has a core cheat or DEV operation that changes that kind, the kind is changed with it. A content cheat handler calls the DEV operation. When there is none, that state is made with the core `rpc` of the owner module and `SetTimeOffset`
- Changed UserState goes into the delta of that response
- For each cheat request other than `DevLogin` that passed the dev access check and step 5 authentication of the request processing order of `routing`, the DEV code of `routing` leaves one `audit` log line with `logging.write`: `request`(request name), `user_id`, `args`(the `to_json()` value of the cheat request message class. `null` for a request that could not be decoded), `result`(error code, 0 for success). `DevLogin` leaves the same line for each request that passed the dev access check, and `user_id` is the logged-in user ID, or 0 when login failed
- Cheat requests rejected before that and cheat requests rejected by the rate limit leave no `audit` log. The log of those rejections is decided by the dev access section and the request processing order of `routing`

## test

- In STG and PROD, a `POST` request to a cheat path is `UNAUTHORIZED` and a `security` log is left
- On a `LOCAL` test server, a cheat request and `DevLogin` without `X-Ogw-Dev-Access` or with a value different from the dev access value are `UNAUTHORIZED`, a `security` log is left, and the handler is not called. With the same value, they are handled. The log does not contain the dev access value
- In DEV, one `audit` log line is left for each cheat request that passed the dev access check and authentication. A cheat request with a wrong `X-Ogw-Dev-Access` and a cheat request with a wrong access token have no `audit` log and leave a `security` log
- The `audit` log `args` of a cheat request with an enum field holds that field as the enum value name and an `int64` field as a decimal string
- When game requests and cheat requests together go over the user counter limit, cheat requests are also `RATE_LIMITED`, and UserState and the offset do not change
- Cheat requests other than `DevLogin` are handled also during maintenance, ban and kill switch. `DevLogin` during maintenance is `MAINTENANCE`, and `DevLogin` of a banned user is `BANNED`
- After `SetTimeOffset`, the request time of a request is clock + offset, and an out-of-range offset is `INVALID_REQUEST`
- The `server_time_at` of the `SetTimeOffset` response is clock + the new offset, and the next request signed with that `server_time_at` as timestamp passes
- `SetUserState` writes the value exactly and puts it in the delta. JSON that does not match the kind and core kinds are `INVALID_REQUEST`
- After a `GameError` or an exception of a cheat handler, the saved state does not change
- The `ItemChange` and history of `item-ledger.add_items` called by a content cheat handler are source `Cheat`, ref cheat name
- A cheat request whose signature name leaves out `cheat/` is `UNAUTHORIZED`
- When a handler of `service Cheat` is missing, the server does not start
