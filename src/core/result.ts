import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What every tool handler returns; converted to an MCP CallToolResult by the registry. */
export interface ToolOutput {
  /** Concise human/agent readable summary (first thing the model reads). */
  summary: string;
  /** Structured details (also serialised as JSON text for clients without structuredContent). */
  data?: Record<string, unknown>;
  /** Suggested follow-ups, ideally naming the exact tool/action to call next. */
  next_steps?: string[];
  isError?: boolean;
}

/** Thrown for expected, user-actionable failures (bad input, missing prerequisites). */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details: { hint?: string; next_steps?: string[]; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const MAX_JSON_CHARS = 60_000;

export function toCallToolResult(out: ToolOutput): CallToolResult {
  const text: string[] = [out.summary.trim()];
  if (out.next_steps?.length) {
    text.push(`\nNext steps:\n${out.next_steps.map((s) => `- ${s}`).join("\n")}`);
  }
  const content: CallToolResult["content"] = [{ type: "text", text: text.join("\n") }];
  const structured = out.data
    ? { ...out.data, ...(out.next_steps ? { next_steps: out.next_steps } : {}) }
    : undefined;
  if (structured) {
    let json = JSON.stringify(structured, jsonReplacer, 2);
    if (json.length > MAX_JSON_CHARS) {
      json = `${json.slice(0, MAX_JSON_CHARS)}\n… (truncated; ${json.length - MAX_JSON_CHARS} more chars)`;
    }
    content.push({ type: "text", text: json });
  }
  // Some clients (Claude Code among them) show only structuredContent when it is present, so the
  // summary must travel there too or the model never reads it. The text block above already has it.
  return {
    content,
    ...(structured
      ? {
          structuredContent: JSON.parse(
            JSON.stringify({ summary: out.summary, ...structured }, jsonReplacer),
          ),
        }
      : {}),
    ...(out.isError ? { isError: true } : {}),
  };
}

export function errorOutput(err: unknown): ToolOutput {
  if (err instanceof ToolError) {
    return {
      summary: `Error: ${err.message}${err.details.hint ? `\nHint: ${err.details.hint}` : ""}`,
      data: {
        error: err.message,
        ...(err.details.hint ? { hint: err.details.hint } : {}),
        ...err.details.data,
      },
      next_steps: err.details.next_steps,
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { summary: `Unexpected error: ${message}`, data: { error: message }, isError: true };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}
