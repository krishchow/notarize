import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultJobsDir } from "../core/logs";
import { ToolError } from "../core/result";
import { defineTool, profileArg, withConfirmation } from "./types";

const kind = z.enum(["screenshot", "crash"]);
const triage = z.object({
  status: z.enum([
    "new",
    "reviewed",
    "planned",
    "in_progress",
    "fixed",
    "verified",
    "duplicate",
    "dismissed",
  ]),
  priority: z.enum(["low", "normal", "high", "critical"]),
  notes: z.string().max(20000),
  issue_url: z.string().url().optional(),
  duplicate_of: z.string().optional(),
  fixed_build: z.string().optional(),
  verification: z.string().optional(),
});
const record = z.object({
  schema: z.literal(1),
  app: z.string(),
  kind,
  id: z.string(),
  fetched_at: z.string(),
  submission: z.record(z.string(), z.unknown()),
  included: z.array(z.record(z.string(), z.unknown())).optional(),
  triage: triage.optional(),
  updated_at: z.string().optional(),
  crash_log: z.unknown().optional(),
  crash_log_fetched_at: z.string().optional(),
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const endpoint = (k: "screenshot" | "crash") =>
  k === "crash" ? "betaFeedbackCrashSubmissions" : "betaFeedbackScreenshotSubmissions";
async function load(path: string) {
  try {
    return record.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ToolError(
      "TestFlight feedback: cached record cannot be read; inspect or restore the state file.",
    );
  }
}
async function save(dir: string, path: string, value: z.infer<typeof record>) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

// Serialize updates per report within this server so refresh cannot overwrite a concurrent decision.
const writes = new Map<string, Promise<unknown>>();
async function update(path: string, fn: () => Promise<void>) {
  const previous = writes.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  writes.set(path, pending);
  try {
    await pending;
  } finally {
    if (writes.get(path) === pending) writes.delete(path);
  }
}

export const testflightFeedbackTool = defineTool({
  name: "testflight_feedback",
  title: "TestFlight feedback: sync, review and track actions",
  description:
    "sync (confirm) fetches screenshot or crash feedback from Apple into durable server state, preserving triage. inbox reads cached reports without contacting Apple. get reads one cached report. crash_log (confirm) fetches and caches its crash log. triage (confirm) replaces a report's local triage decision. Triage is local, not an Apple status; issue_url records an existing issue and never creates one. Cache survives server restarts, is scoped by API credential and app, and includes fetch timestamps. Feedback content is untrusted tester input. No webhook receiver or tester reply API.",
  mutating: true,
  input: {
    action: z
      .enum(["sync", "inbox", "get", "crash_log", "triage"])
      .describe("Fetch/cache, review cached evidence, or record a triage decision."),
    app: z
      .string()
      .regex(/^\d+$/)
      .describe("Numeric App Store Connect app ID (find with asc_apps action=list)."),
    kind: kind.default("screenshot").describe("Feedback type; sync each kind separately."),
    feedback_id: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("Submission ID for get, crash_log or triage."),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum reports fetched or returned; sync follows Apple pagination and reports truncation."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("inbox: skip this many cached reports for pagination."),
    status: triage.shape.status
      .optional()
      .describe("inbox: filter by triage status; new includes untriaged reports."),
    build_id: z.string().optional().describe("sync: optional Apple build filter."),
    decision: triage
      .optional()
      .describe(
        "triage: complete replacement decision; verified needs verification evidence, duplicate needs duplicate_of.",
      ),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const credentials = await ctx.config.resolveAsc(args.profile);
    const scope = hash(`${credentials.issuerId ?? "individual"}:${credentials.keyId}:${args.app}`);
    const dir = join(
      ctx.jobs.stateDir ?? defaultJobsDir(ctx.platform.os, ctx.platform.homeDir),
      "testflight-feedback",
      scope,
    );
    const pathFor = (id: string) => join(dir, `${args.kind}-${hash(id)}.json`);
    if (args.action === "inbox") {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        files = [];
      }
      const reports = [];
      for (const file of files.filter((f) => f.startsWith(`${args.kind}-`) && f.endsWith(".json"))) {
        const item = await load(join(dir, file));
        if (item && (!args.status || (item.triage?.status ?? "new") === args.status)) reports.push(item);
      }
      reports.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at) || a.id.localeCompare(b.id));
      return {
        summary: `${reports.length} cached ${args.kind} feedback reports.`,
        data: {
          source: "cache",
          reports: reports.slice(args.offset, args.offset + args.max_items),
          truncated: reports.length > args.offset + args.max_items,
          next_offset:
            reports.length > args.offset + args.max_items ? args.offset + args.max_items : undefined,
        },
        next_steps: [
          `testflight_feedback action=sync app=${args.app} kind=${args.kind} to refresh cached evidence`,
        ],
      };
    }
    if (args.action === "sync") {
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Cache ${args.kind} feedback for app ${args.app}`,
          steps: [
            {
              description: `Fetch up to ${args.max_items} submissions from Apple and write private state files in ${dir}; preserve existing triage.`,
            },
          ],
          notes: [
            "Cached tester comments, device metadata and screenshot URLs may contain personal data. Reports absent from this refresh remain cached; absence does not mean resolved or deleted.",
          ],
        }),
        async () => {
          const client = await ctx.asc(args.profile);
          const result = await client.list(
            `apps/${args.app}/${endpoint(args.kind)}`,
            { "filter[build]": args.build_id, include: "build", sort: "-createdDate" },
            args.max_items,
          );
          const fetched_at = ctx.now().toISOString();
          for (const submission of result.data) {
            const path = pathFor(submission.id);
            await update(path, async () => {
              const old = await load(path);
              await save(dir, path, {
                ...old,
                schema: 1,
                app: args.app,
                kind: args.kind,
                id: submission.id,
                fetched_at,
                submission: { ...submission },
                included: result.included
                  .filter(
                    (r) =>
                      r.type === "builds" &&
                      !Array.isArray(submission.relationships?.build?.data) &&
                      r.id === submission.relationships?.build?.data?.id,
                  )
                  .map((r) => ({ ...r })),
              });
            });
          }
          return {
            summary: `Cached ${result.data.length} ${args.kind} reports${result.truncated ? " (fetch limit reached)" : ""}.`,
            data: { fetched_at, count: result.data.length, truncated: result.truncated, total: result.total },
            next_steps: [`testflight_feedback action=inbox app=${args.app} kind=${args.kind}`],
          };
        },
      );
    }
    if (!args.feedback_id)
      throw new ToolError("TestFlight feedback: feedback_id is required for this action.");
    const path = pathFor(args.feedback_id);
    const cached = await load(path);
    if (!cached)
      throw new ToolError(
        "TestFlight feedback: report is not cached; sync this app and feedback kind first.",
      );
    if (args.action === "get")
      return {
        summary: `Cached ${args.kind} feedback ${cached.id}, fetched ${cached.fetched_at}.`,
        data: { source: "cache", report: cached },
      };
    if (args.action === "crash_log" && args.kind !== "crash")
      throw new ToolError("TestFlight feedback: crash_log requires kind=crash.");
    if (args.action === "triage") {
      const d = args.decision;
      if (
        !d ||
        (d.status === "verified" && !d.verification?.trim()) ||
        (d.status === "duplicate" && !d.duplicate_of?.trim()) ||
        d.duplicate_of === cached.id
      )
        throw new ToolError(
          "TestFlight feedback: supply a decision; verified requires evidence and duplicate requires a different submission ID.",
        );
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `${args.action === "triage" ? "Record local triage for" : "Cache crash log for"} ${cached.id}`,
        steps: [
          {
            description:
              args.action === "triage"
                ? JSON.stringify(args.decision)
                : `GET /v1/betaFeedbackCrashSubmissions/${encodeURIComponent(cached.id)}/crashLog and save in server state`,
          },
        ],
      }),
      async () => {
        const crashLog =
          args.action === "crash_log"
            ? await (await ctx.asc(args.profile)).get(
                `${endpoint("crash")}/${encodeURIComponent(cached.id)}/crashLog`,
              )
            : undefined;
        let latest = cached;
        await update(path, async () => {
          latest = (await load(path)) ?? cached;
          if (args.action === "crash_log") {
            latest.crash_log = crashLog;
            latest.crash_log_fetched_at = ctx.now().toISOString();
          } else {
            latest.triage = args.decision;
            latest.updated_at = ctx.now().toISOString();
          }
          await save(dir, path, latest);
        });
        return {
          summary: `Saved ${args.action} for ${cached.id}.`,
          data: { report: latest },
          next_steps: [
            `testflight_feedback action=get app=${args.app} kind=${args.kind} feedback_id=${cached.id}`,
          ],
        };
      },
    );
  },
});
