#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, delimiter } from "node:path";

const renderer = "apps/desktop/src/renderer/src/";
const always = [
  "apps/desktop/src/renderer/renderer-core-import-guard.test.ts",
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
    !/(?:^|\/)(?:[^/]*config[^/]*|[^/]*manifest[^/]*|package\.json|tsconfig[^/]*|vite[^/]*|vitest[^/]*|electron-builder[^/]*|[^/]*\.(?:json|jsonl|ya?ml))$/i.test(file) &&
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
    const changes = [];
    for (const args of [[base, "HEAD"], ["--cached"], []]) {
      const fields = execFileSync("git", ["diff", "--name-status", "-z", ...args, "--"], { cwd: root, encoding: "utf8" }).split("\0");
      while (fields[0]) {
        const status = fields.shift();
        const path = fields.shift();
        changes.push({ status, path });
        if (/^[RC]/.test(status)) changes.push({ status, path: fields.shift() });
      }
    }
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
    files = [...new Set([...changes.map((change) => change.path), ...untracked.split("\0").filter(Boolean)])];
    if (changes.some(({ status }) => /^[DRC]/.test(status))) files.push("");
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
