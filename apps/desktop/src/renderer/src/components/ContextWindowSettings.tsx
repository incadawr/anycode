import { useEffect, useRef, useState } from "react";
import type { ProviderConnection, SettingsSnapshot } from "../../../shared/settings.js";
import { contextWindowTokensField, modelOverrideFor } from "../../../shared/model-overrides.js";
import { useSettingsStore } from "../settings-store.js";
import { X } from "./icons.js";

/** This shortcut edits one model's window, without changing connection defaults. */
export default function ContextWindowSettings({ snapshot, connection, model, onClose }: {
  snapshot: SettingsSnapshot;
  connection: ProviderConnection;
  model: string;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initial = modelOverrideFor(connection, model)?.contextWindowTokens;
  const [raw, setRaw] = useState(initial === undefined ? "" : String(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useSettingsStore((state) => state.connectionUpdate);
  const parsed = contextWindowTokensField(raw);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  async function save(): Promise<void> {
    if (snapshot.readOnly || saving || !parsed.ok || !model.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await update({ id: connection.id, modelOverrideModel: model, contextWindowTokens: parsed.value });
      if (result.ok) onClose();
      else setError(result.reason === "not_found" ? "This connection no longer exists." : "The context window could not be saved.");
    } catch {
      setError("The context window could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialogRef} className="connection-drawer" aria-label="Context window"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="connection-drawer-header">
      <span className="connection-drawer-title">Context window</span>
      <button type="button" className="connection-drawer-close" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
    </div>
    <form className="connection-drawer-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="settings-field-hint">Model: {model}</p>
      <label className="settings-field">
        <span className="settings-field-label">Context window (tokens)</span>
        <input ref={inputRef} className="settings-field-input" aria-label="Context window (tokens)"
          type="number" min={1024} max={1000000} step={1} value={raw} disabled={snapshot.readOnly || saving}
          placeholder="Default" onChange={(event) => { setRaw(event.target.value); setError(null); }} />
      </label>
      <p className="settings-field-hint">Blank uses the catalog window or the assumed fallback. Applies on the next turn or model switch.</p>
      {!parsed.ok && <p role="alert">Enter a whole number from 1024 to 1000000, or leave blank.</p>}
      {error !== null && <p role="alert">{error}</p>}
      <div className="connection-drawer-footer">
        <button type="submit" className="settings-button settings-button-primary" disabled={snapshot.readOnly || saving || !parsed.ok}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </form>
  </dialog>;
}
