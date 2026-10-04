# notarize-mcp

## 0.3.0

### Minor Changes

- [`68aac7c`](https://github.com/krishchow/notarize/commit/68aac7ce1aa2dd2e389b8e2d1c2d9c2d0d8d2da1) Thanks [@krishchow](https://github.com/krishchow)! - `/notarize:setup` now finds an `AuthKey_<ID>.p8` that is already installed when no Key ID is configured: `check` reports it (and its Key ID) instead of telling the user to create a new key, and `plan`/`apply` use it when it is the only one.
  The skill also tells agents to say where each value (Issuer ID, Team ID, Key ID, `.p8`) comes from whenever they ask for it.

## 0.2.1

### Patch Changes

- [#8](https://github.com/krishchow/notarize/pull/8) [`5f8decb`](https://github.com/krishchow/notarize/commit/5f8decbac7bed4544f1739156af8fcea46f87638) Thanks [@krishchow](https://github.com/krishchow)! - Add the `/notarize:setup` skill, a zero-dependency script that checks and installs App Store Connect API credentials. The `apple-distribution` guide now documents where the API key lives (`~/.appstoreconnect/private_keys/`, `ASC_*` env vars) and the order the server resolves credentials in.
