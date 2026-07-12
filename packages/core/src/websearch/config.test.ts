/**
 * config.test.ts (slice 6.3 A5): loadWebSearchConfig — the single-object
 * `webSearch` section of .anycode/config.json, project-wins-WHOLESALE

 * invalid JSON / bad shape / business-rule violations (issues collected,
 * loader never throws).
 */

import { describe, expect, it } from "vitest";
import { loadWebSearchConfig } from "./config.js";
import type { FileSystemPort } from "../ports/file-system.js";

const WORKSPACE = "/proj";
const HOME = "/home/u";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";

function makeFs(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

describe("loadWebSearchConfig — absent", () => {
  it("returns null backend and zero issues silently when no config exists", async () => {
    const result = await loadWebSearchConfig(makeFs({}), WORKSPACE, HOME, {});
    expect(result).toEqual({ backend: null, issues: [] });
  });

  it("treats a config with no webSearch key as absent (silent, falls through)", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ other: true }) });
    const result = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ backend: null, issues: [] });
  });
});

describe("loadWebSearchConfig — brave", () => {
  it("resolves a brave backend and captures the key from env into headers", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "brave", apiKeyEnv: "MY_KEY" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { MY_KEY: "secret-123" });
    expect(issues).toEqual([]);
    expect(backend).toEqual({
      kind: "brave",
      endpoint: "https://api.search.brave.com/res/v1/web/search",
      headers: { "X-Subscription-Token": "secret-123", Accept: "application/json" },
      maxResults: 5,
    });
  });

  it("honors an explicit brave endpoint override", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "brave", apiKeyEnv: "MY_KEY", endpoint: "https://brave.example.com/search" },
      }),
    });
    const { backend } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { MY_KEY: "k" });
    expect(backend?.endpoint).toBe("https://brave.example.com/search");
  });

  it("issue + null when brave has no apiKeyEnv", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "brave" } }) });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/requires "apiKeyEnv"/);
  });

  it("issue + null when apiKeyEnv points at an unset env var", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "brave", apiKeyEnv: "MISSING_KEY" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/env var MISSING_KEY is not set; WebSearch disabled/);
  });

  it("issue + null when apiKeyEnv resolves to an empty string", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "brave", apiKeyEnv: "EMPTY_KEY" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { EMPTY_KEY: "" });
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/env var EMPTY_KEY is not set/);
  });

  it("never leaks the resolved key into an issue string", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "brave", apiKeyEnv: "MY_KEY", endpoint: "ftp://bad.example.com" },
      }),
    });
    const { issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { MY_KEY: "top-secret-value" });
    for (const issue of issues) expect(issue).not.toContain("top-secret-value");
  });
});

describe("loadWebSearchConfig — searxng", () => {
  it("resolves a searxng backend with Accept-only headers (no key)", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://127.0.0.1:8080" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(issues).toEqual([]);
    expect(backend).toEqual({
      kind: "searxng",
      endpoint: "http://127.0.0.1:8080",
      headers: { Accept: "application/json" },
      maxResults: 5,
    });
  });

  it("issue + null when searxng has no endpoint", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng" } }) });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/requires "endpoint"/);
  });
});

describe("loadWebSearchConfig — endpoint validation", () => {
  it("rejects a file:// endpoint", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "searxng", endpoint: "file:///etc/passwd" },
      }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/not a valid http\(s\) URL/);
  });

  it("rejects an ftp:// endpoint", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "brave", apiKeyEnv: "K", endpoint: "ftp://example.com/search" },
      }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { K: "k" });
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/not a valid http\(s\) URL/);
  });
});

describe("loadWebSearchConfig — maxResults", () => {
  it("defaults to WEBSEARCH_DEFAULT_MAX_RESULTS when omitted", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://localhost:8080" } }),
    });
    const { backend } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend?.maxResults).toBe(5);
  });

  it("honors an explicit maxResults up to the hard cap", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "searxng", endpoint: "http://localhost:8080", maxResults: 10 },
      }),
    });
    const { backend } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend?.maxResults).toBe(10);
  });

  it("rejects (schema violation) a maxResults above the hard cap", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        webSearch: { backend: "searxng", endpoint: "http://localhost:8080", maxResults: 999 },
      }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/Invalid WebSearch config/);
  });
});

describe("loadWebSearchConfig — malformed JSON", () => {
  it("records an issue and falls through to the user config on invalid project JSON", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: "{ not json",
      [USER_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://localhost:8080" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend?.kind).toBe("searxng");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/Invalid JSON in WebSearch config \/proj\/\.anycode\/config\.json/);
  });

  it("yields null + one issue when project JSON is invalid and no user config exists", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: "{ not json" });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues).toHaveLength(1);
  });
});

describe("loadWebSearchConfig — schema violation shape", () => {
  it("issue + null when the section is not an object", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ webSearch: "brave" }) });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/Invalid WebSearch config/);
  });

  it("issue + null when backend is not brave/searxng", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "google" } }) });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues[0]).toMatch(/Invalid WebSearch config/);
  });
});

describe("loadWebSearchConfig — project wins WHOLESALE (R3)", () => {
  it("uses the project's backend outright when both sources define the section", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://project:8080" } }),
      [USER_CONFIG]: JSON.stringify({ webSearch: { backend: "brave", apiKeyEnv: "USER_KEY" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, { USER_KEY: "k" });
    expect(issues).toEqual([]);
    expect(backend?.kind).toBe("searxng");
    expect(backend?.endpoint).toBe("http://project:8080");
  });

  it("does NOT fall back to a valid user section when the project's section is present but invalid", async () => {
    const fs = makeFs({
      // project claims the key by having it present, even though it fails its own business rule (no apiKeyEnv)
      [PROJECT_CONFIG]: JSON.stringify({ webSearch: { backend: "brave" } }),
      [USER_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://user:8080" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(backend).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/requires "apiKeyEnv"/);
  });

  it("falls through to user config when the project file has no webSearch key at all", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ unrelated: true }),
      [USER_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://user:8080" } }),
    });
    const { backend, issues } = await loadWebSearchConfig(fs, WORKSPACE, HOME, {});
    expect(issues).toEqual([]);
    expect(backend?.endpoint).toBe("http://user:8080");
  });

  it("does not double-read when workspace and home resolve to the same path", async () => {
    let reads = 0;
    const files: Record<string, string> = {
      [USER_CONFIG]: JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://localhost:8080" } }),
    };
    const fs: FileSystemPort = {
      ...makeFs(files),
      readFile: async (path) => {
        reads += 1;
        const c = files[path];
        if (c === undefined) throw new Error("ENOENT");
        return c;
      },
    };
    const { backend } = await loadWebSearchConfig(fs, HOME, HOME, {});
    expect(backend?.kind).toBe("searxng");
    expect(reads).toBe(1);
  });
});
