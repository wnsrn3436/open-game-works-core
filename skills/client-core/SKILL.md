---
name: client-core
description: Holds the list of client core modules, the spec per module, and the implementation rules per engine. Read when making, fixing or reviewing client core, and when looking up a core module's spec before client content code uses that module
---

# client core

The common rules (spec format, lifecycle, hook, event, error handling, core settings) follow [`core`](../core/SKILL.md).

## module

| module | spec | role |
|---|---|---|
| `UtilCore` | [util-core](modules/util-core.md) | string, math, collection, big integer, random(PCG32), general-purpose state machine. No state |
| `LogCore` | [log-core](modules/log-core.md) | diagnostic log, sending error logs and analytics events to the server |
| `EventCore` | [event-core](modules/event-core.md) | publishing of and subscription to core events and content events |
| `TimeCore` | [time-core](modules/time-core.md) | server time estimation, game day and reset period boundaries, game time, pause, entering and returning from background, DEV step mode |
| `LocalDataCore` | [local-data-core](modules/local-data-core.md) | save on the device |
| `ResourceCore` | [resource-core](modules/resource-core.md) | loading resources by resource key, scope of loaded resources, bundle |
| `PoolCore` | [pool-core](modules/pool-core.md) | object pool |
| `DataCore` | [data-core](modules/data-core.md) | loading built data, table lookup, derived containers |
| `LocalizationCore` | [localization-core](modules/localization-core.md) | translation lookup, format argument conversion, input prompt token conversion, font per language |
| `SoundCore` | [sound-core](modules/sound-core.md) | bus, BGM, sound effect, haptic pattern |
| `NetworkCore` | [network-core](modules/network-core.md) | server request, retry, failure handling, UserState delta delivery |
| `UserStateCore` | [user-state-core](modules/user-state-core.md) | UserState cache, delta apply, change hooks and events, the same calculations as the server (recovery item, group item, timed item, big item, counts and progress with reset, reset counter, attendance, live event round, offer) |
| `AuthCore` | [auth-core](modules/auth-core.md) | guest login, dev login, social login, token storage and refresh, consent to terms screen flow, web account deletion code |
| `PushCore` | [push-core](modules/push-core.md) | push permission, device token registration, local push |
| `PaymentCore` | [payment-core](modules/payment-core.md) | store purchase flow, receipt delivery, recovery of incomplete purchases, product ownership, pass and daily reward |
| `AdCore` | [ad-core](modules/ad-core.md) | ads display, reward flow, interstitial pacing |
| `RequirementCore` | [requirement-core](modules/requirement-core.md) | judgement of conditions defined in data |
| `ResolutionCore` | [resolution-core](modules/resolution-core.md) | base resolution, maximum resolution, game area |
| `SafeAreaCore` | [safe-area-core](modules/safe-area-core.md) | safe area, keyboard area |
| `InputCore` | [input-core](modules/input-core.md) | input action, key and gamepad button binding, gesture, input prompt, gamepad family |
| `InputBlockCore` | [input-block-core](modules/input-block-core.md) | acquiring and releasing blocks, the pass flag that decides whether an input passes the active blocks |
| `VirtualPadCore` | [virtual-pad-core](modules/virtual-pad-core.md) | virtual joystick and button |
| `TweenCore` | [tween-core](modules/tween-core.md) | tween, tween preset |
| `CameraCore` | [camera-core](modules/camera-core.md) | follow, camera shake, zoom, screen bounds |
| `ScreenEffectCore` | [screen-effect-core](modules/screen-effect-core.md) | screen color overlay, fade, flash |
| `UICore` | [ui-core](modules/ui-core.md) | panel, popup, back input, focus, keyboard shift, UI layer, license screen |
| `MessageCore` | [message-core](modules/message-core.md) | toast, black box message |
| `BadgeCore` | [badge-core](modules/badge-core.md) | badges (dot or number) for new items and rewards to claim, propagation to parent menus |
| `ShortcutCore` | [shortcut-core](modules/shortcut-core.md) | screen navigation defined in data |
| `SceneCore` | [scene-core](modules/scene-core.md) | scene transition, loading screen |
| `CutsceneCore` | [cutscene-core](modules/cutscene-core.md) | cutscene, line progress, line voice, conditional branch, choice, skip, line history |
| `TutorialCore` | [tutorial-core](modules/tutorial-core.md) | tutorial step progress, screen highlight, hand pointer display, input restriction, progress save and resume |
| `RealtimeCore` | [realtime-core](modules/realtime-core.md) | matching, room and party, P2P connection, sending and receiving realtime message bytes, DEV lockstep. The transport can be replaced |
| `GameUpdateCore` | [game-update-core](modules/game-update-core.md) | app, data, translation, bundle update |
| `BootstrapCore` | [bootstrap-core](modules/bootstrap-core.md) | boot order, content initialization hook, fatal error, restart |
| `QualityCore` | [quality-core](modules/quality-core.md) | graphics quality level, render scale, shadow, effect density, frame limit |
| `AccessibilityCore` | [accessibility-core](modules/accessibility-core.md) | text scale, color mode, voice subtitles, reduce shake, reduce flash |
| `NativeUiCore` | [native-ui-core](modules/native-ui-core.md) | the OS store review request window, share window, clipboard |
| `NoticeCore` | [notice-core](modules/notice-core.md) | receiving server notices and banners, maintenance notice |
| `ChatCore` | [chat-core](modules/chat-core.md) | chat channel list, message polling and cache of watched channels, getting earlier messages, sending, read seq and unread badge |
| `RemoteConfigCore` | [remote-config-core](modules/remote-config-core.md) | receiving the server's config values, feature flags and experiment group assignment |
| `QACore` | [qa-core](modules/qa-core.md) | debug screen, cheat, automation channel, bot connection (headless run, input injection). DEV code |
| `UnitTestCore` | [unit-test-core](modules/unit-test-core.md) | conventions and running of core tests and client regression tests |

## time limit

- Time limits in client core specs are measured with the real elapsed time of `TimeCore`. A time limit is a duration: when the awaited work does not end within it, the work counts as a failure. e.g. `NetworkCore.requestTimeoutMs`, `PaymentCore.storeCallTimeoutMs`, `PushCore.deviceTokenTimeoutMs`, `GameUpdateCore.stallTimeoutMs`
- A limit for which the spec separately defines the duration to measure follows that definition. e.g. the block elapsed time of `InputBlockCore`

## engine

| engine | implementation rules |
|---|---|
| Godot | [godot](engines/godot.md) |

- The implementation rules per engine map the operations, hooks, events and failure values of the specs to the names, types and way of running of that engine. They add no behavior that is not in the spec
- `### generated code` of the implementation rules per engine sets the client core type names. The client core type names are the set of client core names that the contract tool and the data tool check for collisions with generated type names
- When a module chooses its behavior by platform, the platform is the build info `platform` that `BootstrapCore` set in `InitModules` 1. The platform is not determined directly from the OS. How other modules read that value is set by the implementation rules per engine
- When a module chooses its behavior by whether the build contains DEV code, the judgement is whether the build has the DEV entry of `BootstrapCore`. How other modules read that value is set by the implementation rules per engine
- Object destruction in the specs and the way to detect it are set by the implementation rules per engine. When the engine has no object destruction or no notification of it (e.g. Three.js), those rules set a core destroy function, and core code and content code destroy objects only with that function. The static check `object destroy` blocks violations
- The client core implementation is kept in `open-game-works-core-impl/client/<engine>/`
