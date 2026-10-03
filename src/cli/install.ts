import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../core/exec";
import { ok, output } from "../core/exec";
import { shellQuote } from "../core/redact";

/**
 * `notarize-mcp install` / `uninstall`: one command that registers the MCP server
 * with Claude Code, Claude Desktop and Cursor and installs the skill.
 * Runs in the user's own terminal, so `--dry-run` replaces the preview/confirm flow.
 */

export const CLIENTS = ["claude-code", "claude-desktop", "cursor"] as const;
export type Client = (typeof CLIENTS)[number];
export const SERVER_NAME = "notarize";
export const PACKAGE_NAME = "notarize-mcp";
export const SKILL_NAME = "apple-distribution";
export const SKILL_MARKER = ".notarize-mcp-version";

export interface InstallOptions {
  clients?: Client[];
  scope: "user" | "project";
  skill: boolean;
  dryRun: boolean;
  pin: boolean;
  force: boolean;
}

export interface InstallDeps {
  runner: CommandRunner;
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  version: string;
  skillDir?: string;
  print(line: string): void;
}

export function serverEntry(version: string, pin: boolean): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${pin ? version : "latest"}`] };
}

export function claudeDesktopConfigPath(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32")
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

export function cursorConfigPath(home: string, cwd: string, scope: "user" | "project"): string {
  return scope === "project" ? join(cwd, ".cursor", "mcp.json") : join(home, ".cursor", "mcp.json");
}

export function skillTarget(home: string, cwd: string, scope: "user" | "project"): string {
  return join(scope === "project" ? cwd : home, ".claude", "skills", SKILL_NAME);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(runner: CommandRunner, cmd: string): Promise<boolean> {
  const r = await runner.run("which", [cmd], { timeoutMs: 5000 });
  return ok(r) && !!r.stdout.trim();
}

export async function detectClients(deps: InstallDeps): Promise<Client[]> {
  const found: Client[] = [];
  if (await hasCommand(deps.runner, "claude")) found.push("claude-code");
  if (await exists(dirname(claudeDesktopConfigPath(deps.home, deps.platform)))) found.push("claude-desktop");
  if (await exists(join(deps.home, ".cursor"))) found.push("cursor");
  return found.length ? found : ["claude-code"];
}

/** Merge (or remove) mcpServers.notarize in a JSON config file, keeping everything else. */
export async function updateJsonConfig(
  path: string,
  entry: { command: string; args: string[] } | undefined,
  dryRun: boolean,
): Promise<"added" | "updated" | "unchanged" | "removed" | "absent"> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    raw = undefined;
  }
  let cfg: Record<string, any> = {};
  if (raw?.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch {
      throw new Error(`${path} is not valid JSON — fix or move it, then re-run.`);
    }
  }
  const servers: Record<string, unknown> = { ...(cfg.mcpServers ?? {}) };
  const before = servers[SERVER_NAME];
  let result: "added" | "updated" | "unchanged" | "removed" | "absent";
  if (entry) {
    if (JSON.stringify(before) === JSON.stringify(entry)) return "unchanged";
    result = before ? "updated" : "added";
    servers[SERVER_NAME] = entry;
  } else {
    if (!before) return "absent";
    delete servers[SERVER_NAME];
    result = "removed";
  }
  if (dryRun) return result;
  await mkdir(dirname(path), { recursive: true });
  if (raw !== undefined) await writeFile(`${path}.bak`, raw);
  await writeFile(path, `${JSON.stringify({ ...cfg, mcpServers: servers }, null, 2)}\n`);
  return result;
}

function claudeAddArgs(scope: "user" | "project", entry: { command: string; args: string[] }): string[] {
  return ["mcp", "add", "--scope", scope, SERVER_NAME, "--", entry.command, ...entry.args];
}

export async function install(opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const p = deps.print;
  const entry = serverEntry(deps.version, opts.pin);
  const clients = opts.clients ?? (await detectClients(deps));
  const tag = opts.dryRun ? "[dry-run] " : "";
  let failures = 0;
  p(`${tag}Installing ${PACKAGE_NAME} ${deps.version} for: ${clients.join(", ")} (scope: ${opts.scope})`);
  p(`${tag}Server command: ${entry.command} ${entry.args.join(" ")}`);

  for (const client of clients) {
    try {
      if (client === "claude-code") {
        const args = claudeAddArgs(opts.scope, entry);
        const printable = `claude ${args.map(shellQuote).join(" ")}`;
        if (!(await hasCommand(deps.runner, "claude"))) {
          p(`• Claude Code: 'claude' CLI not found. Run this once it is installed:\n    ${printable}`);
        } else if (opts.dryRun) {
          p(`• Claude Code: would run ${printable}`);
        } else {
          if (opts.force)
            await deps.runner.run("claude", ["mcp", "remove", "--scope", opts.scope, SERVER_NAME], {
              timeoutMs: 30000,
            });
          const r = await deps.runner.run("claude", args, { timeoutMs: 60000, cwd: deps.cwd });
          if (ok(r)) p("• Claude Code: registered the notarize MCP server.");
          else if (/already exists/i.test(output(r)))
            p("• Claude Code: already registered (use --force to re-register).");
          else {
            failures++;
            p(
              `• Claude Code: 'claude mcp add' failed: ${output(r).slice(0, 300)}\n    Run manually: ${printable}`,
            );
          }
        }
        if (opts.skill) await installSkill(opts, deps);
      } else {
        const path =
          client === "claude-desktop"
            ? claudeDesktopConfigPath(deps.home, deps.platform)
            : cursorConfigPath(deps.home, deps.cwd, opts.scope);
        const hadFile = await exists(path);
        const res = await updateJsonConfig(path, entry, opts.dryRun);
        const label = client === "claude-desktop" ? "Claude Desktop" : "Cursor";
        p(
          `• ${label}: ${res === "unchanged" ? "already configured" : `${opts.dryRun ? "would be " : ""}${res}`} in ${path}${hadFile && res !== "unchanged" && !opts.dryRun ? ` (previous file saved as ${path}.bak)` : ""}`,
        );
      }
    } catch (e) {
      failures++;
      p(`• ${client}: ${(e as Error).message}`);
    }
  }

  // Environment hints (macOS tools are what the server drives).
  const xcode =
    deps.platform === "darwin"
      ? await deps.runner.run("xcode-select", ["-p"], { timeoutMs: 10000 })
      : undefined;
  p("");
  p("Next steps:");
  if (deps.platform !== "darwin")
    p("  ⚠ Signing and notarization need macOS; on this OS only App Store Connect tools work.");
  else if (!xcode || !ok(xcode))
    p("  ⚠ Install Xcode (or at least `xcode-select --install`) — codesign/notarytool come with it.");
  if (clients.includes("claude-desktop") || clients.includes("cursor"))
    p("  1. Restart Claude Desktop / Cursor so they pick up the new server.");
  p(
    "  2. Create an App Store Connect API key: App Store Connect → Users and Access → Integrations → Team Keys → + (Admin), download the .p8 (only once).",
  );
  p(
    '  3. Ask your agent: "Run doctor, then asc_auth action=configure with my key", then "help me ship <path to my app>".',
  );
  return failures ? 1 : 0;
}

async function installSkill(opts: InstallOptions, deps: InstallDeps): Promise<void> {
  const p = deps.print;
  if (!deps.skillDir) {
    p("• Skill: bundled skill files not found; skipping.");
    return;
  }
  const target = skillTarget(deps.home, deps.cwd, opts.scope);
  const ours = await exists(join(target, SKILL_MARKER));
  if ((await exists(target)) && !ours && !opts.force) {
    p(
      `• Skill: ${target} exists and was not installed by ${PACKAGE_NAME}; leaving it (use --force to replace).`,
    );
    return;
  }
  if (opts.dryRun) {
    p(`• Skill: would copy ${deps.skillDir} → ${target}`);
    return;
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(deps.skillDir, target, { recursive: true });
  await writeFile(join(target, SKILL_MARKER), `${deps.version}\n`);
  p(`• Skill: installed ${SKILL_NAME} → ${target}`);
}

export async function uninstall(opts: InstallOptions, deps: InstallDeps): Promise<number> {
  const p = deps.print;
  const clients = opts.clients ?? [...CLIENTS];
  const tag = opts.dryRun ? "[dry-run] " : "";
  p(`${tag}Uninstalling ${PACKAGE_NAME} from: ${clients.join(", ")} (scope: ${opts.scope})`);
  for (const client of clients) {
    if (client === "claude-code") {
      if (await hasCommand(deps.runner, "claude")) {
        if (opts.dryRun) p(`• Claude Code: would run claude mcp remove --scope ${opts.scope} ${SERVER_NAME}`);
        else {
          const r = await deps.runner.run("claude", ["mcp", "remove", "--scope", opts.scope, SERVER_NAME], {
            timeoutMs: 30000,
          });
          p(`• Claude Code: ${ok(r) ? "removed" : `not registered (${output(r).slice(0, 120)})`}`);
        }
      }
      const target = skillTarget(deps.home, deps.cwd, opts.scope);
      if (await exists(join(target, SKILL_MARKER))) {
        if (!opts.dryRun) await rm(target, { recursive: true, force: true });
        p(`• Skill: ${opts.dryRun ? "would remove" : "removed"} ${target}`);
      } else if (await exists(target))
        p(`• Skill: ${target} was not installed by ${PACKAGE_NAME}; left in place.`);
    } else {
      const path =
        client === "claude-desktop"
          ? claudeDesktopConfigPath(deps.home, deps.platform)
          : cursorConfigPath(deps.home, deps.cwd, opts.scope);
      const res = await updateJsonConfig(path, undefined, opts.dryRun);
      p(
        `• ${client === "claude-desktop" ? "Claude Desktop" : "Cursor"}: ${res === "absent" ? "not configured" : opts.dryRun ? "would remove" : "removed"} (${path})`,
      );
    }
  }
  return 0;
}

/** Parse CLI flags for install/uninstall. */
export function parseInstallFlags(flags: Record<string, string>): InstallOptions {
  let clients: Client[] | undefined;
  if (flags.client) {
    const list = flags.client === "all" ? [...CLIENTS] : flags.client.split(",").map((c) => c.trim());
    for (const c of list)
      if (!CLIENTS.includes(c as Client))
        throw new Error(`Unknown client "${c}". Use ${CLIENTS.join(", ")} or all.`);
    clients = list as Client[];
  }
  const scope = flags.scope ?? "user";
  if (scope !== "user" && scope !== "project") throw new Error('--scope must be "user" or "project".');
  return {
    clients,
    scope,
    skill: flags["no-skill"] === undefined,
    dryRun: flags["dry-run"] !== undefined,
    pin: flags.pin !== undefined,
    force: flags.force !== undefined,
  };
}
