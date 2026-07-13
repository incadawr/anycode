/**
 * Pure-logic test for App.tsx's Welcome-screen gate (slice 2.2, ruling
 * reviews/slice-2.2-forks-ruling.md §2). `.test.ts`-only, same rationale as
 * every other renderer component test in this wave: no jsdom in this
 * package's vitest config, so `App` itself (a full React tree touching
 * `startConnectionManager`/`window.anycode`) isn't rendered here — only the
 * exported pure gating function, which carries the actual decision logic, is
 * exercised directly.
 */
import { describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../../shared/settings.js";
import { computeGitPanelOpen, selectMainPaneView, shouldShowWelcome, shouldSuppressEscForDraft } from "./App.js";

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: {
      version: 1,
      provider: {},
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    },
    secrets: [{ key: "provider.apiKey", set: false, source: "none", tier: "unavailable" }],
    providerReady: false,
    envOverrides: [],
    readOnly: false,
    ...overrides,
  };
}

describe("shouldShowWelcome (ruling §2)", () => {
  it("shows Welcome once the snapshot has loaded, the provider isn't ready, and no tab is open", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0)).toBe(true);
  });

  it("does not show Welcome before the first snapshot has loaded — avoids flashing Welcome during the unknown-readiness window right after mount", () => {
    expect(shouldShowWelcome(null, 0)).toBe(false);
  });

  it("does not show Welcome once ready, even with zero tabs — the shell lets the user open a session explicitly", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: true }), 0)).toBe(false);
  });

  it("does not show Welcome when a main-validated external engine is available without Core credentials", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0, true)).toBe(false);
  });

  it("waits for the external-engine verdict rather than flashing provider-only Welcome", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0, null)).toBe(false);
  });

  it("does not show Welcome once any tab is open, even if not ready — Welcome yields to the tab UI by tab count, not by providerReady flipping back", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 1)).toBe(false);
    expect(shouldShowWelcome(snapshot({ providerReady: true }), 2)).toBe(false);
  });
});

describe("selectMainPaneView (slice P7.12 §4.6)", () => {
  it("the start screen wins over an active tab", () => {
    expect(selectMainPaneView(true, true)).toBe("start");
  });

  it("an active tab renders when the draft is not active", () => {
    expect(selectMainPaneView(false, true)).toBe("active");
  });

  it("falls back to the empty shell with no draft and no active tab", () => {
    expect(selectMainPaneView(false, false)).toBe("empty");
  });

  it("the start screen wins even with no active tab", () => {
    expect(selectMainPaneView(true, false)).toBe("start");
  });
});

describe("shouldSuppressEscForDraft (slice P7.12 §4.6)", () => {
  it("suppresses Esc while the start screen is active — must not cancel a background tab's turn", () => {
    expect(shouldSuppressEscForDraft(true)).toBe(true);
  });

  it("does not suppress Esc when there is no active draft", () => {
    expect(shouldSuppressEscForDraft(false)).toBe(false);
  });
});

describe("computeGitPanelOpen (design TASK.40 §2(f)) — shell-owned, not engine.capabilities.supportsGitMutations", () => {
  it("stays closed when the user never opened it, regardless of shell capability", () => {
    expect(computeGitPanelOpen(false, true)).toBe(false);
    expect(computeGitPanelOpen(false, false)).toBe(false);
    expect(computeGitPanelOpen(false, undefined)).toBe(false);
  });

  it("opens when requested and shell.gitReadOnly is explicitly true (a Codex session in a git workspace)", () => {
    expect(computeGitPanelOpen(true, true)).toBe(true);
  });

  it("stays closed when requested but shell.gitReadOnly is explicitly false (a Codex session with no git workspace)", () => {
    expect(computeGitPanelOpen(true, false)).toBe(false);
  });

  it("defaults to open when requested and shell is undefined — byte-identical to core's pre-TASK.40 behavior (no engine gating at all)", () => {
    expect(computeGitPanelOpen(true, undefined)).toBe(true);
  });
});
