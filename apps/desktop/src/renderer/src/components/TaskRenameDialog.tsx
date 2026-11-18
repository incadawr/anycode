import { useEffect, useRef, useState } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import type { SidebarRow } from "./Sidebar.js";

export function TaskRenameDialog({ row, onSave, onCancel }: { row: SidebarRow; onSave(title: string): Promise<boolean>; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(row.userTitle ?? row.baseTitle ?? "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  useOverlayFlag(true);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    input.current?.focus(); input.current?.select();
    return () => { if (previous?.isConnected) previous.focus(); else document.querySelector<HTMLInputElement>('.sidebar-search-input')?.focus(); };
  }, []);
  async function save(title: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(false);
    try { if (!(await onSave(title))) setError(true); } catch { setError(true); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="git-confirm-dialog" aria-label="Rename task" onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }} onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
    <form onKeyDown={e => { if (e.nativeEvent.isComposing) e.stopPropagation(); }} onSubmit={e => { e.preventDefault(); void save(value); }}>
      <div className="git-confirm-header"><span className="git-confirm-title">Rename task</span></div>
      <div className="git-confirm-body"><label>Task name <input ref={input} value={value} maxLength={160} onChange={e => setValue(e.target.value)} /></label>{error && <p role="alert">Could not rename task. Please try again.</p>}</div>
      <div className="git-confirm-actions">
        {row.userTitle != null && <button type="button" disabled={busy} onClick={() => void save("")}>Reset to automatic title</button>}
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy}>Save</button>
      </div>
    </form>
  </dialog>;
}
