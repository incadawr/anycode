/**

 * precedence across roots, name-claimed-set dedup, MAX_WORKFLOWS cap,
 * root-path dedup (workspace === home loads once), fail-soft readdir/read/JSON/
 * schema errors, name fallback from the file stem, and non-.json/non-file
 * entries being silently ignored.
 *
 * Hermetic: an in-memory fake FileSystemPort (no real disk, no tmpdir).
 */

import { describe, expect, it } from "vitest";
import { discoverWorkflows, type WorkflowRoot } from "./discovery.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { MAX_WORKFLOWS } from "../types/config.js";

// ---------------------------------------------------------------------------
// In-memory fake FileSystemPort (mirrors skills/discovery.test.ts's makeFakeFs).

interface FakeFs {
  fs: FileSystemPort;
  readdirCalls: string[];
  setFile(path: string, content: string): void;
  deleteFile(path: string): void;
  breakReaddir(path: string): void;
  breakReadFile(path: string): void;
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function makeFakeFs(initialFiles: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(
    Object.entries(initialFiles).map(([path, content]) => [normalize(path), content]),
  );
  const brokenReaddirs = new Set<string>();
  const brokenReads = new Set<string>();
  const readdirCalls: string[] = [];

  function isDirectory(path: string): boolean {
    if (files.has(path)) return false;
    const prefix = path === "/" ? "/" : `${path}/`;
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  }

  const fs: FileSystemPort = {
    readFile: async (path) => {
      const n = normalize(path);
      if (brokenReads.has(n)) throw new Error(`EIO: ${path}`);
      const content = files.get(n);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      files.set(normalize(path), content);
    },
    stat: async (path) => {
      const n = normalize(path);
      const content = files.get(n);
      if (content !== undefined) {
        return { size: content.length, mtimeMs: 0, isFile: true, isDirectory: false };
      }
      if (isDirectory(n)) {
        return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    exists: async (path) => {
      const n = normalize(path);
      return files.has(n) || isDirectory(n);
    },
    mkdir: async () => {},
    readdir: async (path) => {
      const n = normalize(path);
      readdirCalls.push(n);
      if (brokenReaddirs.has(n)) throw new Error(`EACCES: ${path}`);
      const prefix = n === "/" ? "/" : `${n}/`;
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [...names];
    },
  };

  return {
    fs,
    readdirCalls,
    setFile: (path, content) => files.set(normalize(path), content),
    deleteFile: (path) => files.delete(normalize(path)),
    breakReaddir: (path) => brokenReaddirs.add(normalize(path)),
    breakReadFile: (path) => brokenReads.add(normalize(path)),
  };
}

function workflowJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    description: "A demo workflow",
    steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "${input}" }],
    ...overrides,
  });
}

const PROJECT_ROOT = "/proj/.anycode/workflows";
const USER_ROOT = "/home/u/.anycode/workflows";

describe("discoverWorkflows — precedence, dedup, validation", () => {
  it("discovers workflows from project and user roots, tagging each with its source", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/proj-flow.json`]: workflowJson({ name: "proj-flow" }),
      [`${USER_ROOT}/user-flow.json`]: workflowJson({ name: "user-flow" }),
    });
    const roots: WorkflowRoot[] = [
      { dir: PROJECT_ROOT, source: "project" },
      { dir: USER_ROOT, source: "user" },
    ];

    const { workflows, problems } = await discoverWorkflows(fs, roots);
    expect(problems).toEqual([]);
    const byName = new Map(workflows.map((w) => [w.name, w]));
    expect(byName.get("proj-flow")).toMatchObject({ source: "project" });
    expect(byName.get("user-flow")).toMatchObject({ source: "user" });
    expect(workflows).toHaveLength(2);
  });

  it("shadows a lower-precedence duplicate name silently (claimed-set semantics, no problem)", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/shared.json`]: workflowJson({ name: "shared", description: "project wins" }),
      [`${USER_ROOT}/shared.json`]: workflowJson({ name: "shared", description: "user loses" }),
    });
    const roots: WorkflowRoot[] = [
      { dir: PROJECT_ROOT, source: "project" },
      { dir: USER_ROOT, source: "user" },
    ];

    const { workflows, problems } = await discoverWorkflows(fs, roots);
    expect(problems).toEqual([]);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({ name: "shared", source: "project", description: "project wins" });
  });

  it("falls back to the file stem when name is omitted", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/my-flow.json`]: workflowJson(),
    });
    const { workflows } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe("my-flow");
    expect(workflows[0]?.path).toBe(`${PROJECT_ROOT}/my-flow.json`);
  });

  it("skips + reports a problem for invalid JSON", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/broken.json`]: "{ not valid json",
    });
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.json");
  });

  it("skips + reports a problem for a schema violation, other definitions survive", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/bad.json`]: JSON.stringify({ steps: [] }), // missing description + zero steps
      [`${PROJECT_ROOT}/fine.json`]: workflowJson({ name: "fine" }),
    });
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows.map((w) => w.name)).toEqual(["fine"]);
    expect(problems).toHaveLength(1);
  });

  it("skips + reports a problem for a dependency cycle, other definitions survive", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ROOT}/cyclic.json`]: workflowJson({
        name: "cyclic",
        steps: [
          { id: "a", agentType: "general-purpose", promptTemplate: "x", dependsOn: ["b"] },
          { id: "b", agentType: "general-purpose", promptTemplate: "y", dependsOn: ["a"] },
        ],
      }),
      [`${PROJECT_ROOT}/fine.json`]: workflowJson({ name: "fine" }),
    });
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows.map((w) => w.name)).toEqual(["fine"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cycle");
  });

  it("caps the total at MAX_WORKFLOWS after dedup and reports one overflow problem", async () => {
    const files: Record<string, string> = {};
    const total = MAX_WORKFLOWS + 5;
    for (let i = 0; i < total; i += 1) {
      const fileName = `flow-${String(i).padStart(3, "0")}`;
      files[`${PROJECT_ROOT}/${fileName}.json`] = workflowJson({ name: fileName });
    }
    const { fs } = makeFakeFs(files);
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows).toHaveLength(MAX_WORKFLOWS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(String(total - MAX_WORKFLOWS));
    expect(workflows.map((w) => w.name)).toContain("flow-000");
    expect(workflows.map((w) => w.name)).not.toContain(`flow-${String(total - 1).padStart(3, "0")}`);
  });

  it("silently ignores non-.json entries and non-file entries", async () => {
    const { fs, setFile } = makeFakeFs({
      [`${PROJECT_ROOT}/real-flow.json`]: workflowJson({ name: "real-flow" }),
      [`${PROJECT_ROOT}/notes.txt`]: "not a workflow",
    });
    setFile(`${PROJECT_ROOT}/stray-dir.json/inner.txt`, "a directory that happens to end in .json");
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(problems).toEqual([]);
    expect(workflows.map((w) => w.name)).toEqual(["real-flow"]);
  });

  it("loads a root directory only once when two roots resolve to the identical path (workspace === home)", async () => {
    const { fs, readdirCalls } = makeFakeFs({
      [`${PROJECT_ROOT}/only-flow.json`]: workflowJson({ name: "only-flow" }),
    });
    const roots: WorkflowRoot[] = [
      { dir: PROJECT_ROOT, source: "project" },
      { dir: PROJECT_ROOT, source: "user" },
    ];
    const { workflows } = await discoverWorkflows(fs, roots);
    expect(workflows).toHaveLength(1);
    expect(readdirCalls.filter((p) => p === normalize(PROJECT_ROOT))).toHaveLength(1);
  });

  it("is a zero-cost no-op when a root directory does not exist", async () => {
    const { fs, readdirCalls } = makeFakeFs({});
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows).toEqual([]);
    expect(problems).toEqual([]);
    expect(readdirCalls).toEqual([]);
  });

  it("fail-soft: a readdir error on an existing root is reported, discovery does not throw", async () => {
    const { fs, breakReaddir } = makeFakeFs({
      [`${PROJECT_ROOT}/placeholder.json`]: workflowJson(),
    });
    breakReaddir(PROJECT_ROOT);
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PROJECT_ROOT);
  });

  it("fail-soft: a readFile error on a discovered definition is reported, other definitions survive", async () => {
    const { fs, breakReadFile } = makeFakeFs({
      [`${PROJECT_ROOT}/broken.json`]: workflowJson({ name: "broken" }),
      [`${PROJECT_ROOT}/fine.json`]: workflowJson({ name: "fine" }),
    });
    breakReadFile(`${PROJECT_ROOT}/broken.json`);
    const { workflows, problems } = await discoverWorkflows(fs, [{ dir: PROJECT_ROOT, source: "project" }]);
    expect(workflows.map((w) => w.name)).toEqual(["fine"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.json");
  });
});
