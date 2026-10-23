# p2p-signaling

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

Gives connection information (STUN, relay) so that match participants make P2P connections with each other, passes signaling frames between participants only within the same match, and takes the rejoin of disconnected participants. Does not handle realtime messages.

## dependency

- `server-time`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `prepare_transport` | `match_id`, `start_at`, `max_duration` | async operation. `Transport` | none. A relay issue failure gives a `Transport` with empty `relays` | `matchmaker` |
| `open_match_session` | `match_id`, `players`(list of `MatchPlayer`), connection per participant, `Transport`, `expires_at` | list of participant changes | none. Throws when a session of that `match_id` already exists, the same connection appears twice, or the connection count differs from the `players` count | `matchmaker` |
| `handle_frame` | connection, `MatchmakerFrame` | participant change or none | none. A frame that does not meet the conditions is dropped and none is returned | `matchmaker` |
| `connection_closed` | connection | participant change or none | none | `matchmaker` |

- connection: an authenticated `/realtime` WebSocket that `matchmaker` passes. In TypeScript it is `{ user_id: bigint; send(frame: MatchmakerFrame): void; close(): void }`, and connections are told apart by object identity
- connection per participant: list of connections in the same order as `players`. The `index` of the i-th element of `players` is i
- `Transport`(base proto message): `TransportKind kind`, `repeated string stun_urls`, `repeated TransportRelay relays`
- `TransportRelay`(base proto message): `string url`, `string username`, `string credential`, `int64 expires_at`
- `TransportKind`(base proto enum): `P2P`
- `expires_at`(match session): `start_at` + `max_duration`
- participant change: `match_id`, `index`, `kind`. `kind` is `LEFT` (left the session by `MATCH_LEAVE`, or left the previous session because the connection was bound to a new session), `DISCONNECTED` (left the session because the connection closed) or `REJOINED` (bound again by `MATCH_REJOIN`)

### frame

Of the `MatchmakerFrame` of `matchmaker`, this module handles `PEER_SIGNAL`, `MATCH_LEAVE`, `MATCH_REJOIN`, `MATCH_REJOINED`, `PEER_LEFT`, `PEER_REJOINED`.

## behavior

### transport

- A P2P connection is a WebRTC data channel, and all participants connect to each other. Each P2P connection has one channel for each of `Reliable` and `Unreliable` of `RealtimeChannel`. The P2P transport of `RealtimeCore` decides the `payload` format, the side that sends the offer, and the choice between direct connection and relay
- The server does not interpret `payload` or the data of P2P connections. The relay only relays the encrypted channel
- `prepare_transport`
  - `stun_urls` is `p2p-signaling.stunUrls`. In LOCAL it is an empty list
  - `relays` are the short-lived credentials that the `turn` adapter issues per match. `expires_at` is `start_at` + `max_duration`
  - When the adapter call takes more than `p2p-signaling.turnTimeoutMs` or fails, empties `relays` and leaves a `warn` log. Match creation continues
- The transport touches the messages of `realtime.proto`, the matching of `matchmaker` and the match result judgement only through the four operations of this module (`prepare_transport`, `open_match_session`, `handle_frame`, `connection_closed`). So replacing it with a module of another `TransportKind` does not change those three

### match session

- A match session holds the signaling state of one match. Keeps `match_id`, `players`, the bound connection or none per index, the set of left indices, `Transport` and `expires_at` in the memory of the server instance. A restart clears it
- left index: the index of a participant who left the session by `MATCH_LEAVE`, or whose connection was bound to a new session and so left the session. It stays a left index until the session is deleted
- `open_match_session` binds each participant's connection to that participant's index
- One connection is bound to only one match session. Binding a connection already bound to another session to a new session is handled the same as that user sending `MATCH_LEAVE` to the previous session: removes it from the previous session and sends `PEER_LEFT` to the other bound participants of the previous session. `open_match_session` returns a `LEFT` participant change of the previous session for each connection removed that way
- Job `p2p_session_sweep` (interval `p2p-signaling.sweepIntervalMs`), which p2p-signaling sets with `server-time.schedule_job` at server start, deletes sessions without a bound connection and sessions with `expires_at` ≤ `clock_now`

### PEER_SIGNAL

When all of the below hold, sends the frame to the target participant's connection; otherwise drops it.

- the sending connection is bound to a session
- `index` is 0 or more and less than the participant count, and is not the sending participant's index
- a connection is bound to the target index
- the `payload` length is 1 or more and `p2p-signaling.maxPayloadBytes` or less

When sending, replaces `index` with the sending participant's index. `payload` stays as it is.

### leave and rejoin

- `MATCH_LEAVE`: when the sending connection is bound to the session of that `match_id`, removes it and sends `PEER_LEFT` to the other bound participants. Otherwise drops the frame
- `connection_closed`: removes the connection from the session it is bound to. Sends `PEER_LEFT` to the other bound participants
- `MATCH_REJOIN`: when all of the below hold, binds the sending connection to that user's index (another connection bound to that index is removed from the session without `PEER_LEFT`), sends `MATCH_REJOINED` (`match_id` is the `match_id` of the request, `ok` `true`, `my_index` is that user's index, `players` is the session's `players`, `transport` is the session's `Transport`, `left_indices` is the list of the session's left indices in ascending order) to the sending connection, and sends `PEER_REJOINED` to the other bound participants
  - a session of that `match_id` exists
  - the sending user is in `players`
  - `clock_now` < `expires_at`
  - that user's index is not a left index
  - the sending connection is not bound to another match session
- When any one is violated, sends `MATCH_REJOINED` (`match_id` is the `match_id` of the request, `ok` `false`, `my_index` 0, `players` empty list, `transport` empty, `left_indices` empty list)
- A rejoined participant makes P2P connections with the other participants again

### real adapter

| adapter key | real adapter |
|---|---|
| `turn` | `turn-coturn` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `none` | the relay is a coturn server that the operator starts, and it does not save relayed packets | `turn-coturn` | `none` | `none` | `none` | `none` | `none` | `none` | `none` |

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| `PEER_SIGNAL`, `MATCH_LEAVE` that do not meet the conditions | dropped | `debug` |
| rejoin condition violation | `MATCH_REJOINED`(`ok` `false`) | none |
| `turn` adapter failure, time limit exceeded | `Transport` with empty `relays` | `warn` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `p2p-signaling.stunUrls` | array<string> | core | content | list of STUN server URLs given to the client |
| `p2p-signaling.turnTimeoutMs` | integer | core | content | time limit of a `turn` adapter call. 1 or more |
| `p2p-signaling.maxPayloadBytes` | integer | core | content | maximum bytes of a `PEER_SIGNAL` `payload` |
| `p2p-signaling.sweepIntervalMs` | integer | core | content | match session cleanup interval. 1 or more |
| `environments.<ENV>.secrets.turn` | string | game | none | secret name in the host secret store that holds the coturn `static-auth-secret` of `turn-coturn` |
| `environments.<ENV>.turnCoturn.urls` | array<string> | game | none | list of coturn relay URLs. The scheme is `turn` or `turns` |
| `environments.<ENV>.adapters.turn` | string? | game | none | relay adapter name. When absent, this environment has no relay adapter |

- Key `turn` of the per-environment `adapters` of game settings chooses the relay adapter. The values are `fake` and `turn-coturn`. When the key is absent, the adapter is not called, `relays` is an empty list and no log is left. `turn-coturn` makes, without a network call, TURN REST API style short-lived credentials of a self-operated coturn server. One relay per URL of `environments.<ENV>.turnCoturn.urls`; `username` is `<quotient of expires_at divided by 1000>:<match_id>`, and `credential` is the HMAC-SHA1 of `username` keyed with secret `environments.<ENV>.secrets.turn`, written in standard base64. `fake` returns the relay list set by the `testing.fake` controller, and an empty list when none is set
- The operation name of the fake adapter controller is `issue_relays`. `set_result` sets a list of `{url, username, credential}` (all strings), and `input` of `calls()` is `{match_id, expires_at}`. p2p-signaling writes the `expires_at` of a relay regardless of the adapter result

## data

none

## DEV

none

## test

- A `PEER_SIGNAL` sent by a participant goes only to the target participant, the received `index` is the sending participant's index, and `payload` is the same
- A `PEER_SIGNAL` for a participant of another match, an out-of-range index, the sender's own index, an empty `payload` or a `payload` over the limit goes to no one
- After `MATCH_LEAVE` and after a connection close, the other participants get `PEER_LEFT`, and a `PEER_SIGNAL` to the participant who left is dropped
- When a participant whose connection closed sends `MATCH_REJOIN` on a new connection, `match_id` of `MATCH_REJOINED` is the `match_id` of the request, `ok` is `true`, `my_index` is that participant's index, `players` and `transport` equal those of `MATCH_FOUND`, `left_indices` is an empty list, and the other participants get `PEER_REJOINED`
- In a three-participant match, when index 2 sends `MATCH_LEAVE`, the connection of index 1 closes, and then index 1 sends `MATCH_REJOIN` on a new connection, `left_indices` of `MATCH_REJOINED` is [2]. An index that left the previous session because its connection was bound to a new match is also in `left_indices` of the previous session
- `MATCH_REJOIN` from a participant who sent `MATCH_LEAVE`, from a user who is not a participant, or for a match past its `expires_at` is `ok` `false`, with `match_id` the `match_id` of the request, `my_index` 0, and `players` and `left_indices` empty lists
- A connection bound to a new match leaves the previous session, the participants of the previous session get `PEER_LEFT`, and `open_match_session` returns the `LEFT` participant change of that index of the previous session. `MATCH_REJOIN` that the user sends to the previous match is `ok` `false`
- `MATCH_REJOIN` sent by a connection bound to another match session is `ok` `false`; that connection stays bound to the session it was bound to, that index of the requested session does not change, and there is no participant change
- The `turn` adapter is called once per match, the relays that the `fake` controller sets differently per match are the `relays` of that match, and `expires_at` is `start_at` + `max_duration`
- When the `turn` adapter fails or takes more than `p2p-signaling.turnTimeoutMs`, `prepare_transport` returns a `Transport` with empty `relays` and leaves a `warn` log
- When there is no `environments.<ENV>.adapters.turn`, `prepare_transport` does not call the adapter, returns a `Transport` with empty `relays` and leaves no log
- A session that all participants left and a session past its `expires_at` are deleted
- `MATCH_LEAVE`, a connection close and a successful `MATCH_REJOIN` return a `LEFT`, `DISCONNECTED` and `REJOINED` participant change respectively, and a connection not bound to a session returns none
