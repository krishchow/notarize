import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { memoryStore } from "mcp-feedback";
import { createIngestHandler, generateKeyPair, toNodeListener } from "mcp-feedback/ingest";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { defaultConfigDir } from "../src/core/config";
import { FakeRunner } from "../src/core/fake-runner";
import { feedbackFromEnv } from "../src/core/feedback";
import { connect, makeCtx } from "./helpers";

const report = (overrides: Record<string, unknown> = {}) => ({
  kind: "tool_failure",
  severity: "major",
  title: "notarize_and_staple detached and the job never finished",
  body: "The job stayed running for an hour.",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent feedback", () => {
  it("offers no submit_feedback, and says nothing about it, when feedback is off", async () => {
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("submit_feedback");
    expect(client.getInstructions()).not.toContain("submit_feedback");
  });

  it("offers submit_feedback when a hub is configured, naming where reports go", async () => {
    const { ctx } = await makeCtx({
      feedback: { sink: memoryStore(), destination: "the feedback service at hub.test" },
    });
    const client = await connect(ctx);
    const submit = (await client.listTools()).tools.find((t) => t.name === "submit_feedback");
    expect(submit?.description).toContain("the feedback service at hub.test");
    expect(client.getInstructions()).toContain("submit_feedback");
    expect(client.getInstructions()).toContain("not TestFlight tester feedback");
  });

  it("takes secrets and the home directory out of what the agent wrote, and adds versions and the job's state", async () => {
    const store = memoryStore();
    const runner = new FakeRunner()
      .on("sw_vers", ["-productVersion"], { stdout: "26.1\n" })
      .on("xcodebuild", ["-version"], { stdout: "Xcode 27.0\nBuild version 27A123\n" });
    const { ctx, home } = await makeCtx({
      runner,
      feedback: { sink: store, destination: "the feedback service at hub.test" },
    });
    const job = await ctx.jobs.runWithDeadline(
      "notarize",
      `Notarize ${home}/Secret Project/MyApp.app`,
      1000,
      async () => "ok",
    );
    const client = await connect(ctx);

    const result = await client.callTool({
      name: "submit_feedback",
      arguments: report({
        body: `Submitted ${home}/Secret Project/MyApp.app with password abcd-efgh-ijkl-mnop.\n-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMG\n-----END PRIVATE KEY-----`,
        context: {
          references: { jobId: job.jobId, submissionId: "2b9c-submission" },
          goal: `Ship ${home}/Secret Project`,
        },
      }),
    });
    expect(result.isError).toBeFalsy();

    const [record] = (await store.list({ limit: 10 })).items;
    expect(record!.body).toContain("~/Secret Project/MyApp.app");
    expect(record!.body).not.toContain(home);
    expect(record!.body).not.toContain("abcd-efgh-ijkl-mnop");
    expect(record!.body).not.toContain("MIGTAgEAMBMG");
    expect(record!.context.goal).toBe("Ship ~/Secret Project");
    expect(record!.context.references).toEqual({ jobId: job.jobId, submissionId: "2b9c-submission" });
    expect(record!.context.server_context).toMatchObject({
      version: pkg.version,
      os: "darwin",
      macos: "26.1",
      xcode: "27.0",
      job: { name: "notarize", status: "succeeded", failed: false },
    });
    // The job's description holds a path; it is not added.
    expect(JSON.stringify(record!.context.server_context)).not.toContain("Secret Project");
  });

  it("reports an unknown job as not found, and leaves out macOS tools it cannot run", async () => {
    const store = memoryStore();
    const { ctx } = await makeCtx({
      feedback: { sink: store, destination: "the feedback service at hub.test" },
    });
    const client = await connect(ctx);
    await client.callTool({
      name: "submit_feedback",
      arguments: report({ context: { references: { jobId: "nope" } } }),
    });
    const [record] = (await store.list({ limit: 10 })).items;
    expect(record!.context.server_context).toMatchObject({ macos: null, xcode: null, job: { found: false } });
  });
});

describe("feedbackFromEnv", () => {
  it("is off unless NOTARIZE_MCP_FEEDBACK_ENDPOINT names a hub, and when MCP_FEEDBACK_DISABLED is set", () => {
    expect(feedbackFromEnv("/home/u", {})).toBeUndefined();
    expect(feedbackFromEnv("/home/u", { NOTARIZE_MCP_FEEDBACK_ENDPOINT: "  " })).toBeUndefined();
    expect(
      feedbackFromEnv("/home/u", {
        NOTARIZE_MCP_FEEDBACK_ENDPOINT: "https://hub.example.com",
        MCP_FEEDBACK_DISABLED: "1",
      }),
    ).toBeUndefined();
  });

  it("turns feedback off, without throwing, for an endpoint it cannot use", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      feedbackFromEnv("/home/u", { NOTARIZE_MCP_FEEDBACK_ENDPOINT: "http://hub.example.com" }),
    ).toBeUndefined();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("https");
  });

  it("keeps its state in the config directory and names the hub's host", () => {
    const channel = feedbackFromEnv("/home/u", {
      NOTARIZE_MCP_FEEDBACK_ENDPOINT: "https://hub.example.com/api/ingest",
    });
    expect(channel?.destination).toBe("the feedback service at hub.example.com");
    expect((channel!.sink as { stateDir?: string }).stateDir).toBe(
      join(defaultConfigDir("/home/u"), "feedback"),
    );
  });

  it("delivers to a hub under the notarize project, with no project key", async () => {
    const key = generateKeyPair("k1");
    const hubStore = memoryStore();
    const handler = createIngestHandler({
      issuer: "http://127.0.0.1",
      keyring: {
        keys: [{ kid: key.kid, publicKey: key.publicKey }],
        signer: { kid: key.kid, privateKey: key.privateKey },
      },
      store: hubStore,
      openEnrollment: true,
    });
    const http = createHttpServer(toNodeListener(handler));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { home } = await makeCtx();
      const endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const channel = feedbackFromEnv(home, {
        NOTARIZE_MCP_FEEDBACK_ENDPOINT: endpoint,
        NOTARIZE_MCP_CONFIG_DIR: join(home, "config"),
      });
      const { ctx } = await makeCtx({ feedback: channel });
      const client = await connect(ctx);
      const result = await client.callTool({ name: "submit_feedback", arguments: report() });
      expect(result.isError).toBeFalsy();
      const [record] = (await hubStore.list({ limit: 10 })).items;
      expect(record).toMatchObject({
        server: { name: "notarize" },
        identity: { scopes: ["ingest:install"] },
      });
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});
