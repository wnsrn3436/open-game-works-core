# VirtualPadCore

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

Draws virtual joysticks and virtual buttons on a touch screen and turns their pointers into action injects of `InputCore`. Saves on the device the placement that the user changed.

## dependency

`LogCore`, `EventCore`, `LocalDataCore`, `ResourceCore`, `SafeAreaCore`, `InputCore`, `UICore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `open_layout` | resource key of the layout prefab, resource scope | async operation. success flag | `false` | content code |
| `close_layout` | none | none | none | content code |
| `set_offset` | element name, offset | none | none | content code |
| `set_scale` | element name, scale | none | none | content code |
| `set_opacity` | element name, opacity | none | none | content code |
| `get_offset` | element name | offset | (0, 0) | content code |
| `get_scale` | element name | scale | 1 | content code |
| `get_opacity` | element name | opacity | 1 | content code |
| `reset_user_settings` | none | none | none | content code |
| `get_state` | none | `VirtualPadState`. `Hidden` when there is no virtual pad | `Hidden` | content code |

- `VirtualPadState`: `Active`(draws and holds pointers), `Inactive`(draws but does not hold pointers), `Hidden`(does not draw and does not hold pointers)
- VirtualPadCore does not give pointers and direction values to content code. Content code gets input through `InputCore.is_pressed`, `is_just_pressed`, `is_just_released`, `get_strength`, `get_vector`

## behavior

### layout prefab

- virtual pad: a group of elements made from a layout prefab and drawn in the `VirtualPad` layer of `UICore.get_layer`. There is one virtual pad at a time
- A layout prefab is a prefab that the content agent makes. What it holds:

  | attribute | target | value |
  |---|---|---|
  | joystick mode | layout | `Fixed`, `Floating`, `Following` of enum `JoystickMode` |
  | element list | layout | the list order is the draw order. A later element is drawn on top |
  | element name | element | snake_case. Unique in the layout |
  | element area | element | the rectangle that receives pointers. Placed with anchors, with the safe area as parent. The unit is game coordinates |
  | element image | element | the image that shows the element |
  | action | virtual button | one action of the action list |
  | direction action | virtual joystick | negative x, positive x, negative y, positive y actions |
  | base default position | virtual joystick | a point inside the element area |
  | base radius | virtual joystick | more than 0. game coordinates |
  | base image, handle image | virtual joystick | part of the element image |

- In one layout, the actions of the virtual buttons and the direction actions of the joystick all differ from each other. All layout prefabs of one game use the same joystick mode. Static check `virtual pad layout` blocks a violation
- Static check `action reference` blocks a virtual button action or joystick direction action of a layout prefab that is not in the action list of the game

### virtual joystick

- base: the reference circle of the direction value. The handle is drawn away from the base center in the pointer direction by the smaller of (distance to the pointer, base radius). When there is no pointer, it is drawn at the base center

  | joystick mode | on pointer acquire | on pointer move |
  |---|---|---|
  | `Fixed` | the base is at its default position | the base does not move |
  | `Floating` | moves the base center to the pointer position | the base does not move |
  | `Following` | moves the base center to the pointer position | when the distance between the base center and the pointer is more than the radius, moves the base toward the pointer so that the distance becomes the radius |

- When there is no pointer, the base is at its default position
- distance ratio r: distance from the base center to the pointer ÷ base radius. 1 when it is more than 1
- direction value: a 2D value whose x is positive to the right and whose y is positive downward. D is `VirtualPadCore.deadZonePermille` ÷ 1000, and S is `VirtualPadCore.sensitivityPermille` ÷ 1000
  - (0, 0) when there is no pointer or r is at most D
  - Otherwise its direction is from the base center toward the pointer, and its size is min(1, (r − D) ÷ (1 − D) × S)
- When the direction value (x, y) changes, the strengths of the direction actions are injected. Only actions whose strength changed are injected. A strength more than 0 is a press, and 0 is a release

  | direction action | strength |
  |---|---|
  | negative x | max(0, −x) |
  | positive x | max(0, x) |
  | negative y | max(0, −y) |
  | positive y | max(0, y) |

### virtual button

- When it acquires a pointer, it injects a press of its action with strength 1, and when the acquired pointer is released, it injects a release

### pointer ownership

- One element holds only one pointer, and one pointer belongs to only one element. Several elements can each hold a pointer at the same time
- When `Active`, a pointer pressed inside an element area is held by that element. Where areas overlap, the element drawn on top holds it. A pointer pressed in the area of an element that already holds a pointer is held by no element
- An element holds its pointer until the pointer is released. The same holds when the pointer moves out of the area
- When `Active`, the press, moves and release of a pointer pressed inside an element area are consumed at the UI stage of `InputCore`. The same applies to such a pointer that no element holds. Such a pointer is not a judge pointer
- A pointer pressed outside the element areas and a pointer pressed when not `Active` are not consumed. While not `Active`, pointer moves and releases are not consumed
- release handling: the element drops its pointer. A button injects a release, and a joystick injects the direction value (0, 0) and puts the base at its default position. A dropped pointer is held by no element until it is released
- Every inject made with a pointer that an element holds, including the injects of release handling, passes the pointer ID of that pointer to `InputCore.inject_action` along with it
- Release handling runs for every element that holds a pointer at these times: a change from `Active` to another state, `close_layout`, an input cancel of `InputCore` (checked each frame by whether `get_cancel_count` changed), receiving `SafeAreaChangedEvent`

### open and close

- `open_layout` loads the layout prefab from `ResourceCore` with that resource scope, and when the load ends, creates the virtual pad and applies the user settings. It is `true` when it creates the virtual pad
- When the resource key and resource scope equal those of the current virtual pad, it does nothing and is `true`. When they differ, it runs `close_layout` before the load
- When `open_layout` or `close_layout` is called while an `open_layout` waits for a load, the waiting request is dropped and ends with `false`. No virtual pad is created from the load result of a dropped request
- When the loaded resource is not in the layout prefab format, it leaves an error log and is `false`. Not in the format: a violation of a value condition of the attribute table, an empty element name or a duplicate name, a direct child that is not an element, the fallback resource of `ResourceCore`
- When the resource scope of the current virtual pad is released, `close_layout` runs without a log. When the resource scope of a request waiting for a load is released, that request ends with `false` without a log
- `close_layout` runs release handling and then removes the virtual pad. When there is no virtual pad, it does nothing

### state

- The state is set by the first matching condition from the top

  | condition | state |
  |---|---|
  | the device does not support touch | `Hidden` |
  | the input device of `InputCore` is not `Touch` | `Hidden` |
  | `UICore.get_open_popup_count` is 1 or more | `Inactive` |
  | otherwise | `Active` |

- Touch support is judged once in `init`
- The state is set again when: the virtual pad is created (the input device, the cancel count and the number of open popups are read again at this time), `InputDeviceChangedEvent` is received, whether the number of open popups is 0 changes (`UICore.get_open_popup_count` is checked each frame). When there is no virtual pad, these are not checked

### safe area

- In `init`, VirtualPadCore creates one safe area root of `SafeAreaCore` inside `UICore.get_layer(VirtualPad)`. `open_layout` creates the virtual pad under this safe area root
- Element areas are kept inside the safe area. When an area with user settings applied goes outside the safe area, it is moved back in along the axis where it goes outside. On an axis where the area is longer than the safe area, the area center is aligned to the safe area center
- When `SafeAreaChangedEvent` is received, release handling runs and then all elements are placed again

### user settings

| user setting | meaning | value | default |
|---|---|---|---|
| offset | distance the element area is moved from its placement in the layout. game coordinates | 2D value | (0, 0) |
| scale | factor multiplied into the area, the base default position, the base radius and the images, around the element area center | more than 0 | 1 |
| opacity | value multiplied into the alpha of the element image | 0~1 | 1 |

- User settings are kept per element name. Elements with the same name use the same user settings even in different layouts
- They are kept in the `device` file of `LocalDataCore` under five keys: `VirtualPadCore.element_names`, `VirtualPadCore.offset_x`, `VirtualPadCore.offset_y`, `VirtualPadCore.scale`, `VirtualPadCore.opacity`. The i-th value of the other four is the value for the i-th name of `element_names`
- `open_layout` reads and applies them when it creates the virtual pad. When the five arrays differ in length or `element_names` has the same name two or more times, all five arrays are treated as empty arrays. An element whose name is not there uses the defaults, and a value outside its value range uses the default for that value only
- `set_offset`, `set_scale`, `set_opacity` apply to the virtual pad at once and save. For a name that already exists, they write only the changed keys (`offset_x`, `offset_y` for offset); for a name that does not exist, they add an item at the end of the arrays and write all five keys. The other values of the added item are the defaults
- Content code does not call set operations every frame. Drag editing calls them once when the drag ends
- Get operations return the values before the move into the safe area
- `reset_user_settings` deletes the five keys and, when there is a virtual pad, applies the defaults to all elements

### lifecycle

- `release`: runs `close_layout`, drops an `open_layout` waiting for a load, and then destroys the safe area root in the `VirtualPad` layer. Saved user settings are not changed
- From receiving a pointer to calling `inject_action`, no memory is allocated. Logs are excluded

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| not in the layout prefab format | `false`. There is no virtual pad | error |
| set, get with an element name that is not in the virtual pad | set is ignored, get gives the failure value | error |
| scale of 0 or less | ignored | error |
| opacity outside 0~1 | 0 when less than 0, 1 when more than 1 | error |
| `VirtualPadCore.deadZonePermille` outside 0~999 | uses 0 as D | error |
| `VirtualPadCore.sensitivityPermille` of 0 or less | uses 1 as S | error |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `VirtualPadCore.deadZonePermille` | integer | core | content | upper limit of the distance ratio at which the direction value is (0, 0). permille |
| `VirtualPadCore.sensitivityPermille` | integer | core | content | factor multiplied into the size of the direction value. In permille, and 1 or more |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `VirtualPadCore.element_names` | `array<string>` | element names that have user settings |
| `device` | `VirtualPadCore.offset_x` | `array<float64>` | offset x per element |
| `device` | `VirtualPadCore.offset_y` | `array<float64>` | offset y per element |
| `device` | `VirtualPadCore.scale` | `array<float64>` | scale per element |
| `device` | `VirtualPadCore.opacity` | `array<float64>` | opacity per element |

## DEV

| operation | input | output | caller |
|---|---|---|---|
| `set_test_touch_support` | whether touch is supported | none. Sets the state again | core test, client regression test, `BootstrapCore`(touch emulation of DEV code) |

- `set_test_touch_support` before `init` leaves an error log and does nothing. `release` clears the touch support value that was set

## test

Common conditions: touch supported, input device `Touch`, no open popup, dead zone 0, sensitivity 1000, all user settings at default. Pointers are put in with `InputCore.inject_device_input`

- On a `Fixed` joystick, `get_vector` is (0.5, 0) at 0.5 times the radius to the right of the base center, and (0, −1) at 2 times the radius upward. The error is at most 0.001
- With dead zone 200, r 0.2 gives (0, 0) and no direction action is pressed, and the size at r 0.6 is 0.5
- With sensitivity 2000, the size at r 0.3 is 0.6 and the size at r 0.8 is 1
- Each condition of the error table gives the result and log of the table, and a failed set does not change the get result or the saved value
- At 45 degrees down-right with r 1, the strengths of the four direction actions are the values of the table, and a move that does not change the direction value injects nothing
- On `Fixed`, pressing inside the area and outside the base keeps the base at its default position and gives a value of size 1 in that direction
- On `Floating`, the pressed point is the base center and the value is (0, 0), the base stays the same after a move of 3 times the radius, and the base is at its default position after the release
- On `Following`, a move of 3 times the radius to the right puts the base center 2 times the radius to the right of the pressed point, and the value is (1, 0)
- The handle is 0.5 times the radius away at r 0.5, and 1 times the radius away at r 2
- Pressing a button area makes its action pressed with strength 1, the action stays pressed when the pointer moves out of the area, and it is not pressed after the release
- Under a block made by `InputBlockCore.block` whose pass list has only the joystick element, pressing the joystick area and moving out of the area makes a direction action pressed and changes `get_vector`, and after the release no direction action is pressed. Under the same block, when a popup opens while the joystick is pressed, no direction action is pressed. Under the same block, a press on a button area does not change its action
- When the joystick and a button are pressed together with different pointers, both are pressed, and releasing one leaves the other as it is
- Pressing, moving and releasing another pointer in the area of an element that holds a pointer leaves the action of that element as it is, and UI and gestures do not receive that pointer
- Pressing an overlapping area presses only the action of the later element
- A pointer inside an area is not received by the UI elements below and makes no gesture. A pointer outside the areas is not consumed
- Without touch support, the state is `Hidden` and a press gives no action
- When the input device changes to something other than `Touch` while a pointer is held, the state is `Hidden` and no action is pressed, and it is `Active` when the device returns to `Touch`
- When a popup opens while a pointer is held, the state is `Inactive`, the pad is drawn, the action is not pressed, and the moves and release of that pointer make no gesture. When all popups close, it is `Active`
- After an input cancel, the `Floating` base is at its default position, and after a release and a new press the joystick holds the new pointer
- Opening B during the load of A makes A `false` and B `true`, and the current layout is B
- `open_layout` with the same key and scope is `true` and the pressed action stays as it is. With a different key, it creates a new virtual pad after release handling
- When the scope of the current layout is released, there is no virtual pad and no action is pressed. When the scope is released during a load, the result is `false` and there is no error log from VirtualPadCore
- After a set, the area and alpha change at once, the five keys hold the values of the rules, and get returns the value passed to set. The same holds after closing and opening again
- On a joystick with scale 2, a pointer at the default radius distance gives size 0.5
- The user settings of an element are applied when another layout with an element of the same name opens
- When the five arrays differ in length, all values are defaults, and an item with scale 0 uses the default for that value only
- After `reset_user_settings`, the five keys do not exist and get returns the defaults
- An area placed outside the safe area by offset is inside the safe area. When a virtual notch shrinks the safe area, after the event all areas are inside the new safe area and no action is pressed
- On an axis widened beyond the safe area by scale, the area center is the safe area center, and get returns the offset before the move
- After `init`, the `VirtualPad` layer has one safe area root of VirtualPadCore, and the virtual pad that `open_layout` creates is under it
- After `release`, the virtual pad and that safe area root in the `VirtualPad` layer do not exist, no action is pressed, and the saved values stay as they are
