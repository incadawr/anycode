import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, state: {} as any, settings: {} as any, send: vi.fn(), update: vi.fn(), tabId: "tab" }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useContext: () => ({ tabId: harness.tabId }),
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => { const i = harness.cursor++; return harness.slots[i] ??= { current: initial }; },
    useState: (initial: unknown) => { const i = harness.cursor++; if (!(i in harness.slots)) harness.slots[i] = initial; return [harness.slots[i], (v: any) => { harness.slots[i] = typeof v === "function" ? v(harness.slots[i]) : v; }]; },
    useEffect: (fn: () => void, deps: unknown[]) => { const i = harness.cursor++; const prev = harness.slots[i]; if (!prev || deps.some((v, j) => !Object.is(v, prev[j]))) { harness.slots[i] = deps; harness.effects.push(fn); } },
  };
});
vi.mock("../tab-context.js", () => ({ TabContext: {}, useTabSend: () => harness.send, useTabStore: (select: any) => select(harness.state), useTabStoreApi: () => ({ getState: () => harness.state }) }));
vi.mock("../tabs-store.js", () => ({ useTabsStore: (select: any) => select({ tabs: [] }) }));
// `useSettingsStore` is both a selector hook and a store handle: GitHub #33's
// successful switch re-reads the snapshot main just wrote.
vi.mock("../settings-store.js", () => ({ useSettingsStore: Object.assign((select: any) => select(harness.settings), { getState: () => harness.settings }) }));
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayFlag: () => {} }));
import { ModelPill } from "./ModelPill.js";
import { findCatalogEntry } from "@anycode/core/catalog";

function render(): any {
  harness.cursor = 0;
  harness.effects = [];
  const tree = ModelPill();
  // Effects are replayed the way React would: a changed dep list re-runs its
  // effect, and state setters write straight into the slots, so the next
  // `render()` sees the updated state.
  for (const effect of harness.effects) effect();
  return tree;
}
function requestId(type: string): string { return harness.send.mock.calls.filter(([m]: any[]) => m.type === type).at(-1)![0].requestId; }
function menu(tree: any): any { return tree.props.children[1].props.children; }

describe("model menu interaction", () => {
  beforeEach(() => {
    harness.slots = []; harness.send.mockReset(); harness.update.mockReset().mockResolvedValue({ ok: true });
    harness.tabId = "tab";
    harness.state = { model: "glm-5.2", reasoningEffort: "high", availableEffortLevels: ["off", "high", "max"], turn: { status: "idle" }, queueInFlight: null, connection: "ready", pinnedConnection: { connectionId: "c", providerId: "z-ai" }, engine: null };
    harness.settings = { connectionUpdate: harness.update, load: vi.fn(), snapshot: { settings: { provider: { activeConnectionId: "c", connections: [{ id: "c", providerId: "z-ai" }], custom: [] } }, catalog: [{ id: "z-ai", name: "Z.AI", authKind: "api_key", models: [{ id: "glm-5.2", reasoning: true, effortLevels: ["off", "high", "max"] }] }] } };
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, anycode: { listSessions: () => Promise.resolve([]) } });
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  });
  it("persists off after the host acknowledges an effort picked in the menu", async () => {
    harness.state.reasoningEffort = "off";
    let tree = render();
    tree.props.children[0].props.onClick();
    tree = render();
    const open = menu(tree).props.rows.find((row: any) => row.kind === "effort-open");
    menu(tree).props.onActivateRow(open);
    tree = render();
    const off = menu(tree).props.rows.find((row: any) => row.kind === "effort" && row.value === "off");
    expect(off).toBeDefined();
    menu(tree).props.onActivateRow(off);
    expect(harness.send).toHaveBeenCalledWith({ type: "set_reasoning_effort", effort: "off", requestId: expect.any(String) });
    expect(harness.update).not.toHaveBeenCalled();
    harness.state.reasoningEffort = "off";
    harness.state.effortSelectionAck = {kind:"effort", model:"glm-5.2", effort:"off", requestId:requestId("set_reasoning_effort")};
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledWith({ id: "c", modelOverrideModel: "glm-5.2", reasoningEffort: "off" }));
  });
  it.each(["model-first", "effort-first"])("persists both explicit queued axes (%s), including an unchanged effective tier", async (order) => {
    harness.state.turn.status = "running";
    harness.settings.snapshot.catalog[0].models.push({id:"glm-4.6", reasoning:true, effortLevels:["off","high","max"]});
    const chooseEffort = (value: string) => {
      let tree = render(); tree.props.children[0].props.onClick(); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort-open")); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort" && r.value === value));
    };
    const chooseModel = () => {
      let tree = render(); tree.props.children[0].props.onClick(); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group")); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-4.6"));
    };
    const effort = order === "model-first" ? "high" : "max";
    if (order === "model-first") { chooseModel(); chooseEffort(effort); }
    else { chooseEffort(effort); chooseModel(); }
    expect(harness.update).not.toHaveBeenCalled();
    harness.state.model = "glm-4.6";
    harness.state.modelSelectionAck = {kind:"model", model:"glm-4.6", effort, requestId:requestId("set_model"), effortRequestId:requestId("set_reasoning_effort")};
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledExactlyOnceWith({id:"c", model:"glm-4.6", modelOverrideModel:"glm-4.6", reasoningEffort:effort}));
  });

  it.each(["effort-first", "model-first"])("persists both acknowledgements arriving before render (%s)", async (order) => {
    harness.settings.snapshot.catalog[0].models.push({id:"glm-4.6", reasoning:true, effortLevels:["off","high","max"]});
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort-open")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort" && r.value === "max"));
    tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-4.6"));
    const effortAck = {kind:"effort", model: "glm-5.2", effort:"max", requestId:requestId("set_reasoning_effort")};
    const modelAck = {kind:"model", model:"glm-4.6", effort:"high", requestId:requestId("set_model")};
    if (order === "effort-first") { harness.state.effortSelectionAck = effortAck; harness.state.modelSelectionAck = modelAck; }
    else { harness.state.modelSelectionAck = modelAck; harness.state.effortSelectionAck = effortAck; }
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledTimes(2));
    expect(harness.update).toHaveBeenCalledWith({id:"c", model:"glm-4.6"});
    expect(harness.update).toHaveBeenCalledWith({id:"c", modelOverrideModel:effortAck.model, reasoningEffort:"max"});
  });

  it("does not let a stale acknowledgement consume a queued choice for another model", async () => {
    harness.state.turn.status = "running";
    harness.state.reasoningEffort = "off";
    harness.settings.snapshot.catalog[0].models.push({id:"glm-4.6", reasoning:true, effortLevels:["off","high","max"]});
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-4.6"));
    tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort-open")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort" && r.value === "off"));
    harness.state.effortSelectionAck = {kind:"effort", model:"glm-5.2", effort:"off", requestId:"stale"};
    harness.state.modelSelectionAck = {kind:"model", model:"glm-4.6", effort:"low", requestId:requestId("set_model"), effortRequestId:requestId("set_reasoning_effort")};
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledExactlyOnceWith({id:"c", model:"glm-4.6", modelOverrideModel:"glm-4.6", reasoningEffort:"low"}));
  });

  it("ignores a stale same-value acknowledgement before a later model pick", async () => {
    harness.state.turn.status = "running";
    harness.state.reasoningEffort = "off";
    harness.settings.snapshot.catalog[0].models.push({id:"glm-4.6", reasoning:true, effortLevels:["off","high","max"]});
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort-open")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "effort" && r.value === "off"));
    harness.state.effortSelectionAck = {kind:"effort", model:"glm-5.2", effort:"off", requestId:"stale"};
    render();
    expect(harness.update).not.toHaveBeenCalled();
    tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-4.6"));
    harness.state.modelSelectionAck = {kind:"model", model:"glm-4.6", effort:"low", requestId:requestId("set_model"), effortRequestId:requestId("set_reasoning_effort")};
    render();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledExactlyOnceWith({id:"c", model:"glm-4.6", modelOverrideModel:"glm-4.6", reasoningEffort:"low"}));
  });

  it("passes the current tier and the picked model when switching to another connection", async () => {
    const rebind = vi.fn().mockResolvedValue({ok:true});
    (window.anycode as any).tabRebind = rebind;
    harness.settings.snapshot.settings.provider.connections.push({id:"d", providerId:"other"});
    harness.settings.snapshot.catalog.push({id:"other", name:"Other", authKind:"api_key", models:[{id:"glm-5.3-flash", reasoning:true, effortLevels:["low","high"]}]});
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group" && r.connectionId === "d")); tree = render();
    menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-5.3-flash"));
    // GitHub #33: the dry run goes first (it is the child gate's question), the
    // switch itself carries the effort AND the model main must write.
    await vi.waitFor(() => expect(rebind).toHaveBeenLastCalledWith({tabId:"tab", connectionId:"d", model:"glm-5.3-flash", priorEffort:"high"}));
    expect(rebind).toHaveBeenNthCalledWith(1, {tabId:"tab", connectionId:"d", dryRun:true});
  });

  it("shows no effort row for a model without reasoning metadata", () => {
    harness.state.model = "gpt-6-astra"; harness.state.availableEffortLevels = undefined;
    harness.settings.snapshot.catalog[0].models = [findCatalogEntry("openai")!.models.find((model) => model.id === "gpt-6-astra")!];
    let tree = render(); tree.props.children[0].props.onClick(); tree = render();
    expect(menu(tree).props.rows.some((row: any) => row.kind === "effort-open")).toBe(false);
  });

  // GitHub #33: a cross-connection pick re-binds the host, which CANCELS the
  // tab's running children. The pick therefore asks first (main's dry-run
  // answer), writes nothing at all, and carries the explicit `cancelChildren`
  // consent on the retry — bound to the tab the question was asked in.
  describe("GitHub #33: running subagents gate a cross-connection switch", () => {
    function pickForeign(): void {
      harness.settings.snapshot.settings.provider.connections.push({ id: "d", providerId: "other" });
      harness.settings.snapshot.catalog.push({ id: "other", name: "Other", authKind: "api_key", models: [{ id: "glm-5.3-flash", reasoning: true, effortLevels: ["low", "high"] }] });
      let tree = render(); tree.props.children[0].props.onClick(); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "group" && r.connectionId === "d")); tree = render();
      menu(tree).props.onActivateRow(menu(tree).props.rows.find((r: any) => r.kind === "model" && r.modelId === "glm-5.3-flash"));
    }
    /** The confirm dialog the pill renders as the third child (chip, popover, dialog). */
    function dialog(tree: any): any {
      return tree.props.children[2];
    }

    it("asks with the live count instead of cancelling silently, writing nothing", async () => {
      const rebind = vi.fn().mockResolvedValue({ ok: false, reason: "children_running", runningChildren: 3 });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledWith({ tabId: "tab", connectionId: "d", dryRun: true }));

      const tree = render();
      expect(dialog(tree).props.request).toEqual({
        title: "Subagents are running",
        body: "3 subagents are running in this session and will be cancelled. Switch connection anyway?",
        confirmLabel: "Switch anyway",
        cancelLabel: "Wait",
      });
      // A question is not a switch: no real rebind was attempted and the
      // renderer never writes settings at all in this flow (main owns that
      // write, inside the locked switch), so there is nothing to roll back.
      expect(rebind).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
    });

    it("switches only after the user confirms, with the cancelChildren consent and the picked model on the rebind", async () => {
      const rebind = vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: "children_running", runningChildren: 2 })
        .mockResolvedValueOnce({ ok: true, connectionId: "d" })
        .mockResolvedValueOnce({ ok: true, connectionId: "d" });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(1));
      render().props.children[2].props.onConfirm();

      await vi.waitFor(() =>
        expect(rebind).toHaveBeenLastCalledWith({
          tabId: "tab",
          connectionId: "d",
          model: "glm-5.3-flash",
          priorEffort: "high",
          cancelChildren: true,
        }),
      );
      expect(rebind).toHaveBeenNthCalledWith(2, { tabId: "tab", connectionId: "d", dryRun: true, cancelChildren: true });
      // The renderer performs no settings write of its own — main wrote the
      // target model inside the same locked switch — it only re-reads the
      // snapshot so Settings shows the new default.
      expect(harness.update).not.toHaveBeenCalled();
      expect(harness.settings.load).toHaveBeenCalled();
      expect(dialog(render()).props.request).toBeNull();
    });

    it("declining leaves the session and the target connection untouched", async () => {
      const rebind = vi.fn().mockResolvedValue({ ok: false, reason: "children_running", runningChildren: 1 });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(1));
      expect(dialog(render()).props.request.body).toBe("1 subagent is running in this session and will be cancelled. Switch connection anyway?");

      render().props.children[2].props.onCancel();

      expect(dialog(render()).props.request).toBeNull();
      expect(harness.update).not.toHaveBeenCalled();
      expect(rebind).toHaveBeenCalledTimes(1);
      expect(harness.settings.load).not.toHaveBeenCalled();
    });

    it("a child that starts between the dry run and the rebind is asked about, never cancelled", async () => {
      // Dry run says clear, then the real (locked) rebind finds a live child:
      // main refuses before writing anything, so the only thing the renderer
      // does is ask again — with the live count.
      const rebind = vi.fn()
        .mockResolvedValueOnce({ ok: true, connectionId: "d" })
        .mockResolvedValueOnce({ ok: false, reason: "children_running", runningChildren: 1 });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(2));

      const tree = render();
      expect(dialog(tree).props.request.body).toBe("1 subagent is running in this session and will be cancelled. Switch connection anyway?");
      // The refused attempt carried the model but no consent — main refused it
      // before its own write, and the tab's children keep running.
      expect(rebind).toHaveBeenLastCalledWith({
        tabId: "tab",
        connectionId: "d",
        model: "glm-5.3-flash",
        priorEffort: "high",
      });
      expect(harness.settings.load).not.toHaveBeenCalled();
    });

    // ── The consent belongs to the tab it was asked in ──────────────────────
    // The active tab's component tree is reused when the selected tab changes.

    it("a dry run answered AFTER the user switched tabs opens no dialog for the new tab", async () => {
      let answer: (result: unknown) => void = () => {};
      const rebind = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(1));

      // The user is now looking at another tab; this is the same mounted tree.
      harness.tabId = "tab-2";
      render();
      answer({ ok: false, reason: "children_running", runningChildren: 3 });
      await Promise.resolve();
      await Promise.resolve();

      expect(dialog(render()).props.request).toBeNull();
      expect(rebind).toHaveBeenCalledTimes(1);
      expect(harness.settings.load).not.toHaveBeenCalled();
    });

    it("a question left open is dropped when the tab changes, so it can never be answered for another tab", async () => {
      const rebind = vi.fn().mockResolvedValue({ ok: false, reason: "children_running", runningChildren: 2 });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(1));
      expect(dialog(render()).props.request).not.toBeNull();

      harness.tabId = "tab-2";
      // The tab-change effect clears the parked question…
      render();

      expect(dialog(render()).props.request).toBeNull();
      expect(rebind).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
    });

    it("a confirmation for the ORIGIN tab is not spent on the tab now in front of the user", async () => {
      const rebind = vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: "children_running", runningChildren: 2 })
        .mockResolvedValue({ ok: true, connectionId: "d" });
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(1));
      // Capture the handler while the question is still on screen for tab A…
      const confirmForTabA = render().props.children[2].props.onConfirm;

      harness.tabId = "tab-2";
      render();
      // …then click it after the tree now represents tab B.
      confirmForTabA();
      await Promise.resolve();
      await Promise.resolve();

      // The consent travelled with tab A's id, and the live tab is B: nothing
      // is rebound, and certainly not with tab B's children cancelled.
      expect(rebind).toHaveBeenCalledTimes(1);
      expect(harness.settings.load).not.toHaveBeenCalled();
    });
    // GitHub #33 review 2: the switch is settled MAIN-side, so its side effects
    // do not depend on which tab this pill happens to render when it lands.
    it("refreshes settings after a switch that completed while the user moved to another tab", async () => {
      let finish: (result: unknown) => void = () => {};
      const rebind = vi.fn()
        .mockResolvedValueOnce({ ok: true, connectionId: "d" })
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      (window.anycode as any).tabRebind = rebind;

      pickForeign();
      await vi.waitFor(() => expect(rebind).toHaveBeenCalledTimes(2));

      // The user is looking at another tab when the switch completes. Main has
      // already saved the target connection's model and moved the session.
      harness.tabId = "tab-2";
      render();
      finish({ ok: true, connectionId: "d" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // …so the shared snapshot must be re-read anyway: otherwise Settings (and
      // every other view of the connections) keeps showing the old model until
      // some unrelated load happens.
      expect(harness.settings.load).toHaveBeenCalled();
    });
  });
});
