import { useEffect, useRef, useState } from "react";
import { Button, Checkbox } from "../ui/index.js";
import { CHILD_WORKTREE_LIMITATION, type ChildWorktreeView } from "../../../shared/child-worktree-view.js";

/** Self-contained so the header menu can move this control without new state wiring. */
export function ChildWorktreeControl({ tabId }: { tabId: string }) {
  const [view, setView] = useState<ChildWorktreeView | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const revision = useRef(0), mutating = useRef(false);
  const lifetime = useRef<object | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { const token = {}; lifetime.current = token;
    mutating.current = false; setBusy(false); setCopied("");
    return () => { clearTimeout(copyTimer.current); if (lifetime.current === token) lifetime.current = null; };
  }, [tabId]);
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
    const token = lifetime.current;
    revision.current++; mutating.current = true; setBusy(true);
    try { const next = await api({ tabId, enabled }); if (token === lifetime.current) { setView(next); setError(""); } }
    catch (e) { if (token === lifetime.current) setError(String(e)); }
    finally { if (token === lifetime.current) { mutating.current = false; setBusy(false); } }
  };
  const copy = (text: string) => {
    const token = lifetime.current;
    void navigator.clipboard?.writeText(text).then(() => {
      if (token !== lifetime.current) return;
      clearTimeout(copyTimer.current);
      setCopied(text);
      copyTimer.current = setTimeout(() => { if (token === lifetime.current) setCopied(""); }, 1500);
    }, () => {});
  };
  return <details className="environment-control" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="environment-trigger">Child worktrees{view?.enabled ? " · ON" : ""}</summary>
    <div className="environment-menu" style={{ maxHeight: "75vh", overflow: "auto", overflowWrap: "anywhere" }}>
    <p>{CHILD_WORKTREE_LIMITATION}</p>
    <Checkbox label="New session children in worktrees" checked={view?.enabled ?? false}
      disabled={!view?.canToggle || busy} onCheckedChange={enabled => void toggle(enabled)} />
    <p>Core session children only. Inline agents use the current cwd. No inherited trust or access grants.</p>
    {error && <p role="alert">{error}</p>}
    {view?.lastRefusal && <p role="alert">Last creation refused: {view.lastRefusal}</p>}
    {view?.unverified?.map(r => <p key={r.id}>Worktree receipt unverified · {r.id}: {r.reason} (project/session association unverified)</p>)}
    <ul>{view?.resources.map(r => <li key={r.id}>
      <strong>Worktree · cwd only</strong> · {r.phase === "active" ? "active (live)" : r.phase === "retained" ? "retained (kept)" : r.phase === "removed" ? "removed" : "unknown"} · {r.childSessionId}
      {!["intent", "not-created"].includes(r.phase) && <p>{r.path} <Button size="sm" variant="ghost" aria-label="Copy path" onClick={() => copy(r.path)}>{copied === r.path ? "Copied" : "Copy path"}</Button></p>}
      <p>{r.branch} <Button size="sm" variant="ghost" aria-label="Copy branch" onClick={() => copy(r.branch)}>{copied === r.branch ? "Copied" : "Copy branch"}</Button></p>
      <details><summary>Base {r.baseSha.slice(0, 12)}</summary>{r.baseSha}</details>
      <p>{r.reason ?? (r.phase === "active" ? "Child checkout active." : r.phase === "retained"
        ? "Checkout and branch kept; inspect manually." : r.phase === "removed"
          ? "Folder removed; branch retained." : "Creation or completion unconfirmed; inspect the resource journal.")}</p>
    </li>)}</ul>
    <p>Review retained work manually: first <code>git -C '&lt;child-path&gt;' diff HEAD</code> (inspect untracked files separately),
      commit in the retained checkout if needed, then in the parent review <code>git diff &lt;base-sha&gt;..&lt;branch&gt;</code>.
      Merge/cherry-pick manually after review. A branch alone cannot transfer uncommitted files. Nothing runs automatically.
      After a crash, inspect the retained path manually; no automatic cleanup or managed-session resume.</p>
    </div>
  </details>;
}
