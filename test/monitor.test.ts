import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlags, type WatchIO, watchJob, watchNotarization } from "../src/cli/watch";
import { ConfigStore } from "../src/core/config";
import { JobManager, readJobState } from "../src/core/jobs";
import { jobMonitor, selfCommand } from "../src/core/monitor";
import { callConfirmed, connect, makeCtx } from "./helpers";

function fakeIO(start = 1_000_000) {
  const lines: string[] = [];
  let now = start;
  const io: WatchIO = {
    print: (l) => lines.push(l),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { io, lines, advance: (ms: number) => (now += ms) };
}

describe("job state persistence", () => {
  it("mirrors status, progress, meta and final summary to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-"));
    const jm = new JobManager(dir);
    const r = await jm.runWithDeadline("notarize", "Notarize X", 1000, async (job) => {
      job.progress("Uploading");
      job.setMeta("submissionId", "sub-1");
      return { summary: "Notarization ACCEPTED\nStapled ✓", isError: false };
    });
    const s = readJobState(join(dir, `${r.jobId}.json`))!;
    expect(s).toMatchObject({
      status: "succeeded",
      meta: { submissionId: "sub-1" },
      summary: "Notarization ACCEPTED\nStapled ✓",
    });
    expect(s.resultIsError).toBeUndefined();
  });
});

describe("watch-job", () => {
  it("prints one line per change and exits 0 on success, 1 on failed result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "job_x.json");
    const base = {
      id: "job_x",
      name: "notarize",
      description: "Notarize X",
      startedAt: "",
      pid: 1,
      meta: { submissionId: "sub-1" },
    };
    const { io, lines } = fakeIO(Date.parse("2026-10-03T00:00:00Z"));
    let step = 0;
    const states = [
      { ...base, status: "running", progress: "Uploading X.zip", updatedAt: "2026-10-03T00:00:00Z" },
      { ...base, status: "running", progress: "Uploading X.zip", updatedAt: "2026-10-03T00:00:10Z" },
      { ...base, status: "running", progress: "Waiting for Apple", updatedAt: "2026-10-03T00:00:20Z" },
      {
        ...base,
        status: "succeeded",
        summary: "Notarization ACCEPTED (submission sub-1).\nStapled ✓",
        updatedAt: "2026-10-03T00:00:30Z",
      },
    ];
    const ioStepping: WatchIO = {
      ...io,
      sleep: async (ms) => {
        await io.sleep(ms);
        step = Math.min(step + 1, states.length - 1);
        await writeFile(path, JSON.stringify(states[step]));
      },
    };
    await writeFile(path, JSON.stringify(states[0]));
    const code = await watchJob("job_x", { stateDir: dir, intervalMs: 10_000 }, ioStepping);
    expect(code).toBe(0);
    expect(lines).toEqual([
      "notarize job_x: running — Uploading X.zip [submission sub-1]",
      "notarize job_x: running — Waiting for Apple [submission sub-1]",
      "notarize job_x: SUCCEEDED — Notarization ACCEPTED (submission sub-1). · Stapled ✓",
    ]);

    await writeFile(
      path,
      JSON.stringify({
        ...base,
        status: "succeeded",
        resultIsError: true,
        summary: "Notarization INVALID",
        updatedAt: "x",
      }),
    );
    const f = fakeIO();
    expect(await watchJob("job_x", { stateDir: dir }, f.io)).toBe(1);
    expect(f.lines[0]).toMatch(/FAILED — Notarization INVALID/);
  });

  it("reports a lost job when the heartbeat goes stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    await writeFile(
      join(dir, "job_y.json"),
      JSON.stringify({
        id: "job_y",
        name: "notarize",
        description: "d",
        status: "running",
        startedAt: "",
        pid: 42,
        meta: { submissionId: "sub-2" },
        updatedAt: "2026-10-03T00:00:00Z",
      }),
    );
    const { io, lines } = fakeIO(Date.parse("2026-10-03T01:00:00Z"));
    expect(await watchJob("job_y", { stateDir: dir }, io)).toBe(3);
    expect(lines.at(-1)).toMatch(/LOST .* submission sub-2/);
  });

  it("gives up with exit 2 when the job never appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const { io, lines } = fakeIO();
    expect(await watchJob("job_missing", { stateDir: dir }, io)).toBe(2);
    expect(lines[0]).toMatch(/NOT FOUND/);
  });
});

describe("watch-notarization", () => {
  it("polls Apple until Accepted", async () => {
    const { ctx, runner } = await makeCtx({ env: { NOTARY_KEYCHAIN_PROFILE: "p" } });
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      ctx.platform.homeDir,
      { NOTARY_KEYCHAIN_PROFILE: "p" },
      join(ctx.platform.homeDir, "c"),
    );
    let n = 0;
    runner.on("xcrun", ["notarytool", "info"], () => ({
      stdout: JSON.stringify({ id: "s1", name: "X.zip", status: ++n < 3 ? "In Progress" : "Accepted" }),
    }));
    const { io, lines } = fakeIO();
    expect(await watchNotarization(ctx, "s1", {}, io)).toBe(0);
    expect(lines).toEqual([
      "notarization s1: In Progress (X.zip)",
      "notarization s1: ACCEPTED — staple the artifact now (staple action=staple).",
    ]);
  });

  it("prints top issues and exits 1 when Invalid", async () => {
    const { ctx, runner } = await makeCtx();
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      ctx.platform.homeDir,
      { NOTARY_KEYCHAIN_PROFILE: "p" },
      join(ctx.platform.homeDir, "c"),
    );
    runner
      .on("xcrun", ["notarytool", "info"], { stdout: '{"id":"s1","status":"Invalid"}' })
      .on("xcrun", ["notarytool", "log"], {
        stdout: JSON.stringify({
          status: "Invalid",
          issues: [
            { severity: "error", message: "The signature does not include a secure timestamp.", path: "a" },
          ],
        }),
      });
    const { io, lines } = fakeIO();
    expect(await watchNotarization(ctx, "s1", {}, io)).toBe(1);
    expect(lines.at(-1)).toMatch(/INVALID — The signature does not include a secure timestamp/);
  });
});

describe("detached notarization returns a Monitor command", () => {
  it("hands off to a background job with watch-job + watch-notarization commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zip-"));
    const zip = join(dir, "Example.zip");
    await writeFile(zip, "zip");
    const { ctx, runner } = await makeCtx();
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      ctx.platform.homeDir,
      { NOTARY_KEYCHAIN_PROFILE: "p" },
      join(ctx.platform.homeDir, "c"),
    );
    runner
      .on("xcrun", ["notarytool", "submit"], {
        stdout: '{"id":"sub-long","message":"Successfully uploaded file"}',
      })
      .on("xcrun", ["notarytool", "info"], { stdout: '{"id":"sub-long","status":"In Progress"}' });
    const client = await connect(ctx);
    const { result } = await callConfirmed(client, "notary", {
      action: "submit",
      path: zip,
      max_wait_seconds: 1,
    });
    expect(result.data).toMatchObject({ status: "running", submission_id: "sub-long" });
    expect(result.data.monitor.command).toMatch(/watch-job job_[0-9a-f]{8} --state-dir /);
    expect(result.data.monitor.fallback_command).toMatch(/watch-notarization sub-long$/);
    expect(result.data.monitor.timeout_ms).toBe(1_800_000);
    expect(result.text).toMatch(/start the Monitor tool/);
    const state = readJobState(join(ctx.jobs.stateDir!, `${result.data.job_id}.json`));
    expect(state).toMatchObject({ status: "running", meta: { submissionId: "sub-long" } });
    ctx.jobs.cancel(result.data.job_id);
  });
});

describe("monitor helpers", () => {
  it("builds self commands and parses flags", () => {
    expect(selfCommand("/x/dist/notarize-mcp.js", "/usr/bin/node")).toBe(
      "/usr/bin/node /x/dist/notarize-mcp.js",
    );
    expect(selfCommand("/x/vitest.mjs")).toBe("npx -y notarize-mcp");
    expect(jobMonitor({ jobId: "job_1", description: "d", stateDir: "/a b", self: "nm" }).command).toBe(
      "nm watch-job job_1 --state-dir '/a b'",
    );
    expect(parseFlags(["job_1", "--state-dir", "/d", "--interval=5"])).toEqual({
      positional: ["job_1"],
      flags: { "state-dir": "/d", interval: "5" },
    });
  });
});
