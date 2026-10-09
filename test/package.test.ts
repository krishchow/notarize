import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

// The plugin surfaces that ship outside the npm tarball, read from the repo.
const codexManifest = () => JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
// Deliberately not `.mcp.json`: Claude Code reads a project-root `.mcp.json` as project-scoped
// servers, so that name would give this repo's Claude Code sessions a second `notarize` server.
// The Codex manifest points at this path explicitly, so the name is ours to choose.
const codexMcp = () => JSON.parse(readFileSync(join(ROOT, "codex.mcp.json"), "utf8"));
const packageJson = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

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
        "cordis.patch.yml",
        "README.md",
        "LICENSE",
      ]),
    );
    expect(files.some((f: string) => f.startsWith("src/") || f.startsWith("test/"))).toBe(false);
    // The plugin manifests belong to the marketplaces that read the git repo, not to the npm
    // package: publishing them would advertise plugins the tarball cannot serve.
    for (const dir of [".claude-plugin/", ".codex-plugin/", ".agents/"]) {
      expect(
        files.some((f: string) => f.startsWith(dir)),
        `${dir} must not be published`,
      ).toBe(false);
    }
    expect(files).not.toContain("codex.mcp.json");
    expect(files).not.toContain(".mcp.json");
  });

  it("declares a DeepSeek Harness bundle that mounts the server and both skills", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // The manifest fields DSH reads. `bundle.patch` is relative to the package root.
    expect(pkg.dsh.manifestVersion).toBe(1);
    expect(pkg.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(pkg.engines.dsh).toBeDefined();
    // A bundle the tarball doesn't ship installs as a package with no patch, which DSH rejects.
    expect(pkg.files).toContain("cordis.patch.yml");

    const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    // Rows are added, never overrides: dsh-web-app disables the host skill row and owns preset rows,
    // so this bundle must contribute its own uniquely named rows instead of reconfiguring theirs.
    expect(patch).toMatch(/^- insert:/m);
    expect(patch).not.toMatch(/^- id:/m);
    expect(patch).not.toMatch(/^ {4}disabled:/m);

    // The server row: the same npx pin as the Claude Code plugin, under the `notarize` namespace
    // (tools arrive as mcp__notarize__<tool>), launched over stdio.
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toMatch(/^ {8}serverName: notarize$/m);
    expect(patch).toMatch(/^ {8}transport: stdio$/m);
    expect(patch).toMatch(/^ {8}command: npx$/m);
    expect(patch).toMatch(/^ {10}- 'notarize-mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?'$/m);

    // The skills row: a second skill-filesystem provider scoped to this package only, read
    // host-side (bundledSkillDir) because the package sits outside the session workspace.
    expect(patch).toContain("name: '@deepseek-ai/dsh-skill-filesystem'");
    expect(patch).toMatch(/^ {8}providerName: notarize$/m);
    expect(patch).toMatch(/^ {8}includeDefaultRoots: false$/m);
    expect(patch).toMatch(/^ {8}bundledSkillDir: !!js /m);
    expect(patch).not.toMatch(/^\s*customSkillDirs:/m);
    // The root resolves at activation through the profile's baseUrl, which is where this package is
    // installed, so it works for a registry install and a local-path install alike.
    const root = patch.match(/bundledSkillDir: (!!js .*)$/m)?.[1] ?? "";
    for (const part of [
      "createRequire(new URL('resolve.mjs', baseUrl))",
      "'notarize-mcp/package.json'",
      "'skills'",
    ]) {
      expect(root, `bundledSkillDir should resolve through ${part}`).toContain(part);
    }
  });

  it("keeps the DSH server pin equal to package.json, unlike the plugin which may lag", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    const pins = [...patch.matchAll(/notarize-mcp@([0-9A-Za-z.+-]+)/g)].map((m) => m[1]);
    // The bundle layer has no version of its own, so its single pin is the only thing to keep in step.
    expect(pins).toEqual([pkg.version]);
  });

  it("ships skills that satisfy DeepSeek Harness discovery (kebab-case name, description)", () => {
    // DSH silently drops a skill whose frontmatter it rejects, so an invalid name or a missing
    // description would make the skill invisible in a DSH session with no error to grep for.
    for (const dir of ["apple-distribution", "setup"]) {
      const file = join(ROOT, "skills", dir, "SKILL.md");
      const front = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
      expect(front, `${dir}/SKILL.md needs YAML frontmatter`).toBeTruthy();
      const fields: Record<string, string> = {};
      for (const line of front?.[1].split("\n") ?? []) {
        const kv = line.match(/^([A-Za-z-]+):\s*(.+)$/);
        if (kv) fields[kv[1]] = kv[2];
      }
      // The grammar @deepseek-ai/dsh-skill enforces; the directory name is what DSH discovers.
      expect(fields.name, `${dir}/SKILL.md must be kebab-case`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(fields.name).toBe(dir);
      expect(fields.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("declares a Codex plugin whose manifest, MCP server and marketplace entry all agree", () => {
    const pkg = packageJson();
    const manifest = codexManifest();
    const mcp = codexMcp();
    const market = JSON.parse(readFileSync(join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));

    // Codex rejects an install when the manifest name and the marketplace entry disagree, and
    // requires a name of ASCII alphanumerics, hyphens and underscores.
    expect(manifest.name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(manifest.version).toBe(pkg.version);
    const entry = market.plugins.find((p: { name: string }) => p.name === manifest.name);
    expect(entry, "the marketplace must list the plugin under the manifest's name").toBeDefined();
    // The docs require all three on every entry; a missing policy is an install-time surprise.
    expect(entry.policy).toMatchObject({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
    expect(entry.category).toBeTruthy();
    // This plugin lives at the repository root, so the entry points at the marketplace root itself.
    // The path must be `./`-prefixed and inside that root or Codex skips the entry silently.
    expect(entry.source).toEqual({ source: "local", path: "./" });

    // Codex silently ignores an invalid component path (no `./`, or any `..`), which would install
    // the plugin with no skills or no MCP server at all — so assert reachability, not just shape.
    const onboarding = manifest.extensions["com.openai"].onboardingSkill;
    for (const path of [manifest.skills, manifest.mcpServers, onboarding]) {
      expect(path, `${path} must be ./-relative`).toMatch(/^\.\//);
      expect(path).not.toContain("..");
      expect(existsSync(join(ROOT, path)), `${path} must exist`).toBe(true);
    }
    // The onboarding skill is what Codex offers to run right after install: it is our setup skill.
    expect(onboarding).toBe("./skills/setup/SKILL.md");
    // One directory per skill, each with SKILL.md — the layout Codex discovers under `skills`.
    for (const dir of ["apple-distribution", "setup"]) {
      expect(existsSync(join(ROOT, "skills", dir, "SKILL.md")), dir).toBe(true);
    }

    // The server row: the same npx pin as every other surface.
    const server = mcp.mcpServers[manifest.name];
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", `notarize-mcp@${manifest.version}`]);
    // Codex builds the child environment from a forwarded allowlist, so the credential names have
    // to be listed here or the server starts without them.
    expect(server.env_vars).toEqual(
      expect.arrayContaining([
        "ASC_KEY_ID",
        "ASC_ISSUER_ID",
        "ASC_PRIVATE_KEY_PATH",
        "NOTARY_KEYCHAIN_PROFILE",
      ]),
    );
    // npx downloads the server on a cold cache, so the handshake needs more than a default wait.
    expect(server.startup_timeout_sec).toBeGreaterThanOrEqual(30);

    // Codex drops over-long or excess default prompts without failing, so keep them inside limits.
    const prompts = manifest.interface.defaultPrompt;
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(128);
  });

  it("keeps every shipped surface on one version, and the release guard able to see that", () => {
    const pkg = packageJson();
    // Read the pins exactly as .github/workflows/release.yml does. A guard that cannot read a pin
    // never short-circuits, so sync-plugin re-runs bump-version and then fails to commit.
    const probes: Record<string, string> = {
      ".claude-plugin/plugin.json version": "require('./.claude-plugin/plugin.json').version",
      ".codex-plugin/plugin.json version": "require('./.codex-plugin/plugin.json').version",
      "codex.mcp.json pin":
        "JSON.parse(require('fs').readFileSync('codex.mcp.json','utf8')).mcpServers.notarize.args[1].split('@')[1]",
      "cordis.patch.yml pin":
        "require('fs').readFileSync('cordis.patch.yml','utf8').match(/- .notarize-mcp@([0-9][0-9A-Za-z.+-]*)/)[1]",
    };
    for (const [label, expr] of Object.entries(probes)) {
      const value = execFileSync("node", ["-p", expr], { cwd: ROOT }).toString().trim();
      expect(value, `${label} must resolve to the package version`).toBe(pkg.version);
    }
  });

  it("bump-version moves every version and pin without reformatting; rejects non-semver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bump-"));
    await mkdir(join(dir, ".claude-plugin"));
    await mkdir(join(dir, ".codex-plugin"));
    const plugin = readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8");
    const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    const codex = readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8");
    const mcp = readFileSync(join(ROOT, "codex.mcp.json"), "utf8");
    await writeFile(join(dir, "package.json"), readFileSync(join(ROOT, "package.json"), "utf8"));
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), plugin);
    await writeFile(join(dir, "cordis.patch.yml"), patch);
    await writeFile(join(dir, ".codex-plugin", "plugin.json"), codex);
    await writeFile(join(dir, "codex.mcp.json"), mcp);
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
    // The Codex manifest carries a version but no pin; its MCP config carries the pin but no version.
    expect(await readFile(join(dir, ".codex-plugin", "plugin.json"), "utf8")).toBe(
      codex.replace(/"version": "[^"]*"/, '"version": "1.4.0-beta.2"'),
    );
    expect(await readFile(join(dir, "codex.mcp.json"), "utf8")).toBe(
      mcp.replace(/"notarize-mcp@[^"]*"/, '"notarize-mcp@1.4.0-beta.2"'),
    );
    // The DSH layer has no version field either, so only its pin moves — nothing else changes.
    expect(await readFile(join(dir, "cordis.patch.yml"), "utf8")).toBe(
      patch.replace(/notarize-mcp@[0-9A-Za-z.+-]+/g, "notarize-mcp@1.4.0-beta.2"),
    );
    // Re-running with the same version is a no-op rather than an error.
    execFileSync("node", [script, "1.4.0-beta.2", dir]);
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
    // The Codex manifest/MCP config and the DSH bundle layer carry the same version and pin, so
    // sync-plugin must move and commit every one of them, and read each pin it compares.
    expect(sync).toContain(
      "git add package.json .claude-plugin/plugin.json .codex-plugin/plugin.json cordis.patch.yml codex.mcp.json",
    );
    for (const file of [".codex-plugin/plugin.json", "codex.mcp.json", "cordis.patch.yml"]) {
      expect(sync, `${file} must be part of the guard`).toContain(file);
    }
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
