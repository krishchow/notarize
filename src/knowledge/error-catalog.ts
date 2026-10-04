/**
 * Known failure messages from codesign, notarytool, stapler, spctl, xcodebuild,
 * altool/App Store Connect (ITMS-*), dyld/AMFI and crash reports, mapped to a
 * plain-language explanation and a concrete fix.
 */

export type ErrorSource =
  | "codesign"
  | "notarization"
  | "stapler"
  | "gatekeeper"
  | "runtime"
  | "xcodebuild"
  | "upload"
  | "keychain";

export interface KnownError {
  id: string;
  source: ErrorSource;
  pattern: RegExp;
  title: string;
  explanation: string;
  fix: string[];
  /** Tool/action that helps resolve it. */
  tool?: string;
  /** More generic entries this one explains; they are dropped from the matches when this one matches. */
  supersedes?: string[];
}

export const ERROR_CATALOG: KnownError[] = [
  // ---------------- keychain / codesign ----------------
  {
    id: "keychain-prompt-timeout",
    source: "keychain",
    pattern: /timed out waiting for keychain access|User interaction is not allowed/,
    title: "Waiting on a keychain access prompt / locked keychain",
    explanation:
      "codesign needs the private key but macOS is waiting for someone to approve access (a GUI dialog) or the keychain is locked. Unattended agent runs, SSH sessions and CI cannot answer the dialog.",
    fix: [
      "On the Mac's screen click 'Always Allow' for codesign",
      "Unlock: security unlock-keychain ~/Library/Keychains/login.keychain-db",
      "Pre-authorize codesign: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> <keychain>",
    ],
    tool: "doctor",
  },
  {
    id: "errSecInternalComponent",
    source: "keychain",
    pattern: /errSecInternalComponent/,
    title: "Keychain refused access to the signing key",
    explanation:
      "codesign could not use the private key: the keychain is locked (common over SSH/CI), the key's access control does not allow codesign, or the certificate chain is incomplete.",
    fix: [
      "Unlock the keychain: security unlock-keychain ~/Library/Keychains/login.keychain-db",
      "CI/temporary keychains: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> <keychain>",
      "Install the Apple intermediate certificates (keychain action=install_intermediates)",
    ],
    tool: "keychain install_intermediates / signing_identities",
  },
  {
    id: "chain-to-root",
    source: "codesign",
    pattern: /unable to build chain to self-signed root|CSSMERR_TP_NOT_TRUSTED|errSecNoTrustSettings/,
    title: "Certificate chain is incomplete or untrusted",
    explanation:
      "The Apple intermediate CA (WWDR G3 or Developer ID G2) is missing, or someone changed the certificate's trust settings to 'Always Trust' (which breaks codesign).",
    fix: [
      "Install intermediates: keychain action=install_intermediates",
      "In Keychain Access, set the certificate's Trust back to 'Use System Defaults'",
    ],
    tool: "keychain install_intermediates",
  },
  {
    id: "ambiguous-identity",
    source: "codesign",
    pattern: /ambiguous \(matches/,
    title: "More than one matching signing identity",
    explanation: "Several certificates share the same name (e.g. an expired and a renewed one).",
    fix: [
      "Pass the identity's SHA-1 hash instead of its name (signing_identities lists them)",
      "Delete expired duplicates from the keychain",
    ],
    tool: "signing_identities",
  },
  {
    id: "no-identity",
    source: "codesign",
    pattern: /no identity found|The specified item could not be found in the keychain|not a valid identity/,
    title: "Signing identity not found",
    explanation:
      "There is no certificate WITH its private key matching that name in the searched keychains. Certificates downloaded without the private key that created the CSR cannot sign.",
    fix: [
      "List usable identities: signing_identities",
      "Import a .p12 that contains the private key (keychain import_p12), or create a new certificate from a fresh CSR (keychain create_csr → asc_certificates create)",
    ],
    tool: "signing_identities",
  },
  {
    id: "detritus",
    source: "codesign",
    pattern: /resource fork, Finder information, or similar detritus not allowed/,
    title: "Extended attributes on files in the bundle",
    explanation:
      "Files carry extended attributes (Finder info, quarantine, resource forks). Often caused by building inside iCloud Drive/Dropbox folders or copying with Finder.",
    fix: ["xattr -cr /path/to/App.app, then sign again", "Build outside cloud-synced folders"],
    tool: "quarantine clear",
  },
  {
    id: "nested-unsigned",
    source: "codesign",
    pattern: /code object is not signed at all|In subcomponent:/,
    title: "Nested code is unsigned",
    explanation:
      "A framework, dylib, helper, plug-in or executable inside the bundle is not signed. Bundles must be signed inside-out: nested code first, outer bundle last.",
    fix: ["Use the sign tool (it signs nested code deepest-first)", "Never rely on --deep for signing"],
    tool: "sign",
  },
  {
    id: "sealed-resource",
    source: "codesign",
    pattern: /a sealed resource is missing or invalid|file added:|file modified:|file missing:/,
    title: "Bundle changed after it was signed",
    explanation:
      "Files were added, removed or modified after signing (post-build scripts, copying resources, editing Info.plist, stripping).",
    fix: [
      "Make all modifications first and sign last",
      "inspect_code_signature shows which file changed",
      "Re-sign the bundle (sign tool)",
    ],
    tool: "inspect_code_signature",
  },
  {
    id: "modified-binary",
    source: "codesign",
    pattern:
      /invalid signature \(code or signature have been modified\)|invalid Info\.plist \(plist or signature have been modified\)/,
    title: "Code or signature has been modified",
    explanation:
      "A binary changed after signing (strip, install_name_tool, lipo, patching) or the signature is from a revoked/expired certificate.",
    fix: [
      "Re-sign after the last modification (sign tool)",
      "Check the certificate is valid (signing_identities)",
    ],
    tool: "sign",
  },
  {
    id: "bundle-format",
    source: "codesign",
    pattern: /bundle format unrecognized, invalid, or unsuitable|bundle format is ambiguous/,
    title: "Malformed bundle",
    explanation:
      "The bundle structure is invalid — commonly a framework whose Versions/Current symlinks were flattened by `cp -r`/zip, or an Info.plist in the wrong location.",
    fix: [
      "Copy bundles with ditto or cp -a (preserve symlinks)",
      "Check Framework.framework/Versions/Current is a symlink to A",
    ],
  },
  {
    id: "unsealed-contents",
    source: "codesign",
    pattern: /unsealed contents present in the (root directory of an embedded framework|bundle root)/,
    title: "Files in an unsealed location",
    explanation:
      "Only specific locations are sealed. Extra files at the bundle/framework root are not allowed.",
    fix: ["Move resources into Contents/Resources (or Versions/A/Resources for frameworks)"],
  },
  {
    id: "timestamp-unavailable",
    source: "codesign",
    pattern: /The timestamp service is not available|timestamp.*(timed out|unavailable)/i,
    title: "Apple timestamp server unreachable",
    explanation: "codesign --timestamp contacts timestamp.apple.com; the network or proxy blocked it.",
    fix: ["Retry; check network/proxy access to timestamp.apple.com"],
  },
  {
    id: "cert-revoked",
    source: "codesign",
    pattern: /CSSMERR_TP_CERT_REVOKED|certificate (has been )?revoked/i,
    title: "Certificate revoked",
    explanation: "The signing certificate was revoked in the developer portal.",
    fix: ["Create a new certificate (keychain create_csr → asc_certificates create) and re-sign"],
    tool: "asc_certificates",
  },
  {
    id: "cert-expired",
    source: "codesign",
    pattern: /CSSMERR_TP_CERT_EXPIRED|certificate (has )?expired/i,
    title: "Certificate expired",
    explanation:
      "The signing certificate has expired. Builds signed with a timestamp before expiry stay valid; new signing needs a new certificate.",
    fix: ["Create a replacement certificate and remove the expired one from the keychain"],
    tool: "asc_certificates",
  },
  // ---------------- notarization ----------------
  {
    id: "notary-not-developer-id",
    source: "notarization",
    pattern: /not signed with a valid Developer ID certificate/,
    title: "Not signed with Developer ID",
    explanation:
      "Notarization requires a Developer ID Application certificate. Apple Development/Distribution or ad-hoc signatures are rejected.",
    fix: ["Sign with 'Developer ID Application: <Name> (<TEAMID>)' (sign tool with target=mac-developer-id)"],
    tool: "sign",
  },
  {
    id: "notary-no-timestamp",
    source: "notarization",
    pattern: /does not include a secure timestamp/,
    title: "Missing secure timestamp",
    explanation: "Every binary must be signed with --timestamp.",
    fix: ["Re-sign with --timestamp (the sign tool always adds it for distribution)"],
    tool: "sign",
  },
  {
    id: "notary-no-hardened-runtime",
    source: "notarization",
    pattern: /does not have the hardened runtime enabled/,
    title: "Hardened runtime not enabled",
    explanation: "Every executable must be signed with --options runtime.",
    fix: [
      "Xcode: ENABLE_HARDENED_RUNTIME = YES",
      "Electron: mac.hardenedRuntime=true; Tauri: bundle.macOS.hardenedRuntime=true",
      "Manual: codesign --options runtime",
    ],
    tool: "sign",
  },
  {
    id: "notary-get-task-allow",
    source: "notarization",
    pattern: /requests the com\.apple\.security\.get-task-allow entitlement/,
    title: "Debug entitlement present",
    explanation: "The build is debuggable (Debug configuration or development signing).",
    fix: [
      "Build the Release configuration",
      "Remove com.apple.security.get-task-allow from entitlements and re-sign",
    ],
    tool: "entitlements validate",
  },
  {
    id: "notary-old-sdk",
    source: "notarization",
    pattern: /uses an SDK older than the 10\.9 SDK/,
    title: "Binary built with an ancient SDK",
    explanation:
      "A binary (often a bundled third-party tool) was linked against a macOS SDK older than 10.9.",
    fix: ["Rebuild that binary with a modern SDK, or remove it", "inspect_binary shows each binary's SDK"],
    tool: "inspect_binary",
  },
  {
    id: "notary-binary-not-signed",
    source: "notarization",
    pattern: /The binary is not signed|The signature of the binary is invalid/,
    title: "Unsigned or invalid nested binary",
    explanation:
      "A Mach-O inside the submission (possibly inside a nested zip/jar, node_modules *.node, Python .so) is unsigned or its signature is broken.",
    fix: [
      "Sign every Mach-O inside-out (sign tool discovers them)",
      "Sign binaries inside nested archives before archiving",
    ],
    tool: "sign",
  },
  {
    id: "notary-pkg-unsigned",
    source: "notarization",
    pattern: /(package|installer).*not signed|not signed with a Developer ID Installer/i,
    title: "Installer package not signed",
    explanation: "A .pkg must be signed with a Developer ID Installer certificate.",
    fix: ["productsign --sign 'Developer ID Installer: …' in.pkg out.pkg (package action=pkg)"],
    tool: "package",
  },
  {
    id: "notary-archive-invalid",
    source: "notarization",
    pattern: /The archive is invalid|unable to (unzip|extract)|Invalid archive/i,
    title: "Upload archive invalid",
    explanation:
      "The zip was created in a way the notary service cannot read (e.g. Finder 'Compress' of an alias, zip without symlinks).",
    fix: ["Create with: ditto -c -k --sequesterRsrc --keepParent App.app App.zip (package action=zip)"],
    tool: "package",
  },
  {
    id: "notary-auth",
    source: "notarization",
    pattern: /HTTP status code: 401|Unable to authenticate|invalid credentials|Error: (HTTP )?401/i,
    title: "Notary service authentication failed",
    explanation:
      "The API key, Apple ID or app-specific password is wrong or revoked. Apple ID passwords must be app-specific passwords, not the account password.",
    fix: ["Re-store credentials with an App Store Connect API key (notary action=store_credentials)"],
    tool: "notary store_credentials",
  },
  {
    id: "notary-agreement",
    source: "notarization",
    pattern: /required agreement|sign the relevant contracts|agreement.*(missing|expired|not.*accepted)/i,
    title: "Developer agreement not accepted",
    explanation: "Apple blocks notarization/uploads until the Account Holder accepts updated agreements.",
    fix: ["Account Holder: sign in at developer.apple.com/account and accept the pending agreement"],
  },
  {
    id: "notary-no-profile",
    source: "notarization",
    pattern:
      /No Keychain password item found for profile|keychain profile .* (not found|could not be found)/i,
    title: "notarytool keychain profile missing",
    explanation: "The named --keychain-profile does not exist in this keychain.",
    fix: ["Create it: notary action=store_credentials"],
    tool: "notary store_credentials",
  },
  // ---------------- stapler ----------------
  {
    id: "staple-error-65",
    source: "stapler",
    pattern: /Error 65|Record not found|Could not validate ticket|does not have a ticket stapled/i,
    title: "No notarization ticket found",
    explanation:
      "Apple has no ticket for this exact file: it was not notarized (or notarization was Invalid), it changed after submission (different cdhash), or the ticket is still propagating (wait a minute).",
    fix: [
      "Check status: notary action=history / status",
      "Staple the same .app/.dmg/.pkg you submitted (a .zip cannot be stapled — staple the app inside and re-zip)",
      "Retry after a minute if notarization just finished",
    ],
    tool: "notary status",
  },
  {
    id: "staple-unsupported",
    source: "stapler",
    pattern: /Error 73|is not a supported file type|Stapler is incapable of working with/i,
    title: "File type cannot be stapled",
    explanation: "Only .app bundles, .dmg, and .pkg can be stapled; bare executables and .zip cannot.",
    fix: [
      "Staple the .app (then zip it), or ship a .dmg/.pkg",
      "Bare CLI tools rely on online ticket lookup instead",
    ],
  },
  // ---------------- gatekeeper ----------------
  {
    id: "gk-unnotarized",
    source: "gatekeeper",
    pattern: /source=Unnotarized Developer ID/,
    title: "Signed but not notarized",
    explanation: "Gatekeeper sees a valid Developer ID signature but no notarization ticket.",
    fix: ["Notarize and staple (notarize_and_staple)"],
    tool: "notarize_and_staple",
  },
  {
    id: "gk-no-usable-signature",
    source: "gatekeeper",
    pattern: /source=no usable signature|no usable signature/,
    title: "No usable signature",
    explanation: "The item is unsigned, ad-hoc signed, or the signature is broken.",
    fix: ["inspect_code_signature to see why", "Sign with Developer ID (sign)"],
    tool: "inspect_code_signature",
  },
  {
    id: "gk-not-an-app",
    source: "gatekeeper",
    pattern: /the code is valid but does not seem to be an app/,
    title: "Wrong spctl assessment type",
    explanation:
      "spctl --type execute only applies to app bundles. Use --type install for .pkg and --type open for .dmg.",
    fix: ["Use gatekeeper action=assess (it picks the right type)"],
    tool: "gatekeeper assess",
  },
  {
    id: "gk-wrong-cert",
    source: "gatekeeper",
    pattern:
      /origin=Apple (Development|Distribution)|source=Apple (Development|Distribution)|source=Mac App Store/,
    title: "Not a Developer ID signature",
    explanation:
      "Development/App Store signatures are not trusted by Gatekeeper for direct downloads. Only Developer ID + notarization works outside the App Store.",
    fix: ["Re-sign with Developer ID Application and notarize"],
    tool: "sign",
  },
  {
    id: "gk-damaged",
    source: "gatekeeper",
    pattern: /is damaged and can.t be opened|is damaged and should be moved to the Trash/,
    title: '"App is damaged"',
    explanation:
      "Shown for quarantined apps whose signature is invalid (modified after signing, broken nested signatures, unsigned arm64 code), not for merely unnotarized apps.",
    fix: [
      "inspect_code_signature on the downloaded copy",
      "Re-sign inside-out, notarize, staple; distribute in a .dmg or ditto-made zip",
    ],
    tool: "gatekeeper simulate_download",
  },
  {
    id: "gk-unverified",
    source: "gatekeeper",
    pattern:
      /developer cannot be verified|Apple could not verify|cannot check it for malicious software|unidentified developer/i,
    title: "Gatekeeper cannot verify the developer",
    explanation:
      "The app is not notarized (or the ticket is missing and the Mac is offline), or it isn't Developer ID signed.",
    fix: ["notarize_and_staple, then re-test with gatekeeper simulate_download"],
    tool: "notarize_and_staple",
  },
  {
    id: "gk-translocation",
    source: "gatekeeper",
    pattern: /AppTranslocation|translocat/i,
    title: "App Translocation",
    explanation:
      "A quarantined app launched from where it was downloaded runs from a randomized read-only path, which breaks relative paths and updaters.",
    fix: ["Ship in a .dmg with an /Applications link and ask users to move the app", "Notarize + staple"],
  },
  // ---------------- runtime (dyld / AMFI / sandbox) ----------------
  {
    id: "rt-library-validation",
    source: "runtime",
    pattern:
      /not valid for use in process|different Team IDs|mapping process and mapped file \(non-platform\) have different Team IDs/,
    title: "Library validation blocked a library",
    explanation:
      "Under the hardened runtime, a process may only load libraries signed by Apple or by the same Team ID.",
    fix: [
      "Re-sign the bundled library with your Developer ID (sign tool signs nested code)",
      "If you must load third-party plug-ins: add com.apple.security.cs.disable-library-validation",
    ],
    tool: "sign",
  },
  {
    id: "rt-library-not-loaded",
    source: "runtime",
    pattern: /Library not loaded:/,
    title: "dyld could not load a library",
    explanation: "A linked library is missing from the bundle or its @rpath/install name is wrong.",
    fix: ["inspect_binary shows linked libraries and rpaths", "Embed the framework (Xcode: Embed & Sign)"],
    tool: "inspect_binary",
  },
  {
    id: "rt-no-profile",
    source: "runtime",
    pattern:
      /no eligible provisioning profiles found|Unsatisfied [Ee]ntitlements|Disallowing .* because no eligible provisioning profiles/,
    title: "Restricted entitlement without a matching profile",
    explanation:
      "The app claims an entitlement (iCloud, push, associated domains, etc.) that must be granted by an embedded provisioning profile. AMFI kills it at launch.",
    fix: [
      "Create a profile for the target (MAC_APP_DIRECT for Developer ID) with the capability enabled (asc_bundle_ids enable_capability → asc_profiles create)",
      "Embed it at Contents/embedded.provisionprofile before signing (provisioning_profiles embed)",
    ],
    tool: "entitlements validate",
  },
  {
    id: "rt-codesigning-crash",
    source: "runtime",
    pattern: /Namespace CODESIGNING|Code Signature Invalid|CODESIGNING, Code/,
    title: "Killed for an invalid code signature",
    explanation:
      "The kernel killed the process because a page failed signature validation or the signature is invalid.",
    fix: ["inspect_code_signature", "Re-sign after all modifications; check entitlements need a profile"],
    tool: "inspect_code_signature",
  },
  {
    id: "rt-killed-9",
    source: "runtime",
    pattern: /[Kk]illed: 9/,
    title: "Process killed at launch (SIGKILL)",
    explanation:
      "On Apple silicon, arm64 code must be signed (at least ad-hoc); invalid signatures or unsatisfied entitlements cause an immediate SIGKILL.",
    fix: [
      "codesign -s - for local testing, or sign properly",
      "crash_reports and system_logs preset=amfi for details",
    ],
    tool: "crash_reports",
  },
  {
    id: "rt-sandbox-deny",
    source: "runtime",
    pattern: /Sandbox: .*deny\(\d+\)/,
    title: "App Sandbox denied an operation",
    explanation: "The sandboxed process tried something its entitlements don't allow.",
    fix: ["system_logs preset=sandbox maps each denial to the entitlement that would allow it"],
    tool: "system_logs",
  },
  // ---------------- xcodebuild ----------------
  {
    id: "xc-no-certificate",
    source: "xcodebuild",
    pattern: /No signing certificate "([^"]+)" found|No certificate for team .* matching/,
    title: "Xcode cannot find a signing certificate",
    explanation: "No certificate of the required type with its private key is in the keychain.",
    fix: [
      "Let Xcode create it: xcode archive with allow_provisioning_updates=true and an API key",
      "Or create/import manually (keychain create_csr → asc_certificates create)",
    ],
    tool: "signing_identities",
  },
  {
    id: "xc-no-profile",
    source: "xcodebuild",
    pattern:
      /No profiles for '([^']+)' were found|requires a provisioning profile|No provisioning profiles? (with|matching)/,
    title: "No matching provisioning profile",
    explanation:
      "Automatic signing could not fetch/create a profile, or manual signing points to one that isn't installed.",
    fix: [
      "Archive with -allowProvisioningUpdates and API key auth (xcode archive)",
      "Or create + install one: asc_profiles create / download_install",
    ],
    tool: "asc_profiles",
  },
  {
    id: "xc-profile-missing-cert",
    source: "xcodebuild",
    pattern: /Provisioning profile "[^"]+" doesn't include signing certificate/,
    title: "Profile does not contain your certificate",
    explanation: "The profile was generated for a different/older certificate.",
    fix: [
      "asc_profiles regenerate including the current certificate",
      "Or sign with the certificate the profile lists",
    ],
    tool: "asc_profiles regenerate",
  },
  {
    id: "xc-profile-missing-capability",
    source: "xcodebuild",
    pattern: /Provisioning profile "[^"]+" doesn't (support|include) the .* (capability|entitlement)/,
    title: "Profile lacks a capability/entitlement",
    explanation:
      "The app's entitlements request a capability not enabled on the App ID or not present in the profile.",
    fix: ["asc_bundle_ids enable_capability, then asc_profiles regenerate", "Or remove the entitlement"],
    tool: "asc_bundle_ids",
  },
  {
    id: "xc-requires-team",
    source: "xcodebuild",
    pattern: /requires a development team/,
    title: "No development team set",
    explanation: "DEVELOPMENT_TEAM is empty for the target.",
    fix: [
      "Pass DEVELOPMENT_TEAM=<TEAMID> (xcode archive team_id=…) or set it in the target's Signing & Capabilities",
    ],
    tool: "xcode signing_settings",
  },
  {
    id: "xc-conflicting-settings",
    source: "xcodebuild",
    pattern:
      /has conflicting provisioning settings|is automatically signed, but provisioning profile .* has been manually specified|is automatically signed for development, but a conflicting code signing identity/,
    title: "Automatic vs manual signing conflict",
    explanation:
      "The target uses automatic signing but a specific identity/profile is forced (or vice-versa).",
    fix: [
      "For automatic: clear PROVISIONING_PROFILE_SPECIFIER and set CODE_SIGN_IDENTITY to 'Apple Development'",
      "For manual: CODE_SIGN_STYLE=Manual with an explicit profile",
    ],
    tool: "xcode signing_settings",
  },
  {
    id: "xc-no-devices",
    source: "xcodebuild",
    pattern: /Your team has no devices from which to generate a provisioning profile/,
    title: "No registered devices",
    explanation:
      "Development/Ad Hoc profiles need at least one registered device. An iOS archive with automatic signing builds with an Apple Development profile first (distribution signing happens at export), so even App Store/TestFlight archives hit this on a team with no devices. -allowProvisioningUpdates does not help.",
    fix: [
      "Register any one device you own: devices (UDIDs of connected iPhones/iPads) → asc_devices register, then archive again",
      "Or skip development signing: asc_profiles create profile_type=IOS_APP_STORE → download_install, then xcode archive signing_style=manual signing_certificate='Apple Distribution' provisioning_profiles={<bundle id>: <profile name>}",
    ],
    tool: "asc_devices",
    supersedes: ["xc-no-profile"],
  },
  {
    id: "xc-auth-key",
    source: "xcodebuild",
    pattern:
      /authenticationKey|Failed to authenticate|No Accounts|There are no accounts registered with Xcode/,
    title: "xcodebuild has no account to manage signing",
    explanation:
      "Automatic signing in CI needs either an Xcode-logged-in account or App Store Connect API key flags.",
    fix: ["xcode archive with an API key profile (adds -authenticationKeyPath/ID/IssuerID)"],
    tool: "xcode archive",
  },
  // ---------------- upload / App Store Connect ----------------
  {
    id: "itms-90189",
    source: "upload",
    pattern: /ITMS-90189|Redundant Binary Upload|bundle version .* has already been used/i,
    title: "Build number already used",
    explanation: "CFBundleVersion must be unique (and increasing) per version train.",
    fix: ["Bump CURRENT_PROJECT_VERSION / CFBundleVersion (asc_builds list shows the latest)"],
    tool: "asc_builds list",
  },
  {
    id: "itms-90062",
    source: "upload",
    pattern:
      /ITMS-90062|ITMS-90186|must contain a higher version than that of the previously approved version|train .* is closed/i,
    title: "Version must be higher",
    explanation: "CFBundleShortVersionString must be greater than the last approved/released version.",
    fix: ["Increase MARKETING_VERSION / CFBundleShortVersionString"],
  },
  {
    id: "itms-90683",
    source: "upload",
    pattern: /ITMS-90683|Missing purpose string in Info\.plist/i,
    title: "Missing privacy usage description",
    explanation:
      "The binary references a protected API but Info.plist lacks the matching NS*UsageDescription.",
    fix: [
      "Add the key named in the email/error with a user-facing explanation (privacy audit lists candidates)",
    ],
    tool: "privacy audit",
  },
  {
    id: "itms-91053",
    source: "upload",
    pattern: /ITMS-91053|Missing API declaration/i,
    title: "Privacy manifest missing a required-reason API",
    explanation: "The app (or an SDK) uses a required-reason API not declared in PrivacyInfo.xcprivacy.",
    fix: [
      "Add NSPrivacyAccessedAPITypes entries with the reason codes (privacy audit lists detected categories)",
    ],
    tool: "privacy audit",
  },
  {
    id: "itms-91061",
    source: "upload",
    pattern: /ITMS-91061|Missing privacy manifest/i,
    title: "Third-party SDK missing its privacy manifest",
    explanation: "A commonly-used SDK in the app lacks PrivacyInfo.xcprivacy or a valid signature.",
    fix: ["Update the SDK to a version that ships a privacy manifest"],
  },
  {
    id: "itms-90296",
    source: "upload",
    pattern: /ITMS-90296|App sandbox not enabled/i,
    title: "Mac App Store build not sandboxed",
    explanation: "Every executable in a Mac App Store app must have com.apple.security.app-sandbox.",
    fix: ["Add the sandbox entitlement to the app and all helpers (helpers: app-sandbox + inherit)"],
    tool: "entitlements generate",
  },
  {
    id: "itms-90161",
    source: "upload",
    pattern: /ITMS-90161|Invalid Provisioning Profile/i,
    title: "Invalid provisioning profile",
    explanation:
      "The embedded profile is not an App Store distribution profile or doesn't match the bundle ID/team.",
    fix: [
      "Export with method app-store-connect; inspect the embedded profile (provisioning_profiles inspect)",
    ],
    tool: "provisioning_profiles inspect",
  },
  {
    id: "itms-90046",
    source: "upload",
    pattern: /ITMS-90046|Invalid Code Signing Entitlements/i,
    title: "Entitlements not allowed by the profile",
    explanation: "Signed entitlements contain keys/values the distribution profile does not grant.",
    fix: ["entitlements validate against the profile; enable the capability and regenerate the profile"],
    tool: "entitlements validate",
  },
  {
    id: "itms-90034",
    source: "upload",
    pattern: /ITMS-90034|Missing or invalid signature/i,
    title: "Not signed with a distribution certificate",
    explanation: "App Store uploads must be signed with Apple Distribution (or legacy iOS/Mac distribution).",
    fix: ["Export with method app-store-connect, or re-sign with Apple Distribution"],
  },
  {
    id: "itms-90237",
    source: "upload",
    pattern: /ITMS-90237|product archive package's signature is invalid/i,
    title: "Mac upload .pkg not signed correctly",
    explanation:
      "The .pkg must be signed with the Mac Installer Distribution (3rd Party Mac Developer Installer) certificate.",
    fix: ["package action=pkg with the Mac Installer Distribution identity"],
    tool: "package pkg",
  },
  {
    id: "itms-90886",
    source: "upload",
    pattern: /ITMS-90886|ITMS-90889|missing a provisioning profile|missing an application identifier/i,
    title: "Mac TestFlight: helper missing profile / app identifier",
    explanation:
      "For Mac TestFlight every executable bundle needs an embedded profile and the com.apple.application-identifier + team-identifier entitlements.",
    fix: ["Embed MAC_APP_STORE profiles in each helper/extension and include the identity entitlements"],
    tool: "provisioning_profiles embed",
  },
  {
    id: "itms-90087",
    source: "upload",
    pattern: /ITMS-90087|Unsupported Architectures/i,
    title: "Simulator architectures in the upload",
    explanation: "An embedded framework contains simulator slices (x86_64/arm64-simulator).",
    fix: ["Use XCFrameworks, or strip simulator slices with lipo before signing"],
    tool: "inspect_binary",
  },
  {
    id: "itms-sdk-version",
    source: "upload",
    pattern: /ITMS-90725|ITMS-90111|SDK version issue|built with .* SDK .* (older|unsupported)/i,
    title: "Built with an SDK that is too old",
    explanation: "App Store Connect requires uploads to be built with a recent Xcode/SDK.",
    fix: ["Update Xcode (doctor shows the current minimum)"],
    tool: "doctor",
  },
  {
    id: "itms-90717",
    source: "upload",
    pattern: /ITMS-90717|Invalid App Store Icon/i,
    title: "App icon has transparency",
    explanation: "The App Store icon must not have an alpha channel.",
    fix: ["Export the 1024×1024 icon without transparency"],
  },
  {
    id: "itms-90338",
    source: "upload",
    pattern: /ITMS-90338|Non-public API usage/i,
    title: "Non-public API usage",
    explanation: "The binary references private Apple APIs (often via a third-party SDK).",
    fix: ["Find the symbol named in the email; update/remove the SDK"],
  },
];

export interface ErrorMatch {
  id: string;
  source: ErrorSource;
  title: string;
  explanation: string;
  fix: string[];
  tool?: string;
  matched: string;
}

/** Find all known errors mentioned in a blob of tool output. */
export function matchKnownErrors(text: string, sources?: ErrorSource[]): ErrorMatch[] {
  const out: ErrorMatch[] = [];
  const seen = new Set<string>();
  const superseded = new Set<string>();
  for (const e of ERROR_CATALOG) {
    if (sources && !sources.includes(e.source)) continue;
    const m = e.pattern.exec(text);
    if (m && !seen.has(e.id)) {
      seen.add(e.id);
      for (const id of e.supersedes ?? []) superseded.add(id);
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const matched = text
        .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        .trim()
        .slice(0, 300);
      out.push({
        id: e.id,
        source: e.source,
        title: e.title,
        explanation: e.explanation,
        fix: e.fix,
        tool: e.tool,
        matched,
      });
    }
  }
  return out.filter((m) => !superseded.has(m.id));
}

export function formatMatches(matches: ErrorMatch[]): string {
  return matches
    .map(
      (m) =>
        `• ${m.title}: ${m.explanation}\n  Fix: ${m.fix.join(" | ")}${m.tool ? `\n  Tool: ${m.tool}` : ""}`,
    )
    .join("\n");
}
