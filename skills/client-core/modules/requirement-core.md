# RequirementCore

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

Judges conditions defined with the `requirement` table of data (unlock conditions, start conditions) from UserState and data, and tells when the judgement result changes. The server judges again with the same table and the same rules.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `DataCore`, `LocalizationCore`, `UserStateCore`, `NetworkCore`, `UICore`

- Uses `NetworkCore`, `UICore` only to subscribe to trigger events, `LocalizationCore` only for the `FormatArgs` type, and `TimeCore` only to judge time-dependent conditions again

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_judge` | `RequirementType` element, judge hook, list of UserState kinds it reads, translation key of the guide text, guide argument hook (optional), time-dependent flag (`false` when omitted) | success flag | `false` | content code |
| `evaluate` | requirement ID value | `RequirementResult` | `passed` `false`, `failed_requirement_id` the input ID, `guide_key` none | content code, `TutorialCore`, `ShortcutCore`, `BadgeCore`, `CutsceneCore` |
| `watch` | requirement ID value, trigger list, callback, owner object (optional) | success flag | `false` | content code, `TutorialCore` |
| `unwatch` | requirement ID value, callback | none | none | content code, `TutorialCore` |
| `fill_guide_args` | `RequirementResult`, `FormatArgs` of `LocalizationCore` | none | none | content code, `ShortcutCore` |

- `RequirementResult`: `passed`(pass flag), `failed_requirement_id`(ID value of the first failed condition. 0 on pass), `guide_key`(guide text translation key of the type of the first failed condition. none on pass or when there is none)
- `RequirementResult` is a value the module holds per condition. It changes at the next `evaluate`. The caller does not change it and copies the values it keeps
- watch callback: the input is the watched requirement ID value and the `RequirementResult` of that condition that batch evaluation judged. output none

## behavior

### condition and combination

- A condition is one row of the `requirement` table. Other tables write conditions as expressions in a column of `requirement` type. The data tool turns the expression into rows of this table, and the column value is the ID value of the top condition. The `data` skill defines the expression grammar
- requirement ID value 0 is an empty `requirement` cell and has no condition. Judging 0 calls no judge hook and is pass without log, with `failed_requirement_id` 0 and `guide_key` none
- self judgement: the pass flag that a condition whose `type` is not `None` gets from the judge hook of that type. A condition whose `type` is `None` is a group condition and has no self judgement
- item: self judgement, then the child conditions of `children`, in this order. Items are judged in order, and nothing after the stop item is judged

  | `logic` | pass | stop item | first failed condition item |
  |---|---|---|---|
  | `None` | self judgement is pass | none | self judgement |
  | `All` | every item is pass | first fail item | first fail item |
  | `Any` | one or more items are pass | first pass item | first item |

- first failed condition: that condition when the self judgement item sets it, and the first failed condition of that child condition when a child condition item sets it
- The self judgement of a type without a judge hook is fail and has no `guide_key`

### judge hook

- `register_judge` is once per type. An already registered type and `None` leave an error log and give `false`
- A judge hook reads only UserState (`UserStateCore`), data (`DataCore`) and `TimeCore` server time. It does not change state, sends no requests, raises no events, and does not call `evaluate`, `watch`, `unwatch`
- time-dependent type: a type registered with the time-dependent flag `true` in `register_judge`. A type whose judge hook reads `TimeCore` server time or a time-dependent operation of `UserStateCore` is registered as a time-dependent type. These values change with time without a change number
- When the needed UserState is missing, the judge hook returns `false`
- The list of UserState kinds it reads is all kinds the judge hook reads

### cache

- Each condition keeps its last `RequirementResult` and whether it is valid. When there is a valid cache, the judge hook is not called. Child condition items also use the cache
- kinds a condition looks at: all kinds read by the judge hooks of the types of that condition and all its child conditions
- time-dependent condition: a condition where the types of that condition or its child conditions include a time-dependent type. A time-dependent condition keeps no cache and is judged at each `evaluate`. Its child conditions that are not time-dependent conditions use the cache
- When the `UserStateCore` change number of at least one kind the condition looks at changes after the judgement, that cache is invalid. `evaluate` during the apply of a UserState delta also judges with the values applied up to then
- `register_judge` invalidates the cache of the conditions of that type and of all conditions that have those conditions as children
- Data does not invalidate the cache. New data is applied through the restart of `BootstrapCore`
- Content code does not call `evaluate` each frame to find changes. It receives changes through `watch`

### watch

- `watch` judges the condition, keeps the result as the reference result (`passed`, `failed_requirement_id`) and does not call the callback
- trigger: when to judge the watched condition again

  | trigger | target | raised when |
  |---|---|---|
  | `UserStateChanged` | UserState kind. When empty, all kinds the condition looks at | `UserStateCore.UserStateChangedEvent` was raised for that kind |
  | `RequestCompleted` | request name | `NetworkCore.RequestCompletedEvent` was raised with that name. Success and failure are not distinguished |
  | `UIOpened` | panel key or popup key | `UICore.UIOpenedEvent` was raised with that key |
  | `UIClosed` | panel key or popup key | `UICore.UIClosedEvent` was raised with that key |
  | `ContentEvent` | content event type | a content event of that type was raised through `EventCore` |

- The event subscription is made once at the first `watch` of that trigger and removed when the last watch of that trigger is deleted
- When a trigger is raised, the watches with that trigger are only marked as pending evaluation. They are not judged at that time
- A watch of a time-dependent condition also becomes pending evaluation outside triggers. While there is one or more such watch, RequirementCore marks all those watches as pending evaluation every `RequirementCore.timeRecheckMs` of `TimeCore` real elapsed time, and on receiving `TimeCore.DayChangedEvent`
- A watch given an owner object is deleted without log or callback when the owner object is destroyed. A watch set from a screen gives the root object of that screen as owner object
- `unwatch` deletes the watch with the same requirement ID and callback. When there is none, it does nothing

### batch evaluation

- When a pending evaluation appears, a batch evaluation is scheduled. The batch evaluation runs after the call that made the pending evaluation returns, before the content update of the next frame. It also runs during `TimeCore` pause
- Each round takes the pending evaluation watches at the start of that round one by one: clears the mark, runs `evaluate`, ends when `passed` and `failed_requirement_id` equal the reference result, and otherwise changes the reference result and calls the callback
- A pending evaluation that appears during batch evaluation is judged in the next round of the same batch evaluation. When the round count exceeds `RequirementCore.maxBatchRounds`, leaves an error log and deletes the remaining pending evaluations
- When one callback throws, the remaining watches are still judged. The callback order is not defined

### server evaluation

- The server handler of a request with an unlock condition judges the same condition again with `validation.evaluate_requirement`
- The rules of combination and first failed condition are the same on server and client. For the same UserState and data that use only types with a judge hook, `passed` and `failed_requirement_id` of server evaluation equal the client judgement. The client judgement is used only for display and pre-check
- A core test checks that they are equal with the core test fixture `requirement-evaluation` that client and server both read (ID names of requirement rows, UserState, judge hook results per type)
- A regression test checks with the shared formula of the `client-content` skill that client and server evaluation of a judge hook that content registers are the same

### lifecycle

- `init` reads no data and makes only an empty store. A condition's result and cache are made when that condition is judged the first time
- `init` subscribes to `TimeCore.DayChangedEvent`
- `release` deletes judge hooks, watches, caches, pending evaluations, event subscriptions, and the record of IDs and types that left an error log. It does not call callbacks
- `evaluate` before `init` and after `release` gives the failure value and an error log

## hook

| hook | when | input | output | default |
|---|---|---|---|---|
| judge hook(handler hook) | self judgement of one `RequirementType` element | `requirement` row | pass flag | when absent, the self judgement of that type is fail, with one error log per type |
| guide argument hook(handler hook) | `fill_guide_args` calls it for the type of the first failed condition | `requirement` row, `FormatArgs` | none. Puts arguments in `FormatArgs` | leaves it empty |

- `fill_guide_args` runs `clear` on `FormatArgs` and then calls the hook. For a result whose `passed` is `true`, it leaves it empty

## event

none

## error

| condition | failure value | log |
|---|---|---|
| the guide argument hook throws | empties `FormatArgs` | error |
| `evaluate` of a requirement ID that is not 0 and not in the table | failure value | error once per ID |
| self judgement of a type without a judge hook | that item fails | error once per type |
| `register_judge` of an already registered type or `None` | `false`. The hook registered first remains | error |
| `watch`: a watch with the same requirement ID and callback exists, ID 0, ID not in the table, empty trigger list, destroyed owner object | `false` | error |
| batch evaluation round count exceeded | deletes the remaining pending evaluations | error |
| the judge hook throws or its output format is wrong | that `evaluate` gives the failure value and keeps no cache | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `RequirementCore.maxBatchRounds` | integer | core | content | maximum round count of one batch evaluation |
| `RequirementCore.timeRecheckMs` | integer | core | content | real elapsed time interval at which watches of time-dependent conditions are marked as pending evaluation |
| `TimeCore.reachMarginMs` | integer | core | content | ms added to the reach judgement of `TimeCore`. Used for expected times in tests |

## data

`data/tables/requirement.csv`. The data tool makes this table at build time from cells of `requirement` type, and the game does not keep this CSV file

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `type` | `enum<RequirementType>?` | `All` |
| `target_id` | `int` | `All` |
| `value` | `long` | `All` |
| `children` | `array<ref<requirement.id>>` | `All` |
| `logic` | `enum<RequirementLogic>?` | `All` |

- `target_id`: ID value or enum value of the target of the self judgement. `0` when there is none. `value`: criterion value of the self judgement. `0` when there is none
- Rows the data tool makes keep the following
  - When `children` is empty, `logic` is `null`; otherwise it is `All` or `Any`
  - When `type` is `null`, the row is a group condition and `children` is not empty
  - Following child conditions does not reach the row itself
- The requirement expression of the `data` skill sets the build target of each row. Client build data has only rows whose build target is `Client` or `All`, and server build data only rows whose build target is `Server` or `All`

`data/enums.csv`

| type | element |
|---|---|
| `RequirementType` | set by the game. The argument format of each element is written in `data/requirement_types.csv` |
| `RequirementLogic` | `All`, `Any`. The game does not change it |

reserved ID, reserved string, reserved sound: none

## DEV

none

## test

- For conditions whose `logic` is `None`, `All`, `Any`, the pass flag matches the combination table, and judge hooks of items after the stop item are not called
- For a result whose `passed` is `false`, `failed_requirement_id` follows the first failed condition rule and `guide_key` is the value received in `register_judge` of that type
- Each call of the error table gives the result and log count of the table
- When a judge hook throws, the `evaluate` that judged that condition gives the failure value (`passed` `false`, `failed_requirement_id` the input ID, `guide_key` none) and one error log, and the next `evaluate` calls the judge hook again
- `evaluate`(0) returns a result with `passed` `true` and `failed_requirement_id` 0, without a judge hook call or log
- Two `evaluate` calls of the same condition without delta apply call the judge hook once
- After delta apply of a kind the condition looks at, `evaluate` of that condition and its parent conditions calls the judge hook again, and after a change of only kinds it does not look at, it does not
- A watch with a `UserStateChanged` trigger whose target is empty becomes pending evaluation after delta apply of a kind the condition looks at, and does not after a change of only kinds it does not look at
- For a condition with a time-dependent type in a child condition, two `evaluate` calls without delta call the judge hook of that type twice, and the judge hook of a child condition that is not a time-dependent condition once
- When `watch` is set on a condition of a time-dependent type that reads the balance of a recovery item, after the result changes through recovery without delta and the test clock advances by `RequirementCore.timeRecheckMs`, the callback is called once in the next batch evaluation. It is also judged after `DayChangedEvent`. A watch that is not of a time-dependent condition is not judged at that time
- When `watch` is set on a condition of a time-dependent type that reads `UserStateCore.get_shop_purchase_count`, after server time reaches `reset_at` + `TimeCore.reachMarginMs` of that object without delta and the result changes, and the test clock advances by `RequirementCore.timeRecheckMs`, the callback is called once in the next batch evaluation
- After judging a type without a hook, `register_judge` and judging again calls the hook
- `watch` does not call the callback, and even when the result changes there is no callback before a trigger
- For each trigger kind, raising the trigger gives no callback until that call returns, and the callback is called once with the watched requirement ID value and the new `RequirementResult` before the content update of the next frame
- When a trigger is raised but the result equals the reference result, there is no callback
- Even when the trigger of the same watch is raised several times before batch evaluation, the callback is called once, and even when several watches of the same condition that is not time-dependent are pending, the judge hook is called once
- `RequestCompletedEvent` of a failed request also raises the `RequestCompleted` trigger
- After `unwatch` and after the owner object is destroyed, there is no callback and no log
- The watch of a trigger raised inside a callback is judged in the next round of the same batch evaluation
- When one callback throws, the remaining callbacks of the same batch evaluation are called
- After `release` and `init` again, the previous hooks, watches and caches are gone
- `init` before `DataCore.load` reads no container and leaves no log. The first `evaluate` after `load` returns the result of that condition
- After `fill_guide_args`, `FormatArgs` has only the values the hook put in
- For the same core test fixture `requirement-evaluation` (ID names of requirement rows, UserState, judge hook results), `passed` and `failed_requirement_id` of the client judgement and of the requirement evaluation of server `validation` are equal
