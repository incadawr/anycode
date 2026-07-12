import { describe, expect, it, vi } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { loadRepoMapConfig } from "./config.js";

function configFs(files: Record<string, string>): FileSystemPort {
  return {
    exists: vi.fn(async (path) => path in files),
    readFile: vi.fn(async (path) => files[path]!),
    stat: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
  };
}

describe("loadRepoMapConfig", () => {
  it("is disabled by default", async () => {
    expect(await loadRepoMapConfig(configFs({}), "/ws", "/home", {})).toEqual({ repoMap: null, issues: [] });
  });

  it.each(["0", "FALSE", "Off"])("applies env kill-switch %s before filesystem access", async (value) => {
    const fs = configFs({ "/ws/.anycode/config.json": JSON.stringify({ repoMap: { enabled: true } }) });
    expect(await loadRepoMapConfig(fs, "/ws", "/home", { ANYCODE_REPO_MAP: value })).toEqual({ repoMap: null, issues: [] });
    expect(fs.exists).not.toHaveBeenCalled();
  });

  it.each(["1", "TRUE", "On"])("supports env force-on %s before filesystem access", async (value) => {
    const fs = configFs({});
    expect(await loadRepoMapConfig(fs, "/ws", "/home", { ANYCODE_REPO_MAP: value })).toEqual({ repoMap: { enabled: true }, issues: [] });
    expect(fs.exists).not.toHaveBeenCalled();
  });

  it("lets a project section win wholesale over user config", async () => {
    const fs = configFs({
      "/ws/.anycode/config.json": JSON.stringify({ repoMap: { enabled: false } }),
      "/home/.anycode/config.json": JSON.stringify({ repoMap: { enabled: true, maxTokens: 700 } }),
    });
    expect(await loadRepoMapConfig(fs, "/ws", "/home", {})).toEqual({ repoMap: null, issues: [] });
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it("loads an enabled project section with an explicit cap", async () => {
    const fs = configFs({
      "/ws/.anycode/config.json": JSON.stringify({ repoMap: { enabled: true, maxTokens: 750 } }),
    });
    expect(await loadRepoMapConfig(fs, "/ws", "/home", {})).toEqual({
      repoMap: { enabled: true, maxTokens: 750 }, issues: [],
    });
  });

  it.each([
    [1, 500],
    [99_999, 8_000],
  ])("clamps maxTokens=%s to %s", async (configured, expected) => {
    const fs = configFs({
      "/ws/.anycode/config.json": JSON.stringify({ repoMap: { enabled: true, maxTokens: configured } }),
    });
    expect((await loadRepoMapConfig(fs, "/ws", "/home", {})).repoMap?.maxTokens).toBe(expected);
  });

  it("fails soft on invalid claimed config", async () => {
    const result = await loadRepoMapConfig(
      configFs({ "/ws/.anycode/config.json": JSON.stringify({ repoMap: { enabled: true, maxTokens: 1.5 } }) }),
      "/ws", "/home", {},
    );
    expect(result.repoMap).toBeNull();
    expect(result.issues[0]).toContain("Invalid repo-map config");
  });
});
