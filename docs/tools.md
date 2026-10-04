# Tool reference

<!-- Generated from src/tools/*.ts by `UPDATE_DOCS=1 pnpm exec vitest run test/docs.test.ts`. Do not edit by hand. -->

35 tools. **Mutating** tools also accept `confirm_token`: the first call returns a preview and changes nothing; repeat the identical call with the token to execute (see [agent-integration.md](agent-integration.md)).

| Tool | Kind | Title |
|---|---|---|
| [`doctor`](#doctor) | read-only | Check this Mac's signing/notarization readiness |
| [`detect_project`](#detect_project) | read-only | Detect app/project type and current signing setup |
| [`distribution_checklist`](#distribution_checklist) | read-only | What is missing to ship this app to a target? |
| [`signing_identities`](#signing_identities) | read-only | List keychain signing identities and certificates |
| [`inspect_code_signature`](#inspect_code_signature) | read-only | Inspect and verify a code signature |
| [`inspect_binary`](#inspect_binary) | read-only | Inspect Mach-O binaries (archs, SDK, linked libraries) |
| [`entitlements`](#entitlements) | mutating | Read, validate, explain or generate entitlements |
| [`provisioning_profiles`](#provisioning_profiles) | mutating | List, inspect, install or embed provisioning profiles |
| [`gatekeeper`](#gatekeeper) | mutating | Test Gatekeeper acceptance like an end user |
| [`quarantine`](#quarantine) | mutating | Read / set / clear the com.apple.quarantine attribute |
| [`system_logs`](#system_logs) | read-only | Query macOS unified logs for signing / sandbox / privacy problems |
| [`crash_reports`](#crash_reports) | read-only | Find and explain recent crash reports |
| [`privacy`](#privacy) | mutating | Audit privacy permissions (TCC) / reset prompts |
| [`devices`](#devices) | read-only | List this Mac's UDID, connected devices and simulators |
| [`jobs`](#jobs) | mutating | Status of long-running background jobs |
| [`keychain`](#keychain) | mutating | Create CSRs and manage signing identities in the keychain |
| [`sign`](#sign) | mutating | Code sign an app, bundle, binary or DMG (inside-out) |
| [`resign`](#resign) | mutating | Re-sign a prebuilt .app or .ipa for a new identity/profile |
| [`package`](#package) | mutating | Package an app as .zip, .dmg or .pkg (optionally signed) |
| [`notary`](#notary) | mutating | Apple notary service (notarytool) |
| [`staple`](#staple) | mutating | Staple / validate notarization tickets |
| [`notarize_and_staple`](#notarize_and_staple) | mutating | One-shot: preflight → notarize → staple → Gatekeeper check |
| [`asc_auth`](#asc_auth) | mutating | App Store Connect API key setup and validation |
| [`asc_bundle_ids`](#asc_bundle_ids) | mutating | Register bundle IDs (App IDs) and manage capabilities |
| [`asc_certificates`](#asc_certificates) | mutating | Signing certificates in the Apple Developer portal |
| [`asc_devices`](#asc_devices) | mutating | Registered test devices |
| [`asc_profiles`](#asc_profiles) | mutating | Provisioning profiles in the Apple Developer portal |
| [`asc_apps`](#asc_apps) | read-only | App Store Connect app records |
| [`asc_builds`](#asc_builds) | mutating | Uploaded builds and processing status |
| [`asc_api`](#asc_api) | mutating | Raw App Store Connect API request (escape hatch) |
| [`xcode`](#xcode) | mutating | Xcode: schemes, signing settings, archive, export / upload |
| [`upload_build`](#upload_build) | mutating | Upload an .ipa / .pkg to App Store Connect |
| [`testflight`](#testflight) | mutating | TestFlight: groups, testers, builds, beta review |
| [`app_store`](#app_store) | mutating | App Store versions, metadata, review submission and release |
| [`ci_config`](#ci_config) | mutating | Generate a CI workflow for signing + notarization / upload |

## doctor

**Check this Mac's signing/notarization readiness** — read-only

Start here. Checks macOS and Xcode / Command Line Tools versions against App Store minimums, required CLIs (codesign, notarytool, stapler, altool, productbuild…), keychain signing identities (expired, missing private keys, duplicates), Apple intermediate certificates, App Store Connect API key configuration and the notarytool keychain profile. Returns a checklist with exact fixes. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `profile` | string |  | Credential profile to check (default profile / env vars if omitted). |

## detect_project

**Detect app/project type and current signing setup** — read-only

Identify what lives at a path: Xcode project/workspace, SwiftPM package, Electron (electron-builder/forge), Tauri, Flutter, React Native, Expo (managed/bare), or a prebuilt .app/.xcarchive/.ipa/.dmg/.pkg/.zip. Reports platforms, bundle IDs, team IDs, current signing configuration, problems found, suggested distribution targets, build commands, and framework-specific config snippets / environment variables to enable signing + notarization (apply them with your editor). Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Project directory or artifact path (absolute, or ~/...). |
| `depth` | integer |  | Directory scan depth (default 2). |

## distribution_checklist

**What is missing to ship this app to a target?** — read-only

The zero-context entry point. For a project/artifact path and a target (mac-developer-id, mac-app-store, testflight-mac, ios-app-store, testflight-ios, ios-ad-hoc, ios-development, mac-development, enterprise) it checks: developer tools / Xcode version, App Store Connect API key (and therefore membership), notarization credentials, required certificates in the keychain (and in the portal), Apple intermediates, sandbox / debug entitlements, bundle ID registration + capabilities, provisioning profiles (local and portal), the App Store Connect app record and build numbers, export compliance and category keys, plus the human-only steps. Each item has a status and the exact tool call or manual step that fixes it, in order. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` | yes |  |
| `path` | string |  | Project directory or built artifact. |
| `bundle_id` | string |  | Override the detected bundle identifier. |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## signing_identities

**List keychain signing identities and certificates** — read-only

List code-signing identities (certificate + private key) in the keychain with type (Developer ID Application/Installer, Apple Distribution, Apple Development, Mac Installer Distribution…), team ID, SHA-1, expiry and validity; also lists developer certificates that are missing their private key and explains which certificate each distribution target needs. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `keychain` | string |  | Specific keychain path (default: user search list). |
| `include_reference` | boolean |  | Include the certificate-type reference table (default true). |

## inspect_code_signature

**Inspect and verify a code signature** — read-only

Deep inspection of a signed .app/.framework/.appex/.dylib/binary/.dmg/.pkg/.ipa: signer and certificate chain, team ID, hardened runtime, secure timestamp, stapled ticket, entitlements, embedded provisioning profile, strict deep verification, and every nested component (unsigned, ad-hoc, missing runtime/timestamp, mismatched Team IDs). Pass a target to get readiness findings for that distribution path. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Path to the artifact. |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  | Distribution target to evaluate readiness for. |
| `deep` | boolean |  | Inspect nested code individually (default true). |

## inspect_binary

**Inspect Mach-O binaries (archs, SDK, linked libraries)** — read-only

For a Mach-O file or every Mach-O in a bundle: architectures (lipo), platform / minimum OS / SDK version (LC_BUILD_VERSION), linked libraries and @rpath entries (otool). Flags binaries built with an SDK older than 10.9 (notarization rejects them), simulator slices in device builds, and @rpath libraries that are not embedded. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Binary or bundle path. |
| `max_files` | integer |  | Max binaries to inspect in a bundle (default 40). |

## entitlements

**Read, validate, explain or generate entitlements** — mutating (preview → confirm_token)

action=read: entitlements of a signed app/binary, an .entitlements/.plist file, or a provisioning profile, annotated with what each key does. action=validate: check them against a provisioning profile (wildcards supported), a distribution target (sandbox required, get-task-allow forbidden…), Info.plist usage descriptions, risky hardened-runtime exceptions and helper inherit rules. action=explain: describe keys (or the whole catalog). action=generate: build an .entitlements plist from a preset (electron, electron-mas, electron-mas-inherit, tauri, sandbox-basic, developer-id-minimal) plus capability shorthands; writing to output_path requires confirmation.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `read` \| `validate` \| `explain` \| `generate` | yes |  |
| `path` | string |  | read/validate: app bundle, binary, .entitlements/.plist file, or profile. |
| `profile` | string |  | validate: provisioning profile to validate against (default: the bundle's embedded profile). |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  | validate/generate: distribution target. |
| `keys` | string[] |  | explain: entitlement keys to describe (omit for the full catalog). |
| `preset` | string |  | generate: one of developer-id-minimal, electron, electron-mas, electron-mas-inherit, tauri, sandbox-basic |
| `capabilities` | string[] |  | generate: shorthands — sandbox, network-client, network-server, files-user-selected-read, files-user-selected-write, downloads, camera, microphone, usb, bluetooth, location, contacts, calendars, photos, apple-events, print, jit, unsigned-executable-memory, disable-library-validation, dyld-env |
| `extra` | object |  | generate: additional raw key/value pairs. |
| `output_path` | string |  | generate: write the plist here (requires confirmation). |

## provisioning_profiles

**List, inspect, install or embed provisioning profiles** — mutating (preview → confirm_token)

action=list_installed: profiles installed for Xcode (both ~/Library/Developer/Xcode/UserData/Provisioning Profiles and the legacy MobileDevice folder) with expiry and type, optionally filtered by bundle_id. action=inspect: decode a .mobileprovision/.provisionprofile (app ID, team, type, devices, entitlements, embedded certificates and whether their private keys are in this keychain). action=install (confirm): copy a profile into Xcode's folders. action=embed (confirm): copy a profile into an app bundle (Contents/embedded.provisionprofile or embedded.mobileprovision) — re-sign afterwards.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list_installed` \| `inspect` \| `install` \| `embed` | yes |  |
| `path` | string |  | inspect/install/embed: the profile file. |
| `bundle_id` | string |  | list_installed: filter by bundle ID (wildcard profiles also match). |
| `app_path` | string |  | embed: the .app bundle to embed into. |

## gatekeeper

**Test Gatekeeper acceptance like an end user** — mutating (preview → confirm_token)

action=assess: spctl assessment with the right type for .app (execute), .pkg (install) and .dmg (open, primary signature), explaining rejections (unnotarized, no usable signature, wrong certificate…). action=syspolicy_check: Apple's macOS 14+ pre-distribution checker (`syspolicy_check distribution|notary-submission`). action=simulate_download: copy the artifact to a temp folder, add the com.apple.quarantine attribute exactly like a Safari download (mounting DMGs / extracting zips), then assess it, check the stapled ticket and run syspolicy_check — the closest thing to a user's first launch. launch=true (confirm) also opens the app and collects Gatekeeper/AMFI log lines.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `assess` \| `syspolicy_check` \| `simulate_download` | yes |  |
| `path` | string | yes | .app, .dmg, .pkg or .zip |
| `mode` | `distribution` \| `notary-submission` |  | syspolicy_check mode (default distribution). |
| `launch` | boolean |  | simulate_download: also launch the quarantined copy (requires confirmation). |

## quarantine

**Read / set / clear the com.apple.quarantine attribute** — mutating (preview → confirm_token)

action=get: show the quarantine attribute (flags, time, downloading agent) — present on downloaded files and what triggers Gatekeeper. action=set (confirm): add it to test first-launch behaviour. action=clear (confirm): remove it (recursive) — this only bypasses Gatekeeper on THIS Mac and is not a distribution fix. action=clear_all_xattrs (confirm): `xattr -cr`, the fix for codesign's 'resource fork, Finder information, or similar detritus not allowed'.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `get` \| `set` \| `clear` \| `clear_all_xattrs` | yes |  |
| `path` | string | yes |  |
| `recursive` | boolean |  | set/clear: apply to bundle contents too (default true for directories). |

## system_logs

**Query macOS unified logs for signing / sandbox / privacy problems** — read-only

Runs `log show` with a preset predicate: gatekeeper (syspolicyd, XProtect), amfi (code signature & entitlement enforcement), sandbox (deny lines → parsed into violations with the entitlement that would allow each), tcc (privacy permission decisions), launch (dyld/launchd), or a custom predicate. Optionally narrow to a process / app name. Reproduce the problem first, then call this with a short window (e.g. last=5m). Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `preset` | `gatekeeper` \| `amfi` \| `sandbox` \| `tcc` \| `launch` \| `custom` | yes |  |
| `predicate` | string |  | custom: NSPredicate for `log show --predicate`. |
| `process` | string |  | Only lines mentioning this process / app name. |
| `last` | string |  | Time window like 5m, 1h (default 10m). |
| `max_lines` | integer |  | Lines to return (default 200). |

## crash_reports

**Find and explain recent crash reports** — read-only

Lists recent .ips/.crash reports from ~/Library/Logs/DiagnosticReports (and /Library/Logs/DiagnosticReports) for a process or bundle ID and explains signing-related terminations: CODESIGNING kills (invalid signature, missing provisioning profile for restricted entitlements), dyld 'Library not loaded' and library-validation Team ID mismatches. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `process` | string |  | Process / app name or bundle ID to match (omit for all). |
| `limit` | integer |  | Max reports (default 10). |

## privacy

**Audit privacy permissions (TCC) / reset prompts** — mutating (preview → confirm_token)

action=audit: for an .app, cross-checks linked frameworks (camera, microphone, location, contacts, photos, Bluetooth…) against Info.plist NS*UsageDescription strings and macOS hardened-runtime/sandbox entitlements, and scans for privacy-manifest required-reason APIs (UserDefaults, file timestamps, boot time, disk space) vs PrivacyInfo.xcprivacy — the causes of silent permission failures, crashes on first access, and ITMS-90683 / ITMS-91053 rejections. action=tcc_reset (confirm): `tccutil reset <Service> <bundle-id>` so the permission prompt appears again for testing.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `audit` \| `tcc_reset` | yes |  |
| `path` | string |  | audit: the .app bundle. |
| `service` | `All` \| `Accessibility` \| `AddressBook` \| `AppleEvents` \| `BluetoothAlways` \| `Calendar` \| `Camera` \| `ListenEvent` \| `MediaLibrary` \| `Microphone` \| `Motion` \| `Photos` \| `PostEvent` \| `Reminders` \| `ScreenCapture` \| `SpeechRecognition` \| `SystemPolicyAllFiles` \| `SystemPolicyDesktopFolder` \| `SystemPolicyDocumentsFolder` \| `SystemPolicyDownloadsFolder` \| `SystemPolicyNetworkVolumes` \| `SystemPolicyRemovableVolumes` \| `Willow` |  | tcc_reset: TCC service (All resets everything for the bundle). |
| `bundle_id` | string |  | tcc_reset: bundle ID (omit to reset the service for ALL apps). |

## devices

**List this Mac's UDID, connected devices and simulators** — read-only

Collects device identifiers needed for development / Ad Hoc provisioning: this Mac's provisioning UDID (system_profiler), connected iPhones/iPads/Apple TVs/Vision Pros (`xcrun devicectl list devices`), and available simulators (`xcrun simctl`). Register them with asc_devices action=register. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `include_simulators` | boolean |  | Include simulators (default false). |

## jobs

**Status of long-running background jobs** — mutating (preview → confirm_token)

Long operations (xcodebuild archive/export, notarization waits, uploads, build processing) continue in the background when they exceed max_wait_seconds. action=list / status (optionally wait up to wait_seconds) / tail (recent output) / cancel (confirm).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `status` \| `tail` \| `cancel` | yes |  |
| `job_id` | string |  |  |
| `wait_seconds` | integer |  | status: wait up to this long for completion. |
| `lines` | integer |  | tail: number of lines (default 80). |

## keychain

**Create CSRs and manage signing identities in the keychain** — mutating (preview → confirm_token)

action=create_csr (confirm): generate an RSA-2048 private key (stored 0600 in ~/.config/notarize-mcp/keys) and a Certificate Signing Request to upload to Apple (asc_certificates create, or the developer portal for Developer ID). action=import_certificate (confirm): pair a downloaded .cer with that private key and import the identity into the login keychain, pre-authorizing codesign/productsign. action=import_p12 (confirm): import an existing .p12 (password via password_env). action=install_intermediates (confirm): download and import Apple's WWDR G3 and Developer ID G2 intermediate certificates (fixes 'unable to build chain' / errSecInternalComponent). action=export_p12 (confirm): export a key generated here + its certificate as a .p12 (+ base64) for CI secrets.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `create_csr` \| `import_certificate` \| `import_p12` \| `install_intermediates` \| `export_p12` | yes |  |
| `key_name` | string |  | Name for the generated key/CSR (create_csr/import_certificate/export_p12). |
| `common_name` | string |  | create_csr: your name or company (Apple replaces it with your team name). |
| `email` | string |  | create_csr: your Apple Developer account email. |
| `country` | string |  | create_csr: 2-letter country code (default US). |
| `certificate_path` | string |  | import_certificate/export_p12: .cer (DER) or .pem certificate from Apple. |
| `p12_path` | string |  | import_p12: the .p12 file. |
| `password_env` | string |  | Name of an environment variable (in the MCP server's env) holding the .p12 password — keeps secrets out of the conversation. |
| `keychain` | string |  | Target keychain (default login keychain). |
| `output_path` | string |  | export_p12: where to write the .p12. |

## sign

**Code sign an app, bundle, binary or DMG (inside-out)** — mutating (preview → confirm_token)

Signs nested code deepest-first (frameworks, dylibs, helpers, XPC services, app extensions, extra Mach-Os, Node .node modules) and then the outer bundle — never relying on --deep. Defaults for distribution: hardened runtime (--options runtime) and secure timestamp. identity can be a keychain name, SHA-1, '-' (ad-hoc, local testing only) or 'auto' with a target (picks the newest valid Developer ID Application / Apple Distribution / Apple Development identity). Supports per-component entitlements (e.g. Electron helpers), preserving nested entitlements, clearing extended attributes first, and embedding a provisioning profile. Preview → confirm.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | .app / .framework / .appex / .xpc / Mach-O binary / .dmg |
| `identity` | string |  | Identity name, SHA-1, '-' for ad-hoc, or 'auto' (needs target). |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  | Distribution target (drives identity choice and readiness checks). |
| `team_id` | string |  | Restrict 'auto' identity selection to this team. |
| `entitlements` | string |  | Entitlements plist for the outer bundle/binary. |
| `nested_entitlements` | object |  | Map of nested relative path → entitlements plist. |
| `default_nested_entitlements` | string |  | Entitlements for nested executables/helper apps without an explicit entry (e.g. Electron's entitlementsInherit). |
| `preserve_nested_entitlements` | boolean |  | Keep existing entitlements on nested items without an explicit file (default true). |
| `hardened_runtime` | boolean |  | Default true (required for notarization). |
| `timestamp` | boolean |  | Default true unless ad-hoc. |
| `sign_nested` | boolean |  | Sign nested code inside-out first (default true). |
| `clear_xattrs` | boolean |  | Run xattr -cr before signing (default true). |
| `embed_profile` | string |  | Provisioning profile to embed before signing. |
| `keychain` | string |  | Keychain containing the identity. |
| `max_wait_seconds` | integer |  | Foreground wait before continuing as a background job (default 600). |

## resign

**Re-sign a prebuilt .app or .ipa for a new identity/profile** — mutating (preview → confirm_token)

Re-signs a prebuilt artifact you have rights to distribute (no source needed): copies it to output_path, optionally replaces the embedded provisioning profile, derives entitlements from the profile (keeping existing capability entitlements, swapping application/team identifiers, dropping get-task-allow for distribution), signs inside-out, and repackages .ipa files. App extensions inside an IPA need their own profiles via extension_profiles. Preview → confirm.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | .app or .ipa to re-sign (left untouched; a copy is written). |
| `output_path` | string |  | Where to write the re-signed artifact (default <name>-resigned.<ext> next to the input). |
| `identity` | string |  | Identity name / SHA-1 / 'auto' (with target). |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  |  |
| `profile` | string |  | New provisioning profile for the main app. |
| `extension_profiles` | object |  | Bundle-relative path of each .appex → profile. |
| `entitlements` | string |  | Explicit entitlements for the main app (otherwise derived). |
| `max_wait_seconds` | integer |  |  |

## package

**Package an app as .zip, .dmg or .pkg (optionally signed)** — mutating (preview → confirm_token)

action=zip: `ditto -c -k --sequesterRsrc --keepParent` (the zip format notarization accepts; plain `zip` breaks framework symlinks). action=dmg: compressed UDZO disk image with an /Applications shortcut, optionally codesigned with Developer ID (recommended before notarizing). action=pkg: productbuild installer that installs into /Applications, signed with Developer ID Installer (direct distribution) or Mac Installer Distribution (Mac App Store upload, target=mac-app-store). action=sign_pkg: productsign an existing pkg. Writing a new file runs directly; overwriting or signing needs confirmation.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `zip` \| `dmg` \| `pkg` \| `sign_pkg` | yes |  |
| `path` | string | yes | The .app (or .pkg for sign_pkg). |
| `output_path` | string |  | Output file (default next to the input). |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  | pkg: mac-developer-id (default) or mac-app-store. |
| `identity` | string |  | dmg: Developer ID Application identity to sign the DMG ('auto' or omit to skip). pkg/sign_pkg: installer identity name, 'auto' (default) or 'none'. |
| `volume_name` | string |  | dmg: volume name (default app name). |
| `install_location` | string |  | pkg: default /Applications. |

## notary

**Apple notary service (notarytool)** — mutating (preview → confirm_token)

action=store_credentials (confirm): save notarytool credentials in the keychain (App Store Connect API key — preferred — or Apple ID + app-specific password from password_env) and remember the profile name. action=submit (confirm): upload a .app (zipped automatically with ditto), .zip, .dmg or .pkg after a signature preflight (refuses obvious rejects unless force=true), then wait for the result (continues as a background job after max_wait_seconds); on Invalid it fetches and explains the developer log. action=status / wait / log / history: inspect submissions; log groups issues and maps each to a fix.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `store_credentials` \| `submit` \| `status` \| `wait` \| `log` \| `history` | yes |  |
| `path` | string |  | submit: artifact to notarize. |
| `submission_id` | string |  | status/wait/log: submission UUID. |
| `keychain_profile` | string |  | notarytool keychain profile name (default from config / NOTARY_KEYCHAIN_PROFILE). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |
| `profile_name` | string |  | store_credentials: name to store under (default notarize-mcp). |
| `apple_id` | string |  | store_credentials (Apple ID method): Apple ID email. |
| `team_id` | string |  | store_credentials (Apple ID method): Team ID. |
| `password_env` | string |  | store_credentials (Apple ID method): env var holding an app-specific password. |
| `force` | boolean |  | submit: skip the preflight refusal. |
| `wait_minutes` | integer |  | submit/wait: how long to keep waiting overall (default 60). |
| `max_wait_seconds` | integer |  | Foreground wait before returning a job id + Monitor command (default 90). Notarization usually takes 2–15 min, sometimes much longer. |

## staple

**Staple / validate notarization tickets** — mutating (preview → confirm_token)

action=staple (confirm): attach the notarization ticket to a notarized .app, .dmg or .pkg (`xcrun stapler staple`) so Gatekeeper can verify it offline. Zips cannot be stapled — staple the .app and re-zip. action=validate: check whether a ticket is stapled. Errors such as 'Error 65 / Record not found' are explained (not notarized, modified after submission, or ticket still propagating).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `staple` \| `validate` | yes |  |
| `path` | string | yes |  |

## notarize_and_staple

**One-shot: preflight → notarize → staple → Gatekeeper check** — mutating (preview → confirm_token)

End-to-end Developer ID pipeline for an already-signed .app, .dmg or .pkg (or .zip, which is notarized but not stapled): verify the signature is notarizable, zip if needed, submit with notarytool, wait (continuing as a background job if slow), explain the log on rejection, staple the ticket, validate it, run a Gatekeeper assessment, and optionally produce a distribution zip of the stapled app. One preview covers the whole pipeline.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Signed .app, .dmg, .pkg or .zip |
| `keychain_profile` | string |  |  |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |
| `distribution_zip` | string |  | For a .app: also create this zip from the stapled app. |
| `force` | boolean |  | Submit even if the preflight finds problems. |
| `wait_minutes` | integer |  | Overall wait for Apple (default 60). |
| `max_wait_seconds` | integer |  | Foreground wait before returning a job id + Monitor command (default 90). Notarization usually takes 2–15 min, sometimes much longer. |

## asc_auth

**App Store Connect API key setup and validation** — mutating (preview → confirm_token)

action=status: show which API key is configured (env vars or saved profile) without network calls, plus .p8 files found in ~/.appstoreconnect/private_keys. action=test: make an authenticated call and report success, rate limit, and role/agreement problems. action=configure (confirm): validate a key (key_id, issuer_id, private_key_path) and save it as a named profile in ~/.config/notarize-mcp/config.json (0600; only the .p8 PATH is stored). One Team API key (Admin or App Manager role) powers portal automation, notarization and uploads. Creating the key itself is manual: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate (the .p8 downloads only once).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `status` \| `test` \| `configure` | yes |  |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |
| `profile_name` | string |  | configure: profile name to save (default 'default'). |
| `key_id` | string |  | configure: Key ID (10 characters). |
| `issuer_id` | string |  | configure: Issuer ID (UUID shown above the keys table). Omit for an individual key. |
| `private_key_path` | string |  | configure: path to AuthKey_<KEYID>.p8. |
| `team_id` | string |  | configure: your 10-character Team ID (developer.apple.com → Membership). |
| `make_default` | boolean |  | configure: make this the default profile (default true). |

## asc_bundle_ids

**Register bundle IDs (App IDs) and manage capabilities** — mutating (preview → confirm_token)

App IDs identify your app to Apple's services. action=list (filter by identifier/platform) / get / capabilities (enabled capabilities). action=create (confirm): register an explicit bundle ID (IOS, MAC_OS or UNIVERSAL). action=enable_capability / disable_capability (confirm): e.g. PUSH_NOTIFICATIONS, ICLOUD, APP_GROUPS, ASSOCIATED_DOMAINS, APPLE_ID_AUTH (Sign in with Apple), IN_APP_PURCHASE, NETWORK_EXTENSIONS — provisioning profiles must be regenerated afterwards. action=delete (confirm, destructive).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `get` \| `create` \| `delete` \| `capabilities` \| `enable_capability` \| `disable_capability` | yes |  |
| `bundle_id` | string |  | Bundle identifier (com.example.app) or ASC resource id. |
| `name` | string |  | create: display name (letters, numbers, spaces). |
| `platform` | `IOS` \| `MAC_OS` \| `UNIVERSAL` |  | create/list: IOS, MAC_OS or UNIVERSAL. |
| `capability_type` | string |  | enable/disable_capability: capabilityType, e.g. PUSH_NOTIFICATIONS. |
| `capability_id` | string |  | disable_capability: bundleIdCapability id (from capabilities). |
| `settings` | object[] |  | enable_capability: capability settings array (e.g. iCloud version). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_certificates

**Signing certificates in the Apple Developer portal** — mutating (preview → confirm_token)

action=list (filter by certificate_type) / get. action=create (confirm): submit a CSR (from keychain create_csr: pass key_name, or csr_path) for certificate_type DISTRIBUTION (Apple Distribution), DEVELOPMENT (Apple Development), MAC_INSTALLER_DISTRIBUTION, DEVELOPER_ID_APPLICATION_G2… and, if key_name is given, install the issued certificate + private key into the login keychain. Developer ID types usually require the Account Holder via the web portal — on refusal you get exact manual steps. action=download_install (confirm): fetch an existing certificate and pair it with a local key. action=revoke (confirm, destructive).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `get` \| `create` \| `download_install` \| `revoke` | yes |  |
| `certificate_type` | `DEVELOPMENT` \| `DISTRIBUTION` \| `DEVELOPER_ID_APPLICATION` \| `DEVELOPER_ID_APPLICATION_G2` \| `DEVELOPER_ID_KEXT` \| `DEVELOPER_ID_KEXT_G2` \| `MAC_INSTALLER_DISTRIBUTION` \| `MAC_APP_DISTRIBUTION` \| `MAC_APP_DEVELOPMENT` \| `IOS_DEVELOPMENT` \| `IOS_DISTRIBUTION` \| `PASS_TYPE_ID` \| `PASS_TYPE_ID_WITH_NFC` |  |  |
| `certificate_id` | string |  |  |
| `key_name` | string |  | Key created by keychain create_csr (its .csr is used for create; its .key is paired on install). |
| `csr_path` | string |  | create: explicit CSR path. |
| `install` | boolean |  | create: install into the keychain afterwards (default true when key_name is given). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_devices

**Registered test devices** — mutating (preview → confirm_token)

Devices (UDIDs) are needed for development and Ad Hoc profiles (limit: 100 per device family per membership year — disabling does not free a slot until renewal). action=list (filter platform/status). action=register (confirm): add a device (get UDIDs from the devices tool). action=disable (confirm).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `register` \| `disable` | yes |  |
| `name` | string |  |  |
| `udid` | string |  |  |
| `platform` | `IOS` \| `MAC_OS` |  |  |
| `device_id` | string |  | disable: ASC device resource id. |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_profiles

**Provisioning profiles in the Apple Developer portal** — mutating (preview → confirm_token)

action=list (filter profile_type, bundle_id) / get. action=create (confirm): profile_type (IOS_APP_STORE, IOS_APP_ADHOC, IOS_APP_DEVELOPMENT, MAC_APP_STORE, MAC_APP_DIRECT = Developer ID, MAC_APP_DEVELOPMENT, …) for a bundle ID; certificates default to all valid certificates of the matching type and devices to all enabled devices of the platform (for development/ad hoc). Installs it for Xcode by default. action=download_install (confirm). action=regenerate (confirm): delete + recreate with the same name/type/bundle ID and current certificates/devices — needed after adding devices or capabilities. action=delete (confirm).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `get` \| `create` \| `download_install` \| `regenerate` \| `delete` | yes |  |
| `profile_id` | string |  |  |
| `profile_type` | `IOS_APP_DEVELOPMENT` \| `IOS_APP_STORE` \| `IOS_APP_ADHOC` \| `IOS_APP_INHOUSE` \| `MAC_APP_DEVELOPMENT` \| `MAC_APP_STORE` \| `MAC_APP_DIRECT` \| `TVOS_APP_DEVELOPMENT` \| `TVOS_APP_STORE` \| `TVOS_APP_ADHOC` \| `TVOS_APP_INHOUSE` \| `MAC_CATALYST_APP_DEVELOPMENT` \| `MAC_CATALYST_APP_STORE` \| `MAC_CATALYST_APP_DIRECT` |  |  |
| `bundle_id` | string |  | Bundle identifier or ASC bundleId resource id. |
| `name` | string |  | create: profile name (default '<bundle id> <type>'). |
| `certificate_ids` | string[] |  | create: certificate ids (default: all valid of the right type). |
| `device_ids` | string[] |  | create: device ids (default: all enabled for the platform, dev/ad hoc only). |
| `install` | boolean |  | create/regenerate: install for Xcode (default true on macOS). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_apps

**App Store Connect app records** — read-only

action=list / get / find_by_bundle_id: app records (name, bundle ID, SKU, primary locale, Apple ID). App records CANNOT be created through the API — action=create_instructions returns the exact web steps and values to enter (bundle ID must already be registered with asc_bundle_ids).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `get` \| `find_by_bundle_id` \| `create_instructions` | yes |  |
| `app_id` | string |  |  |
| `bundle_id` | string |  |  |
| `name` | string |  | create_instructions: intended app name (must be unique on the App Store). |
| `platform` | `iOS` \| `macOS` \| `tvOS` \| `visionOS` |  |  |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_builds

**Uploaded builds and processing status** — mutating (preview → confirm_token)

action=list: recent builds for an app (version, build number, processing state, expiry). action=get. action=wait_processing: after an upload, poll until the build appears and reaches VALID (usable for TestFlight / review) or FAILED/INVALID — typically 5–30 min; continues as a background job with a Monitor command. action=set_encryption_compliance (confirm): answer the export-compliance question (usesNonExemptEncryption) so the build becomes testable — or add ITSAppUsesNonExemptEncryption to Info.plist to skip this forever. action=expire (confirm).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `list` \| `get` \| `wait_processing` \| `set_encryption_compliance` \| `expire` | yes |  |
| `app` | string |  | App id or bundle ID. |
| `build_id` | string |  |  |
| `build_number` | string |  | CFBundleVersion (wait_processing / list filter). |
| `version` | string |  | CFBundleShortVersionString (list filter). |
| `uses_non_exempt_encryption` | boolean |  | set_encryption_compliance: true only if you use non-exempt encryption (HTTPS/standard OS crypto is exempt). |
| `limit` | integer |  |  |
| `wait_minutes` | integer |  | wait_processing: overall wait (default 60). |
| `max_wait_seconds` | integer |  | wait_processing: foreground wait before handing off to a background job (default 90). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## asc_api

**Raw App Store Connect API request (escape hatch)** — mutating (preview → confirm_token)

Call any App Store Connect API endpoint not covered by other tools (pricing, screenshots, in-app purchases, Xcode Cloud, analytics, users…). path is relative to https://api.appstoreconnect.apple.com (e.g. /v1/apps/123/appInfos, /v2/inAppPurchases). GET runs directly (follows pagination when paginate=true); POST/PATCH/DELETE require confirmation. See https://developer.apple.com/documentation/appstoreconnectapi for payload shapes.

| Argument | Type | Required | Description |
|---|---|---|---|
| `method` | `GET` \| `POST` \| `PATCH` \| `DELETE` | yes |  |
| `path` | string | yes | e.g. /v1/apps or /v1/apps/{id}/appStoreVersions |
| `query` | object |  | Query params, e.g. {"filter[platform]": "IOS", "include": "build"} |
| `body` | object |  | JSON:API body for POST/PATCH/DELETE. |
| `paginate` | boolean |  | GET: follow links.next (up to max_items). |
| `max_items` | integer |  |  |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## xcode

**Xcode: schemes, signing settings, archive, export / upload** — mutating (preview → confirm_token)

action=schemes: list schemes/targets/configurations. action=signing_settings: signing-related build settings per target (team, style, identity, profile, hardened runtime, entitlements, versions) with problems flagged. action=archive (confirm): `xcodebuild archive` for generic/platform=macOS|iOS with automatic signing + -allowProvisioningUpdates using the App Store Connect API key (Xcode then creates/fetches certificates and profiles itself — the easiest path), optional team/settings overrides; signing_style=manual checks that each app target already sets CODE_SIGN_IDENTITY / PROVISIONING_PROFILE_SPECIFIER in the project (they are never passed on the command line, which would also hit Pods targets); runs as a background job with a Monitor command if slow. action=export (confirm): writes ExportOptions.plist for the target (developer-id, app-store-connect, release-testing, debugging, enterprise) and runs -exportArchive; destination=upload sends it straight to App Store Connect.

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `schemes` \| `signing_settings` \| `archive` \| `export` | yes |  |
| `path` | string |  | .xcworkspace / .xcodeproj or the folder containing it (schemes/signing_settings/archive). |
| `scheme` | string |  |  |
| `configuration` | string |  | Default Release. |
| `target` | `mac-developer-id` \| `mac-app-store` \| `testflight-mac` \| `ios-app-store` \| `testflight-ios` \| `ios-ad-hoc` \| `ios-development` \| `mac-development` \| `enterprise` |  | Distribution target (platform + export method). |
| `team_id` | string |  |  |
| `archive_path` | string |  | archive output / export input (.xcarchive). |
| `export_path` | string |  | export: output folder. |
| `destination` | `export` \| `upload` |  | export: 'upload' sends the build to App Store Connect. |
| `signing_style` | `automatic` \| `manual` |  | Default automatic. |
| `provisioning_profiles` | object |  | manual: bundle ID → profile name or UUID. |
| `signing_certificate` | string |  | manual: e.g. 'Apple Distribution' or 'Developer ID Application'. |
| `build_settings` | object |  | Extra KEY=VALUE overrides (e.g. CURRENT_PROJECT_VERSION). |
| `allow_provisioning_updates` | boolean |  | Let Xcode create/download certificates and profiles (default true). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |
| `max_wait_seconds` | integer |  | Foreground wait before handing off to a background job (default 120). |

## upload_build

**Upload an .ipa / .pkg to App Store Connect** — mutating (preview → confirm_token)

Uploads a distribution-signed .ipa (iOS/tvOS/visionOS) or Mac App Store .pkg to App Store Connect with `xcrun altool` using your API key (flags detected from the installed Xcode; the .p8 is placed in ~/.appstoreconnect/private_keys if altool needs it there). Reads the bundle ID / version / build from IPAs, looks up the app record, and continues as a background job with a Monitor command for large uploads. Afterwards use asc_builds wait_processing. For Xcode projects, `xcode action=export destination=upload` is an alternative.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | .ipa or .pkg |
| `platform` | `ios` \| `macos` \| `appletvos` \| `visionos` |  | Default: ios for .ipa, macos for .pkg. |
| `app_id` | string |  | Numeric App Store Connect app id (looked up from the bundle ID when possible). |
| `bundle_id` | string |  |  |
| `version` | string |  | CFBundleShortVersionString (for .pkg). |
| `build_number` | string |  | CFBundleVersion (for .pkg). |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |
| `max_wait_seconds` | integer |  | Foreground wait before handing off to a background job (default 120). |

## testflight

**TestFlight: groups, testers, builds, beta review** — mutating (preview → confirm_token)

action=groups / testers / status (internal + external beta state of a build). action=create_group (confirm): internal (App Store Connect users, no review) or external (anyone by email or public link; first build of each version needs beta app review). action=add_testers / remove_testers (confirm): invite by email to a group. action=add_build_to_group (confirm). action=set_what_to_test (confirm): 'What to Test' notes for a build. action=submit_beta_review (confirm): submit a build for external testing review (requires beta review contact info set once in App Store Connect → TestFlight → Test Information). Builds must be VALID and have export compliance answered (asc_builds).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `groups` \| `testers` \| `status` \| `create_group` \| `add_testers` \| `remove_testers` \| `add_build_to_group` \| `set_what_to_test` \| `submit_beta_review` | yes |  |
| `app` | string |  | App id or bundle ID. |
| `group_id` | string |  |  |
| `group_name` | string |  | create_group: name. |
| `internal` | boolean |  | create_group: internal group (default false = external). |
| `public_link` | boolean |  | create_group: enable a public TestFlight link (external groups). |
| `testers` | object[] |  |  |
| `build_id` | string |  |  |
| `what_to_test` | string |  |  |
| `locale` | string |  | set_what_to_test: default en-US. |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## app_store

**App Store versions, metadata, review submission and release** — mutating (preview → confirm_token)

action=versions: App Store versions and their states. action=create_version (confirm). action=attach_build (confirm): select the processed build for a version. action=localizations / update_localization (confirm): description, keywords, What's New, promotional text, support/marketing URLs per locale. action=submit_for_review (confirm): creates a review submission with the version and submits it. action=review_status. action=release (confirm): release a version approved with manual release. action=phased_release (confirm): start a 7-day phased rollout. Screenshots, pricing, privacy labels and age rating are easiest in the web UI (or asc_api).

| Argument | Type | Required | Description |
|---|---|---|---|
| `action` | `versions` \| `create_version` \| `attach_build` \| `localizations` \| `update_localization` \| `submit_for_review` \| `review_status` \| `release` \| `phased_release` | yes |  |
| `app` | string |  | App id or bundle ID. |
| `platform` | `iOS` \| `macOS` \| `tvOS` \| `visionOS` |  | Default iOS. |
| `version_id` | string |  |  |
| `version_string` | string |  | create_version: e.g. 1.2.0 (must match CFBundleShortVersionString). |
| `release_type` | `MANUAL` \| `AFTER_APPROVAL` \| `SCHEDULED` |  |  |
| `build_id` | string |  |  |
| `locale` | string |  | update_localization: default en-US. |
| `description` | string |  |  |
| `keywords` | string |  |  |
| `whats_new` | string |  |  |
| `promotional_text` | string |  |  |
| `support_url` | string |  |  |
| `marketing_url` | string |  |  |
| `profile` | string |  | Credential profile name from asc_auth configure (defaults to env vars / default profile). |

## ci_config

**Generate a CI workflow for signing + notarization / upload** — mutating (preview → confirm_token)

Generates a GitHub Actions workflow for a target (mac-developer-id, testflight-ios, ios-app-store, mac-app-store, testflight-mac) and framework (xcode, electron, tauri, flutter, react-native, expo, swiftpm, prebuilt): temporary keychain + set-key-partition-list (avoids errSecInternalComponent), API key from secrets, archive/export with automatic signing via the API key (or the framework's own signing), notarytool --wait + staple, artifact upload, and keychain cleanup. Returns the YAML and the list of repository secrets to create. Writing to output_path needs confirmation only when overwriting.

| Argument | Type | Required | Description |
|---|---|---|---|
| `target` | `mac-developer-id` \| `testflight-ios` \| `ios-app-store` \| `mac-app-store` \| `testflight-mac` | yes |  |
| `framework` | `xcode` \| `electron` \| `tauri` \| `flutter` \| `react-native` \| `expo` \| `swiftpm` \| `prebuilt` | yes |  |
| `app_name` | string | yes | Product / scheme name (used for paths). |
| `scheme` | string |  |  |
| `workspace` | string |  | Relative .xcworkspace path (xcode). |
| `app_path` | string |  | Built .app path expression (prebuilt / custom layouts). |
| `runner` | string |  | GitHub runner label (default macos-15). |
| `output_path` | string |  | e.g. .github/workflows/release.yml |
