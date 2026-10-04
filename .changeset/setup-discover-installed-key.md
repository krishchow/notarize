---
"notarize-mcp": minor
---

`/notarize:setup` now finds an `AuthKey_<ID>.p8` that is already installed when no Key ID is configured: `check` reports it (and its Key ID) instead of telling the user to create a new key, and `plan`/`apply` use it when it is the only one.
The skill also tells agents to say where each value (Issuer ID, Team ID, Key ID, `.p8`) comes from whenever they ask for it.
