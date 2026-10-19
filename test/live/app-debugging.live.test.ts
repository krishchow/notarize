import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext } from "../../src/context";
import { ConfirmManager } from "../../src/core/confirm";
import { loadDebugSession } from "../../src/core/debug-session";
import { probeDebugTarget } from "../../src/core/debug-target";
import { JobManager } from "../../src/core/jobs";
import { appDebuggingTool } from "../../src/tools/app-debugging";

const LIVE = process.env.NOTARIZE_DEBUG_LIVE === "1" && process.platform === "darwin";
describe.skipIf(!LIVE)("local Apple debugging backends (no Apple account)", () => {
  it("probes and captures real host unified logging with explicit confirmation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notarize-debug-live-"));
    const ctx = createContext({
      confirm: new ConfirmManager({ autoConfirm: false }),
      jobs: new JobManager(dir),
    });
    const args = {
      action: "start" as const,
      target: {
        platform: "macos" as const,
        bundle_id: "dev.notarize.debug-fixture",
        process: "notarize-debug-fixture",
        runtime: "native" as const,
      },
      collection: "logs" as const,
      seconds: 2,
    };
    const extra = { toolName: "app_debugging", progress: async () => {} };
    const preview = await appDebuggingTool.handler(args, ctx, extra);
    expect(preview.data?.status).toBe("preview");
    const out = await appDebuggingTool.handler(
      { ...args, confirm_token: preview.data!.confirm_token } as any,
      ctx,
      extra,
    );
    expect(out.isError).not.toBe(true);
    const jobId = out.data!.job_id as string;
    await ctx.jobs.wait(jobId, 10000);
    const session = await loadDebugSession(ctx, out.data!.session_id as string);
    expect(session.segments[0].ready_at).toBeDefined();
    expect(session.segments[0].status).toBe("complete");
    expect(session.segments[0].reason).toBe("duration");
    console.info(
      JSON.stringify({
        backend: "macos",
        target: session.target,
        status: session.segments[0].status,
        ready: !!session.segments[0].ready_at,
        durationBound: 2,
      }),
    );
  });

  it.skipIf(!process.env.NOTARIZE_DEBUG_DEVICE_ID)(
    "probes an explicitly selected physical phone without changing it",
    async () => {
      const ctx = createContext();
      const result = await probeDebugTarget(ctx, {
        platform: "ios",
        device_id: process.env.NOTARIZE_DEBUG_DEVICE_ID!,
        bundle_id: "com.meitianhanzi.app",
        process: "Meitian Hanzi",
      });
      if (result.logs) expect(result.log_mode).toBe("snapshot");
      expect(result.gaps.length).toBeGreaterThan(0);
      console.info(
        JSON.stringify({
          backend: result.backend,
          logs: result.logs,
          reports: result.reports,
          relaunch: result.relaunch,
          versions: result.versions,
          gaps: result.gaps,
        }),
      );
    },
  );
});
