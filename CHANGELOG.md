# notarize-mcp

## 1.4.1

### Patch Changes

- [#25](https://github.com/krishchow/notarize/pull/25) [`a856092`](https://github.com/krishchow/notarize/commit/a85609270e4217fbba54040f2c1152ae817a6bef) Thanks [@krishchow](https://github.com/krishchow)! - Keep signature inspection concise, preserve full evidence in structured results, and avoid recommending notarization for artifacts with a stapled ticket.

- [#25](https://github.com/krishchow/notarize/pull/25) [`dd58424`](https://github.com/krishchow/notarize/commit/dd584241101d63530f72a57fce4fb8896c23fefe) Thanks [@krishchow](https://github.com/krishchow)! - Focus Gatekeeper, doctor, distribution checklist, signing identity, binary inspection, and privacy audit output on verdicts and actionable findings while preserving complete reports in structured content.

## 1.4.0

### Minor Changes

- [#23](https://github.com/krishchow/notarize/pull/23) [`296d266`](https://github.com/krishchow/notarize/commit/296d2662f056ea876c24bb12e5bfff6817329d37) Thanks [@krishchow](https://github.com/krishchow)! - Add target-aware app debugging sessions for Mac, iPhone/iPad, and simulator apps with bounded evidence capture, optional normal-user live device logging and Homebrew setup, Apple-native snapshots, explicit access gaps, Console imports, and a dedicated debugging skill.

### Patch Changes

- [#23](https://github.com/krishchow/notarize/pull/23) [`296d266`](https://github.com/krishchow/notarize/commit/296d2662f056ea876c24bb12e5bfff6817329d37) Thanks [@krishchow](https://github.com/krishchow)! - Honor explicit advance approval for actions within the user's agreed scope while preserving previews, confirmation tokens and renewed approval for expanded scope or material new risks.

## 1.3.0

### Minor Changes

- [#21](https://github.com/krishchow/notarize/pull/21) [`6881566`](https://github.com/krishchow/notarize/commit/6881566a688fe2ccb2da947bc94af26bc4ba1b88) Thanks [@krishchow](https://github.com/krishchow)! - Improve TestFlight setup with explicit invitation sending and accurate tester states, surface upload-processing failures before builds become visible, fix capability listing and resource-bundle signature false positives, and document App Group assignment and manual-signing recovery before archiving.

## 1.2.1

### Patch Changes

- [#19](https://github.com/krishchow/notarize/pull/19) [`a179fbe`](https://github.com/krishchow/notarize/commit/a179fbed5a8342aef726b1ee783d061989fc7f39) Thanks [@krishchow](https://github.com/krishchow)! - Build `dist` during install (`prepare`), so installing the package from a git URL — including the DeepSeek Harness bundle's `github:` install — produces a runnable server instead of one whose `npx` row resolves a dist-less local copy and fails to start with `SdkError: Connection closed`.

## 1.2.0

### Minor Changes

- [#17](https://github.com/krishchow/notarize/pull/17) [`3d470f6`](https://github.com/krishchow/notarize/commit/3d470f69ad1c9cb7ca924d31c1995f25a7c954fc) Thanks [@krishchow](https://github.com/krishchow)! - The repository is now a Codex plugin: `codex plugin marketplace add krishchow/notarize` then `codex plugin add notarize@notarize` installs the MCP server and both skills, with `setup` as the onboarding skill. The server's credential variables are listed so Codex forwards them to the child process.

- [#17](https://github.com/krishchow/notarize/pull/17) [`3d470f6`](https://github.com/krishchow/notarize/commit/3d470f69ad1c9cb7ca924d31c1995f25a7c954fc) Thanks [@krishchow](https://github.com/krishchow)! - The package is now a DeepSeek Harness bundle: installing it into a DSH profile (`plugin_manager` `install_bundle`, or the sidebar's Plugins page) mounts the MCP server as `mcp__notarize__*` tools and adds both skills, `apple-distribution` and `setup`, to the session catalog.

## 1.1.0

### Minor Changes

- [#15](https://github.com/krishchow/notarize/pull/15) [`66fbf4a`](https://github.com/krishchow/notarize/commit/66fbf4a389c0578fac1086061ffa67254ce2c9aa) Thanks [@krishchow](https://github.com/krishchow)! - `ci_config framework=custom build_command=…` runs your own release command (such as a fastlane lane) after setting up the keychain, API key and a notarytool profile.

- [#15](https://github.com/krishchow/notarize/pull/15) [`66fbf4a`](https://github.com/krishchow/notarize/commit/66fbf4a389c0578fac1086061ffa67254ce2c9aa) Thanks [@krishchow](https://github.com/krishchow)! - `detect_project` reports fastlane setups: Appfile `app_identifier`/`team_id`, checked against the project, plus the Fastfile lanes.

- [#15](https://github.com/krishchow/notarize/pull/15) [`66fbf4a`](https://github.com/krishchow/notarize/commit/66fbf4a389c0578fac1086061ffa67254ce2c9aa) Thanks [@krishchow](https://github.com/krishchow)! - `package action=dmg` can build a styled DMG (background, window size, icon size and positions) with `dmgbuild`, without scripting Finder, so it works on CI and headless Macs.

### Patch Changes

- [#15](https://github.com/krishchow/notarize/pull/15) [`66fbf4a`](https://github.com/krishchow/notarize/commit/66fbf4a389c0578fac1086061ffa67254ce2c9aa) Thanks [@krishchow](https://github.com/krishchow)! - Add a fastlane guide to the apple-distribution skill, and an error catalog entry for DMG tools blocked from scripting Finder (-1743).

- [#15](https://github.com/krishchow/notarize/pull/15) [`66fbf4a`](https://github.com/krishchow/notarize/commit/66fbf4a389c0578fac1086061ffa67254ce2c9aa) Thanks [@krishchow](https://github.com/krishchow)! - Setup now offers to store a notarytool keychain profile for scripts, fastlane and CI, and `check --online` verifies the profile still works (for example after an API key rotation).

## 1.0.0

### Major Changes

- [#13](https://github.com/krishchow/notarize/pull/13) [`28f7fbd`](https://github.com/krishchow/notarize/commit/28f7fbdddc7a3d09c2676b3029eed80e0af27154) Thanks [@krishchow](https://github.com/krishchow)! - 1.0.0. Tool results now carry their `summary` in `structuredContent`, so clients that show only structured output (Claude Code) see it. Managed Expo apps are offered the local build route (prebuild + `xcode`) alongside EAS. `distribution_checklist` handles Expo's string `buildNumber` and drops the app-record step once the record exists. `signing_identities` reads the team from the certificate's subject OU, the no-devices archive error explains its real fixes, a missing-key error names installed `AuthKey_*.p8` files, and `/notarize:setup` leaves matching hand-written `ASC_*` exports alone.
  `/notarize:setup` can also register a connected iPhone/iPad, reading its UDID itself, and explains who needs a registered device.
  `xcode action=archive signing_style=manual` no longer silently ignores `signing_certificate` / `provisioning_profiles`: it checks the app targets' own signing settings and lists exactly what to set, without overriding them for Pods targets.
  The apple-distribution skill now says which steps go through the tools and which the agent runs itself, and tells agents to name the tool when showing a preview, so a previewed command isn't mistaken for an improvised one.
  Long-running tools (`xcode`, `upload_build`, `sign`, `resign`) now hand off to a background job after 90 seconds by default instead of 120–900, so the Monitor command arrives before Claude Code backgrounds the call itself.
  Creating or importing a certificate for a key generated by `create_csr` now says why the key must be backed up (Apple can't reissue it) and makes `keychain export_p12`, with its arguments filled in, the first next step.
  `/notarize:setup` also sets up an internal TestFlight group with the user as a tester, once per app.

## 0.3.0

### Minor Changes

- [`68aac7c`](https://github.com/krishchow/notarize/commit/68aac7ce1aa2dd2e389b8e2d1c2d9c2d0d8d2da1) Thanks [@krishchow](https://github.com/krishchow)! - `/notarize:setup` now finds an `AuthKey_<ID>.p8` that is already installed when no Key ID is configured: `check` reports it (and its Key ID) instead of telling the user to create a new key, and `plan`/`apply` use it when it is the only one.
  The skill also tells agents to say where each value (Issuer ID, Team ID, Key ID, `.p8`) comes from whenever they ask for it.

## 0.2.1

### Patch Changes

- [#8](https://github.com/krishchow/notarize/pull/8) [`5f8decb`](https://github.com/krishchow/notarize/commit/5f8decbac7bed4544f1739156af8fcea46f87638) Thanks [@krishchow](https://github.com/krishchow)! - Add the `/notarize:setup` skill, a zero-dependency script that checks and installs App Store Connect API credentials. The `apple-distribution` guide now documents where the API key lives (`~/.appstoreconnect/private_keys/`, `ASC_*` env vars) and the order the server resolves credentials in.
