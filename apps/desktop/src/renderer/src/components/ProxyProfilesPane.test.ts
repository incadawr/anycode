/**
 * Pure-logic tests for the Network pane (TASK.141 lane C). `.test.ts` (never
 * `.test.tsx`) — this package's vitest runs `environment: "node"` with no jsdom
 * and collects `.test.ts` only.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings, ProviderConnection } from "../../../shared/settings.js";
import type { ProxyProfile } from "../../../shared/proxy.js";
import { profileConsumersText, proxyProfileConsumers, proxyProfileSummary } from "./ProxyProfilesPane.js";

function settings(over: {
  appRef?: string;
  codexRef?: string;
  claudeRef?: string;
  connections?: ProviderConnection[];
}): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: over.connections ?? [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...(over.codexRef === undefined ? {} : { codex: { proxyRef: over.codexRef } }),
    ...(over.claudeRef === undefined ? {} : { claude: { proxyRef: over.claudeRef } }),
    ...(over.appRef === undefined ? {} : { network: { proxyRef: over.appRef } }),
  } as AnycodeSettings;
}

function profile(over: Partial<ProxyProfile> = {}): ProxyProfile {
  return { id: "proxy-1", name: "Corporate", mode: "manual", url: "http://proxy.example.com:3128", ...over };
}

describe("proxyProfileSummary (TASK.141: the list row's one line)", () => {
  it("names the mode for a system profile rather than showing a blank address", () => {
    expect(proxyProfileSummary(profile({ mode: "system", url: undefined }))).toBe("System proxy");
  });

  it("shows the manual address", () => {
    expect(proxyProfileSummary(profile())).toBe("http://proxy.example.com:3128/");
  });

  // A profile URL is refused with userinfo at the main boundary, so this is
  // belt-and-braces — but the list is renderer-visible text and every URL that
  // reaches text goes through the mask, without exception.
  it("masks userinfo if any ever reaches the registry", () => {
    const summary = proxyProfileSummary(profile({ url: "http://bob:hunter2@proxy.example.com:3128" }));
    expect(summary).not.toContain("hunter2");
    expect(summary).toContain("bob:***@");
  });

  it("says so honestly when a manual profile has no address yet", () => {
    expect(proxyProfileSummary(profile({ url: undefined }))).toBe("No address set");
  });
});

describe("proxyProfileConsumers (TASK.141 §7: who references this profile)", () => {
  it("finds nobody in an untouched document", () => {
    expect(proxyProfileConsumers(settings({}), "proxy-1")).toEqual([]);
  });

  it("names the app rung, both engines, and each connection, in that order", () => {
    const doc = settings({
      appRef: "proxy-1",
      codexRef: "proxy-1",
      claudeRef: "proxy-1",
      connections: [{ id: "c1", providerId: "z-ai", label: "Anthropic work", proxyRef: "proxy-1" }],
    });
    expect(proxyProfileConsumers(doc, "proxy-1")).toEqual([
      "Application default",
      "Codex engine",
      "Claude engine",
      "connection «Anthropic work»",
    ]);
  });

  it("falls back to the provider id for an unlabelled connection", () => {
    const doc = settings({ connections: [{ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }] });
    expect(proxyProfileConsumers(doc, "proxy-1")).toEqual(["connection «z-ai»"]);
  });

  it("counts only the scopes that reference THIS profile", () => {
    const doc = settings({
      appRef: "proxy-2",
      codexRef: "proxy-1",
      claudeRef: "direct",
    });
    expect(proxyProfileConsumers(doc, "proxy-1")).toEqual(["Codex engine"]);
  });

  // A legacy `proxyUrl` string is not a reference to any profile — it is an
  // unnamed rung of its own, and importing it is a separate explicit action.
  it("a legacy proxyUrl string is never a consumer of a profile", () => {
    const doc = {
      ...settings({}),
      codex: { proxyUrl: "http://old.example.com:3128" },
    } as AnycodeSettings;
    expect(proxyProfileConsumers(doc, "proxy-1")).toEqual([]);
  });
});

describe("profileConsumersText (TASK.141 §7: a refusal that NAMES the blockers)", () => {
  // The whole point of refusing rather than cascading: silently detaching the
  // references would re-route scopes the user is not looking at, and the worst
  // outcome of that is traffic leaving the corporate proxy. A refusal the user
  // cannot act on is indistinguishable from a bug.
  it("lists every consumer main reported", () => {
    const text = profileConsumersText(["Application default", "connection «Anthropic work»"]);
    expect(text).toContain("Application default");
    expect(text).toContain("connection «Anthropic work»");
    expect(text).toContain("delete");
  });

  it("never renders a dangling sentence when main refused without naming anyone", () => {
    const text = profileConsumersText([]);
    expect(text).not.toContain("by .");
    expect(text).toContain("still in use");
  });
});
