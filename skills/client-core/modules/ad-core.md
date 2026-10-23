# AdCore

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

Shows rewarded ads, interstitial ads and banner ads through the ads SDK. The server `ads-reward` module verifies and grants the reward of a rewarded ad with a ticket and the ad network callback; AdCore gets the ticket and fetches the grant result.

## dependency

`LogCore`, `EventCore`, `TimeCore`, `LocalDataCore`, `DataCore`, `NetworkCore`, `UserStateCore`, `AuthCore`, `SoundCore`, `InputBlockCore`

- server dependency: `ads-reward`
- optional dependency: `PaymentCore`. Used only for the `suppress_if_product` judgement. When it is not in the module list, AdCore does not block by `suppress_if_product`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_ads_adapter` | ads adapter, ad unit list | none | none | `BootstrapCore`(`InitModules`) |
| `start` | none | async operation. success flag | `false` | `BootstrapCore`(`AfterLogin`) |
| `preload` | placement ID value | none | none | content code |
| `get_ready_state` | placement ID value | `AdReadyState` | `NotReady` | content code |
| `can_show` | placement ID value | whether the interstitial ad passes the pacing judgement | `false` | content code |
| `show` | placement ID value | async operation. `AdShowResult` | `Failed` | content code |
| `show_banner` | placement ID value | none | none | content code |
| `hide_banner` | none | none | none | content code |
| `is_ad_privacy_options_required` | none | whether an entry to change ads consent is needed | `false` | content code |
| `open_ad_privacy_options` | none | async operation. whether the ads consent change screen was opened | `false` | content code |

- `set_ads_adapter` is called before `init`. A call after `init` leaves an error log and is ignored
- ad unit list: the list from placement ID value to ad unit ID. `BootstrapCore` passes build info `ad_units`
- `AdReadyState`: `NotReady`(not loaded, load failed, or used by `show`), `Loading`, `Ready`, `LimitReached`(the grant count of the rewarded ad reached `limit_count`. Set by the limit judgement of `preload` or by `AD_LIMIT_REACHED` of `BeginAdReward` in `show`), `Unsupported`(no ads adapter)
- `AdShowResult`

  | element | meaning |
  |---|---|
  | `Completed` | the interstitial ad closed. Or the reward condition of the rewarded ad was met and `ClaimAdReward` succeeded |
  | `RewardPending` | the reward condition of the rewarded ad was met, but `ClaimAdReward` ended with `AD_REWARD_PENDING` or a communication failure. The reward comes as the UserState delta of a later response |
  | `Aborted` | the rewarded ad closed before the reward condition was met. Interstitial ads do not have it |
  | `NotReady` | not shown, because the ready state was not `Ready` or `BeginAdReward` of the rewarded ad ended with `AD_LIMIT_REACHED` |
  | `Paced` | the interstitial ad was not shown, because the pacing judgement blocked it |
  | `Unsupported` | there is no ads adapter |
  | `Failed` | a check blocked it, `BeginAdReward` ended with a failure other than `AD_LIMIT_REACHED`, the ads SDK could not show the ad, `ClaimAdReward` ended with another error, or `release` stopped it |

## behavior

### ads adapter

The ads adapter wraps the ads SDK. Handling that differs per ads SDK is only inside the ads adapter. Code outside AdCore does not call the ads adapter.

| adapter operation | input | output |
|---|---|---|
| `request_ad_consent` | none | async operation. `required`(whether the region requires ads consent), `personalized`(whether the user agreed to personalization on the ads consent screen). When a consent screen is needed, it shows it and waits until it closes |
| `is_privacy_options_required` | none | whether an entry to change ads consent is needed |
| `show_privacy_options` | none | async operation. whether the ads consent change screen was opened |
| `initialize` | ad consent | async operation. success flag |
| `load` | ad type, unit ID, ad consent | async operation. success flag |
| `present` | ad type, unit ID, verification value(rewarded only) | async operation. One of `Completed`, `Aborted`, `Failed`. An interstitial ad is `Completed` when it closes after being shown, and `Aborted` is never returned for it |
| `open_banner` | unit ID, ad consent | async operation. success flag |
| `close_banner` | none | none |

- ad consent: `ad_personalization_allowed`(whether ad personalization is allowed), `child`(whether it is child-directed), `below_consent_age`(whether the user is below the consent age). AdCore makes it with `AuthCore.get_consent` at each call. The adapter passes these values to the ads SDK as request parameters
- verification value: the user ID and the reward notify ID. In `present`, the adapter puts them in the server-side verification custom data of the loaded rewarded ad and then shows it
- AdCore defines the adapter key `ads` and the selection criteria below, and `BootstrapCore` chooses by the `ads` value of build info `adapters` and passes the adapter with `set_ads_adapter`

  | value | platform `ios`, `android` | other platforms |
  |---|---|---|
  | `fake` | fake adapter | fake adapter |
  | `ads-admob` | `admob` adapter | none |
  | no key | none | none |

  The callback `<network>` of server `ads-reward` is the provider name of this value (`admob`)
- The build puts the app ID of the `admob` adapter in the app ID item of the ads SDK (build-time check `admob` of [`build`](../../build/SKILL.md)). AdCore does not pass it to the adapter
- `request_ad_consent`, `is_privacy_options_required` and `show_privacy_options` of the `admob` adapter use the Google UMP SDK (a Google-certified CMP). UMP does the region judgement and the consent screen, and UMP saves the consent result in IAB TCF format, which the ads SDK reads. `required` is whether the region is one where UMP requires consent; `personalized` is whether the saved TCF consent has the Google vendor consent and consent to purposes 1, 3 and 4
- The unit ID is the value of that placement in the ad unit list, and an empty string when the list has none. The unit ID of the fake adapter is the decimal string of the placement ID value
- In `release` the adapter discards all loaded ads. When it receives `initialize` several times in one process, it does not initialize the ads SDK again and succeeds

### start

- `BootstrapCore` calls it after login and does not wait for it. It first does `request_ad_consent` of the adapter; when `required` is `true`, it waits for `AuthCore.report_ad_consent`(`personalized`) and then calls `initialize`. A failure of `request_ad_consent` leaves a warn log, and a failure of `report_ad_consent` continues without a log. When `initialize` succeeds, AdCore enters the started state
- When there is no ads adapter, it calls no adapter and returns `true`. In the started state, it does not call `request_ad_consent` and `initialize` and returns `true`. When a `start` is in progress, it returns that result
- When `preload` and `show_banner` pass the placement check and AdCore is not in the started state, they call `start` and wait for its result before calling the adapter. When a `start` is in progress, they get its result; when the previous `start` ended with `false`, they get the result of a `start` called again. When the result is `false`, `preload` sets the ready state to `NotReady`, and `show_banner` ends without a banner. `start` leaves the log
- `is_ad_privacy_options_required`: `false` when there is no ads adapter or AdCore is not in the started state, otherwise `is_privacy_options_required` of the adapter. When `true`, content code puts an ads consent change entry on the screen
- `open_ad_privacy_options`: `false` when there is no ads adapter or AdCore is not in the started state. It waits for `show_privacy_options`, then does `request_ad_consent` again, and when `required` is `true` it waits for `AuthCore.report_ad_consent`(`personalized`). It returns the result of `show_privacy_options`

### placement check

`preload`, `get_ready_state`, `can_show`, `show` and `show_banner` first check the following in order, and stop when one blocks.

| order | blocked when | log | result |
|---|---|---|---|
| 1 | there is no ads adapter | none | `Unsupported`. `can_show` is `false`, and an operation without output does nothing |
| 2 | `start` has not been called since `init`. Not checked for `get_ready_state` and `can_show` | error | failure value |
| 3 | the placement is not in `ad_placement` | error | failure value |
| 4 | the ad type does not match the operation. `show_banner` takes `Banner`, `can_show` takes `Interstitial`, the others take `Rewarded` or `Interstitial` | error | failure value |
| 5 | the unit ID is an empty string | error | failure value |

### preload

- When the ready state is `Loading` or `Ready`, it does nothing. For a rewarded ad when not logged in (`AuthCore.is_logged_in`), it leaves an error log and ends without changing the ready state. Otherwise it does the following. The caller does not wait
- limit judgement: for a rewarded ad, when `limit_count` of that placement row is not `null` and `UserStateCore.get_ad_reward_count`(placement ID value) is `limit_count` or more, it sets `LimitReached` and does not call `load`
- Otherwise it sets `Loading` and calls adapter `load`. `preload` sends no request
- A `load` success gives `Ready`; a failure gives `NotReady` and a warn log. AdCore does not retry a failed load

### show

1. For a rewarded ad when not logged in, `Failed`
2. When another `show` is in progress, `Failed`. Otherwise, for an interstitial ad it does the pacing judgement, and when blocked, `Paced`
3. When the ready state is not `Ready`, it leaves a warn log and returns `NotReady`
4. Sets a pause with `SoundCore.request_pause`
5. With `InputBlockCore.run_blocked`(reason tag `ad`), it waits for the two tasks below in turn. There is no pass list. `BeginAdReward` is a core rpc with the silent option, so it opens no system popup even when it fails, and during `present` the full-screen view shown by the ads adapter covers the game screen, so a system popup opened below it is not visible
   - For a rewarded ad, it first sends `SilentRetry` core rpc `BeginAdReward`(placement ID value) with `NetworkCore.send` and gets the reward notify ID issued by the server from `notify_id` of the response. The failure callback returns `true`. When it fails, it does not call `present`
   - Then it calls `present`, and for a rewarded ad it passes the verification value (the current user ID, the received reward notify ID)
6. Releases the pause with `SoundCore.release_pause`. It releases it whatever the result of `present`
7. When `BeginAdReward` failed in 5, it skips 8 to 11. With `AD_LIMIT_REACHED` it sets the ready state to `LimitReached` and returns `NotReady`; with another failure it returns `Failed` without changing the ready state
8. Sets the ready state to `NotReady`. For an interstitial ad, it saves 0 as the opportunity count of that placement and `TimeCore.get_server_time` as the last interstitial time
9. For a rewarded ad whose `present` is `Completed`, it sends `ClaimAdReward` with the reward notify ID from 5 and waits. The failure callback returns `true`
10. Does `preload` of the same placement
11. When it sent `ClaimAdReward` in 9, it returns the `show` result that matches that result; otherwise it returns the result of `present` as the element with the same name. When `present` of an interstitial ad is `Aborted`, it leaves an error log and returns `Completed`

| `ClaimAdReward` result | `show` result |
|---|---|
| success | `Completed` |
| `AD_REWARD_PENDING`, communication failure (after all retries are used), `NetworkCore.send` that ended with `false` without the failure callback (e.g. a delta rejected in response processing) | `RewardPending` |
| other error | `Failed` |

- The server grants the reward. The server-side verification callback of the ads SDK goes to server `ads-reward`, and the response of `ClaimAdReward` brings the granted UserState delta. `ClaimAdReward` is a core rpc with the silent and retry options
- Content code does not grant rewards or change UserState from `AdShowResult`
- The reward notify ID is not passed to content code
- The only requests AdCore sends are `BeginAdReward` and `ClaimAdReward`. The contract has no request in which the client reports a completed view to get a reward
- AdCore does not display results on screen and does not stop game time. It does not limit the frequency of rewarded ads. Server `ads-reward` applies the grant count limit with `ad_placement`

### pacing

- One `show` of an interstitial ad is one opportunity of that placement. The pacing judgement adds 1 to the opportunity count of that placement, saves it, and then checks whether one of the following blocks it. When blocked, it does not show the ad and leaves no log
  1. `suppress_if_product` is not an empty array, `PaymentCore` is in the module list, and a product in `suppress_if_product` has `PaymentCore.is_owned` `true`
  2. `first_show_after` is set, and `UserStateCore.get_user_created_at` is 0 or `TimeCore.is_reached`(user creation time + `first_show_after`) is `false`
  3. `min_interval` is set, the last interstitial time is not 0, and `TimeCore.is_reached`(last interstitial time + `min_interval`) is `false`
  4. `every_n` is set and opportunity count < `every_n`
- `can_show` does the same judgement with opportunity count + 1 on an interstitial placement that passed the placement check, and changes nothing. When nothing blocks, it is `true`. It does not look at the ready state
- The opportunity count and the last interstitial time are kept in the `user` file of `LocalDataCore`. All interstitial placements share the last interstitial time. After `init` and before `start` is called, both count as 0, and AdCore does not read or write `LocalDataCore`
- When reading `AdCore.opportunity_count`, elements not in the `<placement ID value>=<count>` format or with a negative count, and elements with the same placement ID value as a previous element, are discarded with a warn log. The opportunity count of a placement without an element is 0
- When pacing judgement 1 blocks, `show_banner` does not open the banner and closes the shown banner of that placement
- Rewarded ads have no pacing

### banner

- One banner is shown at a time. When the banner of the same placement is shown, it does nothing; when the banner of another placement is shown, it calls `close_banner` and then `open_banner`
- A failure of `open_banner` is a warn log, and the shown banner is gone. When another `show_banner` or `hide_banner` was called in the meantime, it discards the late result. A `show_banner` waiting for `start` also does not call `open_banner` when another `show_banner` or `hide_banner` was called in the meantime
- `hide_banner` does nothing when no banner is shown
- A banner sets no block and does not stop sound. The area a banner covers is not applied to the game area and the safe area. Scene transitions and popups do not change the banner

### lifecycle

- `release`: releases the pause of a `show` in progress, calls `close_banner` for a shown banner, and deletes the ready state, the started state and whether `start` was called. A `run_blocked` in progress is released by the rules of `InputBlockCore`
- Results of adapter operations that end after `release` are discarded. A `show` in progress ends with `Failed` and does not send `ClaimAdReward`
- AdCore does not block or change entering and returning from background during `show`

### real adapter

| adapter key | real adapter |
|---|---|
| `ads` | `ads-admob` |

### collected data

| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |
|---|---|---|---|---|---|---|---|---|---|
| `device_id` | advertising ID | `ads-admob` | `third_party_advertising`, `analytics`, `fraud_prevention` | `false` | `true` | `true` | `false` | `android`, `ios` | `none` |
| `advertising_data` | ad impressions and reactions to ads | `ads-admob` | `third_party_advertising`, `analytics` | `false` | `true` | `true` | `false` | `android`, `ios` | `none` |
| `product_interaction` | app launches and ad screen interactions | `ads-admob` | `third_party_advertising`, `analytics` | `false` | `true` | `true` | `false` | `android`, `ios` | `none` |
| `crash_data` | crash records of the ads SDK | `ads-admob` | `analytics` | `false` | `false` | `true` | `false` | `android`, `ios` | `none` |
| `performance_data` | performance records of the ads SDK | `ads-admob` | `analytics` | `false` | `false` | `true` | `false` | `android`, `ios` | `none` |
| `coarse_location` | approximate location derived from the IP address | `ads-admob` | `third_party_advertising`, `analytics`, `fraud_prevention` | `false` | `true` | `true` | `false` | `android`, `ios` | `none` |

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| blocked by placement check 2 to 5 | failure value of the operation | error |
| `preload` of a rewarded ad when not logged in | none. The ready state does not change, and there is no `load` | error |
| `BeginAdReward` of `show` fails | with `AD_LIMIT_REACHED`, `NotReady` and the ready state set to `LimitReached`; otherwise `Failed`. There is no `present` | `NetworkCore` leaves it |
| `preload` of a rewarded ad blocked by the limit judgement | none. Sets the ready state to `LimitReached`, and there is no `load` | none |
| `show` of a rewarded ad before login, another `show` in progress | `Failed` | error |
| `initialize` fails | `false` | error |
| `request_ad_consent` fails | continues | warn |
| `report_ad_consent` fails | continues | `AuthCore` or `NetworkCore` leaves it |
| `open_ad_privacy_options` without an ads adapter or before the started state | `false` | none |
| `present` is `Failed` | `Failed` | error |
| `present` of an interstitial ad is `Aborted` | `Completed` | error |
| `run_blocked` could not set a block | `Failed`. Releases the pause | `InputBlockCore` leaves it |
| `ClaimAdReward` fails | result in the show table | `NetworkCore` leaves it |
| `set_ads_adapter` called after `init` | none | error |
| element of `AdCore.opportunity_count` with a wrong format, a negative count, or the same placement ID value as a previous element | discards that element | warn |

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `AdCore.fakePresentMs` | integer | core | content | duration for which the fake adapter shows an ad |
| `AdCore.sdkCallTimeoutMs` | integer | core | content | time limit of ads SDK `initialize`, `load`, `open_banner`. When it is exceeded, that call fails. `request_ad_consent`, `show_privacy_options` and `present`, which wait for the user, have no time limit. 1 or more |
| `TimeCore.reachMarginMs` | integer | core | content | ms added to the reach judgement of `TimeCore`. Used for the expected times of tests |

## data

used table: `ad_placement`

- Reads `id`, `type`(`enum<AdType>`), `limit_count`, `min_interval`, `first_show_after`, `every_n`, `suppress_if_product` of the `ad_placement` table, whose header server `ads-reward` defines. `limit_count` is used only for the limit judgement of `preload`. It does not read the reward contents (`reward`, `extra_grant`) or `reset`
- Server `ads-reward` defines enum `AdType`(`Rewarded`, `Interstitial`, `Banner`)

reserved ID, reserved string, reserved sound: none

`LocalDataCore` key

| file kind | key | type | meaning |
|---|---|---|---|
| `user` | `AdCore.last_interstitial_at` | `int64` | server time when an interstitial ad was last shown. 0 when there is none |
| `user` | `AdCore.opportunity_count` | `array<string>` | opportunity count per placement since an ad was last shown there. An element is `<placement ID value>=<count>`, and the count is a decimal integer |

## DEV

- `present` of the fake adapter shows an opaque solid-color rectangle made in code over the whole screen for `AdCore.fakePresentMs` and then ends with `Completed`. It has no text
- A rewarded `present` of the fake adapter, before it ends with `Completed`, sends core cheat `FakeAdCallback` with the reward notify ID of the verification value by `NetworkCore.send_cheat` and waits for the result. Server `ads-reward` handles this in place of the ad network callback

| operation | input | output | caller |
|---|---|---|---|
| `fake_set_next_present_result` | one of `Completed`, `Aborted`, `Failed` | none. Used for the next single `present` | core test |
| `fake_set_fail` | adapter operation name, fail flag | none | core test |
| `fake_skip_callback` | none | none. The next rewarded `present` does not send `FakeAdCallback` | core test |
| `fake_delay_callback` | none | none. The next rewarded `present` does not send `FakeAdCallback`, and the first rewarded `load` received after that sends `FakeAdCallback` with the reward notify ID of the skipped `present` and waits for the result | core test |
| `fake_set_ad_consent` | `required`, `personalized`, whether privacy options are required | none. The values that `request_ad_consent` and `is_privacy_options_required` of the fake adapter return. When they are not set, all three are `false` | core test |

## test

- During `present` there is one active block with reason tag `ad` and one sound pause of AdCore, and when `show` returns there are neither
- `show` of an interstitial ad whose `present` is `Completed` or `Failed` returns the element with the same name, and with `Aborted` gives an error log and `Completed`. `show` of a rewarded ad whose `present` is `Aborted` is `Aborted`
- When the ready state is not `Ready`, the result is `NotReady` without `present`, block or pause
- Without an ads adapter, `start` is `true`, `get_ready_state` and `show` are `Unsupported`, and `preload`, `show_banner`, `hide_banner` do not call the adapter and leave no log
- For each of placement check 2 to 5, a rewarded ad before login and a `show` in progress, the result and log are as in the table, and `load`, `present`, `open_banner` are not called
- When `start` is called twice concurrently, `initialize` is called once and both results are the same
- `preload` and `show_banner` while `start` is in progress call `load` and `open_banner` after `start` ends, without an error log
- `preload` after `initialize` failed calls `initialize` again, and on success calls `load`. When it fails again, the ready state is `NotReady` without `load`, and the only log is the error of the `initialize` failure
- `preload` before `start` is called gives an error log and does not call `initialize`
- Right after `preload` the ready state is `Loading`, after a `load` success `Ready`, after a failure `NotReady` with a warn log. In `Loading` and `Ready`, `preload` does not call `load`
- `preload` of a rewarded placement in `NotReady` when not logged in leaves an error log; after that `get_ready_state` is `NotReady` and there is no `load`
- When a `show` that reached `present` returns, the same placement is `Loading`. Except: when `ClaimAdReward` of the rewarded ad made `get_ad_reward_count` reach `limit_count`, it is `LimitReached`. For a rewarded ad, `load` is called after `ClaimAdReward` ends
- `preload` sends no request. `show` of a rewarded ad sends one `BeginAdReward` after checking the ready state and before `present`, and the verification value `present` receives is the current user ID and the reward notify ID of that response. While waiting for `BeginAdReward`, there is a block with reason tag `ad` and a sound pause of AdCore. `show` of an interstitial ad has no request, and its `present` has no verification value
- When `BeginAdReward` of `show` is `AD_LIMIT_REACHED`, the result is `NotReady` without `present`, the ready state is `LimitReached`, and nothing is displayed on screen. With another failure, the result is `Failed` without `present`, and the ready state is `Ready`. In both cases there is no block and no pause when `show` returns
- `preload` of a rewarded placement with `limit_count` set and `UserStateCore.get_ad_reward_count` equal to `limit_count` is `LimitReached` without `load` and request, and `preload` from `reset_at` of that grant count + `TimeCore.reachMarginMs` calls `load`
- When `present` of a rewarded ad is `Completed`, one `ClaimAdReward` goes before `show` returns, and its reward notify ID is the value of the `BeginAdReward` response of that `show`. For each result, the `show` result is as in the show table
- In `show` of an interstitial ad, of a rewarded ad that is not `Completed`, and of a banner, there is no `ClaimAdReward`
- The ad consent that `initialize`, `load`, `open_banner` receive matches `AuthCore.get_consent` at that call by the rules of behavior
- `start` calls `request_ad_consent` before `initialize`, and when `required` is `true` calls `AuthCore.report_ad_consent` once with that `personalized`. When `required` is `false`, it does not call it. Even when `request_ad_consent` fails, it calls `initialize`
- `open_ad_privacy_options` calls `request_ad_consent` and `report_ad_consent` again after `show_privacy_options`. Before the started state, it does not call the adapter and is `false`
- With the fake adapter and the server fake adapter, `show` of a rewarded ad is `Completed` and the grant delta is applied
- After `fake_delay_callback`, `show` of a rewarded ad is `RewardPending`, and the grant of the `FakeAdCallback` sent at the next `load` is applied as the pending delta of a later response
- While banner A is shown, `show_banner` of A does not call the adapter, and `show_banner` of B is `close_banner` then `open_banner`. No block or pause is created
- When B opens while `open_banner` of A is waiting and A then fails, B stays shown. An `open_banner` that succeeds late after `hide_banner` does not create the banner again
- `release` during `present` gives `show` `Failed`, no `ClaimAdReward`, no pause, no block, and one `close_banner`. After `init` again, every placement is `NotReady` and `start` calls `initialize` once
- Of three `show` calls on a placement with `every_n` 3, the first two are `Paced` without `present` and the third reaches `present`. `can_show` before the third `show` is `true`, and before the first two it is `false`
- `can_show` before `start` judges with opportunity count and last interstitial time 0, there is no error log of `LocalDataCore`, and the `user` file does not change
- The second interstitial `show` within `min_interval` is `Paced`, and one passes from last interstitial time + `min_interval` + `TimeCore.reachMarginMs`
- An interstitial `show` before user creation time + `first_show_after` + `TimeCore.reachMarginMs` is `Paced`
- On a placement whose `suppress_if_product` has two products, even when only the second product has `PaymentCore.is_owned` `true`, interstitial `show` is `Paced` and `show_banner` does not call `open_banner`. When both products are `false`, that does not make it `Paced`
- When `PaymentCore` is not in the module list, an interstitial `show` whose `suppress_if_product` is not an empty array is not `Paced` by it, and `show_banner` calls `open_banner`
- After `release` and `init`, the opportunity count and the last interstitial time carry on from the `user` file
- With a `user` file whose `AdCore.opportunity_count` is `["5=2", "5=7", "x", "6=-1"]`, after `start` the opportunity count of placement 5 is 2 and of placement 6 is 0, and there are three warn logs
- The unit ID that `load`, `present`, `open_banner` of a non-fake ads adapter receive is the value of that placement in the ad unit list. A placement not in the list gives the error log and failure value of placement check 5, and the adapter is not called
