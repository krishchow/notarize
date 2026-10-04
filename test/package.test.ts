import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("package", () => {
  it("keeps plugin.json and package.json versions in sync", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(await readFile(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.version).toBe(pkg.version);
  });

  it("publishes a self-contained tarball (bundle + skill, no runtime dependencies)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT }).toString(),
    );
    const files = packed.files.map((f: { path: string }) => f.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "dist/notarize-mcp.js",
        "skills/apple-distribution/SKILL.md",
        "README.md",
        "LICENSE",
      ]),
    );
    expect(files.some((f: string) => f.startsWith("src/") || f.startsWith("test/"))).toBe(false);
  });

  it("bump-version sets both versions and the plugin's npx pin without reformatting; rejects non-semver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bump-"));
    await mkdir(join(dir, ".claude-plugin"));
    const plugin = readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8");
    await writeFile(join(dir, "package.json"), readFileSync(join(ROOT, "package.json"), "utf8"));
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), plugin);
    const script = join(ROOT, "scripts", "bump-version.mjs");
    execFileSync("node", [script, "1.4.0-beta.2", dir]);
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).version).toBe("1.4.0-beta.2");
    const bumped = await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf8");
    expect(bumped).toBe(
      plugin
        .replace(/"version": "[^"]*"/, '"version": "1.4.0-beta.2"')
        .replace(/"notarize-mcp@[^"]*"/, '"notarize-mcp@1.4.0-beta.2"'),
    );
    expect(JSON.parse(bumped).mcpServers.notarize.args).toEqual(["-y", "notarize-mcp@1.4.0-beta.2"]);
    expect(() => execFileSync("node", [script, "1.4", dir], { stdio: "pipe" })).toThrow();
  });

  it("release workflow is manual-only, publishes after the checks and pushes main only after publishing", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(wf).toContain("secrets.NPM_TOKEN");
    expect(wf).toContain("scripts/bump-version.mjs");
    expect(wf.indexOf("npm run check")).toBeGreaterThan(0);
    expect(wf.indexOf("npm run check")).toBeLessThan(wf.indexOf('npm publish "'));
    // The marketplace reads main: the plugin must never pin a version npm doesn't have yet.
    expect(wf.indexOf('git push origin "v$VERSION"')).toBeLessThan(wf.indexOf('npm publish "'));
    expect(wf.indexOf('npm publish "')).toBeLessThan(wf.indexOf("git push origin HEAD:main"));
  });
});
