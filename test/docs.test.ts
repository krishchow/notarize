import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorCatalogMarkdown, findSkillDir, guideTopics } from "../src/resources/index";
import { allTools } from "../src/tools/index";
import { connect, makeCtx } from "./helpers";

const skillDir = findSkillDir()!;

describe("skill + docs", () => {
  it("has a SKILL.md with frontmatter and working relative links", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: apple-distribution\ndescription: .{100,}\n---/);
    for (const [, link] of skill.matchAll(/\]\(((?:references)\/[^)#]+)\)/g)) {
      expect(existsSync(join(skillDir, link)), link).toBe(true);
    }
  });

  it("mentions every tool name that exists and no tool that doesn't", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const names = new Set(allTools.map((t) => t.name));
    for (const core of [
      "doctor",
      "detect_project",
      "distribution_checklist",
      "notarize_and_staple",
      "jobs",
      "sign",
    ]) {
      expect(skill).toContain(core);
    }
    const referenced = [
      ...skill.matchAll(
        /`((?:asc_|notary|xcode|upload_|testflight|app_store|ci_|keychain|gatekeeper|privacy|system_logs|inspect_|entitlements|provisioning_|package|staple|resign|crash_reports|devices|quarantine|signing_)[a-z_]*)/g,
      ),
    ]
      .map((m) => m[1])
      .filter((r) => !r.endsWith("_") && !["notarytool", "xcodebuild", "xcodeproj"].includes(r));
    for (const r of referenced) expect(names.has(r), `SKILL.md references unknown tool ${r}`).toBe(true);
  });

  it("documents the Monitor workflow for long notarizations", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/Long-running operations/);
    expect(skill).toMatch(/Monitor\(\{ command: <monitor\.command>/);
    expect(skill).toMatch(/watch-notarization/);
  });

  it("keeps references/error-catalog.md in sync with the catalog", () => {
    const path = join(skillDir, "references", "error-catalog.md");
    const md = errorCatalogMarkdown();
    if (process.env.UPDATE_DOCS === "1") writeFileSync(path, md);
    expect(readFileSync(path, "utf8")).toBe(md);
  });

  it("serves guides and catalogs as MCP resources, and prompts", async () => {
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("notarize://guides/overview");
    expect(uris).toContain("notarize://guides/notarization");
    expect(uris).toContain("notarize://guides/frameworks-electron");
    expect(uris).toContain("notarize://catalog/errors");
    expect(uris.length).toBe(guideTopics(skillDir).length + 6);
    const r = await client.readResource({ uri: "notarize://catalog/targets" });
    expect(JSON.parse((r.contents[0] as { text: string }).text)["mac-developer-id"].exportMethod).toBe(
      "developer-id",
    );
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "debug-gatekeeper",
      "debug-notarization",
      "debug-sandbox",
      "setup-distribution",
    ]);
    const p = await client.getPrompt({ name: "setup-distribution", arguments: { path: "/tmp/app" } });
    expect((p.messages[0].content as { text: string }).text).toMatch(/Monitor/);
  });
});
