import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function user(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "setup-distribution",
    {
      title: "Set up signing & distribution for an app",
      description:
        "Zero-context walkthrough: machine check → project detection → target choice → checklist → fixes → build/sign → notarize or upload.",
      argsSchema: {
        path: z.string().describe("Project folder or built artifact"),
        target: z
          .string()
          .optional()
          .describe("mac-developer-id, mac-app-store, testflight-ios, ios-app-store, ios-ad-hoc, …"),
      },
    },
    ({ path, target }) =>
      user(
        [
          `Help me ship the app at ${path}${target ? ` as ${target}` : ""}. I may not know Apple's terminology — explain briefly as we go.`,
          "1. Run `doctor`, then `detect_project` on the path.",
          target
            ? `2. Use target ${target}.`
            : "2. Ask me which distribution target I want (explain the options in one line each).",
          "3. Run `distribution_checklist` and fix blocking items in order; tell me exactly what I must do by hand (with URLs).",
          "4. Show me every PREVIEW before confirming it.",
          "5. Build/sign, verify with `inspect_code_signature`, then notarize+staple (Developer ID) or upload (stores).",
          "6. If notarization or processing is still running, start a Monitor with the returned monitor.command and keep going; never block.",
        ].join("\n"),
      ),
  );
  server.registerPrompt(
    "debug-gatekeeper",
    {
      title: "Why won't my Mac app open on other Macs?",
      description: "Diagnose 'cannot be opened', 'is damaged', 'developer cannot be verified'.",
      argsSchema: { path: z.string().describe(".app, .dmg, .pkg or .zip as distributed") },
    },
    ({ path }) =>
      user(
        `Users can't open ${path}. Run gatekeeper action=simulate_download on it, then inspect_code_signature target=mac-developer-id, and explain the root cause in plain words with the exact fix (sign / notarize_and_staple / packaging change). Use system_logs preset=gatekeeper or amfi if needed.`,
      ),
  );
  server.registerPrompt(
    "debug-notarization",
    {
      title: "Why was notarization rejected?",
      description: "Fetch and explain a notarization log, then fix and resubmit.",
      argsSchema: {
        submission_id: z
          .string()
          .optional()
          .describe("Submission UUID (omit to use the latest from history)"),
      },
    },
    ({ submission_id }) =>
      user(
        `${submission_id ? `Notarization submission ${submission_id}` : "My latest notarization (see notary action=history)"} failed or is stuck. Use notary action=status/log to explain every issue, map each to a fix, re-sign with the sign tool, and resubmit with notarize_and_staple (monitor it with the returned Monitor command).`,
      ),
  );
  server.registerPrompt(
    "debug-app",
    {
      title: "Debug a Mac, iPhone/iPad or simulator app",
      description:
        "Select an explicit runtime, collect bounded evidence, correlate source/build identity, and verify a fix.",
      argsSchema: {
        symptom: z.string().describe("Observed failure and known reproduction steps"),
        path: z.string().optional().describe("Project or artifact path"),
      },
    },
    ({ symptom, path }) =>
      user(
        `Debug this app failure: ${symptom}. ${path ? `Project/artifact: ${path}.` : ""} Read notarize://guides/app-debugging. Discover and select the exact app/runtime using detect_project and devices; use app_debugging action=probe with an explicit target. Preserve the installed app/state. Preview capture before confirming, wait for ready before reproduction, and use the returned Monitor. Physical-device logs may require Console export/import. Do not use host system_logs/crash_reports for an iPhone or simulator. No Apple-account setup is needed for local evidence. Separate observations from hypotheses and name the runtime/build actually verified.`,
      ),
  );
  server.registerPrompt(
    "debug-sandbox",
    {
      title: "Fix macOS App Sandbox / privacy permission problems",
      description:
        "macOS host only: find sandbox denials and TCC issues. For iPhone/iPad/simulator apps use debug-app.",
      argsSchema: {
        app_name: z.string().describe("Process/app name"),
        path: z.string().optional().describe("Path to the .app"),
      },
    },
    ({ app_name, path }) =>
      user(
        `A feature fails in the macOS app ${app_name}. Ask me to reproduce it, then run system_logs preset=sandbox process=${app_name} last=5m and preset=tcc, ${path ? `privacy action=audit path=${path} and entitlements action=read path=${path}, ` : ""}and tell me which entitlements / Info.plist usage strings to add. Preview any file changes and re-sign afterwards.`,
      ),
  );
}
