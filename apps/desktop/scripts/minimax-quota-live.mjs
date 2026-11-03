import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMiniMaxQuota } from "../src/main/minimax-quota-adapter.ts";

let stage = "credential";
try {
  const contents = await readFile(join(homedir(), "projects/tools/anycode/.smoke-secrets/minimax.env"), "utf8");
  const key = contents.match(/sk-cp-[A-Za-z0-9_-]+/)?.[0];
  if (!key) throw new Error();
  stage = "request";
  const response = await fetch("https://www.minimax.io/v1/token_plan/remains", { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  stage = "response";
  if (!response.ok) throw new Error();
  const quota = parseMiniMaxQuota(await response.json());
  if (!quota?.primary) throw new Error();
  for (const [name, window] of [["5h", quota.primary], ["weekly", quota.secondary]]) {
    if (window) console.log(`${name}: ${100 - window.usedPercent}% remaining, reset minutes: ${window.resetsAt ? Math.round((window.resetsAt * 1000 - Date.now()) / 60_000) : "unavailable"}`);
  }
} catch {
  console.error(`MiniMax quota live check failed at ${stage}`);
  process.exitCode = 1;
}
