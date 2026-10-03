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

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export type FakeRoute = (req: FakeRequest) => { status?: number; body?: unknown } | undefined;

/** Minimal App Store Connect API fake: routes keyed by "METHOD /v1/path" (exact) or a function. */
export function fakeAsc(routes: Record<string, FakeRoute | { status?: number; body?: unknown }>) {
  const requests: FakeRequest[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const req: FakeRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    const route = routes[`${req.method} ${req.path}`];
    const res = typeof route === "function" ? route(req) : route;
    if (!res)
      return jsonResponse(404, {
        errors: [
          { status: "404", code: "NOT_FOUND", title: "Not found", detail: `${req.method} ${req.path}` },
        ],
      });
    return jsonResponse(res.status ?? 200, res.body ?? { data: [] });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

/** Write a real ES256 PKCS#8 key and return ASC env vars pointing at it. */
export async function ascEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  const { generateKeyPair, exportPKCS8 } = await import("jose");
  const { writeFile } = await import("node:fs/promises");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const p = join(dir, "AuthKey_TESTKEY123.p8");
  await writeFile(p, await exportPKCS8(privateKey));
  return {
    ASC_KEY_ID: "TESTKEY123",
    ASC_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
    ASC_PRIVATE_KEY_PATH: p,
  };
}
