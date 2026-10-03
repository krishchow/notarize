# Error catalog

<!-- Generated from src/knowledge/error-catalog.ts by `UPDATE_DOCS=1 npx vitest run test/docs.test.ts`. Do not edit by hand. -->

Tool results run every failure through this catalog automatically; this page is for reading ahead.

## keychain

### Waiting on a keychain access prompt / locked keychain

Matches: `timed out waiting for keychain access|User interaction is not allowed`

codesign needs the private key but macOS is waiting for someone to approve access (a GUI dialog) or the keychain is locked. Unattended agent runs, SSH sessions and CI cannot answer the dialog.

- On the Mac's screen click 'Always Allow' for codesign
- Unlock: security unlock-keychain ~/Library/Keychains/login.keychain-db
- Pre-authorize codesign: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> <keychain>
- Tool: `doctor`

### Keychain refused access to the signing key

Matches: `errSecInternalComponent`

codesign could not use the private key: the keychain is locked (common over SSH/CI), the key's access control does not allow codesign, or the certificate chain is incomplete.

- Unlock the keychain: security unlock-keychain ~/Library/Keychains/login.keychain-db
- CI/temporary keychains: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> <keychain>
- Install the Apple intermediate certificates (keychain action=install_intermediates)
- Tool: `keychain install_intermediates / signing_identities`


## codesign

### Certificate chain is incomplete or untrusted

Matches: `unable to build chain to self-signed root|CSSMERR_TP_NOT_TRUSTED|errSecNoTrustSettings`

The Apple intermediate CA (WWDR G3 or Developer ID G2) is missing, or someone changed the certificate's trust settings to 'Always Trust' (which breaks codesign).

- Install intermediates: keychain action=install_intermediates
- In Keychain Access, set the certificate's Trust back to 'Use System Defaults'
- Tool: `keychain install_intermediates`

### More than one matching signing identity

Matches: `ambiguous \(matches`

Several certificates share the same name (e.g. an expired and a renewed one).

- Pass the identity's SHA-1 hash instead of its name (signing_identities lists them)
- Delete expired duplicates from the keychain
- Tool: `signing_identities`

### Signing identity not found

Matches: `no identity found|The specified item could not be found in the keychain|not a valid identity`

There is no certificate WITH its private key matching that name in the searched keychains. Certificates downloaded without the private key that created the CSR cannot sign.

- List usable identities: signing_identities
- Import a .p12 that contains the private key (keychain import_p12), or create a new certificate from a fresh CSR (keychain create_csr → asc_certificates create)
- Tool: `signing_identities`

### Extended attributes on files in the bundle

Matches: `resource fork, Finder information, or similar detritus not allowed`

Files carry extended attributes (Finder info, quarantine, resource forks). Often caused by building inside iCloud Drive/Dropbox folders or copying with Finder.

- xattr -cr /path/to/App.app, then sign again
- Build outside cloud-synced folders
- Tool: `quarantine clear`

### Nested code is unsigned

Matches: `code object is not signed at all|In subcomponent:`

A framework, dylib, helper, plug-in or executable inside the bundle is not signed. Bundles must be signed inside-out: nested code first, outer bundle last.

- Use the sign tool (it signs nested code deepest-first)
- Never rely on --deep for signing
- Tool: `sign`

### Bundle changed after it was signed

Matches: `a sealed resource is missing or invalid|file added:|file modified:|file missing:`

Files were added, removed or modified after signing (post-build scripts, copying resources, editing Info.plist, stripping).

- Make all modifications first and sign last
- inspect_code_signature shows which file changed
- Re-sign the bundle (sign tool)
- Tool: `inspect_code_signature`

### Code or signature has been modified

Matches: `invalid signature \(code or signature have been modified\)|invalid Info\.plist \(plist or signature have been modified\)`

A binary changed after signing (strip, install_name_tool, lipo, patching) or the signature is from a revoked/expired certificate.

- Re-sign after the last modification (sign tool)
- Check the certificate is valid (signing_identities)
- Tool: `sign`

### Malformed bundle

Matches: `bundle format unrecognized, invalid, or unsuitable|bundle format is ambiguous`

The bundle structure is invalid — commonly a framework whose Versions/Current symlinks were flattened by `cp -r`/zip, or an Info.plist in the wrong location.

- Copy bundles with ditto or cp -a (preserve symlinks)
- Check Framework.framework/Versions/Current is a symlink to A

### Files in an unsealed location

Matches: `unsealed contents present in the (root directory of an embedded framework|bundle root)`

Only specific locations are sealed. Extra files at the bundle/framework root are not allowed.

- Move resources into Contents/Resources (or Versions/A/Resources for frameworks)

### Apple timestamp server unreachable

Matches: `The timestamp service is not available|timestamp.*(timed out|unavailable)`

codesign --timestamp contacts timestamp.apple.com; the network or proxy blocked it.

- Retry; check network/proxy access to timestamp.apple.com

### Certificate revoked

Matches: `CSSMERR_TP_CERT_REVOKED|certificate (has been )?revoked`

The signing certificate was revoked in the developer portal.

- Create a new certificate (keychain create_csr → asc_certificates create) and re-sign
- Tool: `asc_certificates`

### Certificate expired

Matches: `CSSMERR_TP_CERT_EXPIRED|certificate (has )?expired`

The signing certificate has expired. Builds signed with a timestamp before expiry stay valid; new signing needs a new certificate.

- Create a replacement certificate and remove the expired one from the keychain
- Tool: `asc_certificates`


## notarization

### Not signed with Developer ID

Matches: `not signed with a valid Developer ID certificate`

Notarization requires a Developer ID Application certificate. Apple Development/Distribution or ad-hoc signatures are rejected.

- Sign with 'Developer ID Application: <Name> (<TEAMID>)' (sign tool with target=mac-developer-id)
- Tool: `sign`

### Missing secure timestamp

Matches: `does not include a secure timestamp`

Every binary must be signed with --timestamp.

- Re-sign with --timestamp (the sign tool always adds it for distribution)
- Tool: `sign`

### Hardened runtime not enabled

Matches: `does not have the hardened runtime enabled`

Every executable must be signed with --options runtime.

- Xcode: ENABLE_HARDENED_RUNTIME = YES
- Electron: mac.hardenedRuntime=true; Tauri: bundle.macOS.hardenedRuntime=true
- Manual: codesign --options runtime
- Tool: `sign`

### Debug entitlement present

Matches: `requests the com\.apple\.security\.get-task-allow entitlement`

The build is debuggable (Debug configuration or development signing).

- Build the Release configuration
- Remove com.apple.security.get-task-allow from entitlements and re-sign
- Tool: `entitlements validate`

### Binary built with an ancient SDK

Matches: `uses an SDK older than the 10\.9 SDK`

A binary (often a bundled third-party tool) was linked against a macOS SDK older than 10.9.

- Rebuild that binary with a modern SDK, or remove it
- inspect_binary shows each binary's SDK
- Tool: `inspect_binary`

### Unsigned or invalid nested binary

Matches: `The binary is not signed|The signature of the binary is invalid`

A Mach-O inside the submission (possibly inside a nested zip/jar, node_modules *.node, Python .so) is unsigned or its signature is broken.

- Sign every Mach-O inside-out (sign tool discovers them)
- Sign binaries inside nested archives before archiving
- Tool: `sign`

### Installer package not signed

Matches: `(package|installer).*not signed|not signed with a Developer ID Installer`

A .pkg must be signed with a Developer ID Installer certificate.

- productsign --sign 'Developer ID Installer: …' in.pkg out.pkg (package action=pkg)
- Tool: `package`

### Upload archive invalid

Matches: `The archive is invalid|unable to (unzip|extract)|Invalid archive`

The zip was created in a way the notary service cannot read (e.g. Finder 'Compress' of an alias, zip without symlinks).

- Create with: ditto -c -k --sequesterRsrc --keepParent App.app App.zip (package action=zip)
- Tool: `package`

### Notary service authentication failed

Matches: `HTTP status code: 401|Unable to authenticate|invalid credentials|Error: (HTTP )?401`

The API key, Apple ID or app-specific password is wrong or revoked. Apple ID passwords must be app-specific passwords, not the account password.

- Re-store credentials with an App Store Connect API key (notary action=store_credentials)
- Tool: `notary store_credentials`

### Developer agreement not accepted

Matches: `required agreement|sign the relevant contracts|agreement.*(missing|expired|not.*accepted)`

Apple blocks notarization/uploads until the Account Holder accepts updated agreements.

- Account Holder: sign in at developer.apple.com/account and accept the pending agreement

### notarytool keychain profile missing

Matches: `No Keychain password item found for profile|keychain profile .* (not found|could not be found)`

The named --keychain-profile does not exist in this keychain.

- Create it: notary action=store_credentials
- Tool: `notary store_credentials`


## stapler

### No notarization ticket found

Matches: `Error 65|Record not found|Could not validate ticket|does not have a ticket stapled`

Apple has no ticket for this exact file: it was not notarized (or notarization was Invalid), it changed after submission (different cdhash), or the ticket is still propagating (wait a minute).

- Check status: notary action=history / status
- Staple the same .app/.dmg/.pkg you submitted (a .zip cannot be stapled — staple the app inside and re-zip)
- Retry after a minute if notarization just finished
- Tool: `notary status`

### File type cannot be stapled

Matches: `Error 73|is not a supported file type|Stapler is incapable of working with`

Only .app bundles, .dmg, and .pkg can be stapled; bare executables and .zip cannot.

- Staple the .app (then zip it), or ship a .dmg/.pkg
- Bare CLI tools rely on online ticket lookup instead


## gatekeeper

### Signed but not notarized

Matches: `source=Unnotarized Developer ID`

Gatekeeper sees a valid Developer ID signature but no notarization ticket.

- Notarize and staple (notarize_and_staple)
- Tool: `notarize_and_staple`

### No usable signature

Matches: `source=no usable signature|no usable signature`

The item is unsigned, ad-hoc signed, or the signature is broken.

- inspect_code_signature to see why
- Sign with Developer ID (sign)
- Tool: `inspect_code_signature`

### Wrong spctl assessment type

Matches: `the code is valid but does not seem to be an app`

spctl --type execute only applies to app bundles. Use --type install for .pkg and --type open for .dmg.

- Use gatekeeper action=assess (it picks the right type)
- Tool: `gatekeeper assess`

### Not a Developer ID signature

Matches: `origin=Apple (Development|Distribution)|source=Apple (Development|Distribution)|source=Mac App Store`

Development/App Store signatures are not trusted by Gatekeeper for direct downloads. Only Developer ID + notarization works outside the App Store.

- Re-sign with Developer ID Application and notarize
- Tool: `sign`

### "App is damaged"

Matches: `is damaged and can.t be opened|is damaged and should be moved to the Trash`

Shown for quarantined apps whose signature is invalid (modified after signing, broken nested signatures, unsigned arm64 code), not for merely unnotarized apps.

- inspect_code_signature on the downloaded copy
- Re-sign inside-out, notarize, staple; distribute in a .dmg or ditto-made zip
- Tool: `gatekeeper simulate_download`

### Gatekeeper cannot verify the developer

Matches: `developer cannot be verified|Apple could not verify|cannot check it for malicious software|unidentified developer`

The app is not notarized (or the ticket is missing and the Mac is offline), or it isn't Developer ID signed.

- notarize_and_staple, then re-test with gatekeeper simulate_download
- Tool: `notarize_and_staple`

### App Translocation

Matches: `AppTranslocation|translocat`

A quarantined app launched from where it was downloaded runs from a randomized read-only path, which breaks relative paths and updaters.

- Ship in a .dmg with an /Applications link and ask users to move the app
- Notarize + staple


## runtime

### Library validation blocked a library

Matches: `not valid for use in process|different Team IDs|mapping process and mapped file \(non-platform\) have different Team IDs`

Under the hardened runtime, a process may only load libraries signed by Apple or by the same Team ID.

- Re-sign the bundled library with your Developer ID (sign tool signs nested code)
- If you must load third-party plug-ins: add com.apple.security.cs.disable-library-validation
- Tool: `sign`

### dyld could not load a library

Matches: `Library not loaded:`

A linked library is missing from the bundle or its @rpath/install name is wrong.

- inspect_binary shows linked libraries and rpaths
- Embed the framework (Xcode: Embed & Sign)
- Tool: `inspect_binary`

### Restricted entitlement without a matching profile

Matches: `no eligible provisioning profiles found|Unsatisfied [Ee]ntitlements|Disallowing .* because no eligible provisioning profiles`

The app claims an entitlement (iCloud, push, associated domains, etc.) that must be granted by an embedded provisioning profile. AMFI kills it at launch.

- Create a profile for the target (MAC_APP_DIRECT for Developer ID) with the capability enabled (asc_bundle_ids enable_capability → asc_profiles create)
- Embed it at Contents/embedded.provisionprofile before signing (provisioning_profiles embed)
- Tool: `entitlements validate`

### Killed for an invalid code signature

Matches: `Namespace CODESIGNING|Code Signature Invalid|CODESIGNING, Code`

The kernel killed the process because a page failed signature validation or the signature is invalid.

- inspect_code_signature
- Re-sign after all modifications; check entitlements need a profile
- Tool: `inspect_code_signature`

### Process killed at launch (SIGKILL)

Matches: `[Kk]illed: 9`

On Apple silicon, arm64 code must be signed (at least ad-hoc); invalid signatures or unsatisfied entitlements cause an immediate SIGKILL.

- codesign -s - for local testing, or sign properly
- crash_reports and system_logs preset=amfi for details
- Tool: `crash_reports`

### App Sandbox denied an operation

Matches: `Sandbox: .*deny\(\d+\)`

The sandboxed process tried something its entitlements don't allow.

- system_logs preset=sandbox maps each denial to the entitlement that would allow it
- Tool: `system_logs`


## xcodebuild

### Xcode cannot find a signing certificate

Matches: `No signing certificate "([^"]+)" found|No certificate for team .* matching`

No certificate of the required type with its private key is in the keychain.

- Let Xcode create it: xcode archive with allow_provisioning_updates=true and an API key
- Or create/import manually (keychain create_csr → asc_certificates create)
- Tool: `signing_identities`

### No matching provisioning profile

Matches: `No profiles for '([^']+)' were found|requires a provisioning profile|No provisioning profiles? (with|matching)`

Automatic signing could not fetch/create a profile, or manual signing points to one that isn't installed.

- Archive with -allowProvisioningUpdates and API key auth (xcode archive)
- Or create + install one: asc_profiles create / download_install
- Tool: `asc_profiles`

### Profile does not contain your certificate

Matches: `Provisioning profile "[^"]+" doesn't include signing certificate`

The profile was generated for a different/older certificate.

- asc_profiles regenerate including the current certificate
- Or sign with the certificate the profile lists
- Tool: `asc_profiles regenerate`

### Profile lacks a capability/entitlement

Matches: `Provisioning profile "[^"]+" doesn't (support|include) the .* (capability|entitlement)`

The app's entitlements request a capability not enabled on the App ID or not present in the profile.

- asc_bundle_ids enable_capability, then asc_profiles regenerate
- Or remove the entitlement
- Tool: `asc_bundle_ids`

### No development team set

Matches: `requires a development team`

DEVELOPMENT_TEAM is empty for the target.

- Pass DEVELOPMENT_TEAM=<TEAMID> (xcode archive team_id=…) or set it in the target's Signing & Capabilities
- Tool: `xcode signing_settings`

### Automatic vs manual signing conflict

Matches: `has conflicting provisioning settings|is automatically signed, but provisioning profile .* has been manually specified|is automatically signed for development, but a conflicting code signing identity`

The target uses automatic signing but a specific identity/profile is forced (or vice-versa).

- For automatic: clear PROVISIONING_PROFILE_SPECIFIER and set CODE_SIGN_IDENTITY to 'Apple Development'
- For manual: CODE_SIGN_STYLE=Manual with an explicit profile
- Tool: `xcode signing_settings`

### No registered devices

Matches: `Your team has no devices from which to generate a provisioning profile`

Development/Ad Hoc profiles need at least one registered device.

- devices (get UDIDs) → asc_devices register
- Tool: `asc_devices`

### xcodebuild has no account to manage signing

Matches: `authenticationKey|Failed to authenticate|No Accounts|There are no accounts registered with Xcode`

Automatic signing in CI needs either an Xcode-logged-in account or App Store Connect API key flags.

- xcode archive with an API key profile (adds -authenticationKeyPath/ID/IssuerID)
- Tool: `xcode archive`


## upload

### Build number already used

Matches: `ITMS-90189|Redundant Binary Upload|bundle version .* has already been used`

CFBundleVersion must be unique (and increasing) per version train.

- Bump CURRENT_PROJECT_VERSION / CFBundleVersion (asc_builds list shows the latest)
- Tool: `asc_builds list`

### Version must be higher

Matches: `ITMS-90062|ITMS-90186|must contain a higher version than that of the previously approved version|train .* is closed`

CFBundleShortVersionString must be greater than the last approved/released version.

- Increase MARKETING_VERSION / CFBundleShortVersionString

### Missing privacy usage description

Matches: `ITMS-90683|Missing purpose string in Info\.plist`

The binary references a protected API but Info.plist lacks the matching NS*UsageDescription.

- Add the key named in the email/error with a user-facing explanation (privacy audit lists candidates)
- Tool: `privacy audit`

### Privacy manifest missing a required-reason API

Matches: `ITMS-91053|Missing API declaration`

The app (or an SDK) uses a required-reason API not declared in PrivacyInfo.xcprivacy.

- Add NSPrivacyAccessedAPITypes entries with the reason codes (privacy audit lists detected categories)
- Tool: `privacy audit`

### Third-party SDK missing its privacy manifest

Matches: `ITMS-91061|Missing privacy manifest`

A commonly-used SDK in the app lacks PrivacyInfo.xcprivacy or a valid signature.

- Update the SDK to a version that ships a privacy manifest

### Mac App Store build not sandboxed

Matches: `ITMS-90296|App sandbox not enabled`

Every executable in a Mac App Store app must have com.apple.security.app-sandbox.

- Add the sandbox entitlement to the app and all helpers (helpers: app-sandbox + inherit)
- Tool: `entitlements generate`

### Invalid provisioning profile

Matches: `ITMS-90161|Invalid Provisioning Profile`

The embedded profile is not an App Store distribution profile or doesn't match the bundle ID/team.

- Export with method app-store-connect; inspect the embedded profile (provisioning_profiles inspect)
- Tool: `provisioning_profiles inspect`

### Entitlements not allowed by the profile

Matches: `ITMS-90046|Invalid Code Signing Entitlements`

Signed entitlements contain keys/values the distribution profile does not grant.

- entitlements validate against the profile; enable the capability and regenerate the profile
- Tool: `entitlements validate`

### Not signed with a distribution certificate

Matches: `ITMS-90034|Missing or invalid signature`

App Store uploads must be signed with Apple Distribution (or legacy iOS/Mac distribution).

- Export with method app-store-connect, or re-sign with Apple Distribution

### Mac upload .pkg not signed correctly

Matches: `ITMS-90237|product archive package's signature is invalid`

The .pkg must be signed with the Mac Installer Distribution (3rd Party Mac Developer Installer) certificate.

- package action=pkg with the Mac Installer Distribution identity
- Tool: `package pkg`

### Mac TestFlight: helper missing profile / app identifier

Matches: `ITMS-90886|ITMS-90889|missing a provisioning profile|missing an application identifier`

For Mac TestFlight every executable bundle needs an embedded profile and the com.apple.application-identifier + team-identifier entitlements.

- Embed MAC_APP_STORE profiles in each helper/extension and include the identity entitlements
- Tool: `provisioning_profiles embed`

### Simulator architectures in the upload

Matches: `ITMS-90087|Unsupported Architectures`

An embedded framework contains simulator slices (x86_64/arm64-simulator).

- Use XCFrameworks, or strip simulator slices with lipo before signing
- Tool: `inspect_binary`

### Built with an SDK that is too old

Matches: `ITMS-90725|ITMS-90111|SDK version issue|built with .* SDK .* (older|unsupported)`

App Store Connect requires uploads to be built with a recent Xcode/SDK.

- Update Xcode (doctor shows the current minimum)
- Tool: `doctor`

### App icon has transparency

Matches: `ITMS-90717|Invalid App Store Icon`

The App Store icon must not have an alpha channel.

- Export the 1024×1024 icon without transparency

### Non-public API usage

Matches: `ITMS-90338|Non-public API usage`

The binary references private Apple APIs (often via a third-party SDK).

- Find the symbol named in the email; update/remove the SDK
