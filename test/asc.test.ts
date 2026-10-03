import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ASC_AUDIENCE, AscTokenProvider } from "../src/asc/auth";
import { AscApiError, AscClient, parseRateLimit } from "../src/asc/client";
import { jsonResponse } from "./helpers";

async function testKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { pem: await exportPKCS8(privateKey), publicKey };
}

describe("ASC JWT", () => {
  it("creates team-key tokens with iss/aud/exp ≤ 20 min and kid header", async () => {
    const { pem, publicKey } = await testKey();
    const tp = new AscTokenProvider({ keyId: "KEY1234567", issuerId: "issuer-uuid", privateKeyPem: pem });
    const token = await tp.token();
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, { audience: ASC_AUDIENCE });
    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(payload.iss).toBe("issuer-uuid");
    expect(payload.sub).toBeUndefined();
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(1200);
    expect(await tp.token()).toBe(token); // cached
  });

  it("uses sub=user for individual keys", async () => {
    const { pem, publicKey } = await testKey();
    const tp = new AscTokenProvider({ keyId: "KEY1234567", privateKeyPem: pem });
    const { payload } = await jwtVerify(await tp.token(), publicKey);
    expect(payload.sub).toBe("user");
    expect(payload.iss).toBeUndefined();
  });

  it("rejects non-PKCS8 keys with a helpful error", async () => {
    const tp = new AscTokenProvider({ keyId: "K", issuerId: "i", privateKeyPem: "not a key" });
    await expect(tp.token()).rejects.toThrow(/PKCS#8/);
  });
});

describe("ASC client", () => {
  it("follows pagination links and tracks the rate limit header", async () => {
    const { pem } = await testKey();
    const seen: string[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toMatch(/^Bearer ey/);
      if (url.includes("cursor=2")) {
        return jsonResponse(200, { data: [{ type: "bundleIds", id: "2" }], links: {} });
      }
      return jsonResponse(
        200,
        {
          data: [{ type: "bundleIds", id: "1", attributes: { identifier: "com.x" } }],
          links: { next: "https://api.appstoreconnect.apple.com/v1/bundleIds?cursor=2" },
          meta: { paging: { total: 2, limit: 1 } },
        },
        { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3599;" },
      );
    }) as typeof fetch;
    const client = new AscClient({
      tokens: new AscTokenProvider({ keyId: "K", issuerId: "i", privateKeyPem: pem }),
      fetch: fetchStub,
    });
    const res = await client.list("bundleIds", { "filter[platform]": "MAC_OS" });
    expect(res.data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(res.total).toBe(2);
    expect(seen[0]).toContain("/v1/bundleIds?");
    expect(seen[0]).toContain("filter%5Bplatform%5D=MAC_OS");
    expect(client.lastRateLimit).toEqual({ limit: 3600, remaining: 3599 });
  });

  it("maps 403 agreement errors and 409 conflicts to actionable hints", async () => {
    const { pem } = await testKey();
    const make = (status: number, detail: string) =>
      new AscClient({
        tokens: new AscTokenProvider({ keyId: "K", issuerId: "i", privateKeyPem: pem }),
        fetch: (async () =>
          jsonResponse(status, {
            errors: [{ status: String(status), code: "X", title: "T", detail }],
          })) as any,
        sleep: async () => {},
      });
    const e403 = await make(403, "A required agreement is missing or has expired.")
      .get("apps")
      .catch((e) => e);
    expect(e403).toBeInstanceOf(AscApiError);
    expect(e403.details.hint).toMatch(/agreement/);
    const e409 = await make(409, "An attribute value is not acceptable. The bundle ID already exists.")
      .post("bundleIds", {})
      .catch((e) => e);
    expect(e409.details.hint).toMatch(/already exists/);
  });

  it("retries 429/5xx then succeeds", async () => {
    const { pem } = await testKey();
    let n = 0;
    const client = new AscClient({
      tokens: new AscTokenProvider({ keyId: "K", issuerId: "i", privateKeyPem: pem }),
      fetch: (async () => (++n < 2 ? jsonResponse(503, {}) : jsonResponse(200, { data: [] }))) as any,
      sleep: async () => {},
    });
    await client.get("apps");
    expect(n).toBe(2);
  });

  it("parses rate limit headers", () => {
    expect(parseRateLimit("user-hour-lim:3500;user-hour-rem:10;")).toEqual({ limit: 3500, remaining: 10 });
    expect(parseRateLimit(null)).toBeUndefined();
  });
});
