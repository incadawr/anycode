/**
 * TASK.198 срез E2a — pure-logic tests for the Vision panel's decision layer
 * (vision-pane-model.ts). Same `.test.ts`-only, no-jsdom discipline as every
 * other Settings pane in this directory (vitest.config.ts runs `environment:
 * "node"`; see ProfilePane.test.ts's own docstring) — every rule the panel
 * needs is exercised through the module's exported pure functions.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings, CatalogSummary, ProviderConnection } from "../../../shared/settings.js";
import {
  RECOGNIZER_OAUTH_DISABLED_REASON,
  declaredProxyRung,
  resolveRecognizerAuthKind,
  sameDeclaredProxyRung,
  visionConnectionLabel,
  visionConnectionOptions,
  visionConnectionProxyWarning,
  visionFallbackState,
  visionModelHints,
  visionSubmitDisabled,
} from "./vision-pane-model.js";

// ── fixtures ──

function connection(over: Partial<ProviderConnection> & { id: string; providerId: string }): ProviderConnection {
  return over;
}

/** Minimal `AnycodeSettings` fixture — same required-fields shape as ConnectionDrawer.test.ts's/ProxyRefPicker.test.ts's own helper. */
function settings(over: {
  connections?: ProviderConnection[];
  activeConnectionId?: string;
  recognizer?: { connectionId: string; modelId: string };
}): AnycodeSettings {
  return {
    version: 2,
    provider: {
      connections: over.connections ?? [],
      ...(over.activeConnectionId === undefined ? {} : { activeConnectionId: over.activeConnectionId }),
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...(over.recognizer === undefined ? {} : { recognizer: over.recognizer }),
  } as AnycodeSettings;
}

/**
 * TASK.198: `imageInput` is not yet a real field of `CatalogSummaryEntry.
 * models` — see vision-pane-model.ts's own doc comment — so this fixture
 * type widens the wire type's model shape with the field a closed gap would
 * add, and CATALOG below is built through it instead of a bare object literal
 * (which the real, narrower wire type would reject as an excess property).
 */
type CatalogModelFixture = CatalogSummary[number]["models"][number] & { imageInput?: boolean };

const CATALOG: CatalogSummary = [
  {
    id: "z-ai",
    name: "Z.AI (GLM)",
    authKind: "api_key",
    models: [
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", imageInput: true },
      { id: "glm-5.2", name: "GLM-5.2" },
    ] satisfies CatalogModelFixture[] as CatalogSummary[number]["models"],
  },
  { id: "kimi", name: "Kimi", authKind: "api_key", models: [] },
];

const NO_AUTH_KIND = (): "api_key" | "oauth" | undefined => undefined;

// ── resolveRecognizerAuthKind ──

describe("resolveRecognizerAuthKind (mirrors host-env.ts resolveRecognizerConfig verbatim)", () => {
  it("marks an oauth-authenticated connection as oauth", () => {
    expect(resolveRecognizerAuthKind({ providerId: "anthropic" }, () => "oauth")).toBe("oauth");
  });

  it("marks an api_key-authenticated connection as api_key", () => {
    expect(resolveRecognizerAuthKind({ providerId: "z-ai" }, () => "api_key")).toBe("api_key");
  });

  it("a bare/legacy connection (providerId === \"\") is ALWAYS api_key, even when authKindFor would answer oauth", () => {
    // Pin against the exact runtime tonicity (host-env.ts §1179-1183): a bare
    // connection is api_key by construction and never even CONSULTS authKindFor.
    expect(resolveRecognizerAuthKind({ providerId: "" }, () => "oauth")).toBe("api_key");
  });

  it("an unknown providerId (authKindFor returns undefined) degrades to api_key, never to oauth", () => {
    expect(resolveRecognizerAuthKind({ providerId: "some-unknown-id" }, NO_AUTH_KIND)).toBe("api_key");
  });
});

// ── proxy rung comparison ──

describe("declaredProxyRung / sameDeclaredProxyRung", () => {
  it("proxyRef wins over proxyUrl on the SAME connection", () => {
    // `readProxyScope` never returns BOTH fields non-empty for `proxyRef` set
    // (host-env.ts's own "beats" rule lives there, not here) — this pins
    // `declaredProxyRung`'s own half: given both, it reads the ref and
    // ignores the legacy string entirely. The end-to-end path (a real
    // connection carrying both fields) is covered by
    // "proxyRef beats proxyUrl on one connection..." below, via
    // visionConnectionProxyWarning + readProxyScope together.
    const rung = declaredProxyRung({ ref: "proxy-1", legacyUrl: "http://ignored.example.com:3128" });
    expect(rung).toEqual({ kind: "ref", value: "proxy-1" });
  });

  it("same rung (both inherit) compares equal", () => {
    expect(sameDeclaredProxyRung({ kind: "inherit" }, { kind: "inherit" })).toBe(true);
  });

  it("same rung (same proxyRef id) compares equal", () => {
    expect(sameDeclaredProxyRung({ kind: "ref", value: "proxy-1" }, { kind: "ref", value: "proxy-1" })).toBe(true);
  });

  it("different rung kinds compare unequal", () => {
    expect(sameDeclaredProxyRung({ kind: "inherit" }, { kind: "ref", value: "proxy-1" })).toBe(false);
  });

  it("same kind, different value compares unequal", () => {
    expect(sameDeclaredProxyRung({ kind: "ref", value: "proxy-1" }, { kind: "ref", value: "proxy-2" })).toBe(false);
  });
});

describe("visionConnectionProxyWarning (task §2 — warns, never blocks)", () => {
  it("warns when the candidate's declared rung differs from the default connection's", () => {
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }),
        connection({ id: "c2", providerId: "kimi", proxyRef: "proxy-2" }),
      ],
      activeConnectionId: "c1",
    });
    const warning = visionConnectionProxyWarning(s, "c2", "c1", "Anthropic work");
    expect(warning).toBeDefined();
    expect(warning).toContain("Anthropic work");
  });

  it("no warning when both connections declare the identical rung (both inherit)", () => {
    const s = settings({
      connections: [connection({ id: "c1", providerId: "z-ai" }), connection({ id: "c2", providerId: "kimi" })],
      activeConnectionId: "c1",
    });
    expect(visionConnectionProxyWarning(s, "c2", "c1", "Anthropic work")).toBeUndefined();
  });

  it("no warning when both connections declare the identical rung (both direct)", () => {
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "z-ai", proxyRef: "direct" }),
        connection({ id: "c2", providerId: "kimi", proxyRef: "direct" }),
      ],
      activeConnectionId: "c1",
    });
    expect(visionConnectionProxyWarning(s, "c2", "c1", "Anthropic work")).toBeUndefined();
  });

  it("no warning when both connections declare the identical rung (same proxyRef profile id)", () => {
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }),
        connection({ id: "c2", providerId: "kimi", proxyRef: "proxy-1" }),
      ],
      activeConnectionId: "c1",
    });
    expect(visionConnectionProxyWarning(s, "c2", "c1", "Anthropic work")).toBeUndefined();
  });

  it("proxyRef beats proxyUrl on one connection when comparing against the default's declared rung", () => {
    // c2 carries BOTH; its declared rung must be judged by proxyRef alone
    // ("proxy-1"), which matches c1's own proxyRef — so no warning, even
    // though c2's legacy proxyUrl names something else entirely.
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }),
        connection({ id: "c2", providerId: "kimi", proxyRef: "proxy-1", proxyUrl: "http://elsewhere.example.com:3128" }),
      ],
      activeConnectionId: "c1",
    });
    expect(visionConnectionProxyWarning(s, "c2", "c1", "Anthropic work")).toBeUndefined();
  });

  it("the candidate connection being the default itself never warns", () => {
    const s = settings({
      connections: [connection({ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" })],
      activeConnectionId: "c1",
    });
    expect(visionConnectionProxyWarning(s, "c1", "c1", "Anthropic work")).toBeUndefined();
  });
});

// ── visionConnectionOptions ──

describe("visionConnectionOptions (task §1)", () => {
  it("marks an oauth connection unselectable with a reason, and an api_key connection selectable", () => {
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "anthropic", label: "Anthropic OAuth" }),
        connection({ id: "c2", providerId: "z-ai", label: "Z.AI" }),
      ],
    });
    const authKindFor = (providerId: string): "api_key" | "oauth" | undefined =>
      providerId === "anthropic" ? "oauth" : "api_key";
    const options = visionConnectionOptions(s, CATALOG, authKindFor);
    const oauthOption = options.find((o) => o.id === "c1")!;
    const apiKeyOption = options.find((o) => o.id === "c2")!;
    expect(oauthOption.selectable).toBe(false);
    expect(oauthOption.disabledReason).toBe(RECOGNIZER_OAUTH_DISABLED_REASON);
    expect(apiKeyOption.selectable).toBe(true);
    expect(apiKeyOption.disabledReason).toBeUndefined();
  });

  it("a divergent-proxy connection stays selectable — this test must fail if a future change turns the warning into a disable", () => {
    const s = settings({
      connections: [
        connection({ id: "c1", providerId: "z-ai", proxyRef: "proxy-1" }),
        connection({ id: "c2", providerId: "kimi", proxyRef: "proxy-2" }),
      ],
      activeConnectionId: "c1",
    });
    const options = visionConnectionOptions(s, CATALOG, () => "api_key");
    const divergent = options.find((o) => o.id === "c2")!;
    expect(divergent.selectable).toBe(true);
    expect(divergent.proxyWarning).toBeDefined();
  });
});

// ── visionConnectionLabel ──

describe("visionConnectionLabel", () => {
  it("uses the connection's own label when set", () => {
    const conn = connection({ id: "c1", providerId: "z-ai", label: "My Z.AI" });
    expect(visionConnectionLabel(conn, CATALOG, [conn])).toBe("My Z.AI");
  });

  it("falls back to the catalog name when no label is set", () => {
    const conn = connection({ id: "c1", providerId: "z-ai" });
    expect(visionConnectionLabel(conn, CATALOG, [conn])).toBe("Z.AI (GLM)");
  });
});

// ── visionModelHints (task §3 — UNION, not replace) ──

describe("visionModelHints (task §3 anti-canon: union, never ModelPill's replace)", () => {
  it("includes a catalog model with imageInput:true", () => {
    const hints = visionModelHints("z-ai", CATALOG, undefined);
    expect(hints).toContainEqual({ id: "glm-5.3-flash", label: "GLM-5.3 Flash" });
  });

  it("excludes a catalog model without imageInput:true", () => {
    const hints = visionModelHints("z-ai", CATALOG, undefined);
    expect(hints.some((h) => h.id === "glm-5.2")).toBe(false);
  });

  it("always includes a live connection model id, regardless of catalog modality", () => {
    const hints = visionModelHints("z-ai", CATALOG, ["some-live-model"]);
    expect(hints).toContainEqual({ id: "some-live-model", label: "some-live-model" });
  });

  it("a catalog imageInput model does NOT disappear when the live list is non-empty (the ModelPill.providerModelsFor defect, fixed)", () => {
    const hints = visionModelHints("z-ai", CATALOG, ["some-live-model"]);
    expect(hints).toContainEqual({ id: "glm-5.3-flash", label: "GLM-5.3 Flash" });
    expect(hints).toContainEqual({ id: "some-live-model", label: "some-live-model" });
    expect(hints).toHaveLength(2);
  });

  it("collapses a duplicate id (present in both halves) into ONE entry, named from the catalog", () => {
    const hints = visionModelHints("z-ai", CATALOG, ["glm-5.3-flash"]);
    expect(hints.filter((h) => h.id === "glm-5.3-flash")).toHaveLength(1);
    expect(hints).toContainEqual({ id: "glm-5.3-flash", label: "GLM-5.3 Flash" });
  });

  it("a provider with an empty catalog models[] and an empty live list yields zero hints — not an error", () => {
    expect(visionModelHints("kimi", CATALOG, [])).toEqual([]);
    expect(visionModelHints("kimi", CATALOG, undefined)).toEqual([]);
  });

  it("an unknown providerId (no catalog entry at all) still returns the live ids", () => {
    const hints = visionModelHints("openrouter", CATALOG, ["anthropic/claude-x"]);
    expect(hints).toEqual([{ id: "anthropic/claude-x", label: "anthropic/claude-x" }]);
  });
});

// ── visionFallbackState (task §4 — no half-configured middle state) ──

describe("visionFallbackState (task §4)", () => {
  it("empty settings.recognizer reads as disabled", () => {
    expect(visionFallbackState(settings({}), NO_AUTH_KIND)).toEqual({ enabled: false });
  });

  it("a dangling connectionId reads as disabled", () => {
    const s = settings({ connections: [], recognizer: { connectionId: "gone", modelId: "m1" } });
    expect(visionFallbackState(s, NO_AUTH_KIND)).toEqual({ enabled: false });
  });

  it("an oauth connection reads as disabled", () => {
    const s = settings({
      connections: [connection({ id: "c1", providerId: "anthropic" })],
      recognizer: { connectionId: "c1", modelId: "m1" },
    });
    expect(visionFallbackState(s, () => "oauth")).toEqual({ enabled: false });
  });

  it("a valid api_key pair reads as enabled, carrying the connectionId/modelId", () => {
    const s = settings({
      connections: [connection({ id: "c1", providerId: "z-ai" })],
      recognizer: { connectionId: "c1", modelId: "glm-5.3-flash" },
    });
    expect(visionFallbackState(s, () => "api_key")).toEqual({
      enabled: true,
      connectionId: "c1",
      modelId: "glm-5.3-flash",
    });
  });
});

// ── visionSubmitDisabled (task §5 — mirrors handleRecognizerSet's own refusal) ──

describe("visionSubmitDisabled (mirrors handleRecognizerSet's refusal, main/settings-ipc.ts)", () => {
  it("disabled when no connection is chosen (the <select> placeholder's empty value)", () => {
    expect(visionSubmitDisabled("", "glm-5.3-flash")).toBe(true);
  });

  it("disabled when the model field is empty", () => {
    expect(visionSubmitDisabled("c1", "")).toBe(true);
  });

  it("disabled when the model field is whitespace-only after trim", () => {
    expect(visionSubmitDisabled("c1", "   ")).toBe(true);
  });

  it("enabled once both a connection is chosen and the model is non-blank", () => {
    expect(visionSubmitDisabled("c1", "glm-5.3-flash")).toBe(false);
  });

  it("enabled for a model with surrounding whitespace that is non-blank once trimmed", () => {
    expect(visionSubmitDisabled("c1", "  glm-5.3-flash  ")).toBe(false);
  });
});
