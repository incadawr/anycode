import { useEffect, useRef, useState } from "react";
import { CHILD_WORKTREE_LIMITATION, type ChildWorktreeView } from "../../../shared/child-worktree-view.js";

/** Self-contained so the header menu can move this control without new state wiring. */
export function ChildWorktreeControl({ tabId }: { tabId: string }) {
  const [view, setView] = useState<ChildWorktreeView | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0), mutating = useRef(false);
  const api = window.anycode.childWorktrees;
  useEffect(() => {
    if (!api) return;
    let disposed = false, pending = false;
    setView(null); setError("");
    const refresh = async () => {
      if (pending || mutating.current) return;
      const version = revision.current;
      pending = true;
      try { const next = await api({ tabId }); if (!disposed && version === revision.current) { setView(next); setError(""); } }
      catch (e) { if (!disposed && version === revision.current) setError(String(e)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = open ? setInterval(() => void refresh(), 2500) : undefined;
    return () => { disposed = true; clearInterval(timer); };
  }, [api, tabId, open]);
  if (!api) return null;
  const toggle = async (enabled: boolean) => {
    revision.current++; mutating.current = true; setBusy(true);
    try { setView(await api({ tabId, enabled })); setError(""); }
    catch (e) { setError(String(e)); }
    finally { mutating.current = false; setBusy(false); }
  };
  const copy = (text: string) => { void navigator.clipboard.writeText(text).catch(e => setError(String(e))); };
  return <details className="environment-control" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="environment-trigger">Child worktrees{view?.enabled ? " · ON" : ""}</summary>
    <div className="environment-menu" style={{ maxHeight: "75vh", overflow: "auto", overflowWrap: "anywhere" }}>
    <p>{CHILD_WORKTREE_LIMITATION}</p>
    <label><input type="checkbox" checked={view?.enabled ?? false} disabled={!view?.canToggle || busy}
      onChange={event => void toggle(event.currentTarget.checked)} />New session children in worktrees</label>
    <p>Core session children only. Inline agents use the current cwd. No inherited trust or access grants.</p>
    {error && <p role="alert">{error}</p>}
    {view?.lastRefusal && <p role="alert">{view.lastRefusal} Choose Core and start a new child.</p>}
    <ul>{view?.resources.map(r => <li key={r.id}>
      <strong>Worktree · cwd only</strong> · {r.phase === "active" ? "active (live)" : r.phase === "retained" ? "retained (kept)" : r.phase} · {r.childSessionId}
      <p>{r.path} <button aria-label="Copy path" onClick={() => copy(r.path)}>Copy path</button></p>
      <p>{r.branch} <button aria-label="Copy branch" onClick={() => copy(r.branch)}>Copy branch</button></p>
      <details><summary>Base {r.baseSha.slice(0, 12)}</summary>{r.baseSha}</details>
      <p>{r.reason ?? (r.phase === "intent" ? "Creation pending; inspect any residue manually." : "Child checkout active.")}</p>
      {r.phase === "removed" && <p>Folder removed; branch retained.</p>}
    </li>)}</ul>
    <p>Review retained work manually: first <code>git -C '&lt;child-path&gt;' diff HEAD</code> (inspect untracked files separately),
      commit in the retained checkout if needed, then in the parent review <code>git diff &lt;base-sha&gt;..&lt;branch&gt;</code>.
      Merge/cherry-pick manually after review. A branch alone cannot transfer uncommitted files. Nothing runs automatically.
      After a crash, inspect the retained path manually; no automatic cleanup or managed-session resume.</p>
    </div>
  </details>;
}
