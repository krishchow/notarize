# Changesets

Releases of `notarize-mcp` (and the Claude Code plugin that pins it) are driven by [Changesets](https://github.com/changesets/changesets).

Add a changeset to every PR that changes what users get (server, tools, skills, plugin):

```bash
pnpm changeset               # pick patch / minor / major and write a one-line summary
```

This writes a markdown file to this folder and commits it (`"commit": true` in `config.json`). Use `pnpm changeset --empty` for PRs that should not release anything.

When changesets land on `main`, the Release workflow opens (or updates) a **Version Packages** PR that bumps `package.json` and writes `CHANGELOG.md`. Merging that PR publishes to npm and then pins the plugin to the new version. See [docs/releasing.md](../docs/releasing.md).
