#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, delimiter } from "node:path";

const renderer = "apps/desktop/src/renderer/src/";
const always = [
  "apps/desktop/src/main/subagents-ipc.test.ts",
  "apps/desktop/src/main/repo-hygiene.test.ts",
  "apps/desktop/src/main/workflow-map-smoke-assertions.test.ts",
  "apps/desktop/src/host/session-reconnect.test.ts",
  "apps/desktop/src/host/session-reconnect-defects.test.ts",
  "scripts/usage-rollup.test.ts",
];

// Unknown inputs deliberately fall back to the full suite.
export function planScope(files, exists = () => true) {
  const eligible = files.length > 0 && files.every((file) =>
    file.startsWith(renderer) && /\.(?:ts|tsx|css)$/.test(file) &&
    (file.startsWith(`${renderer}components/`) || /\.css$/.test(file)) &&
    !/(?:^|[\/._-])(?:__)?(?:fixtures?|snapshots?|contracts?|protocols?)(?:__)?(?:[\/._-]|$)/i.test(file) && exists(file));
  return eligible ? { mode: "renderer", always: [...always] } : { mode: "full", always: [] };
}

function main() {
  const base = process.argv[2];
  if (!base || base.startsWith("-")) {
    console.error("Usage: node scripts/test-scope.mjs <base-ref>");
    return 2;
  }
  let root, files;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const changed = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "--"], { cwd: root, encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
    files = [...new Set((changed + untracked).split("\0").filter(Boolean))];
  } catch (error) {
    console.error("Cannot determine changed files:", error.message);
    return 2;
  }
  const plan = planScope(files, (file) => existsSync(`${root}/${file}`));
  const commands = plan.mode === "full" ? [["run"]] : [
    ["run", "--maxWorkers=4", renderer, ...plan.always],
    ["related", ...files, "--run", "--passWithNoTests", "--maxWorkers=4"],
  ];
  console.log(`Scope: ${plan.mode}; changed files: ${files.length}`);
  for (const args of commands) {
    console.log(`Running: vitest ${args.join(" ")}`);
    const env = { ...process.env, PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` };
    const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), ...args], { cwd: root, stdio: "inherit", env });
    if (result.error || result.status !== 0) {
      if (result.error) console.error(result.error.message);
      return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
