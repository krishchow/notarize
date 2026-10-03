import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext } from "../src/context";
import { ConfigStore } from "../src/core/config";
import { ConfirmManager } from "../src/core/confirm";
import { FakeRunner } from "../src/core/fake-runner";
import { createServer } from "../src/server";
import type { ToolContext } from "../src/tools/types";
// Shared test helpers.

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export async function makeCtx(
  opts: {
    runner?: FakeRunner;
    isMac?: boolean;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: Date;
  } = {},
): Promise<{ ctx: ToolContext; runner: FakeRunner; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "notarize-home-"));
  const runner = opts.runner ?? new FakeRunner();
  const isMac = opts.isMac ?? true;
  const ctx = createContext({
    runner,
    platform: { os: isMac ? "darwin" : "linux", isMac, homeDir: home },
    config: new ConfigStore(home, opts.env ?? {}, join(home, ".config", "notarize-mcp")),
    confirm: new ConfirmManager({ autoConfirm: false }),
    fetch: opts.fetch,
    now: opts.now ? () => opts.now! : undefined,
  });
  return { ctx, runner, home };
}

export async function connect(ctx: ToolContext): Promise<Client> {
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

export interface CallResult {
  text: string;
  data: any;
  isError: boolean;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const r: any = await client.callTool({ name, arguments: args });
  return {
    text: (r.content ?? []).map((c: any) => c.text ?? "").join("\n"),
    data: r.structuredContent,
    isError: !!r.isError,
  };
}

/** Call a mutating tool twice: preview, then confirm with the issued token. */
export async function callConfirmed(client: Client, name: string, args: Record<string, unknown>) {
  const preview = await call(client, name, args);
  if (preview.data?.status !== "preview") throw new Error(`expected preview, got: ${preview.text}`);
  return {
    preview,
    result: await call(client, name, { ...args, confirm_token: preview.data.confirm_token }),
  };
}
