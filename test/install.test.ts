import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeDesktopConfigPath,
  type InstallDeps,
  install,
  parseInstallFlags,
  SKILL_MARKER,
  uninstall,
} from "../src/cli/install";
import { FakeRunner } from "../src/core/fake-runner";
import { findSkillDir } from "../src/resources/index";

const ROOT = join(__dirname, "..");

async function deps(opts: { claude?: boolean; platform?: NodeJS.Platform } = {}) {
  const home = await mkdtemp(join(tmpdir(), "install-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "install-cwd-"));
  const runner = new FakeRunner()
    .on("which", ["claude"], opts.claude ? { stdout: "/usr/local/bin/claude\n" } : { code: 1 })
    .on("claude", ["mcp", "add"], {})
    .on("claude", ["mcp", "remove"], {})
    .on("xcode-select", ["-p"], { stdout: "/Applications/Xcode.app/Contents/Developer\n" });
  const lines: string[] = [];
  const d: InstallDeps = {
    runner,
    home,
    cwd,
    platform: opts.platform ?? "darwin",
    version: "0.2.0",
    skillDir: findSkillDir(),
    print: (l) => lines.push(l),
  };
  return { d, runner, home, cwd, lines };
}

const base = { scope: "user" as const, skill: true, dryRun: false, pin: false, force: false };

describe("install", () => {
  it("registers with Claude Code via `claude mcp add` and installs the skill with a marker", async () => {
    const { d, runner, home } = await deps({ claude: true });
    expect(await install({ ...base, clients: ["claude-code"] }, d)).toBe(0);
    expect(runner.callsTo("claude")[0]).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "notarize",
      "--",
      "npx",
      "-y",
      "notarize-mcp@latest",
    ]);
    const skill = join(home, ".claude", "skills", "apple-distribution");
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skill, "references", "notarization.md"))).toBe(true);
    expect((await readFile(join(skill, SKILL_MARKER), "utf8")).trim()).toBe("0.2.0");
  });

  it("prints the exact command when the claude CLI is missing", async () => {
    const { d, runner, lines } = await deps({ claude: false });
    expect(await install({ ...base, clients: ["claude-code"], skill: false }, d)).toBe(0);
    expect(runner.callsTo("claude")).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/claude mcp add --scope user notarize -- npx -y notarize-mcp@latest/);
  });

  it("merges into Claude Desktop config, keeping other servers, with a backup; idempotent", async () => {
    const { d, home } = await deps();
    const path = claudeDesktopConfigPath(home, "darwin");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    await install({ ...base, clients: ["claude-desktop"], pin: true }, d);
    const cfg = JSON.parse(await readFile(path, "utf8"));
    expect(cfg).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "x" },
        notarize: { command: "npx", args: ["-y", "notarize-mcp@0.2.0"] },
      },
    });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8")).mcpServers.notarize).toBeUndefined();
    const again = await deps();
    again.d.home = home;
    await install({ ...base, clients: ["claude-desktop"], pin: true }, again.d);
    expect(again.lines.join("\n")).toMatch(/already configured/);
  });

  it("creates the Cursor config and supports project scope", async () => {
    const { d, cwd } = await deps();
    await install({ ...base, clients: ["cursor"], scope: "project" }, d);
    const cfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8"));
    expect(cfg.mcpServers.notarize.args).toEqual(["-y", "notarize-mcp@latest"]);
  });

  it("--dry-run changes nothing", async () => {
    const { d, home, runner } = await deps({ claude: true });
    await install({ ...base, dryRun: true, clients: ["claude-code", "claude-desktop", "cursor"] }, d);
    expect(runner.callsTo("claude")).toHaveLength(0);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(claudeDesktopConfigPath(home, "darwin"))).toBe(false);
  });

  it("does not overwrite a skill it didn't install unless --force", async () => {
    const { d, home, lines } = await deps({ claude: true });
    const skill = join(home, ".claude", "skills", "apple-distribution");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "mine");
    await install({ ...base, clients: ["claude-code"] }, d);
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("mine");
    expect(lines.join("\n")).toMatch(/not installed by notarize-mcp/);
  });

  it("uninstall removes config entries and only our skill copy", async () => {
    const { d, home } = await deps({ claude: true });
    await install({ ...base, clients: ["claude-code", "cursor"] }, d);
    await uninstall({ ...base, clients: ["claude-code", "cursor"] }, d);
    expect(existsSync(join(home, ".claude", "skills", "apple-distribution"))).toBe(false);
    expect(JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({});
  });

  it("parses flags", () => {
    expect(parseInstallFlags({ client: "all", "dry-run": "true" })).toMatchObject({
      clients: ["claude-code", "claude-desktop", "cursor"],
      dryRun: true,
      skill: true,
      scope: "user",
    });
    expect(parseInstallFlags({ "no-skill": "true", scope: "project" })).toMatchObject({
      skill: false,
      scope: "project",
    });
    expect(() => parseInstallFlags({ client: "vscode" })).toThrow(/Unknown client/);
  });
});

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
});
