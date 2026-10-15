import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPlist } from "../src/core/plist";
import { discoverNestedCode } from "../src/parsers/macho";
import { ascEnv, call, callConfirmed, connect, fakeAsc, makeCtx } from "./helpers";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0]);
const APP = { type: "apps", id: "A1", attributes: { bundleId: "com.example.app" } };

async function setup(routes: Parameters<typeof fakeAsc>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "distribution-regression-"));
  const asc = fakeAsc({ "GET /v1/apps": { body: { data: [APP] } }, ...routes });
  const { ctx } = await makeCtx({ env: await ascEnv(dir), fetch: asc.fetch, isMac: false });
  return { asc, ctx, client: await connect(ctx), dir };
}

describe("capability relationships and App Groups", () => {
  it("lists capabilities without Apple's rejected limit parameter", async () => {
    const { client, asc } = await setup({
      "GET /v1/bundleIds": {
        body: { data: [{ type: "bundleIds", id: "B1", attributes: { identifier: "com.example.app" } }] },
      },
      "GET /v1/bundleIds/B1/bundleIdCapabilities": (req) => {
        expect(req.query.has("limit")).toBe(false);
        return {
          body: {
            data: [
              { type: "bundleIdCapabilities", id: "CAP1", attributes: { capabilityType: "APP_GROUPS" } },
            ],
          },
        };
      },
    });
    const result = await call(client, "asc_bundle_ids", {
      action: "capabilities",
      bundle_id: "com.example.app",
    });
    expect(result.isError).toBe(false);
    expect(result.data.capabilities[0].capabilityType).toBe("APP_GROUPS");
    expect(asc.requests.filter((r) => r.path.endsWith("/bundleIdCapabilities"))).toHaveLength(1);
  });

  it("checks static Expo entitlements and does not confuse capability enablement with container assignment", async () => {
    const { client, dir } = await setup({
      "GET /v1/certificates": { body: { data: [] } },
      "GET /v1/bundleIds": {
        body: { data: [{ type: "bundleIds", id: "B1", attributes: { identifier: "com.example.app" } }] },
      },
      "GET /v1/bundleIds/B1/bundleIdCapabilities": (req) => {
        expect(req.query.has("limit")).toBe(false);
        return {
          body: {
            data: [
              { type: "bundleIdCapabilities", id: "CAP1", attributes: { capabilityType: "APP_GROUPS" } },
            ],
          },
        };
      },
    });
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "^54.0.0" } }));
    await writeFile(
      join(dir, "app.json"),
      JSON.stringify({
        expo: {
          name: "Example",
          ios: {
            bundleIdentifier: "com.example.app",
            entitlements: { "com.apple.security.application-groups": ["group.com.example.app"] },
          },
        },
      }),
    );
    const result = await call(client, "distribution_checklist", { path: dir, target: "testflight-ios" });
    expect(result.isError).toBe(false);
    expect(result.data.items.find((i: any) => i.id === "capabilities").status).toBe("ok");
    expect(result.data.items.find((i: any) => i.id === "app-groups")).toMatchObject({ status: "manual" });
    expect(result.data.items.find((i: any) => i.id === "app-groups").fix).toContain("Continue → Assign");
  });

  it("includes the manual assignment step in APP_GROUPS previews", async () => {
    const { client, asc } = await setup({
      "GET /v1/bundleIds": {
        body: { data: [{ type: "bundleIds", id: "B1", attributes: { identifier: "com.example.app" } }] },
      },
    });
    const result = await call(client, "asc_bundle_ids", {
      action: "enable_capability",
      bundle_id: "com.example.app",
      capability_type: "APP_GROUPS",
    });
    expect(result.data.status).toBe("preview");
    expect(result.text).toContain("does not assign a shared container");
    expect(asc.requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("resource bundles and target-specific signature inspection", () => {
  it("skips resource-only wrappers while retaining code inside them and executable bundles", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "resources-")), "Example.app");
    const resource = join(root, "Privacy.bundle");
    const hidden = join(root, "Resources.bundle");
    const executable = join(root, "Plugin.bundle");
    for (const dir of [resource, hidden, executable]) await mkdir(dir, { recursive: true });
    await writeFile(join(root, "Example"), MACHO);
    await writeFile(join(resource, "PrivacyInfo.xcprivacy"), buildPlist({ NSPrivacyTracking: false }));
    await writeFile(join(hidden, "helper"), MACHO);
    await writeFile(join(executable, "Info.plist"), buildPlist({ CFBundleExecutable: "CustomBinary" }));
    await writeFile(join(executable, "CustomBinary"), MACHO);
    const paths = (await discoverNestedCode(root)).map((c) => c.relativePath);
    expect(paths).not.toContain("Privacy.bundle");
    expect(paths).not.toContain("Resources.bundle");
    expect(paths).toContain("Resources.bundle/helper");
    expect(paths).toContain("Plugin.bundle");
    expect(paths).not.toContain("Plugin.bundle/CustomBinary");
    expect(await discoverNestedCode(resource)).toEqual([]);
  });

  it.each([false, true])(
    "keeps iOS signature findings accurate when an extension is unsigned=%s",
    async (unsigned) => {
      const root = join(await mkdtemp(join(tmpdir(), "ios-signatures-")), "Example.app");
      const extension = join(root, "PlugIns", "Widget.appex");
      const resource = join(root, "Privacy.bundle");
      await mkdir(extension, { recursive: true });
      await mkdir(resource);
      await writeFile(join(root, "Example"), MACHO);
      await writeFile(join(extension, "Widget"), MACHO);
      await writeFile(join(root, "embedded.mobileprovision"), "fake CMS payload");
      const signature =
        "Executable=/Example\nIdentifier=com.example.app\nCodeDirectory v=20400 flags=0x0(none)\nAuthority=Apple Distribution: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
      const { ctx, runner } = await makeCtx();
      runner
        .on(
          "codesign",
          (_c, a) => a[0] === "-dvvv",
          (_c, a) =>
            unsigned && a[1] === extension
              ? { code: 1, stderr: "code object is not signed at all" }
              : { stderr: signature },
        )
        .on("codesign", ["--verify"], { stderr: "valid on disk" })
        .on("codesign", ["-d", "--entitlements"], { stdout: buildPlist({ "get-task-allow": false }) })
        .on("security", ["cms"], {
          stdout: buildPlist({
            Name: "Distribution",
            TeamIdentifier: ["ABCDE12345"],
            Platform: ["iOS"],
            Entitlements: { "application-identifier": "ABCDE12345.com.example.app", "get-task-allow": false },
          }),
        });
      const result = await call(await connect(ctx), "inspect_code_signature", {
        path: root,
        target: "testflight-ios",
      });
      expect(result.isError).toBe(false);
      expect(result.text).not.toMatch(
        /hardened runtime not enabled|no secure timestamp|Nested bundle: unsigned/,
      );
      expect(result.data.findings.filter((f: any) => f.severity === "error")).toHaveLength(unsigned ? 1 : 0);
      if (unsigned) expect(result.text).toContain("Nested appex: unsigned");
      expect(runner.callsTo("codesign").some((a) => a.includes(resource))).toBe(false);
    },
  );

  it("retains Developer ID runtime and timestamp findings on nested code", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "mac-signatures-")), "Example.app");
    const helper = join(root, "Contents", "XPCServices", "Worker.xpc");
    await mkdir(helper, { recursive: true });
    const { ctx, runner } = await makeCtx();
    runner
      .on("codesign", ["-dvvv"], {
        stderr:
          "Identifier=com.example.app\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\nCodeDirectory v=20400 flags=0x0(none)\n",
      })
      .on("codesign", ["--verify"], { stderr: "valid on disk" })
      .on("codesign", ["-d", "--entitlements"], { stdout: buildPlist({}) });
    const result = await call(await connect(ctx), "inspect_code_signature", {
      path: root,
      target: "mac-developer-id",
    });
    expect(result.data.nested[0].issues).toEqual(
      expect.arrayContaining(["hardened runtime not enabled", "no secure timestamp"]),
    );
  });
});

describe("TestFlight membership and invitations", () => {
  it("does not call a NOT_INVITED membership an invitation", async () => {
    const { client, asc } = await setup({
      "POST /v1/betaTesters": {
        status: 201,
        body: { data: { type: "betaTesters", id: "T1", attributes: { state: "NOT_INVITED" } } },
      },
    });
    const { preview, result } = await callConfirmed(client, "testflight", {
      action: "add_testers",
      group_id: "G1",
      testers: [{ email: "tester@example.com" }],
    });
    expect(preview.text).not.toContain("Testers receive an email invitation");
    expect(result.data.results).toEqual([
      { email: "tester@example.com", status: "added to group", id: "T1", invitationState: "NOT_INVITED" },
    ]);
    expect(result.text).not.toContain(": invited");
    expect(asc.requests.some((r) => r.path.includes("betaTesterInvitations"))).toBe(false);
  });

  it("lists a group's testers without requiring app and displays their invitation states", async () => {
    const { client, asc } = await setup({
      "GET /v1/betaGroups/G1/betaTesters": {
        body: {
          data: [
            { type: "betaTesters", id: "T1", attributes: { email: "tester@example.com", state: "INVITED" } },
          ],
        },
      },
    });
    const result = await call(client, "testflight", { action: "testers", group_id: "G1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("INVITED");
    expect(asc.requests.map((r) => r.path)).toEqual(["/v1/betaGroups/G1/betaTesters"]);
  });

  it("sends app-scoped invitations only after confirming the email preview", async () => {
    const { client, asc } = await setup({
      "GET /v1/betaTesters": (req) => {
        expect(req.query.get("filter[apps]")).toBe("A1");
        expect(req.query.get("filter[email]")).toBe("tester@example.com");
        return { body: { data: [{ type: "betaTesters", id: "T1" }] } };
      },
      "POST /v1/betaTesterInvitations": {
        status: 201,
        body: { data: { type: "betaTesterInvitations", id: "I1" } },
      },
    });
    const args = {
      action: "send_invites",
      app: "com.example.app",
      testers: [{ email: "tester@example.com" }],
    };
    const preview = await call(client, "testflight", args);
    expect(preview.data.status).toBe("preview");
    expect(preview.data.destructive).toBe(true);
    expect(preview.text).toContain("tester@example.com");
    expect(asc.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    const result = await call(client, "testflight", { ...args, confirm_token: preview.data.confirm_token });
    expect(result.isError).toBe(false);
    expect(result.data.results[0].status).toBe("invitation sent");
    expect(asc.requests.find((r) => r.method === "POST")!.body.data.relationships).toEqual({
      app: { data: { type: "apps", id: "A1" } },
      betaTester: { data: { type: "betaTesters", id: "T1" } },
    });
  });

  it("explains Apple's no-installable-build refusal without claiming an invitation was sent", async () => {
    const { client } = await setup({
      "GET /v1/betaTesters": { body: { data: [{ type: "betaTesters", id: "T1" }] } },
      "POST /v1/betaTesterInvitations": {
        status: 409,
        body: {
          errors: [
            {
              code: "STATE_ERROR.TESTER_INVITE.NO_INSTALLABLE_BUILDS",
              title: "Tester has no installable build.",
            },
          ],
        },
      },
    });
    const { result } = await callConfirmed(client, "testflight", {
      action: "send_invites",
      app: "com.example.app",
      testers: [{ email: "tester@example.com" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("wait for VALID");
    expect(result.text).toContain("add_build_to_group");
    expect(result.data.results[0].status).toBe("failed");
  });
});

describe("uploads before builds become visible", () => {
  it("stops on upload validation failure and selects the requested marketing version", async () => {
    const { client, asc } = await setup({
      "GET /v1/builds": { body: { data: [] } },
      "GET /v1/apps/A1/buildUploads": {
        body: {
          data: [
            {
              type: "buildUploads",
              id: "OLD",
              attributes: {
                cfBundleVersion: "1",
                cfBundleShortVersionString: "1.0.0",
                state: { state: "PROCESSING" },
              },
            },
            {
              type: "buildUploads",
              id: "U1",
              attributes: {
                cfBundleVersion: "1",
                cfBundleShortVersionString: "2.0.0",
                state: {
                  state: "FAILED",
                  errors: [{ code: "ITMS-91053", description: "Missing API declaration" }],
                },
              },
            },
          ],
        },
      },
    });
    const result = await call(client, "asc_builds", {
      action: "wait_processing",
      app: "com.example.app",
      build_number: "1",
      version: "2.0.0",
    });
    expect(result.isError).toBe(true);
    expect(result.data.state).toBe("FAILED");
    expect(result.data.upload.id).toBe("U1");
    expect(result.text).toContain("Missing API declaration");
    expect(
      asc.requests.find((r) => r.path === "/v1/builds")!.query.get("filter[preReleaseVersion.version]"),
    ).toBe("2.0.0");
  });

  it.each([200, 404])("keeps watching until VALID when upload lookup returns %s", async (uploadStatus) => {
    let buildsRead = 0;
    const { client, asc } = await setup({
      "GET /v1/builds": () => ({
        body: {
          data:
            buildsRead++ === 0
              ? []
              : [
                  {
                    type: "builds",
                    id: "B1",
                    attributes: { version: "1", processingState: "VALID", usesNonExemptEncryption: false },
                  },
                ],
        },
      }),
      "GET /v1/apps/A1/buildUploads":
        uploadStatus === 200
          ? {
              body: {
                data: [
                  {
                    type: "buildUploads",
                    id: "U1",
                    attributes: { cfBundleVersion: "1", state: { state: "PROCESSING", errors: [] } },
                  },
                ],
              },
            }
          : { status: 404, body: { errors: [{ code: "NOT_FOUND", title: "Not found" }] } },
    });
    const original = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) =>
        original(callback, delay === 30000 ? 0 : delay, ...args),
      );
    try {
      const result = await call(client, "asc_builds", {
        action: "wait_processing",
        app: "com.example.app",
        build_number: "1",
      });
      expect(result.isError).toBe(false);
      expect(result.data.state).toBe("VALID");
      expect(result.data.build.id).toBe("B1");
      expect(asc.requests.filter((r) => r.path.endsWith("/buildUploads"))).toHaveLength(1);
      if (uploadStatus === 404) expect(result.data.uploadStatusUnavailable).toContain("404");
    } finally {
      timer.mockRestore();
    }
  });
});
