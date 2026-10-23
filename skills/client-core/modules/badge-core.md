# BadgeCore

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

Manages the displays (red dot, count) that announce new items and rewards to receive as a badge tree, and propagates the counts of child badges to the parent menu badge.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `ResourceCore`, `LocalDataCore`, `LocalizationCore`, `DataCore`, `UserStateCore`, `RequirementCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `prepare` | none | async operation. success flag | `false` | `BootstrapCore`(`Prepare` stage) |
| `register_evaluator` | badge ID, evaluator | success flag | `false` | content code |
| `set_count` | badge ID, count | success flag | `false` | content code |
| `set_item` | badge ID, item key, count | success flag | `false` | `NoticeCore`, `ChatCore`, content code |
| `clear_item` | badge ID, item key | none | none | `NoticeCore`, `ChatCore`, content code |
| `clear_items` | badge ID | none | none | content code |
| `refresh` | badge ID. All when omitted | none | none | content code |
| `get_count` | badge ID | total count of the badge | `0` | core, content code |
| `get_item_count` | badge ID, item key | count of the item | `0` | core, content code |
| `load_saved` | none | success flag | `false` | `BootstrapCore`(`AfterLogin` stage) |

### component

| component | operation | input | output | failure value | caller |
|---|---|---|---|---|---|
| `BadgeView` | `bind` | badge ID, item key(the badge itself when omitted) | success flag | `false` | content code |
| `BadgeView` | `unbind` | none | none | none | content code |

- A badge ID is an ID value of the `badge` table. Content code gets it from a reserved ID accessor or a `ref<badge.id>` column value
- An item key is a non-zero `long`. e.g. the ID value of a newly obtained item, a mail ID

## behavior

### badge tree

- data badge: one row of the `badge` table. When it has `parent`, it is a child of that badge
- item badge: a leaf that content code adds under a data badge with `set_item`. e.g. one newly obtained character, one mail with a reward to receive
- The count of an item badge is 1 or more. `set_item` with count 0 deletes that item the same as `clear_item` and returns `true`
- The own count of a data badge is the count the evaluator returned or the count received with `set_count`. When there is neither, it is 0
- total count = own count + sum of the total counts of child data badges + sum of the counts of item badges
- A data badge whose `requirement` is not 0 (empty cell) is judged with `RequirementCore.evaluate` when evaluators are called (a badge without an evaluator also at those times), on `load_saved`, and when the own count or an item count of that badge changes. Several judgements within one frame are merged into one at the end of that frame. Before the first judgement, `passed` counts as `false`
- A badge whose judgement result has `passed` `false` has total count 0. Its children and items do not propagate to the parent. e.g. a menu that is not unlocked has no red dot
- A badge is on when its total count is more than 0. A parent is on when any one child is on

### evaluator

- An evaluator is a handler hook that reads UserState and data and returns the own count of a badge. e.g. the number of attendance rewards that can be received, the number of equipment items that can be upgraded
- A badge with a registered evaluator does not accept `set_count`
- Several evaluator call triggers within one frame are merged into one at the end of that frame. The call every `BadgeCore.refreshIntervalMs` catches rewards that become receivable as time passes
- An evaluator does not wait

### recalculation and event

- When an own count or an item count changes, the total counts of that badge and its ancestor badges are recalculated at the end of the frame
- `BadgeChangedEvent` is emitted for each badge whose total count changed. Children are emitted before parents. It is not emitted for a badge that did not change
- When an item count changes, `BadgeChangedEvent` is emitted for that item

### save

- Item badges under a data badge whose `persist` is `true` are saved in the `user` file of `LocalDataCore`, key `BadgeCore.items`. An element is `<badge ID>:<item key>=<count>` per item badge; all three are decimal integers, and the count is 1 or more. They are saved at the end of the frame in which they changed. Nothing is saved before `load_saved`
- `load_saved` is called after `LocalDataCore.load_user_file`. Of the saved item badges, it adds only those whose badge and item key are not in memory. An item in memory uses the memory value. Saved values of badges whose `persist` became `false` and of badges not in data are discarded. Elements with a wrong format are discarded with a warn log. After that, when the save targets in memory differ from the saved values, it saves at the end of that frame
- Item badges of a badge whose `persist` is `false` disappear on `release` and restart

### display

- `BadgeView.bind` shows the display of the received badge over the UI element that `BadgeView` is attached to, and when it receives an item key, shows the display of that item badge. It updates the display each time the total count of that badge or the count of that item changes. When there is a connection, it replaces the previous connection. When it fails, it does not change the connection
- `BadgeView.unbind` hides the display and stops updating. When there is no connection, it does nothing
- `BadgeView` shows a dot for a badge whose `display` is `Dot`, and the count for a `Count` badge. An item badge follows the `display` of its parent data badge
- When the count is more than `BadgeCore.maxDisplayCount`, it shows `[badge_count_over]` formatted with `{count}` = `BadgeCore.maxDisplayCount`
- When the total count is 0, it hides the display
- `prepare` loads `BadgeCore.dotResource` in global scope. When it is an empty string or cannot be loaded, a red circle made in code is used. The count is shown as text over it
- When the object that `BadgeView` is attached to is destroyed, it cleans up the same as `unbind`

### release

- Deletes evaluators, own counts, item badges, `BadgeView` connections and whether `load_saved` was called. It does not delete saved values

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| badge evaluator | right after `register_evaluator` (that badge), on receiving `UserStateCore.UserStateChangedEvent` (all), on `refresh` (the received badge or all), every `BadgeCore.refreshIntervalMs` (all. Not done when 0) | badge ID | own count (integer, 0 or more) | a badge without a registered evaluator uses the `set_count` value |

- There is one evaluator per badge ID

## event

| event | when | payload |
|---|---|---|
| `BadgeChangedEvent` | end of the frame in which the total count of a badge or an item count changed | badge ID, item key (0 for the badge itself), new count |

## error

| condition | failure value | log |
|---|---|---|
| badge ID not in the `badge` table | each failure value | error |
| evaluator registered twice for the same badge ID | `false`. Keeps the first one | error |
| `set_count` of a badge with a registered evaluator | `false` | error |
| negative count | `false`. Value unchanged | error |
| item key of `set_item` is 0 | `false` | error |
| evaluator throws or returns a negative number | own count of that badge unchanged | error |
| dot prefab cannot be loaded in `prepare` | `false`. Uses a red circle made in code | error |
| `LocalDataCore.is_loaded`(`user`) is `false` at `load_saved` | `false`. Does not read saved values, and does not save after that either | error |
| `BadgeCore.items` element with a wrong format in `load_saved` | discards that element | warn |
| `clear_item` of an item that does not exist | none | none |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `BadgeCore.refreshIntervalMs` | integer | core | content | interval at which all evaluators are called again. Not done when 0 |
| `BadgeCore.maxDisplayCount` | integer | core | content | largest count shown as it is |
| `BadgeCore.dotResource` | string | core | content | resource key of the dot prefab. A red circle made in code when it is an empty string |

## data

`data/tables/badge.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `parent` | `ref<badge.id>?` | `Client` |
| `display` | `enum<BadgeDisplay>` | `Client` |
| `persist` | `bool` | `Client` |
| `requirement` | `requirement` | `Client` |
| `#comment` | comment column | |

- When `parent` points to the badge itself or to a descendant, it is a data check `cycle` error
- reserved string: `[badge_count_over]`

format argument

| text | arguments |
|---|---|
| `[badge_count_over]` | `{count}`(`integer`) |

`data/enums.csv`

| type | element |
|---|---|
| `BadgeDisplay` | `Dot`, `Count`. The game does not change it |

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `user` | `BadgeCore.items` | `array<string>` | item badges under a data badge whose `persist` is `true` |

## DEV

none

## test

- With data badges A and B under parent P, when the own count of A is set to 2 and the two items under B to 1 each, the total count of P is 4. When all are set to 0, P turns off
- Even when `UserStateChangedEvent` comes several times in one frame, the evaluator is called once per badge in that frame
- `refresh` calls only the evaluator of the received badge, and calls all evaluators when the badge is omitted
- A badge whose `requirement` judgement has `passed` `false` has total count 0 even when a child is on, and does not propagate to the parent. It turns on at the end of the frame of the UserState delta that made `passed` `true`, and the same holds for a badge without an evaluator. Before the first judgement, a badge with a requirement is off
- When `BadgeCore.refreshIntervalMs` passes, the evaluator is called; when it is 0, it is not called
- `BadgeChangedEvent` comes once, only for badges whose total count changed, and children come before parents
- `BadgeView` of a badge whose `display` is `Dot` shows a dot, and `BadgeView` of a `Count` badge shows the count; when the count is more than `BadgeCore.maxDisplayCount`, it shows the `[badge_count_over]` format result. At 0 it hides
- Items of a badge whose `persist` is `true` exist again after `release` and `init`, `load_saved`; items of a badge where it is `false` do not
- `set_item` on a badge whose `persist` is `true` before `load_saved` saves nothing and leaves no error log. After `load_saved`, that item exists with the memory value, an item that was only in the saved values also exists, and both are saved at the end of that frame
- When `BadgeCore.items` has an element with a wrong format, `load_saved` leaves a warn log and reads the items of the other elements
- Calling `load_saved` before the `user` file is loaded gives `false` and an error log, and after that `set_item` on a badge whose `persist` is `true` saves nothing
- `set_item`(count 0) is `true`, deletes that item, and `get_item_count` is 0. For an item that existed, `BadgeChangedEvent` comes once with new count 0; for an item that did not exist, none comes. For a badge whose `persist` is `true`, the item is also removed from the saved values
- For each condition in the error table, the log and the failure value of the table occur
- When an evaluator throws, the total count of that badge stays the previous value, and the calculation of other badges continues
- After the object that `BadgeView` is attached to is destroyed, there is no error log even when `BadgeChangedEvent` comes
- After `release`, evaluators are not called, and after `init` again, `register_evaluator` succeeds
