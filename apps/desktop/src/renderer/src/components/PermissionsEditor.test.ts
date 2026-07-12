/**
 * Pure-logic tests for PermissionsEditor's exported helpers (slice P7.16
 * §4.1/§5 W3). Same `.test.ts`-only, no-jsdom rationale as SettingsScreen's
 * and PermissionModal's own test files (this package's vitest config runs
 * `environment: "node"`) — grouping is covered separately in
 * permission-rules.test.ts, so this file covers the row label/aria builder,
 * the icon map, the manual-add datalist/validation, and (through a fake
 * `SettingsBridge`, the settings-store.test.ts DI pattern) that manual add
 * routes through the corrected `buildAlwaysAllowRule` sanitizer.
 */
import { describe, expect, it, vi } from "vitest";
import type { AlwaysAllowRule, SettingsMutationResult, SettingsSnapshot } from "../../../shared/settings.js";
import { createSettingsStore, type SettingsBridge } from "../settings-store.js";
import { FileIcon, Gear, Globe, Terminal } from "./icons.js";
import {
  canSubmitPermissionAdd,
  KNOWN_TOOL_NAMES,
  permissionToolOptions,
  ruleDisplayPattern,
  ruleHasPattern,
  ruleRemoveAriaLabel,
  ruleToolIcon,
  submitPermissionAdd,
} from "./PermissionsEditor.js";

function baseSettings(alwaysAllow: AlwaysAllowRule[] = []): SettingsSnapshot["settings"] {
  return {
    version: 1,
    provider: {},
    tools: {},
    permissions: { alwaysAllow },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

function baseSnapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: baseSettings(),
    secrets: [{ key: "provider.apiKey", set: false, source: "none", tier: "unavailable" }],
    providerReady: false,
    envOverrides: [],
    readOnly: false,
    ...overrides,
  };
}

function fakeBridge(overrides: Partial<SettingsBridge> = {}): SettingsBridge {
  return {
    get: vi.fn().mockResolvedValue(baseSnapshot()),
    set: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    setSecret: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    clearSecret: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    addRule: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() } satisfies SettingsMutationResult),
    oauthStart: vi.fn().mockResolvedValue({ ok: true, snapshot: baseSnapshot() }),
    oauthCancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ruleToolIcon", () => {
  it("maps Bash to Terminal", () => {
    expect(ruleToolIcon("Bash")).toBe(Terminal);
  });

  it("maps Read/Write/Edit to FileIcon", () => {
    expect(ruleToolIcon("Read")).toBe(FileIcon);
    expect(ruleToolIcon("Write")).toBe(FileIcon);
    expect(ruleToolIcon("Edit")).toBe(FileIcon);
  });

  it("maps WebFetch/WebSearch to Globe", () => {
    expect(ruleToolIcon("WebFetch")).toBe(Globe);
    expect(ruleToolIcon("WebSearch")).toBe(Globe);
  });

  it("falls back to Gear for an unknown tool", () => {
    expect(ruleToolIcon("Task")).toBe(Gear);
    expect(ruleToolIcon("")).toBe(Gear);
  });
});

describe("ruleHasPattern / ruleDisplayPattern / ruleRemoveAriaLabel", () => {
  it("treats a present, non-empty pattern as the display text", () => {
    const rule: AlwaysAllowRule = { toolName: "Bash", pattern: "git *" };
    expect(ruleHasPattern(rule)).toBe(true);
    expect(ruleDisplayPattern(rule)).toBe("git *");
    expect(ruleRemoveAriaLabel(rule)).toBe("Remove Bash rule git *");
  });

  it("renders 'all uses' for a pattern-less rule — never blank (the Edit-x bug)", () => {
    const rule: AlwaysAllowRule = { toolName: "Edit" };
    expect(ruleHasPattern(rule)).toBe(false);
    expect(ruleDisplayPattern(rule)).toBe("all uses");
    expect(ruleRemoveAriaLabel(rule)).toBe("Remove Edit rule all uses");
  });

  it("treats an empty-string pattern the same as absent", () => {
    const rule: AlwaysAllowRule = { toolName: "Read", pattern: "" };
    expect(ruleHasPattern(rule)).toBe(false);
    expect(ruleDisplayPattern(rule)).toBe("all uses");
  });
});

describe("permissionToolOptions", () => {
  it("returns the four known tools when there are no rules yet", () => {
    expect(permissionToolOptions([])).toEqual([...KNOWN_TOOL_NAMES]);
  });

  it("lists tool names already in rules first (first-appearance), then unseen known tools", () => {
    const rules: AlwaysAllowRule[] = [{ toolName: "WebFetch" }, { toolName: "Bash", pattern: "git *" }];
    expect(permissionToolOptions(rules)).toEqual(["WebFetch", "Bash", "Read", "Write", "Edit"]);
  });

  it("does not duplicate a known tool already present in rules", () => {
    const rules: AlwaysAllowRule[] = [{ toolName: "Bash" }, { toolName: "Bash", pattern: "npm *" }];
    const options = permissionToolOptions(rules);
    expect(options.filter((name) => name === "Bash")).toHaveLength(1);
  });
});

describe("canSubmitPermissionAdd", () => {
  it("disables on a blank or whitespace-only tool name", () => {
    expect(canSubmitPermissionAdd("")).toBe(false);
    expect(canSubmitPermissionAdd("   ")).toBe(false);
  });

  it("enables once a tool name is typed", () => {
    expect(canSubmitPermissionAdd("Bash")).toBe(true);
    expect(canSubmitPermissionAdd("  Bash  ")).toBe(true);
  });
});

describe("submitPermissionAdd", () => {
  it("does not call the bridge for a blank tool name", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    const result = await submitPermissionAdd(store, "   ", "git *");
    expect(result).toBeNull();
    expect(bridge.addRule).not.toHaveBeenCalled();
  });

  it("adds a bare tool-level rule when the pattern is blank", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    await submitPermissionAdd(store, "Read", "");
    expect(bridge.addRule).toHaveBeenCalledWith({ toolName: "Read" });
  });

  it("routes a hand-typed Bash pattern through the corrected sanitizer (P7.16 §4.2)", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    await submitPermissionAdd(store, "Bash", 'OUT="/tmp/o" node x.mjs');
    expect(bridge.addRule).toHaveBeenCalledWith({ toolName: "Bash", pattern: "node x.mjs" });
  });

  it("leaves a non-Bash pattern untouched (Bash-only sanitize gate)", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    await submitPermissionAdd(store, "Read", "env *");
    expect(bridge.addRule).toHaveBeenCalledWith({ toolName: "Read", pattern: "env *" });
  });

  it("trims the tool name before building the rule", async () => {
    const bridge = fakeBridge();
    const store = createSettingsStore(bridge);
    await submitPermissionAdd(store, "  Bash  ", "git status");
    expect(bridge.addRule).toHaveBeenCalledWith({ toolName: "Bash", pattern: "git status" });
  });

  it("updates the store snapshot from a successful bridge response", async () => {
    const nextSnapshot = baseSnapshot({ settings: baseSettings([{ toolName: "Bash", pattern: "git *" }]) });
    const bridge = fakeBridge({ addRule: vi.fn().mockResolvedValue({ ok: true, snapshot: nextSnapshot }) });
    const store = createSettingsStore(bridge);
    await submitPermissionAdd(store, "Bash", "git *");
    expect(store.getState().snapshot).toBe(nextSnapshot);
  });
});
