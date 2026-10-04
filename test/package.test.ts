import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("package", () => {
  it("pins the plugin to its own version, never ahead of package.json", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(await readFile(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.mcpServers.notarize.args).toEqual(["-y", `notarize-mcp@${plugin.version}`]);
    // Between merging the Version Packages PR and the release workflow's sync-plugin job,
    // package.json is ahead of the plugin; the plugin is never ahead.
    const core = (v: string) => v.split("-")[0].split(".").map(Number);
    const [a, b] = [core(plugin.version), core(pkg.version)];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    expect(cmp).toBeLessThanOrEqual(0);
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
        "skills/setup/SKILL.md",
        "skills/setup/scripts/setup.mjs",
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

  it("release workflow uses changesets, publishes after the checks and pins the plugin only after publishing", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // Actions minutes are scarce: main pushes that touch release inputs, or manual runs. Never PRs.
    expect(wf).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths:/m);
    expect(wf).toMatch(/^ {2}workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s+(pull_request|pull_request_target|schedule):/m);
    for (const step of ["select-mode", "version", "publish"]) {
      expect(wf).toContain(`uses: changesets/action/${step}@v2`);
    }
    // pnpm publish runs prepublishOnly, so the full check gates every publish.
    expect(pkg.scripts.prepublishOnly).toBe("pnpm run check");
    // The Version Packages PR must not move the plugin pin: main would then pin an unpublished version.
    expect(pkg.scripts["version-packages"]).not.toContain("bump-version");
    expect(wf).toContain("script: pnpm run version-packages");
    // The marketplace reads main: the plugin is pinned only after npm has the version.
    const sync = wf.slice(wf.indexOf("  sync-plugin:"));
    expect(sync).toContain("needs: [select-mode, publish]");
    const onNpm = sync.indexOf('npm view "$PACKAGE@$version" version');
    const bump = sync.indexOf("scripts/bump-version.mjs");
    const push = sync.indexOf("git push origin HEAD:main");
    expect(onNpm).toBeGreaterThan(0);
    // npm lags behind a fresh publish: wait for it, and fail rather than skip when this run published.
    expect(sync).toContain("PUBLISH_RESULT: ${{ needs.publish.result }}");
    expect(sync).toMatch(/sleep \d+/);
    expect(sync).toContain("exit 1");
    expect(onNpm).toBeLessThan(bump);
    expect(bump).toBeLessThan(push);
    expect(wf.slice(0, wf.indexOf("  sync-plugin:"))).not.toContain("bump-version");
  });

  it("changesets config publishes notarize-mcp publicly from main", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"));
    expect(config).toMatchObject({ baseBranch: "main", access: "public" });
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.devDependencies["@changesets/cli"]).toBeDefined();
    // The changelog generator named in the config must be installed, or `changeset version` fails.
    const changelog = [config.changelog].flat()[0];
    if (changelog.startsWith("@changesets/") && changelog !== "@changesets/cli/changelog") {
      expect(pkg.devDependencies[changelog]).toBeDefined();
    }
  });
});
