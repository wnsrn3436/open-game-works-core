# final resource production

How the resource sub-agent makes final resources, and their post-processing. Resource key, resource list, resource request and resource rights are in [SKILL.md](SKILL.md).

- method
- model
- sprite animation
- sprite sheet
- rig
- skeleton spec
- rig tools
- making
- logo
- first final
- finalize

## method

- `ogw generation methods <game> <resource key>` gives the methods that can be used for that resource key and, for a method measured by stages, the stage to use. Only the methods in that output are used
  - For `rig-2d`, `trellis2` and `z-image-turbo`, the output also gives the `flux2-klein` stage to use for that method
  - For an `external-service` method that has `pins`, the output also gives `skill` (the `SKILL.md` path of the fetched repository) and `cli` (the executable file path of the fetched CLI)
  - A method that lacks the install that `ogw generation install` gives it on this host (for `rig-2d`, `trellis2` and `z-image-turbo`, or the `flux2-klein` they call) has the line `not installed`
  - A stage with `fallback` attached is the highest `ok` stage, and no `ok` stage reaches `size` or `length` of `spec`
- image method of a game: for a key of the image types (`image`, `sprite_sheet`, `icon`, `background`, `nine_slice`, `texture`, `skybox`, `app_icon`, `splash`), the `method` of the first row of those types in `resources.csv` whose `status` is `final` and whose method is a method of those types, leaving out a `sprite_sheet/<name>` row when `sprite_animation/<name>` is in `resources.csv` (the sheet that `ogw resource finalize` writes for that sprite animation); when there is none, harness settings `imageMethod`. A row made with `logotype` does not count. For a key of the image types, `ogw generation methods` gives only that method, except a logo key `image/logo/<language>`, which takes that method and `logotype` (`## logo`) and no temporary method
- temporary method: `flux2-klein`, when `ogw generation methods` gives it with `temporary`
  - It is used only when the call of the other method failed because the usage limit of that subscription was reached (its error says so), when every other method that `ogw generation methods` gives has the line `not installed`, or when it gives no other method. The resource key and the error or the `not installed` method go in the report. It does not replace a `final` row asked again: that key stays `final` and goes in the report
  - When there is no temporary method either, the key is written in the result file as not made, with the error. `--pending` requests it again
  - A resource made with the temporary method becomes `temporary` in `## finalize`. `--pending` of the next run requests it again
- A sprite-gen method for an image type is run only through `cli` as `gen --provider <provider of that method> --prompt-file <file> --out <work folder>/image.png`, with `--transparent` when `alpha` of `spec` is `true` and `--ref <file>` per image to edit from (at most 5). Put in `image.png` with `--file`
- A `local-model` method is called only with `ogw generation run <method> --game <game> --key <resource key> --prompt <file> [--image <file>...] --out <dir>`. The tool runs it with the stage of that method from `ogw generation methods`. `--out` is a folder outside the game repo. The `flux2-klein` of `rig-2d` and `trellis2` is also called this way with that resource key
- `z-image-turbo` draws from text alone. In a game whose image method is `z-image-turbo`, a call that gives reference images in `--image` (e.g. `image/ui_kit` for a `nine_slice` or `icon` key, the lettering of a logo key, the `## base` resource of a variant) is a `flux2-klein` call made this way with that resource key, and its result is put in with `--method z-image-turbo`
- When several keys of one request use the same `local-model` method, make them in one call with `ogw generation run <method> --game <game> --batch <file>`, a JSON array of `{"key", "prompt", "images", "out"}` (`images` optional), one item per key with its own `--out` folder. `moss-sfx`, `ace-step` and `qwen3-tts` then load the model once for all of them. The output shows per key `ok`, or `failed` with the reason, or `timeout`
- `ogw generation run` runs only one `local-model` task at a time on one host. When a previous task exists, it waits until that task ends, then starts. It also waits while the performance measurement of an `ogw check` on this host runs or waits to run
- The content of the `--prompt` file of `ogw generation run`, `--image`, and the files produced in `--out` are as below per method

| method | `--prompt` | `--image` | output in `--out` |
|---|---|---|---|
| `flux2-klein` | English text that describes the picture to draw | None, or one or more. When given, it edits that image (reference editing) | `image.png` (the drawn picture), `image-alpha.png` (`image.png` with its background removed). The size is `size` of `spec` scaled so that the long side is the stage `resolution`, with each side rounded to a multiple of 16 |
| `z-image-turbo` | English text that describes the picture to draw | Not given | `image.png` and `image-alpha.png`, as for `flux2-klein` |
| `ace-step` | English text that describes the song. It makes a song without lyrics | Not given | `music.wav`, and `music.json` that holds the tempo the song was made with (`bpm`, `beatsPerBar`). The song is the smaller of `length` of `spec` and the stage `durationMs` long, and 8000 ms longer for a key whose `loop` is `true` |
| `moss-sfx` | English text that describes the sound | Not given | `sound.wav`. It holds the sound and the 1000 ms after it, so that its end is not cut. The sound is the smaller of `length` of `spec` and the stage `durationMs` long. An item that came back near silent fails, and is made again with another seed |
| `qwen3-tts` | A JSON object. `text` (the text to read), `speaker` (a qwen3-tts voice name; the same name is the same voice), `language` (the English name of the language to read in. e.g. `English`, `Korean`), and the optional `instruct` (speaking style instruction) | Not given | `voice.wav` |
| `trellis2` | An empty file | Exactly 1. A source illustration with a transparent background | `model.glb` |
- With the method `blender`, the agent makes the resource by writing a Blender script. Only the Blender version of harness settings `tools.blender` is used
- A `catalog` method picks from the files that `ogw generation install` fetched. `ogw generation list <method>` gives, per file, the path, license, source URL, author credit and the character set it holds
- For a font, pick a file that holds the character set of the language of the `language` rows that use that font as `font`. The same face draws body text, system popups and captions (`LocalizationCore` applies one font chain to the body and heading text styles), so pick a text face that stays readable at the smallest body size, and among those the one whose character fits `## art direction` (e.g. a serif for a dark fantasy world, a rounded sans for a toy world) over a neutral UI sans. Prefer one with a `wght` axis, because titles and body text are told apart by weight

## model

For `model`, use the first method that matches, in the order below.

1. `blender`, when the target has no body form of a living thing and `## art direction` of `design.md` set a style built from primitive shapes. e.g. low-poly, voxel
2. `trellis2`, when the target has the body form of a living thing, `ogw generation methods` gives `trellis2`, and `## character models` of `records/setup/art-direction.md` is not `primitive`. e.g. character, monster, animal, plant
3. `blender`

When a target with the body form of a living thing was made by option 3, write it in the report.

The order for `trellis2` follows.

1. Make one source illustration with `flux2-klein`. One target, transparent background, 3/4 view, rest pose
2. Make the mesh with `ogw generation run trellis2 --image <image-alpha.png of the source illustration>`. The mesh has about 20000 faces
3. When the `rig` or `animation_3d` resource key of the same target is made in the same request, load the mesh in `blender`, voxel remesh it (the voxel size is the longest side of the bounding box ÷ 256), then decimate it to 20000 triangles or fewer, unwrap new UVs and bake the base color of the original mesh. Attach a skeleton to that mesh and give it automatic weights
4. Put it in with `## finalize`

## sprite animation

- The default method of `sprite_animation` is `sprite-gen-codex`. `sprite-gen-grok` is used only when `ogw generation methods` does not give `sprite-gen-codex` or gives it with the line `not installed`
- A sprite-gen method is run only through the `cli` that `ogw generation methods` gave, with the commands below in this order
  1. `gen --provider <provider of that method>`: one base image. One target, full body, rest pose
  2. `prepare` with that base image in `--base-image`. The state names of its `--request` file are the `animations` names of `spec`
  3. `gen-set --provider <provider of that method>`
  4. `extract`
  5. `compose-atlas`
- The `skill` that `ogw generation methods` gave, and the documents it links, are read only for the options, inputs and outputs of these commands. Where they differ from the harness, the harness rules apply: no question is asked of the human, no other command is run (`workflow`, `curation`, `defaults` and `rife install` included), no other provider is used, and no Python environment (`.venv`) is made or changed. Where they write `$SPRITE_GEN_ROOT/.venv/bin/sprite-gen`, run `cli`
- Put in `sprite-sheet-alpha.png` and `manifest.json` of the result with `--file` and `--manifest` of `## finalize`
- With the temporary method `flux2-klein`:
  1. One base image without `--image`: one target, full body, rest pose. Use its `image-alpha.png`
  2. Per animation of `spec`, its length in ms ÷ 125 frames (rounded, at least 2 and at most 8), each made with that base image in `--image` and a prompt that names the pose at that point of the motion. Use their `image-alpha.png`
  3. `ogw resource sprite-sheet --frames <animation>=<frame>,<frame>... --out <folder>` with one `--frames` per animation in `spec` order makes `sheet.png` and `manifest.json`. Put them in with `--file` and `--manifest` of `## finalize`

## sprite sheet

`ogw resource sprite-sheet --frames <animation>=<file>,<file>... --out <folder>` packs PNG frames into `<folder>/sheet.png` and `<folder>/manifest.json`. One row per `--frames` in the order given, frames in the order given. Every cell has the width of the widest frame and the height of the tallest frame, and a frame sits at the center of its cell. `manifest.json` is `{"frame_layout": {"rows": {"<animation>": [{"x", "y", "w", "h"}, ...]}}}` with the cell of each frame, which `--manifest` of `## finalize` reads. When a file does not exist or is not a PNG, or an animation is given twice, it writes nothing and fails.

## rig

The order for making `rig_animation_2d` with `rig-2d` follows.

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

When the input violates the format, a command writes nothing, gives the reason and ends with a non-zero code.

### rig-split

`ogw resource rig-split --source <source illustration> --skeleton <skeleton spec> --layers <folder> --size <width>x<height> --out <new folder>`

- Input: `--source` is skeleton spec `source`. Per part of `parts`, `<folder>/<part name>.png` exists, has a pixel whose alpha is greater than 0, and no other PNG exists. The layers and the source illustration have the same size. The `bone` and `bones` of `parts` are in `bones`. `bones` has one root, and every bone reaches the root. This command does not read `pivot`
- Output: `<out>/rig-canvas.png` (the source illustration scaled to the canvas of `--size`), `<out>/<part name>.png` per part, and the rig split JSON `<out>/rig-split.json`, which it also prints: `source` (absolute path of the source illustration), `canvas` (`[width, height]` of `--size`), `parts` (`name`, `file` (absolute path), `offset` (the top left of the part image on the canvas; it can be negative), `size`, in `parts` order), `pivots` (bone name to the initial joint position `[x, y]`), `recompose`

### rig-check

`ogw resource rig-check <rig split JSON>` reads the part files and `source` of the rig split JSON again, measures recompose and outputs it. When `status` is `fail`, it ends with a non-zero code.

- Output `recompose`: `alphaIou`, `colorDiff`, `status`, `iouMin`, `colorDiffMax`
- `status`: `pass` when `alphaIou` is at least harness settings `rigCheck.iouMin` and `colorDiff` is not `null` and is at most `rigCheck.colorDiffMax`, otherwise `fail`

### rig-mesh

`ogw resource rig-mesh --skeleton <skeleton spec> --split <rig split JSON> --out <new folder>` makes a mesh and weights for each part that has weight `bones`. Every bone must have a `pivot`.

- Output: `<out>/<part name>.mesh.json`: `polygon` (canvas coordinates of the points), `uv` (part image coordinates of the points), `polygons` (three point numbers per triangle), `weights` (bone name to the list of weights in point order)

## making

- A variant of the same target is made from the resource in `## base` of the request file. When `## base` is `none`, the base is the resource that `ogw resource first-final <game> --name <name>` gave. `<name>` is the `<name>` of that resource key. A variant is not made from the immediately previous variant
- An image prompt is, in this order: the style block of `## art direction`, the subject and the size it is seen at in the game, and `No text, no letters, no labels, no mockup frame, no duplicate objects, no cropped edges, no signature, no watermark.`
- `image/ui_kit` is the UI kit sheet of the game: the UI parts that the UI style of `## art direction` names (e.g. the focus mark of a menu line, a divider, a slider, and a frame, plate or button only where the presentation game's screens have one), side by side, drawn in the hand of the game's world (`## UI screens` of [commercial quality](../game-design/commercial-quality.md)). Every `nine_slice` and `icon` key is made from it: in `--image` of `flux2-klein` or `--ref` of a sprite-gen method, and in `--inputs` of `## finalize`. `ogw resource finalize` of a `nine_slice` or `icon` key fails when `image/ui_kit` is `final` and is not in `--inputs`. When a request holds `image/ui_kit` with `nine_slice` or `icon` keys, the kit is made and finalized first, and those keys are made from the new kit. When a request holds `nine_slice` or `icon` keys without the kit while `image/ui_kit` is `requested`, those keys are left as they are and go in the report as `placeholder` with that reason, and `--pending` requests them again
- Before `## finalize`, look at the made image at the size it is seen at in the game, over the background it is seen on, and in grayscale. It drifted from the art direction when, against the `## base` resource or `image/ui_kit`, its height or head ratio, outline width, light direction or camera angle changed, it adds colors outside the palette, or an icon is filled where the others are outlined (or the reverse). A UI or icon image also drifted when it has a bevel, a glossy highlight or a thick dark outline that the world's characters do not have (a raised button of a portrait phone game excepted), when it is a slab of stone, metal or wood to hold text where the presentation game's same screen is not one, detail that turns to noise at the size it is seen at, or marks of image generation (melted or mushy forms, meaningless glyphs or runes, line weight changing within one object). A drifted image is made again from the `## base` resource or `image/ui_kit`, not edited from the drifted image
- A made image meets [commercial quality](../game-design/commercial-quality.md) for its kind (`## characters`, `## environment`, `## props, pickups, effects and icons`, `## qualities of every resource`). Look at the same kind of asset in the reference videos (`ogw frames`; a UI part in those of the presentation game for its role and place, any other asset in those of the reference game) before writing the prompt, and say in the subject of the prompt the size and background it is seen at in the game. Judge the result in a capture of the game at play size, next to the main character, not on its own
- Post-processing that needs judgement is done by the agent before `ogw resource finalize`: background removal, palette matching, tile seam matching, compositing
- UI images hold no text. Text is kept as UI elements
- The sound of a text voice reads, in the source language, the `source` of the row of the translation key `text_key` of that row in the translation file of the source language (`data/translations/<language>.csv`). When `ogw resource first-final <game> --speaker <speaker>` gives a resource, make it with the same voice as that resource. `<speaker>` is the `speaker` of that row
- A `moss-sfx` prompt describes one sound event in one short sentence: its source as it is in this game and its material, its action, and how it starts and ends. e.g. `A small wooden button tick, dry and close, very short attack and quick decay`. It names no music, no voice, no other sound and no silence, and does not end in `then silence`. For a key whose `loop` is `true`, it describes a continuous sound with no start and no end
- An `ace-step` prompt gives, in this order, the genre, the lead and backing instruments, the mood, and the tempo feel. For a key whose `loop` is `true`, it ends with `steady tempo, no intro, no ending, no fade`; otherwise it ends with `clear ending`
- A haptic is a JSON file (`.json`) in the haptic pattern format of `SoundCore` ([`client-core`](../client-core/SKILL.md))
- For a 3D model, check in `blender` before `## finalize`: `bpy.ops.uv.select_overlap` selects no UV, the weights of every vertex of a rigged mesh sum to 1, every mesh object has location 0, rotation 0 and scale 1, and the origin is at the center of the bottom face of the `bounds` box, where the placeholder box has it
- Generation originals and the other files of a making order are kept in a new work folder per resource key outside the game repo. The game repo holds only the files that the engine uses

## logo

A logo key `image/logo/<language>` is the game's name drawn as a logo in the hand of its world, as commercial titles draw theirs. Image generation does not letter text reliably on its own, so the method `logotype` letters the name with a font first, and the image method of the game draws that lettering again, following it character by character. `ogw generation methods` gives a logo key those two methods; `logotype` letters with the fonts of `font-catalog`, so both wait for that catalog's install, and a logo key that the image method draws waits for its install too. On a host whose image method `ogw generation methods` does not give, the lettering of step 3 is the logo, as step 5 renders it; when the image method's call fails at its usage limit, the key is not made (`## method`).

1. Read the game name of that language in `records/setup/name.md`
2. From `ogw generation list font-catalog`, take the faces whose `style` has `DISPLAY` or `HANDWRITING` and whose `charset` (google/fonts subsets, e.g. `korean`, `latin`, `japanese`, `chinese-simplified`) covers that language, preferring static files to variable ones (a file named `[wght]` draws its default instance, often thin). Render the name with up to five of them whose character fits `## art direction` (e.g. a blackletter or engraved serif for a dark fantasy world, a rounded heavy face for a toy world) with `ogw resource logotype --font <file> --text <name> --out <file> --height <px>`, with the height that makes the lettering about as wide on the screen as the presentation game's logo is on its title screen. The command refuses, naming them, characters the font has no glyph for and scripts that need shaping (e.g. Arabic, Thai), and draws only TrueType (`glyf`) outlines. When it refuses every face, the row is left as it is and the report says so
3. Keep the lettering whose letter shapes fit the art direction and read at a glance at the size seen over the key art
4. Draw it with the image method of the game: the lettering as the first reference image of the call (`--ref` of a sprite-gen method, `--image` of a `local-model` method), then the world's own references that are `final` (the key art, a character, `image/ui_kit`; a key still a placeholder is no reference). The prompt is the style block of `## art direction`, then the name: the exact text, every character exactly as in the first reference (the same characters in the same order, no stroke added or missing), the letters in the world's own hand as the presentation game's logo is in its world: lettering with its own shapes, made of a material of the world where that fits (e.g. bent neon tubes for a neon arcade, brushed paint for a painted world), with no bevel or gloss the world's characters do not have (`## qualities of every resource`) and an outline or shadow only to keep the letters readable over the key art, and it ends with `No other text, no mockup frame, no duplicate letters, no cropped edges, no signature, no watermark.` in place of the ending of other image prompts. A sprite-gen method gets `--chroma-key` with the key color farthest from the logo's own colors (`green` for a pink or magenta logo)
5. Look at each take at the size seen over the key art next to the lettering: every character is the one in the lettering, with nothing added, and its edges carry no fringe of the key color. A take with any other character is not used. When 3 takes keep no take with every character right, the logo is the lettering of step 3 rendered again with `--fill` from the palette (one color, or a top and a bottom color), and `--outline`, `--shadow` and `--glow` from the palette only where the presentation game's logo has them
6. An emblem without letters (`image/emblem`, made with the image method of the game) may be composited behind or beside the logo, as post-processing, with `image/emblem` in `--inputs` of `## finalize`
7. Put it in with `## finalize` and the image method of the game, or the method `logotype` when step 5 kept the lettering

## first final

`ogw resource first-final <game> (--name <name> | --speaker <speaker>)` gives the resource key and file path of the row that became `final` first, among the rows now `final` whose resource key `<name>` is the same (for `--name`) or whose `speaker` is the same (for `--speaker`). When there is no such row, it gives `none`.

## finalize

Put a made file in with `ogw resource finalize <game> <key> --method <method> --file <path> [--inputs <key>...] [--bus <Sfx|Ui>] [--music <file>] [--manifest <file>] [--skeleton <file> --split <file>]`. For a `catalog` method, every `--file` is a path that `ogw generation list <method>` gave. `--inputs` is the resource keys of the composited originals and of the existing final resources used as generation input. `--bus` is given only for type `sfx`, and must be given for it. `--music` is the `music.json` that `ace-step` wrote with that file; it is given only for type `bgm` whose `loop` is `true`, and must be given for it. For a row whose `spec` has `variants` of 2 or more, `--file` is given as many times as the number of variants, in `<n>` order. For `sprite_animation`, give the sheet PNG in `--file` and the `manifest.json` of sprite-gen in `--manifest`. For `rig_animation_2d`, give the rig scene in `--file`, the skeleton spec in `--skeleton` and the rig split JSON in `--split`. `--manifest`, `--skeleton`, `--split` are given only for those types, and must be given for them. The tool does:

1. Check. When any check fails, it changes nothing and fails: the `status` of the `<key>` row is `requested` or `temporary`, or `final` or `placeholder` with its key in a request file of this run, and a `final` row is not made with the temporary method. `<method>` is in the output of `ogw generation methods <game> <key>`. The extension of `--file` is `.png` for `sprite_animation`, and for any other type the extension of that type in `## resource type` of the engine (`.wav` is also accepted for `sfx`, `bgm`, `voice`). The rows of `--inputs` are all `final`. `--bus`, `--music`, `--manifest`, `--skeleton`, `--split` follow the rules above. When there is a row whose key is the resource key of an attached row, its `description` is `<key> sheet` for the sheet row and `<key> part <part name>` for a part image row
   - an image of a type that has `alpha` in `spec`, whose `alpha` is `true`: it has a pixel with alpha under 255. A fully opaque file has its background baked in
   - `sprite_animation`: the set of `frame_layout` state names of `--manifest` is the same as the set of `animations` names of `spec`, and each state has one or more frames
   - `rig_animation_2d`: the skeleton spec is in the `## skeleton spec` format, and every bone has a `pivot`. The `image` of each part is `image/<name>/<part name>`. The parts of `--split` are the same as skeleton spec `parts`, `canvas` of `--split` is `size` of `spec`, `source` of `--split` is skeleton spec `source`, and `ogw resource rig-check` is `pass`. The set of `Bone2D` names, the set of part node names and the set of `AnimationPlayer` animation names of the rig scene are the same as the name sets of `bones`, `parts` and `animations` of the skeleton spec. In the rig scene, the `position` of the root `Bone2D` plus the `position` of its parent `Skeleton2D`, a child of the root node, is `[x − width ÷ 2, y − height ÷ 2]` for the root `pivot` `[x, y]` and `canvas` `[width, height]`
2. Deterministic post-processing of a copy of `--file`
   - `image`, `icon`, `background`, `texture`, `app_icon`, `splash`: when `alpha` of `spec` is `true`, crops the border rows and columns whose alpha is 0, scales it to fit in `size` keeping the aspect ratio and places it at the center of a transparent canvas of `size`. When it is `false`, scales it to cover `size` keeping the aspect ratio and crops the center to `size`
   - `sprite_animation`: fits the frames to `size` of `spec`
   - `sfx`, `bgm`, `voice`: shape the sound, then match its loudness
     - When `loop` of `spec` is not `true`: when the type is not `bgm`, cut the spans at the start and end where the absolute sample value of every channel is less than -60 dBFS. When the type is `sfx` and the sound is longer than `length` of `spec`, cut it to that length. Then fade in linearly over the first 2 ms, and fade out linearly over the last 50 ms or the last quarter of the sound, whichever is shorter
     - When `loop` of `spec` is `true`: cut the span at the end where the absolute sample value of every channel is less than -60 dBFS, then make a loop of loop length L whose seam is a crossfade of length X. For `bgm`, X is one bar (`beatsPerBar` × 60000 ÷ `bpm` of `--music`, in ms) and L is the largest whole number of bars that is at most `length` of `spec` and at most the file length − X; it fails when L is shorter than 4 bars. For `sfx`, X is 500 ms or a quarter of `length` of `spec`, whichever is shorter, and L is `length` of `spec` or the file length − X, whichever is shorter; it fails when L is not longer than X. The loop is the first L of the file, with its first X replaced by the equal-power crossfade of the first X (fading in) and the X right after L (fading out), so that the end of the loop runs on into its start
     - Then match the integrated loudness (ITU-R BS.1770-4) to the `SoundCore.busLoudnessLufs` value of the bus plus the `level` offset (`quiet` −8 dB, `normal` 0 dB, `loud` +4 dB; `normal` for `bgm` and `voice`), and limit the true peak to at most the `SoundCore.busPeakMaxDbtp` value of the bus. For a sound shorter than 400 ms (one gating block) that has no integrated loudness, measure the integrated loudness and true peak of that sound repeated for 1000 ms, and multiply the whole sound by one gain: the smaller of the gain that matches the loudness to that target and the gain that makes the true peak the bus value. A sound with no true peak (no samples left) fails. The bus is `Bgm` for `bgm`, `Voice` for `voice`, and `--bus` for `sfx`. The values are those of game settings `core` laid over core settings. The result is written in the format of the extension of that type for the engine. The integrated loudness and true peak of the result are given. A result shorter than 400 ms is measured repeated for 1000 ms
3. Writing the result of step 2 to `resource/<key>.<extension>`, and the files and rows of the attached rows
4. Changing the `status` of the row to `final` (`temporary` when `ogw generation methods` gives `<method>` with `temporary` for that key) and `method` to `<method>`, and writing `source`, `license`, `attribution` and, for a text voice row, `text_hash`
5. It runs `ogw resource sync <game>` and does not commit
