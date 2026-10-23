# ResourceCore

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

Loads resources by resource key, holds and releases loaded resources per scope, and attaches received bundles so that the bundles' resources are used.

## dependency

`UtilCore`, `LogCore`, `LocalDataCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `load` | resource key, resource kind, scope | async operation. resource | fallback resource of the requested kind | all code |
| `get_loaded` | resource key, resource kind, scope | resource | fallback resource of the requested kind | all code |
| `is_loaded` | resource key, resource kind | whether it is in the cache and passes the kind check | `false` | all code |
| `preload` | `PreloadRequest`, scope | async operation. success flag (whether all items succeeded) | `false` | all code. `SceneCore` when there is a shader warmup item |
| `get_global_scope` | none | global scope | released scope | core module |
| `create_scope` | scope kind (`scene`, `panel`, `popup`), name | scope | released scope | `SceneCore`, `UICore` |
| `release_scope` | scope | none | none | `SceneCore`, `UICore` |
| `get_owner_scope` | owner object | owner scope | released scope | all code |
| `end_owner_scope` | owner object | none | none | `PoolCore`, `SoundCore` |
| `add_scope_release_listener` | listener: a function that receives the scope being released | none | none | core module |
| `remove_scope_release_listener` | listener | none | none | core module |
| `register_kind` | engine type, fallback resource | resource kind | invalid kind | module that depends on `ResourceCore` |
| `apply_bundles` | list of `DownloadedBundle` | success flag (whether all bundles were applied) | `false` | `BootstrapCore`(`InitModules` stage) |

- `PreloadRequest`: item list (resource key, resource kind, whether shader warmup), finished item count, total item count
- `Scope`: kind, name, whether released, list of the resource keys of its references. Only ResourceCore changes its state
- `DownloadedBundle`: bundle name, app storage path, SHA-256. `GameUpdateCore` creates it

## behavior

### resource lookup

- In `init`, ResourceCore reads the resource key list file that the harness tool creates in the logical folder `client/generated/` of [`client-content`](../../client-content/SKILL.md), and finds the file of a resource key with that list. The file path and format are in the engine-specific implementation rules. When a list was set with the DEV operation `set_test_key_list`, it uses that list without reading the file. When the file is missing or its format is wrong, it leaves an `error` log and `init` fails. A key in an applied bundle is found with the bundle's key list
- The resource key list holds the variant count per key. `load` of a key whose variant count is 2 or more loads all variant files and returns them as one list of resources in variant order
- Code outside ResourceCore does not call the engine's resource load functions. The function list is in the engine-specific implementation rules. A reference to another resource inside a resource file is not a load function call

### resource kind and fallback

- A resource kind is the engine type class of a resource that the caller sets per request. Base kinds exist from `init` and their list is in the engine-specific implementation rules. A registered kind is added with `register_kind`. An invalid kind is a value that points to no kind
- kind check: checks that the resource to return is of the requested kind. It runs on every `load` and `get_loaded`
- There is one fallback resource per kind. The fallback of a base kind is created at `init` from code or an engine built-in resource and discarded at `release`. The fallback of a registered kind is passed by the module that registers it. A fallback is not a reference target
- `load` and `get_loaded` do not return none. Exceptions: calls before `init` and after `release`, invalid kind

### scope

| scope kind | creator | release time |
|---|---|---|
| `global` | `init` | `release` |
| `scene` | `SceneCore` | scene transition |
| `panel` | `UICore` | panel closed, panel covered |
| `popup` | `UICore` | popup closed |
| `owner` | `get_owner_scope` | owner object destroyed, `end_owner_scope` |

- scope name: `global`; for scene, panel and popup, their resource key; for owner, the name of the owner object
- Only resources that a core spec puts in global are loaded into the global scope. e.g. font. Content code does not use the global scope
- There is one owner scope per owner object. Until it becomes released, the same scope is returned for the same owner object
- reference: a scope holding one resource key. One scope has only one reference to the same key. The reference count is the number of scopes that have a reference to that resource
- cache: keeps, by key, resources whose loading has finished and whose reference count is 1 or more
- When `load` or `get_loaded` returns a resource that is not a fallback, it adds a reference to the requesting scope. When the reference already exists, it adds none and allocates no memory
- There is no operation that releases only one resource. Resources are released per scope
- scope release order: mark the scope as releasing → call the scope release listeners in registration order → remove all references → remove resources whose reference count is 0 from the cache → make the scope released. For a releasing scope, whether released is `true`, and a request made with that scope is a request of a released scope
- When a listener releases another scope, that release runs the release order to the end on the spot and then returns. Each release calls the listeners of the registration list at the start of that release, in registration order; a listener removed during that release is not called in the remaining turns, and a listener added during that release is not called in that release
- A released scope does not go back. An owner scope is released only by owner object destruction and `end_owner_scope`. `end_owner_scope` does nothing when there is no owner scope
- `release` processing order: handle later calls as calls after `release` → end a waiting `load` with the fallback and a waiting `preload` with `false` (add no reference and leave no log) → destroy the shader warmup objects → make every scope released without listeners → delete the cache, the keys being loaded, the listeners, the registered kinds and the applied bundle key list → discard the fallbacks

### load

- For a key in the cache, the resource in the cache is returned without an engine load
- When the same key is being loaded, a new request shares the result of the engine load in progress. The engine load happens once per key, and a reference is added per request
- When the requesting scope is released before loading finishes, no reference is added and the fallback is returned
- `get_loaded` does no engine load. For a key that is not in the cache or is being loaded, it returns the fallback
- `is_loaded` leaves no log and allocates no memory

### preload

- `preload` loads all items by the same rules as `load`, and increases the finished item count by 1 each time an item finishes. The caller reads the progress state while it waits. e.g. loading screen progress
- item success: it got a resource that is not a fallback, and for a shader warmup item, the warmup also succeeded. A failed item also counts as a finished item
- shader warmup: compiling the shaders a resource uses before the first display of that resource. `SceneCore` calls it while the loading screen covers the screen. The kinds that can be warmed up are in the engine-specific implementation rules
- The caller adds items before `preload` and does not change items during `preload`

### bundle

- A bundle file holds the resources in the bundle and the list of their resource keys. The bundle patch section of the `build` skill sets which keys it holds, and the file format is in the engine-specific implementation rules
- `apply_bundles` is called once per `init`, before any `load` with any scope, because a resource loaded earlier stays in the cache and is not replaced by the bundle's resource. Bundles are applied in input order
  - A bundle is skipped when `LocalDataCore.hash_file` of the bundle file differs from the SHA-256 of `DownloadedBundle`, its name is not snake_case, it cannot be attached to the engine, or its key list cannot be read. The rest are applied
  - On an engine that can read the key list only after attaching, whether the file of a bundle skipped because its key list could not be read stays in the engine is in the engine-specific implementation rules. Keys of a skipped bundle are not looked up in the bundle
  - A key of an applied bundle is looked up in the bundle even when the resource key list has the same key. When several bundles have the same key, it is looked up in the bundle applied later
  - For each applied bundle, the bundle name and SHA-256 are left as an `info` log
- Applying is not undone. To change bundles, run `release`, `init` and `apply_bundles` again
- How a bundle file is attached to the engine is in the engine-specific implementation rules

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| key in neither the resource key list nor a bundle, engine load failure, kind check failure, no scope passed, released scope | fallback of the requested kind | one `error` per key until `release` |
| requesting scope released during loading | fallback. No reference is added | `warn` |
| key of `get_loaded` that is not in the cache or is being loaded | fallback | one `error` per key until `release` |
| `load`, `get_loaded` with an invalid kind | none | `error` |
| kind other than `scene`, `panel`, `popup` in `create_scope` | released scope | `error` |
| missing or destroyed object in `get_owner_scope`, destruction detection cannot start | released scope | `error` |
| global, owner or released scope in `release_scope` | does nothing | `error` |
| registering an already registered listener again | ignored | `error` |
| fallback of `register_kind` missing or not of that type | invalid kind | `error` |
| `register_kind` again for the same type | replaces the fallback and returns the same kind | none |
| shader warmup item of a kind that cannot be warmed up | only loads it and counts it as failed | `error` |
| `preload` again of a `PreloadRequest` that is in `preload` | `false`. The `preload` called first continues unchanged | `error` |
| second `apply_bundles`, `apply_bundles` after `load` | `false`. Does nothing | `error` |
| skipped bundle | result `false` | one `error` per bundle with its name and path |
| resource key list file missing or of wrong format in `init` | `init` failure | `error` |

## settings

none

## data

none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `list_loaded_resources` | none | key and reference count per resource in the cache | empty list | `QACore` |
| `list_scopes` | none | list of scopes that are not released | empty list | `QACore` |
| `set_test_key_list` | list that links resource keys to the engine paths of their resources, variant count of each key whose variant count is 2 or more | none | none | core test |

- `set_test_key_list` is called only before `init`. Called after `init`, it leaves an `error` log and does nothing. `release` deletes the set list. A `release` before `init` also deletes it
- A core test links test resources to resource keys with `set_test_key_list`. The method is in the engine-specific implementation rules
- leak check: in a build that contains DEV code, after a resource is removed from the cache, it is a leak when, at the time the engine-specific implementation rules set, a live object that can be found by the method the engine-specific implementation rules set references that resource. For each leak, an `error` log is left with the key and the name of the scope that removed the last reference. Resources that came back into the cache and resources that other resources in the cache reference inside their files are excluded. For an engine on which that method cannot be defined, the engine-specific implementation rules state that there is no leak check, and no leak check is done
- `release` and app exit run the leak check on the spot for resources whose time set by the engine-specific implementation rules has passed, and discard resources whose time has not come yet without a leak check

## test

- For each fallback condition of the error table, the fallback of the requested kind and an `error` log come out, and the log appears once even when the same key is requested several times. The same holds when a key in the cache is requested with another kind
- A fallback is in no scope's references and stays when a scope is released
- When several `load` calls of the same key arrive while it is loading, the engine load happens once and all get the same resource. A key in the cache returns without an engine load
- When one scope loads the same key several times, the reference count increases by only 1
- When a scope is released, resources referenced only by that scope leave the cache, and resources also referenced by another scope stay with their reference count reduced by 1
- Listeners are called in registration order before references are removed; inside a listener, whether that scope is released is `true` and `get_loaded` with that scope returns the fallback. A removed listener is not called
- When a listener of scope A releases scope B, before that listener returns, B is released and resources referenced only by B are not in the cache. The remaining listeners of A are called in the order of the list at the start of A's release; a listener removed during A's release is not called, and a listener added during it is not called in A's release
- Destroying the owner object makes the owner scope released. Two `get_owner_scope` calls for the same owner object return the same scope. After `end_owner_scope` it is released and the listener was called once
- Releasing the scope during loading gives the fallback as the result, leaves the reference count unchanged and leaves a `warn` log
- `release` while waiting on `load` and `preload` ends them with the fallback and `false`, with no log. After `release` there is no cache, scope or registered kind, and no listener was called
- Loading with a registered kind returns a resource of that type; for another type, the registered fallback and an `error` log come out
- After `preload`, the finished item count equals the total item count and increased by 1 per item, and the keys of successful items are in the scope's references. When an item got a fallback, the result is `false`. When there is a shader warmup item, it ends after the warmup ends
- After `apply_bundles`, a key of a bundle returns the bundle's resource. With two bundles that hold the same key, it is the later bundle's resource. When a bundle with a wrong SHA-256 is mixed in, an `error` log with that bundle's name and `false` come out, and the keys of the other bundles load
- `apply_bundles` after a `load` with the global scope gives an `error` log and `false`, and the bundle's keys are not loaded from the bundle
- `is_loaded` returns, without a log, `true` for a key and kind in the cache, and `false` for a key not in the cache, a key being loaded and another kind
- When `release` runs after the frame in which a resource was removed from the cache ends, a leak check `error` log is left for a resource that a live object references
- In a build that contains DEV code, when another live object references a resource removed from the cache, a leak check `error` log is left. An engine whose engine-specific implementation rules state that there is no leak check has no such test
- A ResourceCore that ran `init` after `set_test_key_list` loads the keys of the list as the resources at their paths. `set_test_key_list` after `init` gives an `error` log and the list does not change. After `release` there is no set list
- Core code has no engine resource load function call outside ResourceCore. The static check before core test checks it
- Without `set_test_key_list`, when the resource key list file is missing, `init` fails and an `error` log is left
