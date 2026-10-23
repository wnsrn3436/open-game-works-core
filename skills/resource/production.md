# final resource production

How the resource sub-agent makes final resources, and their post-processing. Resource key, resource list, resource request and resource rights are in [SKILL.md](SKILL.md).

- method
- model
- sprite animation
- rig
- skeleton spec
- rig tools
- making
- first final
- finalize

## method

- `ogw generation methods <game> <resource key>` gives the methods that can be used for that resource key and the stage to use per method. Only the methods in that output are used
  - usable method: a method whose `resourceTypes` in harness settings `resourceGeneration` has the type of that resource key and that has, among its stages in harness settings `measured`, a stage whose `result` is `ok`. `rig-2d` and `trellis2` can be used only when `flux2-klein` also meets that condition (the type condition excepted), and then the output also gives the `flux2-klein` stage to use for that method
  - For an `external-service` method that has `pins`, the output also gives `skill` (the `SKILL.md` path of the fetched repository) and `cli` (the executable file path of the fetched CLI)
  - stage to use: given only for methods whose stages in `measured` have `resolution` or `durationMs`. It is the lowest `ok` stage whose `resolution` is at least the larger of the width and height of `size` in `spec` and whose `durationMs` is at least `length` in `spec`. An item that is not in `spec` is not compared. When there is no such stage, it is the highest `ok` stage, with `fallback` attached
- Resource keys made with a stage that has `fallback` are written in the report
- A `local-model` method is called only with `ogw generation run <method> --game <game> --key <resource key> --prompt <file> [--image <file>...] --out <dir>`. The tool runs it with the stage of that method from `ogw generation methods`. `--out` is a folder outside the game repo. The `flux2-klein` of `rig-2d` and `trellis2` is also called this way with that resource key
- `ogw generation run` runs only one `local-model` task at a time on one host. When a previous task exists, it waits until that task ends, then starts
- The content of the `--prompt` file of `ogw generation run`, `--image`, and the files produced in `--out` are as below per method

| method | `--prompt` | `--image` | output in `--out` |
|---|---|---|---|
| `flux2-klein` | English text that describes the picture to draw | None, or one or more. When given, it edits that image (reference editing) | `image.png` (the drawn picture), `image-alpha.png` (`image.png` with its background removed). The size is `size` of `spec` scaled so that the long side is the stage `resolution`, with each side rounded to a multiple of 16 |
| `ace-step` | English text that describes the song. It makes a song without lyrics | Not given | One WAV file. Its length is the smaller of `length` of `spec` and the stage `durationMs` |
| `moss-sfx` | English text that describes the sound | Not given | `sound.wav`. Its length is the smaller of `length` of `spec` and the stage `durationMs` |
| `qwen3-tts` | A JSON object. `text` (the text to read), `speaker` (a qwen3-tts voice name; the same name is the same voice), `language` (the English name of the language to read in. e.g. `English`, `Korean`), and the optional `instruct` (speaking style instruction) | Not given | `voice.wav` |
| `trellis2` | An empty file | Exactly 1. A source illustration with a transparent background | `model.glb` |
- With the method `blender`, the agent makes the resource by writing a Blender script. Only the Blender version of harness settings `tools.blender` is used
- A `catalog` method picks from the files that `ogw generation install` fetched. `ogw generation list <method>` gives, per file, the path, license, source URL, author credit and the character set it holds
- For a font, pick a file that holds the character set of the language of the `language` rows that use that font as `font`

## model

For `model`, use the first method that matches, in the order below.

1. `blender`, when `## art direction` of `design.md` set a style built from primitive shapes. e.g. low-poly, voxel
2. `trellis2`, when the target has the body form of a living thing and `ogw generation methods` gives `trellis2`. e.g. character, monster, animal, plant
3. `blender`

When a target with the body form of a living thing was made by option 3, write it in the report.

The order for `trellis2` follows. All files are kept in a work folder outside the game repo.

1. Make one source illustration with `flux2-klein`. One target, transparent background, 3/4 view, rest pose
2. Make the mesh with `ogw generation run trellis2 --image <image-alpha.png of the source illustration>`
3. When the `rig` or `animation_3d` resource key of the same target is made in the same request, load the mesh in `blender`, voxel remesh it (the voxel size is the longest side of the bounding box ÷ 256), then decimate it to 20000 triangles or fewer, unwrap new UVs and bake the base color of the original mesh. Attach a skeleton to that mesh and give it automatic weights
4. Put it in with `## finalize`

## sprite animation

- The default method of `sprite_animation` is `sprite-gen-codex`. `sprite-gen-grok` is used only when every Grok feature used for that task is generally available (not beta, preview or trial)
- A sprite-gen method is run only through the `cli` that `ogw generation methods` gave, with the commands below in this order. All files are kept in a new work folder outside the game repo
  1. `gen --provider <provider of that method>`: one base image. One target, full body, rest pose
  2. `prepare` with that base image in `--base-image`. The state names of its `--request` file are the `animations` names of `spec`
  3. `gen-set --provider <provider of that method>`
  4. `extract`
  5. `compose-atlas`
- The `skill` that `ogw generation methods` gave, and the documents it links, are read only for the options, inputs and outputs of these commands. Where they differ from the harness, the harness rules apply: no question is asked of the human, no other command is run (`workflow`, `curation`, `defaults` and `rife install` included), no other provider is used, and no Python environment (`.venv`) is made or changed. Where they write `$SPRITE_GEN_ROOT/.venv/bin/sprite-gen`, run `cli`
- Put in `sprite-sheet-alpha.png` and `manifest.json` of the result with `--file` and `--manifest` of `## finalize`

## rig

The order for making `rig_animation_2d` with `rig-2d` follows. All files are kept in a work folder outside the game repo.

1. Make one source illustration with `flux2-klein`. Use the `image-alpha.png` that `flux2-klein` gave without changing its size. The background is transparent, the pose is the rest pose, and it is the pose in which every part is visible and the overlap is the smallest
2. Write the skeleton spec. The `pivot` of `bones` is filled after step 4
3. Per part, make a transparent layer PNG `<layers folder>/<part name>.png` that holds only that part, with `flux2-klein` reference editing (the source illustration in `--image`). The layer has the size of the source illustration, and the areas hidden by other parts are filled in. A filled part gets `filled` set to `true` in the skeleton spec
4. Run `ogw resource rig-split` with `size` of `spec` in `--size`. When `status` of `recompose` is `fail`, split again with step 3 the parts that are off from the source illustration and do step 4 again. When a part image was edited after the split, measure again with `ogw resource rig-check`
5. Fix the `pivots` of the rig split JSON to the joint positions on `rig-canvas.png` next to the rig split JSON and write them in `pivot` of skeleton spec `bones`
6. When there is a part that has weight `bones`, run `ogw resource rig-mesh`
7. Write the rig scene following `rig_animation_2d` in `## resource type` of the engine that `## resource key` of [SKILL.md](SKILL.md) points to. A `Sprite2D` part takes the part file and `offset` of the rig split JSON, and a `Polygon2D` part takes the values of the mesh JSON of that part. In `AnimationPlayer`, write the key frames of `Bone2D` per `animations` of the skeleton spec
8. Put it in with `## finalize`

## skeleton spec

The rig definition JSON object of `rig-2d`. Coordinates are pixel `[x, y]` of the canvas of the rig split JSON, with the origin at the top left.

| field | contents |
|---|---|
| `source` | The absolute path of the source illustration file |
| `parts` | Part list. An earlier item is drawn behind a later one. Per item `name` (snake_case, unique), `bone` (the name of the bone it is attached to), `image` (part image resource key `image/<name>/<part name>`; `<name>` is the `<name>` of that resource key), `filled` (`true` when the hidden areas were filled in), and the optional `bones` (list of the names of the bones that receive weight; it includes `bone`; when present, the part spans a joint) |
| `bones` | Bone list. Per item `name` (snake_case, unique), `parent` (parent bone name; `null` only for the one root bone), `pivot` (joint position) |
| `animations` | Animation list. Per item `name`, `loop` (`true`, `false`), `duration_ms`. The order, names, lengths and repetition are the same as `animations` of `spec` |

- The bone, part and animation names of the engine resource are the same as the names in the skeleton spec

## rig tools

The three commands are deterministic. An opaque pixel is a pixel whose alpha is 128 or more. Boxes are in integer pixel coordinates and do not include their end, and centers are rounded down. When the input violates the format, a command writes nothing, gives the reason and ends with a non-zero code.

### rig-split

`ogw resource rig-split --source <source illustration> --skeleton <skeleton spec> --layers <folder> --size <width>x<height> --out <new folder>`

1. Check: `--source` is skeleton spec `source`. Per part of `parts`, `<folder>/<part name>.png` exists, and no other PNG exists. The layers and the source illustration have the same size. The `bone` and `bones` of `parts` are in `bones`. `bones` has one root, and every bone reaches the root. This command does not read `pivot`
2. The canvas is a transparent image of `--size`. Scale the source illustration and each layer to fit in the canvas keeping the aspect ratio, and place each at the center of the canvas. Write the scaled source illustration to `<out>/rig-canvas.png`
3. Per layer on the canvas, take the box of the pixels whose alpha is greater than 0, widen it by 3 px on each side, and write that area to `<out>/<part name>.png`. Its pixels outside the canvas are transparent. The top left of the widened box is `offset`, and it can be negative. When a layer has no pixel whose alpha is greater than 0, it fails
4. Per bone, decide the initial joint position, starting from the root. B is the union box of the boxes (before widening) of the parts attached to that bone, and P is the union box of the boxes of the parts attached to the parent bone
   - for the root, or when there is no P: the center of B
   - when B and P overlap: the center of the overlap box
   - when they do not overlap: the point in B closest to the center of P
   - a bone with no attached part takes the value of its parent, and such a root takes the center of the canvas
5. Measure the recompose of `### rig-check`
6. Write the rig split JSON to `<out>/rig-split.json` and output it: `source` (absolute path of the source illustration), `canvas` (`[width, height]` of `--size`), `parts` (`name`, `file` (absolute path), `offset`, `size` in `parts` order), `pivots` (bone name to `[x, y]`), `recompose`

### rig-check

`ogw resource rig-check <rig split JSON>` reads the part files and `source` of the rig split JSON again, measures recompose and outputs it. When `status` is `fail`, it ends with a non-zero code.

- It scales `source` onto a transparent image of `canvas` as `rig-split` does, and draws the parts onto another transparent image of `canvas` in `parts` order at `offset` (rest pose). Part pixels outside the canvas are dropped
- `alphaIou`: the size of the intersection ÷ the size of the union of the opaque pixel sets of the composite and the scaled source illustration
- `colorDiff`: for each pixel that is opaque in both, the mean of the absolute differences of the R, G, B channels, averaged over all those pixels. From 0 to 255; `null` when no pixel is opaque in both
- `status`: `pass` when `alphaIou` is at least harness settings `rigCheck.iouMin` and `colorDiff` is not `null` and is at most `rigCheck.colorDiffMax`, otherwise `fail`
- The output `recompose` is `alphaIou`, `colorDiff`, `status`, `iouMin`, `colorDiffMax`

### rig-mesh

`ogw resource rig-mesh --skeleton <skeleton spec> --split <rig split JSON> --out <new folder>` makes a mesh and weights for each part that has weight `bones`. Every bone must have a `pivot`.

1. The shape is the opaque pixels of the part image widened by 2 px, cut to the part image, so every point is inside the part image. On its contour, pick contour points at an interval fixed in the tool, and from a grid with the same interval that starts at the top left of the box of the pixels whose alpha is greater than 0, pick the inner points of the shape that are not closer than that interval to any contour point
2. Delaunay-triangulate the points, and discard the triangles whose center is outside the shape
3. The segments of a bone run from the `pivot` of that bone to the `pivot` of each child bone, and a bone without children is the single point `pivot`. The distance d between a point and a bone is the shortest distance to those segments. Per point, calculate 1 ÷ (d + 1)² for each of the `bones` of the part, keep only the 3 largest, and divide them so that their sum is 1
4. Write `<out>/<part name>.mesh.json`: `polygon` (canvas coordinates of the points), `uv` (part image coordinates of the points), `polygons` (three point numbers per triangle), `weights` (bone name to the list of weights in point order)

## making

- A variant of the same target is made from the resource in `## base` of the request file. When `## base` is `none`, the base is the resource that `ogw resource first-final <game> --name <name>` gave. `<name>` is the `<name>` of that resource key. A variant is not made from the immediately previous variant
- Post-processing that needs judgement is done by the agent before `ogw resource finalize`: background removal, palette matching, tile seam matching, compositing
- UI images hold no text. Text is kept as UI elements
- The sound of a text voice reads, in the source language, the `source` of the row of the translation key `text_key` of that row in the translation file of the source language (`data/translations/<language>.csv`). When `ogw resource first-final <game> --speaker <speaker>` gives a resource, make it with the same voice as that resource. `<speaker>` is the `speaker` of that row
- A haptic is a JSON file (`.json`) in the haptic pattern format of `SoundCore` ([`client-core`](../client-core/SKILL.md))
- For a 3D model, check UV overlap, weight normalization, applied transforms and origin position
- Generation originals are kept outside the game repo. The game repo holds only the files that the engine uses

## first final

`ogw resource first-final <game> (--name <name> | --speaker <speaker>)` picks, in `resources.csv`, among the rows whose resource key `<name>` is the same (for `--name`) or whose `speaker` is the same (for `--speaker`), the rows whose `status` is now `final`. For each picked row, it finds the last commit, among the commits reachable from HEAD, in which the `status` of that row changed from not `final` to `final`, and gives the resource key and file path of the row whose commit comes first. The order is the order of `git rev-list --topo-order --reverse HEAD`, and for the same commit the byte order of the resource key. When no row is picked, it gives `none`.

## finalize

Put a made file in with `ogw resource finalize <game> <key> --method <method> --file <path> [--inputs <key>...] [--bus <Sfx|Ui>] [--manifest <file>] [--skeleton <file> --split <file>]`. For a `catalog` method, every `--file` is a path that `ogw generation list <method>` gave. `--inputs` is the resource keys of the composited originals and of the existing final resources used as generation input. `--bus` is given only for type `sfx`, and must be given for it. For a row whose `spec` has `variants` of 2 or more, `--file` is given as many times as the number of variants, in `<n>` order. For `sprite_animation`, give the sheet PNG in `--file` and the `manifest.json` of sprite-gen in `--manifest`. For `rig_animation_2d`, give the rig scene in `--file`, the skeleton spec in `--skeleton` and the rig split JSON in `--split`. `--manifest`, `--skeleton`, `--split` are given only for those types, and must be given for them.

1. Check. When any check fails, it changes nothing and fails: the `status` of the `<key>` row is `requested`. `<method>` is in the output of `ogw generation methods <game> <key>`. The extension of `--file` is the extension of that type in `## resource type` of the engine (`.png` is also accepted for `sprite_animation`, and `.wav` for `sfx`, `bgm`, `voice`). The rows of `--inputs` are all `final`. `--bus`, `--manifest`, `--skeleton`, `--split` follow the rules above. When there is a row whose key is the resource key of an attached row, its `description` is the value that the tool writes in step 4
   - `sprite_animation`: the set of `frame_layout` state names of `--manifest` is the same as the set of `animations` names of `spec`, and each state has one or more frames
   - `rig_animation_2d`: the skeleton spec is in the `## skeleton spec` format, and every bone has a `pivot`. The `image` of each part is `image/<name>/<part name>`. The parts of `--split` are the same as skeleton spec `parts`, `canvas` of `--split` is `size` of `spec`, `source` of `--split` is skeleton spec `source`, and `ogw resource rig-check` is `pass`. The set of `Bone2D` names, the set of part node names and the set of `AnimationPlayer` animation names of the rig scene are the same as the name sets of `bones`, `parts` and `animations` of the skeleton spec. In the rig scene, the `position` of the root `Bone2D` plus the `position` of its parent `Skeleton2D`, a child of the root node, is `[x − width ÷ 2, y − height ÷ 2]` for the root `pivot` `[x, y]` and `canvas` `[width, height]`
2. Apply deterministic post-processing to a copy of `--file`
   - `image`, `icon`, `background`, `texture`, `app_icon`, `splash`: when `alpha` of `spec` is `true`, crop the border rows and columns whose alpha is 0, then scale it to fit in `size` keeping the aspect ratio and place it at the center of a transparent canvas of `size`. When it is `false`, scale it to cover `size` keeping the aspect ratio and crop the center to `size`
   - `sfx`, `bgm`, `voice`: when the type is not `bgm` and `loop` of `spec` is not `true`, cut the spans at the start and end where the absolute sample value of every channel is less than -60 dBFS. Then match the integrated loudness (ITU-R BS.1770-4) to the `SoundCore.busLoudnessLufs` value of the bus, and limit the true peak to at most the `SoundCore.busPeakMaxDbtp` value of the bus. For a sound shorter than 400 ms (one gating block) that has no integrated loudness, measure the integrated loudness and true peak of that sound repeated for 1000 ms, and multiply the whole sound by one gain: the smaller of the gain that matches the loudness to the bus value and the gain that makes the true peak the bus value. A sound with no true peak (no samples left) fails. The bus is `Bgm` for `bgm`, `Voice` for `voice`, and `--bus` for `sfx`. The values are those of game settings `core` laid over core settings. The result is written in the format of the extension of that type for the engine. The integrated loudness and true peak of the result are given. A result shorter than 400 ms is measured repeated for 1000 ms
   - `sprite_animation`: scale all the frame regions of `frame_layout` by one factor at which the largest frame fits in `size`, and place each at the center of a transparent cell of `size`. Make a sheet PNG with one row per animation in the `animations` order of `spec`, and the frames in `frame_layout` order. Make a `SpriteFrames` that points to that sheet. The frame rate of an animation is the number of frames × 1000 ÷ the length in `spec` (fps), and its repetition is `loop` or `once` of `spec`
   - any other type: not changed
3. Write the result of step 2 to `resource/<key>.<extension>`. Also write the files of the attached rows: for `sprite_animation`, the sheet PNG to `resource/sprite_sheet/<name>.png`; for `rig_animation_2d`, the part files of `--split` to `resource/image/<name>/<part name>.png`. Delete the attached rows and files of the parts that are not in this skeleton spec
4. Change the `status` of the row to `final` and `method` to `<method>`, and write the following
   - base values of `source`, `license`, `attribution`: for a `catalog` method, the source URL, license and author credit that `ogw generation list` gave for each `--file`. For any other method, `source` is an empty cell, and `license` and `attribution` are the `license` and `attribution` of that method in harness settings `resourceGeneration` (an empty value when missing)
   - `source` is the non-empty, distinct base values joined with ` ` in byte order
   - When there are two or more base values or there is `--inputs`, `license` is the expression of the distinct values of the base values and the `license` of the `--inputs` rows joined with ` AND ` in byte order. A value that holds ` OR ` is wrapped in parentheses. When `unknown` is among them, it is `unknown`. `attribution` is the non-empty, distinct values of the base values and the `attribution` of the `--inputs` rows joined with `; ` in byte order. Otherwise `license` and `attribution` are the base values
   - For a text voice row, write in `text_hash` the `current_hash` of the `text_key` row of the source language translation file
   - Write the attached rows. `status`, `method`, `source`, `license`, `attribution` are the same as this row, and `spec` is `size=<width>x<height>;alpha=true` of that file. `description` is `<key> sheet` for the sheet row and `<key> part <part name>` for a part image row
5. Run `ogw resource sync <game>`. Do not commit
