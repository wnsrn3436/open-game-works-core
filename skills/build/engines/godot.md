# Godot build

- export
- export preset
- platform
- bundle export
- signing
- device performance
- web smoke

## export

`ogw build run` does the steps below in this order for each platform in the build workspace.

1. Puts the `plugins` of `engine.json` for that platform into `addons/` and `ios/plugins/`. For android, puts the Android build template into `android/build/` and writes the `res://` paths of all `addons/<folder>/plugin.cfg` (the editor plugin of a Godot Android plugin v2) of the added plugins, in byte order, into `[editor_plugins]` `enabled` (`PackedStringArray`) of `project.godot`. The export plugin of an editor plugin that is not enabled does not add the `.aar` and its dependencies. A `.gdextension` plugin has no setting that enables it, because Godot reads it in the project scan
2. For STG and PROD, changes the `LogCore.log_debug(...)` lines by the `LogCore` row of `engines/godot.md` `## engine behavior` of the `client-core` skill
3. Writes `generated/build_info.json` and `application/config/version` of `project.godot`. `generated/build_info.json` is a JSON object keyed by the `BuildInfo` field names of `BootstrapCore`: `app_id` is game settings `appId`, `app_version` is the version, `environment` is the environment name, `platform` is the platform, `server_url` is that environment's `serverUrl` (an empty string when there is none), `game_update_url` is `server_url` followed by `/update/deploy_list.json`, `update_trust_keys` is a `{key_id, public_key}` for each item of that environment's `updatePublicKeys` (`key_id` is the key ID of `game-update`), `adapters` is that environment's `adapters`, `ad_units` is the ad unit IDs of that platform keyed by the ID value of the placement (read from `id_registry.json` of the `id-registry` branch) as a decimal string, and `instance_id` is an empty string. DEV adds the value of DEV secret `devAccess` as `dev_access`. When a placement of `adUnits` is not in `id_registry.json`, it fails
4. Writes `export_presets.cfg`
5. Puts in the signing values. For ios, does the keychain and provisioning profile preparation of `## signing`
6. `godot --headless --path client --import`
7. Runs `godot --headless --path client --export-<debug|release> "<preset>" <output file>` with `--export-debug` for DEV and `--export-release` for STG and PROD. For ios when game settings `consent.trackingRequest` is `true`, it then puts the localized `NSUserTrackingUsageDescription` into the `.ipa` before the keychain of `## signing` is deleted: it unpacks the `.ipa` with `ditto -x -k`, and for each language of game settings `supportedLanguages` writes `NSUserTrackingUsageDescription` of `Payload/<app>.app/<language with `-` replaced by `_`>.lproj/InfoPlist.strings` (made with `plutil -create xml1` when it does not exist) as the text of that language with `plutil -replace`. The text is the translation of reserved string `[auth_tracking_usage]`, and the source text for a missing translation. Then it re-signs the app bundle with `codesign --force` using the entitlements read with `codesign -d --entitlements <file> --xml`, the signing identity of that environment (DEV `Apple Development`, STG and PROD `Apple Distribution`) and the keychain of `## signing`, and packs `Payload` into the `.ipa` again with `ditto -c -k --sequesterRsrc --keepParent`
8. When the exit code is not 0 or a named output file (the files starting with `<game>`, `index.html` for web) is missing, it fails
9. When the file list inside the made package has a target of `exclude_filter`, or the app bundle root inside the ios `.ipa` has no `PrivacyInfo.xcprivacy`, it fails
10. For windows without free signing, signs the output files by `## signing`. When signing fails, it fails

### export preset

- There is one preset per platform and environment, named `<platform>-<lowercase environment>`. e.g. `android-prod`. `export_presets.cfg` is written only in the build workspace and is not committed
- `export_filter` is `all_resources`, and `include_filter` is `build/data/*,generated/*.json`
- `exclude_filter`

  | environment | value |
  |---|---|
  | DEV | `tests/*,addons/gut/*,generated/launch_values.json` |
  | STG, PROD | `tests/*,addons/gut/*,dev/*,core/*/dev/*,generated/core_settings_types.json,generated/launch_values.json` |

- The app ID is game settings `appId`. It is `package/unique_name` for android, and `application/bundle_identifier` for ios and macos
- When `ads` of that environment's `adapters` in game settings is `ads-admob`, writes the ads SDK app ID. For android it is `admob.appIdAndroid` in meta-data `com.google.android.gms.ads.APPLICATION_ID` of `android/build/AndroidManifest.xml`, and for ios it is `admob.appIdIos` in Info.plist key `GADApplicationIdentifier`
- iOS entitlements are written with `entitlements/push_notifications` and `entitlements/additional` of the ios preset. `entitlements/push_notifications` is `Production` when that environment's `adapters.push-apns` is `push-apns`, `Development` when it is `push-apns-sandbox`, and `Disabled` otherwise. `entitlements/additional` is `com.apple.developer.applesignin` (an array with the one value `Default`) when `adapters.login-apple` is `login-apple`, and an empty string otherwise. For the macOS entitlement, a plist holding only `com.apple.developer.applesignin` is written in the build workspace, and `codesign/entitlements/custom_file` of the macos preset points to it. `provisioningProfile` of macos signing is passed to `codesign/provisioning_profile` of the macos preset
- The privacy manifest items of the ios preset are written from the values of the build's `PrivacyInfo.xcprivacy`. `privacy/tracking_enabled` is `NSPrivacyTracking`, and `privacy/tracking_domains` is an empty list. For each item of `NSPrivacyCollectedDataTypes`, writes `privacy/collected_data/<key>/collected` as `true`, and `privacy/collected_data/<key>/linked_to_user`, `used_for_tracking` and `collection_purposes` as the linked, tracking and purpose of that item. `collection_purposes` is an integer that adds one bit per purpose: `Analytics` 1, `AppFunctionality` 2, `DeveloperAdvertising` 4, `ThirdPartyAdvertising` 8, `ProductPersonalization` 16, `Other` 32 (the names are the values without `NSPrivacyCollectedDataTypePurpose`). `<key>` is the snake_case of the name left after removing the leading `NSPrivacyCollectedDataType` from the `NSPrivacyCollectedDataType` value. e.g. `NSPrivacyCollectedDataTypeUserID` → `user_id`. The required reason API items (items whose name starts with `privacy/` and ends with `_access_reasons`) use the export preset defaults
- For Google Sign-In, writes `loginGoogle.iosClientId` in Info.plist key `GIDClientID` of ios, and its reversed client ID (the parts split by `.` in reverse order) in `CFBundleURLSchemes` of `CFBundleURLTypes`
- The keys added to the ios Info.plist are written as XML of `<key>` and value in `application/additional_plist_content` of the ios preset: `GADApplicationIdentifier` (ads), `GIDClientID` and `CFBundleURLTypes` (Google Sign-In), and `NSUserTrackingUsageDescription` (the source text of reserved string `[auth_tracking_usage]`) when game settings `consent.trackingRequest` is `true`
- The ios preset writes `plugins/<name>` as `true` for each `.gdip` under `ios/plugins/` of the plugins added in 1. `<name>` is `[config]` `name` of that `.gdip`. A `.gdip` plugin that is not enabled is not included in the export
- The ios preset's other values: `architectures/arm64` is `true`, `application/bundle_identifier` is the app ID, `application/app_store_team_id` is game settings `appleTeamId`, `application/version` is the version code, and `application/short_version` is the version
- The android Firebase config file is `android/build/google-services.json`. `project_info.project_number`, `project_info.project_id`, `client[0].client_info.mobilesdk_app_id`, `client[0].client_info.android_client_info.package_name` and `client[0].api_key[0].current_key` get `projectNumber`, `projectId`, `appIdAndroid` of `fcm`, game settings `appId` and `apiKeyAndroid` of `fcm`
- version code: android `version/code` and ios `application/version` are (major × 1000000 + minor × 1000 + patch) × 10 + environment number. The environment number is DEV 0, STG 1, PROD 2. android `version/name` and ios `application/short_version` are the version as it is. When major is more than 209, or minor or patch is more than 999, the android and ios exports fail
- android has `gradle_build/use_gradle_build=true` and `permissions/internet=true`
- The app display name is `application/config/name` and `application/config/name_localized` of `project.godot`. For windows, the source text of reserved string `[app_name]` is also written in `application/product_name`
- icon: the items below get resource `app_icon/main` converted to the size (width and height in pixels) and format of that item. The converted files are kept only in the build workspace
  - android: `launcher_icons/main_192x192`(192), `launcher_icons/adaptive_foreground_432x432`(432)
  - ios: PNG without an alpha channel. `icons/icon_1024x1024`(1024), `icons/app_store_1024x1024`(1024), `icons/settings_58x58`(58), `icons/settings_87x87`(87), `icons/notification_40x40`(40), `icons/notification_60x60`(60), `icons/notification_76x76`(76), `icons/notification_114x114`(114), `icons/spotlight_80x80`(80), `icons/spotlight_120x120`(120), `icons/iphone_120x120`(120), `icons/iphone_180x180`(180), `icons/ipad_152x152`(152), `icons/ipad_167x167`(167), `icons/ios_128x128`(128), `icons/ios_136x136`(136), `icons/ios_192x192`(192). `icons/icon_1024x1024_dark` and `icons/icon_1024x1024_tinted` are left empty
  - macos: `application/icon`(1024)
  - windows: `application/icon`(256, `.ico`)
- `generated/launch_values.json` is written only for the exports of checks `device performance` and `web smoke`. The preset of those exports is the DEV preset with `generated/launch_values.json` removed from `exclude_filter`

### platform

| platform | preset `platform` | architecture | output file |
|---|---|---|---|
| android | `Android` | `arm64-v8a`, `armeabi-v7a` | `<game>.aab` (`gradle_build/export_format=1`) for STG and PROD, `<game>.apk` (`0`) for DEV |
| ios | `iOS` | `arm64` | `<game>.ipa` |
| macos | `macOS` | `universal` | `<game>.zip` |
| windows | `Windows Desktop` | `x86_64` | `<game>.exe`, `<game>.pck` and all files the export wrote in the same folder (GDExtension libraries and the libraries they use) |
| linux | `Linux` | `x86_64` | `<game>.x86_64`, `<game>.pck` and all files the export wrote in the same folder (GDExtension libraries and the libraries they use) |
| web | `Web` | none | `index.html` and all files produced with it (including `index.service.worker.js`, `index.manifest.json`, `index.offline.html` and icon `.png`). `variant/thread_support=true`, `progressive_web_app/enabled=true`, `progressive_web_app/ensure_cross_origin_isolation_headers=true`, `html/custom_html_shell` is `res://core/web/ogw-shell.html`, and after the export `index.service.worker.js` is replaced with `core/web/service-worker.js` |

- `<game>` is the game folder name

### bundle export

In a bundle patch build, `ogw build run` makes the bundle files in the order below instead of the platform export. All platforms use one set of bundle files.

1. `godot --headless --path client --import`
2. For each resource key to include, picks files for each file of that key in the `ResourceCore` resource key list file of `engines/godot.md` of the `client-core` skill (all variant files when the variant count is 2 or more). For an imported file, these are the file with `.import` appended to that path and all files in `[deps]` `dest_files` of that file; otherwise, the file at that path
3. Packs the picked files at the same paths with Godot `PCKPacker`. Keys are packed in byte order, and when packing the files of the next key would make the `.pck` exceed the smaller of `game-update.maxFileBytes` and `GameUpdateCore.fileMaxBytes`, a new `.pck` is started. The bundle name of the n-th `.pck` is `patch_<n>` and its file name is `patch_<n>.pck`, with n starting at 1
4. Each `.pck` gets the key list file of the keys packed in that `.pck`. The path and format follow `ResourceCore` attaching a bundle in `engines/godot.md` of the `client-core` skill
5. The bundle check fails when one of the below holds
   - The files of one key and the key list file alone exceed the limit
   - A `.pck` has a path that is not the key list file and is outside `res://resource/` and `res://.godot/imported/`
   - A `.pck` has a `.gd` or `.gdc` file, or a packed `.tscn` or `.tres` has `type="GDScript"`

## signing

- Key names per platform of the game settings `signing` secret

  | platform | key |
  |---|---|
  | android | `keystore`(base64 keystore file), `password` |
  | ios | `developmentCertificate`(base64 p12, Apple Development), `developmentCertificatePassword`, `developmentProvisioningProfile`(base64, iOS App Development), `distributionCertificate`(base64 p12, Apple Distribution), `distributionCertificatePassword`, `distributionProvisioningProfile`(base64, App Store) |
  | macos | `certificate`(base64 p12), `certificatePassword`, `provisioningProfile`(base64), `notaryApiKey`(base64) |
  | windows | `clientSecret`(client secret of the game settings `trustedSigning.clientId` app) |

- Values that are files are unpacked into a temporary folder outside the build workspace and the game repo, and deleted when the export ends
- android passes them through the environment variables `GODOT_ANDROID_KEYSTORE_DEBUG_PATH`, `GODOT_ANDROID_KEYSTORE_DEBUG_USER`, `GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD` (DEV) and `GODOT_ANDROID_KEYSTORE_RELEASE_PATH`, `GODOT_ANDROID_KEYSTORE_RELEASE_USER`, `GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD` (STG and PROD) of the export process. `_PATH` is the file unpacked from `keystore`, `_USER` is game settings `androidKeyAlias`, and `_PASSWORD` is `password`
- The signing values of ios and macos and the game settings `macosNotary` values of macos are written in `.godot/export_credentials.cfg` of the build workspace and deleted when the export ends. Signing values are not written in `export_presets.cfg`
- In the signing items of the macos preset, `codesign/codesign` is `3` (Xcode codesign), and `codesign/provisioning_profile` is the file unpacked from `provisioningProfile`. `.godot/export_credentials.cfg` gets `codesign/certificate_file` (the file unpacked from `certificate`) and `codesign/certificate_password` (`certificatePassword`). STG and PROD set `notarization/notarization` to `2` (notarytool) and write `notarization/api_uuid` (`macosNotary.issuerId`), `notarization/api_key_id` (`macosNotary.keyId`) and `notarization/api_key` (the file unpacked from `notaryApiKey`) in the credentials
- windows sets `codesign/enable` of the export preset to `false`, and after the export signs all `.exe` and `.dll` files of the output in Azure Trusted Signing with `jsign`. `jsign` and the Java runtime that runs it are the platform `windows` items of `engine.json` `buildTools`
  - The access token is obtained with the client credentials flow of Microsoft Entra ID. The tenant is game settings `trustedSigning.tenantId`, the client ID is `trustedSigning.clientId`, the client secret is `clientSecret` of `signing.windows`, and the scope is `https://codesigning.azure.net/.default`
  - The `jsign` arguments are `--storetype TRUSTEDSIGNING`, the host of `trustedSigning.endpoint` for `--keystore`, `file:<path>` of a temporary file holding the access token for `--storepass`, `<trustedSigning.account>/<trustedSigning.certificateProfile>` for `--alias`, `--tsaurl http://timestamp.acs.microsoft.com`, `--tsmode RFC3161` and `--alg SHA-256`
  - A human prepares the Trusted Signing account and certificate profile, the app registration of `trustedSigning.clientId`, and the `Trusted Signing Certificate Profile Signer` role that app has on the certificate profile
- STG and PROD of macos also do notarization
- free signing (`## platform build` of [`build`](../SKILL.md)): android passes the debug keystore in `GODOT_ANDROID_KEYSTORE_DEBUG_PATH` of the environment variables above, `androiddebugkey` in `_USER` and `android` in `_PASSWORD`. The macos preset sets `codesign/codesign` to `1` (Built-in, ad-hoc) and does not write `codesign/provisioning_profile` and `.godot/export_credentials.cfg`. windows does not run `jsign`
- ios uses the keys starting with `development` for DEV and the keys starting with `distribution` for STG and PROD. In the export preset, `application/export_method_debug` is Development (`1`), `application/export_method_release` is App Store (`0`), `application/code_sign_identity_debug` is `Apple Development`, and `application/code_sign_identity_release` is `Apple Distribution`. Game settings `appleTeamId` goes in `application/app_store_team_id`, and the `UUID` of that environment's provisioning profile goes in `application/provisioning_profile_uuid_debug` for DEV and in `application/provisioning_profile_uuid_release` for STG and PROD
- Before the export, ios does the following
  1. Creates a keychain with a random password in a temporary folder, unlocks it and turns off its auto-lock
  2. Imports the certificate of that environment with its certificate password, and sets the key partition list to `apple-tool:,apple:,codesign:` so that `codesign` uses the key without asking
  3. Adds that keychain to the front of the user keychain search list
  4. Puts the provisioning profile of that environment, named `<UUID>.mobileprovision`, in `~/Library/MobileDevice/Provisioning Profiles/` and `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`. It does not put it in a folder that already has a file of the same name
- When the ios export ends, on success or failure, restores the user keychain search list to its state before 1, deletes the keychain of 1, and deletes the files put in 4
- `.godot/export_credentials.cfg`, keystores, certificates and provisioning profiles are not committed. The build workspace is deleted when the build ends

## device performance

`ogw build run` does check `device performance` of an android build in the order below. The device is the first item of harness settings `testDevices` whose `platform` is `android`.

1. Starts an instance with the runner, without clients other than bot clients. The DB is SQLite. The runner starts the bot client of that instance on the host
2. For a realtime game, does the UDP reach check of `ogw env check` with that device. When UDP does not reach, stops the instance and outputs the check result `unknown`
3. Exports an apk in the build workspace with the DEV preset (`android-dev`) without `generated/build_info.json`. The export version is the build's version, and for a bundle patch build, the target app version. Before the export, writes into `generated/launch_values.json` `OGW_SERVER_URL` (`http://127.0.0.1:<instance server port>`), `OGW_INSTANCE_ID` (the instance ID of 1), `OGW_AUTOMATION_PORT` and `OGW_AUTOMATION_TOKEN` set by the runner, `OGW_PLATFORM` (`android`), `OGW_DEV_ACCESS` with the dev access value the runner gave the instance server of 1, and `OGW_DEV_ACCOUNT` with the dev account the runner set. This apk is not an artifact. When the check ends, on success or failure, deletes this apk and `generated/launch_values.json`
4. Installs the apk with `adb -s <serial>`, connects the instance server port and automation port of the device to the same ports of the host with `adb reverse`, and starts the app with `adb -s <serial> shell monkey -p <game settings appId> -c android.intent.category.LAUNCHER 1`. Whether the client process of the bot playtest has ended is judged by whether `adb -s <serial> shell pidof <game settings appId>` exits with a nonzero code or outputs nothing
5. Does the `## performance` judgement of `performance.md` of the `game-loop` skill. When it ends, deletes the app and stops the instance

## web smoke

`ogw build run` does check `web smoke` of a web build in the order below.

1. Starts an instance with the runner, without clients other than bot clients. The DB is SQLite. The runner starts the bot client of that instance on the host
2. Makes a web export in the build workspace with the DEV preset (`web-dev`) without `generated/build_info.json`. The export version is the build's version, and for a bundle patch build, the target app version. Before the export, writes into `generated/launch_values.json` `OGW_SERVER_URL` (`http://127.0.0.1:<instance server port>`), `OGW_INSTANCE_ID` (the instance ID of 1), `OGW_AUTOMATION_PORT` and `OGW_AUTOMATION_TOKEN` set by the runner, `OGW_PLATFORM` (`web`), `OGW_DEV_ACCESS` with the dev access value the runner gave the instance server of 1, and `OGW_DEV_ACCOUNT` with the dev account the runner set. This export is not an artifact. When the check ends, on success or failure, deletes this export and `generated/launch_values.json`
3. Serves the export folder over HTTP on a free port of `127.0.0.1`, applies the CPU throttle of harness settings `webSmokeCpuThrottleRate` to the headless browser of harness settings `tools.chromium`, and opens `index.html` of that folder
4. When the client connects to the automation channel, runs the bot playtest of the `client-content` skill and judges no blocker and full flow. Browser console output counts as client output. The ms from opening the page until `boot_stage` becomes `Done` goes into the result. When `boot_stage` does not become `Done` within harness settings `webSmokeBootTimeoutMs` from opening the page, no blocker and full flow are `fail`
5. When it ends, closes the browser and stops the instance
