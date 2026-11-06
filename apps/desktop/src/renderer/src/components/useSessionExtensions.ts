import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DesktopStoreApi } from "../tab-registry.js";
import type { McpConfigSnapshot, McpConfigMutationResult } from "../../../shared/mcp-config.js";
import type { PluginsSnapshot, PluginsMutationResult } from "../../../shared/plugins-config.js";
import type { SkillsSnapshot, SkillsMutationResult } from "../../../shared/skills-config.js";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";
import { hasFailedExtensionMcp, projectExtensionMcp, type ExtensionReadState } from "./extensions-model.js";

/** Opening the menu only reads; explicit switches use the lossless config patch. */
export interface SessionExtensionsBridge {
  mcpConfig?: Pick<Window["anycode"]["mcpConfig"], "get"> & Partial<Pick<Window["anycode"]["mcpConfig"], "setEnabled">>;
  plugins?: Pick<Window["anycode"]["plugins"], "list" | "onChanged"> & Partial<Pick<Window["anycode"]["plugins"], "setEnabled">>;
  skills?: Pick<Window["anycode"]["skills"], "list"> & Partial<Pick<Window["anycode"]["skills"], "setEnabled">>;
  lspConfig?: Pick<Window["anycode"]["lspConfig"], "status">;
}
type Snapshots = { mcp: McpConfigSnapshot; plugins: PluginsSnapshot; skills: SkillsSnapshot; lsp: LspConfigStatus };
export type ExtensionCategory = keyof Snapshots;
type CatalogCategory = "skills" | "plugins";
export type ExtensionToggleControls = { setEnabled: (key: string) => void; busy: boolean; writable: boolean;
  write: { pendingKey: string; error: string; savedKeys: string[] } };
const emptyWrite = () => ({ pendingKey: "", error: "", savedKeys: [] as string[] });
type Reads = { [K in ExtensionCategory]: ExtensionReadState<Snapshots[K]> & { generation: number } };
const absentBridge: SessionExtensionsBridge = {};
const categories: ExtensionCategory[] = ["mcp", "plugins", "skills", "lsp"];
const pluginCategories: ExtensionCategory[] = ["mcp", "plugins", "skills"];
const loading = (): Reads => ({
  mcp: { status: "loading", generation: 0 }, plugins: { status: "loading", generation: 0 },
  skills: { status: "loading", generation: 0 }, lsp: { status: "loading", generation: 0 },
});

export function useSessionExtensions({ tabId, store, bridge = window.anycode ?? absentBridge }: {
  tabId: string;
  store: DesktopStoreApi;
  bridge?: SessionExtensionsBridge;
}) {
  const workspace = useStore(store, (s) => s.workspace);
  const engine = useStore(store, (s) => s.engine?.id ?? null);
  const connection = useStore(store, (s) => s.connection);
  // Observe runtime even before the first menu open.
  const mcpServers = useStore(store, (s) => s.mcpServers);
  const lspServers = useStore(store, (s) => s.lspServers);
  const scope = JSON.stringify([tabId, workspace, engine, connection]);
  const [menu, setMenu] = useState({ scope, open: false });
  const open = menu.scope === scope && menu.open;
  const [state, setState] = useState<{ scope: string; reads: Reads }>({ scope, reads: loading() });
  const writeScope = JSON.stringify([tabId, workspace]);
  const locks = useRef(new Set<string>());
  const catalogLocks = useRef(new Set<string>());
  const dirty = useRef(new Set<ExtensionCategory>());
  const catalogToken = (category: CatalogCategory) => category === "plugins" ? "plugins" : `skills:${writeScope}`;
  const blocked = (category: ExtensionCategory) => category === "mcp" ? locks.current.has(writeScope)
    : category !== "lsp" && catalogLocks.current.has(catalogToken(category));
  const [catalogWrite, setCatalogWrite] = useState({ scope, skills: emptyWrite(), plugins: emptyWrite() });
  const catalogRead = useRef({ cancel: (_category: CatalogCategory) => {},
    accept: (_category: CatalogCategory, _snapshot: SkillsSnapshot | PluginsSnapshot) => {} });
  const catalogOperation = useRef<(category: CatalogCategory, key: string) => Promise<void>>(async () => {});
  const currentWriteScope = useRef(writeScope);
  currentWriteScope.current = writeScope;
  const [, redraw] = useState(0);
  const mounted = useRef(false);
  const refreshCancels = useRef(new Set<() => void>());
  const [mcpWrite, setMcpWrite] = useState({ scope, pendingKey: "", error: "", savedKeys: [] as string[] });
  const currentReads = useRef(state);
  currentReads.current = state;
  const mcpRead = useRef({ cancel: () => {}, accept: (_snapshot: McpConfigSnapshot) => {} });
  const writeMcp = useRef<(key: string) => Promise<void>>(async () => {});
  const setMcpEnabled = useCallback((key: string) => { void writeMcp.current(key); }, []);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    for (const cancel of refreshCancels.current) cancel();
  }; }, []);
  useEffect(() => {
    let disposed = false;
    setMcpWrite({ scope, pendingKey: "", error: "", savedKeys: [] });
    writeMcp.current = async (key) => {
      const read = currentReads.current;
      if (disposed || !workspace || read.scope !== scope || read.reads.mcp.status !== "ready" || locks.current.has(writeScope)) return;
      const entry = read.reads.mcp.snapshot.entries.find((row) => JSON.stringify([row.source, row.name]) === key);
      if (!entry || (entry.source !== "project" && entry.source !== "user")) return;
      locks.current.add(writeScope);
      mcpRead.current.cancel();
      setMcpWrite((previous) => ({ ...previous, scope, pendingKey: key, error: "" }));
      try {
        const result: McpConfigMutationResult | undefined = await bridge.mcpConfig?.setEnabled?.({ tabId, scope: entry.source, name: entry.name, enabled: !entry.enabled });
        if (disposed) return;
        if (result?.ok) {
          mcpRead.current.accept(result.snapshot);
          setMcpWrite((previous) => ({ ...previous, pendingKey: "", savedKeys: [...new Set([...previous.savedKeys, key])] }));
        } else {
          const error = result && !result.ok ? {
            invalid: "Could not save this change. Check the configuration in Settings.",
            no_workspace: "This project is no longer available.",
            read_only_source: "This source is read-only. Manage it in Settings.",
            io_error: "Could not write the configuration. Retry or manage it in Settings.",
            not_found: "This entry no longer exists. Refreshing the configuration.",
          }[result.reason] : "Saving is unavailable. Manage MCP servers in Settings.";
          setMcpWrite((previous) => ({ ...previous, pendingKey: "", error }));
          if (result && !result.ok && result.reason === "not_found") {
            locks.current.delete(writeScope);
            reload.current("mcp");
          }
        }
      } catch {
        if (!disposed) setMcpWrite((previous) => ({ ...previous, pendingKey: "", error: "Could not save this change. Retry or manage it in Settings." }));
      } finally {
        locks.current.delete(writeScope);
        if (mounted.current) {
          redraw((value) => value + 1);
          // A rehost/disconnect may have skipped reads while this scope was locked.
          if ((disposed && currentWriteScope.current === writeScope) || dirty.current.delete("mcp")) reload.current("mcp");
        }
      }
    };
    return () => { disposed = true; writeMcp.current = async () => {}; };
  }, [scope, writeScope, tabId, workspace, bridge]);
  useEffect(() => {
    let disposed = false;
    setCatalogWrite({ scope, skills: emptyWrite(), plugins: emptyWrite() });
    catalogOperation.current = async (category, key) => {
      const read = currentReads.current;
      const token = catalogToken(category);
      if (disposed || !workspace || read.scope !== scope || catalogLocks.current.has(token)) return;
      const skillRead = read.reads.skills;
      const pluginRead = read.reads.plugins;
      const skill = skillRead.status === "ready" ? skillRead.snapshot.rows.find((row) => JSON.stringify([row.sourceKind, row.name]) === key) : undefined;
      const plugin = pluginRead.status === "ready" ? pluginRead.snapshot.plugins.find((row) => row.name === key) : undefined;
      if (category === "skills" ? !skill || !["project", "user"].includes(skill.sourceKind) : !plugin) return;
      catalogLocks.current.add(token);
      catalogRead.current.cancel(category);
      const updateWrite = (patch: Partial<ExtensionToggleControls["write"]>) => {
        if (!disposed) setCatalogWrite((previous) => ({ ...previous, [category]: { ...previous[category], ...patch } }));
      };
      updateWrite({ pendingKey: key, error: "" });
      let changedPlugin = false;
      try {
        const result: SkillsMutationResult | PluginsMutationResult | undefined = category === "skills"
          ? await bridge.skills?.setEnabled?.({ tabId, name: skill!.name, enabled: !skill!.enabled })
          : await bridge.plugins?.setEnabled?.(plugin!.name, plugin!.disabled);
        if (!result?.ok) {
          updateWrite({ error: result && result.reason === "not_found" ? "This entry no longer exists. Refreshing the catalog."
            : "Could not save this change. Retry or manage it in Settings." });
          if (result && result.reason === "not_found") dirty.current.add(category);
          return;
        }
        changedPlugin = category === "plugins";
        if (!mounted.current) return;
        // Plugin writes are global, but the catalog read retains the originating tab.
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let cancelRefresh = () => {};
        const snapshot = "snapshot" in result ? result.snapshot : await Promise.race([
          bridge.plugins?.list({ tabId }),
          new Promise<never>((_resolve, reject) => {
            cancelRefresh = () => reject(new Error("Catalog unavailable"));
            refreshCancels.current.add(cancelRefresh);
            refreshTimer = setTimeout(cancelRefresh, 5_000);
          }),
        ]).finally(() => { clearTimeout(refreshTimer); refreshCancels.current.delete(cancelRefresh); });
        if (!disposed && snapshot) {
          if (category === "plugins") dirty.current.delete(category);
          catalogRead.current.accept(category, snapshot);
          setCatalogWrite((previous) => ({ ...previous, [category]: { ...previous[category],
            savedKeys: [...new Set([...previous[category].savedKeys, key])] } }));
        }
      } catch {
        updateWrite({ error: changedPlugin ? "Saved, but could not reload the catalog. Retry."
          : "Could not save this change. Retry or manage it in Settings." });
      } finally {
        catalogLocks.current.delete(token);
        updateWrite({ pendingKey: "" });
        if (mounted.current) {
          redraw((value) => value + 1);
          if (dirty.current.delete(category) || disposed) reload.current(category);
          if (changedPlugin) for (const dependency of ["mcp", "skills"] as const) {
            dirty.current.add(dependency);
            reload.current(dependency);
          }
        }
      }
    };
    return () => { disposed = true; catalogOperation.current = async () => {}; };
  }, [scope, writeScope, tabId, workspace, bridge]);
  const everOpened = useRef(false);
  const lastScope = useRef(scope);
  const sequence = useRef(0);
  const reload = useRef<(category?: ExtensionCategory) => void>(() => {});
  const setOpen = useCallback((value: boolean) => setMenu({ scope, open: value }), [scope]);
  const retry = useCallback((category?: ExtensionCategory) => {
    if (!category || category === "mcp") setMcpWrite((previous) => ({ ...previous, error: "", savedKeys: [] }));
    setCatalogWrite((previous) => ({ ...previous,
      ...(!category || category === "skills" ? { skills: { ...previous.skills, error: "", savedKeys: [] } } : {}),
      ...(!category || category === "plugins" ? { plugins: { ...previous.plugins, error: "", savedKeys: [] } } : {}),
    }));
    reload.current(category);
  }, []);

  useEffect(() => {
    let disposed = false;
    const changedScope = lastScope.current !== scope;
    lastScope.current = scope;
    if (changedScope) {
      setState({ scope, reads: loading() });
      setMenu({ scope, open: false });
    }
    const pending = new Map<ExtensionCategory, { generation: number; timer: ReturnType<typeof setTimeout> }>();
    function cancel(category: ExtensionCategory) {
      const request = pending.get(category);
      if (request) clearTimeout(request.timer);
      pending.delete(category);
    }
    function update<K extends ExtensionCategory>(category: K, value: Reads[K]) {
      if (disposed) return;
      setState((previous) => ({
        scope, reads: { ...(previous.scope === scope ? previous.reads : loading()), [category]: value },
      }));
    }
    function request<K extends ExtensionCategory>(category: K) {
      if (disposed) return;
      if (blocked(category)) return;
      dirty.current.delete(category);
      cancel(category);
      const generation = ++sequence.current;
      update(category, { status: "loading", generation });
      function finish(value: ExtensionReadState<Snapshots[K]>) {
        if (disposed || pending.get(category)?.generation !== generation) return;
        cancel(category);
        update(category, { ...value, generation } as Reads[K]);
      }
      const timer = setTimeout(() => finish({ status: "unavailable" }), 5_000);
      pending.set(category, { generation, timer });
      // Each rejection (including a missing bridge or synchronous throw) settles independently.
      void Promise.resolve().then(() => {
        if (disposed || pending.get(category)?.generation !== generation) return undefined;
        switch (category) {
          case "mcp": return bridge.mcpConfig?.get({ tabId });
          case "plugins": return bridge.plugins?.list({ tabId });
          case "skills": return bridge.skills?.list({ tabId });
          case "lsp": return bridge.lspConfig?.status({ tabId });
        }
      }).then((snapshot) => finish(snapshot === undefined
        ? { status: "unavailable" }
        : { status: "ready", snapshot: snapshot as Snapshots[K] }),
      () => finish({ status: "unavailable" }));
    }
    function load(selected = categories) { selected.forEach(request); }
    mcpRead.current = { cancel: () => cancel("mcp"), accept: (snapshot) => {
      cancel("mcp");
      update("mcp", { status: "ready", snapshot, generation: ++sequence.current });
    } };
    catalogRead.current = { cancel, accept: (category, snapshot) => {
      cancel(category);
      update(category, { status: "ready", snapshot, generation: ++sequence.current } as Reads[typeof category]);
    } };
    reload.current = (category) => load(category ? [category] : categories);
    if (open || (changedScope && everOpened.current)) load();
    if (open) everOpened.current = true;
    const onFocus = () => { if (open) load(); };
    const unsubscribe = bridge.plugins?.onChanged(() => {
      for (const category of pluginCategories) if (blocked(category)) dirty.current.add(category);
      if (open) load(pluginCategories);
      else for (const category of pluginCategories) {
        if (blocked(category)) { dirty.current.add(category); continue; }
        cancel(category);
        update(category, { status: "loading", generation: ++sequence.current });
      }
    });
    window.addEventListener("focus", onFocus);
    // IPC reads have no abort API; disposal invalidates their completions.
    return () => {
      disposed = true;
      reload.current = () => {};
      categories.forEach(cancel);
      unsubscribe?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [scope, tabId, bridge, open]);

  const reads = state.scope === scope ? state.reads : loading();
  const mcpRows = projectExtensionMcp(reads.mcp.status === "ready" ? reads.mcp.snapshot : undefined,
    mcpServers, connection === "ready");
  const catalogControls = Object.fromEntries((["skills", "plugins"] as const).map((category) => [category, {
    setEnabled: (key: string) => { void catalogOperation.current(category, key); },
    busy: catalogLocks.current.has(catalogToken(category)), writable: !!bridge[category]?.setEnabled,
    write: catalogWrite.scope === scope ? catalogWrite[category] : emptyWrite(),
  }])) as Record<CatalogCategory, ExtensionToggleControls>;
  return { catalogControls, open, setOpen, retry, reads, mcpServers, engine, connection, mcpRows, lspServers,
    mcpFailed: hasFailedExtensionMcp(mcpServers), setMcpEnabled,
    mcpBusy: locks.current.has(writeScope), mcpWritable: !!bridge.mcpConfig?.setEnabled,
    mcpWrite: mcpWrite.scope === scope ? mcpWrite : { scope, pendingKey: "", error: "", savedKeys: [] } };
}
