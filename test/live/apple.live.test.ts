import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchJob } from "../../src/cli/watch";
import { createContext } from "../../src/context";
import { ConfirmManager } from "../../src/core/confirm";
import { connect } from "../helpers";

/**
 * LIVE tests against a real Apple developer account. Never destructive.
 *
 *   NOTARIZE_LIVE=1 ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_PRIVATE_KEY_PATH=… pnpm run test:live
 *
 * Add NOTARIZE_LIVE_NOTARIZE=1 (macOS, Developer ID Application identity in the keychain)
 * to sign + notarize + staple a tiny test app end to end. See docs/testing.md.
 */
const LIVE = process.env.NOTARIZE_LIVE === "1";
const NOTARIZE = LIVE && process.env.NOTARIZE_LIVE_NOTARIZE === "1" && process.platform === "darwin";

async function liveClient() {
  // Real runner, real fetch, real config. Auto-confirm only the non-destructive notarization path.
  const ctx = createContext({
    confirm: new ConfirmManager({
      policy: { mode: "list", entries: ["sign", "notarize_and_staple", "gatekeeper"] },
    }),
  });
  return { ctx, client: await connect(ctx) };
}

async function callText(
  client: Awaited<ReturnType<typeof connect>>,
  name: string,
  args: Record<string, unknown>,
) {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content.map((c: any) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name} failed:\n${text}`);
  return { text, data: r.structuredContent };
}

describe.skipIf(!LIVE)("App Store Connect (read-only)", () => {
  it("authenticates", async () => {
    const { client } = await liveClient();
    const r = await callText(client, "asc_auth", { action: "test" });
    expect(r.text).toMatch(/works/);
  });

  it.each([
    ["asc_apps", { action: "list" }],
    ["asc_bundle_ids", { action: "list" }],
    ["asc_certificates", { action: "list" }],
    ["asc_profiles", { action: "list" }],
    ["asc_devices", { action: "list" }],
  ])("%s lists without errors", async (tool, args) => {
    const { client } = await liveClient();
    await callText(client, tool, args);
  });

  it.skipIf(process.platform !== "darwin")(
    "notarytool history works with the configured credentials",
    async () => {
      const { client } = await liveClient();
      await callText(client, "notary", { action: "history" });
    },
  );

  it("distribution_checklist runs against the real account", async () => {
    const { client } = await liveClient();
    const r = await callText(client, "distribution_checklist", { target: "mac-developer-id" });
    expect(r.data.items.find((i: { id: string }) => i.id === "api-key").status).toBe("ok");
  });
});

describe.skipIf(!NOTARIZE)(
  "Developer ID end to end (uploads a tiny test app to Apple's notary service)",
  () => {
    it("signs, notarizes, staples and passes Gatekeeper", async () => {
      const work = mkdtempSync(join(tmpdir(), "notarize-live-"));
      const app = execFileSync("bash", [
        "-c",
        `source scripts/lib/build-test-app.sh && build_test_app "${work}"`,
      ])
        .toString()
        .trim()
        .split("\n")
        .at(-1)!;
      const { ctx, client } = await liveClient();
      const signed = await callText(client, "sign", {
        path: app,
        identity: "auto",
        target: "mac-developer-id",
      });
      expect(signed.text).toMatch(/Verify: valid/);
      const r = await callText(client, "notarize_and_staple", { path: app, max_wait_seconds: 60 });
      let summary = r.text;
      if (r.data.status === "running") {
        const code = await watchJob(r.data.job_id, {
          stateDir: ctx.jobs.stateDir,
          intervalMs: 15_000,
          maxMs: 3_000_000,
        });
        expect(code).toBe(0);
        summary = (await callText(client, "jobs", { action: "status", job_id: r.data.job_id })).text;
      }
      expect(summary).toMatch(/ACCEPTED/);
      expect(summary).toMatch(/Stapled ✓/);
      const gk = await callText(client, "gatekeeper", { action: "simulate_download", path: app });
      expect(gk.text).toMatch(/should open it without warnings/);
    });
  },
);
