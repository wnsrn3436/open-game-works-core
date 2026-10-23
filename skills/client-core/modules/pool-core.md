# PoolCore

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

Provides an object pool that keeps instances made from a prefab without destroying them and lends them out again.

## dependency

`LogCore`, `EventCore`, `ResourceCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `prefill` | `PrefillItem` list | async operation. success flag (whether every item succeeded) | `false` | all code |
| `borrow` | resource key, pool scope, owner object(optional) | handle | empty handle | all code |
| `give_back` | handle | none | none | all code |
| `notify_finished` | finished auto-return instance | none | none | pool object |
| `is_valid` | handle | whether the handle is valid | `false` | all code |
| `get_instance` | handle | instance | none | all code |
| `get_pool_state` | resource key, pool scope | in-pool instance count, borrowed count | 0, 0 | all code |
| `add_return_cleaner` | return cleaner | none | none | modules that depend on `PoolCore` |

- `PrefillItem`: prefill item. resource key, pool scope, prefill count (optional)
- return cleaner: a function that receives one component object of an instance, cleans it up, and returns the number of items left after the cleanup. e.g. `TweenCore` stops the tweens of that object

## behavior

### pool and pool object

- There is one object pool per pair of resource key and pool scope. The resource key points to a prefab
- The pool scope is the `ResourceCore` scope the pool belongs to
- A pool object is an instance the pool made. The component objects are the pool object and the objects that were under it when the pool made that instance
- An instance made and destroyed 2 or more times within one scene is borrowed from a pool. e.g. effect, projectile, damage text, scroll cell. Scenes, panels, popups and instances made only once within one scene are not put in a pool
- A pool object implements two functions: `on_borrow` (right before lending), `on_return` (on return, before common cleanup). The two functions restore the state that common cleanup does not restore
- The return mode is set by the auto-return flag member of the pool object. The default is manual-return. PoolCore reads this value once when it makes the instance and uses that value until the instance is destroyed. The member name is in the per-engine implementation rules
  - auto-return: an instance with a set end. e.g. an effect played once, damage text. When it ends, it calls `notify_finished` and PoolCore takes it back
  - manual-return: an instance that is not auto-return. The borrower calls `give_back`
  - The borrower can also `give_back` an auto-return instance before it ends

### borrow

- `borrow` ends without waiting
- Borrowing from a pool that does not exist creates the pool. The prefab is obtained by `ResourceCore.get_loaded` with the pool scope
- When there is no in-pool instance, PoolCore makes a new one and lends it
- Right before lending, PoolCore restores the instance's visibility to the value at creation and calls `on_borrow`. For an auto-return instance, it emits `EffectSpawnedEvent` after `on_borrow`
- The borrower attaches the borrowed instance to a parent

### handle

- generation number: an integer kept per pool object. It goes up by 1 on return. An instance whose generation number is the maximum in the per-engine implementation rules is destroyed on return instead of kept in the pool
- A handle is the borrowed instance and the generation number at lending. An empty handle points to no instance
- valid handle: the instance is not destroyed and the handle's generation number equals the current generation number
- The borrower keeps a pool object in a field or callback only as a handle. A local variable within one function can hold the instance
- The holder of a handle of an auto-return instance or owner-bound instance checks it with `is_valid` before `get_instance`

### return

- `give_back` and `notify_finished` follow the order below. `notify_finished` is treated as a call with the handle of that instance's current generation number
  1. Checks the handle
  2. When the instance has the in-pool mark on, stops (double return)
  3. Turns on the in-pool mark, lowers the borrowed count by 1 and raises the generation number by 1
  4. Calls `on_return`
  5. Runs common cleanup
  6. When the in-pool instance count, not counting the returned instance, is `PoolCore.maxPoolSize` or more, destroys the instance. Otherwise keeps it in the pool
- common cleanup order: `ResourceCore.end_owner_scope` per component object → return cleaners per component object in registration order → `EventCore.unsubscribe_all` per component object → hide the instance → detach it from the parent → set the position to the value at creation
- The double return check also runs in STG·PROD builds

### owner-bound borrow

- Passing an owner object to `borrow` makes an owner-bound borrow. PoolCore gets the owner scope with `ResourceCore.get_owner_scope`
- When the owner scope is released, PoolCore handles the owner-bound instances of that scope
  - An instance that is not a descendant of the owner object is taken back
  - An instance that is a descendant of the owner object is treated as destroyed together with the owner object. Without `on_return` and common cleanup, PoolCore removes it from the pool and lowers the borrowed count by 1
  - When the release comes from `end_owner_scope` in common cleanup, descendant instances are also taken back
- Another pool object attached under a component object of a pool object is borrowed owner-bound with that component object as owner

### direct destroy

- A pool object is not destroyed outside PoolCore
- A pool object destroyed outside PoolCore is removed from the pool. When it was a borrowed instance, the borrowed count goes down by 1. The detection method is in the per-engine implementation rules

### size

- `prefill` creates a pool per item, and when the in-pool instance count is less than the prefill count, makes the missing number of instances. When the count is more, it neither makes nor destroys instances. The prefab is obtained by `ResourceCore.load` with the pool scope
- An omitted prefill count is `PoolCore.defaultPrefillCount`. A count larger than `PoolCore.maxPoolSize` is treated as `PoolCore.maxPoolSize`. A pool remembers the last prefill count, and a pool never prefilled has 0
- Even when an item fails, the remaining items are filled
- When the pool scope of an item is released while waiting for the prefab, that item fails without a log and creates no pool
- `SceneCore` fills the pools of the scene scope in the preload step of a scene transition. For any other pool, the code that borrows fills it before borrowing
- On a memory warning, PoolCore destroys, in every pool, the in-pool instances beyond the prefill count. How the warning is received is in the per-engine implementation rules

### scope and lifecycle

- PoolCore registers one scope release listener with `ResourceCore.add_scope_release_listener` in `init` and removes it with `ResourceCore.remove_scope_release_listener` in `release`. It receives the release of pool scopes and owner scopes through this listener
- When a pool scope is released, for each pool of that scope: takes back every borrowed instance → destroys every pool object → removes the pool
- `release` destroys every pool object, borrowed instances included, and removes every pool
- `borrow`, `give_back`, `notify_finished`, `is_valid`, `get_instance`, `get_pool_state` do not allocate memory. Exceptions: creating a new pool or instance, getting an owner scope for the first time, growth of the owner-bound record, log, the code inside `on_borrow`, `on_return` and return cleaners

## hook

none

## event

| event | when | payload |
|---|---|---|
| `EffectSpawnedEvent` | When an auto-return instance is lent. `QACore` counts it as feedback | none |

## error

| condition | failure value | log |
|---|---|---|
| Prefab that does not implement `on_borrow`, `on_return` | empty handle for `borrow`, failure of that item for `prefill` | `error` |
| Prefab for which `ResourceCore.load` or `get_loaded` returned the fallback resource | empty handle for `borrow`, failure of that item for `prefill` | none. `ResourceCore` writes it |
| `borrow` with a pool scope that is released or releasing | empty handle | `error` |
| Owner-bound borrow with a destroyed owner object or a released owner scope | empty handle. The borrowed count is unchanged | `error` |
| Prefill item with a released pool scope | failure of that item | `error` |
| `give_back`, `get_instance` with an invalid handle | does nothing, none | `error`. log none for an empty handle |
| double return | does nothing | `error` |
| `notify_finished` of a manual-return instance, `notify_finished` of an instance the pool did not make | ignored | `error` |
| Pool object destroyed outside PoolCore | removed from the pool | `error`. log none for an owner-bound instance destroyed together with its owner object and during `release` |
| Release of a pool scope that has borrowed instances | takes back the borrowed instances | `error`. log none during `release` |
| prefill count > `PoolCore.maxPoolSize` | treated as `PoolCore.maxPoolSize` | `warn` |
| Registering a registered return cleaner again | ignored | none |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `PoolCore.defaultPrefillCount` | integer | core | content | prefill count of an item that omits the prefill count. 0 or more |
| `PoolCore.maxPoolSize` | integer | core | content | maximum number of in-pool instances one pool keeps. Borrowed instances are not counted |

## data

none

## DEV

- When there is no in-pool instance and a new one is made and lent, a build with DEV code leaves a `warn` log
- leak check: in a build with DEV code, when after common cleanup `EventCore.count_subscriptions` counts 1 or more subscriptions whose subscriber is a component object, or a return cleaner returns 1 or more items left, PoolCore leaves an `error` log

## test

- `is_valid` returns `true` for a handle before it is given back, and `false` for the previous handle after giving back and for an empty handle, without a log
- A returned instance has no parent, is hidden, has the position value at creation, has no subscription whose subscriber is a component object, and the return cleaner was called once per component object
- In a build with DEV code, when a return cleaner returns 1 item left, a leak check `error` log is written
- Releasing a pool scope with borrowed instances writes an `error` log and calls `on_return` per borrowed instance, and after the release every pool object is destroyed and there is no pool
- Destroying a borrowed instance and an in-pool instance outside PoolCore writes an `error` log for each, and they drop out of `get_pool_state`
- For an owner-bound instance that is not a descendant of the owner object, destroying the owner object calls `on_return` and takes the instance back. A descendant instance leaves the pool without an `error` log, and `on_return` is not called
- Giving back an instance to which another instance, owner-bound borrowed with a component object as owner, is attached takes the attached instance back without destroying it
- Prefilling an empty pool gives an in-pool instance count of the prefill count, `PoolCore.defaultPrefillCount` when the count is omitted, and `PoolCore.maxPoolSize` when the count exceeds it. Prefilling a pool that has more does not reduce the count
- When borrowing from a pool that does not exist and the prefab is in the cache, the pool is created and a build with DEV code writes a `warn` log. When the prefab is not in the cache, the result is an empty handle and there is no pool, and the log is one `error` from `ResourceCore` and no log from PoolCore
- Giving back to a pool whose in-pool instance count is `PoolCore.maxPoolSize` destroys that instance and leaves the count unchanged. Giving back to a pool at `PoolCore.maxPoolSize` − 1 keeps the instance in the pool, and the count becomes `PoolCore.maxPoolSize`
- An auto-return instance is taken back by its `notify_finished`
- A pool object whose auto-return flag member is not changed is manual-return. Changing the member after the instance is made leaves the return mode of that instance unchanged
- Each `borrow` of an auto-return instance emits `EffectSpawnedEvent` once, and a `borrow` of a manual-return instance or with an empty handle emits none
- After a memory warning, the in-pool instance count of every pool is at most the prefill count
- Releasing the pool scope while prefill waits for the prefab gives `false` without a log, and `get_pool_state` is 0, 0
- After `release`, every pool object is destroyed and there is no pool, and there is no `error` log even with borrowed instances
- After `release` and `init`, destroying the owner object of an owner-bound instance calls `on_return` of that instance once
- For each condition of the error table, the failure value and log match the table
- Repeating `borrow`, `is_valid`, `get_instance`, `get_pool_state`, `give_back` on a manual-return pool with in-pool instances allocates no memory. The `on_borrow`, `on_return` and return cleaner of that pool object do nothing
