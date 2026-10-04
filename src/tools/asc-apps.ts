import { z } from "zod";
import type { AscResource } from "../asc/client";
import { FOREGROUND_SECONDS } from "../core/jobs";
import { ToolError } from "../core/result";
import { resolveAppId, slimResource, table } from "./asc-common";
import { detachedOutput } from "./detached";
import { defineTool, profileArg, withConfirmation } from "./types";

export const ascAppsTool = defineTool({
  name: "asc_apps",
  title: "App Store Connect app records",
  description:
    "action=list / get / find_by_bundle_id: app records (name, bundle ID, SKU, primary locale, Apple ID). App records CANNOT be created through the API — action=create_instructions returns the exact web steps and values to enter (bundle ID must already be registered with asc_bundle_ids).",
  input: {
    action: z.enum(["list", "get", "find_by_bundle_id", "create_instructions"]),
    app_id: z.string().optional(),
    bundle_id: z.string().optional(),
    name: z
      .string()
      .optional()
      .describe("create_instructions: intended app name (must be unique on the App Store)."),
    platform: z.enum(["iOS", "macOS", "tvOS", "visionOS"]).optional(),
    profile: profileArg,
  },
  async handler(args, ctx) {
    if (args.action === "create_instructions") {
      return {
        summary: [
          "Create the app record in App Store Connect (cannot be automated via the API):",
          "1. Open https://appstoreconnect.apple.com/apps and click + → New App.",
          `2. Platforms: ${args.platform ?? "the platform(s) you ship"}.`,
          `3. Name: ${args.name ?? "<your app name>"} (max 30 chars, must be unique on the store).`,
          "4. Primary Language: the default listing language.",
          `5. Bundle ID: choose ${args.bundle_id ?? "<your bundle id>"} from the dropdown (register it first with asc_bundle_ids action=create if it is missing).`,
          "6. SKU: any internal unique string (e.g. the bundle ID).",
          "7. User Access: Full Access (or limit to specific users).",
          "Then: asc_apps action=find_by_bundle_id to get the app's id.",
        ].join("\n"),
        data: { manual: true, url: "https://appstoreconnect.apple.com/apps" },
      };
    }
    const client = await ctx.asc(args.profile);
    if (args.action === "list") {
      const res = await client.list("apps", { "fields[apps]": "name,bundleId,sku,primaryLocale" }, 200);
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length ? table(rows, ["name", "bundleId", "sku", "id"]) : "No app records.",
        data: { apps: rows },
      };
    }
    const key = args.app_id ?? args.bundle_id;
    if (!key) throw new ToolError("app_id or bundle_id is required.");
    const { app } = await resolveAppId(client, key);
    return {
      summary: `${app.attributes?.name} — ${app.attributes?.bundleId} (app id ${app.id}, SKU ${app.attributes?.sku})`,
      data: { app: slimResource(app) },
    };
  },
});

const TERMINAL = new Set(["VALID", "FAILED", "INVALID"]);

export const ascBuildsTool = defineTool({
  name: "asc_builds",
  title: "Uploaded builds and processing status",
  description:
    "action=list: recent builds for an app (version, build number, processing state, expiry). action=get. action=wait_processing: after an upload, poll until the build appears and reaches VALID (usable for TestFlight / review) or FAILED/INVALID — typically 5–30 min; continues as a background job with a Monitor command. action=set_encryption_compliance (confirm): answer the export-compliance question (usesNonExemptEncryption) so the build becomes testable — or add ITSAppUsesNonExemptEncryption to Info.plist to skip this forever. action=expire (confirm).",
  mutating: true,
  input: {
    action: z.enum(["list", "get", "wait_processing", "set_encryption_compliance", "expire"]),
    app: z.string().optional().describe("App id or bundle ID."),
    build_id: z.string().optional(),
    build_number: z.string().optional().describe("CFBundleVersion (wait_processing / list filter)."),
    version: z.string().optional().describe("CFBundleShortVersionString (list filter)."),
    uses_non_exempt_encryption: z
      .boolean()
      .optional()
      .describe(
        "set_encryption_compliance: true only if you use non-exempt encryption (HTTPS/standard OS crypto is exempt).",
      ),
    limit: z.number().int().min(1).max(200).optional(),
    wait_minutes: z
      .number()
      .int()
      .min(1)
      .max(240)
      .optional()
      .describe("wait_processing: overall wait (default 60)."),
    max_wait_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("wait_processing: foreground wait before handing off to a background job (default 90)."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    const listBuilds = async (appId: string, buildNumber?: string, version?: string, limit = 20) =>
      client.list(
        "builds",
        {
          "filter[app]": appId,
          "filter[version]": buildNumber,
          "filter[preReleaseVersion.version]": version,
          sort: "-uploadedDate",
          include: "preReleaseVersion",
          "fields[builds]":
            "version,uploadedDate,expirationDate,expired,minOsVersion,processingState,usesNonExemptEncryption,preReleaseVersion",
        },
        limit,
      );
    const rowsOf = (res: Awaited<ReturnType<typeof listBuilds>>) => {
      const versions = new Map(
        res.included.filter((i) => i.type === "preReleaseVersions").map((i) => [i.id, i.attributes?.version]),
      );
      return res.data.map((b) => {
        const pre = b.relationships?.preReleaseVersion?.data as { id: string } | undefined;
        return {
          ...slimResource(b),
          marketingVersion: pre ? versions.get(pre.id) : undefined,
          buildNumber: b.attributes?.version,
        };
      });
    };

    if (args.action === "list") {
      if (!args.app) throw new ToolError("app is required.");
      const { id } = await resolveAppId(client, args.app);
      const rows = rowsOf(await listBuilds(id, args.build_number, args.version, args.limit ?? 20));
      return {
        summary: rows.length
          ? table(rows, ["marketingVersion", "buildNumber", "processingState", "uploadedDate", "id"])
          : "No builds uploaded yet.",
        data: { builds: rows, latestBuildNumber: rows[0]?.buildNumber },
      };
    }

    if (args.action === "wait_processing") {
      if (!args.app || !args.build_number) throw new ToolError("app and build_number are required.");
      const { id: appId } = await resolveAppId(client, args.app);
      const job = await ctx.jobs.runWithDeadline(
        "build-processing",
        `Processing of build ${args.build_number}`,
        (args.max_wait_seconds ?? FOREGROUND_SECONDS) * 1000,
        async (j) => {
          const deadline = Date.now() + (args.wait_minutes ?? 60) * 60000;
          let state = "NOT_VISIBLE_YET";
          let build: Record<string, unknown> | undefined;
          while (Date.now() < deadline && !j.signal.aborted) {
            const rows = rowsOf(await listBuilds(appId, args.build_number, undefined, 5));
            build = rows[0];
            state = String(build?.processingState ?? "NOT_VISIBLE_YET");
            j.progress(`Build ${args.build_number}: ${state}`);
            if (build) j.setMeta("buildId", build.id);
            if (TERMINAL.has(state)) break;
            await new Promise((r) => setTimeout(r, 30000));
          }
          const ok = state === "VALID";
          return {
            summary: `Build ${args.build_number}: ${state}.${ok ? "" : state === "NOT_VISIBLE_YET" || state === "PROCESSING" ? " Still processing — check again later." : " Processing failed — check the email from App Store Connect for ITMS errors."}`,
            data: { build, state },
            next_steps: ok
              ? [
                  build?.usesNonExemptEncryption === undefined || build?.usesNonExemptEncryption === null
                    ? `asc_builds action=set_encryption_compliance build_id=${build?.id} uses_non_exempt_encryption=false (if you only use HTTPS/OS crypto)`
                    : "testflight action=add_build_to_group",
                  "app_store action=attach_build to submit this build for review",
                ]
              : [],
            isError: state === "FAILED" || state === "INVALID",
          };
        },
      );
      if (!job.done)
        return detachedOutput(ctx, job.jobId, `App Store Connect processing of build ${args.build_number}`, [
          "Uploads typically take 5–30 minutes to process.",
        ]);
      return job.value;
    }

    if (!args.build_id) throw new ToolError("build_id is required.");
    if (args.action === "get") {
      const b = (await client.get<AscResource>(`builds/${args.build_id}`, { include: "buildBetaDetail" }))
        .data;
      return {
        summary: `Build ${b.attributes?.version}: ${b.attributes?.processingState}${b.attributes?.expired ? " (expired)" : ""}`,
        data: { build: slimResource(b) },
      };
    }
    if (args.action === "set_encryption_compliance") {
      if (args.uses_non_exempt_encryption === undefined)
        throw new ToolError("uses_non_exempt_encryption is required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Set export compliance on build ${args.build_id}: usesNonExemptEncryption=${args.uses_non_exempt_encryption}`,
          steps: [{ description: `PATCH /v1/builds/${args.build_id}` }],
          notes: [
            "Exempt (false) covers apps that only use HTTPS/TLS and Apple's OS crypto APIs. Proprietary or non-standard encryption may require documentation (true).",
            "Tip: set ITSAppUsesNonExemptEncryption in Info.plist so future builds don't need this step.",
          ],
        }),
        async () => {
          await client.patch(`builds/${args.build_id}`, {
            data: {
              type: "builds",
              id: args.build_id,
              attributes: { usesNonExemptEncryption: args.uses_non_exempt_encryption },
            },
          });
          return {
            summary: "Export compliance set.",
            data: { ok: true },
            next_steps: ["testflight action=add_build_to_group"],
          };
        },
      );
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Expire build ${args.build_id}`,
        steps: [{ description: `PATCH /v1/builds/${args.build_id} expired=true` }],
        destructive: true,
        warnings: ["Testers can no longer install this build. Cannot be undone."],
      }),
      async () => {
        await client.patch(`builds/${args.build_id}`, {
          data: { type: "builds", id: args.build_id, attributes: { expired: true } },
        });
        return { summary: "Build expired.", data: { ok: true } };
      },
    );
  },
});

export const ascApiTool = defineTool({
  name: "asc_api",
  title: "Raw App Store Connect API request (escape hatch)",
  description:
    "Call any App Store Connect API endpoint not covered by other tools (pricing, screenshots, in-app purchases, Xcode Cloud, analytics, users…). path is relative to https://api.appstoreconnect.apple.com (e.g. /v1/apps/123/appInfos, /v2/inAppPurchases). GET runs directly (follows pagination when paginate=true); POST/PATCH/DELETE require confirmation. See https://developer.apple.com/documentation/appstoreconnectapi for payload shapes.",
  mutating: true,
  input: {
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    path: z.string().describe("e.g. /v1/apps or /v1/apps/{id}/appStoreVersions"),
    query: z
      .record(z.string(), z.string())
      .optional()
      .describe('Query params, e.g. {"filter[platform]": "IOS", "include": "build"}'),
    body: z.record(z.string(), z.any()).optional().describe("JSON:API body for POST/PATCH/DELETE."),
    paginate: z.boolean().optional().describe("GET: follow links.next (up to max_items)."),
    max_items: z.number().int().min(1).max(2000).optional(),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    if (!args.path.startsWith("/")) throw new ToolError("path must start with /, e.g. /v1/apps");
    if (args.method === "GET") {
      if (args.paginate) {
        const res = await client.list(args.path, args.query ?? {}, args.max_items ?? 200);
        return {
          summary: `${res.data.length} item(s)${res.truncated ? " (truncated)" : ""} from GET ${args.path}`,
          data: {
            data: res.data.map(slimResource),
            included: res.included.map(slimResource),
            total: res.total,
          },
        };
      }
      const r = await client.request<unknown>("GET", args.path, { query: args.query });
      return {
        summary: `GET ${args.path} → ${r.status}`,
        data: { status: r.status, body: r.body as Record<string, unknown> },
      };
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `${args.method} ${args.path}`,
        steps: [
          {
            description: `${args.method} https://api.appstoreconnect.apple.com${args.path}`,
            command: args.body ? JSON.stringify(args.body).slice(0, 2000) : undefined,
          },
        ],
        destructive: true,
        warnings: ["Raw API calls change your App Store Connect account directly."],
      }),
      async () => {
        const r = await client.request<unknown>(args.method, args.path, {
          query: args.query,
          body: args.body,
        });
        return {
          summary: `${args.method} ${args.path} → ${r.status}`,
          data: { status: r.status, body: (r.body as Record<string, unknown>) ?? null },
        };
      },
    );
  },
});
