import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalAppleDoc, contextPath, digest, freshness } from "../src/core/apple-context";
import { FakeRunner } from "../src/core/fake-runner";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const url = "https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/minlensaperture";
function document(version = "27.0", beta = false) {
  return {
    metadata: { title: "minLensAperture", platforms: [{ name: "iOS", introducedAt: version, beta }] },
    abstract: [{ type: "text", text: "A format's minimum supported aperture." }],
    primaryContentSections: [
      { kind: "declarations", declarations: [{ tokens: [{ text: "var minLensAperture: Float { get }" }] }] },
      {
        kind: "content",
        content: [
          {
            type: "paragraph",
            inlineContent: [
              { type: "text", text: "Inspect " },
              { type: "reference", identifier: "related" },
            ],
          },
        ],
      },
    ],
    references: {
      related: { title: "Active format", url: "/documentation/avfoundation/avcapturedevice/activeformat" },
    },
  };
}
function runnerWithSettings() {
  let sdk = "26.0";
  const runner = new FakeRunner()
    .on("xcode-select", ["-p"], { stdout: "/Applications/Xcode.app/Contents/Developer\n" })
    .on("xcodebuild", ["-version"], { stdout: "Xcode 26.3\nBuild version 17C10\n" })
    .on("xcodebuild", ["-showsdks"], { stdout: "iOS SDKs:\n iOS 26.0 -sdk iphoneos26.0\n" })
    .on("xcrun", ["--find", "mcpbridge"], {
      stdout: "/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge\n",
    })
    .on("xcodebuild", ["-showBuildSettings"], () => ({
      stdout: JSON.stringify([
        {
          target: "App",
          buildSettings: {
            SDK_VERSION: sdk,
            SDKROOT: "iphoneos",
            PLATFORM_NAME: "iphoneos",
            IPHONEOS_DEPLOYMENT_TARGET: "18.0",
            SWIFT_VERSION: "6.0",
            PRODUCT_TYPE: "com.apple.product-type.application",
            APP_SECRET: "never-return-this",
          },
        },
        {
          target: "CaptureExtension",
          buildSettings: {
            SDK_VERSION: sdk,
            PLATFORM_NAME: "iphoneos",
            IPHONEOS_DEPLOYMENT_TARGET: "18.0",
            PRODUCT_TYPE: "com.apple.product-type.app-extension",
          },
        },
      ]),
    }));
  return {
    runner,
    updateSdk: () => {
      sdk = "27.0";
    },
  };
}
async function projectSelection() {
  const root = await mkdtemp(join(tmpdir(), "apple-context-"));
  const path = join(root, "Trusted App.xcodeproj");
  await mkdir(path);
  return { path, scheme: "App", destination: "generic/platform=iOS" };
}
const decision = {
  summary: "Offer aperture controls when supported",
  implementation_plan: "Guard the API and query the active format",
  constraints: ["Check runtime exposure combinations"],
  fallback: "Automatic exposure",
  unresolved: ["Physical hardware still needs testing"],
  verification: [{ stage: "compile", result: "not_run", evidence: "No app feature was compiled" }],
};

describe("Apple platform inspection", () => {
  it("reads selected toolchain/target facts, previews snapshots and never returns unrelated build settings", async () => {
    const { runner } = runnerWithSettings();
    const selection = await projectSelection();
    const developerDir = join(selection.path, "Xcode Beta.app");
    await mkdir(developerDir);
    const { ctx } = await makeCtx({ runner });
    const client = await connect(ctx);
    const preview = await call(client, "apple_platform_context", { ...selection, action: "snapshot" });
    expect(preview.data.status).toBe("preview");
    expect(runner.calls).toHaveLength(0);
    const inspected = await call(client, "apple_platform_context", {
      ...selection,
      action: "inspect",
      developer_dir: developerDir,
    });
    expect(inspected.data.saved).toBe(false);
    expect(inspected.data.snapshot.facts.targets).toHaveLength(2);
    expect(inspected.text).not.toContain("never-return-this");
    expect(inspected.data.snapshot.facts.toolchain.mcp_bridge_available).toBe(true);
    const command = runner.calls.find((c) => c.args[0] === "-showBuildSettings")!;
    expect(command.args).toContain(selection.path);
    expect(command.opts.env?.DEVELOPER_DIR).toBe(developerDir);
    const { result } = await callConfirmed(client, "apple_platform_context", {
      ...selection,
      action: "snapshot",
    });
    const snapshot = result.data.snapshot;
    expect(snapshot.fingerprint).toBe(digest(snapshot.facts));
    const path = contextPath(ctx, "projects", snapshot.snapshot_id);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).snapshot_id).toBe(snapshot.snapshot_id);
    const count = runner.calls.length;
    const cached = await call(client, "apple_platform_context", {
      action: "get",
      snapshot_id: snapshot.snapshot_id,
    });
    expect(cached.data.snapshot).toEqual(snapshot);
    expect(runner.calls).toHaveLength(count);
    await client.close();
  });

  it("reports non-Mac gaps without pretending to know a local SDK or device", async () => {
    const { ctx, runner } = await makeCtx({ isMac: false });
    const client = await connect(ctx);
    const result = await call(client, "apple_platform_context", { action: "inspect" });
    expect(result.data.snapshot.facts.targets).toEqual([]);
    expect(result.data.snapshot.facts.toolchain).toEqual({});
    expect(result.data.snapshot.facts.gaps.join(" ")).toMatch(/Mac runner/);
    expect(runner.calls).toHaveLength(0);
    await client.close();
  });
});

describe("Official Apple documentation", () => {
  it("caches parsed availability and links, revalidates with ETag, preserves revisions and reads offline", async () => {
    const requests: { url: string; headers?: RequestInit["headers"] }[] = [];
    let responseMode = "initial";
    let now = new Date("2026-11-08T00:00:00Z");
    const { ctx } = await makeCtx({
      fetch: (async (input, init) => {
        requests.push({ url: String(input), headers: init?.headers });
        if (responseMode === "offline") throw new Error("network unavailable");
        if (responseMode === "unchanged") return new Response(null, { status: 304 });
        return Response.json(document(responseMode === "updated" ? "27.1" : "27.0"), {
          headers: { etag: responseMode === "updated" ? '"two"' : '"one"' },
        });
      }) as typeof fetch,
    });
    ctx.now = () => now;
    const client = await connect(ctx);
    const args = { action: "fetch", url };
    const preview = await call(client, "apple_docs", args);
    expect(preview.data.status).toBe("preview");
    expect(requests).toHaveLength(0);
    const initial = await callConfirmed(client, "apple_docs", args);
    const doc = initial.result.data.document;
    expect(doc.availability[0].introducedAt).toBe("27.0");
    expect(doc.content).toContain("var minLensAperture");
    expect(doc.content).toContain(
      "[Active format](https://developer.apple.com/documentation/avfoundation/avcapturedevice/activeformat)",
    );
    expect(requests[0].url).toContain("/tutorials/data/documentation/");
    responseMode = "unchanged";
    now = new Date("2026-11-09T00:00:00Z");
    const revalidated = await callConfirmed(client, "apple_docs", args);
    expect((requests[1].headers as Record<string, string>)["If-None-Match"]).toBe('"one"');
    expect(revalidated.result.data.document.fetched_at).toBe(doc.fetched_at);
    expect(revalidated.result.data.document.checked_at).toBe(now.toISOString());
    responseMode = "updated";
    const updated = await callConfirmed(client, "apple_docs", args);
    expect(updated.result.data.document.content_hash).not.toBe(doc.content_hash);
    responseMode = "offline";
    const failure = await callConfirmed(client, "apple_docs", args);
    expect(failure.result.isError).toBe(true);
    const old = await call(client, "apple_docs", { action: "read", url, content_hash: doc.content_hash });
    expect(old.data.document.availability[0].introducedAt).toBe("27.0");
    const latest = await call(client, "apple_docs", { action: "read", url });
    expect(latest.data.document.availability[0].introducedAt).toBe("27.1");
    now = new Date("2026-12-01T00:00:00Z");
    expect((await call(client, "apple_docs", { action: "read", url })).data.freshness.status).toBe(
      "refresh_required",
    );
    await client.close();
  });

  it("falls back to native Markdown, supports paging, and rejects unsupported URLs and responses", async () => {
    const requested: string[] = [];
    let oversized = false;
    const { ctx } = await makeCtx({
      fetch: (async (input, init) => {
        expect(init?.redirect).toBe("error");
        requested.push(String(input));
        if (oversized) return new Response("too big", { headers: { "content-length": "3000000" } });
        if (String(input).includes(".json")) return new Response(null, { status: 404 });
        return new Response(
          `<!--\n{"metadataVersion":"0.1.0","title":"Example"}\n-->\n\n# Example\n\n${"content ".repeat(300)}`,
          {
            headers: { "content-type": "text/markdown" },
          },
        );
      }) as typeof fetch,
    });
    const client = await connect(ctx);
    const { result } = await callConfirmed(client, "apple_docs", { action: "fetch", url, max_chars: 1000 });
    expect(requested).toHaveLength(2);
    expect(result.data.document.format).toBe("markdown");
    expect(result.data.document.availability).toEqual([]);
    expect(result.data.next_offset).toBe(1000);
    const page = await call(client, "apple_docs", { action: "read", url, offset: 1000, max_chars: 1000 });
    expect(page.data.next_offset).toBe(2000);
    for (const bad of [
      "https://evil.test/documentation/a",
      "http://developer.apple.com/documentation/a",
      "https://developer.apple.com@evil.test/documentation/a",
      "https://developer.apple.com/documentation/a?redirect=https://evil.test",
      "https://developer.apple.com/news/",
    ]) {
      const rejected = await call(client, "apple_docs", { action: "fetch", url: bad });
      expect(rejected.isError).toBe(true);
    }
    expect(requested).toHaveLength(2);
    oversized = true;
    const failure = await callConfirmed(client, "apple_docs", { action: "fetch", url });
    expect(failure.result.isError).toBe(true);
    expect((await call(client, "apple_docs", { action: "read", url })).data.document.format).toBe("markdown");
    await client.close();
  });
});

describe("Feature investigation evidence", () => {
  it("separates SDK, deployment, beta and hardware checks and invalidates changed evidence", async () => {
    const { runner, updateSdk } = runnerWithSettings();
    const selection = await projectSelection();
    let introduction = "27.0";
    const { ctx } = await makeCtx({
      runner,
      now: new Date("2026-11-08T00:00:00Z"),
      fetch: (async () => Response.json(document(introduction, true))) as typeof fetch,
    });
    const client = await connect(ctx);
    const { result: snapshot } = await callConfirmed(client, "apple_platform_context", {
      ...selection,
      action: "snapshot",
    });
    const source = await callConfirmed(client, "apple_docs", { action: "fetch", url });
    const args = {
      action: "record",
      investigation_id: "app-aperture",
      feature: "variable-aperture",
      snapshot_id: snapshot.data.snapshot.snapshot_id,
      project_fingerprint: snapshot.data.snapshot.fingerprint,
      sources: [{ url, content_hash: source.result.data.document.content_hash }],
      decision,
    };
    const { result } = await callConfirmed(client, "apple_feature_context", args);
    expect(result.data.investigation.decision_provenance).toBe("agent_reported");
    expect(result.data.availability[0]).toMatchObject({
      sdk_assessment: "newer_sdk_required",
      deployment_assessment: "runtime_availability_guard_and_fallback_required",
      beta_policy: "blocked_by_stable_only_policy",
      hardware_and_runtime: "unverified",
    });
    const before = await call(client, "apple_feature_context", {
      action: "get",
      investigation_id: "app-aperture",
    });
    expect(before.data.revalidation_required).toBe(false);
    updateSdk();
    const newProject = await callConfirmed(client, "apple_platform_context", {
      ...selection,
      action: "snapshot",
    });
    expect((await call(client, "apple_feature_context", args)).isError).toBe(true);
    const changed = await call(client, "apple_feature_context", {
      action: "get",
      investigation_id: "app-aperture",
    });
    expect(changed.data.revalidation_required).toBe(true);
    expect(changed.data.context_comparison).toBe("changed_or_missing");
    introduction = "27.1";
    await callConfirmed(client, "apple_docs", { action: "fetch", url });
    const sourceChanged = await call(client, "apple_feature_context", {
      action: "get",
      investigation_id: "app-aperture",
    });
    expect(sourceChanged.data.sources[0].changed).toBe(true);
    expect(sourceChanged.data.investigation.sources[0].availability[0].introducedAt).toBe("27.0");
    const exactRevision = await callConfirmed(client, "apple_feature_context", {
      ...args,
      project_fingerprint: newProject.result.data.snapshot.fingerprint,
    });
    expect(exactRevision.result.data.investigation.sources[0].availability[0].introducedAt).toBe("27.0");
    expect(exactRevision.result.data.availability[0].sdk_assessment).toBe(
      "version_requirement_met_not_compiled",
    );
    const falseDeviceClaim = await call(client, "apple_feature_context", {
      ...args,
      decision: { ...decision, verification: [{ stage: "device", result: "passed", evidence: "works" }] },
    });
    expect(falseDeviceClaim.isError).toBe(true);
    await client.close();
  });

  it("provides dated iPhone 18 Pro discovery without inventing support for an unknown model", async () => {
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const discovery = await call(client, "apple_feature_context", {
      action: "discover",
      device: "iPhone 18 Pro",
      query: "variable-aperture",
    });
    expect(discovery.data.device.name).toBe("iPhone 18 Pro");
    expect(discovery.data.features).toHaveLength(1);
    expect(discovery.data.features[0].symbols.join(" ")).toContain("supportsExposureModeCustom");
    const unknown = await call(client, "apple_feature_context", {
      action: "discover",
      device: "unknown phone",
      query: "imaginary feature",
    });
    expect(unknown.data.device_support).toBe("unknown");
    expect(unknown.data.features).toEqual([]);
    expect(unknown.data.coverage).toContain("unknown coverage");
    await client.close();
  });
});

it("canonicalizes documentation identity and treats future cache times as needing refresh", () => {
  expect(canonicalAppleDoc(`${url}.md#discussion`)).toBe(url);
  expect(freshness("2026-12-01T00:00:00Z", new Date("2026-11-08T00:00:00Z")).status).toBe("refresh_required");
});
