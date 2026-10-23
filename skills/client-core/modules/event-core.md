# EventCore

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

Delivers core events and content events, told apart by event type, to subscribers synchronously.

## dependency

`LogCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `subscribe` | event type, callback | success flag | `false` | all code |
| `unsubscribe` | event type, callback | none | none | all code |
| `unsubscribe_all` | subscriber | number of deleted subscriptions | 0 | all code |
| `count_subscriptions` | subscriber | number of subscriptions of that subscriber | 0 | `PoolCore`, core test |
| `acquire` | event type | event object to fill and pass to `publish` | none | for core events and content events, the side that defines the event type; for boot events, the module that `when` of the `## event` table names |
| `publish` | event | none | none | for core events and content events, the side that defines the event type; for boot events, the module that `when` of the `## event` table names |

## behavior

### event type

- An event is the notification object that EventCore passes to subscribers. An event type is the type of that object. Subscribing and publishing do not use string event names
- Every event type derives from the event base type of EventCore. How it derives is in the engine-specific implementation rules. An event type does not use another event type as its base

| kind | defined by | publisher | subscriber |
|---|---|---|---|
| core event | the `## event` table of each module spec. Defined in the core code of that module | the module that defines it | modules that depend on that module, content code |
| boot event | the `## event` table of this spec. Defined in the core code of EventCore | the module that `when` of the table names | the module that `when` of the table names, content code |
| content event | content code in `client/features/<feature>/`, `client/common/` | content code | content code |

- A module defines and publishes only the core events written in `## event` of its own spec. Only the module that `when` of the table names publishes a boot event
- A boot event is a notification between `BootstrapCore` and another module. With it, modules other than `BootstrapCore` do not depend on `BootstrapCore`
- Content events are used for notifications between features. The notification method inside one feature is not restricted
- An event type name is PascalCase and ends with `Event`. e.g. `QuestCompletedEvent`, `DayChangedEvent`
- Event fields hold only payload values. An ID value field is int32, a time is Unix ms, and a duration is ms

### subscribe

- A callback is a method of a subscriber object that receives one event and returns no result. The subscriber is the object the callback belongs to. One subscriber can have several subscriptions
- A lambda, a static function or a callback with bound arguments is not subscribed
- A subscriber receives only events of the event types it subscribed to
- A subscriber removes its own subscriptions before `release` or destruction. Objects of screens and prefabs use `unsubscribe_all`
- EventCore deletes the subscriptions of a subscriber destroyed without unsubscribing at the next `publish` of that event type, before delivering. When a subscriber is destroyed during a delivery and its subscription has not yet received in that delivery, EventCore deletes the subscription when that delivery reaches it. In either case it does not call the callback
- Later subscriptions reuse the record slots of deleted subscriptions. Even with repeated subscribing and unsubscribing, the number of subscription record slots of one event type does not exceed twice the maximum number of subscriptions that existed at the same time
- `unsubscribe_all` deletes all subscriptions of that subscriber regardless of event type. It does not delete the subscriptions of the subscriber's child objects

### publish and delivery

- A publisher fills every field of the event object it got from `acquire` and then calls `publish` right away. It does no other `acquire` or `publish` between `acquire` and `publish`
- EventCore keeps a list of event objects per event type and reuses them. The delivery depth is the number of `publish` calls of that type that have not yet returned. `acquire` returns the object at position delivery depth (counting from 0) in the list, and when there is none, makes one and adds it to the list. Publishing the same type inside a callback does not change the object of the outer delivery
- Delivery is synchronous. `publish` returns after all callbacks return. It does not queue events or defer them to the next frame
- The order of calling callbacks is not defined. Publishers and subscribers do not rely on the order
- Changes during a delivery
  - A subscription added during a delivery does not receive in that delivery
  - A subscription deleted during a delivery does not receive in that delivery when it has not yet received
  - A `publish` inside a callback delivers right away. The outer delivery continues after the inner `publish` returns
  - When `release` of EventCore runs inside a callback, that delivery and all outer deliveries return without a log and without delivering to the remaining subscriptions. The same holds when `init` follows inside the callback
- Even when one callback fails, it delivers to the remaining subscriptions and finishes `publish`
- A subscriber does not change the fields of a received event and does not reference the event after the callback returns. It copies the values it needs
- `publish`, `unsubscribe_all`, `count_subscriptions`, and `acquire` when the object of that delivery depth already exists do not allocate memory. Logs and the code inside callbacks are excluded
- In a build that contains DEV code, each `publish` leaves a `debug` log with the event type name and the number of subscriptions whose callback was called

## hook

none

## event

boot event

| event | when | payload |
|---|---|---|
| `RestartRequestedEvent` | A core module other than `BootstrapCore` publishes it when it needs a restart. `BootstrapCore` subscribes | `module`: name of the publishing module |
| `FatalErrorRequestedEvent` | A core module other than `BootstrapCore` publishes it when it meets an unrecoverable failure. `BootstrapCore` subscribes | `module`: name of the publishing module, `reason`: English text |
| `BootCompletedEvent` | `BootstrapCore` publishes it at boot stage `Done`. `QACore` subscribes | `duration_ms`: device monotonic time (ms) elapsed from the start of `InitModules` of that boot. A boot after a restart or update reboot is also measured from the start of `InitModules` of that boot. It does not use the test clock |
| `AppQuitEvent` | `BootstrapCore` publishes it when it starts the app exit. `AuthCore` subscribes | none |

## error

| condition | failure value | log |
|---|---|---|
| `subscribe` again of the same callback to the same event type | `false`. The first subscription stays | `error` |
| `subscribe` of a lambda, a static function or a callback with bound arguments | `false` | `error` |
| `subscribe` with a callback of a destroyed subscriber | `false` | `error` |
| subscriber destroyed without unsubscribing | deletes the subscriptions | one `error` per subscription |
| a callback fails | delivers to the remaining subscriptions | `error` per failed callback when the engine reports callback failures. Whether it reports them is in the engine-specific implementation rules |
| `unsubscribe` of a subscription that does not exist | does nothing | none |
| `subscribe`, `unsubscribe`, `acquire` of a type that does not derive from the event base type or of a type based on another event type | `subscribe` is `false`, `unsubscribe` does nothing, `acquire` is none | `error` |
| the event that `publish` receives is not the object of the current delivery depth of that type | does not deliver | `error` |

## settings

none

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `register_init_listener` | listener (a function called when `init` finishes). A custom `Callable` (lambda, `bind()`) is not registered and gives an `error` log | none | none | `UnitTestCore` |

- `register_init_listener` is called before `init`. A call that a listener makes during `init` also counts as a call after `init`
- Right before `init` finishes, after it can accept subscriptions, it calls the registered listeners once each in registration order. `release` deletes the registrations
- When at registration the listener is a function that cannot be called (an empty function, a method of a destroyed object), it leaves an `error` log and does not register it. A listener whose object is destroyed after registration is skipped without a log. When a listener calls `release`, the remaining listeners are not called and `init` returns `false`

## test

- With X subscribed to event type A and Y subscribed to B, publishing A calls only the callback of X, once, before `publish` returns, and after X calls `unsubscribe` for A, the callback is not called
- A second `subscribe` of the same callback, a lambda callback, and `subscribe` of a destroyed subscriber each give `false` and an `error` log, and a following publish calls those callbacks 1, 0 and 0 times
- Publishing after destroying a subscriber without unsubscribing does not call the callback, `count_subscriptions` does not count that subscription, and there is one `error` log per subscription
- When subscribers X and Y subscribe to the same type and each callback destroys the other, publishing calls only the callback of the one that receives first, once, and there is one `error` log for the destroyed one's subscription in total across that publish and the next publish
- `unsubscribe_all` deletes the subscriptions of that subscriber for all event types and returns the number deleted, and keeps the subscriptions of other subscribers and of child objects
- When a callback adds a new subscription during a delivery, the subscription does not receive in that delivery and receives in the next publish. When it deletes a subscription that has not yet received, that subscription does not receive in that delivery. When it publishes another event, the subscribers of that event receive it before the outer `publish` returns
- When a callback of type A calls `acquire` for A, fills other values and calls `publish`, the subscribers of the inner delivery receive the inner values, and the subscribers that have not yet received in the outer delivery receive the outer values. After one nested publish at delivery depth 2, `acquire` and `publish` up to the same depth do not allocate memory
- When a type that three subscribers subscribed to is published and the callback that receives first calls `release` of EventCore, the other two do not receive and `publish` returns without a log. Even when a callback of an inner `publish` calls `release` and then `init`, the inner and outer `publish` return without a log and without delivering to the remaining subscriptions, and after that a new subscription to the same type followed by `acquire` and `publish` delivers without an error log
- `publish` of an object not received from `acquire` gives no delivery and one `error` log
- For each of a type that does not derive from the event base type and a type based on another event type, `subscribe` is `false`, `unsubscribe` does not change subscriptions, `acquire` is none, and there is one `error` log per call
- On an engine that reports callback failures, when the callback of one of three subscribers fails, the other two receive in the same publish, the next publish also goes to all three, and there is one `error` log per failed publish
- On an engine that does not report callback failures, when the callback of one of three subscribers stops with a runtime error, the other two receive in the same publish and in the next publish, and there is no EventCore log
- Even with 1000 repetitions of subscribing and unsubscribing during a delivery, the number of subscription record slots of that event type does not exceed twice the maximum number of concurrent subscriptions
- In a build that contains DEV code, publishing an event type with 2 subscriptions leaves one `debug` log that holds the event type name and 2
- After `release` and then `init`, there are no previous subscriptions
- A listener registered before `init` or after `release` is called at the next `init`. `register_init_listener` after `init`, and inside a listener during `init`, leaves one `error` log and does not register
- When D is the difference between the device monotonic times the test reads right before `start_boot` and when it receives `BootCompletedEvent`, `duration_ms` is at least 0 and at most D. The `duration_ms` of the boot after a restart is at most the difference between the device monotonic times at the restart request and when the test receives `BootCompletedEvent` of that boot
- The four boot event types are in the core code of EventCore, and the core code of other modules does not define those types
