# Gatekeeper debugging

Gatekeeper evaluates **quarantined** files (anything downloaded by a browser, AirDrop, Messages, many chat apps) on first open. Files you build locally are not quarantined, so "it works on my Mac" proves nothing — always test with `gatekeeper action=simulate_download`.

## What users see → cause
| Dialog | Usual cause | Check |
|---|---|---|
| "can't be opened because Apple cannot check it for malicious software" / "Apple could not verify … is free of malware" / "developer cannot be verified" | Not notarized, or not Developer ID | `gatekeeper assess` → `source=Unnotarized Developer ID` / `no usable signature` |
| "… is damaged and can't be opened. You should move it to the Trash." | Signature invalid: modified after signing, unsigned nested code, broken symlinks from a bad zip | `inspect_code_signature` on the downloaded copy |
| App opens from Downloads but auto-update / resources break | App Translocation (quarantined app run in place) | Ship a DMG, ask users to move to /Applications |
| Nothing happens / bounces and quits | AMFI kill (invalid signature, missing profile for restricted entitlements) | `crash_reports`, `system_logs preset=amfi` |

## Tools
- `gatekeeper action=assess path=…` — spctl with the right type (.app execute, .pkg install, .dmg open+primary-signature).
- `gatekeeper action=syspolicy_check` — macOS 14+ `syspolicy_check distribution` (Apple's own pre-flight; very informative).
- `gatekeeper action=simulate_download` — copies, quarantines like Safari, mounts DMGs / extracts zips, assesses, checks staple, runs syspolicy_check; `launch=true` actually opens it and collects syspolicyd/AMFI logs.
- `quarantine action=get|set|clear` — inspect or toggle the attribute. `xattr -dr com.apple.quarantine` is a **local workaround only**; never the fix to ship.
- `system_logs preset=gatekeeper` — syspolicyd decisions.

## Manual equivalents
```bash
spctl --assess --type execute -vvv App.app
spctl --assess --type open --context context:primary-signature -vvv App.dmg
spctl --assess --type install -vvv App.pkg
syspolicy_check distribution App.app
xcrun stapler validate App.app
log show --last 10m --predicate 'process == "syspolicyd"'
```
