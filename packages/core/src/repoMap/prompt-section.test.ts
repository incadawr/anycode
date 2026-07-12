import { describe, expect, it, vi } from "vitest";
import { HeuristicTokenizer } from "../context/tokenizer.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { buildRepoMapPromptSection, prioritizeAndEnrich } from "./prompt-section.js";
import type { RepoFile } from "./walk.js";

function file(relativePath: string, mtimeMs = 1, size = 100): RepoFile {
  const dot = relativePath.lastIndexOf(".");
  return { relativePath, mtimeMs, size, extension: dot < 0 ? "" : relativePath.slice(dot).toLowerCase() };
}

describe("repo-map prompt section", () => {
  it("prioritizes manifests then source files and enriches only top-N text files", async () => {
    const fs: FileSystemPort = {
      readFile: vi.fn(async (path) => path.includes("package") ? "{}\n" : "a\nb\n"),
      exists: vi.fn(), stat: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
    };
    const result = await prioritizeAndEnrich(fs, [file("docs/x.md"), file("src/old.ts", 2), file("src/new.ts", 9), file("package.json", 1), file("logo.png")], 3, "/ws");
    expect(result.map((item) => item.relativePath)).toEqual(["package.json", "src/new.ts", "src/old.ts", "docs/x.md", "logo.png"]);
    expect(fs.readFile).toHaveBeenCalledTimes(3);
    expect(result[0]?.lines).toBe(2);
    expect(result.at(-1)?.lines).toBeUndefined();
  });

  it("prefers recently modified files in the non-source priority group", async () => {
    const fs: FileSystemPort = {
      readFile: vi.fn(async () => "x"), exists: vi.fn(), stat: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
    };
    const result = await prioritizeAndEnrich(fs, [file("docs/a.md", 1), file("docs/z.md", 20)], 0);
    expect(result.map((entry) => entry.relativePath)).toEqual(["docs/z.md", "docs/a.md"]);
  });

  it("renders a tree, metadata, and mtime rank", () => {
    const built = buildRepoMapPromptSection(
      [{ ...file("src/index.ts", 10, 2048), lines: 12 }, file("logo.png", 1, 500)],
      { maxTokens: 8000, tokenizer: new HeuristicTokenizer(), workspace: "/ws" },
    );
    expect(built.section).toContain("<repo-map>");
    expect(built.section).toContain("- src/\n  - index.ts (12L, ts, mtime#1)");
    expect(built.section).toContain("logo.png (500B, mtime#2)");
    expect(built).toMatchObject({ truncated: false, omittedCount: 0 });
  });

  it("never reads binary files while enriching the priority prefix", async () => {
    const readFile = vi.fn(async () => "one\ntwo");
    const fs: FileSystemPort = {
      readFile, exists: vi.fn(), stat: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
    };
    const enriched = await prioritizeAndEnrich(fs, [file("package.json"), file("logo.png")], 10, "/ws");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/ws/package.json");
    expect(enriched.find((entry) => entry.relativePath === "logo.png")?.lines).toBeUndefined();
  });

  it("stays within the token cap and reports omitted files", () => {
    const tokenizer = new HeuristicTokenizer();
    const files = Array.from({ length: 500 }, (_, index) => file(`src/deep/file-${index.toString().padStart(4, "0")}.ts`, index));
    const built = buildRepoMapPromptSection(files, { maxTokens: 500, tokenizer, workspace: "/ws" });
    expect(built.truncated).toBe(true);
    expect(built.omittedCount).toBeGreaterThan(0);
    expect(built.section).toContain("use Glob/Grep");
    expect(tokenizer.count(built.section)).toBeLessThanOrEqual(500);
  });

  it.each([
    [1, 500],
    [99_999, 8_000],
  ])("clamps formatter maxTokens=%s to %s", (requested, expected) => {
    const built = buildRepoMapPromptSection([file("a.ts")], {
      maxTokens: requested, tokenizer: new HeuristicTokenizer(), workspace: "/ws",
    });
    expect(built.section).toContain(`~${expected}-token budget`);
  });

  it("is empty for an empty repository", () => {
    expect(buildRepoMapPromptSection([], { maxTokens: 500, tokenizer: new HeuristicTokenizer(), workspace: "/ws" })).toEqual({ section: "", truncated: false, omittedCount: 0 });
  });
});
