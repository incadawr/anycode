import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anycodeSetupSkill } from "./builtin.js";
import { parseFrontmatter } from "./frontmatter.js";
import { anycodeSetupBody } from "./setup-body.js";

// This is the same tree copied into packaged builds by extraResources.
const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/user");
const pages = new Map(readdirSync(docsDir).filter(name => name.endsWith(".md"))
  .map(name => [name, readFileSync(resolve(docsDir, name), "utf8")]));
const readme = pages.get("README.md")!;

function prose(markdown: string): string {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}

function links(markdown: string): string[] {
  return [...prose(markdown).matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)]
    .map(match => match[1]!);
}

/** GitHub heading ids, including repeated heading suffixes. */
function anchors(markdown: string): Set<string> {
  const used = new Set<string>();
  for (const match of prose(markdown).matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1]!.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    let id = base;
    for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
  }
  for (const match of markdown.matchAll(/<(?:a|[a-z]+)\b[^>]*\bid=["']([^"']+)["']/g)) {
    used.add(match[1]!);
  }
  return used;
}

function localLink(link: string): { page: string; anchor?: string } | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(link)) return undefined;
  const [path = "", fragment] = decodeURIComponent(link).split("#");
  const target = resolve(docsDir, path || "README.md");
  const fromRoot = relative(docsDir, target);
  if (link.startsWith("/") || isAbsolute(fromRoot) || fromRoot.startsWith("..")) {
    throw new Error(`Link escapes packaged docs: ${link}`);
  }
  return { page: fromRoot, ...(fragment ? { anchor: fragment } : {}) };
}

describe("packaged user guide navigation", () => {
  it("links every page from the README without a hardcoded topic list", () => {
    const indexed = new Set(links(readme).map(link => localLink(link)?.page));
    for (const [name, content] of pages) {
      expect(content.trim(), `${name} must be non-empty`).not.toBe("");
      if (name !== "README.md") expect(indexed.has(name), `README must link ${name}`).toBe(true);
    }
  });

  it("keeps all local links inside the packaged tree and resolves files and anchors", () => {
    for (const [source, body] of pages) {
      for (const link of links(body)) {
        // A fragment-only link refers to the current page.
        const target = localLink(link.startsWith("#") ? source + link : link);
        if (!target) continue;
        const content = pages.get(target.page);
        expect(content, `${source}: missing target ${link}`).toBeDefined();
        if (target.anchor && content) {
          expect(anchors(content).has(target.anchor), `${source}: missing anchor ${link}`).toBe(true);
        }
      }
    }
  });

  it("provides 30–40 task and symptom rows with valid anchors", () => {
    const map = readme.split("## I want to… / Symptom")[1]!.split("\n## ")[0]!;
    const entries = links(map);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(entries.length).toBeLessThanOrEqual(40);
    expect(entries.some(link => link.includes("#"))).toBe(true);
  });

  it("rejects traversal, including encoded traversal, and handles heading punctuation", () => {
    for (const link of ["../development/README.md", "../../examples/x.md", "%2e%2e/x.md", "/tmp/x.md"]) {
      expect(() => localLink(link)).toThrow("escapes packaged docs");
    }
    expect(anchors("## Shared config: `.anycode/config.json`\n## Repeat\n## Repeat\n"))
      .toEqual(new Set(["shared-config-anycodeconfigjson", "repeat", "repeat-1"]));
  });

  it("the setup body starts at the index and names only existing documentation pages", () => {
    for (const docs of [{ kind: "local", dir: docsDir }, { kind: "remote", ref: "v0.0.90" }] as const) {
      const body = anycodeSetupSkill(docs).body;
      expect(body).toContain("Read README.md first");
      const mentioned = [...body.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/g)].map(match => match[1]!);
      expect(mentioned).toContain("README.md");
      for (const name of mentioned) expect(pages.has(name), `Skill names missing page ${name}`).toBe(true);
    }
  });

  it("keeps the config boundary and Sessions API connection instructions discoverable", () => {
    expect(readme).toContain("~/.anycode/settings.json");
    expect(readme).toContain("~/.anycode/secrets.json");
    expect(readme).toContain(".anycode/config.json");
    const api = pages.get("sessions-api.md")!;
    for (const text of ["list_sessions", "send_message", "Settings → Sessions API", "Copy MCP config", 'mode: "next_turn"']) {
      expect(api).toContain(text);
    }
  });

  it("keeps the external Agent Skills package synchronized with the shared setup body", () => {
    const raw = readFileSync(resolve(docsDir, "../../skills/anycode-setup/SKILL.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(Object.keys(parsed.fields).sort()).toEqual(["description", "name"]);
    expect(parsed.fields.name).toBe("anycode-setup");
    expect(parsed.fields.description).toMatch(/AnyCode configuration/);
    expect(parsed.body.trim()).toBe(anycodeSetupBody(
      "App documentation: https://raw.githubusercontent.com/incadawr/anycode/master/docs/user/README.md\n" +
      "Resolve relative page links under https://raw.githubusercontent.com/incadawr/anycode/master/docs/user/.",
      "Use available permitted read/edit and remote reading tools; retain their normal approval restrictions.",
    ).trim());
  });

  it("offers a short, secret-safe instruction snippet reachable from the map", () => {
    const snippet = pages.get("AGENTS-SNIPPET.md")!;
    expect(snippet.trimEnd().split("\n").length).toBeGreaterThanOrEqual(15);
    expect(snippet.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
    expect(snippet).toContain("https://raw.githubusercontent.com/incadawr/anycode/master/docs/user/README.md");
    expect(snippet).toContain("Never read ~/.anycode/secrets.json");
    expect(snippet).toContain("Never read ~/.codex/auth.json");
  });
});
