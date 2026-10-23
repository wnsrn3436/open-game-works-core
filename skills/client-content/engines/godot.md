# Godot client content

- project
- engine settings
- scene and prefab
- GDScript
- deterministic simulation
- feature folder
- boot and DEV code
- regression test
- dev run

Content code follows `## API`, `## hook`, `## event`, `## engine behavior`, `## GDScript`, `## resource loading`, `## resource type`, `## engine meta file` and the failure judgement of `## test` in `engines/godot.md` of the `client-core` skill. This document adds content code rules on top of them.

When content code breaks the Godot GDScript rules (`client-core` and this document), static check `forbidden GDScript API` blocks it; a forbidden call in frame code is blocked by `frame code`, and a literal passed for presentation durations and animation values by `literal timing`.

## project

`client/` is the Godot project. `res://` is `client/`. The actual path of a logical folder of [`client-content`](../SKILL.md) `## folder` is the same as the logical folder. e.g. logical folder `client/generated/` is `res://generated/`.

```
client/
  project.godot         the harness tool writes it
  resource -> ../resource   relative symbolic link that the harness tool makes. Committed
  core/                 client core
  generated/            generated code, core_settings.json
  boot/                 boot.tscn, boot.gd, content_boot.gd, project_settings.cfg
  features/<feature>/
  common/
  tests/
  dev/
  addons/, android/, ios/plugins/, build/, .godot/   not committed
```

- `resource/` of the game root is visible in the project through the `client/resource` link. The path of a resource is `res://resource/<resource key>.<extension>`. The link is not deleted or replaced with a copy
- The harness tool writes `client/.gitignore`, which ignores `addons/`, `android/`, `ios/plugins/` and `.godot/`. `.gitignore` of the game repo root ignores `build/`
- `.import` and `.uid` in `resource/` are not resource files. They are not written in `resources.csv`

## engine settings

- Only the harness tool writes `project.godot` and `export_presets.cfg`. Agents do not change these files through the Project Settings and Export windows of the Godot editor
- When content needs to change an engine setting, it writes it in `client/boot/project_settings.cfg`. The syntax is the same as `project.godot`, and `ogw generate` merges it into `project.godot`. Only keys that start with the prefixes below can be written. When there is any other key, the tool blocks it with an error
  - `layer_names/`
  - `input/`
  - `physics/common/`, `physics/2d/`, `physics/3d/`
  - `rendering/textures/canvas_textures/`
  - `rendering/2d/`
  - `rendering/anti_aliasing/`
  - `rendering/lights_and_shadows/`
  - `rendering/environment/defaults/`
- Action names under `input/` are snake_case. Events use only `InputEventKey`, `InputEventMouseButton`, `InputEventJoypadButton` and `InputEventJoypadMotion`. Core actions (`back`, `cutscene_advance`, `cutscene_skip`) and engine default actions starting with `ui_` are not put there. When they are, the tool blocks them with an error. An action name starting with `menu_` or `cutscene_` sets the binding context of `InputCore`. When two actions that are overlapping actions of `InputCore` have the same key, mouse button, gamepad button or gamepad axis direction, the tool blocks it with an error. A `Gameplay` action can have the same key or gamepad button as `back`
- The renderer that the harness tool writes

  | platform | `rendering_method` |
  |---|---|
  | windows, macos, linux | `forward_plus` |
  | android, ios | `mobile` |
  | web | `gl_compatibility` |

  - `rendering/rendering_device/fallback_to_opengl3` is `true`
- In `project.godot`, the harness tool writes the source text of reserved string `[app_name]` to `application/config/name`, its translation per supported language to `application/config/name_localized` (the source text for a missing translation; the key is the language `code` with `-` replaced by `_`), the file of resource `app_icon/main` to `application/config/icon`, and the file of resource `splash/main` to `application/boot_splash/image`
- The harness tool writes `display/window/handheld/orientation` of `project.godot` as `4` (sensor landscape) when the width of game settings `baseResolution` is greater than its height, otherwise as `5` (sensor portrait), and writes the width and height of `baseResolution` to `display/window/size/viewport_width` and `display/window/size/viewport_height`
- The harness tool writes `rendering/textures/vram_compression/import_s3tc_bptc` and `rendering/textures/vram_compression/import_etc2_astc` as `true`, and `editor/export/convert_text_resources_to_binary` as `false`. This is so that one set of bundle files holds the texture formats of all platforms, and `.tscn` and `.tres` of a bundle override the files with the same path in the app

## scene and prefab

- A scene is `resource/scene/<feature>/<name>.tscn`, and a prefab is `resource/prefab/<feature>/<name>.tscn`. Their resource keys are `scene/<feature>/<name>` and `prefab/<feature>/<name>`. A prefab that several features use is `prefab/common/<name>`. `common` is not used as a feature name
- Scenes and prefabs are text `.tscn`. `.scn` and `.res` are not used. A shared resource is `.tres`
- The root script of a scene resource inherits `SceneBase`
- `_ready()` and `@onready var` of a scene run in step 4 of `SceneCore`, so they can be used from `on_preload` on. `_process()`, `_physics_process()` and input callbacks are called from step 7 on
- Before step 7, `visible` of the top visual node of the `client-core` Godot rules is not changed. A node to hide at first has `visible` set to `false` in the `.tscn`
- `ext_resource` of a `.tscn` points only to files under `res://resource/`, `res://features/<own feature>/`, `res://common/` and `res://core/`. A `.tscn` of `prefab/common/` does not point to `res://features/`
- A script is not put inside a `.tscn` or `.tres` (`type="GDScript"`). A script goes in a `.gd` file. An automated check blocks it
- The script of a node with a script attached goes in the feature folder of that scene or prefab or in `client/common/`
- `sprite_animation` goes in `sprite_frames` of an `AnimatedSprite2D` of a scene or prefab and is played with that `AnimatedSprite2D`. `rig_animation_2d` goes in a scene or prefab as an instance and is played with the `AnimationPlayer` child of its root. Nodes inside the rig are not edited
- Presentation durations and animation values go in `AnimationPlayer` of the `.tscn` and in tween presets. Code does not pass literal values to `AnimationPlayer.speed_scale`, `custom_speed` and `custom_blend` of `play()`, `SceneTree.create_timer()` or `Timer.wait_time`

## GDScript

- A `class_name` in a feature folder starts with the PascalCase of the feature name. e.g. `DailyQuestRewardPopup` of `features/daily_quest/`. A `class_name` in `client/common/` starts with `Common`
- The `class_name` of another feature and the string `res://features/<other feature>/` are not used
- A node reference is obtained once with `@onready var` or `@export var` and kept in a field
- Frame code (`_process()`, `_physics_process()`, input callbacks, and every method of the same class that these functions call, following the calls) does not do node lookup (`get_node()`, `$`, `%`, `find_child()`), `PackedScene.instantiate()`, `queue_free()` or `await`. A display `String` is made only in the frame in which its value changed. Objects made in frame code are obtained with `PoolCore`
- Notification within one feature can use signals. Notification between features is content events of `EventCore`
- `OS.is_debug_build()`, `OS.has_feature()` and `Engine.is_editor_hint()` are not used. Platform and environment are read with core operations
- `@tool` scripts are not used
- `static var` is not used. State is a field of a node or of a `RefCounted` object
- The shared formula mark is `# ogw:shared <name>`

## deterministic simulation

The Godot counterpart of the `## deterministic simulation` rules of `client-content`. The targets are the `.gd` files of `client/features/<feature>/sim/` and `client/common/sim/`. Static check `determinism` blocks violations.

- A class is `extends RefCounted`
- Floating-point types and values are not used: the notation of `float`, `Vector2`, `Vector3`, `Vector4`, `Rect2`, `Transform2D`, `Transform3D`, `Basis`, `Quaternion`, `Plane`, `AABB`, `Color`, `PackedFloat32Array`, `PackedFloat64Array`, `PackedVector2Array`, `PackedVector3Array`, `PackedVector4Array`, `PackedColorArray`, and floating-point literals
- `/`, `%`, `/=` and `%=` are not used. `UtilCore.floor_div` and `UtilCore.floor_mod` are used
- Only the below are called
  - Classes of `sim/` of the same feature and of `client/common/sim/`
  - Contract code and data code of `client/generated/`
  - The `UtilCore` operations `floor_div`, `floor_mod`, `clamp_int`, `apply_permille`, `create_random`, `make_purpose_seed`, `next_uint32`, `range_int`, `shuffle_indices`, `pick_weighted`
  - Operations of `DataCore`
  - `absi`, `clampi`, `maxi`, `mini`, `signi`, `range`, `len` of `@GlobalScope`
  - Methods of `int`, `bool`, `String`, `StringName`, `Array`, `Dictionary`, `PackedByteArray`, `PackedInt32Array`, `PackedInt64Array` that do not return a floating-point value. e.g. `String.to_float()` is not called

## feature folder

```
client/features/<feature>/
  <feature>_<screen>.gd     root script of a scene or panel
  <feature>_<part>.gd       other scripts
  events/<event type name in snake_case>.gd
```

- A file name is the snake_case of its `class_name`. The constants file is the exception
- The client's constants files are `client/features/<feature>/constants.gd` and `client/common/constants.gd`
- The automation channel commands and cheats of a feature go in `client/dev/features/<feature>/`
- The regression tests of a feature go in `client/tests/<feature>/`

## boot and DEV code

- The main scene is `res://boot/boot.tscn`. `ogw generate` makes `boot.tscn` and `boot.gd` and writes it to `application/run/main_scene` of `project.godot`. `boot.gd` calls only `BootstrapCore.start_boot.call_deferred(ContentBoot.new())` in `_ready()`. This keeps core modules from attaching core nodes to the root while the root is attaching the main scene
- `client/boot/content_boot.gd` is the content entry. It is `class_name ContentBoot`, `extends ContentEntry`, and overrides `content_init()`, `content_release()` and `select_first_scene()`. Hooks are registered inside `content_init()`. A registered hook function is a static func of `ContentBoot` or of a feature class. An owner hook is also registered by a node of a scene or prefab with its own instance method in `_ready()`
- The DEV registration function of a feature is `static func register() -> void` of `class_name <Feature PascalCase>Dev` in `client/dev/features/<feature>/<feature>_dev.gd`. Automation channel commands, cheats, debug screens and content state are registered here
- `ogw generate` generates in `client/dev/generated/dev_registration.gd` the DEV registration list that calls `register()` of every feature in feature name order. `BootstrapCore` calls it only in a DEV build
- The DEV code reference check counts as references, in files outside DEV code (`client/dev/`, `client/core/*/dev/`) and regression tests (`client/tests/`), a `class_name` inside `client/dev/` and `client/core/*/dev/` (including `client/dev/generated/`) and the strings `res://dev/` and `res://core/*/dev/`. On the server, it counts as a reference a file outside `server/dev/`, `server/core/*/dev/` of core and server regression tests (`server/tests/`) importing a file inside those two folders
- Inline DEV sections such as `# ogw:debug_begin` are not used. DEV behavior goes only in files of `client/dev/`
- The Godot counterpart of debug text: a non-empty string literal in a value that a `.gd` outside `client/dev/` and `client/tests/` assigns to `text` (`=`, `+=`) or passes to `set_text()`, `add_text()` or `append_text()` (including literals joined with `+`, `%`, a ternary expression or `as`), and a non-empty value of the `text` property of a `.tscn` node in `resource/scene/` and `resource/prefab/`

## regression test

- A regression test is `client/tests/<feature>/test_<topic>.gd` and `extends UnitTestCase`. Test support classes go in `client/tests/<feature>/support/`
- `ogw check <game> --regression [<path>]` runs them headless. `<path>` is a test file or folder relative to the game repo; when omitted, it is all of `client/tests/` and `server/tests/`
- The tool passes the absolute path of the shared fixture folder of `UnitTestCore` as `ogw_shared_fixture_dir` of the test run config (`client-core` skill `engines/godot.md` `## test`)
- GUT is not called directly, and no `.gutconfig.json` is kept
- The Godot counterpart of the test input rule of `UnitTestCore`: a test does not call input callbacks (`_input()`, `_unhandled_input()`, `_unhandled_key_input()`, `_shortcut_input()`, `_gui_input()`) or `_pressed()` and `_toggled()` of `BaseButton`, and does not emit signals `pressed`, `button_down`, `button_up`, `toggled` or `gui_input` with `emit()` or `emit_signal()`. Static check `test input` blocks violations
- The Godot counterpart of the polling ban of `UnitTestCore`: a test does not use a `for` or `while` loop whose body waits for a frame (waits with `await` for `wait_frames()`, `process_frame` or `physics_frame`). Static check `frame polling` blocks violations

## dev run

- A dev run is `godot --path client`. The runner starts the clients of an instance with `ogw instance start`. Agents do not start Godot directly
- Before it starts a client for the first time in each checkout, the runner runs `godot --headless --path client --import` once. It is the first time when the checkout has no `client/.godot/`. When the import fails, the runner deletes `client/.godot/` and the instance start fails
- The bot clients of an instance and the bot playtest are started with `--headless`. The clients of the performance check, the per-resolution capture and the play agent draw the screen
- The runner starts a client with the `rendering_method` of the instance platform (`ogw instance start --platform`) in the renderer table. The value is passed on the Godot command line as `--rendering-method`
- Content code does not read launch values
