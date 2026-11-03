import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("kills descendants even when the server exits cleanly during cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrate-cleanup-"));
  const bin = join(dir, "fake-codex");
  const pidFile = join(dir, "descendant.pid");
  const parentExit = join(dir, "parent-exit");
  const survivor = join(dir, "survivor");
  writeFileSync(bin, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--experimental'); process.exit(0); }
const descendant = spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survivor)}, 'alive'), 1800); setInterval(() => {}, 1000);\`], { stdio: ['ignore', 'pipe', 'ignore'] });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(parentExit)}, '0'); process.exit(0); });
descendant.stdout.once('data', () => {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'config/read' ? { config: {}, layers: [] } : request.method === 'mcpServerStatus/list' ? { data: [] } : { thread: { id: 'thread', turns: [] } };
    console.log(JSON.stringify({ id: request.id, result }));
  });
});
`);
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync(process.execPath, [resolve("apps/desktop/scripts/codex-orchestrate-probe.mjs"), "--no-inference", "--bin", bin, "--root", join(dir, "root")], { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(parentExit, "utf8")).toBe("0");
    // The descendant would create this file after the grace period if it survived.
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1200)"]);
    expect(existsSync(survivor)).toBe(false);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
