# tutorial

## purpose

Saves the step of tutorial progress per user and sends it to the client as UserState. Client `TutorialCore` does the start judgement, step progress and screens.

## dependency

- `storage`
- `logging`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `SaveTutorialProgress` (core rpc, `silent`, `retry`). changes: `TutorialProgressUserState` | `tutorial_id`, `step` | empty response | `INVALID_REQUEST` | `routing`. Client `TutorialCore` sends it |
| `get_tutorial_step` | ctx, tutorial ID value | the saved step. 0 when there is no row | none. A negative or non-integer tutorial ID value throws | content handler, hook |

- `step` is the `step` value of `tutorial_step`

core `rpc` request field

| message | field | type | `(ogw.v)` |
|---|---|---|---|
| `SaveTutorialProgressRequest` | `tutorial_id` | `int32` | `table`: `tutorial` |
| `SaveTutorialProgressRequest` | `step` | `int32` | `min`: 1, `max`: 2^31−1 |

## behavior

- Progress is saved in the core UserState kind `TutorialProgressUserState` (list kind) of the base proto. field: `int64 id` (tutorial ID value), `int32 step`. Only this module writes it, with `storage.put_core_state` and `delete_core_state`
- `SaveTutorialProgress` processing order
  1. When `tutorial_step` has no row whose `id` is `tutorial_id` and whose `step` is the `step` of the request, `INVALID_REQUEST`
  2. When the saved step is the `step` of the request or more, nothing changes and it succeeds
  3. Writes that row of `TutorialProgressUserState` with the `step` of the request, and emits core analytics event `core_tutorial_step` with `logging.track_core_event`
- Progress only increases. A smaller `step` that arrives out of order does not reduce the saved value
- A changed row goes into the UserState delta of that response. It is also in the full UserState of the `Login` response
- This module does not give tutorial rewards. When a reward is needed, the content grants it with its own `rpc`. The rules for that `rpc` are `## handler` of [`server-content`](../../server-content/SKILL.md)

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| (`tutorial_id`, `step`) not in `tutorial_step` | `INVALID_REQUEST` | `INVALID_REQUEST` | `warn` log |

Added `CoreError`: none

## settings

none

## data

used table: `tutorial`, `tutorial_step`

Reads the `tutorial` table and the `tutorial_step` table. `TutorialCore` defines the headers of both tables. This module reads only the columns whose build target is `All`.

| table | columns read |
|---|---|
| `tutorial` | `id` |
| `tutorial_step` | `id`, `step` |

reserved ID, reserved string, reserved sound: none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_tutorial_step` | ctx, tutorial ID value, step | none | an input violation throws | content cheat handler, `testing` |

- `set_tutorial_step` changes the step to that value. It can reduce it. When the value is 0, it deletes that row. When the step is not 0 and is not in `tutorial_step`, it throws
- STG and PROD builds have no `set_tutorial_step`

## test

- `SaveTutorialProgress` writes a `TutorialProgressUserState` row and the delta of that response has the changed row
- A `step` less than or equal to the saved step succeeds, and the row and delta do not change
- A `step` not in `tutorial_step` and a `tutorial_id` not in `tutorial` are `INVALID_REQUEST`, and the row does not change
- The response received for `SaveTutorialProgress` sent again with the same request ID equals the first response in every field other than `server_time_at`
- The full UserState of the `DevLogin` response has the saved `TutorialProgressUserState`
- A direct write of `TutorialProgressUserState` by a content handler is rejected by `storage`
- `set_tutorial_step` reduces the step, and deletes the row when the value is 0
- Only a `SaveTutorialProgress` that changed progress leaves core analytics event `core_tutorial_step` for a user who allowed analytics
