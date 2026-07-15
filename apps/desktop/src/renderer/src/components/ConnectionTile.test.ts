/**
 * Pure-logic tests for ConnectionTile's exported helpers (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts: this package's vitest config runs in
 * `environment: "node"` with no jsdom, so a real DOM-rendering test isn't
 * feasible here; actual tile/menu/grid behavior is proven live by
 * `provider-connections-ui-smoke.mjs` instead.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection, SecretStatus } from "../../../shared/settings.js";
import {
  connectionDisplayName,
  connectionHealthStatus,
  connectionSecretKey,
  describeConnectionHealth,
  HEALTH_LABEL,
  HEALTH_TONE,
} from "./ConnectionTile.js";

function conn(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id: "conn-1", providerId: "z-ai", ...over };
}

function status(over: Partial<SecretStatus> = {}): SecretStatus {
  return { key: "provider.connection.conn-1.apiKey", set: true, source: "vault", tier: "os_encrypted", ...over };
}

describe("connectionSecretKey", () => {
  it("api_key -> the connection's apiKey vault key", () => {
    expect(connectionSecretKey("conn-1", "api_key")).toBe("provider.connection.conn-1.apiKey");
  });

  it("oauth -> the connection's oauth vault key", () => {
    expect(connectionSecretKey("conn-1", "oauth")).toBe("provider.connection.conn-1.oauth");
  });
});

describe("connectionHealthStatus (task §3: needs_credential OVERRIDES any stale lastHealth)", () => {
  it("needs_credential when the credential is absent, regardless of a prior lastHealth reading", () => {
    expect(connectionHealthStatus(conn({ lastHealth: { status: "ready", at: "t" } }), status({ set: false }))).toBe(
      "needs_credential",
    );
  });

  it("needs_credential when there is no SecretStatus at all (undefined)", () => {
    expect(connectionHealthStatus(conn(), undefined)).toBe("needs_credential");
  });

  it("unchecked when the credential is set but never probed", () => {
    expect(connectionHealthStatus(conn(), status({ set: true }))).toBe("unchecked");
  });

  it("the connection's own lastHealth.status when the credential is set", () => {
    expect(connectionHealthStatus(conn({ lastHealth: { status: "auth_invalid", at: "t" } }), status({ set: true }))).toBe(
      "auth_invalid",
    );
  });
});

describe("describeConnectionHealth (task §3 table: tone discipline)", () => {
  it("ready -> ok", () => {
    expect(describeConnectionHealth("ready")).toEqual({ text: HEALTH_LABEL.ready, tone: "ok" });
  });

  it("auth_invalid and forbidden -> danger (red) — a DISCRIMINATED credential failure only", () => {
    expect(describeConnectionHealth("auth_invalid").tone).toBe("danger");
    expect(describeConnectionHealth("forbidden").tone).toBe("danger");
  });

  it("rate_limited/unreachable/misconfigured -> warn (amber), NEVER danger — 429/timeout/5xx/bad-model must never paint red", () => {
    expect(describeConnectionHealth("rate_limited").tone).toBe("warn");
    expect(describeConnectionHealth("unreachable").tone).toBe("warn");
    expect(describeConnectionHealth("misconfigured").tone).toBe("warn");
  });

  it("needs_credential/unchecked -> muted", () => {
    expect(describeConnectionHealth("needs_credential").tone).toBe("muted");
    expect(describeConnectionHealth("unchecked").tone).toBe("muted");
  });

  it("every status has a non-empty, distinct label — status is never color alone", () => {
    const labels = Object.values(HEALTH_LABEL);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("HEALTH_TONE and HEALTH_LABEL cover exactly the same status keys", () => {
    expect(Object.keys(HEALTH_TONE).sort()).toEqual(Object.keys(HEALTH_LABEL).sort());
  });
});

describe("connectionDisplayName (task's own example: \"OpenAI\", \"OpenAI 2\", …)", () => {
  it("a custom label always wins", () => {
    const c = conn({ label: "Work" });
    expect(connectionDisplayName(c, "OpenAI", [c])).toBe("Work");
  });

  it("the first unlabeled connection of a provider gets the bare catalog name", () => {
    const c = conn({ id: "conn-1", providerId: "openai" });
    expect(connectionDisplayName(c, "OpenAI", [c])).toBe("OpenAI");
  });

  it("a second unlabeled connection of the SAME provider gets an ordinal suffix", () => {
    const first = conn({ id: "conn-1", providerId: "openai" });
    const second = conn({ id: "conn-2", providerId: "openai" });
    const all = [first, second];
    expect(connectionDisplayName(first, "OpenAI", all)).toBe("OpenAI");
    expect(connectionDisplayName(second, "OpenAI", all)).toBe("OpenAI 2");
  });

  it("a labeled connection does not consume an ordinal slot from its unlabeled siblings", () => {
    const labeled = conn({ id: "conn-1", providerId: "openai", label: "Personal" });
    const unlabeled = conn({ id: "conn-2", providerId: "openai" });
    const all = [labeled, unlabeled];
    expect(connectionDisplayName(labeled, "OpenAI", all)).toBe("Personal");
    // The unlabeled one is the FIRST unlabeled connection of this provider —
    // still bare "OpenAI", not "OpenAI 2" (the labeled sibling doesn't count).
    expect(connectionDisplayName(unlabeled, "OpenAI", all)).toBe("OpenAI");
  });

  it("connections of a DIFFERENT provider never affect each other's ordinal", () => {
    const openai1 = conn({ id: "conn-1", providerId: "openai" });
    const zai1 = conn({ id: "conn-2", providerId: "z-ai" });
    const all = [openai1, zai1];
    expect(connectionDisplayName(openai1, "OpenAI", all)).toBe("OpenAI");
    expect(connectionDisplayName(zai1, "Z.AI", all)).toBe("Z.AI");
  });
});
