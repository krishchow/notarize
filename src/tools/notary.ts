import { chmod, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep, type PlanStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import type { JobHandle } from "../core/jobs";
import { FOREGROUND_SECONDS } from "../core/jobs";
import { jobMonitor, notarizationMonitor } from "../core/monitor";
import { requireMacOS } from "../core/platform";
import { ToolError, type ToolOutput } from "../core/result";
import { formatMatches, matchKnownErrors } from "../knowledge/error-catalog";
import { groupIssues, type NotarySubmission, parseNotaryJson, parseNotaryLog } from "../parsers/notarytool";
import { detachedOutput } from "./detached";
import { assess } from "./gatekeeper";
import { dittoZipArgs } from "./package";
import { formatFindings, inspectSignature, isDirectory, resolveUserPath, scratchDir } from "./shared";
import { defineTool, profileArg, type ToolContext, type ToolExtra, withConfirmation } from "./types";

export interface NotaryAuth {
  args: string[];
  description: string;
  cleanup: () => Promise<void>;
}

/** Credentials for notarytool: keychain profile, else the App Store Connect API key. */
export async function notaryAuth(
  ctx: ToolContext,
  keychainProfile?: string,
  profile?: string,
): Promise<NotaryAuth> {
  const kp = await ctx.config.notaryProfile(keychainProfile, profile);
  if (kp)
    return {
      args: ["--keychain-profile", kp],
      description: `keychain profile "${kp}"`,
      cleanup: async () => {},
    };
  let creds: Awaited<ReturnType<typeof ctx.config.resolveAsc>>;
  try {
    creds = await ctx.config.resolveAsc(profile);
  } catch {
    throw new ToolError(
      "No notarization credentials: no notarytool keychain profile and no App Store Connect API key.",
      {
        hint: "Configure an API key (asc_auth action=configure) and optionally store it for notarytool (notary action=store_credentials).",
        next_steps: ["asc_auth action=configure", "notary action=store_credentials"],
      },
    );
  }
  if (!creds.issuerId)
    throw new ToolError(
      "notarytool needs a Team API key (with an issuer ID); individual keys are not supported for notarization.",
    );
  let keyPath = creds.privateKeyPath;
  let cleanup = async () => {};
  if (!keyPath) {
    const dir = await scratchDir("p8");
    keyPath = join(dir, `AuthKey_${creds.keyId}.p8`);
    await writeFile(keyPath, creds.privateKeyPem, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    cleanup = async () => rm(dir, { recursive: true, force: true });
  }
  return {
    args: ["--key", keyPath, "--key-id", creds.keyId, "--issuer", creds.issuerId],
    description: `API key ${creds.keyId}`,
    cleanup,
  };
}

async function notarytool(ctx: ToolContext, args: string[], auth: NotaryAuth, timeoutMs = 120000) {
  return ctx.runner.run("xcrun", ["notarytool", ...args, ...auth.args, "--output-format", "json"], {
    timeoutMs,
    logName: `notarytool-${args[0]}`,
  });
}

export async function fetchLog(ctx: ToolContext, id: string, auth: NotaryAuth) {
  const r = await ctx.runner.run("xcrun", ["notarytool", "log", id, ...auth.args], {
    timeoutMs: 120000,
    logName: "notarytool-log",
  });
  if (!ok(r)) return undefined;
  return parseNotaryLog(r.stdout);
}

function explainLog(log: ReturnType<typeof parseNotaryLog>): string {
  const groups = groupIssues(log.issues);
  if (!groups.length) return log.statusSummary ?? "";
  return groups
    .slice(0, 12)
    .map(
      (g) =>
        `• ${g.message}${g.count > 1 ? ` (×${g.count})` : ""}\n    e.g. ${g.paths.slice(0, 3).join(", ")}${g.explanation ? `\n    → ${g.explanation.fix.join("; ")}` : ""}`,
    )
    .join("\n");
}

const POLL_MS = 20000;
/** Keep the conversation responsive: hand off to a Monitor after this long. */
export const NOTARY_FOREGROUND_SECONDS = FOREGROUND_SECONDS;

/** Temp key files are only removed by the executing job; previews must clean up themselves. */
async function cleanupOnPreview(auth: NotaryAuth, result: Promise<ToolOutput>): Promise<ToolOutput> {
  const r = await result;
  if (r.data?.status === "preview") await auth.cleanup();
  return r;
}

/** Upload then poll `notarytool info` until a terminal status. */
export async function submitAndWait(
  ctx: ToolContext,
  file: string,
  auth: NotaryAuth,
  job: JobHandle,
  waitMinutes: number,
): Promise<NotarySubmission & { log?: ReturnType<typeof parseNotaryLog> }> {
  job.progress(`Uploading ${basename(file)}`);
  const up = await ctx.runner.run(
    "xcrun",
    ["notarytool", "submit", file, ...auth.args, "--output-format", "json"],
    {
      timeoutMs: 3600000,
      logName: "notarytool-submit",
      signal: job.signal,
      onOutput: (c) => job.log(c),
    },
  );
  const sub = parseNotaryJson(up.stdout || up.stderr);
  if (!ok(up) || !sub.id) {
    const text = output(up);
    const known = matchKnownErrors(text);
    throw new ToolError(`notarytool submit failed: ${text.slice(0, 800)}`, {
      hint: known[0] ? `${known[0].title}: ${known[0].fix.join("; ")}` : undefined,
    });
  }
  job.log(`Submission id: ${sub.id}\n`);
  job.setMeta("submissionId", sub.id);
  const deadline = Date.now() + waitMinutes * 60000;
  let status = sub;
  while (Date.now() < deadline && !job.signal.aborted) {
    job.progress(`Waiting for Apple (submission ${sub.id}, status ${status.status ?? "In Progress"})`);
    const info = await notarytool(ctx, ["info", sub.id], auth);
    if (ok(info)) {
      status = { ...sub, ...parseNotaryJson(info.stdout) };
      if (status.status && status.status !== "In Progress") break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const result: NotarySubmission & { log?: ReturnType<typeof parseNotaryLog> } = { ...status, id: sub.id };
  if (status.status && status.status !== "Accepted" && status.status !== "In Progress") {
    result.log = await fetchLog(ctx, sub.id, auth);
  }
  return result;
}

function submissionSummary(s: NotarySubmission & { log?: ReturnType<typeof parseNotaryLog> }): string {
  if (s.status === "Accepted") return `Notarization ACCEPTED (submission ${s.id}).`;
  if (s.status === "In Progress" || !s.status) return `Notarization still in progress (submission ${s.id}).`;
  return `Notarization ${s.status?.toUpperCase()} (submission ${s.id}).${s.log ? `\n${explainLog(s.log)}` : ""}`;
}

/**
 * Agents sometimes re-submit while a notarization is still pending (e.g. after a
 * restart). Refuse when a live job — in this process or another — is already
 * notarizing the same artifact.
 */
export function refuseDuplicate(ctx: ToolContext, path: string): void {
  const live = ctx.jobs.list().find((j) => j.status === "running" && j.meta.path === path);
  const other = ctx.jobs.persisted().find((j) => j.status === "running" && !j.lost && j.meta?.path === path);
  const hit = live
    ? { id: live.id, sub: live.meta.submissionId as string | undefined }
    : other
      ? { id: other.id, sub: other.meta?.submissionId as string | undefined }
      : undefined;
  if (!hit) return;
  const monitor = jobMonitor({
    jobId: hit.id,
    description: `Notarization of ${basename(path)}`,
    stateDir: ctx.jobs.stateDir,
    submissionId: hit.sub,
  });
  throw new ToolError(
    `${basename(path)} is already being notarized by job ${hit.id}${hit.sub ? ` (submission ${hit.sub})` : ""}. Not submitting it again.`,
    {
      hint: "Wait for that job instead (or pass force=true if you really changed the artifact).",
      next_steps: [`Monitor: ${monitor.command}`, `jobs action=status job_id=${hit.id}`],
      data: { job_id: hit.id, submission_id: hit.sub, monitor },
    },
  );
}

/** Zip an .app for upload if needed; returns the file to submit. */
async function uploadable(ctx: ToolContext, path: string): Promise<{ file: string; zipped: boolean }> {
  if ((await isDirectory(path)) && extname(path) === ".app") {
    const out = join(await scratchDir("notarize"), `${basename(path, ".app")}.zip`);
    const r = await ctx.runner.run("ditto", dittoZipArgs(path, out), { timeoutMs: 1800000 });
    if (!ok(r)) throw new ToolError(`Could not zip ${basename(path)}: ${output(r)}`);
    return { file: out, zipped: true };
  }
  if (![".zip", ".dmg", ".pkg"].includes(extname(path).toLowerCase()))
    throw new ToolError(
      "Notarize a .app, .zip, .dmg or .pkg (bare binaries must be zipped or put in a pkg).",
    );
  return { file: path, zipped: false };
}

async function preflight(ctx: ToolContext, path: string): Promise<string[]> {
  if (extname(path).toLowerCase() === ".zip") return [];
  const r = await inspectSignature(ctx, path, { target: "mac-developer-id" });
  return r.findings
    .filter((f) => f.severity === "error")
    .map((f) => `${f.message}${f.path ? ` [${f.path}]` : ""}`);
}

export const notaryTool = defineTool({
  name: "notary",
  title: "Apple notary service (notarytool)",
  description:
    "action=store_credentials (confirm): save notarytool credentials in the keychain (App Store Connect API key — preferred — or Apple ID + app-specific password from password_env) and remember the profile name. action=submit (confirm): upload a .app (zipped automatically with ditto), .zip, .dmg or .pkg after a signature preflight (refuses obvious rejects unless force=true), then wait for the result (continues as a background job after max_wait_seconds); on Invalid it fetches and explains the developer log. action=status / wait / log / history: inspect submissions; log groups issues and maps each to a fix.",
  mutating: true,
  input: {
    action: z.enum(["store_credentials", "submit", "status", "wait", "log", "history"]),
    path: z.string().optional().describe("submit: artifact to notarize."),
    submission_id: z.string().optional().describe("status/wait/log: submission UUID."),
    keychain_profile: z
      .string()
      .optional()
      .describe("notarytool keychain profile name (default from config / NOTARY_KEYCHAIN_PROFILE)."),
    profile: profileArg,
    profile_name: z
      .string()
      .optional()
      .describe("store_credentials: name to store under (default notarize-mcp)."),
    apple_id: z.string().optional().describe("store_credentials (Apple ID method): Apple ID email."),
    team_id: z.string().optional().describe("store_credentials (Apple ID method): Team ID."),
    password_env: z
      .string()
      .optional()
      .describe("store_credentials (Apple ID method): env var holding an app-specific password."),
    force: z.boolean().optional().describe("submit: skip the preflight refusal."),
    wait_minutes: z
      .number()
      .int()
      .min(1)
      .max(240)
      .optional()
      .describe("submit/wait: how long to keep waiting overall (default 60)."),
    max_wait_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe(
        "Foreground wait before returning a job id + Monitor command (default 90). Notarization usually takes 2–15 min, sometimes much longer.",
      ),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "notarytool");

    if (args.action === "store_credentials") {
      const name = args.profile_name ?? "notarize-mcp";
      let cmd: string[];
      let secrets: string[] = [];
      let via: string;
      if (args.apple_id) {
        if (!args.team_id || !args.password_env)
          throw new ToolError(
            "Apple ID method needs team_id and password_env (an app-specific password from appleid.apple.com).",
          );
        const pw = process.env[args.password_env];
        if (!pw) throw new ToolError(`Environment variable ${args.password_env} is not set.`);
        cmd = [
          "notarytool",
          "store-credentials",
          name,
          "--apple-id",
          args.apple_id,
          "--team-id",
          args.team_id,
          "--password",
          pw,
        ];
        secrets = [pw];
        via = `Apple ID ${args.apple_id}`;
      } else {
        const creds = await ctx.config.resolveAsc(args.profile);
        if (!creds.issuerId)
          throw new ToolError("A Team API key (with issuer ID) is required for notarytool.");
        if (!creds.privateKeyPath)
          throw new ToolError(
            "store_credentials needs the .p8 on disk (set privateKeyPath / ASC_PRIVATE_KEY_PATH).",
          );
        cmd = [
          "notarytool",
          "store-credentials",
          name,
          "--key",
          creds.privateKeyPath,
          "--key-id",
          creds.keyId,
          "--issuer",
          creds.issuerId,
        ];
        via = `API key ${creds.keyId}`;
      }
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Store notarytool credentials as "${name}" (${via})`,
          steps: [
            cmdStep("Validate and save to the login keychain", "xcrun", cmd, secrets),
            { description: `Remember "${name}" as notaryKeychainProfile in ${ctx.config.path}` },
          ],
        }),
        async () => {
          const r = await ctx.runner.run("xcrun", cmd, { timeoutMs: 120000, secrets });
          if (!ok(r)) {
            const known = matchKnownErrors(output(r));
            throw new ToolError(`store-credentials failed: ${output(r).slice(0, 600)}`, {
              hint: known[0]?.fix.join("; "),
            });
          }
          const { name: pname } = await ctx.config.getProfile(args.profile);
          await ctx.config.saveProfile(pname ?? "default", { notaryKeychainProfile: name });
          return {
            summary: `Stored notarytool credentials as "${name}" and saved it to your config.`,
            data: { keychainProfile: name },
            next_steps: ["notarize_and_staple path=<app/dmg/pkg>"],
          };
        },
      );
    }

    if (args.action === "submit") {
      if (!args.path) throw new ToolError("path is required.");
      const path = await resolveUserPath(ctx, args.path);
      if (!args.force) refuseDuplicate(ctx, path);
      const problems = args.force ? [] : await preflight(ctx, path);
      if (problems.length)
        throw new ToolError(`Preflight found problems that Apple will reject:\n- ${problems.join("\n- ")}`, {
          hint: "Fix them (sign tool), or pass force=true to submit anyway.",
        });
      const auth = await notaryAuth(ctx, args.keychain_profile, args.profile);
      const steps: PlanStep[] = [];
      if (extname(path) === ".app")
        steps.push(
          cmdStep(
            "Zip the app for upload",
            "ditto",
            dittoZipArgs(path, `<tmp>/${basename(path, ".app")}.zip`),
          ),
        );
      steps.push(
        cmdStep(`Upload to Apple's notary service (${auth.description})`, "xcrun", [
          "notarytool",
          "submit",
          path,
          ...auth.args,
        ]),
      );
      steps.push({
        description: `Poll for the result for up to ${args.wait_minutes ?? 60} min; fetch the log if rejected`,
      });
      return cleanupOnPreview(
        auth,
        withConfirmation(
          ctx,
          extra,
          args,
          () => ({
            title: `Submit ${basename(path)} for notarization`,
            steps,
            notes: ["This uploads your software to Apple."],
          }),
          async () => {
            const job = await ctx.jobs.runWithDeadline(
              "notarize",
              `Notarize ${basename(path)}`,
              (args.max_wait_seconds ?? NOTARY_FOREGROUND_SECONDS) * 1000,
              async (j) => {
                j.setMeta("path", path);
                const up = await uploadable(ctx, path);
                try {
                  const s = await submitAndWait(ctx, up.file, auth, j, args.wait_minutes ?? 60);
                  return {
                    summary: submissionSummary(s),
                    data: {
                      submission: {
                        ...s,
                        log: s.log ? { ...s.log, issues: groupIssues(s.log.issues) } : undefined,
                      },
                    },
                    next_steps:
                      s.status === "Accepted"
                        ? [
                            extname(path) === ".zip"
                              ? "Staple the .app inside, then re-zip (zips cannot be stapled)"
                              : `staple action=staple path=${path}`,
                          ]
                        : s.status === "In Progress"
                          ? [`notary action=wait submission_id=${s.id}`]
                          : ["Fix the issues above, re-sign, and submit again"],
                    isError: s.status === "Invalid" || s.status === "Rejected",
                  } satisfies ToolOutput;
                } finally {
                  if (up.zipped) await rm(dirname(up.file), { recursive: true, force: true });
                  await auth.cleanup();
                }
              },
            );
            if (!job.done) return detachedOutput(ctx, job.jobId, `Notarization of ${basename(path)}`);
            return job.value;
          },
        ),
      );
    }

    const auth = await notaryAuth(ctx, args.keychain_profile, args.profile);
    try {
      if (args.action === "history") {
        const r = await notarytool(ctx, ["history"], auth);
        if (!ok(r))
          throw new ToolError(`notarytool history failed: ${output(r).slice(0, 600)}`, {
            hint: matchKnownErrors(output(r))[0]?.fix.join("; "),
          });
        const h = parseNotaryJson(r.stdout).history ?? [];
        return {
          summary: h.length
            ? h
                .slice(0, 20)
                .map((s) => `• ${s.createdDate?.slice(0, 19)} ${s.status} ${s.name} (${s.id})`)
                .join("\n")
            : "No submissions yet.",
          data: { history: h },
        };
      }
      if (!args.submission_id) throw new ToolError("submission_id is required.");
      if (args.action === "status") {
        const r = await notarytool(ctx, ["info", args.submission_id], auth);
        if (!ok(r)) throw new ToolError(`notarytool info failed: ${output(r).slice(0, 600)}`);
        const s = parseNotaryJson(r.stdout);
        return {
          summary: submissionSummary({ ...s, id: args.submission_id }),
          data: { submission: s },
          next_steps:
            s.status && s.status !== "Accepted" && s.status !== "In Progress"
              ? [`notary action=log submission_id=${args.submission_id}`]
              : [],
        };
      }
      if (args.action === "log") {
        const log = await fetchLog(ctx, args.submission_id, auth);
        if (!log) throw new ToolError("Could not fetch the log (the submission may still be in progress).");
        return {
          summary: `Submission ${args.submission_id}: ${log.status} — ${log.statusSummary ?? ""}\n${explainLog(log)}`,
          data: { ...log, issues: groupIssues(log.issues) },
        };
      }
      // wait
      const id = args.submission_id;
      const job = await ctx.jobs.runWithDeadline(
        "notary-wait",
        `Wait for ${id}`,
        (args.max_wait_seconds ?? NOTARY_FOREGROUND_SECONDS) * 1000,
        async () => {
          const r = await notarytool(
            ctx,
            ["wait", id, "--timeout", `${args.wait_minutes ?? 60}m`],
            auth,
            (args.wait_minutes ?? 60) * 60000 + 60000,
          );
          const s = parseNotaryJson(r.stdout);
          const log =
            s.status && s.status !== "Accepted" && s.status !== "In Progress"
              ? await fetchLog(ctx, id, auth)
              : undefined;
          return { summary: submissionSummary({ ...s, id, log }), data: { submission: s, log } };
        },
      );
      if (!job.done) {
        const out = detachedOutput(ctx, job.jobId, `Notarization submission ${id}`);
        const durable = notarizationMonitor(id, `Notarization submission ${id}`);
        return {
          ...out,
          data: { ...out.data, submission_id: id, monitor: durable },
          next_steps: [`Monitor: ${durable.command}`],
        };
      }
      return job.value;
    } finally {
      await auth.cleanup();
    }
  },
});

export const stapleTool = defineTool({
  name: "staple",
  title: "Staple / validate notarization tickets",
  description:
    "action=staple (confirm): attach the notarization ticket to a notarized .app, .dmg or .pkg (`xcrun stapler staple`) so Gatekeeper can verify it offline. Zips cannot be stapled — staple the .app and re-zip. action=validate: check whether a ticket is stapled. Errors such as 'Error 65 / Record not found' are explained (not notarized, modified after submission, or ticket still propagating).",
  mutating: true,
  input: {
    action: z.enum(["staple", "validate"]),
    path: z.string(),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "stapler");
    const path = await resolveUserPath(ctx, args.path);
    if (extname(path).toLowerCase() === ".zip")
      throw new ToolError(
        "Zip files cannot be stapled. Staple the .app inside, then re-create the zip with package action=zip.",
      );
    const run = async (verb: "staple" | "validate") => {
      const r = await ctx.runner.run("xcrun", ["stapler", verb, "-v", path], {
        timeoutMs: 180000,
        logName: `stapler-${verb}`,
      });
      const text = output(r);
      const known = matchKnownErrors(text, ["stapler", "notarization"]);
      return {
        summary: ok(r)
          ? verb === "staple"
            ? `Stapled the ticket to ${basename(path)}.`
            : `${basename(path)} has a valid stapled ticket.`
          : `stapler ${verb} failed for ${basename(path)}.\n${text.split("\n").slice(-4).join("\n")}${known.length ? `\n\n${formatMatches(known)}` : ""}`,
        data: { ok: ok(r), output: text.slice(-2000), knownErrors: known },
        isError: !ok(r) && verb === "staple",
      };
    };
    if (args.action === "validate") return run("validate");
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Staple ticket to ${basename(path)}`,
        steps: [cmdStep("Staple", "xcrun", ["stapler", "staple", "-v", path])],
      }),
      () => run("staple"),
    );
  },
});

export const notarizeAndStapleTool = defineTool({
  name: "notarize_and_staple",
  title: "One-shot: preflight → notarize → staple → Gatekeeper check",
  description:
    "End-to-end Developer ID pipeline for an already-signed .app, .dmg or .pkg (or .zip, which is notarized but not stapled): verify the signature is notarizable, zip if needed, submit with notarytool, wait (continuing as a background job if slow), explain the log on rejection, staple the ticket, validate it, run a Gatekeeper assessment, and optionally produce a distribution zip of the stapled app. One preview covers the whole pipeline.",
  mutating: true,
  input: {
    path: z.string().describe("Signed .app, .dmg, .pkg or .zip"),
    keychain_profile: z.string().optional(),
    profile: profileArg,
    distribution_zip: z
      .string()
      .optional()
      .describe("For a .app: also create this zip from the stapled app."),
    force: z.boolean().optional().describe("Submit even if the preflight finds problems."),
    wait_minutes: z
      .number()
      .int()
      .min(1)
      .max(240)
      .optional()
      .describe("Overall wait for Apple (default 60)."),
    max_wait_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe(
        "Foreground wait before returning a job id + Monitor command (default 90). Notarization usually takes 2–15 min, sometimes much longer.",
      ),
  },
  async handler(args, ctx, extra: ToolExtra) {
    requireMacOS(ctx.platform, "Notarization");
    const path = await resolveUserPath(ctx, args.path);
    const ext = extname(path).toLowerCase();
    if (!args.force) refuseDuplicate(ctx, path);
    const problems = args.force ? [] : await preflight(ctx, path);
    if (problems.length)
      throw new ToolError(`Preflight found problems Apple will reject:\n- ${problems.join("\n- ")}`, {
        hint: "Fix with the sign tool (or pass force=true).",
        next_steps: [
          "inspect_code_signature path=<…> target=mac-developer-id",
          "sign path=<…> identity=auto target=mac-developer-id",
        ],
      });
    const auth = await notaryAuth(ctx, args.keychain_profile, args.profile);
    const zipOut = args.distribution_zip
      ? await resolveUserPath(ctx, args.distribution_zip, false)
      : undefined;
    return cleanupOnPreview(
      auth,
      withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Notarize and staple ${basename(path)}`,
          steps: [
            { description: "Preflight signature check: passed" },
            ...(ext === ".app" ? [{ description: "Zip the app for upload (ditto)" }] : []),
            {
              description: `Submit to Apple's notary service (${auth.description}) and wait up to ${args.wait_minutes ?? 60} min`,
            },
            ...(ext === ".zip"
              ? [{ description: "Zips cannot be stapled — the ticket is checked online" }]
              : [cmdStep("Staple the ticket", "xcrun", ["stapler", "staple", path])]),
            { description: "Validate the stapled ticket and run a Gatekeeper assessment" },
            ...(zipOut ? [cmdStep("Create the distribution zip", "ditto", dittoZipArgs(path, zipOut))] : []),
          ],
          notes: [
            "Uploads your software to Apple. Typical turnaround is a few minutes; first submissions can take longer.",
          ],
        }),
        async () => {
          const job = await ctx.jobs.runWithDeadline(
            "notarize_and_staple",
            `Notarize ${basename(path)}`,
            (args.max_wait_seconds ?? NOTARY_FOREGROUND_SECONDS) * 1000,
            async (j) => {
              j.setMeta("path", path);
              const up = await uploadable(ctx, path);
              let s: Awaited<ReturnType<typeof submitAndWait>>;
              try {
                s = await submitAndWait(ctx, up.file, auth, j, args.wait_minutes ?? 60);
              } finally {
                if (up.zipped) await rm(dirname(up.file), { recursive: true, force: true });
                await auth.cleanup();
              }
              if (s.status !== "Accepted") {
                return {
                  summary: submissionSummary(s),
                  data: {
                    submission: {
                      ...s,
                      log: s.log ? { ...s.log, issues: groupIssues(s.log.issues) } : undefined,
                    },
                  },
                  next_steps:
                    s.status === "In Progress"
                      ? [`notary action=wait submission_id=${s.id}`]
                      : ["Fix the issues, re-sign (sign tool) and run notarize_and_staple again"],
                  isError: s.status !== "In Progress",
                } satisfies ToolOutput;
              }
              const lines = [submissionSummary(s)];
              const data: Record<string, unknown> = { submission: s };
              if (ext !== ".zip") {
                j.progress("Stapling");
                // Tickets can take a moment to propagate to the CDN; retry briefly.
                let st = await ctx.runner.run("xcrun", ["stapler", "staple", path], { timeoutMs: 180000 });
                for (let i = 0; i < 3 && !ok(st); i++) {
                  await new Promise((r) => setTimeout(r, 15000));
                  st = await ctx.runner.run("xcrun", ["stapler", "staple", path], { timeoutMs: 180000 });
                }
                data.stapled = ok(st);
                lines.push(
                  ok(st) ? "Stapled ✓" : `Stapling failed: ${output(st).split("\n").slice(-2).join(" ")}`,
                );
                const a = await assess(ctx, path);
                data.gatekeeper = a;
                lines.push(
                  `Gatekeeper: ${a.accepted ? "accepted" : "REJECTED"}${a.source ? ` (${a.source})` : ""}`,
                );
                if (zipOut && ext === ".app") {
                  const z1 = await ctx.runner.run("ditto", dittoZipArgs(path, zipOut), {
                    timeoutMs: 1800000,
                  });
                  data.distributionZip = ok(z1) ? zipOut : undefined;
                  lines.push(ok(z1) ? `Distribution zip: ${zipOut}` : `Zip failed: ${output(z1)}`);
                }
              } else
                lines.push(
                  "(.zip: nothing to staple; distribute it as is or staple the app inside and re-zip)",
                );
              const report =
                ext === ".app"
                  ? await inspectSignature(ctx, path, { target: "mac-developer-id", deep: false })
                  : undefined;
              if (report?.findings.length) lines.push(formatFindings(report.findings));
              return {
                summary: lines.join("\n"),
                data,
                next_steps: [
                  "gatekeeper action=simulate_download path=<artifact> to confirm the end-user experience",
                ],
              } satisfies ToolOutput;
            },
          );
          if (!job.done)
            return detachedOutput(ctx, job.jobId, `Notarize + staple ${basename(path)}`, [
              "When the job succeeds it has already stapled and run the Gatekeeper check — nothing else to do.",
            ]);
          return job.value;
        },
      ),
    );
  },
});
