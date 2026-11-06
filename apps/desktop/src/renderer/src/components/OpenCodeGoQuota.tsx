import type { ProviderConnection } from "../../../shared/settings.js";
import { isOpenCodeGoConnection } from "../../../shared/opencode-go-quota.js";
import { formatAge } from "./Sidebar.js";

export function goQuotaRows(connection: ProviderConnection | undefined, now: number) {
  if (!connection || !isOpenCodeGoConnection(connection) || !connection.lastGoQuota) return [];
  const { observedAt, windows } = connection.lastGoQuota;
  const age = now - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < 0 || age >= 300_000) return [];
  return ([ ["rolling", "5h"], ["weekly", "Weekly"], ["monthly", "Monthly"] ] as const).flatMap(([key, label]) => {
    const window = windows[key];
    if (!window || (window.resetsAt !== undefined && window.resetsAt * 1000 <= now)) return [];
    return [{ label, ...window }];
  });
}

export function OpenCodeGoQuota({ connection, now }: { connection: ProviderConnection | undefined; now: number }) {
  const rows = goQuotaRows(connection, now);
  if (!rows.length || !connection?.lastGoQuota) return null;
  return <div className="go-quota">
    <div className="go-quota-title">Subscription usage · observed {formatAge(Date.parse(connection.lastGoQuota.observedAt), now)}</div>
    {rows.map(row => <div className="go-quota-row" key={row.label} title={row.resetsAt === undefined ? undefined : `Resets ${new Date(row.resetsAt * 1000).toLocaleString()}`}>
      <span>{row.label} · {row.usedPercent}% used{row.resetsAt === undefined ? "" : ` · resets in ${formatAge(row.resetsAt * 1000, now)}`}</span>
      {row.usedPercent >= 80 && <span className={row.usedPercent >= 95 ? "go-quota-danger" : "go-quota-warning"}>{row.usedPercent >= 95 ? "Nearly exhausted" : "High usage"}</span>}
    </div>)}
  </div>;
}
