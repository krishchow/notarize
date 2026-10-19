import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { CONFIRM_TOKEN_ARG } from "./core/confirm";
import { errorOutput, toCallToolResult } from "./core/result";
import { registerPrompts } from "./prompts/index";
import { registerResources } from "./resources/index";
import { allTools } from "./tools/index";
import { confirmTokenSchema, type ToolContext, type ToolDef, type ToolExtra } from "./tools/types";

export const SERVER_NAME = "notarize";
export const SERVER_VERSION: string = pkg.version;

export const SERVER_INSTRUCTIONS = `Apple code signing, notarization, certificates, provisioning, entitlements, Gatekeeper/sandbox/TCC debugging, TestFlight and App Store Connect.

For installed-app failures, read notarize://guides/app-debugging and use app_debugging action=probe with an explicit runtime target before capture. Local debugging needs no Apple account; never substitute host logs for an iPhone or simulator.\n\nStart distribution with: doctor (machine readiness) → detect_project (what the app is) → distribution_checklist (what is missing for the chosen target). Each result lists next_steps naming the tool to call.

Mutating tools (signing, keychain, notarization submits, uploads, App Store Connect changes) use plan + confirm: the first call returns a PREVIEW and a confirm_token and changes nothing. Show the preview to the user, then call again with identical arguments plus confirm_token once authorized. Explicit advance approval counts when its scope covers the preview; ask again only for expanded scope, unclear authorization or a material new risk. Never invent tokens or change auto-confirm policy on the user's behalf.

Read notarize://guides/* resources (or the apple-distribution skill) for background on any topic.`;

export function createServer(ctx: ToolContext, tools: ToolDef<any>[] = allTools): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );

  for (const def of tools) {
    const shape = def.mutating ? { ...def.input, [CONFIRM_TOKEN_ARG]: confirmTokenSchema } : def.input;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: shape,
        annotations: {
          title: def.title,
          readOnlyHint: !def.mutating,
          openWorldHint: false,
          ...def.annotations,
        },
      },
      async (args: any, extra: any) => {
        const toolExtra: ToolExtra = {
          toolName: def.name,
          signal: extra?.signal,
          async progress(message, progress, total) {
            const token = extra?._meta?.progressToken;
            if (token === undefined) return;
            await extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress: progress ?? 0, total, message },
              })
              .catch(() => {});
          },
        };
        try {
          return toCallToolResult(await def.handler(args ?? {}, ctx, toolExtra));
        } catch (e) {
          return toCallToolResult(errorOutput(e));
        }
      },
    );
  }

  registerResources(server);
  registerPrompts(server);
  return server;
}
