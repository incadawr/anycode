import { writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);

function flagValue(prefix) {
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

if (args.includes("--version")) {
  if (args.includes("--bad-version")) process.stdout.write("2.1.0 (Claude Code)\n");
  else if (args.includes("--hang-version")) setInterval(() => {}, 1_000);
  else process.stdout.write("2.1.212 (Claude Code)\n");
  if (!args.includes("--hang-version")) process.exit(0);
} else {
  if (args.includes("--malformed")) process.stdout.write("not-json\n");
  if (args.includes("--oversize")) process.stdout.write(`${"x".repeat(4_096)}\n`);

  const pidFile = flagValue("--pid-file=");
  if (args.includes("--stubborn-group")) {
    // A grandchild that ignores SIGTERM: only a process-GROUP SIGKILL ends it
    // (mirrors codex/test-child.mjs's forkStubbornGrandchild, duplicated —
    // the two CLIs' fake children share no code, cut §1.3 "duplicated on purpose").
    process.on("SIGTERM", () => {});
    const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    if (pidFile && grandchild.pid !== undefined) writeFileSync(pidFile, String(grandchild.pid));
  }

  const slowExitMs = flagValue("--slow-exit-ms=");
  if (slowExitMs !== undefined) {
    process.stdin.on("end", () => {
      setTimeout(() => process.exit(0), Number(slowExitMs));
    });
  }

  const fixturePath = flagValue("--fixture=");
  if (fixturePath !== undefined) {
    // Generic envelope-fixture ({t_ms,dir,raw}) VCR: replays every "out" line
    // (CLI -> host) in order, blocking on each "in" line (host -> CLI) until a
    // real line arrives on stdin. Because the REAL client generates its own
    // request_id (not the W0 harness's recorded one), every "in" control_request
    // we consume records fixtureId -> realId, and every subsequent "out" line is
    // rewritten before emission — this makes any of the 19 envelope fixtures
    // byte-for-byte replayable against a live client, not just a fixed script.
    const entries = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.dir === "in" || entry.dir === "out");

    const idMap = new Map();
    let cursor = 0;

    function substitute(node) {
      if (typeof node === "string") return idMap.has(node) ? idMap.get(node) : node;
      if (Array.isArray(node)) return node.map(substitute);
      if (node !== null && typeof node === "object") {
        const out = {};
        for (const [key, value] of Object.entries(node)) out[key] = substitute(value);
        return out;
      }
      return node;
    }

    function pump() {
      while (cursor < entries.length && entries[cursor].dir === "out") {
        process.stdout.write(`${JSON.stringify(substitute(entries[cursor].raw))}\n`);
        cursor++;
      }
    }

    pump();

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (cursor >= entries.length || entries[cursor].dir !== "in") return;
      let received;
      try {
        received = JSON.parse(line);
      } catch {
        return;
      }
      const expected = entries[cursor].raw;
      if (
        typeof expected === "object" && expected !== null && typeof expected.request_id === "string" &&
        typeof received === "object" && received !== null && typeof received.request_id === "string"
      ) {
        idMap.set(expected.request_id, received.request_id);
      }
      cursor++;
      pump();
    });
  }
}
