# performance

The platforms on which `ogw check` judges performance and UI quality, the judgement of performance, and host load.

## platform profile

The first platform of `android`, `ios` that appears in game settings `buildPlatforms`, and the first platform of `windows`, `macos`, `linux`, `web` that appears there. `ogw check` judges performance and UI quality separately per platform profile, on an instance started with that platform as `--platform`, and writes one item per platform profile in `check-<iteration>.json`.

## performance

- The check measures by running the same scenario as the bot playtest once more on an instance that draws the screen. If `QualityCore` is in the module list, it first calls `set_quality_level`(`High`)
- While the scenario runs, the check reads `get_state` and then `get_stats` every 1000ms. One such reading is a tick. The `fps` of `get_stats` of a tick is a sample of the `scene_key` of `get_state` of that tick
- A tick has a scene load when one of its two requests did not answer `ok`, when its `boot_stage` is not `Done` or its `in_transition` is `true`, or when its `scene_key`, `last_scene_load_ms` or `boot_ms` differs from that of the tick before or there is no tick before. Only the samples of the ticks that have no scene load and whose tick before has no scene load are kept, so that no kept sample covers a scene load, a restart or the 1000ms after them
- fps bound of a sample: the smallest of game settings `targetFps`, the refresh rate and the frame limit, minus 1
  - refresh rate: the refresh rate of the main display of the host in Hz, rounded down, when the client draws on the host. It is left out for a client on a device and when it cannot be read
  - frame limit: the `frame_limit_fps` of `QualityCore` for the level that `quality_level` of `get_stats` of that tick names, with `QualityCore.levels` of the game's merged core settings. It is left out when `quality_level` names no level of `QualityCore.levels` (the empty string when `QualityCore` is not in the module list)
- A scene with 2 or more kept samples is judged. It keeps the fps when, at the 5th percentile of its kept samples ordered by fps − fps bound (nearest rank: the ⌈5n/100⌉-th smallest of n samples), the fps is at least the fps bound. A scene with 1 kept sample is `unknown`, and a scene with no kept sample is not judged unless a tick that would be kept had no numeric `fps` in that scene, which makes it `unknown`. When no scene has a kept sample, the fps is `unknown`
- Judgement: `pass` when every judged scene keeps the fps and every `duration_ms` of telemetry `scene_loads` is at most game settings `loadingTimeLimitMs`. `boot_ms` is not compared

## host load

While `ogw check` measures performance for a platform profile, `cpuMaxPercent` is the maximum of the whole-host CPU usage (%) read every 1000ms, `memoryMaxPercent` the maximum of the memory usage (%), and `instancesMax` the maximum of the number of instances that the runner started during that time. `ogw check` writes them in the `performance` item of that platform profile in `check-<iteration>.json` as `"hostLoad": {"cpuMaxPercent": <number>, "memoryMaxPercent": <number>, "instancesMax": <integer>}`.
