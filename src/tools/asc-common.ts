import { AscTokenProvider } from "../asc/auth";
import { AscClient, type AscResource } from "../asc/client";
import { ToolError } from "../core/result";
import type { ToolContext } from "./types";

/** Strip large base64 payloads from resources before returning them. */
export function slimResource(r: AscResource): Record<string, unknown> {
  const attrs = { ...(r.attributes ?? {}) } as Record<string, unknown>;
  for (const k of ["certificateContent", "profileContent", "csrContent"]) {
    if (typeof attrs[k] === "string") attrs[k] = `<${(attrs[k] as string).length} base64 chars>`;
  }
  return { id: r.id, type: r.type, ...attrs };
}

export function clientFromKey(
  ctx: ToolContext,
  keyId: string,
  issuerId: string | undefined,
  pem: string,
): AscClient {
  return new AscClient({
    tokens: new AscTokenProvider({ keyId, issuerId, privateKeyPem: pem }),
    fetch: ctx.fetch,
  });
}

/** Accept either an App Store Connect resource id or a bundle identifier (com.example.app). */
export async function resolveBundleIdResource(
  client: AscClient,
  idOrIdentifier: string,
): Promise<AscResource> {
  if (!idOrIdentifier.includes(".")) {
    return (await client.get<AscResource>(`bundleIds/${idOrIdentifier}`)).data;
  }
  const res = await client.list("bundleIds", { "filter[identifier]": idOrIdentifier }, 50);
  const exact = res.data.find((b) => b.attributes?.identifier === idOrIdentifier);
  if (!exact)
    throw new ToolError(`Bundle ID ${idOrIdentifier} is not registered for this team.`, {
      hint: "Register it with asc_bundle_ids action=create (identifiers are globally unique across all Apple teams).",
    });
  return exact;
}

export async function resolveAppId(
  client: AscClient,
  appIdOrBundleId: string,
): Promise<{ id: string; app: AscResource }> {
  if (/^\d+$/.test(appIdOrBundleId)) {
    const app = (await client.get<AscResource>(`apps/${appIdOrBundleId}`)).data;
    return { id: app.id, app };
  }
  const res = await client.list("apps", { "filter[bundleId]": appIdOrBundleId }, 10);
  const app = res.data.find((a) => a.attributes?.bundleId === appIdOrBundleId);
  if (!app)
    throw new ToolError(`No App Store Connect app record for ${appIdOrBundleId}.`, {
      hint: "App records cannot be created through the API. Create it at https://appstoreconnect.apple.com/apps → + → New App (platform, name, primary language, bundle ID, SKU).",
      next_steps: ["asc_apps action=create_instructions bundle_id=<…>"],
    });
  return { id: app.id, app };
}

export function table(rows: Record<string, unknown>[], cols: string[]): string {
  return rows
    .map(
      (r) =>
        `• ${cols
          .map((c) => (r[c] === undefined || r[c] === null ? "" : String(r[c])))
          .filter(Boolean)
          .join("  ")}`,
    )
    .join("\n");
}

export const PLATFORMS = ["IOS", "MAC_OS", "UNIVERSAL"] as const;
