import { useEffect, useId, useRef, useState } from "react";
import { useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { Button, SearchInput } from "../ui/index.js";
import { GitBranch, Spinner } from "./icons.js";
import { gitPillLabel } from "./GitPill.js";

export function EnvironmentBranchPicker({ back, retry, switched }: {
  back: () => void; retry: () => void; switched: () => void;
}) {
  const store = useTabStoreApi();
  const send = useTabSend();
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const creating = useRef(false);
  const [target, setTarget] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "warning" | "pending" | "error">("idle");
  const [switchError, setSwitchError] = useState("");
  const locked = phase === "pending" || phase === "warning";
  function performSwitch(name: string, create = creating.current) {
    if (inFlight.current) return;
    creating.current = create;
    if (create && (!name || name.length > 512 || name === "@" || name === "HEAD" || name.startsWith("-") ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.endsWith(".") ||
      name.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")))) {
      setTarget(name); setSwitchError("Invalid branch name"); setPhase("error"); return;
    }
    inFlight.current = true;
    setTarget(name);
    setPhase("pending");
    const requestId = crypto.randomUUID();
    store.getState().gitRequestStarted(requestId, { kind: "mutation", label: create ? "create branch" : "switch branch", onResult: outcome => {
      if (!alive.current) return;
      inFlight.current = false;
      if (outcome.ok) switched();
      else { setSwitchError(outcome.reason); setPhase("error"); }
    } });
    send({ type: "git_command", requestId, command: create ? { op: "create_branch", name, switch: true } : { op: "switch_branch", name } });
  }
  function select(name: string, create = false) {
    if (locked || inFlight.current) return;
    creating.current = create;
    setTarget(name);
    if ((store.getState().git.status?.dirtyCount ?? 0) > 0) setPhase("warning");
    else performSwitch(name, create);
  }
  const status = useTabStore(s => s.git.status);
  const branches = useTabStore(s => s.git.branches);
  const error = useTabStore(s => s.git.branchesError);
  const loading = useTabStore(s => Object.values(s.git.pending).some(p => p.kind === "branches"));
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const query = filter.trim().toLowerCase();
  const matching = (branches ?? []).filter(b => !b.current && b.name !== status?.head.branch && b.name.toLowerCase().includes(query));
  const createName = filter.trim();
  const offerCreate = !!createName && branches !== null && !loading && !error && !(branches.some(b => b.name.toLowerCase() === query) || status?.head.branch?.toLowerCase() === query);
  const names = [status ? gitPillLabel(status) : null, ...(!loading && !error ? matching.map(b => b.name) : []), ...(offerCreate ? [createName] : [])].filter((n): n is string => n !== null);
  const index = Math.min(active, Math.max(0, names.length - 1));
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [index, filter]);
  function choose(i: number) { if (!locked && i > 0 && names[i]) select(names[i]!, offerCreate && i === names.length - 1); }
  function option(name: string, i: number, create = false) {
    return <div key={name} id={`${id}-${i}`} role="option" aria-selected={i === 0} aria-disabled={locked} aria-busy={phase === "pending" && name === target} data-active={index === i}
      className={`environment-branch-row${i === 0 ? " environment-branch-row-current" : ""}`}
      onMouseMove={() => setActive(i)} onClick={() => choose(i)}>
      {phase === "pending" && name === target ? <Spinner className="icon-spin" /> : <GitBranch />}<span title={name}>{create ? `Create branch “${name}”` : name}</span>{phase === "pending" && name === target && <span role="status">{creating.current ? "Creating…" : "Switching…"}</span>}{i === 0 && <span aria-label="Current branch">✓</span>}
    </div>;
  }
  return <section className="environment-branch-picker" aria-label="Switch branch">
    <div className="environment-menu-actions">
      <Button variant="ghost" size="sm" aria-label="Back" disabled={phase === "pending"} onClick={back}>‹</Button>
      <h3>Switch branch · {branches?.length ?? "…"}</h3>
    </div>
    {phase === "warning" && <div role="alert" className="environment-switch-warning">
      <strong>{status?.dirtyCount} uncommitted changes</strong>
      <div>Switch to {target}? Changes may move to the new branch. If they would be overwritten, Git will refuse the switch.</div>
      <div className="environment-menu-actions">
        <Button variant="secondary" size="sm" onClick={() => performSwitch(target!)}>Switch anyway</Button>
        <Button variant="ghost" size="sm" onClick={() => { setPhase("idle"); setTarget(null); }}>Cancel</Button>
      </div>
    </div>}
    {phase === "error" && <div role="alert" className="environment-switch-error">
      <strong>Couldn't {creating.current ? "create" : "switch to"} {target}</strong>
      <div>{switchError}</div>
      <Button variant="secondary" size="sm" onClick={() => performSwitch(target!)}>Retry</Button>
    </div>}
    <SearchInput autoFocus label="Filter branches" disabled={locked} className="environment-menu-text-input" aria-label="Filter branches" placeholder="Filter branches"
      role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={id}
      aria-describedby={`${id}-hint`} aria-activedescendant={names.length ? `${id}-${index}` : undefined} value={filter}
      onValueChange={value => { setFilter(value); setActive(value.trim() ? 1 : 0); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault(); setActive(Math.max(0, Math.min(names.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
        } else if (e.key === "Enter") { e.preventDefault(); choose(index); }
      }} />
    <div id={id} role="listbox" aria-label="Branches" aria-busy={loading || phase === "pending"}>
      {status && <div role="group" aria-label="Current"><div className="environment-menu-note">Current</div>{option(names[0]!, 0)}</div>}
      {!loading && !error && branches !== null && <div role="group" aria-label="Matching">
        <div className="environment-menu-note">Matching · {matching.length}</div>
        <div ref={list} className="environment-branches">{matching.map((b, i) => option(b.name, i + 1))}{offerCreate && option(createName, matching.length + 1, true)}</div>
      </div>}
    </div>
    {loading || (!error && branches === null) ? <div role="status" className="environment-menu-note">Loading branches…</div>
      : error ? <div role="alert" className="environment-menu-note">Couldn't list branches: {error} <Button variant="ghost" size="sm" disabled={locked} onClick={retry}>Retry</Button></div>
      : !matching.length && <div className="environment-menu-note">{query ? "No branches match" : "No other branches"}</div>}
    <div id={`${id}-hint`} className="environment-menu-note">↑↓ · Enter · Esc</div>
  </section>;
}
