import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EngineId } from "../../../shared/engines.js";
import type { EngineModelChoice, EngineSwitchTarget } from "../../../shared/protocol.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";
import { useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { useSettingsStore } from "../settings-store.js";
import { watchExternalEngines } from "../engine-availability.js";
import { CLAUDE_DRAFT_MODELS } from "../claude-draft-models.js";
import { buildStartModelGroups } from "./start-model-picker.js";
import { connectionCredentialKey } from "./ConnectionTile.js";

export const ENGINE_SWITCH_CONSEQUENCE = "Conversation text will be imported. Native engine context will not be transferred.";
export interface EngineSwitchChoice { label: string; target: EngineSwitchTarget }

export function engineSwitchChoices(current: EngineId, ready: readonly EngineId[], snapshot: SettingsSnapshot | null, codexModels: readonly EngineModelChoice[]): EngineSwitchChoice[] {
  const choices: EngineSwitchChoice[] = [];
  if (current !== "core" && ready.includes("core") && snapshot) {
    const connections = snapshot.settings.provider.connections.filter(connection => {
      const catalog = snapshot.catalog?.find(entry => entry.id === connection.providerId);
      const key = connectionCredentialKey(connection.id, connection.providerId, catalog?.authKind ?? "api_key");
      return connection.authOptional || catalog?.authOptional || snapshot.secrets.some(secret => secret.key === key && secret.set && secret.source !== "none");
    });
    for (const group of buildStartModelGroups(connections, snapshot.catalog, snapshot.settings.provider.custom, { connectionId: undefined, modelId: "" }, snapshot.envOverrides)) {
      for (const model of group.items) choices.push({ label: `Core · ${group.label} · ${model.name}`, target: { engine: "core", model: model.id, connectionId: group.connectionId } });
    }
  }
  if (current !== "codex" && ready.includes("codex")) for (const model of codexModels) choices.push({ label: `Codex · ${model.label}`, target: { engine: "codex", model: model.id } });
  if (current !== "claude" && ready.includes("claude")) for (const model of CLAUDE_DRAFT_MODELS) choices.push({ label: `Claude · ${model.label}`, target: { engine: "claude", model: model.id } });
  return choices;
}

/** Shared across all running engines; the active chip changes only on correlated success. */
export function EngineSwitchPicker() {
  const enabled = useTabStore(state => state.engineSwitch !== null);
  const current = useTabStore(state => state.engine?.id ?? "core");
  const pending = useTabStore(state => state.pendingEngineSwitch);
  const idle = useTabStore(state => state.connection === "ready" && state.turn.status === "idle" && !state.queueInFlight && !state.permission && !state.childSurface && state.backgroundChildren.length === 0);
  const snapshot = useSettingsStore(state => state.snapshot);
  const store = useTabStoreApi();
  const send = useTabSend();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<EngineId[]>([]);
  const [models, setModels] = useState<readonly EngineModelChoice[]>([]);
  const [selection, setSelection] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let epoch = 0;
    const stop = watchExternalEngines(window.anycode, (_available, ids) => {
      setReady(ids);
      setModels([]);
      const ticket = ++epoch;
      if (ids.includes("codex")) void window.anycode.codex.recheck().then(result => {
        if (live && ticket === epoch && result.report.status === "ready") setModels(result.report.models ?? []);
      }).catch(() => {});
    });
    return () => { live = false; stop(); };
  }, [enabled]);
  useEffect(() => { setOpen(false); setSelection(""); }, [current]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  if (!enabled) return null;
  const choices = engineSwitchChoices(current, ready, snapshot, models);
  const rect = trigger.current?.getBoundingClientRect();
  return <>
    <button ref={trigger} type="button" className="model-pill-chip" aria-label="Switch engine" aria-expanded={open} disabled={!idle || pending !== null} onClick={() => setOpen(value => !value)}>{current}{pending ? " · switching…" : " ▾"}</button>
    {open && createPortal(<div className="model-pill-popover" role="dialog" aria-label="Switch engine and model" style={{ position: "fixed", left: Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 360)), bottom: window.innerHeight - (rect?.top ?? 40) + 8, width: 340, maxHeight: "70vh", overflowY: "auto", padding: 12, zIndex: 1000 }}>
      <p>{ENGINE_SWITCH_CONSEQUENCE}</p>
      <select aria-label="Target engine and model" value={selection} onChange={event => setSelection(event.target.value)} style={{ width: "100%" }}>
        <option value="">Choose engine and model</option>
        {choices.map((choice, index) => <option key={index} value={String(index)}>{choice.label}</option>)}
      </select>
      {choices.length === 0 && <p>No other ready engines with models.</p>}
      <button type="button" disabled={!idle || pending !== null || !choices[Number(selection)] || selection === ""} onClick={() => {
        const target = choices[Number(selection)]?.target;
        if (!target) return;
        const requestId = crypto.randomUUID();
        const generation = store.getState().beginEngineSwitch(requestId, target);
        if (generation === null) return;
        setOpen(false);
        send({ type: "engine_switch_request", requestId, generation, ...target });
      }}>Switch engine</button>
      <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Cancel</button>
    </div>, document.body)}
  </>;
}
