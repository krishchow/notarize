import { shellQuote } from "./redact";

/**
 * Ready-to-use watch commands for long-running work. In Claude Code the agent
 * passes `command` to the Monitor tool (one event per status line, exits when
 * the job finishes) and re-arms it if the 30-minute monitor limit expires.
 * Any client can also run the command in a background shell.
 */
export interface MonitorHint {
  tool: "Monitor";
  command: string;
  description: string;
  timeout_ms: number;
  /** Durable alternative that polls Apple directly (survives MCP server restarts). */
  fallback_command?: string;
  notes: string[];
}

/** How to invoke this same CLI from a shell. */
export function selfCommand(
  argv1: string | undefined = process.argv[1],
  execPath = process.execPath,
): string {
  if (argv1 && /notarize-mcp(\.js|\.mjs)?$/.test(argv1))
    return `${shellQuote(execPath)} ${shellQuote(argv1)}`;
  return "npx -y notarize-mcp";
}

export function jobMonitor(opts: {
  jobId: string;
  description: string;
  stateDir?: string;
  submissionId?: string;
  self?: string;
}): MonitorHint {
  const self = opts.self ?? selfCommand();
  const stateFlag = opts.stateDir ? ` --state-dir ${shellQuote(opts.stateDir)}` : "";
  return {
    tool: "Monitor",
    command: `${self} watch-job ${opts.jobId}${stateFlag}`,
    description: opts.description,
    timeout_ms: 1_800_000,
    fallback_command: opts.submissionId ? `${self} watch-notarization ${opts.submissionId}` : undefined,
    notes: [
      "Prints one line per status change and exits on success (0), failure (1) or if the server stopped (3).",
      "Monitors expire after 30 minutes: if it expires without a final line, start it again.",
      "When the final line arrives, call `jobs action=status job_id=<id>` for the full result.",
    ],
  };
}

export function notarizationMonitor(
  submissionId: string,
  description: string,
  self = selfCommand(),
): MonitorHint {
  return {
    tool: "Monitor",
    command: `${self} watch-notarization ${submissionId}`,
    description,
    timeout_ms: 1_800_000,
    notes: [
      "Polls Apple every 30s; prints status changes and exits 0 on Accepted, 1 on Invalid/Rejected (with the top issues).",
      "Re-arm after a 30-minute expiry. Then staple (staple action=staple) once Accepted.",
    ],
  };
}
