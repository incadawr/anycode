import { useEffect, useRef, useState } from "react";
import { Button, Checkbox } from "../ui/index.js";
import type { ChildWorktreeView } from "../../../shared/child-worktree-view.js";
import { useHeaderMenuPosition } from "./useHeaderMenuPosition.js";

/** Self-contained so the header menu can move this control without new state wiring. */
export function ChildWorktreeControl({ tabId }: { tabId: string }) {
  const [view, setView] = useState<ChildWorktreeView | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  useHeaderMenuPosition(open, menuRef);
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
  return <details className="environment-control child-worktree-control" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="environment-trigger"><span>Child worktrees{view?.enabled ? " · ON" : ""}</span></summary>
    <div ref={menuRef} className="environment-menu" style={{ maxHeight: "75vh", overflow: "auto", overflowWrap: "anywhere" }}>
    <Checkbox label="New session children in worktrees" checked={view?.enabled ?? false}
      disabled={!view?.canToggle || busy} onCheckedChange={enabled => void toggle(enabled)} />
    <p>Each new child session works in its own Git checkout of the last commit (uncommitted files aren't copied). Not a sandbox: shell commands can still change files outside it.</p>
    <p>Changes stay in the child's checkout — review and merge them yourself. <a href="https://github.com/incadawr/anycode/blob/master/docs/user/subagents.md#session-children-in-worktrees" target="_blank" rel="noreferrer">How →</a></p>
    {error && <p role="alert">{error}</p>}
    {view?.lastRefusal && <p role="alert">Last creation refused: {view.lastRefusal}</p>}
    {view?.unverified?.map(r => <p key={r.id}>Worktree receipt unverified · {r.id}: {r.reason} (project/session association unverified)</p>)}
    {!!view?.resources.length && <ul>{view.resources.map(r => <li key={r.id}>
      <strong>Worktree · cwd only</strong> · {r.phase === "active" ? "active (live)" : r.phase === "retained" ? "retained (kept)" : r.phase === "removed" ? "removed" : "unknown"} · {r.childSessionId}
      {!["intent", "not-created"].includes(r.phase) && <p>{r.path} <Button size="sm" variant="ghost" aria-label="Copy path" onClick={() => copy(r.path)}>{copied === r.path ? "Copied" : "Copy path"}</Button></p>}
      <p>{r.branch} <Button size="sm" variant="ghost" aria-label="Copy branch" onClick={() => copy(r.branch)}>{copied === r.branch ? "Copied" : "Copy branch"}</Button></p>
      <details><summary>Base {r.baseSha.slice(0, 12)}</summary>{r.baseSha}</details>
      <p>{r.reason ?? (r.phase === "active" ? "Child checkout active." : r.phase === "retained"
        ? "Checkout and branch kept; inspect manually." : r.phase === "removed"
          ? "Folder removed; branch retained." : "Creation or completion unconfirmed; inspect the resource journal.")}</p>
    </li>)}</ul>}
    </div>
  </details>;
}
