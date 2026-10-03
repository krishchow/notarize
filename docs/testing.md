# Testing

Four layers, from cheapest to most real. GitHub Actions is **manual only** (`workflow_dispatch`), so run these locally.

## 1. Unit + integration tests: any OS, no credentials
```bash
npm run check          # biome + tsc + vitest
```
- macOS commands are scripted with `FakeRunner` (`src/core/fake-runner.ts`):
  ```ts
  runner.on("codesign", ["-dvvv"], { stderr: fixture })
  ```
  Unmatched commands fail loudly. Use `{ timedOut: true }` to simulate hangs.
- The App Store Connect API is faked with `fakeAsc({ "GET /v1/apps": { body } })` (`test/helpers.ts`), using real ES256 JWTs from `ascEnv()`.
- Tools are exercised through a real MCP client over an in-memory transport:
  ```ts
  makeCtx() → connect(ctx) → call() / callConfirmed()
  ```
  `callConfirmed()` covers the preview → `confirm_token` round trip.
- Hand-written fixtures live in `test/fixtures/*.txt|json|ips`.
- `test/docs.test.ts` keeps the generated docs fresh (`UPDATE_DOCS=1` to regenerate) and checks SKILL.md only names real tools.

## 2. Recorded real-macOS output (macOS, no credentials)
```bash
bash scripts/record-fixtures.sh            # writes test/fixtures/recorded/*.txt (+ .exit)
bash scripts/record-fixtures.sh --with-notary   # also `notarytool history` (needs credentials)
npm run test:recorded
```
- Records what this Mac's tools actually print: `codesign`, `spctl`, `security`, `otool`, `lipo`, `xcodebuild`, `syspolicy_check`, and the `altool` / `notarytool` help text.
- Paths, user names, team names and Team IDs are redacted. Review the files before committing them.
- `test/recorded.test.ts` runs the parsers on whatever has been recorded and skips anything missing, so it passes on Linux.

## 3. Smoke test (macOS, no credentials)
```bash
npm run build && bash scripts/smoke-macos.sh
```
1. Builds a universal Hello.app with a nested dylib (`scripts/lib/build-test-app.sh`).
2. Drives the **bundled** server over stdio (`scripts/smoke-client.mjs`) with `NOTARIZE_MCP_AUTO_CONFIRM=1` (safe policy):
   - doctor, detect, ad-hoc `sign` with hardened runtime, inspect, binary inspection, entitlements;
   - Gatekeeper rejection;
   - zip/dmg packaging, simulated download, quarantine;
   - logs, identities, profiles;
   - the `watch-job` CLI.

## 4. Live Apple account (opt-in, never destructive)
```bash
export NOTARIZE_LIVE=1 ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_PRIVATE_KEY_PATH=~/…/AuthKey_….p8
npm run test:live
```
**Read-only checks:**
- `asc_auth test`;
- listing apps, bundle IDs, certificates, profiles and devices;
- `notary history`;
- `distribution_checklist`.

**`NOTARIZE_LIVE_NOTARIZE=1`** (macOS with a Developer ID Application identity) adds an end-to-end run:
1. builds the test app;
2. `sign identity=auto target=mac-developer-id`;
3. `notarize_and_staple`, followed with the `watch-job` watcher;
4. `gatekeeper simulate_download`, which must be accepted.

This **uploads the tiny test app to Apple's notary service**; nothing else is created or changed.

These still need confirming against a real account:
- Developer ID certificate creation via the API (expect a 403 and the manual steps).
- The exact `altool --upload-package` flags (see `test/fixtures/recorded/altool-help.txt`).
- The TestFlight / review submission endpoints. There is no non-destructive live test for these; try them on a throwaway app record.
- The App Store minimum-Xcode table in `src/knowledge/sdk-requirements.ts`.

In CI, the `live` job (manual dispatch with `live: true`) uses the `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` and optional `NOTARIZE_LIVE_NOTARIZE` secrets.
