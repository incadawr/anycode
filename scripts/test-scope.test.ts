import { describe, expect, it } from "vitest";
import { planScope } from "./test-scope.mjs";

describe("development test scope", () => {
  it("selects the renderer suite and cross-scope readers for renderer source and CSS", () => {
    const plan = planScope(["apps/desktop/src/renderer/src/app.css", "apps/desktop/src/renderer/src/components/Sidebar.tsx"]);
    expect(plan.mode).toBe("renderer");
    expect(plan.always).toContain("apps/desktop/src/renderer/renderer-core-import-guard.test.ts");
    expect(plan.always).toContain("apps/desktop/src/main/subagents-ipc.test.ts");
    expect(plan.always).toContain("apps/desktop/src/host/session-reconnect.test.ts");
  });
  it("includes repository checks when renderer tests change", () => {
    expect(planScope(["apps/desktop/src/renderer/src/components/Sidebar.test.ts"]).always).toContain("apps/desktop/src/main/repo-hygiene.test.ts");
  });
  it("falls back for global inputs, other scopes and unknown files", () => {
    for (const path of ["pnpm-lock.yaml", "tsconfig.base.json", "vitest.config.ts", "codex-support.json", "CHANGELOG.md", "apps/desktop/src/shared/protocol.ts", "apps/desktop/src/renderer/src/store.ts", "packages/core/src/index.ts", "apps/desktop/src/renderer/src/components/fixtures/example.ts", "apps/desktop/src/renderer/src/components/pane.fixture.ts", "apps/desktop/src/renderer/src/components/__snapshots__/pane.css", "apps/desktop/src/renderer/src/components/contract.ts", "apps/desktop/src/renderer/src/components/data.config.ts", "apps/desktop/src/renderer/src/components/manifest.ts", "apps/desktop/src/renderer/src/components/package.json", "apps/desktop/src/renderer/src/components/tsconfig.local.ts", "apps/desktop/src/renderer/src/components/vite.custom.ts", "apps/desktop/src/renderer/src/components/electron-builder.ts", "apps/desktop/src/renderer/src/components/data.yaml", "unclassified.txt"]) {
      expect(planScope(["apps/desktop/src/renderer/src/app.css", path]).mode).toBe("full");
    }
  });
  it("falls back for configuration and data path segments while allowing ordinary components", () => {
    for (const path of ["components/config/theme.ts", "components/manifest/entries.ts", "components/data.ts", "components/schema/model.ts", "components/locales/en.ts", "components/generated/view.ts"]) {
      expect(planScope([`apps/desktop/src/renderer/src/${path}`]).mode, path).toBe("full");
    }
    expect(planScope(["apps/desktop/src/renderer/src/components/Sidebar.tsx"]).mode).toBe("renderer");
  });
  it("falls back for deletions and empty diffs", () => {
    expect(planScope([]).mode).toBe("full");
    expect(planScope(["apps/desktop/src/renderer/src/components/Sidebar.tsx"], () => false).mode).toBe("full");
  });
});

it("uses the branch diff and falls back when an untracked input is present", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "scope-runner-"));
  const repo = join(dir, "repo"), calls = join(dir, "calls");
  const script = resolve("scripts/test-scope.mjs");
  try {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "apps/desktop/src/renderer/src"), { recursive: true });
    const css = join(repo, "apps/desktop/src/renderer/src/app.css");
    writeFileSync(css, "a {}\n");
    writeFileSync(join(repo, "global.config.ts"), "original\n");
    mkdirSync(join(repo, "apps/desktop/src/renderer/src/components"), { recursive: true });
    const component = join(repo, "apps/desktop/src/renderer/src/components/Sidebar.tsx");
    writeFileSync(component, "original\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: repo });
    writeFileSync(css, "b {}\n");
    mkdirSync(join(repo, "node_modules/vitest"), { recursive: true });
    writeFileSync(join(repo, "node_modules/vitest/vitest.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.SCOPE_CALLS, process.argv.slice(2).join(" ") + "\\n");');
    const env = { ...process.env, SCOPE_CALLS: calls };
    const run = () => spawnSync(process.execPath, [script, "HEAD"], { cwd: repo, env, encoding: "utf8" });
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("related apps/desktop/src/renderer/src/app.css");
    writeFileSync(calls, "");
    writeFileSync(component, "staged\n");
    execFileSync("git", ["add", "apps/desktop/src/renderer/src/components/Sidebar.tsx"], { cwd: repo });
    writeFileSync(component, "original\n");
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe("run");
    execFileSync("git", ["reset", "-q", "HEAD", "--", "apps/desktop/src/renderer/src/components/Sidebar.tsx"], { cwd: repo });
    writeFileSync(calls, "");
    writeFileSync(join(repo, "global.config.ts"), "staged\n");
    execFileSync("git", ["add", "global.config.ts"], { cwd: repo });
    writeFileSync(join(repo, "global.config.ts"), "original\n");
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe("run");
    execFileSync("git", ["reset", "-q", "HEAD", "--", "global.config.ts"], { cwd: repo });
    writeFileSync(calls, "");
    execFileSync("git", ["rm", "-q", "-f", "apps/desktop/src/renderer/src/app.css"], { cwd: repo });
    mkdirSync(join(repo, "apps/desktop/src/renderer/src"), { recursive: true });
    writeFileSync(css, "replacement\n");
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe("run");
    execFileSync("git", ["reset", "-q", "HEAD", "--", "apps/desktop/src/renderer/src/app.css"], { cwd: repo });
    writeFileSync(calls, "");
    writeFileSync(join(repo, "untracked.txt"), "new input");
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe("run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
