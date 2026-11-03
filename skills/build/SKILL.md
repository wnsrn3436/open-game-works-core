---
name: build
description: Covers the procedure of the `build` command (hardening, hardening record, one pass of game-loop iteration steps 2 to 6 with PostgreSQL, build-time check, per-platform build and signing, server image, tag, DEV and STG deploy), bundle patch, backward compatibility check, store privacy disclosure, web hosting and the PROD deploy order. Read when receiving the `build` command, when the server hardening agent and the client hardening agent work, when setting the signing key in `setup game`, and when the core agent writes per-engine build rules
---

# build

## procedure

`<env>` is the environment name. In command arguments it is uppercase (`DEV`, `STG`, `PROD`), and inside other names, paths, branches, tags and image tags it is lowercase (`dev`, `stg`, `prod`).

1. Runs `ogw build start <game> <env> [<platform>...] [--version <version>] [--bundle-for <app version>]`. When it succeeds, it prints the run name, the version and the branch: the version is set, branch `build/<env>-<version>` is created and checked out, the run name is `build-<env>-<version>`, and `records/loops/<run>/` exists. When it exits with a nonzero code, it made nothing, and the lead agent acts on what it output
   - build stage values missing (items whose `x-stage` is `build` in the game settings schema): asks the human and fills them by the build stage value rules of [`game-setup`](../game-setup/SKILL.md) 5, then runs `ogw secret generate <game> <environment>` for each environment that had missing values (also PROD when PROD values were missing in an STG build), commits the changed `settings.json` to main and starts again
   - failed human checks: stops and tells the human the human target of each failed human check
   - an `ogw judge calibrate` job of the game runs: waits and runs the command again by `## judge calibration` of [`game-loop`](../game-loop/SKILL.md)
   - any other failure: stops and tells the human what it output
2. Calls the server hardening agent and the client hardening agent together with `--background`. For STG, also calls the sub-agents of placeholder handling at the same time. `ogw agent` creates a separate worktree from the build branch for each agent, and each hardening agent writes and commits its hardening record in that worktree. The lead agent waits for the two hardening agents with `ogw agent wait <id>`, then merges them into the build branch one after the other with `ogw agent merge <id>`. When a merge is not merged with reason `conflict` or `outside scope`, calls that agent again with the same input. For any other reason, stops and reports to the human
3. Each round, writes the finding file with `ogw loop findings <game> --hardening`, fills it by `## defect list` of `game-loop`, then puts it into the defect list with `ogw loop record <game> --hardening`. When `## content agent fixes` of this round's hardening record has items, runs one fix iteration, then returns to 2. A fix iteration is an iteration that does iteration steps 1, 2, 5 and 6 of `game-loop` in this order on the hardened code. Step 2 runs with `ogw check <game> --loop --db postgresql`, and steps 3 and 4 are not done, whatever the result
4. Runs iteration steps 2 to 6 of `game-loop` once with the hardened code. Does not do step 8 (stop judgement). The instance DB is PostgreSQL. Step 2 runs with `ogw check <game> --loop --db postgresql`, and steps 3 and 4 with `ogw loop evaluate <game> --db postgresql`. When `ogw check` outputs `gate: fail` or `vs baseline` of the judge result is `worse`, runs one fix iteration, then returns to 2. For the performance and UI quality results, does not return to 2 and puts them in the build report. Check `placeholder` of 5 judges `no placeholder`
5. For STG, waits for `ogw loop sync <game> --wait --background` with `ogw job wait <id>` to merge all placeholder handling sub-agents. Then does the build-time checks and the per-platform build with `ogw build run <game>`. When a human check fails, check `native plugin` fails or the STG placeholder check fails, stops and reports to the human without returning to 2. When another check fails, has the content agent fix it in a fix iteration and returns to 2
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

## hardening

What the server hardening agent looks for is `## hardening` of [`server-content`](../server-content/SKILL.md), and what the client hardening agent looks for is `## hardening` of [`client-content`](../client-content/SKILL.md).

The path of a hardening record is `records/hardening/<env>-<version>-<server|client>-<round>.md`. `<round>` is the number of hardening records of the same `<env>-<version>-<server|client>` in `records/hardening/` of the build branch plus 1, as `ogw agent` counts it. `ogw agent` passes this path as `output` inside the hardening agent worktree.

| heading | contents |
|---|---|
| `## changes` | Per fixed place: file:line, the problem found, the fix, the tests added |
| `## content agent fixes` | A table with columns `file:line`, `owner`, `problem`, `task`. One row per item: `file:line` is the place to fix, `owner` is `contract` when the file to fix is contract, `data` when data, `server content` when server content code, `client content` when client content code, `problem` is the problem, and `task` is what the content agent does. `none` when there are none |
| `## unknown` | What could not be checked, what is unknown, and why |

## build-time check

`ogw build run` runs these before the platform build. When any fails, it does not build. When a check cannot run to the end for a reason the table below does not set as `unknown` (e.g. an export, instance, device or browser error, or a harness settings `tools` program missing on this host), that check fails, and a check that only warns in a DEV build is a warning in a DEV build. As an exception, the build artifact and archive check of the `secret` check, the made package check of `DEV code` and the `bundle` check run at or after the platform build or the bundle export, and when one fails, the build fails.

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
| native plugin | In an STG or PROD build, the core release of the game settings core version lacks a native plugin that the build of a target platform needs, or the signing of that platform does not grant an entitlement that such a plugin needs, by `## native plugin` of the build document of the engine |
| DEV code | An STG or PROD build contains `client/dev/`, `server/dev/` or core's `dev/`. Code that is not DEV code references DEV code |
| debug text | An STG or PROD build has debug text of [`client-content`](../client-content/SKILL.md) |
| adapter | `push-apns` of the DEV `adapters` in game settings is `push-apns`. STG `adapters` has `fake` or `push-apns-sandbox`. Among the STG `adapters` keys other than `push-apns`, the value of a key for which the module spec that uses the key defines an adapter name ending in `-sandbox` does not end in `-sandbox`. e.g. `iap-apple` is `iap-apple`. PROD `adapters` has `fake` or a name ending in `-sandbox`, or has no `cdn`. In an STG or PROD ios build, that environment's `adapters` has `login-google` but no `login-apple`. The target platforms include web but that environment's `adapters.cdn` is not `cdn-r2` |
| admob | `ads` of that environment's `adapters` in game settings is `ads-admob`, and `admob.appIdAndroid` when the target platform is android, or `admob.appIdIos` when it is ios, is missing or an empty string. That environment's `adUnits` has an `ad_placement` row without an ad unit ID for the target platform. An ad unit ID of the target platform equals an ad unit ID of another placement of that environment or of another environment's `adUnits` |
| banned word | In an STG or PROD build, the modules the game uses include one of `nickname`, `guild`, `chat`, but `data/tables/banned_word.csv` has no row that is built. A DEV build only warns |
| secret | The repo, a build artifact or an archive contains a secret or an absolute path of the workspace. The `dev_access` value in the build info file of a DEV build is not treated as a secret |
| placeholder | There is a placeholder resource, missing translation or stale translation. A DEV build only warns |
| license | An STG or PROD build has a resource whose `license` in `resources.csv` is `unknown`. A DEV build only warns |
| privacy | An STG or PROD build has no game settings `privacy`. Among the adapters chosen in that environment's `adapters` that are not `fake`, there is an adapter for which `core-spec.json` of the modules the game uses has no `collectedData` row with its name (with a trailing `-sandbox` removed) as `source`. A DEV build only warns |
| device performance | In an android build, the result of running the bot playtest scenario on a DEV export of the same commit started on an android device of harness settings `testDevices` is `fail` by the `## performance` judgement of [`ogw`](../../tools/ogw.md), or the app did not boot on the device (crash, `Halted`, error log, timeout), or `client/dev/bot/scenario.json` is not in its defined format. A DEV build only warns. When the target platform is not android, `testDevices` has no android device, or in a realtime game UDP does not reach between that device and the host, it reports `unknown` and does not block |
| web smoke | In a web build, no blocker or full flow of the result of running the bot playtest scenario on a DEV web export of the same commit opened in the headless browser of harness settings `tools.chromium` is `fail`. A DEV build only warns. Runs only when the target platforms include web |
| backward compatibility | Violation of the backward compatibility rules |
| bundle | Violation of `## bundle patch` of [`ogw`](../../tools/ogw.md). The failure lines name each violation |

## platform build

- The platforms are those named in the command, or all of game settings `buildPlatforms` when none are named
- All chosen platforms are built on this host. iOS and macOS are built only on a Mac host
- The chosen platforms are built in parallel. Each platform gets its own clean checkout of the build branch as its build workspace, and artifacts go in `builds/<env>-<version>/<platform>/` of the game repo
- Signing of each platform is one of the below. web and linux are not signed
  - STG and PROD builds, and DEV builds with `signing.<platform>` in game settings, make signed artifacts
  - free signing: DEV builds of android, macos and windows without `signing.<platform>`. android is signed with the debug keystore, macos is ad-hoc signed and not notarized, and windows is not signed. As an exception, macos whose DEV `adapters.login-apple` is `login-apple` has no free signing. An ad-hoc signed app does not launch with the `com.apple.developer.applesignin` entitlement. ios has no free signing
  - In a build without free signing, a missing `signing.<platform>` is output as a missing value by `ogw game check --build` and `ogw build start`
- The secret name used for signing is game settings `signing`, and the value is read from the host secret store. Secrets are not left as files in the repo or artifacts. As an exception, the build info file of a DEV build holds the value of secret `environments.DEV.secrets.devAccess` in `dev_access`
- Only STG builds go to external beta (TestFlight public link, Google Play open testing and closed testing, direct download for testers). PROD builds go only to store review, internal testing and release, and PROD macos to direct distribution (Steam, itch.io, web download). This is because the PROD server also grants for test transactions
- macos is signed with a Developer ID Application certificate and distributed directly, not through the Mac App Store and TestFlight
- The build document of an engine ([godot](engines/godot.md)) defines `## signing` (the signing key table that `ogw game check` reads, and what a human prepares) and `## native plugin` (the plugins a build needs and their conditions). `## <engine> build` of [`ogw`](../../tools/ogw.md) defines what the harness tool does for that engine: the export steps per platform, the export preset values, the platform table (preset `platform`, architecture, output file), the bundle export and its check items, the signing steps, and the procedures of checks `device performance` and `web smoke`

## store privacy disclosure

Before the platform build, `ogw build run` makes the store privacy disclosure drafts in `builds/<env>-<version>/privacy/` from the declarations of `## collected data` of [`core`](../core/SKILL.md) and game settings `privacy.contentData`.

| file | made when | contents |
|---|---|---|
| `PrivacyInfo.xcprivacy` | The target platforms include ios | The iOS privacy manifest. Included in the ios build |
| `app-store.md` | The target platforms include ios or macos | Draft App Store Connect App Privacy answers |
| `google-play.md` | The target platforms include android | Draft Google Play Console Data safety answers and the account deletion URL |

## server image

- There is one server image per build regardless of platform. For DEV and STG builds, `ogw build run` of 5 makes the server image for game settings `serverImage.platform` with `docker buildx` and pushes it to `serverImage.repository` with image tag `<env>-<version>`
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
| save schema | When the current contract version is greater than the contract version of the last PROD build, `## save schema check` of [`ogw`](../../tools/ogw.md) must have no failure |

- While there is no PROD tag, the DEV and STG DBs are emptied on each build
- The PROD server can be rolled back to a previous build only when the builds in between added no converter and did not raise `coreSchemaVersion`. When a converter was added, the rolled-back server answers `INTERNAL` to a request that reads a row of that kind with a higher contract version. When `coreSchemaVersion` was raised, the rolled-back server does not start. A change that only adds `?` columns to a table registered in `storage` does not block a rollback. Rows of UserState, server state and game state kinds that the builds in between added also do not block a rollback. The rolled-back server skips those rows without deleting them (unknown kind row of [`storage`](../server-core/modules/storage.md)), and when the server of the new build is started again, it reads those rows. After the app of a `protocol change` build is released in a store or the web entry page is changed, the PROD server is not rolled back to a build before that build. The `client_data_version` and `compat_client_data_version` of the rolled-back server do not have the protocol hash of the new app, so every request of the new app gets `APP_UPDATE_REQUIRED`
- A change that cannot keep these rules is resolved with a migration, and when that still cannot resolve it, stops and reports to the human

### protocol change

- A build whose Client build target data version has a protocol hash that differs from that of the last PROD build is a `protocol change` build

## bundle patch

A bundle patch starts with `ogw build start <game> <env> --bundle-for <app version>`, and its procedure is the same as the build procedure. Its results are the bundle, the data and the server image built with that data. When it does not carry data, it makes no server image.

- A bundle patch build writes `<app version>-bundle-<n>` in the version position (build branch, run name, `builds/` folder, tag, image tag). The tag format follows AGENTS.md `## branch`
- A bundle patch carries data when the data version of the Client build target or the Server build target of the build commit differs from that of the `<env>-<app version>` tag commit of the target app version
- Bundle patch tags are not counted when setting the version and when finding the commit PROD starts from
- When the `<env>-<app version>` tag of the target app version does not exist, `ogw build start` stops and tells the human
- A PROD bundle patch starts from the most recent commit of main that has an `stg-<app version>-bundle-<n>` tag. When there is no such commit, stops and reports to the human
- A bundle patch does not delete or rename elements that code or data refer to by name. No check reads deleted or renamed elements, so the `bundle` check does not block this

## web hosting

The web build is served from that environment's `cdn-r2` bucket (game settings `environments.<ENV>.cdnR2`). The web origin is the origin of `cdnR2.publicBaseUrl`. It is the same origin as `file_base_url` of the update files, so there is no CORS when the client receives files. The web artifact is all files the build put in `builds/<env>-<version>/web/`.

- cross-origin isolation: the cross-origin isolation that a Web export with threads needs is obtained by the service worker of the web artifact adding `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to the pages in the version folder and the responses to the requests of those pages. The scope of the service worker is the version folder, so each version registers its own service worker on its first load
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
- A human changes `app` of the deploy list (`min_version`, `recommended_version`, `store_url`)
- PostgreSQL major upgrade: when `ogw build start` stops because the major of harness settings `tools.postgresql` `tag` differs from game settings `postgresqlMajor`, the lead agent tells the human this procedure. When there is no PROD tag, a human changes `postgresqlMajor` to the new major. When a PROD tag exists, a human moves the DEV and STG DB volumes and the PROD DB to a cluster of the new major with `pg_dump` of the `postgresqlMajor` major and `pg_restore` of the new major, checks on the new cluster that `pg_restore` ended without an error and that every table has the row count of the old cluster, then changes `postgresqlMajor` to the new major
- The `host` of game settings `environments.<ENV>.deploy` is prepared by a human: Docker Engine and Docker Compose, permission for `deploy.user` to use Docker and to create and write `deploy.dir`, `authorized_keys` of `deploy.user` holding the public key of that environment's `secrets.deploySsh` private key, a `ghcr.io` login that can pull `serverImage.repository`, a reverse proxy that passes HTTPS requests of `serverUrl` and the WebSocket upgrade of `GET /realtime` to `127.0.0.1:<deploy.port>` and appends the client IP to the end of `X-Forwarded-For`, and a log collector that keeps the logs of the server and PostgreSQL containers before rotation deletes them. The number of that proxy plus the proxies in front of it equals that environment's `trustedProxyCount`
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

1. For an app build, fills App Store Connect App Privacy and Google Play Console Data safety from the drafts of build report `## store privacy`, sets the account deletion URL of Google Play Console to the URL in build report `## store privacy`, then submits the app to the store, and does not release it until 4 is done even when it passes review. When there is a web artifact, uploads only the version folder, with the same `Cache-Control` and `Content-Type` as the files of the STG version folder of the same version, and does not change the entry page
2. Uploads the update files with `put_update_file`
3. Turns on, with `set_kill_switch`, `StartPlaySession` when the server module list has `play-session` and `MATCH_REQUEST` when it has `matchmaker`, and waits from the time they were turned on until the match wait duration passes. The match wait duration is the ms value that `ogw build run` of the PROD build calculates from the data and core settings of the last PROD build and that `ogw build report` writes into this order: the largest value among `max_duration` of `play_session_mode` and `prepare_time` + `max_duration` + `matchmaker.reportMarginMs` of `match_mode`, plus `admin-api.switchCacheMs`. This is so that the server and data change after the results of the matches started in the meantime are applied. When there is no last PROD build, the match wait duration is `none` and there is no wait. A bundle patch without a server image skips 3
4. Deploys the server image with container argument `--env PROD`. For a realtime game, adds `--matchmaker` to only one of those processes. The container ports and secrets follow [server image of `server-core`](../server-core/server-image.md). The DB is PostgreSQL of game settings `postgresqlMajor`. The reverse proxy, the log collector and, when `turn` is `turn-coturn`, the coturn server keep the same rules as DEV and STG. Container logs rotate with the values of PROD `containerLog` by the container log rule. A bundle patch without a server image skips 4 and 5. For a `protocol change` build, before the deploy, `min_version` of deploy list `app` must be at least the app version of the last PROD build. This server accepts the requests of the last PROD build's app and of the new app together, and does not accept apps of an earlier protocol. When `## converters` of the build report is not `none` or the two `coreSchemaVersion` of `## core schema` differ, the processes of the previous server and the new server are not run together. The new server is started after all processes of the previous server are stopped. This is because the processes of the previous server answer `INTERNAL` to requests that read rows the new server converted and saved, and do not know the core schema the new server changed. Before stopping them, posts a notice whose `kind` is `Maintenance` and `start_at` is the current time with `notice` `put_notice`, calls `admin-api` `set_maintenance` (`enabled` `true`), and stops them after `admin-api.switchCacheMs` has passed. The server has started when it answers `GET /update/deploy_list.json` with HTTP 200 or 404
5. Calls `start_migration_batch` and waits until the batch ends. When maintenance was turned on in 4, calls `set_maintenance` (`enabled` `false`) after the batch ends and deletes the notice of 4 with `delete_notice`
6. Gets the current deploy list with `get_deploy_list` and keeps it, then calls `publish_deploy_list`. `app` and `patches` are set from the kept deploy list by the deploy list rule
7. Turns off the kill switches turned on in 3 with `set_kill_switch`
8. For an app build, releases the app in the store. When there is a web artifact, switches the entry page to this version and sets its `Cache-Control` and `Content-Type` the same as the STG entry page. Then sets `min_version` and `recommended_version` of deploy list `app` and publishes again. For a `protocol change` build, `min_version` is raised to the new app version after the new app has spread

`## deploy` of the PROD build report also carries the rollback order below.

1. Posts a notice whose `kind` is `Maintenance` and `start_at` is the current time with `notice` `put_notice`, calls `admin-api` `set_maintenance` (`enabled` `true`), then stops all processes of the new server when `admin-api.switchCacheMs` has passed
2. Deploys the server from the digest of `## server image` of the previous PROD build report by the same rules as PROD deploy 4. The server has started when it answers `GET /update/deploy_list.json` with HTTP 200 or 404. Then calls `set_maintenance` (`enabled` `false`) and deletes the notice of 1 with `delete_notice`
3. Calls `publish_deploy_list` with `app` and `patches` of the deploy list kept in PROD deploy 6, plus one entry for each app version in `apps` of this build's `update/update.json` that is not in the kept `patches`. The `data_version`, `data_files` and `translation_files` of an added entry are the values of the previous PROD build's app version entry in the kept `patches`, and `bundle_files` is an empty list. So the app of this build receives the data of the rolled-back server instead of built-in data

`## deploy` of the PROD build report also carries the maintenance order: Turns on the kill switches as in PROD deploy 3, waits for the match wait duration, then turns on `set_maintenance`. After maintenance is turned off, turns off those kill switches
