# NativeUiCore

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

Opens the OS store review request window and share window with a per-platform native adapter, and copies text to the OS clipboard. The three features are OS features, so they are not external services and have no adapter key in game settings.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `UICore`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_native_adapter` | `NativeUiAdapter` or none. Called before `init` | none | none | `BootstrapCore`(`InitModules` stage) |
| `request_review` | none | `ReviewResult` | `Failed` | content code |
| `can_share` | none | whether the share window can be opened | `false` | content code |
| `capture_screen` | none | async operation. PNG bytes | empty bytes | content code |
| `share` | `ShareContent` | async operation. `ShareResult` | `Failed` | content code |
| `copy_text` | text | success flag | `false` | content code |

### type

| type | contents |
|---|---|
| `NativeUiAdapter` | `supports_review()`, `request_review()`: requests the store review request window from the OS and returns a success flag, `supports_share(has image)`, `share(text, PNG bytes)`: opens the share window, waits until it closes, and returns `ShareResult` |
| `ReviewResult` | `Requested`, `Throttled`, `Unsupported`, `Failed` |
| `ShareContent` | `text` (a sentence shown to humans. A value the caller translated), `image` (PNG bytes. Empty bytes means no image) |
| `ShareResult` | `Closed`, `Busy`, `Unsupported`, `Failed` |

## behavior

### adapter

- When there is no adapter, `request_review` is `Unsupported`, `share` is `Unsupported`, and `can_share` is `false`

| platform | review | share |
|---|---|---|
| `android` | Google Play In-App Review API | Android Sharesheet(`ACTION_SEND`) |
| `ios` | `SKStoreReviewController` | `UIActivityViewController` |
| `macos` | `SKStoreReviewController` | `NSSharingServicePicker` |
| `web` | none | Web Share API. none when the browser does not provide that API |
| `windows`, `linux` | none | none |

- For a feature that is none in the table, `supports_*` of the adapter is `false`

### store review request

- The OS decides whether to show the store review request window and how many times, and does not report the result. `Requested` means it was requested from the OS, not that the window was shown
- On `android`, the request counts as made when `request_review` of the adapter has started `requestReviewFlow` of the Google Play In-App Review API: the adapter reports success then, so the result is `Requested` and `NativeUiCore.last_review_at` is saved. The adapter reports a failure only when it cannot start `requestReviewFlow`. A failure of `requestReviewFlow` or of `launchReviewFlow` after that is not reported, leaves no log and changes nothing, so `NativeUiCore.reviewMinIntervalMs` still applies to the next request
- On `ios`, the adapter reports a failure only when `UIApplication.connectedScenes` holds no `UIWindowScene`. On `macos`, it does not report a failure
- `request_review` processing order
  1. `Unsupported` when there is no adapter or `supports_review` is `false`
  2. `Throttled` when `NativeUiCore.last_review_at` of the `device` file exists and the current device time minus it is less than `NativeUiCore.reviewMinIntervalMs`
  3. `Throttled` when it already returned `Requested` in this boot
  4. Calls `request_review` of the adapter. When it reports a failure, nothing is saved and the result is `Failed`. On success, it saves the current device time to `NativeUiCore.last_review_at` and the result is `Requested`
- Content code calls it only on the result screen of a stage clear, level up, reward claim. It does not call it during a tutorial, during a purchase flow, or while a popup is open
- No core screen is made to replace the store review request window

### share

- `share` processing order
  1. `Busy` when a `share` is in progress
  2. `Failed` when `text` is an empty string and `image` is empty bytes
  3. `Unsupported` when there is no adapter or `supports_share`(whether there is an image) is `false`
  4. `Failed` when the number of Unicode code points of `text` is more than `NativeUiCore.shareTextMaxChars` or `image` is more than `NativeUiCore.shareImageMaxBytes`
  5. Waits for `share` of the adapter and returns its result
- `Closed` means the share window closed. Whether the user shared cannot be known. No reward depends on whether the user shared
- `can_share` is whether there is an adapter and `supports_share(false)` is `true`
- The app can go to the background while the share window is open. `share` returns after the share window closes and the app comes back to the foreground

### screen capture

- `capture_screen` waits until the engine has fully drawn the next frame and returns that frame at the window resolution as PNG. `capture_screen` calls made while one waits return the same frame. The `Debug` layer of `UICore` is not in the image, and after a capture returns it has the visibility it had before
- Content code hides the UI to leave out of the screen before calling it
- In a headless run of `QACore`, it returns empty bytes without waiting for a frame and without hiding the `Debug` layer. NativeUiCore reads whether it is headless from the engine without calling `QACore`. The method is in the engine-specific implementation rules

### clipboard

- `copy_text` puts the text on the OS clipboard. It does not use the adapter and uses the engine's clipboard feature. The engine mapping is in the engine-specific implementation rules
- When the text is an empty string, the engine does not provide a clipboard on that platform, or it is a headless run of `QACore`, it does not change the clipboard and is `false`. Otherwise it is `true`
- `copy_text` is synchronous, so when the platform refuses the write later, it is still `true`

### release

- Ends a `share` in progress with `Failed` and every `capture_screen` that has not returned with empty bytes, and deletes the adapter. The `Debug` layer gets back the visibility it had before the capture. Saved values are not deleted

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| `request_review`, `share` of the adapter report a failure | `Failed` | error |
| text length or image size exceeded in `share` | `Failed` | error |
| the text of `share` is an empty string and there is no image either | `Failed` | error |
| `capture_screen` failure, headless run | empty bytes | error. warn for a headless run |
| `Unsupported`, `Throttled`, `Busy` | each result | none |
| `set_native_adapter` after `init` | ignored. The adapter stays the same | error |
| empty text in `copy_text` | `false` | error |
| `copy_text` of text that is not empty on a platform without a clipboard or in a headless run | `false` | warn |
| `share` in progress, or `capture_screen` that has not returned, at `release` | `Failed` for `share`, empty bytes for `capture_screen` | none |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `NativeUiCore.reviewMinIntervalMs` | integer | core | content | minimum duration from the previous `Requested` to the next store review request |
| `NativeUiCore.shareTextMaxChars` | integer | core | content | max number of Unicode code points of the share text |
| `NativeUiCore.shareImageMaxBytes` | integer | core | content | max bytes of the share image |

## data

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `device` | `NativeUiCore.last_review_at` | `int64` | device time (Unix ms) of the last store review request |

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `get_fake_record` | none | `review_count`, `share_count` of the fake adapter, `text` and image byte count of the last share | a value whose `review_count`, `share_count`, image byte count are 0 and whose `text` is an empty string | core test |
| `set_fake_share_result` | `ShareResult` | none | none | core test |
| `set_fake_review_result` | success flag | none | none | core test |

- fake adapter: supports review and share. `request_review` increases `review_count` by 1 and returns the value of `set_fake_review_result` (default `true`). `share` records the received content and returns the value of `set_fake_share_result` (default `Closed`) in the next frame. It does not show a screen
- STG and PROD builds do not have the fake adapter and the operations above

## test

- When there is no adapter, `request_review` and `share` are `Unsupported` with no log
- The first `request_review` is `Requested` and `last_review_at` is saved, and the second in the same boot is `Throttled`. In a new boot before `reviewMinIntervalMs` passes it is also `Throttled`, and after it passes it is `Requested`. In a new boot whose device time is earlier than `last_review_at` by more than `reviewMinIntervalMs`, it is `Throttled`
- After `set_fake_review_result`(`false`), `request_review` gives `Failed` and an error log and `last_review_at` is not saved, and after `set_fake_review_result`(`true`), `request_review` in the same boot is `Requested`
- When a `share` is in progress, a second `share` is `Busy` and the first `share` ends with the fake result
- Text length exceeded, image size exceeded, and empty text with an empty image give `Failed` and an error log, and the adapter is not called
- `share` of text that ends with a character outside the BMP and whose number of Unicode code points is `shareTextMaxChars` goes to the adapter, and `share` of that text with one more character outside the BMP gives `Failed` and an error log
- Even without an adapter, `share` of empty text and an empty image gives `Failed` and an error log
- The PNG size of `capture_screen` equals the window resolution and there are no elements of the `Debug` layer. Two `capture_screen` calls in the same frame return the same bytes. When `capture_screen` returns, the `Debug` layer has the visibility it had before the call. In a headless run, `capture_screen` returns empty bytes with one warn log and leaves the visibility of the `Debug` layer as it is
- `get_fake_record` of the fake adapter returns the text and image byte count passed to `share`
- A `share` during `release` ends with `Failed` without a log, and after `init` again there is no adapter. In a run that is not a headless run, a `capture_screen` called right before `release` returns empty bytes without a log
- `set_native_adapter` after `init` leaves an error log and does not change the adapter
- In a run that is not a headless run on a platform that provides a clipboard, `copy_text`(`12345`) is `true` and the text of the engine clipboard is `12345`. Empty text gives `false` and an error log, and the clipboard stays the same. In a headless run `copy_text`(`12345`) gives `false` and a warn log, and empty text gives `false` and an error log without a warn log
