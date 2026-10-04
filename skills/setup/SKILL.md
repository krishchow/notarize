---
name: setup
description: One-time setup for Apple signing/notarization work. It checks the App Store Connect API key (ASC_KEY_ID, ASC_ISSUER_ID, the AuthKey .p8 file) and Team ID, and creates them if missing. Then it confirms a project's bundle ID, team and version, and that the bundle ID and app record exist on Apple's side. Use it on first use of notarize, when someone asks to "set up", "configure" or "init" Apple credentials or an API key, when a notarize tool says no API key is configured, or before shipping a project whose bundle ID hasn't been confirmed.
---

# notarize setup

This skill puts a machine, and optionally a project, into the state that the `apple-distribution` skill and the `notarize` MCP tools assume:

1. **Machine (credentials).** A valid App Store Connect API key is installed and visible to the MCP server, new shells, `xcodebuild` and `altool`.
2. **Project (metadata), optional.** The bundle ID, Team ID and version are confirmed with the user. The bundle ID is registered with Apple, and an app record exists if the target needs one.

**Never ask for or handle key contents.** Only ever ask for the Key ID, the Issuer ID, the Team ID and the *path* to the downloaded `.p8`.

## Part 1: credentials (deterministic script)

`scripts/setup.mjs` lives in this skill's base directory. It needs Node 20+ and has no dependencies. It prints one JSON object on stdout, and nothing it prints contains key material.

```bash
node <skill-dir>/scripts/setup.mjs check            # read-only; exit 0 = ready, 1 = not ready
node <skill-dir>/scripts/setup.mjs check --online   # also makes one authenticated call to Apple
node <skill-dir>/scripts/setup.mjs plan  --key-id ABCDE12345 --issuer-id <uuid> --team-id <TEAMID> --p8 ~/Downloads/AuthKey_ABCDE12345.p8
node <skill-dir>/scripts/setup.mjs apply <same arguments as plan>
```

Output fields:
- `ready`: true when no check failed.
- `resolved`: `keyId`, `issuerId`, `privateKeyPath`, `source`, `profile`, `configPath`, plus `discoveredKeys[]` (`{keyId, path}`) when no Key ID is configured but `AuthKey_<ID>.p8` files are already installed.
- `checks[]`: each has `{id, status: ok|warn|fail, message, fix?}`. The ids are stable: `platform`, `node_version`, `config_file`, `asc_key_id`, `asc_issuer_id`, `p8_path`, `p8_readable`, `p8_mode`, `p8_filename`, `team_id`, `persisted_shell`, `persisted_profile`, `xcode_tools`, `asc_online`.
- `actions[]`: what `plan` would do, or what `apply` did (marked `done: true`).
- `next_steps[]`: what to do next.

Exit codes: `0` means ready, or the plan was computed; `1` means not ready; `2` means bad input or a refused action. A refused action, such as overwriting a different key, comes back as an `error` field.

### Flow
1. Run `check`. If `ready` is true and there are no warnings you care about, say so in one line and move on.
2. If `resolved.discoveredKeys` is present, a key is **already installed**: the Key ID is in its filename. Confirm with the user that it is the key to use (if there are several, ask which), ask only for the **Issuer ID** and **Team ID**, and go to step 3 with `--key-id <ID>` and no `--p8`. Don't search other folders (like `~/Downloads`) yourself: the script already looks in every folder the tools read keys from (listed under "Resolution order" below), and asking the user for the path is more reliable than guessing.
3. Otherwise, if `asc_key_id` or `p8_path` fails, the user must create a key. That step is manual:
   1. Open App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** → **+**.
   2. Give the key the **Admin** role. App Manager covers most store and TestFlight tasks.
   3. Download the `.p8`. **It can be downloaded only once.**
   4. Bring back the **Key ID** (from the key's row), the **Issuer ID** (shown above the table) and the path of the downloaded file.

   The **Team ID** is at developer.apple.com → Account → Membership details.
4. Run `plan` with those values and show the user the `actions` in plain words. They are:
   - copy the `.p8` to `~/.appstoreconnect/private_keys/` and set it to mode 600 (skipped when it is already there);
   - add a marked block to `~/.zshrc`;
   - save a notarize-mcp profile.
5. After the user agrees, run `apply` with **identical arguments**, then run `check --online`.
6. Explain the result. The MCP server already sees the new profile, with no restart needed. **New terminals**, `xcodebuild` and `altool` see the env vars from `~/.zshrc`. Claude Code's own Bash tool sees them only after Claude Code is restarted.

`apply` is idempotent. Re-running it with a new `--issuer-id` or `--team-id` updates the block and the profile in place. If a *different* file already exists at the target path, `apply` refuses to overwrite it.

### Where the API key lives (the convention)
- **File:** `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`, mode 600. This is Apple's default location, so `xcodebuild -authenticationKeyPath`, `altool` and the MCP server all find the key by its Key ID.
- **Env vars** live in a block in `~/.zshrc` (or `~/.bash_profile`, or fish's `config.fish`, depending on `$SHELL`), between `# >>> notarize setup >>>` and `# <<< notarize setup <<<`. The block sets `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY_PATH`.
- **notarize-mcp profile:** `~/.config/notarize-mcp/config.json` (mode 600). It stores the key **path**, never its contents, plus the Team ID. The server reads it on every call.
- **Resolution order** (the same in the MCP server and in this script):
  1. an explicit `profile` argument (env vars are ignored in this case);
  2. the env vars `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY_PATH`, or `ASC_PRIVATE_KEY` inline for CI;
  3. the profile named by `ASC_PROFILE`, or else the default profile;
  4. `AuthKey_<KEYID>.p8` in `~/.appstoreconnect/private_keys`, `~/private_keys`, `~/.private_keys` or `~/.config/notarize-mcp/keys`.

## Part 2: project metadata (MCP tools + your editor)

Do this when the user names a project, or before the first build, upload or notarization of one. The goal is a confirmed set of values: **bundle ID, Team ID, app name, version + build number, and target(s)**.

1. Run **`detect_project path=<repo>`**. It reads the values from the framework's real source of truth (table below) and flags missing or inconsistent ones, such as different bundle IDs per configuration, no `DEVELOPMENT_TEAM`, or an Expo app without `ios.bundleIdentifier`.
2. **Confirm with the user.** Show what was found, for example: "Bundle ID `com.acme.notes`, team `ABCDE12345`, version 1.4.0 (build 12). Is that right?"
   - If no bundle ID is set, propose one in reverse-DNS form based on a domain they own. Explain that it is **permanent** once an app ships to the App Store or TestFlight. A Developer ID–only Mac app can rename later, but users lose their preferences and TCC grants.
   - If there are several targets (app plus extensions or widgets), each needs its own ID under the app's ID, e.g. `com.acme.notes.widget`.
3. **Write the confirmed values into the project's own files** with your editor. Never keep them in a side file, because the project files are what the build reads. Show the diff.
4. **Register with Apple** (these go through the confirm flow):
   - Look up the ID with `asc_bundle_ids action=list bundle_id=<id>`. If it is missing, run `asc_bundle_ids action=create bundle_id=<id> name=<App Name> platform=IOS|MAC_OS|UNIVERSAL`.
   - Enable the capabilities the entitlements need with `asc_bundle_ids action=enable_capability`.
   - For App Store or TestFlight targets, run `asc_apps action=find_by_bundle_id bundle_id=<id>`. If no record exists, `asc_apps action=create_instructions` gives the manual click path. The API can't create app records, so the user will also choose a **SKU** and **primary language** there.
5. If the Team ID was missing from the credentials profile, save it with `setup.mjs apply --team-id <ID>`.
6. Hand off to `apple-distribution`. Its next step is `distribution_checklist path=<repo> target=<target>`.

### Where the metadata lives, by project type

| Project | Bundle ID | Team ID | Version / build |
|---|---|---|---|
| **Xcode** (native, SwiftUI/UIKit/AppKit) | `PRODUCT_BUNDLE_IDENTIFIER` per target and config in `*.xcodeproj/project.pbxproj`, often via an `.xcconfig`. `Info.plist` has `CFBundleIdentifier = $(PRODUCT_BUNDLE_IDENTIFIER)` | `DEVELOPMENT_TEAM` in the same build settings (Signing & Capabilities) | `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` |
| **SwiftPM** executable | None until it is bundled: you supply an `Info.plist` with `CFBundleIdentifier` when building the `.app` | Signing identity at sign time | `CFBundleShortVersionString` / `CFBundleVersion` in that plist |
| **Expo** (managed) | `expo.ios.bundleIdentifier` in `app.json` / `app.config.(js\|ts)`; Android uses `expo.android.package` | `expo.ios.appleTeamId`, or EAS credentials | `expo.version` / `expo.ios.buildNumber`, or EAS `autoIncrement` |
| **React Native** (bare) / Expo prebuild | `ios/<App>.xcodeproj` build settings, like Xcode. After prebuild, `app.json` is the source and `ios/` is regenerated | `DEVELOPMENT_TEAM` in `ios/` | `ios/` build settings |
| **Flutter** | `ios/Runner.xcodeproj` (`PRODUCT_BUNDLE_IDENTIFIER`); for macOS, `macos/Runner/Configs/AppInfo.xcconfig` | `DEVELOPMENT_TEAM` in each Runner project | `version: 1.2.3+45` in `pubspec.yaml` (name + build) |
| **Electron** (electron-builder) | `build.appId` in `package.json` or `appId` in `electron-builder.yml` | `APPLE_TEAM_ID` env (notarize) / identity name | `version` in `package.json` (`buildVersion` optional) |
| **Electron** (Forge) | `packagerConfig.appBundleId` in `forge.config.*` | `osxNotarize.teamId` | `package.json` `version` |
| **Tauri** | `identifier` in `src-tauri/tauri.conf.json` (v2), or `tauri.bundle.identifier` (v1) | `APPLE_TEAM_ID` env / `bundle.macOS.signingIdentity` | `version` in `tauri.conf.json` (or `Cargo.toml`) |

Other metadata Apple will ask for, which you should collect at the same time when relevant:
- **App name** (display name, `CFBundleDisplayName`).
- **Category.** `LSApplicationCategoryType` is required for the Mac App Store.
- **Export compliance.** `ITSAppUsesNonExemptEncryption=false` in `Info.plist` skips the per-build question.
- **Minimum OS version.**
- **SKU and primary language** for the app record.
