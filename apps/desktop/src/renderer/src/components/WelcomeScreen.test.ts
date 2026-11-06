/**
 * Pure-logic tests for WelcomeScreen's exported view-selection helpers
 * (onboarding was locked into editing the FIRST connection forever,
 * with no way to switch to a different saved connection or create a new one).
 * Deliberately `.test.ts` (not `.test.tsx`): this package's vitest config
 * runs in `environment: "node"` with no jsdom (see ConnectionDrawer.test.ts's
 * docstring) — the actual add/edit form + list rendering is proven live by
 * the provider-connections-ui-smoke.mjs script instead. `initialConnectionsView`
 * and `resolveWelcomeView` carry every branch of WelcomeScreen's view logic so
 * it's tested directly, same discipline as ConnectionDrawer's
 * `resolveCreatedConnectionId`/`liveModelSuggestions`.
 */
import { describe, expect, it } from "vitest";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type { ProviderConnection } from "../../../shared/settings.js";
import { initialConnectionsView, resolveWelcomeView, welcomeFormKey, welcomeKeyLinkVisible, WELCOME_SUBSCRIPTIONS, type WelcomeConnectionsView } from "./WelcomeScreen.js";

function conn(id: string, providerId = "z-ai"): ProviderConnection {
  return { id, providerId };
}

describe("initialConnectionsView", () => {
  it("no connections -> creation view", () => {
    expect(initialConnectionsView([])).toEqual({ mode: "add" });
  });

  it("one connection -> edit view on that connection", () => {
    expect(initialConnectionsView([conn("a")])).toEqual({ mode: "edit", connectionId: "a" });
  });

  it("multiple connections -> edit view on the FIRST one", () => {
    expect(initialConnectionsView([conn("a"), conn("b")])).toEqual({ mode: "edit", connectionId: "a" });
  });
});

describe("resolveWelcomeView", () => {
  const connections = [conn("a"), conn("b")];

  it("add view -> creation mode, no edit target, stable 'add' key", () => {
    const view: WelcomeConnectionsView = { mode: "add" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "add", editConnection: undefined, key: "add" });
  });

  it("edit view on an existing connection -> that connection, keyed by its id", () => {
    const view: WelcomeConnectionsView = { mode: "edit", connectionId: "b" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "edit", editConnection: connections[1], key: "b" });
  });

  it("edit view on a vanished connection id falls back to creation (defensive — this list offers no delete)", () => {
    const view: WelcomeConnectionsView = { mode: "edit", connectionId: "gone" };
    expect(resolveWelcomeView(view, connections)).toEqual({ mode: "add", editConnection: undefined, key: "add" });
  });

  it("switching add -> edit -> add again yields the SAME key each time back at the same view (no drift)", () => {
    const add = resolveWelcomeView({ mode: "add" }, connections);
    const edit = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);
    const addAgain = resolveWelcomeView({ mode: "add" }, connections);
    const editAgain = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);

    expect(add.key).toBe("add");
    expect(edit.key).toBe("a");
    expect(addAgain.key).toBe(add.key);
    expect(editAgain.key).toBe(edit.key);
  });

  it("switching between two DIFFERENT connections yields DIFFERENT keys", () => {
    const editA = resolveWelcomeView({ mode: "edit", connectionId: "a" }, connections);
    const editB = resolveWelcomeView({ mode: "edit", connectionId: "b" }, connections);
    expect(editA.key).not.toBe(editB.key);
  });
});

describe("welcomeFormKey", () => {
  it("a subscription pick on the fresh-create form keys the form per template and pick", () => {
    expect(welcomeFormKey("add", "z-ai", 0)).toBe("add:z-ai#0");
    expect(welcomeFormKey("add", "minimax", 0)).toBe("add:minimax#0");
    expect(welcomeFormKey("add", "kimi", 0)).toBe("add:kimi#0");
  });

  it("different picks yield different keys (typed values must not leak across templates)", () => {
    expect(welcomeFormKey("add", "z-ai", 0)).not.toBe(welcomeFormKey("add", "minimax", 0));
  });

  it("an explicit reset nonce yields a new key for the same template", () => {
    expect(welcomeFormKey("add", "z-ai", 0)).not.toBe(welcomeFormKey("add", "z-ai", 1));
  });

  it("no pick keeps the plain key", () => {
    expect(welcomeFormKey("add", null, 0)).toBe("add");
  });

  it("any other view passes its key through untouched", () => {
    expect(welcomeFormKey("conn-a", "z-ai", 0)).toBe("conn-a");
    expect(welcomeFormKey("conn-a", null, 0)).toBe("conn-a");
  });
});

describe("welcomeKeyLinkVisible", () => {
  const zAi = WELCOME_SUBSCRIPTIONS.find((sub) => sub.id === "z-ai")!;

  it("shows the seeded template's link while the form's Provider select is untouched", () => {
    expect(welcomeKeyLinkVisible(zAi, null)).toBe(true);
  });

  it("hides the link once the form moves to another provider (a stale key page is a dead end)", () => {
    expect(welcomeKeyLinkVisible(zAi, "openai")).toBe(false);
  });

  it("shows the link again when the seeded template is picked back", () => {
    expect(welcomeKeyLinkVisible(zAi, "z-ai")).toBe(true);
  });

  it("no active pick means no link", () => {
    expect(welcomeKeyLinkVisible(undefined, null)).toBe(false);
    expect(welcomeKeyLinkVisible(undefined, "openai")).toBe(false);
  });
});

describe("WELCOME_SUBSCRIPTIONS", () => {
  it("offers one OpenCode Go shortcut", () => {
    expect(WELCOME_SUBSCRIPTIONS.filter(sub => sub.id.startsWith("opencode"))).toEqual([{ id: "opencode", title: "OpenCode Go", description: "Use your OpenCode Go key", keyUrl: "https://opencode.ai/console", planUrl: "https://opencode.ai/go" }]);
  });
  it("every pick is a builtin catalog template a key-paste connection can use", () => {
    const catalog = getBuiltinCatalog();
    for (const sub of WELCOME_SUBSCRIPTIONS) {
      const entry = catalog.providers.find((provider) => provider.id === sub.id);
      // A drift guard: a renamed/removed catalog template would seed the
      // first-run Provider select with an id no entry resolves.
      expect(entry, `catalog template "${sub.id}" missing`).toBeDefined();
      expect(entry!.auth.kind, `template "${sub.id}" must be key paste, not OAuth`).toBe("api_key");
      // The prefilled default model (the curated list's first entry) must exist.
      expect(entry!.models.length, `template "${sub.id}" has no models to prefill`).toBeGreaterThan(0);
    }
  });
});

it("renders icons on connection choices", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { WelcomeScreen } = await import("./WelcomeScreen.js");
  const html = renderToStaticMarkup(createElement(WelcomeScreen));
  for (const name of ["openai", "anthropic", "fallback", "zai", "minimax", "kimi", "opencode"]) {
    expect(html).toContain(`data-provider-icon="${name}"`);
  }
});

it("offers a subscription page separately from the key console", () => {
  expect(WELCOME_SUBSCRIPTIONS.map(sub => sub.planUrl)).toEqual([
    "https://z.ai/subscribe", "https://www.minimax.io/m-plan",
    "https://www.kimi.com/code", "https://opencode.ai/go",
  ]);
  for (const sub of WELCOME_SUBSCRIPTIONS) expect(sub.planUrl).not.toBe(sub.keyUrl);
});
