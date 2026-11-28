import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "notarize-mcp": "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  // Bundle every dependency so the published package has no dependencies and `npx` starts fast.
  noExternal: [/.*/],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __notarizeCreateRequire } from "node:module";',
      "const require = __notarizeCreateRequire(import.meta.url);",
      // npx only warns about `engines`, so refuse plainly before any bundled code runs. Kept in
      // step with "engines" in package.json (test/package.test.ts checks both).
      'const [__notarizeNodeMajor, __notarizeNodeMinor] = process.versions.node.split(".").map(Number);',
      "if (__notarizeNodeMajor < 22 || (__notarizeNodeMajor === 22 && __notarizeNodeMinor < 13)) {",
      '  process.stderr.write("notarize-mcp needs Node 22.13 or later; this is Node " + process.versions.node + ".\\n");',
      "  process.exit(1);",
      "}",
    ].join("\n"),
  },
});
