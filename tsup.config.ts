import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "notarize-mcp": "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  // Bundle every dependency so the git-installed Claude Code plugin only needs Node.
  noExternal: [/.*/],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __notarizeCreateRequire } from "node:module";',
      "const require = __notarizeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
