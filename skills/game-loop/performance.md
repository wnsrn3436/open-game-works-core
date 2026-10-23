# performance

The platforms on which `ogw check` judges performance and UI quality, the judgement of performance, and host load.

## platform profile

The first platform of `android`, `ios` that appears in game settings `buildPlatforms`, and the first platform of `windows`, `macos`, `linux`, `web` that appears there. `ogw check` judges performance and UI quality separately per platform profile, on an instance started with that platform as `--platform`, and writes one item per platform profile in `check-<iteration>.json`.

## performance

- The check measures by running the same scenario as the bot playtest once more on an instance that draws the screen. If `QualityCore` is in the module list, it first calls `set_quality_level`(`High`)
- At each step of the scenario, the `fps` of `get_stats` becomes a sample of the `scene_key` of `get_state` at that moment
- Judgement: `pass` when, for each scene, the 5th percentile of the samples (nearest rank: the ⌈5n/100⌉-th smallest value of n samples) is at least game settings `targetFps`, and every `duration_ms` of telemetry `scene_loads` is at most game settings `loadingTimeLimitMs`. `boot_ms` is not compared

## host load

While `ogw check` measures performance for a platform profile, `cpuMaxPercent` is the maximum of the whole-host CPU usage (%) read every 1000ms, `memoryMaxPercent` the maximum of the memory usage (%), and `instancesMax` the maximum of the number of instances that the runner started during that time. `ogw check` writes them in the `performance` item of that platform profile in `check-<iteration>.json` as `"hostLoad": {"cpuMaxPercent": <number>, "memoryMaxPercent": <number>, "instancesMax": <integer>}`.
