---
"notarize-mcp": patch
---

Add the `/notarize:setup` skill, a zero-dependency script that checks and installs App Store Connect API credentials. The `apple-distribution` guide now documents where the API key lives (`~/.appstoreconnect/private_keys/`, `ASC_*` env vars) and the order the server resolves credentials in.
