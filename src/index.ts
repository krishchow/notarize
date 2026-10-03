import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { allTools } from "./tools/index";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        `${SERVER_NAME} ${SERVER_VERSION} — stdio MCP server for Apple signing, notarization and App Store Connect.`,
        "",
        "Usage: notarize-mcp            (speaks MCP over stdio)",
        "       notarize-mcp --list-tools",
        "",
        "Environment:",
        "  ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH | ASC_PRIVATE_KEY   App Store Connect API key",
        "  ASC_PROFILE                 credential profile name (see asc_auth configure)",
        "  NOTARY_KEYCHAIN_PROFILE     notarytool keychain profile",
        "  NOTARIZE_MCP_CONFIG_DIR     config dir (default ~/.config/notarize-mcp)",
        "  NOTARIZE_MCP_LOG_DIR        command transcript dir (default ~/Library/Logs/notarize-mcp)",
        "  NOTARIZE_MCP_AUTO_CONFIRM=1 skip preview/confirm (CI only)",
        "",
      ].join("\n"),
    );
    return;
  }
  if (argv.includes("--list-tools")) {
    for (const t of allTools)
      process.stdout.write(`${t.name}${t.mutating ? " (mutating)" : ""} — ${t.title}\n`);
    return;
  }

  const ctx = createContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} MCP server ${SERVER_VERSION} running on stdio (${ctx.platform.os})\n`);
}

main().catch((err) => {
  process.stderr.write(
    `${SERVER_NAME}: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
