/** Opt-in, free-only live probe. Credentials stay inside this process. Run with tsx. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isFreeChatGoModel } from "./lib/opencode-go-live-safety.mjs";

if (!process.argv.includes("--live") || !process.argv.includes("--free-only")) throw new Error("Pass --live --free-only to run this probe");
const commonGit = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
const secretPath = join(dirname(resolve(commonGit)), ".smoke-secrets", "opencode-go.env");
let secretFile;
try { secretFile = readFileSync(secretPath, "utf8"); } catch { console.log("SKIP: isolated Go smoke credential is unavailable"); process.exit(0); }
const secrets = Object.create(null);
for (const line of secretFile.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match) continue;
  const raw = match[2];
  secrets[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
}
const apiKey = secrets.OPENCODE_GO_API_KEY ?? secrets.OPENCODE_API_KEY ?? secrets.ANYCODE_API_KEY ?? secrets.API_KEY ?? secrets.KEY;
if (!apiKey) { console.log("SKIP: isolated Go smoke credential is unavailable"); process.exit(0); }

const profile = mkdtempSync(join(tmpdir(), "anycode-go-live-"));
for (const key of Object.keys(process.env)) if (key.startsWith("ANYCODE_") || key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR") delete process.env[key];
process.env.ANYCODE_USER_DATA_DIR = join(profile, "user-data");
process.env.ANYCODE_SETTINGS_PATH = join(profile, "settings.json");
process.env.ANYCODE_SECRETS_PATH = join(profile, "secrets.json");
process.env.ANYCODE_DB_PATH = join(profile, "db.sqlite");
process.env.CODEX_HOME = join(profile, "codex-home");
process.env.CLAUDE_CONFIG_DIR = join(profile, "claude-home");

const modelIds = ["beam-free", "iceman-contributor-free"];
const modelsUrl = "https://opencode.ai/inference/go/v1/models";
const chatUrl = "https://opencode.ai/inference/go/openai/v1/chat/completions";
const originalFetch = globalThis.fetch;
let status;
let allowedModel;
let posts = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === modelsUrl && (init.method ?? "GET") === "GET") return originalFetch(input, { ...init, redirect: "error" });
  if (url !== chatUrl || init.method !== "POST" || !allowedModel || ++posts > 1) throw new Error("Blocked unapproved request");
  const body = JSON.parse(String(init.body));
  if (body.model !== allowedModel || !Number.isFinite(body.max_tokens) || body.max_tokens > 64 || body.tools?.length) throw new Error("Blocked unexpected request body");
  const response = await originalFetch(input, { ...init, redirect: "error" });
  status = response.status;
  return response;
};

try {
  const listing = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!listing.ok) { console.log(`STOP: model listing HTTP ${listing.status}`); process.exitCode = 1; }
  else {
    const raw = await listing.json();
    const rows = Array.isArray(raw.data) ? raw.data : [];
    const free = id => {
      const matches = rows.filter(row => row.id === id);
      if (matches.length !== 1) return false;
      return isFreeChatGoModel(matches[0]);
    };
    if (!modelIds.every(free)) { console.log("STOP: current listing does not confirm both models are free on the approved door"); process.exitCode = 1; }
    else {
      const { parseOpenCodeGoSnapshot } = await import("../packages/core/src/provider/model-route.ts");
      const { applyAutomaticModelRoute } = await import("../packages/core/src/provider/endpoint.ts");
      const { AiSdkModelPort } = await import("../packages/core/src/provider/model-port.ts");
      const { findCatalogEntry } = await import("../packages/core/src/provider/catalog-data.ts");
      const { resolveProviderHeaders } = await import("../packages/core/src/provider/session-headers.ts");
      const headers = resolveProviderHeaders(findCatalogEntry("opencode"), randomUUID(), "0.0.77");
      const snapshot = parseOpenCodeGoSnapshot(raw, new Date().toISOString());
      if (!snapshot.ok) throw new Error("Invalid model listing");
      for (const model of modelIds) {
        allowedModel = model; posts = 0; status = undefined;
        const config = applyAutomaticModelRoute({ providerId: "opencode", automaticModelRouting: true, transport: "openai-chat-completions", baseUrl: "https://invalid.test", apiKey, model, headers, includeUsage: false, retry: { maxRetries: 0, stallTimeoutMs: 0 } }, snapshot.snapshot);
        let finish;
        try {
          for await (const event of new AiSdkModelPort(config).streamText({ messages: [{ role: "user", content: "Reply OK." }], tools: [], maxOutputTokens: 64, abortSignal: AbortSignal.timeout(30_000) })) if (event.type === "finish") finish = event;
        } catch { /* report status only; provider errors may include credentials */ }
        console.log(`${model} /openai/v1/chat/completions status=${status ?? "unavailable"} finish=${finish?.finishReason ?? "unavailable"} usage=${finish?.usage?.totalTokens ?? "unavailable"}`);
        if (!status || status < 200 || status >= 300 || !finish) { process.exitCode = 1; break; }
      }
    }
  }
} catch { console.log("STOP: live probe could not complete"); process.exitCode = 1; }
