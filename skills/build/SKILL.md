---
name: build
description: Covers the procedure of the `build` command (hardening, hardening record, one pass of game-loop iteration steps 2 to 6 with PostgreSQL, build-time check, per-platform build and signing, server image, tag, DEV and STG deploy), bundle patch, backward compatibility check, store privacy disclosure, web hosting and the PROD deploy order. Read when receiving the `build` command, when the server hardening agent and the client hardening agent work, when setting the signing key in `setup game`, and when the core agent writes per-engine build rules
---

# build

## procedure

`<env>` is the environment name. In command arguments it is uppercase (`DEV`, `STG`, `PROD`), and inside other names, paths, branches, tags and image tags it is lowercase (`dev`, `stg`, `prod`).

1. Runs `ogw build start <game> <env> [<platform>...] [--version <version>] [--bundle-for <app version>]`. The tool checks that the game has no unclosed run (loop run or build run), that `git status` of the game repo checkout shows no changes, that harness settings `useLocalCore` is `false`, and that every gameplay video that `records/setup/reference/reference.md` names is in `records/setup/reference/` (step 4 calls the judge agents). Then it checks whether build stage values (items whose `x-stage` is `build` in the game settings schema) of that environment and outside any environment are missing (only the missing values of the same check as `ogw game check <game> --build`. An STG build also looks at the PROD values: a PROD build builds the commit checked in STG. It does not look at the values of any other environment). When values are missing, the tool makes nothing, outputs the missing values and exits with a nonzero code. The lead agent asks the human and fills them by the game settings rules of [`game-setup`](../game-setup/SKILL.md) 5, then runs `ogw secret generate <game> <environment>` for each environment that had missing values (also PROD when PROD values were missing in an STG build), commits the changed `settings.json` to main and starts again. Then the tool checks that this host is a Mac when the platforms to build include ios or macos; that the `signing` secret of each platform to build that has `signing.<platform>` in game settings is in this host's secret store; that the programs of that platform's `engine.json` `buildTools` whose `hosts` include this host, the engine that `engine.json` of the game settings core version names, and, when the platforms to build include web, the program of harness settings `tools.chromium` are on this host at that version; that this host's Docker has the image of harness settings `tools.postgresql`; that harness secret `claude-code-oauth-token` is in this host's secret store when the agent CLI of play or judge in harness settings `agents` is Claude Code (when it is not, a human makes a long-lived token with `claude setup-token` and puts it as one line into `ogw secret set --harness claude-code-oauth-token`); that the major of `tools.postgresql` `tag` equals game settings `postgresqlMajor`; and that game settings have `updatePublicKeys` of that environment (for an STG build, also those of PROD). For DEV and STG it also checks that this host has `docker buildx`, that this host's GitHub CLI login has the `write:packages` scope, and that the secrets of that environment's `secrets` and the `secret` of `adminOperators` are all in this host's secret store (`ogw deploy` writes them by the secret file rule of `## deploy`). For DEV and STG when a PROD tag exists, it also checks the secret of operator `ogw` in PROD `adminOperators`. When any is missing, stops and tells the human. For DEV and STG, the tool then runs the human checks of `## build-time check` on the HEAD of main. When any fails, the tool makes nothing, outputs the human target of each failed human check and exits with a nonzero code. The lead agent stops and tells the human those human targets. The tool sets the version. When a previous build stopped without a tag and branch `build/<env>-<version>` remains, the tool renames that branch to `build/<env>-<version>-failed-<unix ms>`, and when `builds/<env>-<version>/` exists, renames it to `builds/<env>-<version>-failed-<unix ms>/`. Then it creates branch `build/<env>-<version>`. It creates it from the HEAD of main for DEV and STG and from the main commit that has the `stg-<version>` tag for PROD, and checks out the created branch. It sets the run name to `build-<env>-<version>` and creates `records/loops/<run>/`
   - DEV, STG: with `--version`, the version is that value, and when that value is not higher than the game's highest tag version, stops and tells the human. Without `--version`, the version is the highest tag version with patch raised by 1, and `0.1.0` when there is no tag. Versions are compared by major, minor, then patch. When a `--bundle-for` build has `--version`, stops and tells the human
   - PROD: the commit the build branch is created from is, with `--version`, the commit of main tagged `stg-<that value>`, and without it, the most recent commit of main that has an `stg-<version>` tag. The version is that tag's version. When there is no such commit, when the `prod-<version>` tag already exists, or when it is not a bundle patch and the version is not higher than the version of the last PROD build, stops and reports to the human. When main has no `records/loops/build-stg-<version>/end.md` or its `## compatibility base` differs from the tag of the current last PROD build (`none` when there is no PROD tag), stops and reports to the human that a new STG build is needed. Unless it is a bundle patch without data, the tool also checks with this host's GitHub CLI login that game settings `serverImage.repository` has the server image with image tag `stg-<version>`. When it does not, stops and reports to the human
   - When a PROD tag exists and the contract version of the commit the branch was created from is greater than the contract version of the last PROD build, the tool also checks that the secret of operator `ogw` in PROD `adminOperators` is in this host's secret store and that admin operation `sample_user_ids` (`count` 1) on PROD `serverUrl` succeeds with that operator. Otherwise, stops and tells the human
2. Calls the server hardening agent and the client hardening agent together with `--background`. For STG, also calls the sub-agents of placeholder handling at the same time. `ogw agent` creates a separate worktree from the build branch for each agent, and each hardening agent writes and commits its hardening record in that worktree. The lead agent waits for the two hardening agents with `ogw agent wait <id>`, then merges them into the build branch one after the other with `ogw agent merge <id>`. When a merge is not merged with reason `conflict` or `outside scope`, calls that agent again with the same input
3. Each round, writes the finding file with `ogw loop findings <game> --hardening`, fills it by `## defect list` of `game-loop`, then puts it into the defect list with `ogw loop record <game> --hardening`. When `## content agent fixes` of this round's hardening record has items, runs one fix iteration, then returns to 2. A fix iteration is an iteration that does iteration steps 1, 2, 5 and 6 of `game-loop` in this order on the hardened code. Step 2 runs with `ogw check <game> --loop --db postgresql`, and steps 3 and 4 are not done, whatever the result
4. Runs iteration steps 2 to 6 of `game-loop` once with the hardened code. Does not do step 7 (changing the baseline game) and step 8 (stop judgement). The instance DB is PostgreSQL. Step 2 runs with `ogw check <game> --loop --db postgresql`, and steps 3 and 4 with `ogw loop evaluate <game> --db postgresql`. When `ogw check` outputs `gate: fail` or `vs baseline` of the judge result is `worse`, runs one fix iteration, then returns to 2. For the performance and UI quality results, does not return to 2 and puts them in the build report. The check of 5 judges the no placeholder element
5. For STG, waits for `ogw loop sync <game> --wait --background` with `ogw job wait <id>` to merge all placeholder handling sub-agents. Then does the build-time checks and the per-platform build with `ogw build run <game>`. When a human check fails or the STG placeholder check fails, stops and reports to the human without returning to 2. When another check fails, has the content agent fix it in a fix iteration and returns to 2
6. Runs `ogw build finish <game>`. When it exits with a nonzero code, stops and reports the two commits the tool output to the human
7. For DEV and STG, deploys to that environment by `## deploy`. When the deploy fails, stops and reports to the human
8. Writes the build report by `## build report` and reports to the human

- Before returning to 2 from 3, 4 or 5, before calling a hardening agent again in 2, and before doing 2 again in a resumed build run, the lead agent runs `ogw build retry <game>`. When it exits with a nonzero code, game settings `buildRetryLimit` is exceeded, so the lead agent stops and reports to the human
- When the `backward compatibility` check of 5 outputs a failure starting with `save schema: PROD admin API`, stops and reports to the human without returning to 2
- Only an STG build does placeholder handling. The lead agent runs `ogw loop dispatch <game>`. The tool makes the request with `ogw resource request <game> --pending` (request file path `records/hardening/<env>-<version>-resource-<unix ms>.md`) and calls the resource sub-agent and one translation sub-agent per language. In 2 it runs together with the call of the hardening agents, and in fix iterations and the iteration of 4 it runs by iteration step 2 of `game-loop`. Worktrees are created from the build branch. Finished work is merged after the hardening agents are merged in 2 and after each iteration step 6, by waiting for `ogw loop sync <game> --background` with `ogw job wait <id>`. `ogw loop sync` does reassignment by `## sub-agent` of `game-loop`, and reassignment does not count toward `buildRetryLimit`
- Fix iterations and the iteration run in step 4 are `game-loop` iterations of this run. For each iteration, the lead agent raises the number with `ogw loop next <game>`
- `ogw loop input <game> content` writes the content agent's input. In a build run, `## request` is `none`
- The baseline game of the step 4 judge is our game started from the main commit the build branch started from. `ogw loop baseline` outputs this commit
- PROD does not redo hardening and step 4. It builds the commit checked in STG as it is. It does 5, and when a check of 5 fails, stops and reports to the human without fixing. Fixes go through `update game` and a new STG build. It does not do 7
- When a build run is resumed by `## resume` of `game-loop`, `ogw loop resume` outputs the step to resume from: `end` (from `ogw loop end` of `## build report`) when the build report is committed, 7 when tag `<env>-<version>` (for a bundle patch build, `<env>-<app version>-bundle-<n>`) exists, 5 for PROD, 6 when the HEAD of main is the merge commit in which `ogw build finish` merged the build branch of this run, and 2 otherwise

## build report

When the build ends or stops after `ogw build start` created the run, the lead agent runs `ogw build report <game> --result <done|stopped> [--reason <file>]`. For `stopped`, it passes a file stating the stopped step and the reason as `--reason`. The tool writes the build report `records/loops/<run>/end.md` and commits it to main when tag `<env>-<version>` exists, otherwise to the build branch. Then the lead agent runs `ogw loop end <game>` and reports the summary and path of the build report to the human.

The build report has the headings below in this order. A heading is `none` when it has no contents or the build did not reach the step that produces them.

| heading | contents |
|---|---|
| `## result` | `done` or `stopped`. For `stopped`, the contents of the `--reason` file |
| `## protocol change` | For a `protocol change` build, the two data versions the server accepts (`client_data_version`, `compat_client_data_version`). Copied from the result of `ogw build run` |
| `## compatibility base` | The tag of the last PROD build that the backward compatibility check of 5 and `compat_client_data_version` used as their base. `none` when there is no PROD tag |
| `## artifacts` | One line per platform `- <platform>: <artifact path> (<outlets>)`. A platform made with free signing gets ` free signing: <method>` at the end of the line, where `<method>` is android `debug keystore`, macos `ad-hoc`, windows `unsigned`. The outlets are set by the external beta rule of `## platform build`, and the text is STG android `Google Play open testing and closed testing`, STG ios and macos `TestFlight public link`, PROD android, ios and macos `store review, internal testing, release`, and `none` otherwise |
| `## server image` | Name, image tag and digest of the server image |
| `## hardening` | The hardening record paths of this run and the `## unknown` items of the last round's hardening records |
| `## checks` | The result of each build-time check of `ogw build run` (`pass`, `fail`, `warn`, `unknown`) and the first loading ms that web smoke measured. The performance and UI quality results of `check-<iteration>.json` of the step 4 iteration |
| `## store privacy` | File paths of `builds/<env>-<version>/privacy/`. For a PROD build, the account deletion URL |
| `## converters` | In a PROD build, the list of (kind, from version) of the converters added after the last PROD build. They are the items of this build's converter list file `server/generated/contract/converters.json` that are not in that file at the last PROD build tag. When the tag does not have that file, the comparison is with an empty list |
| `## core schema` | In a PROD build, `coreSchemaVersion` of the core version release `manifest.json` of the last PROD build and of this build. When they differ, the sentence "After this build is deployed, the PROD server cannot be rolled back to the last PROD build." |
| `## deploy` | For DEV and STG, the result of `ogw deploy` and the failed step. For PROD, the PROD deploy order, rollback order and maintenance order of `## deploy` with this build's file paths and match wait duration filled in |
| `## human` | The human targets of failed human checks, for a DEV build the resource keys the `license` check warned about, the items of `records/loops/<run>/assumptions.md` with `needs human` in the heading line (the lines are as in `## human` of [`game-loop`](../game-loop/SKILL.md) `### end-record`), and the file paths of `records/core-proposals/` added to the build branch in this run |

- In a DEV build, the failure of a check that only warns is `warn`

## hardening

What the server hardening agent looks for is `## hardening` of [`server-content`](../server-content/SKILL.md), and what the client hardening agent looks for is `## hardening` of [`client-content`](../client-content/SKILL.md).

The path of a hardening record is `records/hardening/<env>-<version>-<server|client>-<round>.md`. `<round>` is the number of hardening records of the same `<env>-<version>-<server|client>` in `records/hardening/` of the build branch plus 1, as `ogw agent` counts it. `ogw agent` passes this path as `output` inside the hardening agent worktree.

| heading | contents |
|---|---|
| `## changes` | Per fixed place: file:line, the problem found, the fix, the tests added |
| `## content agent fixes` | A table with columns `file:line`, `owner`, `problem`, `task`. One row per item: `file:line` is the place to fix, `owner` is `contract` when the file to fix is contract, `data` when data, `server content` when server content code, `client content` when client content code, `problem` is the problem, and `task` is what the content agent does. `none` when there are none |
| `## unknown` | What could not be checked, what is unknown, and why |

## build-time check

`ogw build run` runs these before the platform build. When any fails, it does not build. When a check cannot run to the end for a reason the table below does not set as `unknown` (e.g. an export, instance, device or browser error, or a harness settings `tools` program missing on this host), that check fails, and a check that only warns in a DEV build is a warning in a DEV build. As an exception, the build artifact and archive check of the `secret` check runs after the platform build, and when it fails, the build fails.

The failures below are the human checks: they clear only when a human edits game settings, `records/setup/banned-words/` or `license` of `resources.csv`. The human target of a failure is what a human edits to clear it. The warning of a check that only warns in a DEV build is not a human check failure.

| human check | human target |
|---|---|
| failure of the `license` check | resource keys whose `license` is `unknown` in `resources.csv` |
| failure of the `adapter` check | the game settings path to edit |
| failure of the `admob` check | the game settings path to edit |
| failure of the `banned word` check | languages of `supportedLanguages` whose `records/setup/banned-words/<language>.txt` is missing or has only blank lines |
| failure of the `privacy` check caused by an adapter without a declaration | name of the adapter without a declaration |

| check | blocks |
|---|---|
| DEV code | An STG or PROD build contains `client/dev/`, `server/dev/` or core's `dev/`. Code that is not DEV code references DEV code |
| debug text | An STG or PROD build has debug text of [`client-content`](../client-content/SKILL.md) |
| adapter | `push-apns` of the DEV `adapters` in game settings is `push-apns`. STG `adapters` has `fake` or `push-apns-sandbox`. Among the STG `adapters` keys other than `push-apns`, the value of a key for which the module spec that uses the key defines an adapter name ending in `-sandbox` does not end in `-sandbox`. e.g. `iap-apple` is `iap-apple`. PROD `adapters` has `fake` or a name ending in `-sandbox`, or has no `cdn`. In an STG or PROD ios build, that environment's `adapters` has `login-google` but no `login-apple`. The target platforms include web but that environment's `adapters.cdn` is not `cdn-r2` |
| admob | `ads` of that environment's `adapters` in game settings is `ads-admob`, and `admob.appIdAndroid` when the target platform is android, or `admob.appIdIos` when it is ios, is missing or an empty string. That environment's `adUnits` has an `ad_placement` row without an ad unit ID for the target platform. An ad unit ID of the target platform equals an ad unit ID of another placement of that environment or of another environment's `adUnits` |
| banned word | In an STG or PROD build, the modules the game uses include one of `nickname`, `guild`, `chat`, but `data/tables/banned_word.csv` has no row that is built. A DEV build only warns |
| secret | The repo, a build artifact or an archive contains a secret or an absolute path of the workspace. The `dev_access` value in the build info file of a DEV build is not treated as a secret |
| placeholder | There is a placeholder resource, missing translation or stale translation. A DEV build only warns |
| license | An STG or PROD build has a resource whose `license` in `resources.csv` is `unknown`. A DEV build only warns |
| privacy | An STG or PROD build has no game settings `privacy`. Among the adapters chosen in that environment's `adapters` that are not `fake`, there is an adapter for which `core-spec.json` of the modules the game uses has no `collectedData` row with its name (with a trailing `-sandbox` removed) as `source`. A DEV build only warns |
| device performance | In an android build, the result of running the bot playtest scenario on a DEV export of the same commit started on an android device of harness settings `testDevices` is `fail` by the `## performance` judgement of [performance of `game-loop`](../game-loop/performance.md), or the app did not boot on the device (crash, `Halted`, error log, timeout), or `client/dev/bot/scenario.json` is not in its defined format. A DEV build only warns. When the target platform is not android, `testDevices` has no android device, or in a realtime game UDP does not reach between that device and the host, it reports `unknown` and does not block |
| web smoke | In a web build, no blocker or full flow of the result of running the bot playtest scenario on a DEV web export of the same commit opened in the headless browser of harness settings `tools.chromium` is `fail`. A DEV build only warns. Runs only when the target platforms include web |
| backward compatibility | Violation of the backward compatibility rules |
| bundle | Violation of the bundle patch rules |

## platform build

- The platforms are those named in the command, or all of game settings `buildPlatforms` when none are named
- All chosen platforms are built on this host. iOS and macOS are built only on a Mac host
- The chosen platforms are built in parallel. Each platform gets its own clean checkout of the build branch as its build workspace, and artifacts go in `builds/<env>-<version>/<platform>/` of the game repo
- Signing of each platform is one of the below. web and linux are not signed
  - STG and PROD builds, and DEV builds with `signing.<platform>` in game settings, make signed artifacts
  - free signing: DEV builds of android, macos and windows without `signing.<platform>`. android is signed with the debug keystore, macos is ad-hoc signed and not notarized, and windows is not signed. As an exception, macos whose DEV `adapters.login-apple` is `login-apple` has no free signing. An ad-hoc signed app does not launch with the `com.apple.developer.applesignin` entitlement. ios has no free signing. An unsigned app does not install on a device
  - In a build without free signing, a missing `signing.<platform>` is output as a missing value by `ogw game check --build` and `ogw build start`
  - The debug keystore is `~/.android/debug.keystore` of this host, with key alias `androiddebugkey` and store password and key password `android`. When it does not exist, `ogw build run` makes it with `keytool`: RSA 2048 bit, validity 10000 days, dname `CN=Android Debug,O=Android,C=US`. `keytool` is the one in the same folder as a program that `ogw env install-engines` installed among the platform `android` items of `engine.json` `buildTools`, and the one on PATH when there is no such one. The debug keystore and its passwords are not secrets
- The secret name used for signing is game settings `signing`, and the value is read from the host secret store. Secrets are not left as files in the repo or artifacts. As an exception, the build info file of a DEV build holds the value of secret `environments.DEV.secrets.devAccess` in `dev_access`
- `update_trust_keys` of the client build info is the key ID and public key for each public key of that environment's `updatePublicKeys` in game settings. The key ID is made by the signature rules of [`game-update`](../server-core/modules/game-update.md)
- When game settings `consent.trackingRequest` is `true`, an iOS build includes the tracking permission request text (`NSUserTrackingUsageDescription`). The text is the per-language translation of reserved string `[auth_tracking_usage]`
- iOS and macOS builds include entitlements from that environment's `adapters`. For iOS, `aps-environment` is `production` when `push-apns` is `push-apns`, and `development` when it is `push-apns-sandbox`. For iOS and macOS, `com.apple.developer.applesignin` is `Default` when `login-apple` is `login-apple`. iOS signs DEV with a development provisioning profile and STG and PROD with an App Store provisioning profile. The provisioning profile must hold those capabilities
- When that environment's `login-google` is `login-google`, an iOS build includes game settings `loginGoogle.iosClientId` and its reversed client ID URL scheme
- When that environment's `push-fcm` is `push-fcm`, an android build makes and includes a Firebase config file from `projectId`, `projectNumber`, `appIdAndroid`, `apiKeyAndroid` of game settings `environments.<ENV>.fcm`
- Only STG builds go to external beta (TestFlight public link, Google Play open testing and closed testing). PROD builds go only to store review, internal testing and release. This is because the PROD server also grants for test transactions
- The build method per engine is in [godot](engines/godot.md)

## store privacy disclosure

Before the platform build, `ogw build run` makes the store privacy disclosure in `builds/<env>-<version>/privacy/`. The declaration rows are the two kinds below. The declaration format is `## collected data` of [`core`](../core/SKILL.md).

- The `core-spec.json` `collectedData` rows of the modules the game uses whose `dataType` is not `none`, whose `source` is `module` or the name of an adapter that is not `fake` chosen in that environment's `adapters` (with a trailing `-sandbox` removed), and whose `condition` is `null` or the game settings value at `condition` `path` equals `condition` `value`
- The rows of game settings `privacy.contentData`

| file | made when | contents |
|---|---|---|
| `PrivacyInfo.xcprivacy` | The target platforms include ios | The iOS privacy manifest made from the declaration rows whose `platforms` include `ios`. Included in the ios build |
| `app-store.md` | The target platforms include ios or macos | Draft App Store Connect App Privacy answers made from the declaration rows whose `platforms` include `ios` or `macos` |
| `google-play.md` | The target platforms include android | Draft Google Play Console Data safety answers made from the declaration rows whose `platforms` include `android` |

- The answers are set per store data type by collecting the declaration rows that become that store data type by the tables below. linked, tracking and shared are `true` when any collected row has `true`, optional is `true` when all collected rows have `true`, and purpose is the union of the collected rows' purposes mapped by the table below. Per store data type, the draft writes these values and the `description` and `source` of the rows they come from. When there are no declaration rows, it writes that no data is collected
- When game settings `consent.trackingRequest` is `false`, `app-store.md` and `PrivacyInfo.xcprivacy` treat `tracking` of every row as `false`. In a game that does not ask for tracking permission, the ads SDK does not track
- `PrivacyInfo.xcprivacy`: `NSPrivacyTracking` is whether there is a store data type whose tracking is `true`, `NSPrivacyTrackingDomains` is an empty list, and `NSPrivacyCollectedDataTypes` has one item per store data type holding `NSPrivacyCollectedDataType`, `NSPrivacyCollectedDataTypeLinked`, `NSPrivacyCollectedDataTypeTracking`, `NSPrivacyCollectedDataTypePurposes`. The per-engine build method sets the required reason API items and how to include the file in the ios build
- Along with the store data type answers, `google-play.md` writes the following: encrypted in transit is `Yes` because all transfer is HTTPS, `Yes` because users can request data deletion, and the account deletion URL is PROD `serverUrl` followed by `/account/deletion`. That address is the web account deletion page of [`auth`](../server-core/modules/auth.md)

data type mapping

| data type | App Store data type | `NSPrivacyCollectedDataType` | Google Play data type |
|---|---|---|---|
| `user_id` | User ID | `NSPrivacyCollectedDataTypeUserID` | Personal info: User IDs |
| `device_id` | Device ID | `NSPrivacyCollectedDataTypeDeviceID` | Device or other IDs |
| `nickname` | Other User Content | `NSPrivacyCollectedDataTypeOtherUserContent` | Personal info: Name |
| `purchase_history` | Purchase History | `NSPrivacyCollectedDataTypePurchaseHistory` | Financial info: Purchase history |
| `product_interaction` | Product Interaction | `NSPrivacyCollectedDataTypeProductInteraction` | App activity: App interactions |
| `gameplay_content` | Gameplay Content | `NSPrivacyCollectedDataTypeGameplayContent` | App activity: Other actions |
| `in_app_messages` | Other User Content | `NSPrivacyCollectedDataTypeOtherUserContent` | Messages: Other in-app messages |
| `other_user_content` | Other User Content | `NSPrivacyCollectedDataTypeOtherUserContent` | App activity: Other user-generated content |
| `crash_data` | Crash Data | `NSPrivacyCollectedDataTypeCrashData` | App info and performance: Crash logs |
| `performance_data` | Performance Data | `NSPrivacyCollectedDataTypePerformanceData` | App info and performance: Diagnostics |
| `advertising_data` | Advertising Data | `NSPrivacyCollectedDataTypeAdvertisingData` | App activity: App interactions |
| `coarse_location` | Coarse Location | `NSPrivacyCollectedDataTypeCoarseLocation` | Location: Approximate location |
| `other_data` | Other Data Types | `NSPrivacyCollectedDataTypeOtherDataTypes` | Personal info: Other info |

purpose mapping

| purpose | App Store purpose | `NSPrivacyCollectedDataTypePurposes` value | Google Play purpose |
|---|---|---|---|
| `app_functionality` | App Functionality | `NSPrivacyCollectedDataTypePurposeAppFunctionality` | App functionality |
| `account_management` | App Functionality | `NSPrivacyCollectedDataTypePurposeAppFunctionality` | Account management |
| `analytics` | Analytics | `NSPrivacyCollectedDataTypePurposeAnalytics` | Analytics |
| `product_personalization` | Product Personalization | `NSPrivacyCollectedDataTypePurposeProductPersonalization` | Personalization |
| `developer_communications` | App Functionality | `NSPrivacyCollectedDataTypePurposeAppFunctionality` | Developer communications |
| `developer_advertising` | Developer's Advertising or Marketing | `NSPrivacyCollectedDataTypePurposeDeveloperAdvertising` | Advertising or marketing |
| `third_party_advertising` | Third-Party Advertising | `NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising` | Advertising or marketing |
| `fraud_prevention` | App Functionality | `NSPrivacyCollectedDataTypePurposeAppFunctionality` | Fraud prevention, security, and compliance |

## server image

- There is one server image per build regardless of platform. For DEV and STG builds, `ogw build run` of 5 makes the server image for game settings `serverImage.platform` with `docker buildx` and pushes it to `serverImage.repository` with image tag `<env>-<version>`. The build context is a copy of `server/` in a temporary folder (without `node_modules/`). For STG, `generated/core_settings.json` and `generated/server_modules.json` of that copy are rewritten with the STG prepared modules (`## module` of the `core` skill). For DEV and STG, the items whose path contains an environment name other than this build's are removed from `generated/core_settings.json` of that copy. The Dockerfile is `core/Dockerfile` of that copy. The registry login uses this host's GitHub CLI login
- The image contents and container run rules follow [server image of `server-core`](../server-core/server-image.md). The DB is PostgreSQL, and the adapters are that environment's values in game settings
- A PROD build does not make a server image. PROD uses, by digest, the server image with image tag `stg-<version>` that the STG build of the same commit pushed
- For a realtime game, one server process per environment is started with `--matchmaker`, and all `GET /realtime` requests are sent to that process

## backward compatibility

From the first PROD build on, the check is against the last PROD build. The last PROD build is the build of the `prod-<version>` tag with the highest version, and bundle patch tags are not counted. When there is no PROD tag, there is no check.

| target | check |
|---|---|
| contract | The contract tool checks the backward compatibility of [`contract`](../contract/SKILL.md) |
| data | The data tool checks the data version rules and `prod_change` of [`data`](../data/SKILL.md). The comparison base is the PROD data tag that `## data version` of `data` defines |
| server image | In a PROD build, the value of this build's `server/build/data/compat_client_data_version` (an empty string when the file does not exist) must equal label `ogw.compat_client_data_version` of the server image with image tag `stg-<version>`. A bundle patch without data is not checked |
| game settings | `dailyResetOffsetMs` and `nicknameUnique` equal the game settings values at the last PROD build tag. An unset value is compared as the default of the game settings schema. `environments.PROD.updatePublicKeys` holds all public keys of game settings `environments.PROD.updatePublicKeys` at the last PROD build tag. This is because an installed app verifies the deploy list signature only with the keys of `update_trust_keys` in its build info |
| save schema | When the current contract version is greater than the contract version of the last PROD build, `### save schema check` must have no failure |

- While there is no PROD tag, the DEV and STG DBs are emptied on each build
- The PROD server can be rolled back to a previous build only when the builds in between added no converter and did not raise `coreSchemaVersion`. When a converter was added, the rolled-back server answers `INTERNAL` to a request that reads a row of that kind with a higher contract version. When `coreSchemaVersion` was raised, the rolled-back server does not start. A change that only adds `?` columns to a table registered in `storage` does not block a rollback. Rows of UserState, server state and game state kinds that the builds in between added also do not block a rollback. The rolled-back server skips those rows without deleting them (unknown kind row of [`storage`](../server-core/modules/storage.md)), and when the server of the new build is started again, it reads those rows. After the app of a `protocol change` build is released in a store or the web entry page is changed, the PROD server is not rolled back to a build before that build. The `client_data_version` and `compat_client_data_version` of the rolled-back server do not have the protocol hash of the new app, so every request of the new app gets `APP_UPDATE_REQUIRED`
- A change that cannot keep these rules is resolved with a migration, and when that still cannot resolve it, stops and reports to the human

### save schema check

`ogw build run` runs the migration test of [`migration`](../server-core/modules/migration.md). A changed kind is a UserState, server state or game state kind of the game contract whose definition and the definitions of the game contract messages and enums reachable from it (excluding comments) differ from the last PROD build.

1. Calls the admin API of PROD `serverUrl` as operator `ogw` to get samples. For each user chosen by `sample_user_ids` (`count` is the merged core settings `migration.testSampleCount` of the build checkout), gets a snapshot with `export_user_snapshot`. For each changed game state kind that is also in `contract/game_state.proto` of the last PROD build, gets game state snapshots with `sample_game_state` (kind, `migration.testSampleCount`). The format follows [`user-snapshot-clone`](../server-core/modules/user-snapshot-clone.md)
2. The runner starts a one-off PostgreSQL container with the harness settings `tools.postgresql` image. The tool starts a test server of the new server code in the build checkout with `start_test_server` of [`testing`](../server-core/modules/testing.md), and for each snapshot and game state snapshot calls `call_dev` (that test server, `migration`, `migrate_snapshot`, that snapshot). The test helper input is the input of the server regression test with `--db postgresql` in `### test run` of `testing`
3. When `migrate_snapshot` returns a record whose `result` is `FAILED` or returns `bad_request`, the check fails. The failure contents are the snapshot source (user ID or game state kind) and the record's `table`, `key`, `from_version`, `error`
4. A changed kind that is also in the last PROD build and for which no received record has a contract version lower than the current contract version is reported as `unknown`. When the `backward compatibility` check has no failure and there is an `unknown` kind, the result of that check is `unknown`

- Snapshots and game state snapshots are received one at a time into memory, passed to `migrate_snapshot` and discarded. They are not written to files
- When the PROD admin API cannot be called (no secret, connection failure, authentication failure), the check fails, and the failure contents start with `save schema: PROD admin API`

### protocol change

- A build whose Client build target data version has a protocol hash that differs from that of the last PROD build is a `protocol change` build

## bundle patch

A bundle patch starts with `ogw build start <game> <env> --bundle-for <app version>`, and its procedure is the same as the build procedure. Its results are the bundle, the data and the server image built with that data. When it does not carry data, it makes no server image.

- A bundle patch build writes `<app version>-bundle-<n>` in the version position (build branch, run name, `builds/` folder, tag, image tag). The tag format follows AGENTS.md `## branch`
- A bundle patch carries data when the data version of the Client build target or the Server build target of the build commit differs from that of the `<env>-<app version>` tag commit of the target app version
- Bundle patch tags are not counted when setting the version and when finding the commit PROD starts from
- When the `<env>-<app version>` tag of the target app version does not exist, `ogw build start` stops and tells the human
- A PROD bundle patch starts from the most recent commit of main that has an `stg-<app version>-bundle-<n>` tag. When there is no such commit, stops and reports to the human
- The bundle holds only what matches the code of the target app version
- It leaves out scenes and prefabs that use code changed after that app version, and data whose protocol hash differs from that of the target app version
- The resource keys it holds are the keys whose `sha256` in `resource/resources.csv` differs from the tag, or that were not in the tag, at any commit from the `<env>-<app version>` tag commit of the target app version to the build commit, minus what it leaves out
- It does not delete resource keys that were in the bundle of the target app version, and does not delete or rename elements that code or data refer to by name
- When these rules are broken or the bundle has code, the `bundle` check blocks it
- When it carries data, it holds all client table binaries of `client/build/data/` and the translation binary of each language
- The result files go in `builds/<env>-<version>/patch/`: bundle files, data files and `patch.json`. `patch.json` is the target app version item of deploy list `patches` (`data_version`, `data_files`, `translation_files`, `bundle_files`), and its format follows [`game-update`](../server-core/modules/game-update.md). When it does not carry data, `data_files` and `translation_files` are empty lists and `data_version` is the client data version of the target app version tag commit
- A bundle patch build also runs checks `device performance` and `web smoke`
- The way to make bundle files and the bundle check items per engine are in [godot](engines/godot.md)

## web hosting

The web build is served from that environment's `cdn-r2` bucket (game settings `environments.<ENV>.cdnR2`). The web origin is the origin of `cdnR2.publicBaseUrl`. It is the same origin as `file_base_url` of the update files, so there is no CORS when the client receives files. The web artifact is all files the build put in `builds/<env>-<version>/web/`.

- cross-origin isolation: R2 cannot send COOP and COEP headers per object (the only headers an S3 put saves are `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`). The cross-origin isolation that a Web export with threads needs is obtained by the service worker of the web artifact adding `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to the pages in the version folder and the responses to the requests of those pages. The scope of the service worker is the version folder, so each version registers its own service worker on its first load
- version folder: each file of the web artifact is uploaded with key `web/<env>/<version>/<file name>`. An uploaded version folder is not changed or deleted. This is because open pages keep receiving the files of that folder
- entry page: key `web/<env>/index.html`. It is one HTML file that moves the page (`location.replace`) to `index.html` of the version folder that environment currently serves, keeping the query string. Players enter through `<publicBaseUrl>/web/<env>/index.html`. `web` `store_url` of that environment's deploy list `app` is this address

## deploy

In 7, the lead agent deploys a DEV or STG build to that environment with `ogw deploy <game> <env> <version>`. The tool does the deploy steps in turn, and when any fails, stops and tells which step failed.

- By the deploy list rule, a deploy sets the new deploy list from the deploy list read before `publish_deploy_list`. `app` is `app` of the read deploy list, and an empty object when there is no read deploy list. `patches` is the items below, plus the item of `patch/patch.json` when this build has one. When the same app version key appears in both, the item of `patch.json` is used
  - App versions in `apps` of `update/update.json` that are at least the smallest platform `min_version` of the read deploy list `app` (all of `apps` when `app` is empty): `data_version`, `data_files` and `translation_files` are the values of `update.json`, and `bundle_files` is the value of that app version's item in the read deploy list. When there is no such item, it is an empty list
  - Other app version items of the read deploy list whose `data_version` equals `compat_client_data_version` of the new server: kept as they are. A build without a server image does not change the server, so it keeps all other items as they are
  - Other items of the read deploy list are not included. Clients of those app versions delete the received files and fall back to built-in data and resources
- By the secret file rule, before starting the server, `ogw deploy` of a build with a server image reads the values of the secrets of that environment's `secrets` except `deploySsh` and of every `secret` of `adminOperators` from this host's secret store, and writes them over SSH to the files `secrets/<secret name>` of `deploy.dir`
  - The file contents are the value followed by one newline. `secrets/` is a 0700 folder that only `deploy.user` can enter. The file of `dbPassword` is 0600, and other files are 0644 so that UID 10001 inside the container reads them
  - A secret whose file contents on the host are already the same is not written again. When any file was newly written, that deploy recreates the server and PostgreSQL containers so that they read the new values
  - When a PROD tag exists and the contents of the host's `dbPassword` file differ, it writes no file and fails. This is because the PostgreSQL password in the DB volume does not change
  - Secret values are not output, and are not written to logs or to files other than the host's secret files
- By the container log rule, the logs of the server and PostgreSQL containers are written with the Docker `json-file` log driver and rotated with `max-size` as `maxBytes` of that environment's `containerLog` and `max-file` as `maxFiles`
- update file: the data files, translation files and bundle files of `builds/<env>-<version>/patch/` and `update/`
- A build that is not a bundle patch without data puts, in `ogw build run` of 5, all client table binaries of `client/build/data/`, the translation binary of each language and `update.json` in `builds/<env>-<version>/update/`. `update.json` has `data_version` (the Client build target data version of this build), `data_files`, `translation_files` and `apps`. The format of the first three is that of the same-named fields of a deploy list `patches` item. `language` of `translation_files` is `<code>` of the translation binary file name `translation_<code>.bin`. `apps` is the version of this build when it is not a bundle patch, plus each app version with an `<env>-<app version>` tag for which the Client build target data version of that tag commit has the same protocol hash and which passed the `bundle` check when this build's data was put in together with the `<env>-<app version>-bundle-<n>` bundle of the largest n of that app version (no bundle when there is none)
- A human changes `app` of the deploy list (`min_version`, `recommended_version`, `store_url`)
- PostgreSQL major upgrade: when `ogw build start` stops because the major of harness settings `tools.postgresql` `tag` differs from game settings `postgresqlMajor`, the lead agent tells the human this procedure. When there is no PROD tag, a human changes `postgresqlMajor` to the new major. When a PROD tag exists, a human moves the DEV and STG DB volumes and the PROD DB to a cluster of the new major with `pg_dump` of the `postgresqlMajor` major and `pg_restore` of the new major, then changes `postgresqlMajor` to the new major
- The `host` of game settings `environments.<ENV>.deploy` is prepared by a human: Docker Engine and Docker Compose, permission for `deploy.user` to use Docker and to create and write `deploy.dir`, `authorized_keys` of `deploy.user` holding the public key of that environment's `secrets.deploySsh` private key, a `ghcr.io` login that can pull `serverImage.repository`, and a reverse proxy that passes HTTPS requests of `serverUrl` and the WebSocket upgrade of `GET /realtime` to `127.0.0.1:<deploy.port>` and appends the client IP to the end of `X-Forwarded-For`. The number of that proxy plus the proxies in front of it equals that environment's `trustedProxyCount`
- For an environment whose `adapters.turn` is `turn-coturn`, a human prepares the coturn server. coturn listens on the host and port of that environment's `turnCoturn.urls`, turns on `use-auth-secret`, and sets `static-auth-secret` to the same value as the secret that environment's `secrets.turn` points to. The URL ports are opened for UDP and TCP, and coturn's relay port range (from `min-port` to `max-port`) for UDP. `turns` URLs use the TLS certificate (`cert`, `pkey`) of that host name. Private address and loopback address ranges are blocked as relay targets with `denied-peer-ip`
- For an environment whose `adapters.cdn` is `cdn-r2`, a human prepares the R2 bucket, the custom domain that publishes that bucket as `cdnR2.publicBaseUrl`, and an R2 API token that can write to that bucket (`cdnR2.accessKeyId` and the value of `secrets.cdn`)
- For an environment whose `adapters.ads` is `ads-admob` (PROD included), a human prepares the AdMob ad units. The ad units of that environment's `adUnits` are made in AdMob separately per environment, and for the ad unit of a placement whose `type` in `ad_placement` is `Rewarded`, the server-side verification callback URL is set to that environment's `serverUrl` followed by `/ads/callback/admob`. Devices with DEV or STG builds installed are registered as AdMob test devices
- For an environment whose `adapters.login-google` is `login-google`, a human adds the origin of that environment's `serverUrl` to the authorized JavaScript origins of the `loginGoogle.serverClientId` OAuth client. The web account deletion page of `auth` does Google sign-in from that origin
- For an environment whose `adapters.analytics` is `analytics-ga4`, a human adds the `analyticsGa4.serviceAccountEmail` service account to the GA4 property of `analyticsGa4.propertyId` with the Editor role or higher. The user deletion request of `logging` uses this permission
- If an environment's `adapters.iap-apple` is `iap-apple` or `iap-apple-sandbox`, a human sets, in App Store Connect, the App Store Server Notifications of that app to Version 2, the Production Server URL to PROD `serverUrl` followed by `/iap/notify/apple`, and the Sandbox Server URL to STG `serverUrl` followed by `/iap/notify/apple`. An app has one of each of the two URLs, so the DEV server does not receive Apple store notifications. The key of `iapApple.keyId` and `secrets.iapApple` is an In-App Purchase key made in App Store Connect
- If an environment's `adapters.iap-google` is `iap-google`, a human prepares the following
  - In Google Play Console, gives the `iapGoogle.serviceAccountEmail` service account the permission to view the financial data of that app and the permission to manage orders and subscriptions
  - Creates a Google Cloud Pub/Sub topic, gives `google-play-developer-notifications@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic, then sets that topic as the real-time developer notifications topic of that app in Google Play Console
  - Creates a push subscription of that topic for each environment that is `iap-google`. The endpoint is that environment's `serverUrl` followed by `/iap/notify/google`, the authentication service account is `iapGoogle.notificationServiceAccountEmail`, and the audience is the same URL as the endpoint
- If an environment's `adapters.iap-apple` or `adapters.iap-google` is not `fake`, before a build of that environment first includes an SKU of `iap_product`, a human creates the product of that SKU in the store and leaves it in a state where it can be sold. In App Store Connect it is made with `sku_apple` as the product ID, as Consumable when `type` is `Consumable`, Non-Consumable when `NonConsumable`, and Auto-Renewable Subscription when `Subscription`. In Google Play Console it is made with `sku_google` as the product ID, as an in-app product for `Consumable` and `NonConsumable` and as a subscription for `Subscription`

A human deploys PROD. `ogw build report` puts the order below and the file paths of this build into `## deploy` of the PROD build report.

1. For an app build, fills App Store Connect App Privacy and Google Play Console Data safety from the drafts of build report `## store privacy`, sets the account deletion URL of Google Play Console to that address, then submits the app to the store, and does not release it until 4 is done even when it passes review. When there is a web artifact, uploads only the version folder, with the same `Cache-Control` and `Content-Type` as the files of the STG version folder of the same version, and does not change the entry page
2. Uploads the update files with `put_update_file`
3. Turns on, with `set_kill_switch`, `StartPlaySession` when the server module list has `play-session` and `MATCH_REQUEST` when it has `matchmaker`, and waits from the time they were turned on until the match wait duration passes. The match wait duration is the ms value that `ogw build run` of the PROD build calculates from the data and core settings of the last PROD build and that `ogw build report` writes into this order: the largest value among `max_duration` of `play_session_mode` and `prepare_time` + `max_duration` + `matchmaker.reportMarginMs` of `match_mode`, plus `admin-api.switchCacheMs`. This is so that the server and data change after the results of the matches started in the meantime are applied. When there is no last PROD build, the match wait duration is `none` and there is no wait. A bundle patch without a server image skips 3
4. Deploys the server image with container argument `--env PROD`. For a realtime game, adds `--matchmaker` to only one of those processes. The container ports and secrets follow [server image of `server-core`](../server-core/server-image.md). The DB is PostgreSQL of game settings `postgresqlMajor`. The reverse proxy and, when `turn` is `turn-coturn`, the coturn server keep the same rules as DEV and STG. Container logs rotate with the values of PROD `containerLog` by the container log rule. A bundle patch without a server image skips 4 and 5. For a `protocol change` build, before the deploy, `min_version` of deploy list `app` must be at least the app version of the last PROD build. This server accepts the requests of the last PROD build's app and of the new app together, and does not accept apps of an earlier protocol. When `## converters` of the build report is not `none` or the two `coreSchemaVersion` of `## core schema` differ, the processes of the previous server and the new server are not run together. The new server is started after all processes of the previous server are stopped. This is because the processes of the previous server answer `INTERNAL` to requests that read rows the new server converted and saved, and do not know the core schema the new server changed. Before stopping them, posts a notice whose `kind` is `Maintenance` and `start_at` is the current time with `notice` `put_notice`, calls `admin-api` `set_maintenance` (`enabled` `true`), and stops them after `admin-api.switchCacheMs` has passed
5. Calls `start_migration_batch` and waits until the batch ends. When maintenance was turned on in 4, calls `set_maintenance` (`enabled` `false`) after the batch ends and deletes the notice of 4 with `delete_notice`
6. Gets the current deploy list with `get_deploy_list` and keeps it, then calls `publish_deploy_list`. `app` and `patches` are set from the kept deploy list by the deploy list rule
7. Turns off the kill switches turned on in 3 with `set_kill_switch`
8. For an app build, releases the app in the store. When there is a web artifact, switches the entry page to this version and sets its `Cache-Control` and `Content-Type` the same as the STG entry page. Then sets `min_version` and `recommended_version` of deploy list `app` and publishes again. For a `protocol change` build, `min_version` is raised to the new app version after the new app has spread

`## deploy` of the PROD build report also carries the rollback order below.

1. Posts a notice whose `kind` is `Maintenance` and `start_at` is the current time with `notice` `put_notice`, calls `admin-api` `set_maintenance` (`enabled` `true`), then stops all processes of the new server when `admin-api.switchCacheMs` has passed
2. Deploys the server from the digest of `## server image` of the previous PROD build report by the same rules as PROD deploy 4. When the server has started, calls `set_maintenance` (`enabled` `false`) and deletes the notice of 1 with `delete_notice`
3. Calls `publish_deploy_list` with `app` and `patches` of the deploy list kept in PROD deploy 6, plus one entry for each app version in `apps` of this build's `update/update.json` that is not in the kept `patches`. The `data_version`, `data_files` and `translation_files` of an added entry are the values of the previous PROD build's app version entry in the kept `patches`, and `bundle_files` is an empty list. So the app of this build receives the data of the rolled-back server instead of built-in data

`## deploy` of the PROD build report also carries the maintenance order: Turns on the kill switches as in PROD deploy 3, waits for the match wait duration, then turns on `set_maintenance`. After maintenance is turned off, turns off those kill switches

`ogw build report` writes `## deploy` of the PROD build report as the lines `deploy order`, `rollback order` and `maintenance order`, each followed by its order, and under a step adds the values of this build and the skipped parts as lines starting with `   - `.

- The values, by step, are PROD deploy 1 `artifacts: <artifact path, ...>`, 2 `update files: <update file path, ...>`, 3 `match wait ms: <match wait duration>`, 4 `server image: <name>@<digest>`, rollback 2 `previous server image: <server image of the previous PROD build>`, rollback 3 `update.json: builds/prod-<version>/update/update.json`, and maintenance order `match wait ms: <match wait duration>`. When there is no value, it is `none`
- The skipped parts, by step, are `skipped: bundle patch without server image` on PROD deploy 3, 4 and 5 of a bundle patch without a server image, `skipped part: protocol change (not a protocol change build)` on PROD deploy 4 and 8 when the build is not a `protocol change` build, and `skipped part: maintenance (converters none and the same coreSchemaVersion)` on PROD deploy 4 and 5 when `## converters` is `none` and the two `coreSchemaVersion` are equal
