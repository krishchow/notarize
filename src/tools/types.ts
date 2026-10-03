import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AscClient } from "../asc/client";
import type { ConfigStore } from "../core/config";
import { CONFIRM_TOKEN_ARG, type ConfirmManager, type Plan, previewData } from "../core/confirm";
import type { CommandRunner } from "../core/exec";
import type { JobManager } from "../core/jobs";
import type { PlatformInfo } from "../core/platform";
import type { ToolOutput } from "../core/result";

export interface ToolContext {
  runner: CommandRunner;
  platform: PlatformInfo;
  config: ConfigStore;
  confirm: ConfirmManager;
  jobs: JobManager;
  fetch: typeof fetch;
  /** Build an authenticated App Store Connect client for a credential profile. */
  asc(profile?: string): Promise<AscClient>;
  now(): Date;
}

export interface ToolExtra {
  toolName: string;
  signal?: AbortSignal;
  /** Sends an MCP progress notification if the client asked for one. */
  progress(message: string, progress?: number, total?: number): Promise<void>;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  /** Tool can change state; a `confirm_token` arg is added automatically. */
  mutating?: boolean;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext, extra: ToolExtra): Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export const confirmTokenSchema = z
  .string()
  .optional()
  .describe(
    "Leave empty on the first call to get a preview. After the user approves the preview, repeat the call with identical arguments plus the confirm_token from the preview.",
  );

/**
 * Run `execute` only when the call carries a valid confirm token for these exact
 * args; otherwise return a preview built by `buildPlan`.
 */
export async function withConfirmation(
  ctx: ToolContext,
  extra: ToolExtra,
  args: Record<string, unknown>,
  buildPlan: () => Plan | Promise<Plan>,
  execute: () => Promise<ToolOutput>,
): Promise<ToolOutput> {
  const check = ctx.confirm.check(extra.toolName, args);
  if (check.status === "execute") return execute();
  const plan = await buildPlan();
  // Unattended policy (NOTARIZE_MCP_AUTO_CONFIRM): decided after building the plan so that
  // destructive actions are never auto-run under the "safe" policy.
  if (check.status === "preview" && ctx.confirm.autoAllows(extra.toolName, args, !!plan.destructive)) {
    const out = await execute();
    return {
      ...out,
      summary: `[auto-confirmed by NOTARIZE_MCP_AUTO_CONFIRM: ${plan.title}]\n${out.summary}`,
      data: { ...out.data, auto_confirmed: true },
    };
  }
  const token = ctx.confirm.issue(extra.toolName, args);
  const data = previewData(plan, token, ctx.confirm.ttlMs);
  const lines = [
    `${check.status === "invalid" ? `Not executed: ${check.reason}\n\n` : ""}PREVIEW (nothing has been changed yet): ${plan.title}`,
    ...plan.steps.map((s, i) => `${i + 1}. ${s.description}${s.command ? `\n   $ ${s.command}` : ""}`),
  ];
  if (plan.warnings?.length) lines.push("", "Warnings:", ...plan.warnings.map((w) => `⚠ ${w}`));
  if (plan.notes?.length) lines.push("", ...plan.notes);
  return {
    summary: lines.join("\n"),
    data,
    next_steps: [
      `Show this plan to the user${plan.destructive ? " and get explicit approval — this action is destructive or affects your Apple account" : ""}.`,
      `If approved, call ${extra.toolName} again with the same arguments plus ${CONFIRM_TOKEN_ARG}="${token}".`,
    ],
    isError: check.status === "invalid",
  };
}

/** Common optional args. */
export const profileArg = z
  .string()
  .optional()
  .describe("Credential profile name from asc_auth configure (defaults to env vars / default profile).");

export const pathArg = (what = "Path") => z.string().describe(`${what} (absolute, or ~/...)`);
