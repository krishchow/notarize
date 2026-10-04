# React Native and Expo

## Bare React Native
- Native project: `ios/<Name>.xcworkspace` (after `cd ios && pod install`). Always build the **workspace**.
- `xcode action=archive path=ios scheme=<Name> target=testflight-ios` → `xcode action=export destination=upload` → `asc_builds wait_processing`.
- Version: `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in the Xcode project (or `react-native-version`).
- react-native-macos: `macos/<Name>.xcworkspace`, then the Developer ID or Mac App Store flow.

## Expo
A managed app (no `ios/` folder) can be built **locally** (prebuild + the `xcode` tool; certificates and profiles stay on this Mac and in the user's Apple account) or with **EAS** (Expo's cloud). Both are fine. Ask the user which they want instead of assuming EAS.

### Managed workflow — EAS
- EAS Build creates/stores certificates and profiles on Expo's servers (`eas credentials`), using your Apple account or an **App Store Connect API key** (recommended; same key as here).
- `eas.json` → `submit.production.ios`: `ascAppId` (numeric app id from `asc_apps`), `ascApiKeyPath`, `ascApiKeyIssuerId`, `ascApiKeyId`.
- `eas build -p ios --profile production` then `eas submit -p ios --latest` (or `--auto-submit`).
- This server still helps with: API key setup (`asc_auth`), bundle ID + capabilities (`asc_bundle_ids`), app record checks, TestFlight groups/testers, App Store metadata/submission, debugging rejections.
- `app.json` → `expo.ios.bundleIdentifier`, `expo.ios.buildNumber` (or `autoIncrement` in eas.json), privacy strings in `expo.ios.infoPlist`, privacy manifest via `expo.ios.privacyManifests`.

### Local builds (prebuild)
- `npx expo prebuild -p ios` generates `ios/` (and runs `pod install`); then follow the bare React Native flow above. Many Expo projects gitignore `ios/` and regenerate it, so put everything in app config, not in the Xcode project.
- Set `expo.ios.bundleIdentifier`, `expo.ios.appleTeamId` and `expo.ios.buildNumber` in `app.json`; prebuild copies them into the Xcode project.
- `xcode action=archive` with automatic signing and the API key lets Xcode create the Apple Distribution certificate and App Store profile itself, but only once the team has a registered device. Otherwise use manual signing (see testflight-and-app-store.md). Re-running prebuild overwrites native changes.
- **pnpm / monorepos:**
  - `expo prebuild` may add `expo`, `react` and `react-native` to `dependencies`, even when they're already declared elsewhere. Review the `package.json` diff and revert what you don't want; `--no-install` avoids an install in the meantime.
  - The Release build bundles JavaScript with Babel. Under pnpm's strict layout, `babel.config.js` can't load `babel-preset-expo` unless the app declares it, so add it as a devDependency at the version already in the lockfile. Without it, the archive gets through signing and then fails while bundling the JavaScript, saying babel-preset-expo can't be found.
