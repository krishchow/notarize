import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CERTIFICATE_TYPES } from "../knowledge/certificate-types";
import { ENTITLEMENT_PRESETS, ENTITLEMENTS } from "../knowledge/entitlements";
import { ERROR_CATALOG } from "../knowledge/error-catalog";
import { PRIVACY_RESOURCES, REQUIRED_REASON_APIS } from "../knowledge/privacy-keys";
import { SDK_REQUIREMENTS } from "../knowledge/sdk-requirements";
import { TARGETS } from "../knowledge/targets";

/** Locate skills/apple-distribution both from src/ (tests) and dist/ (bundle / plugin). */
export function findSkillDir(): string | undefined {
  const candidates = [
    process.env.NOTARIZE_MCP_SKILL_DIR,
    fileURLToPath(new URL("../skills/apple-distribution", import.meta.url)),
    fileURLToPath(new URL("../../skills/apple-distribution", import.meta.url)),
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(join(c, "SKILL.md")));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

export function guideTopics(skillDir: string): { topic: string; path: string; title: string }[] {
  const refs = join(skillDir, "references");
  const files = [join(skillDir, "SKILL.md"), ...(existsSync(refs) ? walk(refs) : [])];
  return files.map((p) => {
    const rel = p.endsWith("SKILL.md")
      ? "overview"
      : relative(refs, p).replace(/\.md$/, "").replace(/[\\/]/g, "-");
    const text = readFileSync(p, "utf8");
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? rel;
    return { topic: rel, path: p, title };
  });
}

/** Markdown version of the error catalog (also committed as references/error-catalog.md). */
export function errorCatalogMarkdown(): string {
  const bySource = new Map<string, typeof ERROR_CATALOG>();
  for (const e of ERROR_CATALOG) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  const lines = [
    "# Error catalog",
    "",
    "<!-- Generated from src/knowledge/error-catalog.ts by `UPDATE_DOCS=1 npx vitest run test/docs.test.ts`. Do not edit by hand. -->",
    "",
    "Tool results run every failure through this catalog automatically; this page is for reading ahead.",
  ];
  for (const [source, entries] of bySource) {
    lines.push("", `## ${source}`, "");
    for (const e of entries) {
      lines.push(
        `### ${e.title}`,
        "",
        `Matches: \`${e.pattern.source.replace(/`/g, "'")}\``,
        "",
        e.explanation,
        "",
        ...e.fix.map((f) => `- ${f}`),
      );
      if (e.tool) lines.push(`- Tool: \`${e.tool}\``);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const CATALOGS: Record<string, { description: string; data: () => unknown }> = {
  targets: { description: "Distribution targets and what each requires", data: () => TARGETS },
  "certificate-types": {
    description: "Apple certificate types, who can create them, keychain names",
    data: () => CERTIFICATE_TYPES,
  },
  entitlements: {
    description: "Entitlement catalog + presets",
    data: () => ({ entitlements: ENTITLEMENTS, presets: ENTITLEMENT_PRESETS }),
  },
  errors: {
    description: "Known codesign/notarization/Gatekeeper/xcodebuild/ITMS errors with fixes",
    data: () => ERROR_CATALOG.map((e) => ({ ...e, pattern: e.pattern.source })),
  },
  privacy: {
    description: "Privacy usage strings, TCC services, required-reason APIs",
    data: () => ({ resources: PRIVACY_RESOURCES, requiredReasonApis: REQUIRED_REASON_APIS }),
  },
  "sdk-requirements": { description: "App Store minimum Xcode/SDK by date", data: () => SDK_REQUIREMENTS },
};

export function registerResources(server: McpServer): void {
  const skillDir = findSkillDir();
  if (skillDir) {
    for (const g of guideTopics(skillDir)) {
      const uri = `notarize://guides/${g.topic}`;
      server.registerResource(
        g.topic,
        uri,
        { title: g.title, description: `Guide: ${g.title}`, mimeType: "text/markdown" },
        async () => ({
          contents: [{ uri, mimeType: "text/markdown", text: readFileSync(g.path, "utf8") }],
        }),
      );
    }
  }
  for (const [name, c] of Object.entries(CATALOGS)) {
    const uri = `notarize://catalog/${name}`;
    server.registerResource(
      `catalog-${name}`,
      uri,
      { title: `Catalog: ${name}`, description: c.description, mimeType: "application/json" },
      async () => ({
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(c.data(), null, 2) }],
      }),
    );
  }
}
