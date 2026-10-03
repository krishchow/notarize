import { z } from "zod";
import { type AscResource, rel, relMany } from "../asc/client";
import { ToolError } from "../core/result";
import { resolveAppId, slimResource, table } from "./asc-common";
import { defineTool, profileArg, withConfirmation } from "./types";

// ------------------------------------------------------------------ TestFlight

export const testflightTool = defineTool({
  name: "testflight",
  title: "TestFlight: groups, testers, builds, beta review",
  description:
    "action=groups / testers / status (internal + external beta state of a build). action=create_group (confirm): internal (App Store Connect users, no review) or external (anyone by email or public link; first build of each version needs beta app review). action=add_testers / remove_testers (confirm): invite by email to a group. action=add_build_to_group (confirm). action=set_what_to_test (confirm): 'What to Test' notes for a build. action=submit_beta_review (confirm): submit a build for external testing review (requires beta review contact info set once in App Store Connect → TestFlight → Test Information). Builds must be VALID and have export compliance answered (asc_builds).",
  mutating: true,
  input: {
    action: z.enum([
      "groups",
      "testers",
      "status",
      "create_group",
      "add_testers",
      "remove_testers",
      "add_build_to_group",
      "set_what_to_test",
      "submit_beta_review",
    ]),
    app: z.string().optional().describe("App id or bundle ID."),
    group_id: z.string().optional(),
    group_name: z.string().optional().describe("create_group: name."),
    internal: z.boolean().optional().describe("create_group: internal group (default false = external)."),
    public_link: z
      .boolean()
      .optional()
      .describe("create_group: enable a public TestFlight link (external groups)."),
    testers: z
      .array(
        z.object({ email: z.string(), first_name: z.string().optional(), last_name: z.string().optional() }),
      )
      .optional(),
    build_id: z.string().optional(),
    what_to_test: z.string().optional(),
    locale: z.string().optional().describe("set_what_to_test: default en-US."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);

    if (args.action === "status") {
      if (!args.build_id) throw new ToolError("build_id is required.");
      const d = (await client.get<AscResource>(`builds/${args.build_id}/buildBetaDetail`)).data;
      return {
        summary: `Build ${args.build_id}: internal=${d.attributes?.internalBuildState} external=${d.attributes?.externalBuildState}`,
        data: { betaDetail: slimResource(d) },
      };
    }
    if (args.action === "add_build_to_group") {
      if (!args.group_id || !args.build_id) throw new ToolError("group_id and build_id are required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Add build ${args.build_id} to group ${args.group_id}`,
          steps: [{ description: `POST /v1/betaGroups/${args.group_id}/relationships/builds` }],
          notes: ["External groups only see it after beta app review approval."],
        }),
        async () => {
          await client.post(
            `betaGroups/${args.group_id}/relationships/builds`,
            relMany("builds", [args.build_id!]),
          );
          return {
            summary: "Build added to group.",
            data: { ok: true },
            next_steps: ["testflight action=submit_beta_review (external groups)"],
          };
        },
      );
    }
    if (args.action === "set_what_to_test") {
      if (!args.build_id || !args.what_to_test)
        throw new ToolError("build_id and what_to_test are required.");
      const locale = args.locale ?? "en-US";
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Set What to Test (${locale}) for build ${args.build_id}`,
          steps: [{ description: "PATCH or POST betaBuildLocalizations" }],
          notes: [args.what_to_test!],
        }),
        async () => {
          const locs = await client.list(`builds/${args.build_id}/betaBuildLocalizations`, {}, 50);
          const existing = locs.data.find((l) => l.attributes?.locale === locale);
          if (existing)
            await client.patch(`betaBuildLocalizations/${existing.id}`, {
              data: {
                type: "betaBuildLocalizations",
                id: existing.id,
                attributes: { whatsNew: args.what_to_test },
              },
            });
          else
            await client.post("betaBuildLocalizations", {
              data: {
                type: "betaBuildLocalizations",
                attributes: { locale, whatsNew: args.what_to_test },
                relationships: { build: rel("builds", args.build_id!) },
              },
            });
          return { summary: "What to Test updated.", data: { ok: true } };
        },
      );
    }
    if (args.action === "submit_beta_review") {
      if (!args.build_id) throw new ToolError("build_id is required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Submit build ${args.build_id} for TestFlight beta review`,
          steps: [{ description: "POST /v1/betaAppReviewSubmissions" }],
          destructive: true,
          notes: [
            "Review usually takes under 48 hours; later builds of the same version are often auto-approved.",
          ],
        }),
        async () => {
          const r = await client.post("betaAppReviewSubmissions", {
            data: {
              type: "betaAppReviewSubmissions",
              relationships: { build: rel("builds", args.build_id!) },
            },
          });
          return {
            summary: `Submitted for beta review (${r.data.attributes?.betaReviewState ?? "WAITING_FOR_REVIEW"}).`,
            data: { submission: slimResource(r.data) },
          };
        },
      );
    }
    if (args.action === "remove_testers") {
      if (!args.group_id || !args.testers?.length) throw new ToolError("group_id and testers are required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Remove ${args.testers!.length} tester(s) from group ${args.group_id}`,
          steps: args.testers!.map((t) => ({ description: `Remove ${t.email}` })),
        }),
        async () => {
          const ids: string[] = [];
          for (const t of args.testers!) {
            const found = await client.list("betaTesters", { "filter[email]": t.email }, 5);
            if (found.data[0]) ids.push(found.data[0].id);
          }
          if (ids.length)
            await client.delete(
              `betaGroups/${args.group_id}/relationships/betaTesters`,
              relMany("betaTesters", ids),
            );
          return { summary: `Removed ${ids.length} tester(s).`, data: { removed: ids.length } };
        },
      );
    }
    if (args.action === "add_testers") {
      if (!args.group_id || !args.testers?.length) throw new ToolError("group_id and testers are required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Invite ${args.testers!.length} tester(s) to group ${args.group_id}`,
          steps: args.testers!.map((t) => ({ description: `Invite ${t.email}` })),
          notes: ["Testers receive an email invitation from TestFlight."],
        }),
        async () => {
          const results: { email: string; status: string }[] = [];
          for (const t of args.testers!) {
            try {
              await client.post("betaTesters", {
                data: {
                  type: "betaTesters",
                  attributes: { email: t.email, firstName: t.first_name, lastName: t.last_name },
                  relationships: { betaGroups: relMany("betaGroups", [args.group_id!]) },
                },
              });
              results.push({ email: t.email, status: "invited" });
            } catch (e) {
              if ((e as { status?: number }).status === 409) {
                const found = await client.list("betaTesters", { "filter[email]": t.email }, 5);
                if (found.data[0]) {
                  await client.post(
                    `betaGroups/${args.group_id}/relationships/betaTesters`,
                    relMany("betaTesters", [found.data[0].id]),
                  );
                  results.push({ email: t.email, status: "existing tester added to group" });
                  continue;
                }
              }
              results.push({ email: t.email, status: `failed: ${(e as Error).message}` });
            }
          }
          return { summary: results.map((r) => `• ${r.email}: ${r.status}`).join("\n"), data: { results } };
        },
      );
    }

    if (!args.app) throw new ToolError("app is required.");
    const { id: appId } = await resolveAppId(client, args.app);
    if (args.action === "groups") {
      const res = await client.list(`apps/${appId}/betaGroups`, {}, 100);
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length
          ? table(rows, ["name", "isInternalGroup", "publicLinkEnabled", "publicLink", "id"])
          : "No beta groups.",
        data: { groups: rows },
      };
    }
    if (args.action === "testers") {
      const res = args.group_id
        ? await client.list(`betaGroups/${args.group_id}/betaTesters`, {}, 500)
        : await client.list("betaTesters", { "filter[apps]": appId }, 500);
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length
          ? table(rows, ["email", "firstName", "lastName", "inviteType", "id"])
          : "No testers.",
        data: { testers: rows },
      };
    }
    // create_group
    if (!args.group_name) throw new ToolError("group_name is required.");
    const attrs: Record<string, unknown> = { name: args.group_name };
    if (args.internal) attrs.isInternalGroup = true;
    if (args.public_link) attrs.publicLinkEnabled = true;
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Create ${args.internal ? "internal" : "external"} TestFlight group "${args.group_name}"`,
        steps: [{ description: "POST /v1/betaGroups", command: JSON.stringify(attrs) }],
      }),
      async () => {
        const r = await client.post("betaGroups", {
          data: { type: "betaGroups", attributes: attrs, relationships: { app: rel("apps", appId) } },
        });
        return {
          summary: `Created group "${args.group_name}" (${r.data.id}).${r.data.attributes?.publicLink ? ` Public link: ${r.data.attributes.publicLink}` : ""}`,
          data: { group: slimResource(r.data) },
        };
      },
    );
  },
});

// ------------------------------------------------------------------ App Store

const ASC_PLATFORM = { iOS: "IOS", macOS: "MAC_OS", tvOS: "TV_OS", visionOS: "VISION_OS" } as const;

export const appStoreTool = defineTool({
  name: "app_store",
  title: "App Store versions, metadata, review submission and release",
  description:
    "action=versions: App Store versions and their states. action=create_version (confirm). action=attach_build (confirm): select the processed build for a version. action=localizations / update_localization (confirm): description, keywords, What's New, promotional text, support/marketing URLs per locale. action=submit_for_review (confirm): creates a review submission with the version and submits it. action=review_status. action=release (confirm): release a version approved with manual release. action=phased_release (confirm): start a 7-day phased rollout. Screenshots, pricing, privacy labels and age rating are easiest in the web UI (or asc_api).",
  mutating: true,
  input: {
    action: z.enum([
      "versions",
      "create_version",
      "attach_build",
      "localizations",
      "update_localization",
      "submit_for_review",
      "review_status",
      "release",
      "phased_release",
    ]),
    app: z.string().optional().describe("App id or bundle ID."),
    platform: z.enum(["iOS", "macOS", "tvOS", "visionOS"]).optional().describe("Default iOS."),
    version_id: z.string().optional(),
    version_string: z
      .string()
      .optional()
      .describe("create_version: e.g. 1.2.0 (must match CFBundleShortVersionString)."),
    release_type: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
    build_id: z.string().optional(),
    locale: z.string().optional().describe("update_localization: default en-US."),
    description: z.string().optional(),
    keywords: z.string().optional(),
    whats_new: z.string().optional(),
    promotional_text: z.string().optional(),
    support_url: z.string().optional(),
    marketing_url: z.string().optional(),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    const platform = ASC_PLATFORM[args.platform ?? "iOS"];

    if (args.action === "attach_build") {
      if (!args.version_id || !args.build_id) throw new ToolError("version_id and build_id are required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Attach build ${args.build_id} to version ${args.version_id}`,
          steps: [{ description: `PATCH /v1/appStoreVersions/${args.version_id}/relationships/build` }],
        }),
        async () => {
          await client.patch(
            `appStoreVersions/${args.version_id}/relationships/build`,
            rel("builds", args.build_id!),
          );
          return {
            summary: "Build attached.",
            data: { ok: true },
            next_steps: [
              "app_store action=update_localization (What's New etc.)",
              "app_store action=submit_for_review",
            ],
          };
        },
      );
    }
    if (args.action === "localizations") {
      if (!args.version_id) throw new ToolError("version_id is required.");
      const res = await client.list(
        `appStoreVersions/${args.version_id}/appStoreVersionLocalizations`,
        {},
        100,
      );
      const rows = res.data.map(slimResource);
      return {
        summary:
          rows
            .map(
              (r) =>
                `• ${r.locale}: ${String(r.description ?? "").slice(0, 60)}… keywords=${r.keywords ?? ""}`,
            )
            .join("\n") || "No localizations.",
        data: { localizations: rows },
      };
    }
    if (args.action === "update_localization") {
      if (!args.version_id) throw new ToolError("version_id is required.");
      const locale = args.locale ?? "en-US";
      const attrs = Object.fromEntries(
        Object.entries({
          description: args.description,
          keywords: args.keywords,
          whatsNew: args.whats_new,
          promotionalText: args.promotional_text,
          supportUrl: args.support_url,
          marketingUrl: args.marketing_url,
        }).filter(([, v]) => v !== undefined),
      );
      if (!Object.keys(attrs).length) throw new ToolError("Provide at least one field to update.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Update ${locale} metadata for version ${args.version_id}`,
          steps: Object.entries(attrs).map(([k, v]) => ({ description: `${k}: ${String(v).slice(0, 200)}` })),
        }),
        async () => {
          const res = await client.list(
            `appStoreVersions/${args.version_id}/appStoreVersionLocalizations`,
            {},
            100,
          );
          const existing = res.data.find((l) => l.attributes?.locale === locale);
          if (existing)
            await client.patch(`appStoreVersionLocalizations/${existing.id}`, {
              data: { type: "appStoreVersionLocalizations", id: existing.id, attributes: attrs },
            });
          else
            await client.post("appStoreVersionLocalizations", {
              data: {
                type: "appStoreVersionLocalizations",
                attributes: { locale, ...attrs },
                relationships: { appStoreVersion: rel("appStoreVersions", args.version_id!) },
              },
            });
          return { summary: `Updated ${locale} metadata.`, data: { ok: true } };
        },
      );
    }
    if (args.action === "release" || args.action === "phased_release") {
      if (!args.version_id) throw new ToolError("version_id is required.");
      const phased = args.action === "phased_release";
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: phased
            ? `Start phased release for version ${args.version_id}`
            : `Release version ${args.version_id} to the App Store`,
          steps: [
            {
              description: phased
                ? "POST /v1/appStoreVersionPhasedReleases (ACTIVE)"
                : "POST /v1/appStoreVersionReleaseRequests",
            },
          ],
          destructive: true,
          warnings: ["This makes the version available to customers."],
        }),
        async () => {
          if (phased)
            await client.post("appStoreVersionPhasedReleases", {
              data: {
                type: "appStoreVersionPhasedReleases",
                attributes: { phasedReleaseState: "ACTIVE" },
                relationships: { appStoreVersion: rel("appStoreVersions", args.version_id!) },
              },
            });
          else
            await client.post("appStoreVersionReleaseRequests", {
              data: {
                type: "appStoreVersionReleaseRequests",
                relationships: { appStoreVersion: rel("appStoreVersions", args.version_id!) },
              },
            });
          return { summary: phased ? "Phased release started." : "Release requested.", data: { ok: true } };
        },
      );
    }

    if (!args.app) throw new ToolError("app is required.");
    const { id: appId } = await resolveAppId(client, args.app);

    if (args.action === "versions") {
      const res = await client.list(
        `apps/${appId}/appStoreVersions`,
        { "filter[platform]": platform, include: "build" },
        20,
      );
      const builds = new Map(
        res.included.filter((i) => i.type === "builds").map((b) => [b.id, b.attributes?.version]),
      );
      const rows = res.data.map((v) => ({
        ...slimResource(v),
        build: builds.get((v.relationships?.build?.data as { id: string } | undefined)?.id ?? ""),
      }));
      return {
        summary: rows.length
          ? table(rows, ["versionString", "appStoreState", "releaseType", "build", "id"])
          : "No versions.",
        data: { versions: rows },
      };
    }
    if (args.action === "review_status") {
      const res = await client.list(`apps/${appId}/reviewSubmissions`, { "filter[platform]": platform }, 10);
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length ? table(rows, ["state", "submittedDate", "id"]) : "No review submissions.",
        data: { submissions: rows },
      };
    }
    if (args.action === "create_version") {
      if (!args.version_string) throw new ToolError("version_string is required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Create ${platform} version ${args.version_string}`,
          steps: [{ description: "POST /v1/appStoreVersions" }],
        }),
        async () => {
          const r = await client.post("appStoreVersions", {
            data: {
              type: "appStoreVersions",
              attributes: {
                platform,
                versionString: args.version_string,
                ...(args.release_type ? { releaseType: args.release_type } : {}),
              },
              relationships: { app: rel("apps", appId) },
            },
          });
          return {
            summary: `Created version ${args.version_string} (${r.data.id}).`,
            data: { version: slimResource(r.data) },
            next_steps: ["app_store action=attach_build"],
          };
        },
      );
    }
    // submit_for_review
    if (!args.version_id) throw new ToolError("version_id is required.");
    const version = (
      await client.get<AscResource>(`appStoreVersions/${args.version_id}`, { include: "build" })
    ).data;
    if (!version.relationships?.build?.data)
      throw new ToolError("No build is attached to this version.", { hint: "app_store action=attach_build" });
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Submit version ${version.attributes?.versionString} for App Review`,
        steps: [
          { description: "POST /v1/reviewSubmissions (platform, app)" },
          { description: "POST /v1/reviewSubmissionItems (this version)" },
          { description: "PATCH /v1/reviewSubmissions/{id} submitted=true" },
        ],
        destructive: true,
        warnings: [
          "Make sure screenshots, privacy details, age rating, pricing and review contact info are complete in App Store Connect — missing items cause the submission to fail.",
        ],
      }),
      async () => {
        const sub = (
          await client.post("reviewSubmissions", {
            data: {
              type: "reviewSubmissions",
              attributes: { platform },
              relationships: { app: rel("apps", appId) },
            },
          })
        ).data;
        await client.post("reviewSubmissionItems", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: rel("reviewSubmissions", sub.id),
              appStoreVersion: rel("appStoreVersions", args.version_id!),
            },
          },
        });
        const done = (
          await client.patch("reviewSubmissions/" + sub.id, {
            data: { type: "reviewSubmissions", id: sub.id, attributes: { submitted: true } },
          })
        ).data;
        return {
          summary: `Submitted for review (submission ${sub.id}, state ${done.attributes?.state ?? "WAITING_FOR_REVIEW"}).`,
          data: { submission: slimResource(done) },
          next_steps: ["app_store action=review_status"],
        };
      },
    );
  },
});
