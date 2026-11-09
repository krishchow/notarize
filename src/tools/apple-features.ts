import { z } from "zod";
import {
  availabilitySchema,
  canonicalAppleDoc,
  contextError,
  documentSchema,
  freshness,
  readContext,
  writeContext,
} from "../core/apple-context";
import { compareVersions } from "../core/platform";
import { APPLE_FEATURES, APPLE_FEATURES_REVIEWED, IPHONE_18_PRO } from "../knowledge/apple-features";
import { type PlatformSnapshot, platformSnapshotSchema } from "./apple-platform";
import { defineTool, withConfirmation } from "./types";

const verificationSchema = z.object({
  stage: z.enum(["compile", "simulator", "device"]),
  result: z.enum(["not_run", "passed", "failed"]),
  evidence: z.string().min(1).max(8000),
  device: z.string().optional(),
  os_version: z.string().optional(),
  artifact: z.string().max(2000).optional(),
});
const decisionSchema = z.object({
  summary: z.string().min(1).max(8000),
  implementation_plan: z.string().min(1).max(16000),
  constraints: z.array(z.string().max(4000)).max(30),
  fallback: z.string().min(1).max(8000),
  unresolved: z.array(z.string().max(4000)).max(30),
  verification: z.array(verificationSchema).max(20),
});
const sourceSchema = z.object({
  url: z.string(),
  content_hash: z.string(),
  checked_at: z.string(),
  availability: z.array(availabilitySchema),
});
const investigationSchema = z.object({
  schema: z.literal(1),
  investigation_id: z.string(),
  feature: z.string(),
  device: z.string(),
  recorded_at: z.string(),
  project: platformSnapshotSchema,
  sources: z.array(sourceSchema),
  decision: decisionSchema,
  decision_provenance: z.literal("agent_reported"),
});

/** Availability is a necessary condition; never equate it with compiled or hardware-tested support. */
export function availabilityMatrix(project: PlatformSnapshot, sources: z.infer<typeof sourceSchema>[]) {
  const platforms: Record<string, [string, string]> = {
    iphoneos: ["iOS", "IPHONEOS_DEPLOYMENT_TARGET"],
    iphonesimulator: ["iOS", "IPHONEOS_DEPLOYMENT_TARGET"],
    macosx: ["macOS", "MACOSX_DEPLOYMENT_TARGET"],
    appletvos: ["tvOS", "TVOS_DEPLOYMENT_TARGET"],
    appletvsimulator: ["tvOS", "TVOS_DEPLOYMENT_TARGET"],
    watchos: ["watchOS", "WATCHOS_DEPLOYMENT_TARGET"],
    watchsimulator: ["watchOS", "WATCHOS_DEPLOYMENT_TARGET"],
    xros: ["visionOS", "XROS_DEPLOYMENT_TARGET"],
    xrsimulator: ["visionOS", "XROS_DEPLOYMENT_TARGET"],
  };
  const dotted = (s: string | undefined): s is string => !!s && /^\d+(\.\d+)*$/.test(s);
  return project.facts.targets.flatMap((target) =>
    sources.map((source) => {
      const mapping =
        target.settings.EFFECTIVE_PLATFORM_NAME === "-maccatalyst"
          ? ["Mac Catalyst", "IPHONEOS_DEPLOYMENT_TARGET"]
          : platforms[target.settings.PLATFORM_NAME];
      const availability = source.availability.find((a) => a.name === mapping?.[0]);
      const sdk = target.settings.SDK_VERSION;
      const deployment = mapping ? target.settings[mapping[1]] : undefined;
      const introduced = availability?.introducedAt;
      return {
        target: target.target,
        url: source.url,
        platform: mapping?.[0],
        sdk,
        deployment,
        introduced,
        sdk_assessment: availability?.unavailable
          ? "unavailable"
          : !availability || !dotted(sdk) || !dotted(introduced)
            ? "unknown"
            : compareVersions(sdk, introduced) < 0
              ? "newer_sdk_required"
              : "version_requirement_met_not_compiled",
        deployment_assessment:
          !availability || !dotted(deployment) || !dotted(introduced)
            ? "unknown"
            : compareVersions(deployment, introduced) < 0
              ? "runtime_availability_guard_and_fallback_required"
              : "introduction_requirement_met",
        lifecycle: availability?.unavailable
          ? "unavailable"
          : availability?.obsoletedAt
            ? "obsoletion_documented_review_required"
            : availability?.deprecatedAt
              ? "deprecation_documented_review_required"
              : "no_removal_recorded_in_source",
        beta_policy:
          availability?.beta && project.facts.beta_policy === "stable_only"
            ? "blocked_by_stable_only_policy"
            : availability?.beta
              ? "beta_api"
              : "not_marked_beta_by_source",
        hardware_and_runtime: "unverified",
      };
    }),
  );
}

export const appleFeatureContextTool = defineTool({
  name: "apple_feature_context",
  title: "Apple feature discovery and implementation evidence",
  description:
    "discover searches a small dated feature-to-framework index, initially focused on iPhone 18 Pro buttons, variable aperture and Reference Image. It is not an exhaustive Apple documentation search or a device-support guarantee. record (confirm) saves an agent-reported feature plan, fallback, constraints and verification, binding it to a saved project fingerprint and exact cached Apple source revisions. get reads the investigation and flags changed/expired sources and context mismatches. Availability comparisons are version checks, never proof of compilation, hardware or runtime behavior. No Apple account needed.",
  mutating: true,
  input: {
    action: z
      .enum(["discover", "record", "get"])
      .describe("Discover official entry points, save evidence, or revisit an investigation."),
    query: z
      .string()
      .optional()
      .describe("discover: feature keywords, framework, or exact feature ID; omit to list starter coverage."),
    device: z
      .string()
      .default("iphone-18-pro")
      .describe("Intended device; first curated profile is iphone-18-pro. Other names remain unverified."),
    investigation_id: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("record/get: stable caller-chosen ID, e.g. my-app-camera-control."),
    feature: z
      .string()
      .max(500)
      .optional()
      .describe("record: feature ID or description; new features need not be in the starter index."),
    snapshot_id: z
      .string()
      .optional()
      .describe(
        "record: saved project snapshot ID. get: optional latest snapshot to compare after project/toolchain selection changes.",
      ),
    project_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe("record: exact fingerprint from the inspected snapshot; rejects silently changed context."),
    sources: z
      .array(z.object({ url: z.string().url(), content_hash: z.string().regex(/^[a-f0-9]{64}$/) }))
      .min(1)
      .max(20)
      .optional()
      .describe(
        "record: exact URL and content_hash pairs returned by apple_docs; binds the decision to the revisions actually read, not whatever is latest later.",
      ),
    decision: decisionSchema
      .optional()
      .describe(
        "record: complete replacement investigation decision. Results are explicitly agent-reported; passed checks require concrete evidence.",
      ),
    max_age_hours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(168)
      .describe(
        "Refresh window used to flag cached evidence; never establishes SDK compatibility by itself.",
      ),
  },
  async handler(args, ctx, extra) {
    if (args.action === "discover") {
      const tokens = args.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const features = APPLE_FEATURES.filter((feature) =>
        tokens.every((token) => JSON.stringify(feature).toLowerCase().includes(token)),
      );
      const knownDevice = args.device.toLowerCase().replace(/\s+/g, "-") === "iphone-18-pro";
      return {
        summary: `${features.length} curated feature entry point(s)${knownDevice ? " for the iPhone 18 Pro starter investigation" : "; requested device has no curated profile"}.`,
        data: {
          reviewed_at: APPLE_FEATURES_REVIEWED,
          freshness: freshness(`${APPLE_FEATURES_REVIEWED}T00:00:00.000Z`, ctx.now(), args.max_age_hours),
          requested_device: args.device,
          device: knownDevice ? IPHONE_18_PRO : null,
          device_support: knownDevice ? "hardware_profile_only_runtime_unverified" : "unknown",
          features,
          coverage:
            "Small discovery index; an absent result means unknown coverage, not unsupported hardware or no Apple API.",
        },
        next_steps: features
          .flatMap((f) => f.sources.slice(0, 2).map((url) => `apple_docs action=fetch url=${url}`))
          .slice(0, 8),
      };
    }
    if (!args.investigation_id) throw contextError("investigation_id is required for record/get.");
    if (args.action === "get") {
      const investigation = await readContext(
        ctx,
        "investigations",
        args.investigation_id,
        investigationSchema,
      );
      if (!investigation)
        throw contextError(
          "investigation not found; record one after gathering project and source evidence.",
        );
      const current = await readContext(
        ctx,
        "projects",
        args.snapshot_id ?? investigation.project.snapshot_id,
        platformSnapshotSchema,
      );
      const contextMatches = current?.fingerprint === investigation.project.fingerprint;
      const sources = await Promise.all(
        investigation.sources.map(async (source) => {
          const current = await readContext(ctx, "documents", source.url, documentSchema);
          return {
            ...source,
            changed: !current || current.content_hash !== source.content_hash,
            freshness: current
              ? freshness(current.checked_at, ctx.now(), args.max_age_hours)
              : { status: "missing" },
          };
        }),
      );
      const projectFreshness = freshness(
        current?.observed_at ?? investigation.project.observed_at,
        ctx.now(),
        args.max_age_hours,
      );
      const revalidation =
        !contextMatches ||
        projectFreshness.status !== "within_refresh_window" ||
        sources.some((source) => source.changed || source.freshness.status !== "within_refresh_window");
      return {
        summary: `Feature investigation ${args.investigation_id}: ${revalidation ? "revalidation required" : "matches latest cached context and source revisions"}.`,
        data: {
          investigation,
          sources,
          context_comparison: contextMatches
            ? "matches_latest_cached_snapshot_not_live_inspection"
            : "changed_or_missing",
          project_freshness: projectFreshness,
          revalidation_required: revalidation,
          availability: availabilityMatrix(investigation.project, investigation.sources),
          verification_provenance: "agent_reported_not_executed_by_this_tool",
        },
        next_steps: [
          "Run apple_platform_context action=snapshot again after changing Xcode, SDK, scheme, destination or deployment settings; refresh changed/expired apple_docs sources.",
        ],
      };
    }
    if (!args.feature || !args.snapshot_id || !args.sources || !args.project_fingerprint || !args.decision)
      throw contextError(
        "record requires feature, snapshot_id, project_fingerprint, sources and a complete decision.",
      );
    for (const verification of args.decision.verification) {
      if (
        verification.result === "passed" &&
        (!verification.evidence.trim() ||
          (verification.stage === "device" &&
            (!verification.device?.trim() || !verification.os_version?.trim())))
      )
        throw contextError(
          "passed verification needs evidence; device verification also needs the tested device and OS version.",
        );
    }
    const project = await readContext(ctx, "projects", args.snapshot_id, platformSnapshotSchema);
    if (!project)
      throw contextError("saved project snapshot missing; run apple_platform_context action=snapshot first.");
    if (project.fingerprint !== args.project_fingerprint)
      throw contextError(
        "project fingerprint changed since it was inspected; re-read the snapshot before recording a decision.",
      );
    const sources = await Promise.all(
      args.sources.map(async (ref) => {
        const url = canonicalAppleDoc(ref.url);
        const source = await readContext(
          ctx,
          "document-revisions",
          `${url}:${ref.content_hash}`,
          documentSchema,
        );
        if (!source)
          throw contextError(
            "source revision missing; fetch/read every source with apple_docs and supply its exact content_hash.",
          );
        return {
          url,
          content_hash: source.content_hash,
          checked_at: source.checked_at,
          availability: source.availability,
        };
      }),
    );
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Save feature investigation ${args.investigation_id}`,
        steps: [
          {
            description: `Record agent-reported evidence for ${args.feature} on ${args.device}, project fingerprint ${project.fingerprint}, and ${sources.length} source revision(s).`,
          },
        ],
        notes: [
          "This replaces the previous decision with this ID. No compilation, device testing, entitlement changes or Apple account writes are performed.",
        ],
      }),
      async () => {
        const investigation: z.infer<typeof investigationSchema> = {
          schema: 1,
          investigation_id: args.investigation_id!,
          feature: args.feature!,
          device: args.device,
          recorded_at: ctx.now().toISOString(),
          project,
          sources,
          decision: args.decision!,
          decision_provenance: "agent_reported",
        };
        await writeContext(ctx, "investigations", args.investigation_id!, investigation);
        return {
          summary: `Saved feature investigation ${args.investigation_id}; implementation and verification are agent-reported.`,
          data: { investigation, availability: availabilityMatrix(project, sources) },
          next_steps: [`apple_feature_context action=get investigation_id=${args.investigation_id}`],
        };
      },
    );
  },
});
