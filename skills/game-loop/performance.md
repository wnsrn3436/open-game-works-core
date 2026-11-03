# performance

The platforms on which `ogw check` judges performance and UI quality.

## platform profile

The first platform of `android`, `ios` that appears in game settings `buildPlatforms`, and the first platform of `windows`, `macos`, `linux`, `web` that appears there. `ogw check` judges performance and UI quality separately per platform profile, on an instance started with that platform as `--platform`, and writes one item per platform profile in `check-<iteration>.json`.
