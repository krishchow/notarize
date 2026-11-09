import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ascEnv, call, callConfirmed, connect, fakeAsc, makeCtx } from "./helpers";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "feedback-"));
  const env = await ascEnv(dir);
  let comment = "The save button hangs";
  const asc = fakeAsc({
    "GET /v1/apps/123/betaFeedbackScreenshotSubmissions": () => ({
      body: {
        data: [
          {
            type: "betaFeedbackScreenshotSubmissions",
            id: "report-1",
            attributes: { comment, createdDate: "2026-11-01" },
          },
        ],
      },
    }),
    "GET /v1/apps/123/betaFeedbackCrashSubmissions": {
      body: {
        data: [{ type: "betaFeedbackCrashSubmissions", id: "crash-1", attributes: { comment: "crashed" } }],
      },
    },
    "GET /v1/betaFeedbackCrashSubmissions/crash-1/crashLog": {
      body: { data: { type: "betaCrashLogs", id: "log-1", attributes: { logText: "crash stack" } } },
    },
  });
  const { ctx } = await makeCtx({ env, fetch: asc.fetch });
  const client = await connect(ctx);
  return {
    ctx,
    client,
    asc,
    update: () => {
      comment = "Updated tester comment";
    },
  };
}
const base = { app: "123", kind: "screenshot" };
const decision = { status: "planned", priority: "high", notes: "Reproduce save failure" };

describe("TestFlight feedback cache and triage", () => {
  it("paginates Apple responses, exposes fetch limits, and pages cached decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feedback-pages-"));
    const env = await ascEnv(dir);
    const asc = fakeAsc({
      "GET /v1/apps/123/betaFeedbackScreenshotSubmissions": (req) => ({
        body: {
          data: [
            {
              type: "betaFeedbackScreenshotSubmissions",
              id: req.query.has("cursor") ? "b" : "a",
              attributes: { comment: "report" },
            },
          ],
          links: req.query.has("cursor")
            ? {}
            : {
                next: "https://api.appstoreconnect.apple.com/v1/apps/123/betaFeedbackScreenshotSubmissions?cursor=next",
              },
          meta: { paging: { total: 2 } },
        },
      }),
    });
    const { ctx } = await makeCtx({ env, fetch: asc.fetch });
    const client = await connect(ctx);
    const limited = await callConfirmed(client, "testflight_feedback", {
      ...base,
      action: "sync",
      max_items: 1,
    });
    expect(limited.result.data.truncated).toBe(true);
    expect(asc.requests).toHaveLength(1);
    const full = await callConfirmed(client, "testflight_feedback", {
      ...base,
      action: "sync",
      max_items: 2,
    });
    expect(full.result.data.truncated).toBe(false);
    expect(full.result.data.count).toBe(2);
    await callConfirmed(client, "testflight_feedback", {
      ...base,
      action: "triage",
      feedback_id: "a",
      decision,
    });
    const filtered = await call(client, "testflight_feedback", { ...base, action: "inbox", status: "new" });
    expect(filtered.data.reports.map((r: { id: string }) => r.id)).toEqual(["b"]);
    const first = await call(client, "testflight_feedback", { ...base, action: "inbox", max_items: 1 });
    expect(first.data.next_offset).toBe(1);
    const second = await call(client, "testflight_feedback", {
      ...base,
      action: "inbox",
      max_items: 1,
      offset: first.data.next_offset,
    });
    expect(first.data.reports[0].id).not.toBe(second.data.reports[0].id);
    expect(second.data.truncated).toBe(false);
    await client.close();
  });
  it("previews writes, preserves decisions on refresh, and reads offline across server restarts", async () => {
    const { ctx, client, asc, update } = await setup();
    const preview = await call(client, "testflight_feedback", { ...base, action: "sync" });
    expect(preview.data.status).toBe("preview");
    expect(asc.requests).toHaveLength(0);
    expect((await call(client, "testflight_feedback", { ...base, action: "inbox" })).data.reports).toEqual(
      [],
    );
    await callConfirmed(client, "testflight_feedback", { ...base, action: "sync", build_id: "build-2" });
    expect(asc.requests[0].query.get("filter[build]")).toBe("build-2");
    const triagePreview = await call(client, "testflight_feedback", {
      ...base,
      action: "triage",
      feedback_id: "report-1",
      decision,
    });
    expect(triagePreview.data.status).toBe("preview");
    expect(
      (await call(client, "testflight_feedback", { ...base, action: "get", feedback_id: "report-1" })).data
        .report.triage,
    ).toBeUndefined();
    await callConfirmed(client, "testflight_feedback", {
      ...base,
      action: "triage",
      feedback_id: "report-1",
      decision,
    });
    update();
    await callConfirmed(client, "testflight_feedback", { ...base, action: "sync" });
    const before = asc.requests.length;
    const restarted = await connect({
      ...ctx,
      asc: async () => {
        throw new Error("offline");
      },
    });
    const report = await call(restarted, "testflight_feedback", {
      ...base,
      action: "get",
      feedback_id: "report-1",
    });
    expect(report.data.report.triage).toEqual(decision);
    expect(report.data.report.submission.attributes.comment).toBe("Updated tester comment");
    expect(asc.requests).toHaveLength(before);
    expect(
      (await call(client, "testflight_feedback", { ...base, app: "456", action: "inbox" })).data.reports,
    ).toEqual([]);
    const root = join(ctx.jobs.stateDir!, "testflight-feedback");
    const scopes = await readdir(root);
    const files = await readdir(join(root, scopes[0]));
    const path = join(root, scopes[0], files[0]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).triage).toEqual(decision);
    await restarted.close();
    await client.close();
  });

  it("fetches crash evidence only after confirmation and requires evidence for verified decisions", async () => {
    const { client, asc } = await setup();
    const crash = { app: "123", kind: "crash" };
    await callConfirmed(client, "testflight_feedback", { ...crash, action: "sync" });
    const args = { ...crash, action: "crash_log", feedback_id: "crash-1" };
    const preview = await call(client, "testflight_feedback", args);
    expect(asc.requests).toHaveLength(1);
    const altered = await call(client, "testflight_feedback", {
      ...args,
      feedback_id: "other",
      confirm_token: preview.data.confirm_token,
    });
    expect(altered.isError).toBe(true);
    const { result } = await callConfirmed(client, "testflight_feedback", args);
    expect(result.data.report.crash_log.data.attributes.logText).toBe("crash stack");
    const rejected = await call(client, "testflight_feedback", {
      ...crash,
      action: "triage",
      feedback_id: "crash-1",
      decision: { ...decision, status: "verified" },
    });
    expect(rejected.isError).toBe(true);
    const accepted = await callConfirmed(client, "testflight_feedback", {
      ...crash,
      action: "triage",
      feedback_id: "crash-1",
      decision: {
        ...decision,
        status: "verified",
        fixed_build: "42",
        verification: "Reproduction passes on device with build 42",
      },
    });
    expect(accepted.result.data.report.triage.status).toBe("verified");
    await client.close();
  });
});
