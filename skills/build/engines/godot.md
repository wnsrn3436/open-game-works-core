# Godot build

## signing

- Key names per platform of the game settings `signing` secret

  | platform | key |
  |---|---|
  | android | `keystore`(base64 keystore file), `password` |
  | ios | `developmentCertificate`(base64 p12, Apple Development), `developmentCertificatePassword`, `developmentProvisioningProfile`(base64, iOS App Development), `distributionCertificate`(base64 p12, Apple Distribution), `distributionCertificatePassword`, `distributionProvisioningProfile`(base64, App Store) |
  | macos | `certificate`(base64 p12, Developer ID Application), `certificatePassword`, `provisioningProfile`(base64, Developer ID), `notaryApiKey`(base64) |
  | windows | `clientSecret`(client secret of the game settings `trustedSigning.clientId` app) |

- For ios, a human makes the provisioning profiles with the capabilities of the entitlements of that environment's `adapters`: Push Notifications when `push-apns` is `push-apns` or `push-apns-sandbox`, and Sign in with Apple when `login-apple` is `login-apple`
- For macos, a human registers in Apple Developer the explicit App ID game settings `appId` in the team of `appleTeamId`, with the Sign in with Apple capability when `adapters.login-apple` of an environment is `login-apple`, and makes a `Developer ID` provisioning profile of that App ID with the Developer ID Application certificate of `certificate`. That profile grants `com.apple.application-identifier` `<appleTeamId>.<appId>`, which gives the app process its keychain access group
- For windows, a human prepares the Trusted Signing account and certificate profile, the app registration of `trustedSigning.clientId`, and the `Trusted Signing Certificate Profile Signer` role that app has on the certificate profile

## native plugin

Check `native plugin` of `## build-time check` of [`build`](../SKILL.md) looks at each target platform other than web of an STG or PROD build. The build of a platform needs each plugin of the table below whose condition holds and whose target platforms in the native plugin table of `engines/godot.md` of the `client-core` skill include that platform. The check fails for each needed plugin that has no item in `plugins` of `engine.json` of the game settings core version whose `platforms` include that platform, or whose `<plugin>/<platform>/` the core release asset `client-godot-plugins.zip` lacks. `ogw game check --build` runs the same check for STG and PROD of every platform of game settings `buildPlatforms`.

| plugin | condition |
|---|---|
| `ogw-secure-storage` | always (`AuthCore` is in every game) |
| `ogw-apple-signin` | `adapters.login-apple` of that environment is not `fake` |
| `ogw-google-signin` | `adapters.login-google` of that environment is not `fake` |
| `ogw-iap-apple` | `adapters.iap-apple` of that environment is not `fake` |
| `ogw-iap-google` | `adapters.iap-google` of that environment is not `fake` |
| `ogw-ads-admob` | `adapters.ads` of that environment is not `fake` |
| `ogw-push-fcm` | `adapters.push-fcm` of that environment is not `fake` |
| `ogw-push-apns` | `adapters.push-apns` of that environment is not `fake` |
| `ogw-notification` | the modules the game uses include `PushCore` |
| `ogw-tracking` | game settings `consent.trackingRequest` is `true` |

For a macos build that needs `ogw-secure-storage`, whose singleton needs a keychain access group (native plugin table of `engines/godot.md` of the `client-core` skill), `ogw build start` and `ogw build run` also fail the check when game settings `signing.macos` has no `provisioningProfile`, when the secret it names is not in the secret store, or when `com.apple.application-identifier` of `Entitlements` in that provisioning profile, decoded with `security cms -D -i`, is not `<appleTeamId>.<appId>` of game settings. `ogw game check --build` reads no secret value and does not do this part.
