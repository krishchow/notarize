import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { formatCommand, redactDeep } from "./redact";

/**
 * Plan + confirm protocol.
 *
 * Mutating tools first return a preview describing exactly what they will do,
 * together with a `confirm_token`. The token is an HMAC over the tool name and
 * the canonicalised arguments, so it is only valid for an identical follow-up
 * call made within the TTL. Changing any argument invalidates it.
 */

export interface PlanStep {
  description: string;
  /** Display-only command line (already redacted). */
  command?: string;
}

export interface Plan {
  title: string;
  steps: PlanStep[];
  warnings?: string[];
  /** Irreversible / account-affecting actions (revocation, deletion, uploads). */
  destructive?: boolean;
  notes?: string[];
}

export type ConfirmCheck =
  | { status: "execute" }
  | { status: "preview" }
  | { status: "invalid"; reason: string };

export const CONFIRM_TOKEN_ARG = "confirm_token";

export class ConfirmManager {
  private readonly secret: Buffer;

  constructor(
    opts: {
      secret?: Buffer;
      ttlMs?: number;
      autoConfirm?: boolean;
      now?: () => number;
    } = {},
  ) {
    this.secret = opts.secret ?? randomBytes(32);
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.autoConfirm = opts.autoConfirm ?? process.env.NOTARIZE_MCP_AUTO_CONFIRM === "1";
    this.now = opts.now ?? Date.now;
  }

  readonly ttlMs: number;
  readonly autoConfirm: boolean;
  private readonly now: () => number;

  issue(tool: string, args: Record<string, unknown>): string {
    const expiry = this.now() + this.ttlMs;
    return `${expiry.toString(36)}.${this.sign(tool, args, expiry)}`;
  }

  check(tool: string, args: Record<string, unknown>): ConfirmCheck {
    if (this.autoConfirm) return { status: "execute" };
    const token = args[CONFIRM_TOKEN_ARG];
    if (token === undefined || token === null || token === "") return { status: "preview" };
    if (typeof token !== "string" || !token.includes(".")) {
      return { status: "invalid", reason: "confirm_token is malformed." };
    }
    const [expStr, mac] = token.split(".", 2);
    const expiry = Number.parseInt(expStr, 36);
    if (!Number.isFinite(expiry)) return { status: "invalid", reason: "confirm_token is malformed." };
    if (this.now() > expiry) {
      return {
        status: "invalid",
        reason: "confirm_token expired; review the new preview and confirm again.",
      };
    }
    const expected = this.sign(tool, args, expiry);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return {
        status: "invalid",
        reason:
          "confirm_token does not match these arguments (they changed since the preview, or the token belongs to another tool). Review the new preview and confirm again.",
      };
    }
    return { status: "execute" };
  }

  private sign(tool: string, args: Record<string, unknown>, expiry: number): string {
    const { [CONFIRM_TOKEN_ARG]: _ignored, ...rest } = args;
    return createHmac("sha256", this.secret)
      .update(`${tool}\n${canonicalJson(rest)}\n${expiry}`)
      .digest("base64url");
  }
}

/** Stable JSON: sorted keys, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Helper for building plan steps from argv. */
export function cmdStep(description: string, cmd: string, args: string[], secrets: string[] = []): PlanStep {
  return { description, command: formatCommand(cmd, args, secrets) };
}

export function previewData(plan: Plan, token: string, ttlMs: number) {
  return redactDeep({
    status: "preview" as const,
    title: plan.title,
    destructive: plan.destructive ?? false,
    steps: plan.steps,
    warnings: plan.warnings ?? [],
    notes: plan.notes ?? [],
    confirm_token: token,
    confirm_token_expires_in_seconds: Math.round(ttlMs / 1000),
  });
}
