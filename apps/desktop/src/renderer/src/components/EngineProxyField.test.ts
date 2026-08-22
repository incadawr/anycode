/**
 * Pure-logic tests for EngineProxyField's exported helpers (TASK.139 lane B).
 * Deliberately `.test.ts` (not `.test.tsx`) — same rationale as
 * ConnectionDrawer.test.ts/SettingsScreen.test.ts: this package's vitest
 * config runs in `environment: "node"` with no jsdom, so the actual field's
 * click/render behavior is proven live by a smoke script instead, and these
 * tests exercise only the exported pure helpers directly.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings } from "../../../shared/settings.js";
import { proxyUrlSaveBlocked } from "./ConnectionDrawer.js";
import {
  engineProxyHint,
  engineProxyInitialValue,
  engineProxySavedNoticeVisible,
  engineProxySavePayload,
} from "./EngineProxyField.js";
import { SETTINGS_SEARCH_INDEX } from "./SettingsScreen.js";

/**
 * Minimal `AnycodeSettings` fixture — same required-fields shape as
 * ConnectionDrawer.test.ts's own `okResult` helper. `codex`/`claude` are cast
 * in rather than typed directly: lane A (shared/settings.ts) owns
 * `proxyUrl?: string` on those blocks and may not have landed it yet when
 * this lane writes its tests (TASK.139.md parallel-lane note); the cast keeps
 * this file compiling either way without depending on lane A's timing.
 */
function settings(engineBlocks: { codex?: { proxyUrl?: string }; claude?: { proxyUrl?: string } }): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...engineBlocks,
  } as AnycodeSettings;
}

describe("engineProxyInitialValue (TASK.139)", () => {
  it('"" when the engine has no settings block at all', () => {
    expect(engineProxyInitialValue(settings({}), "codex")).toBe("");
    expect(engineProxyInitialValue(settings({}), "claude")).toBe("");
  });

  it("reads the persisted value off the engine's own block", () => {
    expect(engineProxyInitialValue(settings({ codex: { proxyUrl: "http://p:3128" } }), "codex")).toBe("http://p:3128");
    expect(engineProxyInitialValue(settings({ claude: { proxyUrl: "http://q:3128" } }), "claude")).toBe("http://q:3128");
  });

  // Regress: an earlier draft read the wrong engine's field off `settings`
  // when both blocks were present at once.
  it("never mixes engines — each reads only its own field", () => {
    const both = settings({ codex: { proxyUrl: "http://codex:3128" }, claude: { proxyUrl: "http://claude:3128" } });
    expect(engineProxyInitialValue(both, "codex")).toBe("http://codex:3128");
    expect(engineProxyInitialValue(both, "claude")).toBe("http://claude:3128");
  });

  it('"" when the block exists but the field itself is absent', () => {
    expect(engineProxyInitialValue(settings({ codex: {} }), "codex")).toBe("");
  });
});

describe("engineProxySavePayload (TASK.139)", () => {
  it("trims surrounding whitespace", () => {
    expect(engineProxySavePayload("codex", "  http://p:3128  ")).toEqual({ engine: "codex", proxyUrl: "http://p:3128" });
  });

  it('empty and whitespace-only input both save "" (the clear sentinel)', () => {
    expect(engineProxySavePayload("codex", "")).toEqual({ engine: "codex", proxyUrl: "" });
    expect(engineProxySavePayload("claude", "   ")).toEqual({ engine: "claude", proxyUrl: "" });
  });

  it("carries the engine through unchanged", () => {
    expect(engineProxySavePayload("claude", "http://q:3128").engine).toBe("claude");
  });
});

describe("engineProxyHint (TASK.139)", () => {
  it("differs between the two engines", () => {
    expect(engineProxyHint("codex")).not.toBe(engineProxyHint("claude"));
  });

  it("names Codex's CLI and states plaintext storage", () => {
    const hint = engineProxyHint("codex");
    expect(hint).toContain("Codex CLI");
    expect(hint).toContain("plain text");
  });

  it("names Claude Code's CLI and states plaintext storage", () => {
    const hint = engineProxyHint("claude");
    expect(hint).toContain("Claude Code CLI");
    expect(hint).toContain("plain text");
  });

  // F3 (MEDIUM): codex engine children are refused before spawn
  // (packages/core/src/tools/agent.ts:251) and the legacy engine-children.ts
  // route is unwired (apps/desktop/src/host/index.ts:2036-2043) — no Codex
  // "subagent" traffic exists to route through this proxy, so the hint must
  // not promise one.
  it("does not claim the Codex proxy covers subagents", () => {
    expect(engineProxyHint("codex")).not.toContain("subagents");
  });

  // Claude subagents DO run and DO get the proxy — the claim stays true for
  // the claude hint even as the codex hint above is pared back.
  it("still claims the Claude proxy covers subagents", () => {
    expect(engineProxyHint("claude")).toContain("subagents");
  });

  it("pins the rest of the codex hint's wording exactly", () => {
    expect(engineProxyHint("codex")).toBe(
      "Requests from the Codex CLI go through this HTTP(S) proxy. " +
        "It overrides the connection-level proxy for Codex; a proxy exported by your shell overrides both. " +
        "Stored as plain text, and passed to every process the Codex CLI starts.",
    );
  });

  it("pins the claude hint's wording exactly (unchanged by the F3 fix)", () => {
    expect(engineProxyHint("claude")).toBe(
      "Requests from the Claude Code CLI — sessions and subagents — go through this HTTP(S) proxy. " +
        "It overrides the connection-level proxy for Claude; a proxy exported by your shell overrides both. " +
        "Stored as plain text, and passed to every process the Claude Code CLI starts.",
    );
  });
});

// F5 (MEDIUM): the "Saved." notice must belong to the exact value that was
// persisted, not to a bare "a save succeeded at some point" flag — otherwise
// a save of value A that resolves after the field has moved on to value B
// renders a "Saved." notice next to B, which was never sent.
describe("engineProxySavedNoticeVisible (TASK.139, F5)", () => {
  it("is hidden when nothing has ever saved successfully", () => {
    expect(engineProxySavedNoticeVisible(null, "")).toBe(false);
    expect(engineProxySavedNoticeVisible(null, "http://p:3128")).toBe(false);
  });

  it("is visible when the current value matches the last-saved value", () => {
    expect(engineProxySavedNoticeVisible("http://p:3128", "http://p:3128")).toBe(true);
  });

  // The exact race from F5: save A, then edit to B before the request
  // resolves. A lands on disk (lastSavedValue becomes "A"), but the field
  // now reads "B" — the notice must not appear next to B.
  it("is hidden once the field no longer holds the value that was saved", () => {
    expect(engineProxySavedNoticeVisible("http://a:3128", "http://b:3128")).toBe(false);
  });

  it("is hidden again after the field is cleared back out", () => {
    expect(engineProxySavedNoticeVisible("http://p:3128", "")).toBe(false);
  });
});

// Insurance against the connection-level and engine-level fields silently
// disagreeing about what counts as a valid proxy URL: EngineProxyField
// imports `proxyUrlSaveBlocked` from ConnectionDrawer.js rather than
// re-deriving it, so this is really a regression guard on that import wiring.
describe("proxyUrlSaveBlocked, as used by EngineProxyField (TASK.139)", () => {
  it("blocks a scheme-less host:port exactly as ConnectionDrawer's own field does", () => {
    expect(proxyUrlSaveBlocked("proxy.host:3128")).toBe(true);
  });
});

describe("SETTINGS_SEARCH_INDEX (TASK.139: the engine proxy field must be findable)", () => {
  it('"proxy" is a keyword for both the codex and claude panes', () => {
    expect(SETTINGS_SEARCH_INDEX.codex).toContain("proxy");
    expect(SETTINGS_SEARCH_INDEX.claude).toContain("proxy");
  });
});
