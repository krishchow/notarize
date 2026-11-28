/**
 * Agent feedback about this server's own tools, through mcp-feedback. A copy running on a user's Mac
 * has no store its maintainer could read, so reports go to an mcp-feedback ingest hub, and only when
 * the person running the server names one: NOTARIZE_MCP_FEEDBACK_ENDPOINT, or MCP_FEEDBACK_ENDPOINT,
 * shared by every server that reads it. The repository names no hub: with neither set there is no
 * submit_feedback tool and nothing is sent anywhere.
 *
 * Every report is shown to the user and sent only after they confirm it. On the way out it passes
 * through `redact` and loses the home directory from paths, and the server adds only versions and
 * job states (never paths, identities or command output).
 */
import { arch, release } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type FeedbackRecord,
  type FeedbackSink,
  feedbackConfirmInstructions,
  registerFeedback,
} from "mcp-feedback";
import { feedbackEndpoint, remoteStore } from "mcp-feedback/remote";
import type { ToolContext } from "../tools/types";
import { defaultConfigDir } from "./config";
import { ok } from "./exec";
import { redact } from "./redact";

export interface FeedbackChannel {
  sink: FeedbackSink;
  /** Where reports go, named in the tool's description. */
  destination: string;
  /** Called once as the server starts: renews this machine's token and sends queued reports. */
  start?(): Promise<unknown>;
}

const log = (error: unknown) =>
  process.stderr.write(`notarize feedback: ${error instanceof Error ? error.message : String(error)}\n`);

/**
 * The channel to the hub NOTARIZE_MCP_FEEDBACK_ENDPOINT names, or else MCP_FEEDBACK_ENDPOINT; undefined
 * when feedback is off (neither set, or MCP_FEEDBACK_DISABLED).
 */
export function feedbackFromEnv(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): FeedbackChannel | undefined {
  const endpoint = feedbackEndpoint({ variable: "NOTARIZE_MCP_FEEDBACK_ENDPOINT", env });
  if (!endpoint) return undefined;
  try {
    const store = remoteStore({
      endpoint,
      project: "notarize",
      stateDir: join(defaultConfigDir(homeDir), "feedback"),
      onError: log,
    });
    return {
      sink: store,
      destination: `the feedback service at ${new URL(endpoint).host}`,
      start: () => store.start(),
    };
  } catch (error) {
    // A mistyped endpoint turns feedback off; it must not keep the server from starting.
    log(error);
    return undefined;
  }
}

/** Appended to the server instructions when feedback is on. */
export const FEEDBACK_INSTRUCTIONS =
  "\n\nsubmit_feedback reports a problem with this server's own tools to its maintainers (it is not TestFlight tester feedback). Put the job id (jobId) or notarization submission id (submissionId) involved in context.references when you have one. " +
  feedbackConfirmInstructions;

export function registerAgentFeedback(
  server: McpServer,
  ctx: ToolContext,
  channel: FeedbackChannel,
  version: string,
): void {
  const home = ctx.platform.homeDir;
  registerFeedback(server, {
    store: { insert: (record) => channel.sink.insert(scrub(record, home)) },
    serverInfo: { name: "notarize", version },
    requireConfirmation: true,
    destination: channel.destination,
    contextFields: {
      jobId: "id of the background job involved, from a detached tool result or `jobs`",
      submissionId: "notarization submission id, when the problem is a notarization",
    },
    attachContext: (record) => situation(record, ctx, version),
    onError: log,
  });
}

/** What the agent wrote, with secret shapes redacted and the home directory taken out of paths. */
function scrub(record: FeedbackRecord, home: string): FeedbackRecord {
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") {
      const redacted = redact(value);
      return home.length > 1 ? redacted.split(home).join("~") : redacted;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  return {
    ...record,
    title: clean(record.title) as string,
    body: clean(record.body) as string,
    context: clean(record.context) as FeedbackRecord["context"],
  };
}

/**
 * What the server knows that the agent might not, stored as `server_context`. The user does not see
 * it before confirming, so it holds versions and states only.
 */
async function situation(
  record: FeedbackRecord,
  ctx: ToolContext,
  version: string,
): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {
    version,
    os: ctx.platform.os,
    os_release: release(),
    arch: arch(),
    node: process.version,
  };
  if (ctx.platform.isMac) {
    const [macos, xcode] = await Promise.all([
      firstLine(ctx, "sw_vers", ["-productVersion"]),
      firstLine(ctx, "xcodebuild", ["-version"]),
    ]);
    context.macos = macos;
    context.xcode = xcode?.replace(/^Xcode\s+/, "") ?? null;
  }
  const jobId = record.context.references?.jobId;
  if (typeof jobId === "string") {
    const job = ctx.jobs.get(jobId);
    context.job = job
      ? {
          name: job.name,
          status: job.status,
          started_at: job.startedAt,
          ended_at: job.endedAt ?? null,
          failed: Boolean(job.error),
        }
      : { found: false };
  }
  return context;
}

async function firstLine(ctx: ToolContext, cmd: string, args: string[]): Promise<string | null> {
  try {
    const result = await ctx.runner.run(cmd, args, { timeoutMs: 2000 });
    return ok(result) ? (result.stdout.trim().split("\n")[0] ?? null) : null;
  } catch {
    return null;
  }
}
