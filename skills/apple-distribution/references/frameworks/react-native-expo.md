# React Native and Expo

## Bare React Native
- Native project: `ios/<Name>.xcworkspace` (after `cd ios && pod install`). Always build the **workspace**.
- `xcode action=archive path=ios scheme=<Name> target=testflight-ios` → `xcode action=export destination=upload` → `asc_builds wait_processing`.
- Version: `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in the Xcode project (or `react-native-version`).
- react-native-macos: `macos/<Name>.xcworkspace`, then the Developer ID or Mac App Store flow.

## Expo
### Managed workflow (no `ios/` folder) — EAS
- EAS Build creates/stores certificates and profiles on Expo's servers (`eas credentials`), using your Apple account or an **App Store Connect API key** (recommended; same key as here).
- `eas.json` → `submit.production.ios`: `ascAppId` (numeric app id from `asc_apps`), `ascApiKeyPath`, `ascApiKeyIssuerId`, `ascApiKeyId`.
- `eas build -p ios --profile production` then `eas submit -p ios --latest` (or `--auto-submit`).
- This server still helps with: API key setup (`asc_auth`), bundle ID + capabilities (`asc_bundle_ids`), app record checks, TestFlight groups/testers, App Store metadata/submission, debugging rejections.
- `app.json` → `expo.ios.bundleIdentifier`, `expo.ios.buildNumber` (or `autoIncrement` in eas.json), privacy strings in `expo.ios.infoPlist`, privacy manifest via `expo.ios.privacyManifests`.

### Prebuild / local builds
`npx expo prebuild -p ios` generates `ios/`; then follow the bare React Native flow. Re-running prebuild overwrites native changes — put signing settings in app config, not by hand.
