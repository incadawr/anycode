import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, state: {} as any, settings: {} as any, send: vi.fn(), update: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useContext: () => ({ tabId: "tab" }),
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => { const i = harness.cursor++; return harness.slots[i] ??= { current: initial }; },
    useState: (initial: unknown) => { const i = harness.cursor++; if (!(i in harness.slots)) harness.slots[i] = initial; return [harness.slots[i], (v: any) => { harness.slots[i] = typeof v === "function" ? v(harness.slots[i]) : v; }]; },
    useEffect: (fn: () => void, deps: unknown[]) => { const i = harness.cursor++; const prev = harness.slots[i]; if (!prev || deps.some((v, j) => !Object.is(v, prev[j]))) { harness.slots[i] = deps; harness.effects.push(fn); } },
  };
});
vi.mock("../tab-context.js", () => ({ TabContext: {}, useTabSend: () => harness.send, useTabStore: (select: any) => select(harness.state), useTabStoreApi: () => ({ getState: () => harness.state }) }));
vi.mock("../tabs-store.js", () => ({ useTabsStore: (select: any) => select({ tabs: [] }) }));
vi.mock("../settings-store.js", () => ({ useSettingsStore: (select: any) => select(harness.settings) }));
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayFlag: () => {} }));
import { ModelPill } from "./ModelPill.js";
import { findCatalogEntry } from "@anycode/core/catalog";

function render(): any {
  harness.cursor = 0;
  harness.effects = [];
  const tree = ModelPill();
  for (const effect of harness.effects) effect();
  return tree;
}
function menu(tree: any): any { return tree.props.children[1].props.children; }

describe("model menu interaction", () => {
  beforeEach(() => {
    harness.slots = []; harness.send.mockReset(); harness.update.mockReset().mockResolvedValue({ ok: true });
    harness.state = { model: "glm-5.2", reasoningEffort: "high", availableEffortLevels: ["off", "high", "max"], turn: { status: "idle" }, queueInFlight: false, connection: "ready", pinnedConnection: { connectionId: "c", providerId: "z-ai" }, engine: null };
    harness.settings = { connectionUpdate: harness.update, snapshot: { settings: { provider: { activeConnectionId: "c", connections: [{ id: "c", providerId: "z-ai" }], custom: [] } }, catalog: [{ id: "z-ai", name: "Z.AI", authKind: "api_key", models: [{ id: "glm-5.2", reasoning: true, effortLevels: ["off", "high", "max"] }] }] } };
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, anycode: { listSessions: () => Promise.resolve([]) } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  });
  it("persists off after the host acknowledges an effort picked in the menu", async () => {
    let tree = render();
    tree.props.children[0].props.onClick();
    tree = render();
    const open = menu(tree).props.rows.find((row: any) => row.kind === "effort-open");
    menu(tree).props.onActivateRow(open);
    tree = render();
    const off = menu(tree).props.rows.find((row: any) => row.kind === "effort" && row.value === "off");
    expect(off).toBeDefined();
    menu(tree).props.onActivateRow(off);
    expect(harness.send).toHaveBeenCalledWith({ type: "set_reasoning_effort", effort: "off" });
    expect(harness.update).not.toHaveBeenCalled();
    harness.state.reasoningEffort = "off";
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledWith({ id: "c", reasoningEffort: "off" }));
  });
  it("shows no effort row for a model without reasoning metadata", () => {
    harness.state.model = "gpt-6-astra"; harness.state.availableEffortLevels = undefined;
    harness.settings.snapshot.catalog[0].models = [findCatalogEntry("openai")!.models.find((model) => model.id === "gpt-6-astra")!];
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    expect(menu(tree).props.rows.some((row: any) => row.kind === "effort-open")).toBe(false);
  });
});
