import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config";
import { SpawnRunner } from "../src/core/exec";
import { ascEnv, call, callConfirmed, connect, fakeAsc, makeCtx } from "./helpers";

async function setup(routes: Parameters<typeof fakeAsc>[0], opts: { isMac?: boolean; runner?: any } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "asc-"));
  const env = await ascEnv(dir);
  const asc = fakeAsc(routes);
  const { ctx, runner, home } = await makeCtx({
    env,
    fetch: asc.fetch,
    isMac: opts.isMac ?? false,
    runner: opts.runner,
  });
  const client = await connect(ctx);
  return { ctx, runner, home, client, asc, env, dir };
}

describe("asc_auth", () => {
  it("validates and saves a profile (path only), then reports status", async () => {
    const { client, asc, env, ctx } = await setup({
      "GET /v1/apps": { body: { data: [{ type: "apps", id: "1", attributes: { name: "Ex" } }] } },
    });
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      ctx.platform.homeDir,
      {},
      join(ctx.platform.homeDir, "cfg"),
    );
    const { result } = await callConfirmed(client, "asc_auth", {
      action: "configure",
      key_id: env.ASC_KEY_ID,
      issuer_id: env.ASC_ISSUER_ID,
      private_key_path: env.ASC_PRIVATE_KEY_PATH,
      team_id: "ABCDE12345",
    });
    expect(result.text).toMatch(/Validated and saved/);
    expect(asc.requests[0].path).toBe("/v1/apps");
    const saved = JSON.parse(await readFile(ctx.config.path, "utf8"));
    expect(saved.profiles.default).toEqual({
      keyId: "TESTKEY123",
      issuerId: env.ASC_ISSUER_ID,
      privateKeyPath: env.ASC_PRIVATE_KEY_PATH,
      teamId: "ABCDE12345",
    });
    expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");
    const status = await call(client, "asc_auth", { action: "status" });
    expect(status.text).toMatch(/TESTKEY123 via profile "default"/);
  });

  it("explains 403 agreement errors", async () => {
    const { client } = await setup({
      "GET /v1/apps": {
        status: 403,
        body: {
          errors: [
            {
              status: "403",
              code: "FORBIDDEN_ERROR",
              title: "Forbidden",
              detail: "A required agreement is missing or has expired.",
            },
          ],
        },
      },
    });
    const r = await call(client, "asc_auth", { action: "test" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Account Holder must sign in .* accept the updated agreement/);
  });
});

describe("bundle IDs, certificates, profiles", () => {
  it("registers a bundle ID only after confirmation", async () => {
    const { client, asc } = await setup({
      "POST /v1/bundleIds": (req) => ({
        status: 201,
        body: { data: { type: "bundleIds", id: "B1", attributes: req.body.data.attributes } },
      }),
    });
    const args = { action: "create", bundle_id: "com.example.app", name: "Example", platform: "IOS" };
    const preview = await call(client, "asc_bundle_ids", args);
    expect(asc.requests).toHaveLength(0);
    const res = await call(client, "asc_bundle_ids", { ...args, confirm_token: preview.data.confirm_token });
    expect(res.text).toMatch(/Registered com\.example\.app \(id B1\)/);
    expect(asc.requests[0].body).toEqual({
      data: {
        type: "bundleIds",
        attributes: { identifier: "com.example.app", name: "Example", platform: "IOS" },
      },
    });
  });

  it("creates a certificate from a real CSR and saves the .cer", async () => {
    const pem = await readFile(join(__dirname, "fixtures", "devid-app.pem"), "utf8");
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const { client, asc, ctx } = await setup(
      {
        "POST /v1/certificates": () => ({
          status: 201,
          body: {
            data: {
              type: "certificates",
              id: "C1",
              attributes: {
                displayName: "Example Corp",
                certificateType: "DISTRIBUTION",
                expirationDate: "2027-01-01",
                certificateContent: der.toString("base64"),
              },
            },
          },
        }),
      },
      { runner: new SpawnRunner() },
    );
    await callConfirmed(client, "keychain", {
      action: "create_csr",
      key_name: "dist",
      common_name: "Example",
    });
    const { result } = await callConfirmed(client, "asc_certificates", {
      action: "create",
      certificate_type: "DISTRIBUTION",
      key_name: "dist",
      install: false,
    });
    expect(result.text).toMatch(/Created certificate Example Corp \(C1\)/);
    expect(asc.requests[0].body.data.attributes.csrContent).toMatch(/BEGIN CERTIFICATE REQUEST/);
    expect((await stat(join(ctx.config.keysDir, "dist.cer"))).size).toBe(der.length);
  });

  it("returns manual portal steps when Developer ID creation is refused", async () => {
    const { client, ctx } = await setup({
      "POST /v1/certificates": {
        status: 403,
        body: {
          errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "Forbidden", detail: "not allowed" }],
        },
      },
    });
    await mkdir(ctx.config.keysDir, { recursive: true });
    await writeFile(
      join(ctx.config.keysDir, "devid.csr"),
      "-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----\n",
    );
    const { result } = await callConfirmed(client, "asc_certificates", {
      action: "create",
      certificate_type: "DEVELOPER_ID_APPLICATION_G2",
      key_name: "devid",
      install: false,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Account Holder must create it/);
  });

  it("creates an Ad Hoc profile with all valid certs and enabled devices", async () => {
    const { client, asc } = await setup({
      "GET /v1/bundleIds": {
        body: { data: [{ type: "bundleIds", id: "B1", attributes: { identifier: "com.example.app" } }] },
      },
      "GET /v1/certificates": {
        body: {
          data: [
            { type: "certificates", id: "C1", attributes: { expirationDate: "2030-01-01" } },
            { type: "certificates", id: "C2", attributes: { expirationDate: "2020-01-01" } },
          ],
        },
      },
      "GET /v1/devices": {
        body: {
          data: [
            { type: "devices", id: "D1" },
            { type: "devices", id: "D2" },
          ],
        },
      },
      "POST /v1/profiles": (req) => ({
        status: 201,
        body: {
          data: {
            type: "profiles",
            id: "P1",
            attributes: { ...req.body.data.attributes, uuid: "UUID-1", profileContent: "AAAA" },
          },
        },
      }),
    });
    const { result } = await callConfirmed(client, "asc_profiles", {
      action: "create",
      profile_type: "IOS_APP_ADHOC",
      bundle_id: "com.example.app",
    });
    expect(result.text).toMatch(/Created profile "com\.example\.app IOS_APP_ADHOC" \(P1, UUID UUID-1\)/);
    const post = asc.requests.find((r) => r.method === "POST")!;
    expect(post.body.data.relationships).toEqual({
      bundleId: { data: { type: "bundleIds", id: "B1" } },
      certificates: { data: [{ type: "certificates", id: "C1" }] },
      devices: {
        data: [
          { type: "devices", id: "D1" },
          { type: "devices", id: "D2" },
        ],
      },
    });
    const certQuery = asc.requests
      .find((r) => r.path === "/v1/certificates")!
      .query.get("filter[certificateType]");
    expect(certQuery).toBe("DISTRIBUTION,IOS_DISTRIBUTION");
    expect(asc.requests.find((r) => r.path === "/v1/devices")!.query.get("filter[platform]")).toBe("IOS");
  });
});

describe("builds + raw API", () => {
  it("waits for build processing", async () => {
    const { client } = await setup({
      "GET /v1/apps": {
        body: { data: [{ type: "apps", id: "A1", attributes: { bundleId: "com.example.app" } }] },
      },
      "GET /v1/builds": {
        body: {
          data: [
            {
              type: "builds",
              id: "BU1",
              attributes: { version: "42", processingState: "VALID" },
              relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
            },
          ],
          included: [{ type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.0" } }],
        },
      },
    });
    const r = await call(client, "asc_builds", {
      action: "wait_processing",
      app: "com.example.app",
      build_number: "42",
    });
    expect(r.text).toMatch(/Build 42: VALID/);
    expect(r.text).toMatch(/set_encryption_compliance build_id=BU1/);
  });

  it("asc_api GETs directly and requires confirmation for writes", async () => {
    const { client, asc } = await setup({
      "GET /v1/apps/A1/appInfos": { body: { data: [{ type: "appInfos", id: "I1" }] } },
      "PATCH /v1/apps/A1": { body: { data: { type: "apps", id: "A1" } } },
    });
    const g = await call(client, "asc_api", { method: "GET", path: "/v1/apps/A1/appInfos" });
    expect(g.text).toMatch(/→ 200/);
    const args = {
      method: "PATCH",
      path: "/v1/apps/A1",
      body: { data: { type: "apps", id: "A1", attributes: {} } },
    };
    const p = await call(client, "asc_api", args);
    expect(p.data.status).toBe("preview");
    expect(asc.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    await call(client, "asc_api", { ...args, confirm_token: p.data.confirm_token });
    expect(asc.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
});

describe("distribution_checklist", () => {
  it("lists what is missing for an Expo app going to TestFlight", async () => {
    const proj = await mkdtemp(join(tmpdir(), "expo-"));
    await writeFile(
      join(proj, "package.json"),
      JSON.stringify({ name: "ex", dependencies: { expo: "^52.0.0", "react-native": "0.76.0" } }),
    );
    await writeFile(
      join(proj, "app.json"),
      JSON.stringify({ expo: { name: "Ex", ios: { bundleIdentifier: "com.example.ex" } } }),
    );
    const { client } = await setup({
      "GET /v1/apps": (req) => ({
        body: { data: req.query.get("filter[bundleId]") ? [] : [{ type: "apps", id: "A0" }] },
      }),
      "GET /v1/certificates": {
        body: { data: [{ type: "certificates", id: "C1", attributes: { certificateType: "DISTRIBUTION" } }] },
      },
      "GET /v1/bundleIds": { body: { data: [] } },
    });
    const r = await call(client, "distribution_checklist", { target: "testflight-ios", path: proj });
    const items = Object.fromEntries(r.data.items.map((i: any) => [i.id, i]));
    expect(items["api-key"].status).toBe("ok");
    expect(items["bundle-id"]).toMatchObject({ status: "missing" });
    expect(items["bundle-id"].fix).toMatch(
      /asc_bundle_ids action=create bundle_id=com\.example\.ex .*platform=IOS/,
    );
    expect(items["app-record"]).toMatchObject({ status: "missing" });
    expect(items["cert-apple-distribution"].detail).toMatch(/exist in the portal but none is usable/);
    expect(r.data.ready).toBe(false);
  });

  it("compares an Expo string buildNumber and drops the app-record step once the record exists", async () => {
    const proj = await mkdtemp(join(tmpdir(), "expo-"));
    await writeFile(
      join(proj, "package.json"),
      JSON.stringify({ name: "ex", dependencies: { expo: "^52.0.0", "react-native": "0.76.0" } }),
    );
    await writeFile(
      join(proj, "app.json"),
      JSON.stringify({ expo: { name: "Ex", ios: { bundleIdentifier: "com.example.ex", buildNumber: "1" } } }),
    );
    const { client } = await setup({
      "GET /v1/apps": {
        body: { data: [{ type: "apps", id: "A1", attributes: { name: "Ex", bundleId: "com.example.ex" } }] },
      },
      "GET /v1/builds": { body: { data: [{ type: "builds", id: "B1", attributes: { version: "1" } }] } },
      "GET /v1/certificates": { body: { data: [] } },
      "GET /v1/bundleIds": { body: { data: [] } },
    });
    const r = await call(client, "distribution_checklist", { target: "testflight-ios", path: proj });
    const records = r.data.items.filter((i: any) => i.id === "app-record");
    expect(records).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(r.data.items.find((i: any) => i.id === "build-number")).toMatchObject({
      status: "missing",
      detail: "Latest uploaded build: 1; project: 1",
    });
    const manual = r.data.items.filter((i: any) => i.id === "human").map((i: any) => i.detail);
    expect(manual.join("\n")).not.toMatch(/create the app record/i);
  });
});
