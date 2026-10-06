# fastlane

fastlane drives the release; the notarize tools check and fix what it produces. Don't rewrite a working Fastfile into tool calls, and don't generate Fastfiles. Use the tools to set up credentials, check the output of each step and explain failures.

`detect_project` reports a fastlane setup: the `app_identifier` / `team_id` literals from `fastlane/Appfile` (flagged when they don't match the project's own bundle ID or team) and the public lanes from the `Fastfile` (e.g. `fastlane mac release`).

## Credentials: one API key for everything
- **Prefer the App Store Connect API key over an Apple ID.** `app_store_connect_api_key(key_id:, issuer_id:, key_filepath:)` loads it once per lane. Pass the result as `api_key:` to `notarize`, `upload_to_testflight`, `deliver`, `match` and `sigh` (most of them also pick it up from the lane context). The key the `setup` skill installs is at `~/.appstoreconnect/private_keys/AuthKey_<ID>.p8`, with `ASC_KEY_ID` / `ASC_ISSUER_ID` exported.
- `notarize` takes `api_key:` / `api_key_path:` (a fastlane-format JSON file, **not** the `.p8`). With neither, it falls back to an Apple ID plus an app-specific password.
- **Lanes that run `xcrun notarytool` themselves** (via `sh`) should use `--keychain-profile <name>`. Create the profile with `notary action=store_credentials profile_name=<name>`, or the `setup` skill's Part 1c. It is a keychain copy of the key: recreate it after rotating the key.
- **Never put key contents, passwords or `.p12` files in the Fastfile or Appfile.** Read them from env vars.

## Signing identity
- Pass the full identity, e.g. `"Developer ID Application: Name (TEAMID)"`; `signing_identities` lists them. **`-` means ad-hoc**: the build runs locally but Gatekeeper rejects it after download, and notarization rejects it ("The binary is not signed with a valid Developer ID certificate"). Scripts that default `CODESIGN_IDENTITY` to `-` for dev builds must fail loudly in the release lane when it isn't set.
- Developer ID needs hardened runtime (`--options runtime`) and a secure timestamp (`--timestamp`) on every nested binary, signed inside-out. `inspect_code_signature path=<app> target=mac-developer-id` finds what's missing before you upload.
- **`match` vs `keychain export_p12`:** `match` keeps certificates and profiles in a git repo or bucket, shared across a team; a solo developer or a single CI job can use `keychain action=export_p12` and a CI secret instead (see [ci.md](ci.md)). Don't mix the two for the same certificate type: `match nuke` revokes certificates created outside it.

## DMG
- `create-dmg` (the shell script) and `appdmg` lay out the window by scripting Finder. Without **Automation → Finder** permission for the terminal (System Settings → Privacy & Security → Automation), or on CI or over SSH, they hang or fail with `Not authorized to send Apple events to Finder (-1743)`.
- To build a styled DMG headlessly, use `package action=dmg` with `background` / `icon_positions` / `window_size` (it uses `dmgbuild`, which writes `.DS_Store` directly), or call `dmgbuild` from the lane. A plain DMG (`package action=dmg`, or `create-dmg --skip-jenkins`) notarizes just as well.
- Sign the DMG itself (`codesign --sign <Developer ID Application> --timestamp`), then notarize the DMG and staple the DMG. Stapling the .app inside afterwards changes nothing users download.

## Checks after the lane
1. `inspect_code_signature path=<dmg or app> target=mac-developer-id`
2. `staple action=validate path=<dmg>`
3. `gatekeeper action=simulate_download path=<dmg>`: quarantines a copy and assesses it the way a downloaded file is.
4. `privacy action=audit path=<app>`: under hardened runtime, Photos, camera, microphone, contacts, calendars and location also need the `com.apple.security.personal-information.*` / `device.*` entitlements, or access is denied without a prompt.

On a rejection, `notary action=log submission_id=<id>` groups the issues and maps each to a fix. The `submission_id` is in fastlane's output (`notarytool submit` prints `id:`).

## CI
`ci_config framework=custom build_command="bundle exec fastlane mac release" target=mac-developer-id app_name=<Name>` generates a workflow that:
- imports the certificate into a temporary keychain;
- writes the API key;
- stores a notarytool profile in that keychain;
- exports `NOTARY_PROFILE`, `NOTARY_KEYCHAIN`, `CODESIGN_IDENTITY` and `ASC_*`;
- then runs your lane.

The lane stays the single source of truth for the build. On CI the profile lives in the temporary keychain, so a lane that runs `notarytool` must add `--keychain "$NOTARY_KEYCHAIN"` when that variable is set. Alternatively, it can call `app_store_connect_api_key(key_filepath: ENV["ASC_KEY_PATH"], ...)` and skip the profile.
