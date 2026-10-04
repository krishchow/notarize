import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseFlags, requireArg, watchJob, watchNotarization } from "./cli/watch";
import { createContext } from "./context";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { allTools } from "./tools/index";

const HELP = [
  `${SERVER_NAME} ${SERVER_VERSION} — stdio MCP server for Apple signing, notarization and App Store Connect.`,
  "",
  "Usage:",
  "  notarize-mcp                              speak MCP over stdio (what MCP clients run)",
  "  notarize-mcp --list-tools",
  "  notarize-mcp watch-job <job-id> [--state-dir DIR] [--interval SECONDS] [--max-minutes N]",
  "      Follow a background job (notarization, signing, upload…). One line per status change;",
  "      exits 0 succeeded, 1 failed, 3 lost (server stopped), 4 max time reached. Built for Claude Code's Monitor tool.",
  "  notarize-mcp watch-notarization <submission-id> [--keychain-profile NAME] [--profile NAME] [--interval SECONDS] [--max-minutes N]",
  "      Poll Apple's notary service directly (works even if the MCP server restarted).",
  "      exits 0 Accepted, 1 Invalid/Rejected (prints top issues), 2 error, 4 max time reached.",
  "",
  "Environment:",
  "  ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH | ASC_PRIVATE_KEY   App Store Connect API key",
  "  ASC_PROFILE                 credential profile name (see asc_auth configure)",
  "  NOTARY_KEYCHAIN_PROFILE     notarytool keychain profile",
  "  NOTARIZE_MCP_CONFIG_DIR     config dir (default ~/.config/notarize-mcp)",
  "  NOTARIZE_MCP_LOG_DIR        command transcript dir (default ~/Library/Logs/notarize-mcp)",
  "  NOTARIZE_MCP_STATE_DIR      background job state dir (default <log dir>/jobs)",
  "  NOTARIZE_MCP_AUTO_CONFIRM=1 skip preview/confirm (CI only)",
  "",
].join("\n");

async function main(): Promise<number | undefined> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (command === "watch-job") {
    const { positional, flags } = parseFlags(rest);
    const id = requireArg(positional[0], "notarize-mcp watch-job <job-id>");
    return watchJob(id, {
      stateDir: flags["state-dir"],
      intervalMs: flags.interval ? Number(flags.interval) * 1000 : undefined,
      maxMs: flags["max-minutes"] ? Number(flags["max-minutes"]) * 60000 : undefined,
    });
  }
  if (command === "watch-notarization") {
    const { positional, flags } = parseFlags(rest);
    const id = requireArg(positional[0], "notarize-mcp watch-notarization <submission-id>");
    return watchNotarization(createContext(), id, {
      keychainProfile: flags["keychain-profile"],
      profile: flags.profile,
      intervalMs: flags.interval ? Number(flags.interval) * 1000 : undefined,
      maxMs: flags["max-minutes"] ? Number(flags["max-minutes"]) * 60000 : undefined,
    });
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--list-tools")) {
    for (const t of allTools)
      process.stdout.write(`${t.name}${t.mutating ? " (mutating)" : ""} — ${t.title}\n`);
    return 0;
  }
  if (command) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  const ctx = createContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server ${SERVER_VERSION} running on stdio (${ctx.platform.os})\n`);
  return undefined;
}

main().then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (err) => {
    process.stderr.write(`${SERVER_NAME}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
