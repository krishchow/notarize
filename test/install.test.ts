import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES, loadPackage, PACK_TARGETS, runCli, runPack } from "agentdist";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

// A throwaway home and repository: the installer must never be pointed at the real ones in a test.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "notarize-install-")));
  const env = {
    home: join(root, "home"),
    projectRoot: join(root, "repo"),
    vars: {},
    platform: process.platform,
  };
  mkdirSync(env.home);
  mkdirSync(env.projectRoot);
  return env;
}

async function cli(env: ReturnType<typeof sandbox>, ...argv: string[]) {
  let out = "";
  const code = await runCli({
    packageRoot: ROOT,
    argv,
    bin: "npx notarize-mcp",
    env,
    interactive: false,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      out += text;
    },
  });
  return { code, out };
}

const SKILLS = [
  "app-debugging",
  "apple-distribution",
  "apple-platform-context",
  "setup",
  "testflight-feedback",
];

describe("agentdist.json", () => {
  it("describes everything the package ships", () => {
    const pkg = loadPackage(ROOT);
    expect(pkg.name).toBe("notarize");
    // The version of record is package.json's; the manifest carries none of its own.
    expect(pkg.manifest.version).toBeUndefined();
    expect(pkg.version).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    expect(pkg.nodes.filter((n) => n.kind === "skill").map((n) => n.name)).toEqual(SKILLS);
    const [server] = pkg.nodes.filter((n) => n.kind === "mcpServer");
    expect(server).toMatchObject({
      name: "notarize",
      command: "npx",
      args: ["-y", `notarize-mcp@${pkg.version}`],
    });
  });

  it("is the source of every plugin surface: regenerating them changes nothing", () => {
    // The surfaces may trail package.json between a version bump and the release workflow's
    // sync-plugin job (see package.test.ts), so they are compared at the version they pin.
    const pkg = loadPackage(ROOT);
    const pinned = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
    pkg.version = pinned;
    for (const node of pkg.nodes) {
      if (node.kind === "mcpServer" && node.transport === "stdio")
        node.args = node.args.map((arg) => arg.replace(/@[^@]+$/, `@${pinned}`));
    }
    const result = runPack(pkg, PACK_TARGETS, { check: true });
    expect(result.changes.filter((c) => c.change !== "unchanged")).toEqual([]);
    expect(result.changes.map((c) => c.path).sort()).toEqual([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      "codex.mcp.json",
      "cordis.patch.yml",
    ]);
  });
});

describe("notarize-mcp install", () => {
  it("installs the skills and registers the server for the user, then removes them again", async () => {
    const env = sandbox();
    const before = '# mine\nmodel = "gpt"\n';
    mkdirSync(join(env.home, ".codex"));
    writeFileSync(join(env.home, ".codex", "config.toml"), before);

    const installed = await cli(env, "install", "--harness", "claude,codex", "--user");
    expect(installed.code, installed.out).toBe(0);
    for (const skill of SKILLS) {
      // Vendored skills share a directory with the user's own, so they carry the package name.
      for (const dir of [".claude/skills", ".agents/skills"]) {
        const text = readFileSync(join(env.home, dir, `notarize-${skill}`, "SKILL.md"), "utf8");
        expect(text).toContain(`name: notarize-${skill}`);
      }
    }
    expect(existsSync(join(env.home, ".claude/skills/notarize-setup/scripts/setup.mjs"))).toBe(true);

    const version = loadPackage(ROOT).version;
    expect(JSON.parse(readFileSync(join(env.home, ".claude.json"), "utf8")).mcpServers.notarize).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", `notarize-mcp@${version}`],
      timeout: 300000,
    });
    const toml = readFileSync(join(env.home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith(before)).toBe(true);
    expect(toml).toContain("[mcp_servers.notarize]");
    // Codex forwards only the variables it is told about.
    expect(toml).toMatch(/env_vars = \[ "ASC_KEY_ID", "ASC_ISSUER_ID"/);
    expect(installed.out).toContain("run /notarize-setup to finish setting up");

    expect((await cli(env, "status")).out).toMatch(/User \(~\): notarize .* for claude, codex/);

    expect((await cli(env, "uninstall", "--user")).code).toBe(0);
    expect(readFileSync(join(env.home, ".codex", "config.toml"), "utf8")).toBe(before);
    expect(existsSync(join(env.home, ".claude"))).toBe(false);
    expect(existsSync(join(env.home, ".agents"))).toBe(false);
    expect(existsSync(join(env.home, ".claude.json"))).toBe(false);
  });

  it("installs into a repository, leaving the user's home alone", async () => {
    const env = sandbox();
    expect((await cli(env, "install", "--harness", "claude,cursor", "--local")).code).toBe(0);
    expect(
      existsSync(
        join(env.projectRoot, ".claude/skills/notarize-apple-distribution/references/notarization.md"),
      ),
    ).toBe(true);
    // Cursor also reads .claude/skills, so it shares that copy instead of adding a second.
    expect(existsSync(join(env.projectRoot, ".agents"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(env.projectRoot, ".mcp.json"), "utf8")).mcpServers.notarize.command,
    ).toBe("npx");
    expect(
      JSON.parse(readFileSync(join(env.projectRoot, ".cursor/mcp.json"), "utf8")).mcpServers.notarize.type,
    ).toBe("stdio");
    expect(existsSync(join(env.home, ".claude"))).toBe(false);
  });

  it("can be planned for every harness the engine knows", async () => {
    for (const scope of ["--user", "--local"]) {
      const env = sandbox();
      const dry = await cli(env, "install", "--all", scope, "--dry-run");
      expect(dry.code, dry.out).toBe(0);
      for (const harness of HARNESSES) expect(dry.out).toContain(harness.id);
      expect(existsSync(join(env.home, ".agents"))).toBe(false);
    }
  });
});
