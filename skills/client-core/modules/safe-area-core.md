# SafeAreaCore

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

Calculates, in game coordinates, the safe area that the notch, punch hole, home indicator and rounded corners do not cover, and places UI elements to fit the safe area. Also reports, in game coordinates, the keyboard area that the screen keyboard covers.

## dependency

`LogCore`, `EventCore`, `ResolutionCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_safe_area` | none | safe area (game coordinates rectangle) | empty rectangle | core, content code |
| `get_inset` | side (`Left`, `Top`, `Right`, `Bottom`) | safe area inset of that side | 0 | core, content code |
| `get_keyboard_area` | none | keyboard area (game coordinates rectangle) | empty rectangle | `UICore`, content code |

- `get_safe_area`, `get_inset` and `get_keyboard_area` allocate no memory
- The safe area root and the ignore mark are UI components that core provides. Their form is set by the engine-specific implementation rules

## behavior

### calculation

- OS safe area: the uncovered rectangle inside the window that the platform reports, given as window pixel positions. `android` and `ios` use the OS value; other platforms use the whole window (origin, window size of `ResolutionCore`)
- The top-left and bottom-right corners of the OS safe area are converted to game coordinates with `ResolutionCore.window_to_game`
- safe area inset: the distance from each side of the visible game area to the same side of the safe area. Per side, it is the distance by which that side of the converted OS safe area lies inside the same side of the visible game area, and 0 when it does not lie inside. e.g. when the fill area covers the whole notch, that side is 0
- When the orientation is `Landscape`, the left and right insets are both set to the larger of the two
- safe area: the rectangle made by moving the four sides of the visible game area inward by each inset
- When the width or height of the safe area becomes 0 or less, it leaves an error log and sets all insets to 0

### UI layout

- SafeAreaCore fits only UI elements to the safe area. The scene's world and full-screen backgrounds are not affected by the insets
- The only targets whose layout it changes are safe area roots and UI elements with an ignore mark
- safe area root: a UI element whose position and size SafeAreaCore keeps equal to the safe area. It receives no input
  - UI elements of a UI layer that has a safe area root are placed under the safe area root. Exception: the color filter of `AccessibilityCore` is placed outside the safe area root in the `LoadingIcon` layer and covers the whole visible game area
  - `UILayer` values that have a safe area root: `SceneUI`, `VirtualPad`, `Panel`, `Cutscene`, `Loading`, `Popup`, `Tutorial`, `LoadingIcon`. The side that uses the layer places it
  - `UILayer` values that do not have a safe area root: `WorldEffect`, `CutsceneEffect`, `TransitionEffect`, `Message`, `Debug`
- ignore mark: a mark attached to a UI element. A UI element with it is placed with its anchors calculated against the visible game area instead of its parent. e.g. dim, a panel background that fills to the screen edges
  - Full-screen backgrounds inside panel and popup prefabs get an ignore mark
  - The parent of a UI element with an ignore mark is a safe area root or a UI element with the same position and size as a safe area root. In a build that contains DEV code, a violation leaves an error log, and the element is still placed against the visible game area
- Safe area roots and UI elements with an ignore mark are placed by the current safe area when they are created

### recalculation

- It calculates in `init` and sends no event. When the width or height of the window size is 0, it does not calculate, leaves no log and keeps a result with all values 0
- recalculation times: `GameAreaChangedEvent` received, device rotated 180 degrees, `set_virtual_notch` and `clear_virtual_notch` of DEV code
- For the 180-degree rotation, on `android` and `ios` it reads the OS safe area every `SafeAreaCore.rotationCheckIntervalMs` and recalculates when it differs from the previous value
- A recalculation that arises while `SafeAreaChangedEvent` is being sent runs after that publish returns
- When the safe area and insets from a recalculation all equal the previous ones, it does nothing. When any one of them changes, it places the safe area roots and UI elements with an ignore mark again and then sends `SafeAreaChangedEvent`

### keyboard area

- OS keyboard height: the height that the screen keyboard takes from the bottom side of the window, in window pixels. `android` and `ios` use the OS value; on other platforms it is 0. The engine mapping is in the engine-specific implementation rules
- keyboard area: an empty rectangle when the OS keyboard height h is 0. Otherwise, the overlap of the visible game area and the rectangle made by converting with `ResolutionCore.window_to_game` the top-left and bottom-right corners of the window pixel rectangle (x 0, y window height − h, width window width, height h)
- It calculates in `init` and sends no event
- Times it calculates again: on `android` and `ios`, the OS keyboard height read every frame differs from the previous value; `GameAreaChangedEvent` received; `set_virtual_keyboard` and `clear_virtual_keyboard` of DEV code. The per-frame read allocates no memory
- When the recalculated keyboard area differs from the previous one, it sends `KeyboardAreaChangedEvent`. When one `GameAreaChangedEvent` changes both the safe area and the keyboard area, `SafeAreaChangedEvent` is sent first

### lifecycle

- `release` deletes all registrations of layout targets and leaves their layout as it is. After `init` again, it lays out only the layout targets that enter the UI tree again
- `release` deletes the virtual keyboard

## hook

none

## event

| event | when | payload |
|---|---|---|
| `SafeAreaChangedEvent` | after a recalculation changes the safe area or an inset and the layout is redone | `inset_left`, `inset_top`, `inset_right`, `inset_bottom`: inset of each side |
| `KeyboardAreaChangedEvent` | after the keyboard area changes | `area`: keyboard area. An empty rectangle means there is no screen keyboard |

## error

| condition | failure value | log |
|---|---|---|
| width or height of the safe area 0 or less | all insets 0 | error |
| value that is not a side in `get_inset` | 0 | error |
| in a build that contains DEV code, the parent of a UI element with an ignore mark is outside the rules | placed against the visible game area | error |
| negative value in `set_virtual_notch` | ignored | error |
| negative value in `set_virtual_keyboard` | ignored | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `SafeAreaCore.rotationCheckIntervalMs` | integer | core | content | interval at which the OS safe area is read on `android` and `ios` to find a 180-degree rotation |

## data

none

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_virtual_notch` | distances of the left, top, right and bottom sides (window pixels, integer) | none | `QACore`, core test, client regression test |
| `clear_virtual_notch` | none | none | `QACore`, core test, client regression test |
| `set_virtual_keyboard` | height (window pixels, integer) | none | `QACore`, core test, client regression test |
| `clear_virtual_keyboard` | none | none | `QACore`, core test, client regression test |

- While a virtual notch is set, the OS safe area is the whole window shrunk from its four sides by those distances
- While a virtual keyboard is set, the OS keyboard height on every platform is that height

## test

Common conditions: the OS safe area is set with a virtual notch, and the window size and fill mode with `ResolutionCore.set_test_screen`. An item split by orientation is checked for both `Landscape` and `Portrait`, each set through the base resolution of `set_test_screen`

- When the virtual notch is all 0, all insets are 0 and the safe area equals the visible game area
- In a window with no fill area, when only the left and top of the virtual notch are greater than 0, the left and top insets are those distances converted with `window_to_game` and the bottom is 0. The right equals the left in `Landscape` and is 0 in `Portrait`
- In `Letterbox`, when the notch is at most the fill area band, the inset of that side is 0. When it is larger than the band, the inset is (notch − band) converted
- A virtual notch whose left and right sum is at least the window width gives an error log and all insets 0. A virtual notch with a negative value leaves an error log and the safe area does not change
- The position and size of a safe area root equal the safe area. A safe area root created after `set_virtual_notch` also matches
- The position and size of an ignore-mark UI element anchored to the whole safe area root equal the visible game area
- The position, relative to the visible game area, of an ignore-mark UI element anchored to the top-left of the safe area root equals its position relative to the safe area root without the ignore mark
- A `set_virtual_notch` that changes an inset sends `SafeAreaChangedEvent` once; a `set_virtual_notch` with the same values and `init` do not send it. When a subscriber receives it, the layout has the new values and the payload equals `get_inset`
- With a virtual notch set, a `set_test_screen` that changes the visible game area places the safe area root again and sends the event
- After `clear_virtual_notch`, the safe area and insets equal those before `set_virtual_notch`
- Before and after `set_virtual_notch`, the game coordinates position and size of UI elements outside the safe area root and of the world are the same
- In a build that contains DEV code, an ignore-mark UI element under a parent outside the rules leaves an error log and is placed against the visible game area
- When a `SafeAreaChangedEvent` subscriber calls a `set_virtual_notch` that changes an inset, the event is sent once more after that publish returns, and the two payloads equal `get_inset` at each publish
- Setting a virtual keyboard height h makes `get_keyboard_area` the rectangle of the two corners of the h band at the bottom of the window converted with `window_to_game`; `KeyboardAreaChangedEvent` comes once and its payload equals `get_keyboard_area`. Setting the same height again sends no event
- In a `Letterbox` window, when h is at most the bottom fill area band, the keyboard area is an empty rectangle
- On a platform other than `android` and `ios`, `clear_virtual_keyboard` after setting a virtual keyboard makes the keyboard area an empty rectangle with one `KeyboardAreaChangedEvent`
- `set_virtual_keyboard` with a negative height leaves an error log and the keyboard area does not change
- With a virtual keyboard set, after a `set_test_screen` that changes the visible game area and the safe area, the keyboard area is recalculated with the new visible game area, and `KeyboardAreaChangedEvent` comes after `SafeAreaChangedEvent`
- After `release` and `init` again, there is no virtual keyboard
