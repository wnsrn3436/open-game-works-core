# SoundCore

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

Handles per-bus volume and mute, BGM switching, sound effect playback and the concurrent playback limit, pause, and haptic pattern playback. Code, scenes and prefabs outside SoundCore have no sound players other than content positional players and no haptic calls.

## dependency

`UtilCore`, `LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `ResourceCore`, `InputCore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `load_volume_settings` | none | none | none | `BootstrapCore`(`InitModules` stage) |
| `set_volume` | `SoundBus`, volume | none | none | content code |
| `get_volume` | `SoundBus` | volume | `1` | core, content code |
| `set_mute` | `SoundBus`, whether muted | none | none | content code |
| `get_mute` | `SoundBus` | whether muted | `false` | core, content code |
| `play_bgm` | resource key, resource scope (optional) | none | none | core, content code |
| `stop_bgm` | none | none | none | core, content code |
| `return_bgm` | none | none | none | core, content code |
| `get_bgm_key` | none | resource key of the current BGM | empty string | core, content code |
| `play` | resource key, `SoundBus`, resource scope, priority (default `0`) | play handle | invalid handle | core, content code |
| `stop` | play handle | none | none | core, content code |
| `is_playing` | play handle | whether the handle is not invalid. A request being loaded is also `true` | `false` | core, content code |
| `request_pause` | none | pause token | invalid pause token | core, content code |
| `release_pause` | pause token | none | none | core, content code |
| `play_haptic` | haptic resource key, resource scope | success flag | `false` | core, content code |
| `set_haptic_enabled` | whether on | none | none | content code |
| `is_haptic_enabled` | none | whether on | `false` | core, content code |

### type

| type | contents |
|---|---|
| `SoundBus` | `Master`, `Bgm`, `Sfx`, `Voice`, `Ui` |
| volume | linear real number of at least 0 and at most 1. The bus level (dB) is `20 × log10(volume)` |
| priority | integer. Larger is higher |
| play handle, pause token | a value that SoundCore issues. An issued value is not issued again until `release`. An invalid value points to no request |
| haptic pattern | content of a `haptic` resource. The file is `resource/haptic/<name>.json`, a UTF-8 JSON object `{"segments": [{"delay_ms": <integer>, "duration_ms": <integer>, "intensity": <integer>}, ...]}`. `segments` has 1 or more items, `delay_ms` is 0 or more, `duration_ms` is 1 or more, and `intensity` is in permille, at least 0 and at most 1000. Any other key or value is a format error |

- A resource key is received as a `ReservedSound` accessor or a `reskey` value of data

## behavior

### bus and volume

- The output of the `Bgm`, `Sfx`, `Voice` and `Ui` buses goes into the `Master` bus. The linear output level is playback volume × variation gain × that bus's volume × duck gain × `Master` volume. The variation gain is 1 except for `Sfx` playback, and the duck gain is 1 except for the `Bgm` bus
- The `Master` bus has a limiter. Its ceiling is `SoundCore.masterPeakMaxDbtp` minus `SoundCore.masterLimiterMarginDb`
- Exception: a run for which the engine-specific implementation rules state that the limiter cannot run plays without the limiter. The `Master` output level of that run relies on `SoundCore.busLoudnessLufs` and `SoundCore.busPeakMaxDbtp`, which `ogw resource finalize` of [`resource`](../../resource/SKILL.md) applies
- A bus with mute on and a bus with volume 0 are silent. Mute does not change volume
- The default is volume 1, mute `false`. `set_volume` and `set_mute` apply to the bus at once and write to the `device` file of `LocalDataCore`
- `load_volume_settings` is called after `LocalDataCore.load_device_file` and applies the saved values to all buses. When a key is missing or a volume is NaN or out of range, it uses the default without a log. Before it is called, the values are the default

### playback common

- Playback gets the sound with the request's resource scope. When the scope is released, playback requested with that scope stops without a fade
- A request whose loading ended with a fallback resource does not play. `ResourceCore` leaves the log
- A fade changes the playback volume linearly over a set duration in real elapsed time. The playback volume of playback that is not fading is 1
- Sounds of the `Bgm` bus are played by streaming (decoding while playing) and loop. Sounds of other buses are played from memory (decoded when loaded). The engine-specific implementation rules define how the two playback methods and loop are set up in the engine
- SoundCore playback does no attenuation or panning by spatial position. A content positional player plays sounds that have a spatial position

### BGM

- There are two BGM players. SoundCore records the current BGM and the previous BGM by resource key and resource scope
- BGM scope: for each `play_bgm` without a scope, SoundCore creates one owner object, and the BGM scope is the scope obtained with `ResourceCore.get_owner_scope`. That request loads with this scope. When a BGM recorded with a BGM scope becomes neither the current BGM nor the previous BGM, or its request is discarded, SoundCore calls `ResourceCore.end_owner_scope` and destroys that owner object. Of the resources of BGMs without a scope, only those of the current BGM and the previous BGM remain
- `play_bgm`
  - When the resource key equals the current BGM, it does not crossfade, and when loading ends, it replaces the current BGM's scope with the new scope. The playback position continues
  - Otherwise, after loading ends, it crossfades to the new BGM. When there is a current BGM, it becomes the previous BGM, and the new BGM becomes the current BGM. When there is no current BGM, the previous BGM stays as it is
- A crossfade changes the new BGM from 0 to 1 and the current BGM from its playback volume at that time to 0 over `SoundCore.bgmCrossfadeMs`, and stops the one that ended. When, at the start, a BGM that is not the current BGM is fading out, it stops without a fade
- `stop_bgm` fades out the current BGM over `SoundCore.bgmCrossfadeMs` and stops it. The current BGM becomes the previous BGM and there is no current BGM
- `return_bgm` plays the previous BGM from the start with a crossfade. It becomes the current BGM and there is no previous BGM
- `play_bgm`, `stop_bgm` and `return_bgm` discard earlier `play_bgm` and `return_bgm` requests whose loading has not ended. A `stop_bgm` without a current BGM and a `return_bgm` without a previous BGM also discard them
- When the scope of the current BGM is released, there is no current BGM, and it does not become the previous BGM. When the scope of the previous BGM is released, there is no previous BGM
- A BGM that continues across scene transitions is called without a scope

### sound effect

- The bus of `play` is one of `Sfx`, `Voice`, `Ui`
- `play` of a resource key whose variant count is 2 or more picks one of the variants other than the variant played last with that key, using the random instance of `UtilCore` (purpose name `sound_variant`). The first `play` of that key picks from all variants
- Each playback of `play` on the `Sfx` bus gets a variation picked with the random instance of `UtilCore` (purpose name `sound_variation`): a pitch scale of 2^(c ÷ 1200), where c is uniform in ±`SoundCore.sfxPitchVariationCents`, and a variation gain of 10^(d ÷ 20), where d is uniform in ±`SoundCore.sfxVolumeVariationDb`. A value of 0 gives no variation. Playback on the `Voice` and `Ui` buses has none
- `SoundCore.maxConcurrent` sfx players are created in advance, and new playback starts on one free player. When playback ends or stops, the player becomes free at once
- `play` of a loaded sound starts playback within the call and can be called from frame code
- `play` of a sound that is not loaded returns the handle at once, and loading starts before that frame ends. `play_bgm` and `return_bgm` of a BGM that is not loaded also start loading before that frame ends. When loading ends, it does the limit check and plays. When `stop` or a scope release comes before that, it does not play
- The playback count counts only playback started with `play`. Paused playback is included and requests waiting on loading are not
  - The playback count of the same resource key is at most `SoundCore.maxConcurrentPerKey`, and the total is at most `SoundCore.maxConcurrent`
  - When a limit is exceeded, a replacement target is picked: the playback with the lowest priority that started first, among the playback of the same key when the same-key limit is exceeded, otherwise among all
  - When the replacement target's priority is higher than the new playback's, the new playback does not happen. Otherwise the replacement target stops without a fade and the new playback starts
- When the playback of a `play` request starts, SoundCore sends `SoundPlayedEvent`. It does not send it for a request decided not to play or for BGM
- The handle of a request that ended, was stopped, was replaced or was decided not to play is invalid. `stop` with an invalid handle does nothing
- `is_playing` is `false` from the frame in which the end, stop or replacement happens
- A caller that runs `play` on a loop sound keeps the handle and ends it with `stop`
- Non-repeating playback ends when the engine reports its end, or when the real elapsed time outside pause reaches the length of that sound ÷ the pitch scale of that playback. So even while audio output is not running (e.g. before the first user input in a browser), the playback count and the end of voices follow the sound length, and sounds do not play late when audio runs again

### voice duck

- voice playing: one or more `play` playbacks on the `Voice` bus have started and are not stopped by a pause
- While a voice is playing, the duck gain of the `Bgm` bus goes in real elapsed time linearly in dB from its value to −`SoundCore.voiceDuckDb` dB over `SoundCore.voiceDuckAttackMs` × (the dB still to go ÷ `SoundCore.voiceDuckDb`). When no voice is playing, it goes back to 0 dB the same way over `SoundCore.voiceDuckReleaseMs`. A `SoundCore.voiceDuckDb` of 0 gives no duck
- `release` puts the duck gain back to 0 dB at once

### pause

- While the game time of `TimeCore` is paused, playback on the `Sfx` and `Voice` buses stops while keeping its position, and continues when the pause is lifted. `Sfx` and `Voice` playback started during that time starts in the stopped state. `Bgm` and `Ui` do not stop
- global pause stops playback and fades on all buses while there is one or more reason. The reasons are the unfocused state and the tokens of `request_pause`
- unfocused state: the period after the app loses focus, as the engine reports, until the app regains focus, or the period after `TimeCore.AppBackgroundEnteredEvent` until `AppForegroundReturnedEvent`. The engine mapping of the app losing and regaining focus is in the engine-specific implementation rules
- `release_pause` removes the reason of that token

### haptic

- In `init`, SoundCore registers the haptic kind with `ResourceCore.register_kind`. The fallback is a haptic pattern with empty `segments`. The engine type is in the engine-specific implementation rules
- `play_haptic` gets the haptic pattern with `ResourceCore.get_loaded`(resource key, haptic kind, resource scope). A key that is not loaded gets the fallback, and SoundCore returns `false` without a log. `ResourceCore` leaves the log. The caller loads haptic resources in advance in the scene's `on_preload` or with `ResourceCore.load`
- When the obtained pattern that is not a fallback is not in haptic pattern format, the result is `false`. This error log is left once per resource key until `release`
- haptic target: when `InputCore.get_device` is `Gamepad` at the time `play_haptic` is called, the gamepad of `InputCore.get_last_gamepad` (`Gamepad`); otherwise the device (`Device`). It does not depend on the platform. The haptic target of a pattern being played does not change until that pattern ends
- `play_haptic` plays the haptic pattern as vibration of the haptic target. Segments play in order. From the time the previous segment ends (for the first segment, the playback start), it waits `delay_ms` and then vibrates at `intensity` for `duration_ms`. `intensity` 0 does not vibrate. When a pattern is playing, it stops it and plays the new pattern
- After the format check passes, when haptics are off, global pause is on, or the haptic target has no vibration feature, it does not play and returns `false` without a log. A `Gamepad` target has the vibration feature when `get_last_gamepad` is not −1. The platforms on which a `Device` target has the vibration feature are in the engine-specific implementation rules
- A haptic target that does not support intensity plays a segment whose intensity is greater than 0 as vibration of the same duration
- `set_haptic_enabled` writes to the `device` file of `LocalDataCore`. The default is `true`, and `load_volume_settings` loads it too

### content positional player

- content positional player: an engine positional sound player that content code, scenes and prefabs own. It attenuates by distance to the listener and pans by direction. The engine mapping is in the engine-specific implementation rules
- A content positional player plays only `sfx` resources, and its output bus is `Sfx`. So the volume, mute and limiter of `Sfx` and `Master` apply
- A content positional player stops while keeping its position during a game time pause of `TimeCore` and continues when the pause is lifted. During global pause, SoundCore stops content positional players and continues them when it is lifted
- Playback of a content positional player is not in the playback count of `play` and sends no `SoundPlayedEvent`. The content code that owns the player plays, stops and destroys it. `release` does not destroy content positional players

### release

- Stops all playback and haptics and destroys the players. Discards the requests waiting on loading, the current BGM, the previous BGM and the pause reasons. For each BGM scope, calls `ResourceCore.end_owner_scope` and destroys that owner object
- Resets the volume and mute of all buses and the haptics-on value to the default. Does not change the values in `LocalDataCore`

## hook

none

## event

| event | when | payload |
|---|---|---|
| `SoundPlayedEvent` | when the playback of a `play` request starts. `QACore` counts it as feedback | `bus`: `SoundBus` |

## error

| condition | failure value | log |
|---|---|---|
| volume of `set_volume` less than 0, more than 1, NaN | applied as 0, 1, 1 | error |
| bus that is not an element of `SoundBus` | volume and mute not changed. Queries return the failure value in the table | error |
| bus of `play` is `Master` or `Bgm` | invalid handle | error |
| missing or released resource scope | `play`: invalid handle, `play_bgm`: current BGM kept, `play_haptic`: `false` | error |
| `play` of a sound that is not loaded | returns a handle and plays after loading | warn in a build that contains DEV code |
| `release_pause` with an invalid pause token or a token already released | pause state not changed | error |
| haptic resource that is not a fallback is not in haptic pattern format | `false` | error. Once per resource key until `release` |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `SoundCore.bgmCrossfadeMs` | integer | core | content | crossfade duration, fade out duration of `stop_bgm` |
| `SoundCore.maxConcurrent` | integer | core | content | total concurrent playback limit of `play` and the number of sfx players. 1 or more |
| `SoundCore.maxConcurrentPerKey` | integer | core | content | concurrent playback limit of the same resource key. 1 or more |
| `SoundCore.masterPeakMaxDbtp` | number | core | content | limit (dBTP) of the true peak of the `Master` output. 0 or less |
| `SoundCore.masterLimiterMarginDb` | number | core | content | value (dB) by which the limiter ceiling is set below the peak limit |
| `SoundCore.busLoudnessLufs` | object | core | content | integrated loudness target (LUFS) per `Bgm`, `Sfx`, `Voice`, `Ui`. `ogw resource finalize` adjusts sound files to it |
| `SoundCore.busPeakMaxDbtp` | object | core | content | true peak limit (dBTP) of sound files per `Bgm`, `Sfx`, `Voice`, `Ui`. `ogw resource finalize` adjusts sound files to it |
| `SoundCore.devHapticLogCount` | integer | core | content | number of records that `get_haptic_log` keeps. Only DEV code reads it |
| `SoundCore.sfxPitchVariationCents` | number | core | content | largest pitch change (cents) of a `Sfx` playback. 0 or more |
| `SoundCore.sfxVolumeVariationDb` | number | core | content | largest volume change (dB) of a `Sfx` playback. 0 or more |
| `SoundCore.voiceDuckDb` | number | core | content | how far (dB) the `Bgm` bus goes down while a voice is playing. 0 or more |
| `SoundCore.voiceDuckAttackMs` | integer | core | content | time to go down the whole `SoundCore.voiceDuckDb`. 1 or more |
| `SoundCore.voiceDuckReleaseMs` | integer | core | content | time to come back up the whole `SoundCore.voiceDuckDb`. 1 or more |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `SoundCore.<bus>_volume` | `float64` | volume of that bus. `<bus>` is `master`, `bgm`, `sfx`, `voice`, `ui` |
| `device` | `SoundCore.<bus>_mute` | `bool` | mute of that bus |
| `device` | `SoundCore.haptic_enabled` | `bool` | haptics on |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_playing` | caller buffer | count filled. Resource key, `SoundBus` and priority per `play` request in playback | `0` | `QACore`, core test |
| `get_haptic_log` | caller buffer | count filled. Resource key, whether played, and haptic target (`Device` or `Gamepad`) of the last `SoundCore.devHapticLogCount` `play_haptic` requests | `0` | `QACore` |
| `inject_focus_change` | whether the app has focus | none | none | core test |

- `inject_focus_change` does, without an engine notification, the same handling as the app losing focus for `false` and the app regaining focus for `true`

## test

- With `SoundCore.sfxPitchVariationCents` 100 and `SoundCore.sfxVolumeVariationDb` 2, 200 `Sfx` playbacks of one key have pitch scales from 2^(−100÷1200) to 2^(100÷1200) and variation gains from 10^(−2÷20) to 10^(2÷20), not all equal; `Ui` and `Voice` playbacks have pitch scale 1 and variation gain 1. With both 0, every `Sfx` playback has pitch scale 1 and variation gain 1
- With `SoundCore.sfxPitchVariationCents` 100, a `Sfx` playback whose pitch scale is below 1 and whose end the engine does not report stays playing until the length of the sound ÷ its pitch scale
- With `SoundCore.voiceDuckDb` 12, `SoundCore.voiceDuckAttackMs` 100 and `SoundCore.voiceDuckReleaseMs` 400, the duck gain of `Bgm` is −6 dB 50 ms after a `Voice` playback starts and −12 dB from 100 ms on, stays −12 dB while a second `Voice` playback continues after the first ends, and is 0 dB 400 ms after the last one ends. A game time pause that stops the `Voice` playback starts the release
- Playback that does not report its end (while page audio is stopped in a browser runtime) ends when the sound length passes; its handle becomes invalid and it leaves the playback count. Time passed while paused is not counted in the length
- Running `play` 100 times on a resource key with 3 variants never gives the same variant in two consecutive playbacks, and all three variants are played
- At volume 1, 0.5 and 0, the bus level is 0 dB, -6.02 dB (error at most 0.01) and silent
- Turning mute on for a bus with volume 0.3 makes it silent, and turning it off returns it to the level of 0.3
- Values of `set_volume`, `set_mute` and `set_haptic_enabled` are saved in `LocalDataCore` and `load_volume_settings` restores them. Out-of-range and NaN saved values become the default without a log
- In a run with the limiter, the ceiling of the `Master` limiter is set from the settings values, and when the ceiling is lowered, the output true peak for the same input is at most that value
- `play_bgm` of B while A is playing stops A after `SoundCore.bgmCrossfadeMs` and B's playback volume is 1. Calling C during the A→B crossfade stops A at once and B after its fade out, and C is the current BGM
- `play_bgm` of the same key with scope S1 and then S2 continues the playback position, keeps playing after S1 is released, and stops after S2 is released with no current BGM
- Calling C after B while B is loading does not play B
- `return_bgm` after A, B makes A the current BGM and removes the previous BGM. `return_bgm` after `stop_bgm` while A is playing plays A
- A BGM without a scope keeps playing after the scene scope is released
- After `play_bgm` of A, B and C in order without a scope, once C's crossfade ends, `ResourceCore.is_loaded` is `false` for A and `true` for B and C, and then `return_bgm` plays B. The resource of a scope-less request discarded during loading also does not stay in the cache
- A crossfade ends by real elapsed time regardless of game time pause and time scale
- For each `play` request that started playback, the `SoundPlayedEvent` of that bus comes once; there is none for a request not played because of low priority, a request given `stop` before loading, or `play_bgm`
- Under the same-key limit and the total limit, the replacement target selection matches the behavior, and a request with lower priority than the replacement target gets an invalid handle. BGM playback is not counted
- The playback count is at most `SoundCore.maxConcurrent` at every point
- `is_playing` is `true` while loading and while playing, and `false` in the frame of the end, after `stop` and after replacement
- Calling `stop` with a finished handle leaves another playback on the same player as it is
- `play` of a sound that is not loaded returns the handle at once and plays after loading. With `stop` before that, it does not play
- During game time pause, only `Sfx` and `Voice` stop, and they continue when the pause is lifted
- After `inject_focus_change(false)`, all playback and fades stop. Releasing only one of two pause tokens keeps the pause, and in the unfocused state, releasing all tokens still keeps the pause. Then after `inject_focus_change(true)`, when there is no token, playback continues from the stopped position
- A content positional player that ran `play()` during global pause and an `autoplay` player instanced during that time also make no sound until global pause ends
- A content positional player on the `Sfx` bus is silent with `Sfx` mute, stops during game time pause and global pause, and continues when they are lifted. Its playback is not in `get_playing` or `SoundPlayedEvent`
- All issued handle and token values differ until `release`
- When haptics are off, or the haptic target is `Device` on a platform without the vibration feature, `play_haptic` is `false` with no log. A new `play_haptic` during playback stops the earlier pattern
- After a gamepad button press through `InputCore.inject_device_input` makes `InputCore.get_device` `Gamepad`, `play_haptic` of a loaded haptic resource in the right format is `true` even on a platform without the `Device` vibration feature, and the haptic target in `get_haptic_log` is `Gamepad`. `play_haptic` after only `InputCore.set_test_device`(`Gamepad`) without gamepad input is `false` without a log. When `get_device` is `Touch`, the haptic target is `Device`
- `play_haptic` of a loaded haptic resource in the right format is `true` on a platform with the vibration feature and is recorded as played in `get_haptic_log`. A key that is not loaded is `false` with no SoundCore log. A file with empty `segments`, `duration_ms` 0, `intensity` 1001 or an unknown key is `false` regardless of the vibration feature, and playing the same key twice leaves one error log
- After `release` there is no player; after `init` again there is no current BGM and no previous BGM, no pause, and all volumes are 1
