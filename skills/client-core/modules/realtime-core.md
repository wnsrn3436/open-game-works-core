# RealtimeCore

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

Handles, for a game where several users play together in one match: matching, rooms and parties for gathering with friends, connections between participants, sending and receiving realtime message bytes, match time, disconnection and leaving. A replaceable transport handles connections; RealtimeCore and realtime messages do not know the transport.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `DataCore`, `AuthCore`, `NetworkCore`

- server dependency: `matchmaker`, `p2p-signaling`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_transport` | transport | none | none | `BootstrapCore`(`InitModules`), test |
| `join_match` | match mode ID value | async operation. `MatchJoinResult` | `MatchJoinResult` with `status` `Failed` | content code |
| `rejoin_match` | match ID | async operation. `MatchJoinResult` | `MatchJoinResult` with `status` `Failed` | content code |
| `saved_match_id` | none | match ID of the match saved in `LocalDataCore` | empty string | content code |
| `leave` | none | none | none | content code, `QACore` |
| `end_match` | none | none | none | content code |
| `match_state` | none | `MatchState` | `None` | all code |
| `match_info` | none | `MatchInfo` | empty `MatchInfo` | all code |
| `peer_state` | participant index | `PeerState` | `Left` | all code |
| `match_time_ms` | none | match time (ms) | int64 minimum | all code |
| `send` | target (participant index or `All`), `RealtimeChannel`, message bytes | success flag | `false` | content code |
| `create_room` | match mode ID value | async operation. `RoomResult` | `RoomResult` with `ok` `false` | content code |
| `join_room` | room code | async operation. `RoomResult` | `RoomResult` with `ok` `false` | content code |
| `leave_room` | none | none | none | content code |
| `kick_room_member` | user ID | success flag | `false` | content code |
| `start_room` | none | async operation. `MatchJoinResult` | `MatchJoinResult` with `status` `Failed` | content code |
| `wait_match` | none | async operation. `MatchJoinResult` | `MatchJoinResult` with `status` `Failed` | content code |
| `room_info` | none | `RoomInfo` | empty `RoomInfo` | all code |

- `set_transport` is called before `init`. `BootstrapCore` passes a P2P transport made with the server URL and app version of build info and the relay-only flag `BootstrapCore` decided, or that transport wrapped in a network simulation transport or a lockstep transport. `BootstrapCore` decides which one it passes. A call after `init` leaves an error log and is ignored. Calling `join_match`, `rejoin_match`, `create_room`, `join_room`, `start_room` without a transport gives an error log and a failure
- The caller does not change the returned `MatchInfo` and `RoomInfo` or the message bytes it passed. After `send` returns, the caller may reuse the bytes it passed

| type | element |
|---|---|
| `MatchState` | `None`: no match. `Matching`: after `join_match` or `start_room`, or after the room's match started, before the match is made. `Connecting`: after the match is made, before connecting to all participants. `Playing`: after all are connected, before the end |
| `PeerState` | `Waiting`: in `Connecting`, not connected yet. `Connected`: connected. `Disconnected`: disconnected in `Playing`, waiting for reconnection. `Left`: left the match. Does not return to another state |
| `RealtimeChannel` | `Reliable`: guarantees arrival and order. `Unreliable`: guarantees neither. Order is the order in which one participant sent on one channel |
| `MatchJoinResult` | `status`(`Success`, `Cancelled`, `Failed`), `fail_reason`(`MatchFailReason` of server `MATCH_FAILED`. Otherwise `MATCH_FAIL_REASON_UNSPECIFIED`), `error_code`(error code of `REJECTED`, error code of room failed, error code of matchmaker lost received in `Matching` or `Connecting`. Otherwise 0) |
| `RoomResult` | `ok`, `error_code`(error code of room failed or matchmaker lost. Otherwise 0) |
| `RoomRequest` | the request that caused room failed. `Open`: `create_room`, `join_room`. `Kick`: `kick_room_member`. `Start`: `start_room`. `Match`: `join_match` of the host in a room |
| `RoomChangeReason` | `Updated`: room information changed. `Left`: left with `leave_room`. `Kicked`: the host kicked this user out. `Lost`: the matchmaker connection was lost, so this user dropped out of the room |
| `MatchEndReason` | `Ended`, `Left`, `BackgroundTimeout` |
| `PeerLeaveReason` | `Ended`, `Left`, `Timeout` |

- `MatchInfo`: match ID (string), match mode ID value, own participant index, participant user ID list (index order), team list (index order), party list (index order), match seed (`int64`), match start time (Unix ms), lockstep flag. These are `match_id`, `mode_id`, `my_index`, the `user_id`, `team`, `party` of `players`, `seed`, `start_at`, `lockstep` of server `MATCH_FOUND`. An empty `MatchInfo` has an empty string as match ID and 0 participants
- `RoomInfo`: room code, match mode ID value, member user ID list (join order. The first user is the host), `RoomStatus`. These are the values of server `ROOM_STATE`. An empty `RoomInfo` has an empty string as room code and 0 members
- `MatchFailReason`, `RoomStatus`: enums of the base proto. `matchmaker` defines their meaning

## behavior

### transport

The transport handles the matchmaker connection and the connections between participants and carries only bytes. To move to a server-authoritative realtime server, a transport with the same interface is added.

| transport operation | input | output |
|---|---|---|
| `start_matching` | match mode ID value, access token, lockstep flag | none |
| `cancel_matching` | none | none |
| `rejoin` | match ID, access token | none |
| `connect_peer` | participant index | none |
| `send_packet` | participant index, `RealtimeChannel`, packet | success flag |
| `close_peer` | participant index | none |
| `close` | none | none |
| `disconnect` | none | none |
| `poll` | none | none |
| `open_room` | match mode ID value when creating, room code when joining, access token, lockstep flag | none |
| `leave_room` | none | none |
| `kick_room_member` | user ID | none |
| `start_room` | none | none |
| `lockstep_time` | none | lockstep match time (ms) or none |

| transport notification | payload |
|---|---|
| match found | `MatchInfo` |
| match failed | `MatchFailReason`, error code |
| matchmaker lost | error code. When `CLOSE` was received, its `code`; when it was not received and the WebSocket close code is 4000 and the reason is a decimal integer, that value; otherwise 0. The server closes right after `CLOSE`, so the code remains even when the engine discards a `CLOSE` frame that arrived at the same time as the close |
| rejoined | success flag, list of indexes of participants who left |
| peer connected | participant index |
| peer lost | participant index. Disconnected after connecting, or `connect_peer` failed |
| packet received | participant index, `RealtimeChannel`, packet |
| room updated | `RoomInfo` |
| room failed | error code, `RoomRequest` |
| room kicked | none |

- The transport raises notifications only inside `poll`. match found comes once per match
- RealtimeCore judges time limits. The transport does not
- The transport does not raise peer connected or peer lost for a participant index closed with `close_peer` until `close` or `disconnect`
- Connection addresses and NAT traversal information stay only inside the transport. They are not put in `MatchInfo`, events or logs
- RealtimeCore calls `poll` once per frame and handles the received notifications in the order received. It also calls it during `TimeCore` pause. When `MatchState` becomes `None` inside `poll`, the remaining notifications are discarded
- RealtimeCore passes `false` as the lockstep flag of `start_matching` and `open_room`. The lockstep transport changes that value
- `lockstep_time` of the P2P transport is always none

### P2P transport

Uses the `MatchmakerFrame` of server `matchmaker` and `p2p-signaling`. Receives the server URL, app version and relay-only flag when made.

- matchmaker connection: `<server URL>/realtime` WebSocket (scheme `https` becomes `wss`, `http` becomes `ws`). Sends the first frame `HELLO` (access token, data version from `DataCore.get_data_version`, app version of build info. Empty string in a dev run) and sends the next frame after receiving `HELLO_ACK`. On receiving `CLOSE`, raises matchmaker lost with its `code`; when the connection is lost without `CLOSE`, with error code 0
- `start_matching`: connects when there is no matchmaker connection, then sends `MATCH_REQUEST`(`mode_id`, `lockstep`). `cancel_matching`: `MATCH_CANCEL`. `MATCH_FOUND` is match found, `MATCH_FAILED` is match failed (`reason`, `error_code`)
- `open_room`: connects when there is no matchmaker connection, then sends `ROOM_CREATE`(`mode_id`, `lockstep`) when creating and `ROOM_JOIN`(`room_code`, `lockstep`) when joining. `kick_room_member`: `ROOM_KICK`(`user_id`). `start_room`: `ROOM_START`. `leave_room`: sends `ROOM_LEAVE` and closes the matchmaker connection when not in a match. `ROOM_STATE` is room updated, `ROOM_FAILED` is room failed (`error_code`. `Open` when `request` is `ROOM_CREATE` or `ROOM_JOIN`, `Kick` when `ROOM_KICK`, `Start` when `ROOM_START`, `Match` when `MATCH_REQUEST`), `ROOM_KICKED` is room kicked. After room kicked, closes the matchmaker connection when not in a match
- `rejoin`: on a new connection, `MATCH_REJOIN`(`match_id`) after `HELLO`. `ok` of `MATCH_REJOINED` is the success flag of rejoined, and `left_indices` is the list of indexes of participants who left
- `close`: sends `MATCH_LEAVE` for that match and closes all P2P connections. When not in a room, also closes the matchmaker connection
- `disconnect`: closes all P2P connections and the matchmaker connection without sending `MATCH_LEAVE`. So a restarted app can `rejoin` with the saved `MatchInfo`
- A P2P connection is a WebRTC data channel. Each participant pair has one connection with two channels: `Reliable` is ordered and reliable, `Unreliable` is unordered with 0 retransmits
- The ICE servers are `stun_urls` and `relays` (TURN) of `transport` of `MATCH_FOUND` or `MATCH_REJOINED`. Without relay-only, WebRTC ICE chooses between direct connection and relay
- relay-only: when the relay-only flag received when the P2P transport was made is `true`, it connects only through relay. It removes `a=candidate:` lines whose candidate type is not `relay` from the SDP of the offers and answers it sends, and does not send ICE candidates whose candidate type is not `relay`. It removes and discards the same from received SDP and ICE candidates. The candidate type is the token after `typ` in the candidate string. So a participant's network address does not reach other participants
- In relay-only, when `relays` of `transport` of `MATCH_FOUND` is empty, sends `MATCH_LEAVE` and raises match failed (`CREATE_FAILED`, error code 0). When `relays` of `MATCH_REJOINED` is empty, raises a rejoined failure
- Of the two participants, the one with the smaller index sends the offer. Offer, answer and ICE candidate are put as UTF-8 JSON in `payload` of `PEER_SIGNAL`. Offer and answer are `{"type": "offer"|"answer", "attempt": <connection attempt number>, "data": "<SDP>"}`, an ICE candidate is `{"type": "candidate", "attempt": <connection attempt number>, "data": "<candidate string>", "mid": "<media stream ID>", "index": <m-line index>}`
- connection attempt number: the side that sends the offer increments it by one, starting from 1, each time it starts a new P2P connection with that participant. The side that receives the offer uses the number of the received offer as the number of that connection and puts it in its answer and candidates. A signal whose number differs from the current connection's number is discarded with a warn log: an answer or candidate of a previous attempt that arrives late after a restarted offer does not enter the new connection. When the side that receives the offer receives an offer with a larger number than the current connection, it drops the current connection and makes a new connection with that offer; an offer with a smaller or equal number is discarded with a warn log. The first offer received after that participant's `PEER_REJOINED` is accepted the same way regardless of its number: a participant who restarted the app counts the number from 1 again. The server removes the previous connection from the rejoined index, so a signal of the previous connection does not come after `PEER_REJOINED`. While a connected connection is replaced with a new connection, the participant state does not change
- malformed `payload`: not a JSON object, `type` outside `offer`, `answer`, `candidate`, `attempt` not an integer of at least 1 and less than 2^53, `data` not a string, `type` is `candidate` but `mid` is not a string or `index` is not an integer of at least 0 and less than 2^53. A malformed `payload` is discarded with a warn log
- `PEER_SIGNAL` of a participant received before `connect_peer` is collected per participant index in the order received, and is handled in the order received at `connect_peer` for that index. For that index, `close_peer`, `close` and `disconnect` discard the collected signals
- Server `PEER_LEFT` and `PEER_REJOINED` do not change participant state. Participant state is set only by P2P connections and leave notices. On receiving `PEER_REJOINED`, when that index was not closed with `close_peer` and there is no connected P2P connection with that participant, the transport drops any P2P connection being made with that participant without peer lost and starts a new connection the same as `connect_peer`. Of the two participants, the one with the smaller index sends the offer. When there is a connected P2P connection with that participant, the side that sends the offer drops that connection and starts a new connection with the next number, and the side that receives the offer only changes the number check of the next offer: the restarted app does not continue the previous connection. `PEER_SIGNAL` of an index closed with `close_peer` is discarded until `close` or `disconnect`

### packet

- The first byte of a packet is the kind. `0` is realtime message, `1` is control message
- realtime message packet: from the second byte, the message bytes content code passed. The length is at least 1 and at most `RealtimeCore.messageMaxBytes`
- control message: sent only on `Reliable`. A leave notice is 3 bytes `[1, 1, reason]`, and reason is `1` = `Left`, `2` = `Ended`. A control message whose second byte is `2`, `3`, `4` is a lockstep notification of the lockstep transport
- Sending and receiving reuse bytes buffers instead of making new ones each frame

### join_match

1. When `MatchState` is not `None`, leaves a warn log and is `Failed` at once. The state does not change
2. Changes to `Matching`, waits for `AuthCore.get_access_token` and calls `start_matching` with that access token
3. On receiving match found, checks `MatchInfo`. When the check catches it, this is a failure
4. Changes to `Connecting` and calls `connect_peer` for each other participant
5. When all other participants are `Connected`, changes to `Playing` and is `Success`

- `MatchInfo` check: fails when one of these holds: match ID is an empty string, fewer than 2 participants, own index outside the list, a user ID of 0 or less or a duplicate user ID, the user ID at own index differs from the user ID of `AuthCore`, the length of the team list or party list differs from the participant count
- failure: no transport, no access token, matchmaker lost in `Matching` or `Connecting` (fills `error_code`), match failed (fills `fail_reason`, `error_code`), room failed that this operation receives in `Matching` (fills `error_code`), `MatchInfo` check failure, not all connected within the connect time limit (`RealtimeCore.connectTimeoutMs`) after becoming `Connecting`, leave notice received in `Connecting`, background elapsed time at least `RealtimeCore.backgroundTimeoutMs`
- On failure, calls `close`, changes to `None`, and `status` is `Failed`
- A participant whose peer lost is received in `Connecting` is set to `Waiting` and `connect_peer` is called again. The connect time limit is not restarted
- match found received outside `Matching` and `Connecting` is discarded with a warn log. match found that a non-host member of a room receives in `None` is not discarded
- `MatchInfo` does not change until the match ends. `match_info` returns `MatchInfo` in `Connecting` and `Playing`, and an empty `MatchInfo` without log in other states
- In `Connecting` and `Playing`, `peer_state` returns `Connected` without log for own index, and that participant's state for another participant's index
- Content code uses the match seed as the base of `UtilCore.make_purpose_seed`. RealtimeCore does not make random instances

### rejoin_match

- On becoming `Connecting`, writes `MatchInfo` to the `user` file of `LocalDataCore`. On becoming `None` for a reason other than `release`, deletes it
- `saved_match_id` returns the saved match ID. When there is none, an empty string without log
- `rejoin_match` enters the saved match again after the app ended and restarted

1. When `MatchState` is not `None`, when in a room, while waiting for `create_room`, `join_room`, or when the match ID is an empty string or differs from the saved match ID, leaves a warn log and is `Failed` at once. The state does not change
2. Checks the saved `MatchInfo` with the `MatchInfo` check. When caught, deletes the saved `MatchInfo` and fails. When it passes, uses the saved `MatchInfo` as the `MatchInfo` of this match
3. Changes to `Connecting`, waits for `AuthCore.get_access_token` and calls transport `rejoin` with that access token
4. When rejoined succeeds, changes the other participants in the list of indexes of participants who left to `Left` without events, calls `close_peer` for each of those indexes, then calls `connect_peer` for each other participant that is not `Left`. When rejoined fails, this fails
5. When all other participants that are not `Left` are `Connected`, changes to `Playing` and is `Success`. When there is no such participant, `Playing` and `Success` come right after step 4

- The failure cases and their handling, peer lost in `Connecting` and the connect time limit are the same as `join_match`

### room

A room is a room of server `matchmaker`. It is used to enter the same match with friends. `### room` of `matchmaker` defines the room capacity and the error codes of room failed.

- Being in a room means `RoomInfo` is not empty
- `create_room`, `join_room`: when in a room, while waiting for `create_room`, `join_room`, or when `MatchState` is not `None`, leaves a warn log and `ok` is `false` at once. Otherwise waits for `AuthCore.get_access_token` and calls transport `open_room` with that access token. Sets `RoomInfo` from the first room updated received, raises `RoomChangedEvent`(`Updated`) and is `ok`. When room failed of `Open` or matchmaker lost is received first, `ok` is `false` with that error code
- While in a room, each room updated received changes `RoomInfo` and raises `RoomChangedEvent`(`Updated`). room updated and room kicked received when not in a room and not waiting for `create_room`, `join_room` are discarded without log
- `leave_room`: when not in a room and not waiting for `create_room`, `join_room`, only leaves a warn log. When waiting, calls transport `leave_room` and ends the pending `create_room`, `join_room` with `ok` `false` and error code 0. It raises no event. When in a room, calls transport `leave_room`, empties `RoomInfo` and raises `RoomChangedEvent`(`Left`). When `MatchState` is `Matching`, calls `close`, changes to `None`, and the `status` of the pending `join_match`, `start_room`, `wait_match` is `Cancelled`
- On receiving room kicked, empties `RoomInfo` and raises `RoomChangedEvent`(`Kicked`). In `Matching`, `None` and `Cancelled` the same as `leave_room`
- On receiving matchmaker lost while in a room, empties `RoomInfo` and raises `RoomChangedEvent`(`Lost`). The handling of `MatchState` is the same as for matchmaker lost received when not in a room
- `kick_room_member`: when not in a room or not the host, a warn log and `false`. Otherwise calls transport `kick_room_member` and is `true`
- room failed is received by the in-progress async operation its `RoomRequest` points to. `Open` is the in-progress `create_room`, `join_room`; `Start` is the `Matching` this client started with `start_room`; `Match` is the `Matching` this client started with `join_match` in a room. room failed with no operation to receive it only leaves a warn log and does not change `MatchState` or `RoomInfo`. e.g. room failed of `Kick`, room failed of `Start` that a non-host member received because member rating resolution failed in the host's `start_room`
- `start_room`: when not in a room, not the host, or `MatchState` is not `None`, leaves a warn log and is `Failed` at once. Otherwise changes to `Matching` and calls transport `start_room`. The steps and failures after that are the same as steps 3 to 5 and the failures of `join_match`
- `join_match` of a host in a room enters the queue as a party. When the match mode differs from the match mode of `RoomInfo`, leaves a warn log and is `Failed` at once. `join_match` of a non-host member and `join_match` while waiting for `create_room`, `join_room` are also a warn log and `Failed` at once
- non-host member: on receiving room updated with `RoomStatus` `Matching` while `MatchState` is `None`, changes to `Matching` and raises `RoomMatchStartedEvent`. On receiving match found in `None` or `Matching`, raises `RoomMatchStartedEvent` when it has not been raised yet, and runs steps 3 to 5 of `join_match`. On receiving room updated with `RoomStatus` `Open` in `Matching`, changes to `None`, and the `status` of the pending `wait_match` is `Cancelled`. match failed and matchmaker lost are the same as a `join_match` failure
- `wait_match`: when `MatchState` is not `Matching` or `Connecting`, leaves a warn log and is `Failed` at once. Otherwise waits for the result of the current match. `Success` on becoming `Playing`, `Failed` on a failure the same as a `join_match` failure, `Cancelled` on cancellation
- `room_info` returns `RoomInfo` when in a room, otherwise an empty `RoomInfo` without log
- The room remains after the match ends

### matchmaker lost code

On receiving matchmaker lost, the module does the following with its error code before handling `MatchState` and the room.

- `TOKEN_EXPIRED`: when the transport operation that opened that matchmaker connection (`start_matching`, `open_room`, `rejoin`) has not been called again for this code, waits for `AuthCore.refresh_access_token`. When it succeeds and `MatchState` and the room did not change meanwhile, calls that operation once again with the same input and the received access token, and does not handle this matchmaker lost. When `MatchState` or the room changed meanwhile, that connection no longer exists, so this matchmaker lost is discarded regardless of the refresh result. Otherwise, when it has been called again or the refresh fails, it is handled as matchmaker lost
- `SESSION_REPLACED`, `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED`: calls `NetworkCore.notify_server_error`(error code) and handles it as matchmaker lost
- other codes: handled as matchmaker lost

### send and receive

- `All` of `send` calls `send_packet` once for each `Connected` participant except itself. When one fails, it still calls the rest, and it is `true` when all succeed
- A received packet is external input. The receive check checks a received packet in the order below and discards it on the first item that catches it: `MatchState` is not `Connecting` or `Playing` (log none), the sending participant is `Left` (log none), kind is not `0` or `1` (warn), control message that came on `Unreliable` (warn), length outside range (warn), malformed control message (warn)
- The bytes from the second byte of a realtime message packet that passed the receive check are passed to the `on_realtime_message` hook in the order received. Content code reads them with the generated `RealtimeMessage` decode and checks decode failure and the format and range of the contents
- pending queue: the list that keeps realtime messages received while there is no hook, as sending participant index, `RealtimeChannel` and a copy of the bytes, in the order received. When the pending queue holds `RealtimeCore.pendingMessageMax` messages, new messages are discarded and an error log is left once per match, the first time
- A `poll` with a hook passes the pending queue's messages to the hook in the order they were put in, before handling the transport's notifications, and empties the pending queue
- When `MatchState` becomes `None`, the pending queue is emptied
- Arrival is not guaranteed for messages sent after a disconnection and before reconnection, or right before `leave` or `end_match`

### disconnect, reconnect, leave

- On receiving peer lost of a `Connected` participant in `Playing`, changes it to `Disconnected`, raises `PeerDisconnectedEvent` and starts reconnection with `connect_peer`
- On receiving peer connected within the reconnect time limit (`RealtimeCore.reconnectTimeoutMs`) from the time it became `Disconnected`, changes to `Connected` and raises `PeerReconnectedEvent`. peer lost during reconnection restarts the reconnection, and the reconnect time limit is not restarted
- When the reconnect time limit passes, runs leave handling (reason `Timeout`)
- leave handling: changes to `Left`, calls `close_peer` and raises `PeerLeftEvent`. On receiving a leave notice in `Playing`, runs leave handling for the sending participant with the notice's reason
- peer connected and peer lost of a `Left` participant are discarded without log
- The match does not end even when all other participants leave. Content code decides whether to end it
- On receiving matchmaker lost in `Playing`, leaves a warn log and continues the match. When in-match rejoin is not running, starts in-match rejoin. matchmaker lost received during in-match rejoin is received by step 4 of in-match rejoin
- in-match rejoin: repeats the steps below. Stops when `MatchState` stops being `Playing`, and discards the rejoined it was waiting for
  1. Stops when the error code of the last matchmaker lost received is `SESSION_REPLACED`, `BANNED`, `MAINTENANCE`, `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED`
  2. Waits for the rejoin delay when this is not the first round
  3. Waits for `AuthCore.get_access_token`, calls transport `rejoin` with that access token and waits for rejoined or matchmaker lost. When there is no access token, treats it as matchmaker lost with error code 0 received
  4. Ends when rejoined succeeds. When rejoined fails, leaves a warn log and stops. On receiving matchmaker lost, leaves a warn log and goes to step 1
- rejoin delay: the first value is `NetworkCore.retryDelayMs`, and the next value is the smaller of previous value × `NetworkCore.retryDelayFactorPermille` ÷ 1000 rounded down and `NetworkCore.retryDelayMaxMs`. It is measured with `TimeCore` monotonic time. There is no limit on the repeat count
- When rejoined of in-match rejoin succeeds, runs leave handling (reason `Left`) for each participant in the list of indexes of participants who left that is not `Left`. After that, reconnection of `Disconnected` participants uses signaling again

### leave and end_match

| `MatchState` | `leave` |
|---|---|
| `None` | warn log. Does nothing |
| `Matching` | for a non-host member of a room, the same as `leave_room`. Otherwise `cancel_matching`, `close`, `None`. The `status` of `join_match`, `start_room`, `wait_match` is `Cancelled` |
| `Connecting` | leave notice (`Left`) to `Connected` participants, `close`, `None`. The `status` of `join_match`, `rejoin_match`, `start_room`, `wait_match` is `Cancelled` |
| `Playing` | match end(`Left`) |

- `end_match` runs match end (`Ended`) in `Playing`, and only leaves a warn log in other states
- match end: sends a leave notice to `Connected` participants (reason is `Ended` when `Ended`, otherwise `Left`) → `close` → `None` → `MatchEndedEvent`

### time and background

- The connect time limit and the reconnect time limit are measured with `TimeCore` monotonic time
- match time = `TimeCore` server time − match start time. Negative before the start. When the transport's `lockstep_time` returns a value, the match time is that value. `match_time_ms` returns a value only in `Connecting` and `Playing`. In other states it gives an error log and the failure value; when there is no server time, the failure value without log
- On receiving the `TimeCore` background return event, looks at the background elapsed time before the next `poll` and other time limit checks. Less than `RealtimeCore.backgroundTimeoutMs` continues. At that value or more, `Playing` is match end (`BackgroundTimeout`), and `Matching`, `Connecting` are a `join_match` failure

### match result and log

- Server `matchmaker` judges the match result that changes UserState from the participants' reports. RealtimeCore sends no server request. Content code reports with `matchmaker.ReportMatchResult`. The match ID is the value in `MatchInfo` or `MatchEndedEvent`
- The module assumes another participant's client can tamper with messages
- No log of any level holds the access token, NAT traversal information, signaling contents or participants' network addresses

### lifecycle

- `release` calls transport `leave_room` when in a room or waiting for `create_room`, `join_room`, calls transport `disconnect`, returns to `None` without leave notice or event, empties `RoomInfo`, ends the pending `join_match`, `rejoin_match`, `start_room`, `wait_match` with `Failed` and `create_room`, `join_room` with `ok` `false`, and deletes the transport it was given. It does not delete the `MatchInfo` saved in `LocalDataCore`

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| `on_realtime_message` | each realtime message that passed the receive check | sending participant index, `RealtimeChannel`, message bytes | none | puts the message in the pending queue |

- The bytes passed are reused for the next received packet after the hook returns. Values to keep are copied inside the hook
- `on_realtime_message` is an owner hook. An object of the scene that runs the match registers it

## event

| event | when | payload |
|---|---|---|
| `PeerDisconnectedEvent` | when changed to `Disconnected` | `participant`: index |
| `PeerReconnectedEvent` | when changed from `Disconnected` to `Connected` | `participant` |
| `PeerLeftEvent` | leave handling | `participant`, `reason`: `PeerLeaveReason` |
| `MatchEndedEvent` | match end | `match_id`, `reason`: `MatchEndReason` |
| `RoomChangedEvent` | when `RoomInfo` changes or becomes empty | `room`: `RoomInfo` after the change, `reason`: `RoomChangeReason` |
| `RoomMatchStartedEvent` | when a non-host member became `Matching` or `Connecting` through the room's match | none |

## error

| condition | failure value | log |
|---|---|---|
| the `on_realtime_message` hook throws | that message is discarded. The next message is also given to the hook | error once per match, the first time. So that a hook that throws for every packet in frame code does not flood error sending |
| `join_match` when not `None` | `Failed` | warn |
| `rejoin_match` when not `None`, when in a room or while waiting for `create_room`, `join_room`, `rejoin_match` with an empty match ID or a match ID different from the saved match ID | `Failed` | warn |
| `MatchInfo` check failure | `Failed` | error |
| other `join_match`, `rejoin_match` failures | `Failed` | warn |
| `send` when not `Connecting` or `Playing` | `false` | warn |
| target index outside the list or own index, message length outside range | `false` | error |
| target is not `Connected`, `All` with no `Connected` participant | `false` | none |
| `peer_state` when not `Connecting` or `Playing`, or for an index outside the list | `Left` | error |
| `set_transport` after `init` | none | error |
| `join_match`, `rejoin_match`, `create_room`, `join_room`, `start_room` without a transport | `Failed`, `ok` `false` | error |
| `create_room`, `join_room` when in a room, while waiting for `create_room`, `join_room`, or when `MatchState` is not `None` | `ok` `false` | warn |
| `leave_room` when not in a room and not waiting for `create_room`, `join_room`, `kick_room_member` when not in a room or not the host, `start_room` when not in a room, not the host or not `None`, `join_match` of a non-host member of a room, `join_match` while waiting for `create_room`, `join_room`, `join_match` with a match mode different from the room's | none for `leave_room`, `false` for `kick_room_member`, `Failed` for the rest | warn |
| `wait_match` when not `Matching` or `Connecting` | `Failed` | warn |
| room failed received by an in-progress async operation, matchmaker lost received while in a room | `ok` `false`, `Failed` | warn |
| room failed with no operation to receive it | none. `MatchState` and `RoomInfo` unchanged | warn |
| `leave` when `MatchState` is `None` | none. Does nothing | warn |
| `end_match` when not `Playing` | none. Does nothing | warn |
| `match_time_ms` when not `Connecting` or `Playing` | int64 minimum | error |
| `match_time_ms` when there is no server time | int64 minimum | none |
| match found received when not `Matching` or `Connecting` (except one a non-host member of a room receives in `None`) | discarded | warn |
| malformed `PEER_SIGNAL` `payload` | discarded | warn |
| `PEER_SIGNAL` with a connection attempt number other than the current connection's | discarded | warn |
| receive check: packet received when not `Connecting` or `Playing`, packet of a `Left` participant | discarded | none |
| receive check: kind is not `0` or `1`, control message that came on `Unreliable`, length outside range, malformed control message | discarded | warn |
| realtime message received when there is no hook and the pending queue holds `RealtimeCore.pendingMessageMax` messages | discarded | error. Once per match |
| matchmaker lost received in `Playing`, rejoined failure of in-match rejoin | the match continues | warn |
| `join_match`, `rejoin_match`, `start_room`, `wait_match`, `create_room`, `join_room` pending at `release` | `Failed`, `ok` `false` | none |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `RealtimeCore.connectTimeoutMs` | integer | core | content | limit from becoming `Connecting` until connected to all participants |
| `RealtimeCore.reconnectTimeoutMs` | integer | core | content | limit from becoming `Disconnected` until reconnected |
| `RealtimeCore.backgroundTimeoutMs` | integer | core | content | minimum background elapsed time at which the match ends or `join_match` counts as failed |
| `RealtimeCore.messageMaxBytes` | integer | core | content | maximum bytes of one realtime message |
| `RealtimeCore.pendingMessageMax` | integer | core | content | limit of the number of realtime messages kept in the pending queue while there is no `on_realtime_message` hook |
| `NetworkCore.retryDelayMs` | integer | core | content | first rejoin delay of in-match rejoin |
| `NetworkCore.retryDelayFactorPermille` | integer | core | content | factor multiplied into the next rejoin delay. permille |
| `NetworkCore.retryDelayMaxMs` | integer | core | content | maximum of the rejoin delay |
| `RealtimeCore.simLatencyMs` | integer | core | human | one-way latency of DEV network simulation |
| `RealtimeCore.simJitterMs` | integer | core | human | maximum latency jitter of DEV network simulation |
| `RealtimeCore.simLossPermille` | integer | core | human | `Unreliable` packet loss permille of DEV network simulation |

settings constraint

| left | factor | right |
|---|---|---|
| `RealtimeCore.backgroundTimeoutMs` | 1 | `RealtimeCore.reconnectTimeoutMs` |

## data

match mode ID value is `id` of the `match_mode` table of server core `matchmaker`

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `user` | `RealtimeCore.match_id` | `string` | match ID of the saved `MatchInfo` |
| `user` | `RealtimeCore.mode_id` | `int64` | match mode ID value |
| `user` | `RealtimeCore.my_index` | `int64` | own participant index |
| `user` | `RealtimeCore.players` | `array<int64>` | participant user ID list. Index order |
| `user` | `RealtimeCore.teams` | `array<int64>` | team list. Index order |
| `user` | `RealtimeCore.parties` | `array<int64>` | party list. Index order |
| `user` | `RealtimeCore.lockstep` | `bool` | lockstep flag |
| `user` | `RealtimeCore.seed` | `int64` | match seed |
| `user` | `RealtimeCore.start_at` | `int64` | match start time (Unix ms) |

## DEV

- network simulation transport: puts a delay of `RealtimeCore.simLatencyMs` + [0, `RealtimeCore.simJitterMs`] on each packet sent to the wrapped transport. `Reliable` keeps the send order and loses nothing. `Unreliable` can change order and is discarded with probability `RealtimeCore.simLossPermille`. It is used only in dev run, and the DEV code of `BootstrapCore` passes it
- The random of the network simulation transport is made with `UtilCore.make_purpose_seed`(`realtime_sim`, match seed). When all three values are 0, there is no delay and no loss
- STG and PROD builds do not have the network simulation transport
- The opponent bot client attached to an instance of a realtime game uses RealtimeCore unchanged in the headless run of `QACore`

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `force_peer_lost` | participant index | success flag | `false` | core test, `QACore` |
| `force_matchmaker_lost` | none | success flag | `false` | core test, `QACore` |
| `request_step` | ms | async operation. success flag | `false` | `QACore` |

- `force_peer_lost`: accepts only another participant that is `Connected` in `Playing`. Otherwise a warn log and `false`. Closes the P2P connection with that participant without leave notice through the transport's DEV operation `force_close_peer`. The transport raises peer lost of that participant in the next `poll`
- `force_matchmaker_lost`: accepted only in `Playing`. Otherwise a warn log and `false`. Closes the matchmaker connection without `MATCH_LEAVE` through the transport's DEV operation `force_close_matchmaker`. The transport raises matchmaker lost in the next `poll`
- `force_close_peer` of the P2P transport closes that participant's WebRTC connection, and `force_close_matchmaker` closes the matchmaker WebSocket connection. The transports of STG and PROD builds do not have the two operations
- `request_step`: when not `Playing`, a warn log and `false`. When the transport is a lockstep transport, calls its DEV operation `request_step` and returns the result; otherwise a warn log and `false`

### lockstep transport

DEV lockstep makes participants with `TimeCore` step mode on stop the match time together and advance it together by the same step. The match does not run while an LLM agent looks at the screen and puts in input each turn.

- The lockstep transport is a DEV transport that wraps another transport. The DEV code of `BootstrapCore` passes it
- Replaces the lockstep flag of `start_matching` and `open_room` with the value of `TimeCore.is_step_mode` and passes it to the wrapped transport
- lockstep match: a match whose `MatchInfo` lockstep flag in match found is `true`
- A lockstep notification is a `Reliable` control message. Step is `[1, 2, k, ms]`, step end is `[1, 3, k]`, step request is `[1, 4, ms]`. k and ms are 4-byte big-endian unsigned integers. The lockstep transport does not pass received lockstep notifications on as packet received
- sequencer: the participant with the smallest index among the participants not closed with `close_peer` and itself. When the sequencer changes, the new sequencer makes steps with the number after the largest step number it received
- transport DEV operation `request_step`(ms): when it is the sequencer, makes the step with the next number k (from 1), sends the step notification to the other connected participants and treats it as received itself. When it is not the sequencer, sends a step request to the sequencer. The sequencer makes a step with the same ms for each step request it receives
- When the sequencer changes, a participant that sent a step request and has not yet received the step notification sends a step request with the same ms again to the new sequencer. When it is the new sequencer itself, it makes the step with that ms, and that step is the step of that request
- A participant starts step k when all of the following hold
  - it received the step k notification
  - when k is greater than 1, it finished step k−1 and received the step k−1 end from all other participants not closed with `close_peer`
- On starting a step, calls `TimeCore.add_step_budget`(ms). When `TimeCore.get_step_budget` becomes 0, ends the step and sends the step end to the other connected participants
- A step end arrives after the `Reliable` messages that participant sent during that step. So the next step starts after all `Reliable` messages of the previous step are received
- On receiving peer connected again for a participant that was disconnected, the sequencer sends again all step notifications with a number larger than the last step end received from that participant, and another participant sends again the end of the largest step it finished. When the peer connected received again is the sequencer's, a participant that sent a step request and has not yet received the step notification sends the step request with the same ms again. A notification with an already received number is discarded
- `lockstep_time`: in a lockstep match, the sum of game time added after all other participants first connected. 0 before that. Outside a lockstep match, the value of the wrapped transport
- result of transport DEV operation `request_step`: `true` when this participant finishes the step of that request. A participant that is not the sequencer takes the step of the first step notification received after the request as the step of that request. Outside a lockstep match or when `TimeCore.is_step_mode` is `false`, a warn log and `false`. `false` when `close` or `disconnect` is called before that step finishes
- STG and PROD builds do not have the lockstep transport. RealtimeCore without a lockstep transport discards control messages whose second byte is `2`, `3`, `4` as malformed control messages

## test

Every test other than the P2P transport tests passes the fake realtime transport of `UnitTestCore` with `set_transport`.

- After match found and all peer connected, `join_match` is `Success`, `Playing`, and `match_info` equals the notified `MatchInfo`. The states before that are `Matching`, `Connecting` in turn
- In `Connecting` and `Playing`, `peer_state`(own index) is `Connected` without log
- match failed (`REJECTED`, error code) gives `Failed` with that `fail_reason` and `error_code`
- On receiving matchmaker lost with code `MAINTENANCE` in `Matching`, `join_match` is `Failed` and `error_code` is `MAINTENANCE`. With code 0, `error_code` is 0
- `join_match` when not `None` gives a warn log and `Failed` at once and calls no transport operation
- Each case of the failure list gives `Failed`, a `close` call, `None` and the log level of the error table. Each `MatchInfo` check condition fails the check
- match found and a saved `MatchInfo` whose team list or party list is one shorter or one longer than the participant count are caught by the `MatchInfo` check, giving `Failed` and an error log
- On the test clock, the state is `Connecting` at `RealtimeCore.connectTimeoutMs` − 1 after `Connecting`, and `Failed` when the limit itself is reached
- `leave` in `Matching` gives `cancel_matching` and `Cancelled`, `leave` in `Connecting` gives leave notice (`Left`) and `Cancelled`
- Each `send` failure case of the table gives `false` and the table's log without `send_packet`. `All` calls once for each participant except itself and participants that are not `Connected`, still calls the rest when one fails, and is `false`
- The packet `send` passes is first byte `0` and the passed bytes. For received kind `0` packets, index, channel and the bytes from the second byte go to the hook in the order received
- When `MATCH_FOUND` and offer and ICE candidate `PEER_SIGNAL` of that match are put into the P2P transport in the same `poll`, the signals are handled in the order received after `connect_peer` and connect. There are no collected signals after `close_peer` and `close`. `PEER_REJOINED` and `PEER_SIGNAL` of an index closed with `close_peer` do not start a connection, and there is no peer connected or peer lost for that index until `close`
- `payload` of a candidate `PEER_SIGNAL` the P2P transport sent has `data`, `mid`, `index`, and a received candidate enters the P2P connection with those three values. A candidate `payload` without `mid` or `index`, or with a negative `index`, is discarded with one warn log and the participant state does not change
- In the P2P transport, answer and candidate `PEER_SIGNAL` of a previous connection attempt that arrive late after the offer restarted are discarded with a warn log, and the new attempt connects
- In the P2P transport, after itself at index 1 is connected with index 0 through the connection with number 2, an offer `PEER_SIGNAL` with a number equal to or smaller than 2 is discarded with a warn log, and the connection and the sent signals do not change. On receiving an offer `PEER_SIGNAL` with number 1 after `PEER_REJOINED` of index 0, it sends an answer with number 1 to that offer and the new connection connects, with no peer lost of index 0 meanwhile
- In the P2P transport, when itself at index 0 sends an offer `PEER_SIGNAL` to index 1 and receives `PEER_REJOINED` of index 1 before the answer, it drops the connection being made and sends a new offer `PEER_SIGNAL` once, with no peer lost of index 1. When it receives the answer to that offer and connects, it is peer connected. Itself at index 1 sends no offer after `PEER_REJOINED` of index 0 and sends an answer to the offer it receives. When itself at index 0 is connected with index 1 through the connection with number 2 and receives `PEER_REJOINED` of index 1, it drops that connection and sends an offer `PEER_SIGNAL` with number 3 once, and until it connects with that offer there is no peer lost of index 1 and no second peer connected
- Each warn item of the receive check gives a warn log without the hook, and each log none item gives no log without the hook
- Messages received while there is no hook go to the hook in the first `poll` after hook registration, before the packets that `poll` receives, in the order received. A message received when the pending queue holds `RealtimeCore.pendingMessageMax` messages is discarded, with an error log once per match. A hook registered after the match ended gets no messages of the ended match. The hook is also called during pause
- `on_realtime_message` registered as an object's function is not called after that object is destroyed and behaves as when there is no hook, and registration by another object then succeeds. A second registration while an owner exists gives an error log and `false`
- peer lost in `Playing` gives `PeerDisconnectedEvent` once and `connect_peer`. peer connected at `RealtimeCore.reconnectTimeoutMs` − 1 gives `PeerReconnectedEvent` and `Connected`; when the reconnect time limit passes without notification, `PeerLeftEvent`(`Timeout`) and `Left`
- Each leave notice (`Left`, `Ended`) gives `PeerLeftEvent` with the same reason once, and after that peer lost and peer connected of that participant give no `connect_peer`, event or participant state change. The state is `Playing` even when all other participants leave
- `leave` and `end_match` in `Playing` give leave notice bytes, `close`, `None`, `MatchEndedEvent` in that order, with reason `Left` and `Ended` respectively. When the event is received, `match_state` is `None`
- Background elapsed time `RealtimeCore.backgroundTimeoutMs` − 1 does not change the state; at the limit value itself, `Playing` ends with `BackgroundTimeout` and `Matching`, `Connecting` are `Failed`
- `match_time_ms` is server time − start time; in `None`, an error log and int64 minimum; before there is server time, int64 minimum without log
- matchmaker lost in `Playing` gives a warn log and one `rejoin` and does not change participant state. match found in `Playing` does not change `MatchInfo` after a warn log
- In `Playing`, matchmaker lost with code `SESSION_REPLACED`, `BANNED`, `MAINTENANCE`, `APP_UPDATE_REQUIRED`, `DATA_UPDATE_REQUIRED` leaves a warn log, does not call `rejoin`, and the state is `Playing`
- In `Playing`, on receiving matchmaker lost with code 0 after `rejoin` and before rejoined, a warn log is left; on the test clock, `rejoin` is not called again until `NetworkCore.retryDelayMs` − 1 and is called once at `NetworkCore.retryDelayMs`. For each following matchmaker lost with code 0, the interval until the next `rejoin` is the value of the rejoin delay formula and does not exceed `NetworkCore.retryDelayMaxMs`. After rejoined succeeds, `rejoin` is not called any more
- During in-match rejoin, after a rejoined failure and after matchmaker lost with code `MAINTENANCE`, `rejoin` is not called any more and the state is `Playing`. When `leave` makes the state `None` while waiting for the rejoin delay, `rejoin` is not called any more
- In `Matching`, matchmaker lost with code `SESSION_REPLACED` calls `NetworkCore.notify_server_error`(`SESSION_REPLACED`) once, and `join_match` is `Failed` with `error_code` `SESSION_REPLACED`. `APP_UPDATE_REQUIRED` and `DATA_UPDATE_REQUIRED` also call it once with that code, and `MAINTENANCE` does not call it
- In `Matching`, matchmaker lost with code `TOKEN_EXPIRED` calls `AuthCore.refresh_access_token` once, calls `start_matching` once again with the received access token, and stays `Matching`. On a second `TOKEN_EXPIRED` and on refresh failure, `join_match` is `Failed` with `error_code` `TOKEN_EXPIRED`
- No operation of RealtimeCore sends a server request
- P2P transport: even when the server sends `CLOSE` and closes right away with WebSocket close code 4000, matchmaker lost has the code of that `CLOSE`
- P2P transport: with a fake WebSocket server, `HELLO` is the first frame, its `data_version` is the data version of `DataCore` and `client_version` is the app version of build info; `MATCH_FOUND` becomes match found, `MATCH_FAILED` becomes match failed, `MATCH_REJOINED` becomes rejoined with its `ok` and `left_indices`, `CLOSE` becomes matchmaker lost with its `code`, and a disconnection without `CLOSE` becomes matchmaker lost with code 0. Of the two participants, only the one with the smaller index sends an offer `PEER_SIGNAL`
- `release` in `Playing` calls transport `disconnect`, does not call `close` and raises no event, and after `init` again the state is `None`
- P2P transport: with a fake WebSocket server, `disconnect` in `Playing` closes the WebSocket connection and P2P connections without sending `MATCH_LEAVE`. `close` closes them after sending `MATCH_LEAVE`
- The logs of the whole match contain no access token or NAT traversal information string
- On becoming `Connecting`, `MatchInfo` is saved to the `user` file; it is deleted after match end, `leave` and a `join_match` failure, and remains after `release`
- After `release` and `init` again, `rejoin_match` called with `saved_match_id` calls transport `rejoin` once, is `Success`, `Playing` after rejoined success and all peer connected, and `match_info` equals the saved `MatchInfo`
- `rejoin_match` called without a transport gives an error log and `Failed` without a transport operation, and `MatchState` is `None`
- On rejoined failure and on check failure of the saved `MatchInfo`, `rejoin_match` is `Failed`, `None`, and the saved data is deleted. `rejoin_match` when not `None`, when in a room, while waiting for `create_room`, `join_room`, and with a match ID different from the saved one gives a warn log and `Failed` without a transport operation, and `RoomInfo` is unchanged
- When the saved `MatchInfo` has three participants and itself is index 0, and rejoined of `rejoin_match` succeeds with [2] as the list of indexes of participants who left, `peer_state`(2) is `Left`, `close_peer`(2) is called, `connect_peer` is called only for index 1, and there is no `PeerLeftEvent`. After peer connected of index 1, `Success`, `Playing`
- In in-match rejoin in `Playing`, when rejoined succeeds and the list of indexes of participants who left has a `Disconnected` participant, that participant is `Left` and `PeerLeftEvent`(`Left`) comes once. A participant already `Left` gets no event
- network simulation transport: with loss 1000, all `Unreliable` packets are discarded and all `Reliable` ones arrive in order. With latency d and jitter 0, arrival is d later on the test clock. With the same match seed, the same packets are discarded
- In `Playing`, `force_peer_lost` calls transport `force_close_peer` for that participant once, and peer lost in the next `poll` gives `PeerDisconnectedEvent` and `connect_peer`. `force_matchmaker_lost` calls transport `force_close_matchmaker` once, and the next `poll` gives a warn log and one `rejoin`. When not `Playing` or the target is not `Connected`, both give a warn log and `false` without a transport operation
- `create_room` calls transport `open_room` once, is `ok` after room updated, `room_info` is that `RoomInfo`, and `RoomChangedEvent`(`Updated`) comes once. When room failed of `Open` is received first, `ok` is `false` with that error code
- `create_room`, `join_room` when in a room or not `None` give a warn log and `ok` `false` without a transport operation
- `create_room`, `join_room`, `join_match` while waiting for `create_room` give a warn log and failure without a transport operation. `leave_room` during that wait calls transport `leave_room`, the pending `create_room` is `ok` `false` with error code 0, and there is no `RoomChangedEvent`. room updated and room kicked received after that are discarded without log, and `room_info` is an empty `RoomInfo`
- room failed of `Kick` received by a host in a room and room failed of `Start` received by a non-host member in `None` give one warn log, and `MatchState` and `RoomInfo` are unchanged. room failed of `Kick` received by a host waiting for `start_room` does not end `start_room`
- `join_match` of the host calls `start_matching`. `join_match` with a match mode different from the room's and `join_match` of a non-host member give a warn log and `Failed` without a transport operation
- When a non-host member receives room updated with `Matching`, the state is `Matching` with one `RoomMatchStartedEvent`, and after match found and all peer connected, `wait_match` is `Success`, `Playing`. On receiving room updated with `Open`, the state is `None` and `wait_match` is `Cancelled`
- `start_room` of the host calls transport `start_room` and is `Success`, `Playing` after match found and all peer connected. With room failed of `Start`, `Failed` with that `error_code`
- When a non-host member of a room receives match found in `None`, there is one `RoomMatchStartedEvent` and `Connecting` without a warn log, and after all peer connected, `wait_match` is `Success`, `Playing`. match found received in `None` when not in a room is discarded with a warn log
- On room kicked, `RoomInfo` becomes empty and `RoomChangedEvent`(`Kicked`) comes once. matchmaker lost while in a room raises `RoomChangedEvent`(`Lost`)
- On receiving matchmaker lost with code `BANNED` while waiting for `create_room`, `ok` is `false` and `error_code` is `BANNED`. When a host waiting for `start_room` receives matchmaker lost with code `MAINTENANCE`, `RoomInfo` becomes empty, `RoomChangedEvent`(`Lost`) comes once, and `start_room` is `Failed` with `error_code` `MAINTENANCE`
- After match end, `room_info` is unchanged and transport `leave_room` is not called. `leave_room` calls transport `leave_room` once and raises `RoomChangedEvent`(`Left`)
- `release` while in a room calls transport `leave_room` once and raises no event
- The lockstep transport passes lockstep `true` to `start_matching`, `open_room` of the wrapped transport when `TimeCore.is_step_mode` is `true`, and `false` when it is `false`
- In a two-participant lockstep match of a lockstep transport wrapping the fake realtime transport, when itself is the sequencer, `request_step`(100) sends the step notification `[1, 2, 1, 100]` once with `send_packet`, advances its own game time by 100, then sends step end `[1, 3, 1]` and is `true`. When itself is not the sequencer, `request_step`(100) sends step request `[1, 4, 100]` once, receives the step 1 notification the fake puts in, advances game time by 100, then sends the step end and is `true`
- Before the fake puts in the other participant's step 1 end, step 2 does not start even with a step 2 notification, and its own game time and `match_time_ms` are unchanged. The end of a participant closed with `close_peer` is not waited for
- In a three-participant lockstep match, when itself at index 1 sends a step request and the fake then puts in the leave notice of index 0, itself becomes the sequencer, sends the step notification with that ms to index 2, and `request_step` is `true` when it finishes that step. When itself at index 2 sends a step request and then receives the leave notice of index 0, it sends the step request with the same ms again to index 1
- When the fake puts in another participant's `Reliable` realtime message and step 1 end in turn, that message goes to the hook before its own step 2 starts
- `match_time_ms` of a lockstep match is the sum of step ms advanced after all other participants first connected
- When itself is the sequencer and the fake puts in another participant's peer lost and peer connected in turn, it sends again all step notifications with a number larger than the last step end received from that participant. When itself is not the sequencer, after another participant's peer connected it sends again the end of the largest step it finished, and discards a step notification with an already received number when it receives it again
- Lockstep notifications received by the lockstep transport do not go to the hook or to leave handling. RealtimeCore without a lockstep transport discards control messages whose second byte is `2`, `3`, `4` with a warn log
- When not `Playing` or the transport is not a lockstep transport, `request_step` gives a warn log and `false`
- The SDP a relay-only P2P transport sends has no `a=candidate:` line whose candidate type is not `relay`, and it sends no candidate `PEER_SIGNAL` whose candidate type is not `relay`. A received `typ host` candidate does not enter the P2P connection
- When a relay-only P2P transport receives `MATCH_FOUND` with empty `relays`, it sends `MATCH_LEAVE`, and `join_match` is `Failed` with `fail_reason` `CREATE_FAILED` and `error_code` 0. `MATCH_REJOINED` with empty `relays` is a rejoined failure
