import { useEffect, useId, useRef, useState } from "react";
import { useTabStore } from "../tab-context.js";
import { Button } from "../ui/components/Button.js";
import { GitBranch } from "./icons.js";
import { gitPillLabel } from "./GitPill.js";

export function EnvironmentBranchPicker({ back, retry, select }: {
  back: () => void; retry: () => void; select: (name: string) => void;
}) {
  const status = useTabStore(s => s.git.status);
  const branches = useTabStore(s => s.git.branches);
  const error = useTabStore(s => s.git.branchesError);
  const loading = useTabStore(s => Object.values(s.git.pending).some(p => p.kind === "branches"));
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const matching = (branches ?? []).filter(b => !b.current && b.name !== status?.head.branch && b.name.toLowerCase().includes(filter.toLowerCase()));
  const names = [status ? gitPillLabel(status) : null, ...(!loading && !error ? matching.map(b => b.name) : [])].filter((n): n is string => n !== null);
  const index = Math.min(active, Math.max(0, names.length - 1));
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [index, filter]);
  function choose(i: number) { if (i > 0 && names[i]) select(names[i]!); }
  function option(name: string, i: number) {
    return <div key={name} id={`${id}-${i}`} role="option" aria-selected={i === 0} data-active={index === i}
      className={`environment-branch-row${i === 0 ? " environment-branch-row-current" : ""}`}
      onMouseMove={() => setActive(i)} onClick={() => choose(i)}>
      <GitBranch /><span title={name}>{name}</span>{i === 0 && <span aria-label="Current branch">✓</span>}
    </div>;
  }
  return <section className="environment-branch-picker" aria-label="Switch branch">
    <div className="environment-menu-actions">
      <Button variant="ghost" size="sm" aria-label="Back" onClick={back}>‹</Button>
      <span>Switch branch</span>
    </div>
    <input className="environment-menu-text-input" aria-label="Filter branches" placeholder="Filter branches"
      role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={id}
      aria-activedescendant={names.length ? `${id}-${index}` : undefined} value={filter}
      onChange={e => { setFilter(e.target.value); setActive(0); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault(); setActive(Math.max(0, Math.min(names.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
        } else if (e.key === "Enter") { e.preventDefault(); choose(index); }
      }} />
    <div id={id} role="listbox" aria-label="Branches" aria-busy={loading}>
      {status && <div role="group" aria-label="Current"><div className="environment-menu-note">Current</div>{option(names[0]!, 0)}</div>}
      {!loading && !error && branches !== null && <div role="group" aria-label="Matching">
        <div className="environment-menu-note">Matching · {matching.length}</div>
        <div ref={list} className="environment-branches">{matching.map((b, i) => option(b.name, i + 1))}</div>
      </div>}
    </div>
    {loading || (!error && branches === null) ? <div role="status" className="environment-menu-note">Loading branches…</div>
      : error ? <div role="alert" className="environment-menu-note">Couldn't list branches: {error} <Button variant="ghost" size="sm" onClick={retry}>Retry</Button></div>
      : !matching.length && <div className="environment-menu-note">No branches match</div>}
  </section>;
}
