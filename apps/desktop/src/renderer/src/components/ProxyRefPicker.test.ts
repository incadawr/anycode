/**
 * Pure-logic tests for the one proxy dropdown every scope renders (TASK.141
 * lane C). `.test.ts` (never `.test.tsx`) — this package's vitest runs
 * `environment: "node"` with no jsdom and collects `.test.ts` only.
 *
 * This file is ALSO where the deleted `EngineProxyField.test.ts`'s invariants
 * live on. They are migrated by name, not by accident: initial value per scope,
 * the empty/clear sentinel, the two engines' hints differing, the Claude/Codex
 * subagent asymmetry (TASK.139-F3), the saved-notice binding (TASK.139-F5), and
 * `proxy` surviving in both engine panes' search index. Each carries its
 * original task tag so the provenance is greppable.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings, ProviderConnection } from "../../../shared/settings.js";
import type { ProxyProfile, ProxyScopeId } from "../../../shared/proxy.js";
import {
  PROXY_REF_CREATE,
  PROXY_REF_INHERIT,
  PROXY_SCOPE_COPY,
  connectionCreateProxyRefField,
  proxyRefInitialValue,
  proxyRefOptions,
  proxyRefSetPayload,
  proxySavedNoticeVisible,
  proxyScopeHint,
  proxyScopeLabel,
} from "./ProxyRefPicker.js";
import { SETTINGS_SEARCH_INDEX } from "./SettingsScreen.js";

const CODEX: ProxyScopeId = { kind: "engine", engine: "codex" };
const CLAUDE: ProxyScopeId = { kind: "engine", engine: "claude" };
const APP: ProxyScopeId = { kind: "app" };

function profile(id: string, name: string): ProxyProfile {
  return { id, name, mode: "manual", url: `http://${name.toLowerCase()}.example.com:3128` };
}

/**
 * Minimal `AnycodeSettings` fixture — same required-fields shape as
 * ConnectionDrawer.test.ts's own helper.
 */
function settings(over: {
  profiles?: ProxyProfile[];
  appRef?: string;
  codex?: { proxyRef?: string; proxyUrl?: string };
  claude?: { proxyRef?: string; proxyUrl?: string };
  connections?: ProviderConnection[];
}): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: over.connections ?? [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...(over.codex === undefined ? {} : { codex: over.codex }),
    ...(over.claude === undefined ? {} : { claude: over.claude }),
    network: {
      ...(over.profiles === undefined ? {} : { proxyProfiles: over.profiles }),
      ...(over.appRef === undefined ? {} : { proxyRef: over.appRef }),
    },
  } as AnycodeSettings;
}

describe("proxyRefOptions (TASK.141 §3)", () => {
  it('every non-app scope leads with "Use application proxy" — the ladder made literal', () => {
    for (const scope of [CODEX, CLAUDE, { kind: "connection", connectionId: "c1" } as const]) {
      const options = proxyRefOptions(scope, settings({}));
      expect(options[0]).toEqual({ value: PROXY_REF_INHERIT, label: "Use application proxy" });
    }
  });

  // There is nothing below the app rung, so "inherit" and "no proxy" would be
  // the same entry twice.
  it("the app scope has NO inherit entry", () => {
    const options = proxyRefOptions(APP, settings({}));
    expect(options.some((option) => option.value === PROXY_REF_INHERIT)).toBe(false);
    expect(options[0]).toEqual({ value: "direct", label: "No proxy" });
  });

  it("lists every registered profile by name, in registry order", () => {
    const options = proxyRefOptions(
      CODEX,
      settings({ profiles: [profile("proxy-1", "Corporate"), profile("proxy-2", "Lab")] }),
    );
    expect(options.filter((o) => o.value.startsWith("proxy-"))).toEqual([
      { value: "proxy-1", label: "Corporate" },
      { value: "proxy-2", label: "Lab" },
    ]);
  });

  it('always ends with the "Create profile…" action', () => {
    const options = proxyRefOptions(CODEX, settings({ profiles: [profile("proxy-1", "Corporate")] }));
    expect(options.at(-1)).toEqual({ value: PROXY_REF_CREATE, label: "Create profile…" });
  });

  // The synthetic entry: the legacy string is NOT in the registry and no
  // migration has happened — choosing it and saving is what asks main to
  // convert it (the wire-only `legacy` ref, design review B-05).
  it("offers a synthetic Legacy entry while a scope still carries a pre-registry proxyUrl", () => {
    const options = proxyRefOptions(CODEX, settings({ codex: { proxyUrl: "http://old.example.com:3128" } }));
    expect(options).toContainEqual({ value: "legacy", label: "Legacy: http://old.example.com:3128/" });
  });

  // A legacy string is allowed to embed `user:pass@` and one already reaches
  // the renderer today (design review H-02) — the picker must never render it
  // back out.
  it("masks the userinfo of a legacy string", () => {
    const options = proxyRefOptions(
      CLAUDE,
      settings({ claude: { proxyUrl: "http://bob:hunter2@old.example.com:3128" } }),
    );
    const legacy = options.find((option) => option.value === "legacy");
    expect(legacy?.label).toBe("Legacy: http://bob:***@old.example.com:3128/");
    expect(legacy?.label).not.toContain("hunter2");
  });

  it("offers no Legacy entry when there is no legacy string, or when it is malformed", () => {
    expect(proxyRefOptions(CODEX, settings({})).some((o) => o.value === "legacy")).toBe(false);
    // `resolveProxyLadder` gates a legacy rung on the same `isProxyUrl`, so an
    // unusable string is not a rung and must not be offered as an import.
    expect(
      proxyRefOptions(CODEX, settings({ codex: { proxyUrl: "socks5://old:1080" } })).some((o) => o.value === "legacy"),
    ).toBe(false);
  });
});

/**
 * MIGRATED from EngineProxyField.test.ts's `engineProxyInitialValue` block
 * (TASK.139): the control opens on the value THIS scope persisted, and reads
 * only its own field.
 */
describe("proxyRefInitialValue (TASK.141; migrates TASK.139's initial-value-per-scope invariant)", () => {
  it("inherit when the engine has no settings block at all", () => {
    expect(proxyRefInitialValue(CODEX, settings({}))).toBe(PROXY_REF_INHERIT);
    expect(proxyRefInitialValue(CLAUDE, settings({}))).toBe(PROXY_REF_INHERIT);
  });

  it("reads the persisted ref off the engine's own block", () => {
    const both = settings({
      profiles: [profile("proxy-1", "Corporate"), profile("proxy-2", "Lab")],
      codex: { proxyRef: "proxy-1" },
      claude: { proxyRef: "proxy-2" },
    });
    expect(proxyRefInitialValue(CODEX, both)).toBe("proxy-1");
    expect(proxyRefInitialValue(CLAUDE, both)).toBe("proxy-2");
  });

  // Regress (TASK.139): an earlier draft read the wrong engine's field when
  // both blocks were present at once.
  it("never mixes engines — each reads only its own field", () => {
    const both = settings({
      profiles: [profile("proxy-1", "Corporate")],
      codex: { proxyRef: "proxy-1" },
      claude: { proxyRef: "direct" },
    });
    expect(proxyRefInitialValue(CODEX, both)).toBe("proxy-1");
    expect(proxyRefInitialValue(CLAUDE, both)).toBe("direct");
  });

  it("a connection reads its own ref", () => {
    const doc = settings({
      profiles: [profile("proxy-1", "Corporate")],
      connections: [{ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }],
    });
    expect(proxyRefInitialValue({ kind: "connection", connectionId: "c1" }, doc)).toBe("proxy-1");
    // A since-deleted connection reads as "nothing configured", the same
    // fail-soft posture a stale pin gets everywhere else.
    expect(proxyRefInitialValue({ kind: "connection", connectionId: "gone" }, doc)).toBe(PROXY_REF_INHERIT);
  });

  it('an absent app ref opens on "No proxy" — the app scope has no inherit entry to open on', () => {
    expect(proxyRefInitialValue(APP, settings({}))).toBe("direct");
    expect(proxyRefInitialValue(APP, settings({ appRef: "direct" }))).toBe("direct");
  });

  it("a legacy string opens on the synthetic Legacy entry", () => {
    expect(proxyRefInitialValue(CODEX, settings({ codex: { proxyUrl: "http://old.example.com:3128" } }))).toBe("legacy");
  });

  // `proxyRef` beats the legacy string of the SAME scope — the same precedence
  // `resolveProxyLadder` applies.
  it("a ref beats the same scope's legacy string", () => {
    const doc = settings({
      profiles: [profile("proxy-1", "Corporate")],
      codex: { proxyRef: "proxy-1", proxyUrl: "http://old.example.com:3128" },
    });
    expect(proxyRefInitialValue(CODEX, doc)).toBe("proxy-1");
  });

  // The law: an EXPLICIT rung with a broken value resolves direct, it does NOT
  // fall through. Showing "Use application proxy" for a dangling id would draw
  // a picture of the traffic that is simply false.
  it('a dangling profile id opens on "No proxy", never on inherit', () => {
    expect(proxyRefInitialValue(CODEX, settings({ codex: { proxyRef: "proxy-gone" } }))).toBe("direct");
  });
});

/**
 * MIGRATED from EngineProxyField.test.ts's `engineProxySavePayload` block
 * (TASK.139): the empty selection is a CLEAR sentinel, never an omission — an
 * emptied control has to be able to erase what was saved before.
 */
describe("proxyRefSetPayload (TASK.141; migrates TASK.139's clear-sentinel invariant)", () => {
  it('"Use application proxy" sends ref:null — the clear', () => {
    expect(proxyRefSetPayload(CODEX, PROXY_REF_INHERIT)).toEqual({ scope: CODEX, ref: null });
  });

  it("a chosen profile id and the direct sentinel travel verbatim on an engine scope", () => {
    expect(proxyRefSetPayload(CLAUDE, "proxy-1")).toEqual({ scope: CLAUDE, ref: "proxy-1" });
    expect(proxyRefSetPayload(CLAUDE, "direct")).toEqual({ scope: CLAUDE, ref: "direct" });
  });

  // On the app scope "explicitly none" and "inherit" are the same state (there
  // is nothing below it), so the key is DELETED rather than written as
  // `"direct"` — persisting it would be the one falsy-meaning key on disk that
  // nothing needs. Do not "simplify" this branch away.
  it('"No proxy" on the APP scope deletes the key instead of persisting "direct"', () => {
    expect(proxyRefSetPayload(APP, "direct")).toEqual({ scope: APP, ref: null });
    expect(proxyRefSetPayload(APP, PROXY_REF_INHERIT)).toEqual({ scope: APP, ref: null });
  });

  it("carries the wire-only legacy import action through (review B-05)", () => {
    expect(proxyRefSetPayload(CODEX, "legacy")).toEqual({ scope: CODEX, ref: "legacy" });
  });
});

describe("connectionCreateProxyRefField (TASK.141: one fragment for both create paths)", () => {
  it("sends the picked ref", () => {
    expect(connectionCreateProxyRefField("proxy-1")).toEqual({ proxyRef: "proxy-1" });
    expect(connectionCreateProxyRefField("direct")).toEqual({ proxyRef: "direct" });
  });

  it('omits the key entirely on inherit — create has no "" clear sentinel and its schema refuses one', () => {
    expect(connectionCreateProxyRefField(PROXY_REF_INHERIT)).toEqual({});
    expect("proxyRef" in connectionCreateProxyRefField(PROXY_REF_INHERIT)).toBe(false);
  });

  // A connection being MINTED has no legacy string to convert, so main answers
  // `invalid` for it (review B-05); the dropdown cannot offer the entry in
  // create mode either. Keeping the function total costs one branch.
  it("never sends the legacy import action, nor the picker's own action entry, on create", () => {
    expect(connectionCreateProxyRefField("legacy")).toEqual({});
    expect(connectionCreateProxyRefField(PROXY_REF_CREATE)).toEqual({});
  });
});

describe("PROXY_SCOPE_COPY / proxyScopeLabel (TASK.141 §3: a new scope declares one entry)", () => {
  it("only the app scope lacks an inherit entry", () => {
    expect(PROXY_SCOPE_COPY.app.inherit).toBe(false);
    expect(PROXY_SCOPE_COPY.connection.inherit).toBe(true);
    expect(PROXY_SCOPE_COPY.engine.inherit).toBe(true);
  });

  it("labels the app rung as the application-wide default", () => {
    expect(proxyScopeLabel(APP)).toBe("Application proxy");
    expect(proxyScopeLabel(CODEX)).toBe("Proxy");
    expect(proxyScopeLabel({ kind: "connection", connectionId: "c1" })).toBe("Proxy");
  });
});

/**
 * MIGRATED from EngineProxyField.test.ts's `engineProxyHint` block (TASK.139),
 * F3 included: the two engines' hints differ, and they differ ONLY in the
 * subagent-coverage clause.
 */
describe("proxyScopeHint (TASK.141; migrates TASK.139's per-engine hint invariants)", () => {
  it("differs between the two engines", () => {
    expect(proxyScopeHint(CODEX)).not.toBe(proxyScopeHint(CLAUDE));
  });

  it("names each engine's CLI", () => {
    expect(proxyScopeHint(CODEX)).toContain("Codex CLI");
    expect(proxyScopeHint(CLAUDE)).toContain("Claude Code CLI");
  });

  // TASK.143: a codex-engine child now runs for real (routes through
  // runSessionTier/ctx.sessionSubagents exactly like a claude one, and its
  // flush reads a live thread/read via CodexEngine.readTranscript() instead
  // of a frozen boot snapshot) — real Codex "subagent" traffic now exists to
  // route through this proxy, so the hint must claim it, same as Claude's.
  it("claims the Codex proxy covers subagents (TASK.143 — codex subagents now run)", () => {
    expect(proxyScopeHint(CODEX)).toContain("subagents");
  });

  // Claude subagents DO run and DO get the engine proxy — the claim stays true
  // for the claude hint even as the codex hint is pared back.
  it("still claims the Claude proxy covers subagents", () => {
    expect(proxyScopeHint(CLAUDE)).toContain("subagents");
  });

  it("pins the codex hint's wording exactly (TASK.143 — now matches Claude's subagent coverage)", () => {
    expect(proxyScopeHint(CODEX)).toBe(
      "Requests from the Codex CLI — sessions and subagents — go through the proxy profile selected here. " +
        "It overrides the connection-level proxy for Codex; a proxy exported by your shell overrides both.",
    );
  });

  it("pins the claude hint's wording exactly (the F3 asymmetry, carried over verbatim)", () => {
    expect(proxyScopeHint(CLAUDE)).toBe(
      "Requests from the Claude Code CLI — sessions and subagents — go through the proxy profile selected here. " +
        "It overrides the connection-level proxy for Claude; a proxy exported by your shell overrides both.",
    );
  });

  // A URL is no longer typed at a scope and a profile's password lives in the
  // vault, so the old field's "Stored as plain text" clause would now be a
  // false statement about where the value lives.
  it("no scope hint claims plaintext storage any more", () => {
    for (const scope of [APP, CODEX, CLAUDE, { kind: "connection", connectionId: "c1" } as const]) {
      expect(proxyScopeHint(scope)).not.toContain("plain text");
    }
  });

  it("every scope's hint says who overrides whom, shell included", () => {
    for (const scope of [APP, CODEX, CLAUDE, { kind: "connection", connectionId: "c1" } as const]) {
      expect(proxyScopeHint(scope)).toContain("shell");
    }
  });
});

/**
 * MIGRATED from EngineProxyField.test.ts (TASK.139-F5): the "Saved." notice
 * must belong to the exact value that was persisted, not to a bare "a save
 * succeeded at some point" flag — otherwise a save of value A that resolves
 * after the control has moved on to B renders a notice next to B, which was
 * never sent.
 */
describe("proxySavedNoticeVisible (TASK.141; migrates TASK.139-F5's notice binding)", () => {
  it("is hidden when nothing has ever saved successfully", () => {
    expect(proxySavedNoticeVisible(null, PROXY_REF_INHERIT)).toBe(false);
    expect(proxySavedNoticeVisible(null, "proxy-1")).toBe(false);
  });

  it("is visible when the current selection matches the last-saved one", () => {
    expect(proxySavedNoticeVisible("proxy-1", "proxy-1")).toBe(true);
  });

  // The exact F5 race: save A, then change to B before the request resolves.
  it("is hidden once the control no longer holds the value that was saved", () => {
    expect(proxySavedNoticeVisible("proxy-1", "proxy-2")).toBe(false);
  });

  it("is hidden again after the selection goes back to inherit", () => {
    expect(proxySavedNoticeVisible("proxy-1", PROXY_REF_INHERIT)).toBe(false);
  });
});

describe("SETTINGS_SEARCH_INDEX (TASK.141: the registry and both engine pickers must be findable)", () => {
  // MIGRATED from EngineProxyField.test.ts (TASK.139): the engine panes still
  // carry a proxy control, so they must still answer to "proxy".
  it('"proxy" is still a keyword for both the codex and claude panes', () => {
    expect(SETTINGS_SEARCH_INDEX.codex).toContain("proxy");
    expect(SETTINGS_SEARCH_INDEX.claude).toContain("proxy");
  });

  it("the Network pane answers to every word the profile editor puts on screen", () => {
    expect(SETTINGS_SEARCH_INDEX.network).toEqual([
      "proxy",
      "network",
      "system proxy",
      "no proxy",
      "authentication",
      "check connection",
    ]);
  });
});
