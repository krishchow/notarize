# Prebuilt artifacts (no source)

You have only a `.app`, `.dmg`, `.pkg`, `.ipa`, `.xcarchive` or a CLI binary.

1. `detect_project path=<artifact>` → what it is, bundle ID, version, embedded profile.
2. `inspect_code_signature path=<artifact> target=<target>` → current signer, runtime, timestamp, nested problems.
3. Fix:
   - **Mac app, wrong/no signature** → `sign path=App.app identity=auto target=mac-developer-id` (pass `entitlements` if it needs any; check the old ones with `entitlements action=read`). For many helpers with different entitlements use `nested_entitlements`.
   - **iOS .ipa for another team/profile** → `resign path=App.ipa profile=new.mobileprovision identity=auto target=ios-ad-hoc` (extensions need `extension_profiles`).
   - **.xcarchive** → `xcode action=export archive_path=… target=…`.
   - **.pkg** → `package action=sign_pkg` (Developer ID Installer).
   - **CLI tool** → `sign` (hardened runtime + timestamp) → put it in a .pkg (`pkgbuild --root … --install-location /usr/local/bin`) or .zip → `notary submit`.
4. Package and notarize: `package action=dmg identity=auto` → `notarize_and_staple path=App.dmg` → `gatekeeper simulate_download`.

Only re-sign software you own or are licensed to redistribute.
