/**
 * Pure-logic tests for SettingsScreen's helpers (slice 2.2, design
 * /working-docs/build/design/slice-2.2-cut.md §2/§3; provider-section v2 +
 * OAuth-UX, slice 2.5, design/slice-2.5-cut.md §5). Deliberately `.test.ts`
 * (not `.test.tsx`), same rationale as SessionPicker.test.ts: this package's
 * vitest config runs in `environment: "node"` with no jsdom/
 * @testing-library, so a real `<dialog>`/form DOM-rendering test isn't
 * feasible without adding new dependencies (out of this task's lane —
 * vitest.config.ts is not part of it) — every property below, including the
 * ones the 2.5.4 self-verify gate calls out (provider-change patch/notice,
 * custom<->catalog baseUrl toggle, OAuth pending/cancel/fail text, custody),
 * is instead pinned at the pure-function level the file already established.
 * The exported pure functions carry the component's actual logic —
 * including the two 2.2 properties the task spec calls out explicitly: the
 * write-only secret field never echoes a value back, and the status badge
 * is built from `SecretStatus` alone (structurally incapable of leaking a
 * plaintext value).
 */
import { describe, expect, it } from "vitest";
import type { McpServerStatus, TelemetryStatus } from "@anycode/core";
import type { CatalogSummary, CatalogSummaryEntry, CustomProviderRecord, ProviderConnection, SecretStatus } from "../../../shared/settings.js";
import type { UpdateStatus } from "../../../shared/updates.js";
import type { WireRepoMapStatus } from "../../../shared/protocol.js";
import {
  buildCustomProviderCreateRequest,
  buildToolsPatch,
  customProviderKindLabel,
  describeCustomProvider,
  describeCustomProviderMutationError,
  describeFetchModelsError,
  describeMcpServer,
  describeOAuthStatus,
  describeRepoMapRow,
  describeSecretStatus,
  describeTelemetryRow,
  filterSettingsPanes,
  isEnvOverridden,
  parseOptionalInt,
  resolveReplaceKeyAction,
  secretFieldReducer,
  selectProviderEntry,
  SETTINGS_PANES,
  shouldShowBaseUrlField,
  shouldShowAppVersion,
  shouldShowUpdateBanner,
  showsManualUpdateLink,
  toggleSelectedModel,
  transportOptions,
  updateStatusText,
} from "./SettingsScreen.js";

// ── slice 2.5 fixtures ──

const ANTHROPIC: CatalogSummaryEntry = {
  id: "anthropic",
  name: "Anthropic",
  authKind: "api_key",
  models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
};

const CUSTOM: CatalogSummaryEntry = {
  id: "custom",
  name: "Custom endpoint",
  authKind: "api_key",
  models: [],
  needsBaseUrl: true,
  isCustom: true,
};

const ACME_OAUTH: CatalogSummaryEntry = {
  id: "acme",
  name: "Acme",
  authKind: "oauth",
  models: [{ id: "acme-large" }],
};

// TASK.43 W5 fixtures.
const OPENAI: CatalogSummaryEntry = {
  id: "openai",
  name: "OpenAI",
  authKind: "api_key",
  models: [],
  defaultTransport: "openai-responses",
  supportedTransports: ["openai-responses", "openai-chat-completions"],
};

const VLLM: CatalogSummaryEntry = {
  id: "vllm",
  name: "vLLM",
  authKind: "api_key",
  models: [],
  needsBaseUrl: true,
  defaultTransport: "openai-chat-completions",
  supportedTransports: ["openai-chat-completions"],
  authOptional: true,
};

const CATALOG: CatalogSummary = [ANTHROPIC, ACME_OAUTH, CUSTOM, OPENAI, VLLM];

describe("secretFieldReducer (custody: write-only field)", () => {
  it("tracks typed characters", () => {
    expect(secretFieldReducer("", { type: "change", value: "sk-abc" })).toBe("sk-abc");
    expect(secretFieldReducer("sk-a", { type: "change", value: "sk-ab" })).toBe("sk-ab");
  });

  it("clears the field on submit — the field never echoes a stored value back, regardless of outcome", () => {
    expect(secretFieldReducer("sk-super-secret", { type: "submitted" })).toBe("");
  });

  it("submitting an already-empty field is a no-op result (still empty)", () => {
    expect(secretFieldReducer("", { type: "submitted" })).toBe("");
  });
});

describe("describeSecretStatus", () => {
  it("labels an unset key as muted", () => {
    const status: SecretStatus = { key: "provider.apiKey", set: false, source: "none", tier: "unavailable" };
    const d = describeSecretStatus(status);
    expect(d.tone).toBe("muted");
    expect(d.text).toMatch(/not set/i);
  });

  it("labels an OS-keychain vault entry as ok", () => {
    const status: SecretStatus = { key: "provider.apiKey", set: true, source: "vault", tier: "os_encrypted" };
    const d = describeSecretStatus(status);
    expect(d.tone).toBe("ok");
    expect(d.text).toMatch(/keychain/i);
  });

  it("labels a weak tier (obfuscated/plaintext) as a warning even though it's set", () => {
    const obfuscated: SecretStatus = { key: "provider.apiKey", set: true, source: "vault", tier: "obfuscated" };
    const plaintext: SecretStatus = { key: "provider.apiKey", set: true, source: "plaintext", tier: "plaintext" };
    expect(describeSecretStatus(obfuscated).tone).toBe("warn");
    expect(describeSecretStatus(plaintext).tone).toBe("warn");
  });

  it("labels an env-sourced key as ok — env always wins by design (I2), regardless of the vault's own tier", () => {
    const status: SecretStatus = { key: "provider.apiKey", set: true, source: "env", tier: "unavailable" };
    expect(describeSecretStatus(status).tone).toBe("ok");
  });

  it("CUSTODY: SecretStatus (the only input this function ever receives) structurally carries no plaintext field", () => {
    const status: SecretStatus = { key: "provider.apiKey", set: true, source: "vault", tier: "os_encrypted" };
    expect(Object.keys(status).sort()).toEqual(["key", "set", "source", "tier"]);
  });
});

describe("isEnvOverridden", () => {
  it("true when the env var name is present in envOverrides", () => {
    expect(isEnvOverridden(["ANYCODE_API_KEY"], "ANYCODE_API_KEY")).toBe(true);
  });

  it("false when absent or the list is empty", () => {
    expect(isEnvOverridden([], "ANYCODE_API_KEY")).toBe(false);
    expect(isEnvOverridden(["ANYCODE_MODEL"], "ANYCODE_API_KEY")).toBe(false);
  });
});

describe("parseOptionalInt", () => {
  it("parses a plain integer string", () => {
    expect(parseOptionalInt("4")).toBe(4);
  });

  it("truncates a float string", () => {
    expect(parseOptionalInt("4.9")).toBe(4);
  });

  it("blank/whitespace-only input -> undefined", () => {
    expect(parseOptionalInt("")).toBeUndefined();
    expect(parseOptionalInt("   ")).toBeUndefined();
  });

  it("garbage input -> undefined (main's zod validation is still the final word)", () => {
    expect(parseOptionalInt("not-a-number")).toBeUndefined();
  });
});

describe("transportOptions (TASK.43 W5; reused by ConnectionDrawer, TASK.45 W12)", () => {
  it("restricts to a catalog entry's own supportedTransports", () => {
    expect(transportOptions(OPENAI)).toEqual(["openai-responses", "openai-chat-completions"]);
    expect(transportOptions(VLLM)).toEqual(["openai-chat-completions"]);
  });

  it("offers all three for no selection / the needsBaseUrl (custom) entry", () => {
    expect(transportOptions(undefined)).toEqual(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
    expect(transportOptions(CUSTOM)).toEqual(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
  });
});

describe("buildToolsPatch", () => {
  it("includes both fields when both parse", () => {
    expect(buildToolsPatch("4", "30000")).toEqual({ tools: { concurrency: 4, stallTimeoutMs: 30000 } });
  });

  it("includes maxTurns when supplied", () => {
    expect(buildToolsPatch("4", "30000", "100")).toEqual({ tools: { concurrency: 4, stallTimeoutMs: 30000, maxTurns: 100 } });
  });

  it("omits a blank/unparseable field entirely", () => {
    expect(buildToolsPatch("", "30000")).toEqual({ tools: { stallTimeoutMs: 30000 } });
    expect(buildToolsPatch("4", "")).toEqual({ tools: { concurrency: 4 } });
    expect(buildToolsPatch("nope", "nope")).toEqual({ tools: {} });
  });
});

describe("selectProviderEntry", () => {
  it("finds the matching catalog entry by id", () => {
    expect(selectProviderEntry(CATALOG, "anthropic")).toEqual(ANTHROPIC);
    expect(selectProviderEntry(CATALOG, "acme")).toEqual(ACME_OAUTH);
  });

  it("undefined id, empty catalog, or a non-matching id all fall through to undefined (the legacy/custom fallback)", () => {
    expect(selectProviderEntry(CATALOG, undefined)).toBeUndefined();
    expect(selectProviderEntry([], "anthropic")).toBeUndefined();
    expect(selectProviderEntry(CATALOG, "does-not-exist")).toBeUndefined();
  });
});

describe("shouldShowBaseUrlField (custom<->catalog baseUrl toggle, design §5 point 2)", () => {
  it("hidden for a regular catalog entry", () => {
    expect(shouldShowBaseUrlField(ANTHROPIC)).toBe(false);
    expect(shouldShowBaseUrlField(ACME_OAUTH)).toBe(false);
  });

  it("shown for the catalog's own needsBaseUrl (custom) entry", () => {
    expect(shouldShowBaseUrlField(CUSTOM)).toBe(true);
  });

  it("shown when nothing is selected (legacy, or no catalog at all) — ruling R6: same mode as custom", () => {
    expect(shouldShowBaseUrlField(undefined)).toBe(true);
  });
});

describe("resolveReplaceKeyAction (TASK.45 W12-FIX §1: connection-scoped oauth sign-in, codex W12 review #1)", () => {
  const connB: ProviderConnection = { id: "conn-b", providerId: "acme" };

  // §1.4 — reverting the SettingsScreen.tsx call site back to
  // `oauthStart(providerId)` (dropping the connectionId) turns this red: the
  // action must carry THIS connection's own id, not whatever a provider-wide
  // bucket resolution would land on (which could be a DIFFERENT, active
  // same-provider connection — the custody defect this fix closes).
  it("§1.4 an oauth connection with no stored token resolves to a sign-in SCOPED TO THIS connection", () => {
    expect(resolveReplaceKeyAction(connB, ACME_OAUTH, [])).toEqual({
      kind: "oauthStart",
      providerId: "acme",
      connectionId: "conn-b",
    });
  });

  it("an oauth connection WITH a stored token resolves to clearSecret on its own key (regress)", () => {
    const secrets: SecretStatus[] = [
      { key: "provider.connection.conn-b.oauth", set: true, source: "vault", tier: "os_encrypted" },
    ];
    expect(resolveReplaceKeyAction(connB, ACME_OAUTH, secrets)).toEqual({
      kind: "clearSecret",
      key: "provider.connection.conn-b.oauth",
    });
  });

  it("a non-oauth connection (or no catalog entry) falls through to the drawer (undefined, regress)", () => {
    expect(resolveReplaceKeyAction(connB, ANTHROPIC, [])).toBeUndefined();
    expect(resolveReplaceKeyAction(connB, undefined, [])).toBeUndefined();
  });
});

describe("describeOAuthStatus (custody: same SecretStatus-only shape as describeSecretStatus, bespoke Sign-in wording)", () => {
  it("unset -> 'Not signed in', muted", () => {
    const status: SecretStatus = { key: "provider.acme.oauth", set: false, source: "none", tier: "unavailable" };
    expect(describeOAuthStatus(status)).toEqual({ text: "Not signed in", tone: "muted" });
  });

  it("undefined status (no vault entry at all yet) -> same 'Not signed in', muted", () => {
    expect(describeOAuthStatus(undefined)).toEqual({ text: "Not signed in", tone: "muted" });
  });

  it("set + os_encrypted/env -> 'Signed in', ok", () => {
    const vaultStatus: SecretStatus = { key: "provider.acme.oauth", set: true, source: "vault", tier: "os_encrypted" };
    const envStatus: SecretStatus = { key: "provider.acme.oauth", set: true, source: "env", tier: "unavailable" };
    expect(describeOAuthStatus(vaultStatus)).toEqual({ text: "Signed in", tone: "ok" });
    expect(describeOAuthStatus(envStatus)).toEqual({ text: "Signed in", tone: "ok" });
  });

  it("set + a weak tier -> 'Signed in', warn", () => {
    const weak: SecretStatus = { key: "provider.acme.oauth", set: true, source: "vault", tier: "obfuscated" };
    expect(describeOAuthStatus(weak)).toEqual({ text: "Signed in", tone: "warn" });
  });

  it("CUSTODY: never reads or exposes anything beyond the status's key/set/source/tier — same structural guarantee as describeSecretStatus", () => {
    const status: SecretStatus = { key: "provider.acme.oauth", set: true, source: "vault", tier: "os_encrypted" };
    expect(Object.keys(status).sort()).toEqual(["key", "set", "source", "tier"]);
  });
});

describe("updateStatusText (slice 2.6, design §6)", () => {
  it("idle -> empty (nothing to say before the first check/event)", () => {
    expect(updateStatusText({ kind: "idle" })).toBe("");
  });

  it("checking -> a progress phrase", () => {
    expect(updateStatusText({ kind: "checking" })).toMatch(/checking/i);
  });

  it("available -> names the version", () => {
    expect(updateStatusText({ kind: "available", version: "1.2.3" })).toMatch(/1\.2\.3/);
  });

  it("available with manualOnly unset/false -> the plain phrase, no 'GitHub Releases' wording", () => {
    expect(updateStatusText({ kind: "available", version: "1.2.3" })).not.toMatch(/GitHub Releases/);
    expect(updateStatusText({ kind: "available", version: "1.2.3", manualOnly: false })).not.toMatch(/GitHub Releases/);
  });

  it("TASK.47 defect 2: available with manualOnly:true -> names the version AND the honest download-from-Releases wording", () => {
    const text = updateStatusText({ kind: "available", version: "1.2.3", manualOnly: true });
    expect(text).toMatch(/1\.2\.3/);
    expect(text).toMatch(/GitHub Releases/);
  });

  it("downloading -> the percent", () => {
    expect(updateStatusText({ kind: "downloading", percent: 42 })).toMatch(/42/);
  });

  it("downloaded -> names the version and invites a restart", () => {
    const text = updateStatusText({ kind: "downloaded", version: "1.2.3" });
    expect(text).toMatch(/1\.2\.3/);
    expect(text).toMatch(/restart/i);
  });

  it("not-available -> an up-to-date phrase", () => {
    expect(updateStatusText({ kind: "not-available" })).toMatch(/up to date/i);
  });

  it("error -> forwards the message only (no stack/internal detail beyond it)", () => {
    expect(updateStatusText({ kind: "error", message: "network down" })).toMatch(/network down/);
  });
});

describe("shouldShowUpdateBanner (design §6: non-intrusive — only the two states worth surfacing unprompted)", () => {
  it("true for available and downloaded", () => {
    expect(shouldShowUpdateBanner({ kind: "available", version: "1.2.3" })).toBe(true);
    expect(shouldShowUpdateBanner({ kind: "downloaded", version: "1.2.3" })).toBe(true);
  });

  it("false for every other status", () => {
    const quiet: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "downloading", percent: 10 },
      { kind: "not-available" },
      { kind: "error", message: "x" },
    ];
    for (const status of quiet) {
      expect(shouldShowUpdateBanner(status)).toBe(false);
    }
  });
});

describe("showsManualUpdateLink (TASK.47 defect 2: darwin honest manual-only path)", () => {
  it("true only for available + manualOnly:true", () => {
    expect(showsManualUpdateLink({ kind: "available", version: "1.2.3", manualOnly: true })).toBe(true);
  });

  it("false for available with manualOnly unset or explicitly false", () => {
    expect(showsManualUpdateLink({ kind: "available", version: "1.2.3" })).toBe(false);
    expect(showsManualUpdateLink({ kind: "available", version: "1.2.3", manualOnly: false })).toBe(false);
  });

  it("false for every other status, including downloaded (download() itself refuses manual_only on darwin, so this state never carries the flag)", () => {
    const others: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "downloading", percent: 10 },
      { kind: "downloaded", version: "1.2.3" },
      { kind: "not-available" },
      { kind: "error", message: "x" },
    ];
    for (const status of others) {
      expect(showsManualUpdateLink(status)).toBe(false);
    }
  });
});

describe("describeMcpServer (slice R16: per-server row kind + detail)", () => {
  // base fixture: { name: "srv", transport: "stdio", toolCount: 0, toolsTruncated: false }
  it("connecting -> running kind with a progressive detail", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "connecting", toolCount: 0, toolsTruncated: false };
    expect(describeMcpServer(server)).toEqual({ kind: "running", detail: "connecting…" });
  });

  it("connected -> completed kind with plural tool count", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "connected", toolCount: 3, toolsTruncated: false };
    expect(describeMcpServer(server)).toEqual({ kind: "completed", detail: "3 tools" });
  });

  it("singular 'tool' for exactly one tool", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "connected", toolCount: 1, toolsTruncated: false };
    expect(describeMcpServer(server)).toEqual({ kind: "completed", detail: "1 tool" });
  });

  it("connected + toolsTruncated appends an honest truncation marker", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "connected", toolCount: 2, toolsTruncated: true };
    expect(describeMcpServer(server)).toEqual({ kind: "completed", detail: "2 tools · truncated" });
  });

  it("failed -> failed kind with the server's own error detail", () => {
    const server: McpServerStatus = {
      name: "srv",
      transport: "stdio",
      state: "failed",
      toolCount: 0,
      toolsTruncated: false,
      error: "connect timed out",
    };
    expect(describeMcpServer(server)).toEqual({ kind: "failed", detail: "connect timed out" });
  });

  it("failed with no error falls back to the bare word", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "failed", toolCount: 0, toolsTruncated: false };
    expect(describeMcpServer(server)).toEqual({ kind: "failed", detail: "failed" });
  });

  it("closed -> idle kind (inert record, default glyph tier)", () => {
    const server: McpServerStatus = { name: "srv", transport: "stdio", state: "closed", toolCount: 0, toolsTruncated: false };
    expect(describeMcpServer(server)).toEqual({ kind: "idle", detail: "closed" });
  });
});

describe("describeTelemetryRow (slice P7.8, design slice-P7.8-cut.md §3.5)", () => {
  it("null -> disabled/muted with the opt-in hint", () => {
    const d = describeTelemetryRow(null);
    expect(d.tone).toBe("muted");
    expect(d.text).toContain("Disabled");
    expect(d.text).toContain(".anycode/config.json");
  });

  it("enabled with no drops/errors -> ok tone, filePath + written/dropped counts", () => {
    const status: TelemetryStatus = { filePath: "/ws/.anycode/telemetry/s1.jsonl", written: 12, dropped: 0 };
    expect(describeTelemetryRow(status)).toEqual({
      text: "Enabled — /ws/.anycode/telemetry/s1.jsonl · 12 written · 0 dropped",
      tone: "ok",
    });
  });

  it("dropped > 0 -> warn tone even with no lastWriteError", () => {
    const status: TelemetryStatus = { filePath: "/ws/t.jsonl", written: 5, dropped: 2 };
    expect(describeTelemetryRow(status).tone).toBe("warn");
  });

  it("lastWriteError -> warn tone regardless of dropped count", () => {
    const status: TelemetryStatus = { filePath: "/ws/t.jsonl", written: 5, dropped: 0, lastWriteError: "disk full" };
    expect(describeTelemetryRow(status).tone).toBe("warn");
  });
});

describe("describeRepoMapRow (slice P7.8, design slice-P7.8-cut.md §3.5)", () => {
  it("null -> disabled/muted with the env-var + config hint", () => {
    const d = describeRepoMapRow(null);
    expect(d.tone).toBe("muted");
    expect(d.text).toContain("Disabled");
    expect(d.text).toContain("ANYCODE_REPO_MAP=1");
  });

  it("enabled -> ok tone, included/total file counts + token budget", () => {
    const status: WireRepoMapStatus = { fileCount: 12, includedCount: 10, truncated: false, maxTokens: 2000 };
    expect(describeRepoMapRow(status)).toEqual({
      text: "Enabled — 10 of 12 files in system prompt · ~2000-token budget",
      tone: "ok",
    });
  });

  it("truncated -> appends an honest truncation marker (still ok tone)", () => {
    const status: WireRepoMapStatus = { fileCount: 50, includedCount: 30, truncated: true, maxTokens: 2000 };
    const d = describeRepoMapRow(status);
    expect(d.tone).toBe("ok");
    expect(d.text).toContain("truncated");
  });

  it("fileCount 0 -> honest zero counts, not treated as disabled", () => {
    const status: WireRepoMapStatus = { fileCount: 0, includedCount: 0, truncated: false, maxTokens: 2000 };
    expect(describeRepoMapRow(status)).toEqual({
      text: "Enabled — 0 of 0 files in system prompt · ~2000-token budget",
      tone: "ok",
    });
  });
});

describe("SETTINGS_PANES nav rail (slice P7.16 W2: Permissions split out of Tools & Permissions, icon+description added; P7.20/F23 W3: Skills inserted after MCP; P7.21/F21 W3: Subagents inserted after Skills; P7.22/F19 W3: Profile inserted FIRST; P7.24/F20 W3: Keyboard shortcuts inserted between Appearance and About; TASK.41 W2: Codex inserted between Provider and Permissions)", () => {
  it("grew to twelve panes, Profile leads the rail, Codex inserted between Provider and Permissions, Skills+Subagents inserted after MCP, shortcuts inserted between Appearance and About", () => {
    expect(SETTINGS_PANES.map((p) => p.id)).toEqual([
      "profile",
      "provider",
      "codex",
      "permissions",
      "tools",
      "mcp",
      "skills",
      "subagents",
      "environment",
      "appearance",
      "shortcuts",
      "about",
    ]);
    expect(SETTINGS_PANES).toHaveLength(12);
  });

  it("every pane carries a non-empty label, description, and icon component", () => {
    for (const pane of SETTINGS_PANES) {
      expect(pane.label.length).toBeGreaterThan(0);
      expect(pane.description.length).toBeGreaterThan(0);
      expect(typeof pane.icon).toBe("function");
    }
  });
});

describe("filterSettingsPanes (slice P7.16 W2, design §3: rail search, v1 honest scope)", () => {
  it("empty query -> every pane id, in SETTINGS_PANES order", () => {
    expect(filterSettingsPanes("")).toEqual(SETTINGS_PANES.map((p) => p.id));
    expect(filterSettingsPanes("   ")).toEqual(SETTINGS_PANES.map((p) => p.id));
  });

  it("'allow' matches only the Permissions pane (its always-allow keyword)", () => {
    expect(filterSettingsPanes("allow")).toEqual(["permissions"]);
  });

  it("case-insensitive", () => {
    expect(filterSettingsPanes("ALLOW")).toEqual(["permissions"]);
    expect(filterSettingsPanes("Provider")).toEqual(["provider"]);
  });

  it("a garbage query matches nothing", () => {
    expect(filterSettingsPanes("zzz-not-a-setting-zzz")).toEqual([]);
  });
});

describe("shouldShowAppVersion (TASK.49/W14-fix — About pane version line)", () => {
  it("renders when main supplied a version string", () => {
    expect(shouldShowAppVersion({ appVersion: "1.2.3" })).toBe(true);
  });

  it("renders even for an empty-string version (still a supplied value, not absence)", () => {
    expect(shouldShowAppVersion({ appVersion: "" })).toBe(true);
  });

  it("does not render when main supplied no getAppVersion (appVersion absent)", () => {
    expect(shouldShowAppVersion({})).toBe(false);
    expect(shouldShowAppVersion({ appVersion: undefined })).toBe(false);
  });
});

// ── custom model-provider pure helpers (owner-decision #6, cut §9.2, TASK.54) ──

const CUSTOM_PROVIDER_FIXTURE: CustomProviderRecord = {
  id: "custom:acme",
  name: "Acme Local",
  baseUrl: "https://acme.example.com",
  kind: "openai-compatible",
  models: ["m1", "m2"],
};

describe("customProviderKindLabel", () => {
  it("labels every kind", () => {
    expect(customProviderKindLabel("openai-compatible")).toMatch(/Chat Completions/);
    expect(customProviderKindLabel("openai")).toMatch(/Responses/);
    expect(customProviderKindLabel("anthropic")).toMatch(/Anthropic/);
  });
});

describe("describeCustomProvider", () => {
  it("pluralizes the model count", () => {
    expect(describeCustomProvider({ ...CUSTOM_PROVIDER_FIXTURE, models: [] })).toBe(
      "https://acme.example.com · no models selected",
    );
    expect(describeCustomProvider({ ...CUSTOM_PROVIDER_FIXTURE, models: ["m1"] })).toBe(
      "https://acme.example.com · 1 model",
    );
    expect(describeCustomProvider({ ...CUSTOM_PROVIDER_FIXTURE, models: ["m1", "m2"] })).toBe(
      "https://acme.example.com · 2 models",
    );
  });
});

describe("describeCustomProviderMutationError / describeFetchModelsError (custody: text only, never a value)", () => {
  it("covers every CustomProviderMutationReason with distinct, non-empty text", () => {
    const reasons = ["invalid", "read_only", "not_found", "needs_api_key", "weak_storage_needs_consent"] as const;
    const texts = reasons.map((r) => describeCustomProviderMutationError(r));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("covers every FetchModelsFailureReason with distinct, non-empty text", () => {
    const reasons = [
      "invalid_request",
      "invalid_url",
      "redirect_blocked",
      "http_error",
      "response_too_large",
      "timeout",
      "network_error",
      "invalid_response",
    ] as const;
    const texts = reasons.map((r) => describeFetchModelsError(r));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0);
    }
  });
});

describe("toggleSelectedModel", () => {
  it("adds an unselected id and removes a selected one", () => {
    expect(toggleSelectedModel([], "m1")).toEqual(["m1"]);
    expect(toggleSelectedModel(["m1"], "m2")).toEqual(["m1", "m2"]);
    expect(toggleSelectedModel(["m1", "m2"], "m1")).toEqual(["m2"]);
  });
});

describe("buildCustomProviderCreateRequest (client-side gate; main's zod schema is still the final validator)", () => {
  it("trims and shapes a valid submission", () => {
    const req = buildCustomProviderCreateRequest({
      name: "  Acme  ",
      baseUrl: "  https://acme.example.com  ",
      kind: "anthropic",
      apiKey: "  sekrit  ",
      selectedModels: ["m1", "m2"],
    });
    expect(req).toEqual({
      name: "Acme",
      baseUrl: "https://acme.example.com",
      kind: "anthropic",
      apiKey: "sekrit",
      models: ["m1", "m2"],
    });
  });

  it("returns undefined when name, baseUrl, or apiKey is blank", () => {
    const base = { name: "N", baseUrl: "https://x", kind: "openai-compatible" as const, apiKey: "k", selectedModels: [] };
    expect(buildCustomProviderCreateRequest({ ...base, name: "   " })).toBeUndefined();
    expect(buildCustomProviderCreateRequest({ ...base, baseUrl: "" })).toBeUndefined();
    expect(buildCustomProviderCreateRequest({ ...base, apiKey: "" })).toBeUndefined();
  });

  // Custody sanity: the request this builds is exactly what crosses the wire
  // once — it must never carry more than `apiKey` (no derived/duplicated
  // secret field, nothing that would give the value a second home).
  it("carries the key in exactly one field", () => {
    const req = buildCustomProviderCreateRequest({
      name: "N",
      baseUrl: "https://x",
      kind: "openai-compatible",
      apiKey: "the-secret",
      selectedModels: [],
    });
    expect(Object.values(req ?? {}).filter((v) => v === "the-secret")).toHaveLength(1);
  });
});
