---
"notarize-mcp": major
---

1.0.0. Tool results now carry their `summary` in `structuredContent`, so clients that show only structured output (Claude Code) see it. Managed Expo apps are offered the local build route (prebuild + `xcode`) alongside EAS. `distribution_checklist` handles Expo's string `buildNumber` and drops the app-record step once the record exists. `signing_identities` reads the team from the certificate's subject OU, the no-devices archive error explains its real fixes, a missing-key error names installed `AuthKey_*.p8` files, and `/notarize:setup` leaves matching hand-written `ASC_*` exports alone.
