import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../tools/types";
import { defaultJobsDir } from "./logs";
import { ToolError } from "./result";

export const contextError = (detail: string) => new ToolError(`Apple platform context: ${detail}`);
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function contextPath(ctx: ToolContext, group: string, key: string): string {
  return join(
    ctx.jobs.stateDir ?? defaultJobsDir(ctx.platform.os, ctx.platform.homeDir),
    "apple-platform-context",
    group,
    `${digest(key)}.json`,
  );
}
export async function readContext<S extends z.ZodType>(
  ctx: ToolContext,
  group: string,
  key: string,
  schema: S,
): Promise<z.infer<S> | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(contextPath(ctx, group, key), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw contextError(
      "cached state is unreadable or has an unsupported schema; inspect or restore it before retrying.",
    );
  }
}
export async function writeContext(ctx: ToolContext, group: string, key: string, value: unknown) {
  const path = contextPath(ctx, group, key);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
export const availabilitySchema = z.object({
  name: z.string(),
  introducedAt: z.string().optional(),
  deprecatedAt: z.string().optional(),
  obsoletedAt: z.string().optional(),
  beta: z.boolean().optional(),
  unavailable: z.boolean().optional(),
});
export const documentSchema = z.object({
  schema: z.literal(1),
  url: z.string(),
  transport_url: z.string(),
  title: z.string(),
  format: z.enum(["docc-json", "markdown"]),
  content: z.string(),
  content_hash: z.string(),
  availability: z.array(availabilitySchema),
  fetched_at: z.string(),
  checked_at: z.string(),
  etag: z.string().optional(),
  last_modified: z.string().optional(),
});
export type AppleDocument = z.infer<typeof documentSchema>;
export function freshness(checkedAt: string, now: Date, hours = 168) {
  const age = now.getTime() - Date.parse(checkedAt);
  return {
    status:
      Number.isFinite(age) && age >= 0 && age <= hours * 3600000
        ? "within_refresh_window"
        : "refresh_required",
    checked_at: checkedAt,
    max_age_hours: hours,
  };
}

/** Restrict both initial requests and redirects to Apple's public documentation service. */
export function canonicalAppleDoc(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw contextError("supply an HTTPS developer.apple.com documentation URL.");
  }
  if (
    u.protocol !== "https:" ||
    u.hostname !== "developer.apple.com" ||
    u.port ||
    u.username ||
    u.password ||
    !/^\/(documentation\/|design\/human-interface-guidelines(?:\/|$))/.test(u.pathname)
  )
    throw contextError(
      "only HTTPS developer.apple.com documentation and Human Interface Guidelines URLs are supported.",
    );
  for (const [key, value] of u.searchParams) {
    if (
      !(
        (key === "language" && value === "swift") ||
        (key === "changes" && /^[a-zA-Z0-9_,.-]{1,100}$/.test(value))
      )
    )
      throw contextError("only language=swift and Apple's changes selectors are supported query parameters.");
  }
  u.hash = "";
  u.pathname = u.pathname.replace(/\.(md|json)$/, "").replace(/\/$/, "");
  u.searchParams.sort();
  return u.toString();
}

async function responseText(response: Response): Promise<string> {
  const maxBytes = 2 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw contextError("documentation response exceeds the 2 MiB limit.");
  const reader = response.body?.getReader();
  if (!reader) throw contextError("documentation response was empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw contextError("documentation response exceeds the 2 MiB limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Normalize DocC content while retaining code and link destinations. No HTML scraping. */
export function normalizeDocC(raw: unknown): {
  title: string;
  content: string;
  availability: z.infer<typeof availabilitySchema>[];
} {
  const root = z
    .object({
      metadata: z
        .object({ title: z.string(), platforms: z.array(availabilitySchema).optional() })
        .passthrough(),
      primaryContentSections: z.array(z.unknown()).optional(),
      abstract: z.array(z.unknown()).optional(),
      topicSections: z.array(z.unknown()).optional(),
      references: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(raw);
  const refs = root.references ?? {};
  const render = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(render).join("");
    if (!value || typeof value !== "object") return "";
    const v = value as Record<string, unknown>;
    if (v.type === "reference" && typeof v.identifier === "string") {
      const r = refs[v.identifier] as { title?: string; url?: string } | undefined;
      return r
        ? `[${r.title ?? v.identifier}](${r.url?.startsWith("/") ? `https://developer.apple.com${r.url}` : (r.url ?? "")})`
        : v.identifier;
    }
    if (v.type === "link") return `[${render(v.inlineContent)}](${String(v.destination ?? "")})`;
    if (typeof v.text === "string") return v.text;
    if (typeof v.code === "string") return `\`${v.code}\``;
    if (Array.isArray(v.code)) return `\n\`\`\`${String(v.syntax ?? "")}\n${v.code.join("\n")}\n\`\`\`\n`;
    return Object.entries(v)
      .filter(([key]) => !["identifier", "type", "kind", "anchor", "syntax", "url"].includes(key))
      .map(([, x]) => render(x))
      .join("\n");
  };
  const links = Object.values(refs).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const ref = r as { title?: string; url?: string };
    return ref.url?.startsWith("/documentation/")
      ? [`[${ref.title ?? ref.url}](https://developer.apple.com${ref.url})`]
      : [];
  });
  const content = [
    `# ${root.metadata.title}`,
    render(root.abstract),
    render(root.primaryContentSections),
    render(root.topicSections),
    ...links,
  ].join("\n\n");
  return { title: root.metadata.title, content, availability: root.metadata.platforms ?? [] };
}

export async function fetchAppleDocument(
  ctx: ToolContext,
  url: string,
  previous?: AppleDocument,
): Promise<AppleDocument> {
  const canonical = canonicalAppleDoc(url);
  const u = new URL(canonical);
  const candidates = u.pathname.startsWith("/documentation/")
    ? [
        new URL(`/tutorials/data${u.pathname}.json${u.search}`, u.origin).toString(),
        `${u.origin}${u.pathname}.md${u.search}`,
      ]
    : [`${u.origin}${u.pathname}.md${u.search}`];
  const now = ctx.now().toISOString();
  try {
    for (const transport_url of candidates) {
      const headers: Record<string, string> = {
        Accept: transport_url.includes(".json") ? "application/json" : "text/markdown",
      };
      if (previous?.transport_url === transport_url) {
        if (previous.etag) headers["If-None-Match"] = previous.etag;
        else if (previous.last_modified) headers["If-Modified-Since"] = previous.last_modified;
      }
      const res = await ctx.fetch(transport_url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 304 && previous?.transport_url === transport_url)
        return { ...previous, checked_at: now };
      if ([404, 406, 415].includes(res.status)) continue;
      if (!res.ok)
        throw contextError(
          `Apple documentation request failed (HTTP ${res.status}); cached evidence was not refreshed.`,
        );
      const text = await responseText(res);
      let normalized: ReturnType<typeof normalizeDocC>;
      const format = transport_url.includes(".json") ? "docc-json" : "markdown";
      if (format === "docc-json") normalized = normalizeDocC(JSON.parse(text));
      else {
        if (/^\s*(?:<!doctype\b|<html\b|<head\b|<body\b)/i.test(text) || !/^#\s+.+/m.test(text))
          throw contextError(
            "Apple returned an unsupported document format; cached evidence was not refreshed.",
          );
        normalized = { title: /^#\s+(.+)$/m.exec(text)![1], content: text, availability: [] };
      }
      return {
        schema: 1,
        url: canonical,
        transport_url,
        format,
        ...normalized,
        content_hash: digest(normalized),
        fetched_at: now,
        checked_at: now,
        etag: res.headers.get("etag") ?? undefined,
        last_modified: res.headers.get("last-modified") ?? undefined,
      };
    }
    throw contextError(
      "Apple provides no supported JSON or Markdown document at this URL; use another official source or the host agent's documentation tools.",
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw contextError(
      "documentation retrieval or parsing failed; cached evidence was not refreshed. Check the URL, network and Apple document format.",
    );
  }
}
