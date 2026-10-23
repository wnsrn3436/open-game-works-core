# InputBlockCore

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

Acquires and releases blocks, and judges whether one input passes the active blocks. `InputCore` receives or discards input.

## dependency

`LogCore`, `TimeCore`

- optional dependency: `ResolutionCore`. Used only so that `pass_position` reads the window pixels it receives in the window size of `ResolutionCore.set_test_screen`. When it is not in the module list, window pixels are the real window pixels

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `block` | reason tag, `BlockPassList`(optional), owner object(optional) | block token | invalid token | `blocker` of the reason tag table |
| `unblock` | block token | success flag | `false` | code that holds the block token |
| `run_blocked` | reason tag, async operation, `BlockPassList`(optional), owner object(optional) | async operation. success flag of the operation | `false` | `blocker` of the reason tag table |
| `is_blocked` | none | whether it is in the blocked state | `false` | core, content code |
| `is_active` | block token | whether that block is an active block | `false` | core, content code |
| `pass_action` | action | pass flag | `true` | `InputCore`, `UICore` |
| `pass_position` | window pixel position | pass flag | `true` | `InputCore` |
| `pass_focus` | UI element | pass flag | `true` | `InputCore` |
| `release_all` | reason tag to keep(optional) | number of released blocks | 0 | `SceneCore`, `BootstrapCore`(restart, update reboot) |
| `set_timer_hold` | reason tag(`ui`, `network`, `step`), whether to hold | none | none | `UICore`(`ui`), `NetworkCore`(`network`), `QACore`(`step`) |
| `restart_timer` | block token | success flag | `false` | `NetworkCore` |

- `is_blocked`, `is_active`, `pass_action`, `pass_position`, `pass_focus` and the forced release check do not allocate memory. Logs are excluded
- InputBlockCore displays nothing on screen. The side that acquired the block does the display during the block

### type

| type | contents |
|---|---|
| `BlockPassList` | `actions`: list of actions. `elements`: list of UI elements. Both can be empty lists |

## behavior

### block

- block: one request that blocks input. It has a reason tag, a caller location, a start time (real elapsed time of `TimeCore`), a pass list and an owner object. A block not yet released is an active block
- The state with one or more active blocks is the blocked state. There is no operation that turns the blocked state on and off as one boolean value
- caller location: the position of the code that called `block`. An empty string when it cannot be obtained. Used in `list_active` and logs
- reason tag

  | reason tag | blocker |
  |---|---|
  | `network` | `NetworkCore` |
  | `ui` | `UICore` |
  | `scene` | `SceneCore` |
  | `tween` | `TweenCore` |
  | `message` | `MessageCore` |
  | `cutscene` | `CutsceneCore` |
  | `tutorial` | `TutorialCore` |
  | `ad` | `AdCore` |
  | `boot` | `BootstrapCore` |
  | `content` | content code |

- A reason tag is used only by its `blocker` in the table. A reason tag changes no behavior other than the application of the max duration and `release_all`

### block token

- A block token holds a block slot and a generation number. The slot of a released block is reused for the next block, and each reuse changes the generation number
- bad token: an invalid token, a token whose generation number differs from the current generation number of the slot, a token of a released block
- `unblock` of a bad token leaves an error log and is `false`. It does not release another active block. STG and PROD builds also check this
- `is_active` is `false` for a bad token, without a log

### acquire and release

- The side that acquired a block releases it on every path where that handling ends (success, failure, cancellation, early return)
- The side that acquired a block releases its own block before it opens a popup that waits for user input. When another side can open a system popup during the block, it puts the system popup root of `UICore.get_block_pass_list` into `elements` of the pass list
- A block for which content code calls `block` and `unblock` directly is acquired and released inside one function. There is no wait (async operation, engine notification, timer) in between. The block token is kept only in a local variable of that function and is not passed to functions other than `unblock` and `is_active`
- When there is a wait between acquiring and releasing, content code uses only `run_blocked`
- The two rules above apply only to content code, and the automated check of client content code blocks violations. Core modules (`NetworkCore`, `TweenCore`, `UICore`, `MessageCore`, `SceneCore`, `CutsceneCore`, `BootstrapCore`) hold the block token across waits and release it on every path where they end. On release, they do not call `unblock` for a token whose `is_active` is `false`. That is a block released earlier by `release_all`, forced release or owner object destruction

### run_blocked

- It acquires the block before it starts the operation and releases it whether the operation ends with success, failure or cancellation. The result is the success flag of the operation, and cancellation is `false`
- When the owner object is omitted, the object the operation belongs to is used as the owner object. When there is none either, the block has no owner object
- When the block is released by owner object destruction, `run_blocked` ends with `false` without waiting for the operation. When the operation ends later, its result is not used
- Even when the owner object is destroyed after the block was released earlier by forced release or `release_all`, `run_blocked` ends with `false` without waiting for the operation and without a log. It watches for owner object destruction until `run_blocked` returns
- When the block is already released when the operation ends (forced release, `release_all`), it does not call `unblock` and leaves no log
- When `block` fails, it does not start the operation and the result is `false`. It does not give the caller a block token

### owner object

- When the owner object of a block that has one is destroyed, InputBlockCore releases the block without a log
- When an owner object that is not omitted is already destroyed, `block` leaves an error log and returns an invalid token

### pass list

- pass list: the `BlockPassList` passed to a block. Even during the block, it lets the actions of `actions` and the UI elements of `elements` pass. The caller makes it and reuses it, and several blocks can use the same pass list. While the block is an active block, the caller does not change that pass list
- A UI element of `elements` lets pass the positions inside the screen area of that UI element and the focus of that UI element and its descendant UI elements. A UI element that is not visible or is destroyed lets nothing pass
- A block without a pass list blocks all input including `back`
- pass flag of `pass_action`, `pass_position`, `pass_focus`: `true` when there is no active block. `pass_action` is `true` only when the pass list of every active block has that action. `pass_position` is `true` only when the pass list of every active block has a UI element that lets that position pass. `pass_focus` is `true` only when the pass list of every active block has that UI element or a UI element that is its ancestor. `pass_focus` of a destroyed UI element is `false`
- When there is an active block and `pass_position` receives a position that is not finite, it leaves an error log and is `false`

### max duration

- block elapsed time: the real elapsed time since the block was acquired or since the last `restart_timer`, minus the duration in background and the timer hold duration. The pause and time scale of game time do not affect block elapsed time
- timer hold: while one or more reason tags have hold set to `true` by `set_timer_hold`. Each reason tag follows the last value it received. `step` is not in the reason tag table and is used only in `set_timer_hold`
- `restart_timer` sets the block elapsed time of that block to 0. A bad token gives `false` without a log
- forced release: each frame, it releases the active blocks whose block elapsed time is at least `InputBlockCore.maxDurationMs`. Each forced release leaves an error log with the reason tag, caller location and block elapsed time
- Blocks of reason tags `scene`, `cutscene`, `tutorial`, `ad`, `boot` are not targets of forced release

### release_all

- Releases all active blocks and returns the number released. When it receives a reason tag to keep, it keeps the blocks of that tag. For each released block, it leaves a warn log with the reason tag and caller location
- `SceneCore` calls it at scene transition with `scene` as the reason tag to keep, and `BootstrapCore` calls it at restart and update reboot

### lifecycle

- `release` deletes all blocks without a log and sets the hold of every reason tag to `false`

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| `block`, `run_blocked`, `release_all` with a tag not in the reason tag table | invalid token, `false`, 0 | error |
| `unblock` of a bad token | `false`. Other blocks stay as they are | error |
| `block`, `run_blocked` with a destroyed owner object | invalid token, `false` | error |
| `pass_position` of a position that is not finite while there is an active block | `false` | error |
| forced release | releases that block | error |
| block released by `release_all` | none | warn per block |
| the reason tag of `set_timer_hold` is not `ui`, `network` or `step` | ignores it | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `InputBlockCore.maxDurationMs` | integer | core | content | maximum block elapsed time during which one block can be an active block |

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `list_active` | caller buffer | number filled. Per active block: reason tag, caller location, block elapsed time (ms) | `0` | `QACore`, core test, client regression test |
| `count_active` | none | number of active blocks | `0` | `QACore`, core test, client regression test |

- The softlock judgement of `QACore` uses the result of `list_active`

## test

- While `ResolutionCore.set_test_screen` sets a window size that differs from the real window, `pass_position` is `true` for the position that `ResolutionCore.game_to_window` converts from a game position inside the pass list UI element area, and `false` for a position outside
- With no block, `is_blocked` is `false`; with two acquired, `true`; with one released, still `true`; with the other also released, `false`
- `unblock` of an already released token, of a token from before the slot was reused, and of an invalid token gives an error log and `false`, and other blocks stay as they are
- Also in a build without DEV code, `unblock` of a bad token leaves an error log
- After a block is acquired and the test clock advances by `InputBlockCore.maxDurationMs` − 1, one frame later it is an active block, and after the clock advances 1 more, one frame later forced release releases it and one error log is left
- Even when at least the max duration passes by background progress of the test clock, there is no forced release. During a `TimeCore` pause and at time scale 100 (permille), forced release also releases the block
- `scene`, `cutscene`, `tutorial`, `ad`, `boot` blocks are still active blocks after the max duration passes
- Destroying the owner object releases only that block, without a log
- While the operation of `run_blocked` waits, the block is an active block; when the operation ends with success, the block is released and the result is `true`, and with failure or cancellation, the block is released and the result is `false`
- Destroying the owner object during `run_blocked` releases the block, the result is `false` without waiting for the operation, and there is no log. The same holds when the owner object is omitted and the object the operation belongs to is destroyed
- When the operation ends after the block of `run_blocked` was released earlier by forced release or `release_all`, there is no error log
- In a block whose pass list has only action A, `pass_action` of A is `true`, and of other actions and `back` is `false`
- When a block with A in its pass list and a block without a pass list are active blocks together, `pass_action` of A is `false`
- `pass_position` of a position inside the area of a pass list UI element is `true`, and outside it is `false`. When that UI element is hidden or destroyed, inside is also `false`
- `pass_focus` of a pass list UI element and its descendant UI elements is `true`, and of a UI element outside is `false`. When that pass list UI element is hidden, its descendants are also `false`, and `pass_focus` of a destroyed UI element is `false`
- `release_all` keeps only the tag to keep, returns the number released and leaves a warn log per block
- After `release`, there is no active block and no log
- During `set_timer_hold`(`ui`, `true`), advancing the test clock by more than `InputBlockCore.maxDurationMs` gives no forced release, and after `false`, forced release releases the block at the frame where the time, added to the block elapsed time before the hold, reaches `InputBlockCore.maxDurationMs`. When `ui` and `network` are both `true`, changing only one to `false` keeps the timer hold
- After `restart_timer`, block elapsed time grows again from 0, and `restart_timer` of a bad token is `false` without a log
- `list_active` fills the reason tag, caller location and block elapsed time of all active blocks, and fills all of them into a buffer of size `count_active`
