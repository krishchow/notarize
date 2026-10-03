# Distribution targets

| Target | Certificates (keychain, with private key) | Profile | Sandbox | Hardened runtime | Package | After build |
|---|---|---|---|---|---|---|
| `mac-developer-id` | Developer ID Application (+ Developer ID Installer for .pkg) | MAC_APP_DIRECT only if restricted entitlements | optional | **required** | .dmg / .zip / .pkg | notarize → staple → Gatekeeper test |
| `mac-app-store` | Apple Distribution + Mac Installer Distribution | MAC_APP_STORE (always) | **required** | optional | .pkg (productbuild) | upload → review |
| `testflight-mac` | same as mac-app-store | MAC_APP_STORE in **every** executable bundle | **required** | optional | .pkg | upload → TestFlight |
| `ios-app-store` | Apple Distribution | IOS_APP_STORE | n/a | n/a | .ipa | upload → version → review |
| `testflight-ios` | Apple Distribution | IOS_APP_STORE | n/a | n/a | .ipa | upload → groups/testers |
| `ios-ad-hoc` | Apple Distribution | IOS_APP_ADHOC (+ device UDIDs) | n/a | n/a | .ipa | install via Configurator / OTA |
| `ios-development` | Apple Development | IOS_APP_DEVELOPMENT (+ devices) | n/a | n/a | — | run from Xcode |
| `mac-development` | Apple Development | MAC_APP_DEVELOPMENT only for restricted entitlements | optional | optional | — | run locally |
| `enterprise` | In-house distribution (Enterprise Program) | IOS_APP_INHOUSE | n/a | n/a | .ipa | MDM / internal site |

## Choosing
- "People download it from my website / GitHub / Homebrew" → **mac-developer-id**. No App Review, no sandbox requirement, but notarization is mandatory for a smooth first launch.
- "I want it in the Mac App Store" → **mac-app-store** (sandbox required; some apps — e.g. those needing Accessibility APIs, kernel/system extensions, or arbitrary file access — don't fit).
- "Beta testers" → **testflight-ios** / **testflight-mac** (internal testers: up to 100 team members, no review; external: up to 10,000 via email or public link, beta review per version).
- "A handful of specific iPhones without the store" → **ios-ad-hoc** (100 devices per device family per membership year).
- "iOS users in general" → **ios-app-store** (no sideloading outside the EU's alternative marketplaces, which are out of scope here).

## ExportOptions `method` names
Xcode 15.3+ renamed methods: `app-store` → `app-store-connect`, `ad-hoc` → `release-testing`, `development` → `debugging`. `developer-id` and `enterprise` are unchanged. The `xcode` tool picks the right name for the installed Xcode.
