import { z } from "zod";
import type { ToolDef } from "../tools/types";

/**
 * Generated reference docs. Regenerate with
 * `UPDATE_DOCS=1 pnpm exec vitest run test/docs.test.ts`; CI checks they are fresh.
 */

interface JsonProp {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  items?: JsonProp;
  anyOf?: JsonProp[];
}

function typeOf(p: JsonProp): string {
  if (p.enum) return p.enum.map((e) => `\`${String(e)}\``).join(" \\| ");
  if (p.anyOf) return p.anyOf.map(typeOf).join(" \\| ");
  if (p.type === "array") return `${p.items ? typeOf(p.items) : "any"}[]`;
  if (Array.isArray(p.type)) return p.type.join(" \\| ");
  return p.type ?? "object";
}

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function toolsMarkdown(tools: ToolDef<any>[]): string {
  const lines = [
    "# Tool reference",
    "",
    "<!-- Generated from src/tools/*.ts by `UPDATE_DOCS=1 pnpm exec vitest run test/docs.test.ts`. Do not edit by hand. -->",
    "",
    `${tools.length} tools. **Mutating** tools also accept \`confirm_token\`: the first call returns a preview and changes nothing; repeat the identical call with the token to execute (see [agent-integration.md](agent-integration.md)).`,
    "",
    "| Tool | Kind | Title |",
    "|---|---|---|",
    ...tools.map(
      (t) => `| [\`${t.name}\`](#${t.name}) | ${t.mutating ? "mutating" : "read-only"} | ${cell(t.title)} |`,
    ),
  ];
  for (const t of tools) {
    const schema = z.toJSONSchema(z.object(t.input)) as {
      properties?: Record<string, JsonProp>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    lines.push(
      "",
      `## ${t.name}`,
      "",
      `**${t.title}** — ${t.mutating ? "mutating (preview → confirm_token)" : "read-only"}`,
      "",
      t.description,
      "",
    );
    const entries = Object.entries(props);
    if (entries.length) {
      lines.push("| Argument | Type | Required | Description |", "|---|---|---|---|");
      for (const [name, p] of entries) {
        lines.push(
          `| \`${name}\` | ${typeOf(p)} | ${required.has(name) ? "yes" : ""} | ${cell(p.description)} |`,
        );
      }
    } else lines.push("_No arguments._");
  }
  return `${lines.join("\n")}\n`;
}

/** Claude Code settings snippet that pre-allows every read-only tool. */
export function claudeSettingsExample(tools: ToolDef<any>[], server = "notarize"): string {
  return `${JSON.stringify(
    {
      permissions: {
        allow: tools.filter((t) => !t.mutating).map((t) => `mcp__${server}__${t.name}`),
      },
    },
    null,
    2,
  )}\n`;
}
