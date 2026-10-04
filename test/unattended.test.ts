import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config";
import { parseAutoConfirm } from "../src/core/confirm";
import { readPersistedJobs } from "../src/core/jobs";
import { buildPlist } from "../src/core/plist";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0]);

async function makeApp() {
  const app = join(await mkdtemp(join(tmpdir(), "ua-")), "Example.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), buildPlist({ CFBundleExecutable: "Example" }));
  await writeFile(join(app, "Contents", "MacOS", "Example"), MACHO);
  return app;
}

/** A PID that is certainly not running. */
const DEAD_PID = 2 ** 22 + 12345;

describe("auto-confirm policy through tools", () => {
  it("safe policy runs non-destructive actions without a token", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx({ policy: parseAutoConfirm("safe") });
    runner.on("xattr", ["-w"], {});
    const r = await call(await connect(ctx), "quarantine", { action: "set", path: app });
    expect(r.text).toMatch(/auto-confirmed/);
    expect(r.data.auto_confirmed).toBe(true);
    expect(runner.callsTo("xattr")).toHaveLength(1);
  });

  it("safe policy still previews destructive actions; an explicit list entry runs them", async () => {
    // tccutil reset without a bundle ID affects every app, so its preview is destructive.
    const mac = await makeCtx({ policy: parseAutoConfirm("safe") });
    const p = await call(await connect(mac.ctx), "privacy", { action: "tcc_reset", service: "Camera" });
    expect(p.data.status).toBe("preview");
    expect(p.data.destructive).toBe(true);
    expect(mac.runner.callsTo("tccutil")).toHaveLength(0);

    const listed = await makeCtx({ policy: parseAutoConfirm("privacy:tcc_reset") });
    listed.runner.on("tccutil", ["reset"], {});
    const r = await call(await connect(listed.ctx), "privacy", { action: "tcc_reset", service: "Camera" });
    expect(r.data.auto_confirmed).toBe(true);
  });
});

describe("jobs from previous sessions", () => {
  it("reports a job whose server died as LOST with notarization recovery steps", async () => {
    const { ctx } = await makeCtx();
    const dir = ctx.jobs.stateDir!;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "job_dead0001.json"),
      JSON.stringify({
        id: "job_dead0001",
        name: "notarize_and_staple",
        description: "Notarize X.app",
        status: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pid: DEAD_PID,
        progress: "Waiting for Apple",
        meta: { submissionId: "sub-old", path: "/tmp/X.app" },
      }),
    );
    const client = await connect(ctx);
    const list = await call(client, "jobs", { action: "list" });
    expect(list.text).toMatch(
      /job_dead0001 notarize_and_staple — LOST \(server stopped\) \[previous session\] submission sub-old/,
    );
    const st = await call(client, "jobs", { action: "status", job_id: "job_dead0001" });
    expect(st.text).toMatch(/LOST/);
    expect(st.text).toMatch(/notary action=status submission_id=sub-old/);
    expect(st.text).toMatch(/watch-notarization sub-old/);
    const cancel = await call(client, "jobs", { action: "cancel", job_id: "job_dead0001" });
    expect(cancel.isError).toBe(true);
  });

  it("prunes state files older than 30 days", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prune-"));
    const old = {
      id: "job_old",
      name: "x",
      description: "d",
      status: "succeeded",
      startedAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      pid: DEAD_PID,
      meta: {},
    };
    await writeFile(join(dir, "job_old.json"), JSON.stringify(old));
    expect(readPersistedJobs(dir)).toEqual([]);
    expect(existsSync(join(dir, "job_old.json"))).toBe(false);
  });
});

describe("duplicate notarization guard", () => {
  it("refuses to re-submit an artifact that a live job is notarizing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dup-"));
    const zip = join(dir, "X.zip");
    await writeFile(zip, "zip");
    const { ctx, runner } = await makeCtx();
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      ctx.platform.homeDir,
      { NOTARY_KEYCHAIN_PROFILE: "p" },
      join(ctx.platform.homeDir, "c"),
    );
    runner
      .on("xcrun", ["notarytool", "submit"], { stdout: '{"id":"sub-1","message":"ok"}' })
      .on("xcrun", ["notarytool", "info"], { stdout: '{"id":"sub-1","status":"In Progress"}' });
    const client = await connect(ctx);
    const first = await callConfirmed(client, "notary", { action: "submit", path: zip, max_wait_seconds: 1 });
    expect(first.result.data.status).toBe("running");
    const again = await call(client, "notary", { action: "submit", path: zip });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already being notarized by job job_[0-9a-f]+ \(submission sub-1\)/);
    expect(again.text).toMatch(/watch-job/);
    ctx.jobs.cancel(first.result.data.job_id);
  });
});

describe("fail fast on keychain prompts", () => {
  it("aborts signing when the first codesign hangs on a keychain dialog", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner.on("xattr", ["-cr"], {}).on("codesign", ["--force"], { timedOut: true });
    const { result } = await callConfirmed(await connect(ctx), "sign", {
      path: app,
      identity: "Developer ID Application: X (ABCDE12345)",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/keychain access prompt/);
    expect(result.text).toMatch(/Always Allow/);
    expect(runner.callsTo("codesign").filter((a) => a[0] === "--force")).toHaveLength(1);
    expect(runner.calls.find((c) => c.cmd === "codesign")!.opts.timeoutMs).toBe(45000);
  });

  it("doctor flags a locked keychain, unaccepted Xcode license and pending first launch", async () => {
    const { ctx, runner } = await makeCtx();
    runner
      .on("sw_vers", [], { stdout: "15.5\n" })
      .on("xcode-select", ["-p"], { stdout: "/Applications/Xcode.app/Contents/Developer\n" })
      .on("xcodebuild", ["-version"], { stdout: "Xcode 26.0\nBuild version 17A1\n" })
      .on("xcodebuild", ["-license", "check"], {
        code: 1,
        stderr: "You have not agreed to the Xcode license agreements.",
      })
      .on("xcodebuild", ["-checkFirstLaunchStatus"], { code: 69 })
      .on("security", ["show-keychain-info"], {
        code: 36,
        stderr: "security: SecKeychainCopySettings: User interaction is not allowed.",
      })
      .on("xcrun", ["--find"], (_c, a) => ({ stdout: `/usr/bin/${a[1]}\n` }))
      .on("security", ["find-identity"], { stdout: "     0 valid identities found\n" })
      .on("security", ["find-certificate"], { stdout: "" });
    const r = await call(await connect(ctx), "doctor", {});
    expect(r.text).toMatch(/sudo xcodebuild -license accept/);
    expect(r.text).toMatch(/sudo xcodebuild -runFirstLaunch/);
    expect(r.text).toMatch(/login keychain is locked/);
  });
});

describe("plugin packaging", () => {
  it("plugin.json runs the npm package pinned to this version; no root .mcp.json", async () => {
    const root = join(__dirname, "..");
    const plugin = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(plugin.mcpServers.notarize).toEqual({
      command: "npx",
      args: ["-y", `notarize-mcp@${pkg.version}`],
    });
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });
});
