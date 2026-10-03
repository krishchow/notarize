import { defineConfig } from "vitest/config";

// Opt-in tests against a real Apple developer account. See docs/testing.md.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
