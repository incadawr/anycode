/**
 * Pure-logic tests for ConnectionTile's exported helpers (TASK.45 W12).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * SettingsScreen.test.ts: this package's vitest config runs in
 * `environment: "node"` with no jsdom, so a real DOM-rendering test isn't
 * feasible here; actual tile/menu/grid behavior is proven live by
 * `provider-connections-ui-smoke.mjs` instead.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection, ProviderHealthStatus, SecretStatus } from "../../../shared/settings.js";
import {
  connectionDisplayName,
  connectionHealthStatus,
  connectionSecretKey,
  describeConnectionHealth,
  HEALTH_LABEL,
  HEALTH_TONE,
  LAST_HEALTH_TTL_MS,
  observeLastHealth,
  tileStatusPresentation,
} from "./ConnectionTile.js";

function conn(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id: "conn-1", providerId: "z-ai", ...over };
}

function status(over: Partial<SecretStatus> = {}): SecretStatus {
  return { key: "provider.connection.conn-1.apiKey", set: true, source: "vault", tier: "os_encrypted", ...over };
}

/** Deterministic clock anchors (TASK.140) — replaces the old placeholder `at: "t"` fixtures. */
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A `lastHealth` observed `agoMs` before NOW, with the given status. */
function observed(statusName: ProviderHealthStatus, agoMs: number): NonNullable<ProviderConnection["lastHealth"]> {
  return { status: statusName, at: new Date(NOW - agoMs).toISOString() };
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
    expect(connectionHealthStatus(conn({ lastHealth: observed("ready", 0) }), status({ set: false }), false, NOW)).toBe(
      "needs_credential",
    );
  });

  it("needs_credential when there is no SecretStatus at all (undefined)", () => {
    expect(connectionHealthStatus(conn(), undefined, false, NOW)).toBe("needs_credential");
  });

  it("unchecked when the credential is set but never probed", () => {
    expect(connectionHealthStatus(conn(), status({ set: true }), false, NOW)).toBe("unchecked");
  });

  it("the connection's own lastHealth.status when the credential is set and the observation is fresh", () => {
    expect(connectionHealthStatus(conn({ lastHealth: observed("auth_invalid", MIN) }), status({ set: true }), false, NOW)).toBe(
      "auth_invalid",
    );
  });

  // §4 (W12-FIX, codex W12 review #4) — reverting the `|| credentialStatus.source
  // === "none"` clause turns this red: a present-but-undecryptable vault entry
  // (`set: true`, `source: "none"`) must present the SAME `needs_credential`
  // status as a genuinely-absent one, never a stale `ready`/`auth_invalid`.
  it('§4 needs_credential when the vault entry is present but undecryptable (set:true, source:"none")', () => {
    expect(
      connectionHealthStatus(
        conn({ lastHealth: observed("ready", 0) }),
        status({ set: true, source: "none", tier: "os_encrypted" }),
        false,
        NOW,
      ),
    ).toBe("needs_credential");
  });

  // Paired guard (anti-over-fix): a normally-decryptable vault entry must
  // still surface its lastHealth, not regress to needs_credential.
  it("paired guard: a decryptable credential (source: vault) still surfaces lastHealth, not needs_credential", () => {
    expect(
      connectionHealthStatus(
        conn({ lastHealth: observed("ready", 0) }),
        status({ set: true, source: "vault" }),
        false,
        NOW,
      ),
    ).toBe("ready");
  });

  // Keyless declarations (dogfood 16.07): a connection that expects NO
  // credential (catalog authOptional — vLLM — or its own "no API key" flag)
  // must not nag needs_credential forever over an absent key. Reverting the
  // `keyless` bypass turns these red.
  it("keyless: absent credential is a non-event — lastHealth (or unchecked) surfaces instead of needs_credential", () => {
    expect(connectionHealthStatus(conn(), undefined, true, NOW)).toBe("unchecked");
    expect(connectionHealthStatus(conn({ lastHealth: observed("ready", 0) }), status({ set: false }), true, NOW)).toBe(
      "ready",
    );
  });

  it("keyless defaults to false — the credential gate stays fail-closed for ordinary connections (regress)", () => {
    expect(connectionHealthStatus(conn(), undefined)).toBe("needs_credential");
  });

  // TASK.140: the credential override wins even over a FRESH observation, and
  // the keyless regression still holds under an explicit now.
  it("TASK.140 regress: fresh ready + undecryptable credential still needs_credential under explicit now", () => {
    expect(
      connectionHealthStatus(
        conn({ lastHealth: observed("ready", MIN) }),
        status({ set: true, source: "none", tier: "os_encrypted" }),
        false,
        NOW,
      ),
    ).toBe("needs_credential");
  });
});

describe("observeLastHealth (TASK.140: observation age, TTL freshness, compact ages)", () => {
  it("absent observation: unchecked, not observed, no age, empty compact age", () => {
    const obs = observeLastHealth(undefined, NOW);
    expect(obs.status).toBe("unchecked");
    expect(obs.observed).toBe(false);
    expect(obs.fresh).toBe(false);
    expect(obs.ageMs).toBeUndefined();
    expect(obs.compactAge).toBe("");
  });

  it("missing/invalid timestamp: unchecked, never fresh, age unknown", () => {
    for (const at of [undefined as unknown as string, "not-a-date", ""]) {
      const obs = observeLastHealth({ status: "ready", at }, NOW);
      expect(obs.status).toBe("unchecked");
      expect(obs.observed).toBe(true);
      expect(obs.fresh).toBe(false);
      expect(obs.ageMs).toBeUndefined();
      expect(obs.compactAge).toBe("age unknown");
      expect(obs.title).toContain("age unknown");
    }
  });

  it("fresh observation keeps its status with a compact age", () => {
    const obs = observeLastHealth(observed("ready", 5 * MIN), NOW);
    expect(obs.status).toBe("ready");
    expect(obs.fresh).toBe(true);
    expect(obs.ageMs).toBe(5 * MIN);
    expect(obs.compactAge).toBe("5m ago");
  });

  it("negative age (future timestamp / clock skew) clamps to zero and reads just now", () => {
    const obs = observeLastHealth(observed("ready", -MIN), NOW);
    expect(obs.ageMs).toBe(0);
    expect(obs.fresh).toBe(true);
    expect(obs.compactAge).toBe("just now");
  });

  it("exact TTL boundary: AT the TTL is stale (age >= TTL)", () => {
    const rate = observeLastHealth(observed("rate_limited", HOUR), NOW);
    expect(rate.fresh).toBe(false);
    expect(rate.status).toBe("unchecked");
    const other = observeLastHealth(observed("ready", DAY), NOW);
    expect(other.fresh).toBe(false);
    expect(other.status).toBe("unchecked");
  });

  it("just below the TTL boundary is fresh", () => {
    expect(observeLastHealth(observed("rate_limited", HOUR - 1), NOW).fresh).toBe(true);
    expect(observeLastHealth(observed("ready", DAY - 1), NOW).fresh).toBe(true);
  });

  it("rate_limited expires at 1 hour while another status is still fresh until 24 hours", () => {
    const at2h = 2 * HOUR;
    expect(observeLastHealth(observed("rate_limited", at2h), NOW).status).toBe("unchecked");
    expect(observeLastHealth(observed("ready", at2h), NOW).status).toBe("ready");
    const at25h = 25 * HOUR;
    expect(observeLastHealth(observed("ready", at25h), NOW).status).toBe("unchecked");
  });

  it("stale observation: unchecked, muted-history title naming the previous status, age and staleness", () => {
    const obs = observeLastHealth(observed("ready", 2 * DAY), NOW);
    expect(obs.status).toBe("unchecked");
    expect(obs.title).toBe(`Previous observation: ${HEALTH_LABEL.ready}, 2d ago (stale)`);
  });

  it("compact ages: just now, minutes, hours, 4d ago", () => {
    expect(observeLastHealth(observed("ready", 30_000), NOW).compactAge).toBe("just now");
    expect(observeLastHealth(observed("ready", 59 * MIN), NOW).compactAge).toBe("59m ago");
    expect(observeLastHealth(observed("ready", 3 * HOUR), NOW).compactAge).toBe("3h ago");
    expect(observeLastHealth(observed("ready", 4 * DAY), NOW).compactAge).toBe("4d ago");
  });

  it("never mutates the stored lastHealth or connection", () => {
    const lastHealth = observed("ready", MIN);
    const snapshot = { ...lastHealth };
    const connection = conn({ lastHealth });
    observeLastHealth(lastHealth, NOW);
    connectionHealthStatus(connection, status(), false, NOW);
    expect(lastHealth).toEqual(snapshot);
    expect(connection.lastHealth).toBe(lastHealth);
  });

  it("TTL table: 1h for rate_limited, 24h for every other status", () => {
    expect(LAST_HEALTH_TTL_MS.rate_limited).toBe(HOUR);
    expect(LAST_HEALTH_TTL_MS.other).toBe(DAY);
    for (const s of ["ready", "auth_invalid", "forbidden", "unreachable", "misconfigured"] as const) {
      expect(observeLastHealth(observed(s, HOUR + MIN), NOW).fresh).toBe(true);
      expect(observeLastHealth(observed(s, DAY + MIN), NOW).fresh).toBe(false);
    }
  });
});

describe("tileStatusPresentation (TASK.140: the exact text/title/tone the tile's status element renders)", () => {
  it("checking wins: 'Checking…', no title", () => {
    const fresh = observeLastHealth(observed("ready", MIN), NOW);
    expect(tileStatusPresentation("ready", fresh, true)).toEqual({
      text: "Checking…",
      title: undefined,
      tone: "ok",
    });
  });

  it("fresh observation: status text with compact age inline and in the title", () => {
    expect(tileStatusPresentation("ready", observeLastHealth(observed("ready", 5 * MIN), NOW), false)).toEqual({
      text: `Ready (5m ago)`,
      title: "Checked 5m ago",
      tone: "ok",
    });
  });

  it("stale observation: Unchecked muted text, historical title naming previous status, age and staleness", () => {
    const presentation = tileStatusPresentation("unchecked", observeLastHealth(observed("rate_limited", 2 * HOUR), NOW), false);
    expect(presentation.text).toBe("Unchecked");
    expect(presentation.tone).toBe("muted");
    expect(presentation.title).toBe(`Previous observation: ${HEALTH_LABEL.rate_limited}, 2h ago (stale)`);
  });

  it("unknown-age observation: Unchecked with age unknown in the compact age and title — never fresh", () => {
    const presentation = tileStatusPresentation("unchecked", observeLastHealth({ status: "ready", at: "not-a-date" }, NOW), false);
    expect(presentation.text).toBe("Unchecked");
    expect(presentation.title).toBe(`Previous observation: ${HEALTH_LABEL.ready}, age unknown`);
  });

  it("absent observation: bare Unchecked, no title", () => {
    expect(tileStatusPresentation("unchecked", observeLastHealth(undefined, NOW), false)).toEqual({
      text: "Unchecked",
      title: undefined,
      tone: "muted",
    });
  });

  it("credential override keeps Needs credential as current status AND reports the previous observation's age (defect-1 contract)", () => {
    // Fresh prior reading: age in the title, no stale mark.
    expect(
      tileStatusPresentation("needs_credential", observeLastHealth(observed("rate_limited", 10 * MIN), NOW), false),
    ).toEqual({
      text: "Needs credential",
      title: `Previous observation: ${HEALTH_LABEL.rate_limited}, 10m ago`,
      tone: "muted",
    });
    // Stale prior reading: age kept, stale mark, historical title.
    expect(
      tileStatusPresentation("needs_credential", observeLastHealth(observed("rate_limited", 2 * HOUR), NOW), false),
    ).toEqual({
      text: "Needs credential",
      title: `Previous observation: ${HEALTH_LABEL.rate_limited}, 2h ago (stale)`,
      tone: "muted",
    });
    // Unknown-age prior reading: described as age unknown, never fresh.
    expect(
      tileStatusPresentation("needs_credential", observeLastHealth({ status: "ready", at: "not-a-date" }, NOW), false),
    ).toEqual({
      text: "Needs credential",
      title: `Previous observation: ${HEALTH_LABEL.ready}, age unknown`,
      tone: "muted",
    });
    // No prior observation: bare Needs credential, no title.
    expect(tileStatusPresentation("needs_credential", observeLastHealth(undefined, NOW), false)).toEqual({
      text: "Needs credential",
      title: undefined,
      tone: "muted",
    });
  });

  it("checking suppresses even the credential override's history display", () => {
    expect(
      tileStatusPresentation(
        "needs_credential",
        observeLastHealth(observed("ready", MIN), NOW),
        true,
      ).text,
    ).toBe("Checking…");
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
