---
"notarize-mcp": patch
---

Build `dist` during install (`prepare`), so installing the package from a git URL — including the DeepSeek Harness bundle's `github:` install — produces a runnable server instead of one whose `npx` row resolves a dist-less local copy and fails to start with `SdkError: Connection closed`.
