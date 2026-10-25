---
name: resource
description: Holds the resource key format, the resource list file, the `spec` format, placeholder resources, resource requests, the final resource production method and post-processing, and resource rights. Read when the content agent writes or requests resources, when a resource sub-agent makes final resources, when the core agent edits `licenses.json`, and when the lead agent of `build` handles placeholders
---

# resource

## resource key

- The format of a resource key is `<type>/<name>`. `<name>` is snake_case words joined with `/`. e.g. `icon/skill_fireball`, `bgm/battle_boss`, `prefab/enemy/slime`
- `<type>` is one value of the table below

| category | type |
|---|---|
| 2D | `image`, `sprite_sheet`, `texture_atlas`, `icon`, `background`, `nine_slice` |
| 3D | `model`, `rig`, `material`, `texture`, `skybox` |
| animation | `sprite_animation`, `rig_animation_2d`, `animation_3d`, `tween` |
| VFX | `particle`, `shader` |
| audio | `sfx`, `bgm`, `voice` |
| haptics | `haptic` |
| typography | `font` |
| map | `tileset` |
| scene | `scene` |
| prefab | `prefab` |
| platform | `app_icon`, `splash` |

- The content agent picks the type of a 2D animation per resource key. A character, monster or boss with several motions is `rig_animation_2d`, and any other 2D animation is `sprite_animation`
  - `sprite_animation`: a sprite sheet drawn frame by frame, and a frame list
  - `rig_animation_2d`: a 2D cutout skeletal rig with part images attached to bones, and its animations

- The resource key of a named target (character, monster, item, skill) has no number. The same target uses the same name in its ID name and its resource key. e.g. `[skill_fireball]` and `icon/skill_fireball`
- The resource keys of the platform types are only `app_icon/main` and `splash/main`. `ogw resource sync` adds the two rows as `placeholder` when they are not in `resources.csv`. In `spec`, `app_icon/main` has `size=1024x1024`, and `splash/main` has a `size` equal to the size of game settings `baseResolution`. The build converts them to the size and format that each platform needs
- A file is put at `resource/<resource key>.<extension>`. One resource key has one file. As an exception, a row whose `spec` has `variants` of 2 or more has one file `resource/<resource key>.<n>.<extension>` per variant, with `<n>` from 1 to `variants`
- A final `sprite_animation` row and a final `rig_animation_2d` row have attached rows that `ogw resource finalize` writes. `sprite_animation/<name>` has one sheet row `sprite_sheet/<name>`, and `rig_animation_2d/<name>` has a part image row `image/<name>/<part>` per part. The content agent does not add rows with the resource keys of attached rows
- Per type, the `<extension>`, the file content and the `ResourceCore` resource kind are defined by `## resource type` of the per-engine implementation rules of `client-core` for game settings `engine`: [Godot](../client-core/engines/godot.md)
- After the first PROD build, resource keys that went out to PROD are not changed or deleted. When a key that was in `resources.csv` of the PROD data tag of [`data`](../data/SKILL.md) is not in the current `resources.csv`, the data tool blocks it with `prod_change`
- Code loads resources only through the resource key constants that the harness tool made or the `reskey` values of data. Resource key strings and file paths are not written in code
- There is one resource key constant per resource key of `resources.csv`. Its name is the resource key in uppercase with `/` changed to `__`. e.g. `prefab/enemy/slime` → `PREFAB__ENEMY__SLIME`. In the client it is in the class that the per-engine implementation rules of `client-core` for game settings `engine` define ([Godot](../client-core/engines/godot.md): `ResourceKey.PREFAB__ENEMY__SLIME`), and in the server it is an export of the module that `## generated code` of [`server-core`](../server-core/SKILL.md) defines

## resource list

`resource/resources.csv` is the list of all resource keys. It has 1 header row.

| column | contents |
|---|---|
| `key` | resource key |
| `description` | One sentence on what it is. The scenes and moments where it is used |
| `spec` | The size, length and format conditions of the resource to make |
| `status` | `placeholder`, `requested`, `final`, `temporary` |
| `method` | The name of the generation method that made the final resource |
| `source` | The source URL of a collected resource. Empty cell for a made resource |
| `license` | SPDX license expression or `unknown` |
| `attribution` | The author credit that has to be displayed. Empty cell when there is none |
| `sha256` | The SHA-256 of the file. For a row with several variant files, the SHA-256 of the SHA-256 hex strings of the files joined in `<n>` order |
| `text_key` | The translation key (pre-build key) of the text that a text voice reads. Empty cell in any other row |
| `speaker` | The speaker name of a text voice. Empty cell in any other row |
| `text_hash` | The hash of the source text that a text voice reads. Empty cell in any other row |

- `ogw resource finalize` writes `method`, `source`, `license`, `attribution`, `text_hash`, and `ogw resource sync` writes `sha256`
- text voice: a `voice` resource that reads a set text. It is a line voice (a `voice` resource that a `cutscene_step` row of `CutsceneCore` puts in its `voice` column) or a subtitled voice (a `voice` resource played with the `AccessibilityCore` operation `play_voice`). Line voice rows and `voice` rows whose `text_key` is not an empty cell are text voice rows
- `ogw resource sync` writes `text_key` and `speaker` of line voice rows. `text_key` is the translation key of `text` of that `cutscene_step` row, and `speaker` is the ID name of `speaker` of that row without the brackets (`none` when it is `null`)
- The content agent writes `text_key` and `speaker` of subtitled voice rows. `text_key` is the subtitle translation key passed to `play_voice`, and `speaker` is the `cutscene_speaker` ID name of the same character without the brackets when there is one, otherwise a snake_case name that the content agent decides
- Rows whose type is `scene`, `prefab` or `tween` are `final` from the start
- A `temporary` row holds a resource that the temporary method made in place of the method of that key (`## method` of [production.md](production.md)). It counts as made in the no placeholder check, and is not given in `--see` or `--base`
- When the SHA-256 of a file differs from `sha256`, an automated check blocks it. `ogw resource sync <game>` aligns the files and the list
- For each text voice row whose `status` is `final`, `ogw resource sync` finds the `text_key` row in the translation file of the source language. When the `current_hash` of that row differs from `text_hash`, it changes `status` to `placeholder`, empties `method`, `source`, `license`, `attribution`, `text_hash`, and makes the placeholder resource again
- `ogw resource sync` fails when the `text_key` of a text voice row is not in the translation file of the source language, when `spec` violates the `spec` item rules, or when the file extension or engine class differs from `## resource type` of the engine
- A row whose `attribution` is not an empty cell is put in the game's license manifest by `ogw generate`, and the license screen of the client (the `UICore` operation `open_licenses`) shows it

### spec

A `spec` cell is items `<name>=<value>` joined with `;` without spaces. An item is written only once. e.g. `size=128x128;alpha=true`, `length=800;variants=3`. Writing an item whose `required type` and `optional type` do not include the type of the row, or leaving out an item whose `required type` includes it, violates the rules.

| item | value | required type | optional type |
|---|---|---|---|
| `size` | `<width>x<height>`. px integers. For `sprite_animation` the size of one frame, for `rig_animation_2d` the size of the canvas of the rig split JSON, whose center is the origin of the root node | `image`, `sprite_sheet`, `texture_atlas`, `icon`, `background`, `nine_slice`, `texture`, `skybox`, `tileset`, `app_icon`, `splash`, `sprite_animation`, `rig_animation_2d` | none |
| `alpha` | `true` for a transparent background, otherwise `false`. `false` when omitted | none | `image`, `sprite_sheet`, `texture_atlas`, `icon`, `background`, `nine_slice`, `texture`, `tileset` |
| `slice` | 9-slice margin `<left>,<top>,<right>,<bottom>`. px integers | `nine_slice` | none |
| `length` | Length. ms integer | `sfx`, `bgm`, `voice`, `haptic`, `animation_3d` | none |
| `loop` | `true` for looped playback, otherwise `false`. `false` when omitted | none | `sfx`, `bgm`, `animation_3d`, `particle` |
| `animations` | Animation list. Each animation is `<name>:<length>:<repeat>`, joined with `,`. `<name>` is snake_case and unique. `<length>` is an ms integer. `<repeat>` is `loop` for looped playback and `once` for playing once. e.g. `idle:800:loop,attack:500:once` | `sprite_animation`, `rig_animation_2d` | none |
| `variants` | Number of variants. Integer of 1 or more. 1 when omitted | none | `sfx` |
| `level` | Loudness of a sound effect against the other sound effects of its bus: `quiet`, `normal` or `loud`. `normal` when omitted | none | `sfx` |
| `bounds` | Model size `<x>x<y>x<z>`. The width (x), height (y, up axis) and depth (z) of the axis-aligned box that encloses the model in its default pose. Decimals in m | `model` | none |
| `space` | `2D` or `3D` | `particle`, `shader` | none |

## placeholder resource

- When the content agent needs a resource, it adds a row to `resources.csv` as `placeholder` and runs `ogw resource placeholder <game>`. The tool makes the placeholder resource as `spec` says
  - `image`, `sprite_sheet`, `texture_atlas`, `icon`, `background`, `nine_slice`, `texture`, `skybox`, `tileset`, `app_icon`, `splash`: a solid-color PNG of the `spec` size with the last word of the resource key in it as text
  - `sfx`, `bgm`, `voice`: a tone of the `spec` length. Variant files are tones of a different pitch per variant
  - `model`: a box of the `spec` size
  - `haptic`: a haptic pattern JSON with one segment of the `spec` length (`delay_ms` 0, `intensity` 1000)
  - `font`: harness settings `tools.placeholderFont`
  - `rig`, `material`, `sprite_animation`, `rig_animation_2d`, `animation_3d`, `particle`, `shader`: the placeholder resource that `## resource type` of the engine defines
- Placeholder resources are not drawn or edited by hand
- A sound effect that is heard repeatedly (hits, footsteps, UI presses) gets `variants` of 2 or more in `spec`
- The long side of `size` of a `nine_slice` is 256 or more, so that a stretched frame keeps its detail. `ogw resource request` refuses a smaller one
- A game with UI art adds `image/ui_kit` (`spec` `size=1024x1024`) and requests it before its first `nine_slice` and `icon` keys, which are requested with `--see image/ui_kit`
- A sound effect that is heard many times a minute (hits, pickups, footsteps, UI presses) gets `level=quiet`, and a sound effect of a rare event that the player must notice (level up, boss arrival, death) gets `level=loud`

## resource request

The content agent requests, and in `game-loop` and `build`, `ogw loop dispatch` run by the lead agent requests with `--pending`. The request command is `ogw resource request <game> (<key>... | --pending) [--see <key>...] [--base <key>]`. The tool changes the `status` of the requested rows to `requested`, writes the request file and commits. A `temporary` row keeps its `status` and its file until `ogw resource finalize` replaces them. The request file is `records/loops/<run>/resource-requests/<unix ms>.md` in the loop, and in build the path that `build` defines.

- `--pending`: requests all of the rows below
  - rows whose `status` is `placeholder`
  - rows whose `status` is `requested` and whose resource key is in no request file written in this run
  - rows whose `status` is `temporary` and whose resource key is in no request file written in this run
  - rows whose `status` is `requested`, for which every request file of this run that holds that resource key has a result file `<request file name>-result.md`, and for which the number of those request files is at most harness settings `backgroundRetryLimit`. These are rows whose assigned work ended without them becoming final
- `--see`: existing final resource keys to look at together. The content agent picks them
- `--base`: an existing final resource key to use as the base when requesting a variant of the same target. The content agent picks it
- A request file has three sections, `## keys` (the requested resource keys), `## see` and `## base`, and each section is a list with one resource key per line. An empty section is one line `none`
- The direction of art and audio follows `## art direction` and `## audio direction` of `design.md`
- After requesting, the content agent continues development with placeholder resources

## final resource production

How the resource sub-agent makes final resources, and their post-processing, are in [production.md](production.md).

## resource rights

- A resource whose source cannot be checked is not used. Sources are not made up
- Collected resources use only `CC0-1.0` and `CC-BY-4.0`. Fonts also use `OFL-1.1`
- The rights of a made resource follow the license of the generation method and the licenses of the inputs. The license of a method whose commercial use is not confirmed is `unknown`
- When a method makes its resources from output of another method that is not put in as a resource row of its own (so it is not in `--inputs` of `ogw resource finalize`), its `license` also holds the `license` of that other method. e.g. the part images of `rig-2d` and the source illustration of `trellis2` are `flux2-klein` output
- The license references in the `license` of the methods of harness settings `resourceGeneration` mean the following
  - `LicenseRef-OpenAI-Output`: output of OpenAI models, the license of a method whose `provider` is `codex`. The [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) (personal ChatGPT account) and the [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) (ChatGPT Business, ChatGPT Enterprise, API key) give the ownership of the output to the user, so commercial use is allowed
  - `LicenseRef-xAI-Output`: output of xAI models, the license of a method whose `provider` is `grok`. The [xAI Terms of Service - Consumer](https://x.ai/legal/terms-of-service) (Grok login) and the [xAI Terms of Service - Enterprise](https://x.ai/legal/terms-of-service-enterprise) (`XAI_API_KEY`) give the ownership of the output to the user, so commercial use is allowed. The same terms have a clause on attributing the output to the service, as the [xAI Brand Guidelines](https://x.ai/legal/brand-guidelines) describe, so a method whose `provider` is `grok` has `attribution` `Created with Grok`, the wording those guidelines give for made images
  - `LicenseRef-game-owned`: what the game's own procedural generation made: a program, script or shader that an agent wrote, and its output. It is part of the content of the game and is under the license of that content. It is the license of the `procedural` methods
  - `LicenseRef-DINOv3`: the DINOv3 License of Meta, in `LICENSE.md` of the hf pin `facebook/dinov3-vitl16-pretrain-lvd1689m` of `trellis2`
- The screens, resources, names and text of the reference game are not used as generation input or reference images
- A composited resource follows the license conditions and attribution of every original. `ogw resource finalize` calculates `license` and `attribution` from the originals
- Agents do not install or run external download tools
