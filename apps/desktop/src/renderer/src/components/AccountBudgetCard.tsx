import { useEffect, useState } from "react";
import { startAccountSourcesStore, useAccountSourcesStore } from "../account-sources-store.js";
import { useSettingsStore } from "../settings-store.js";
import type { AccountSourceCandidateView, AccountSourcePreviewResult } from "../../../shared/account-sources.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";

function money(value: string): string {
  const amount = BigInt(value);
  const cents = (amount + 5000n) / 10000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
function sameUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return false; } }
function rate(value: string): string { const n = BigInt(value); const f = String(n % 1_000_000n).padStart(6, "0").replace(/0+$/, ""); return `$${n / 1_000_000n}${f ? `.${f}` : ""}`; }
export function AccountBudgetCard({ collapsed, onSettings }: { collapsed: boolean; onSettings(): void }) {
  const { snapshot, candidates, load } = useAccountSourcesStore();
  const settingsSnapshot = useSettingsStore((s) => s.snapshot);
  const settings = settingsSnapshot?.settings;
  const reloadSettings = useSettingsStore((s) => s.load);
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState<AccountSourceCandidateView | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [preview, setPreview] = useState<AccountSourcePreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => startAccountSourcesStore(), []);
  if (!candidates.length && !snapshot.sources.length) return null;
  const connections = settings?.provider.connections ?? [];
  const custom = settings?.provider.custom ?? [];
  const eligible = candidate ? connections.filter((c) => {
    const record = custom.find((p) => p.id === c.providerId);
    return record && record.kind === candidate.gatewayKind && sameUrl(record.baseUrl, candidate.gatewayBaseUrl) && (!c.baseUrl || sameUrl(c.baseUrl, candidate.gatewayBaseUrl));
  }) : [];
  async function showPreview() {
    if (!candidate || !connectionId) return;
    setBusy(true); try { setPreview(await window.anycode.accountSources.preview(candidate.key, connectionId)); } finally { setBusy(false); }
  }
  async function approve() {
    if (!preview?.ok) return;
    setBusy(true);
    try { if (await window.anycode.accountSources.bind(preview.token)) { setCandidate(null); setPreview(null); await load(); await reloadSettings(); } else setPreview({ ok: false, reason: "Preview expired or connection changed." }); } finally { setBusy(false); }
  }
  return <div className={`account-budget ${collapsed ? "account-budget-collapsed" : ""}`}>
    <button type="button" className="account-budget-toggle" aria-label="Employee budget" aria-expanded={open} onClick={() => setOpen(!open)}>{collapsed ? "$" : "Employee budget"}</button>
    {(!collapsed || open) && <div className="account-budget-content">
      {snapshot.sources.map((source) => <div key={`${source.key.plugin}/${source.key.source}`} className="account-budget-source">
        <strong>{source.displayName}</strong>
        {source.budget?.windows.map((w) => <div key={w.kind}>{w.kind === "day" ? "Today" : "Month"}: {money(w.spent)} / {money(w.limit)}{open && <small> Remaining {money(w.remaining)}{w.reserved !== undefined ? ` · Reserved ${money(w.reserved)}` : ""} · Resets {new Date(w.resetsAt).toLocaleString()}</small>}</div>)}
        {source.status === "ready" && source.budget?.windows.some((w) => BigInt(w.remaining) === 0n) && <small>Budget exhausted. Free models remain available; metered models may be unavailable.</small>}
        {source.status !== "ready" && <span>{source.status.replaceAll("_", " ")}</span>}
        {open && <><small>Employee spending, independent of this chat.{source.budget ? ` Observed ${new Date(source.budget.observedAt).toLocaleString()}` : ""}</small><button type="button" onClick={() => void window.anycode.accountSources.refresh(source.key)}>Refresh</button><button type="button" onClick={() => void window.anycode.accountSources.unbind(source.key)}>Disconnect</button></>}
      </div>)}
      {open && <><button type="button" onClick={onSettings}>Connections</button>{candidates.map((item) => <button type="button" key={`${item.key.plugin}/${item.key.source}`} onClick={() => { setCandidate(item); setConnectionId(""); setPreview(null); }}>Set up {item.displayName}</button>)}</>}
      {open && candidate && <div className="account-budget-setup"><strong>{candidate.displayName}</strong><small>Gateway: {candidate.gatewayBaseUrl}<br />Account API: {candidate.apiBaseUrl}</small><label>Connection <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}><option value="">Choose a connection</option>{eligible.map((c) => <option key={c.id} value={c.id}>{c.label || c.providerId}</option>)}</select></label><button type="button" onClick={() => setCreating(true)}>Create dedicated connection</button><button type="button" disabled={!connectionId || busy} onClick={() => void showPreview()}>Preview catalog</button>
        {preview?.ok && <><p>Allow this source to read the account budget and synchronize these models:</p><ul>{preview.models.map((m) => <li key={m.id}>{m.displayName || m.id} · {m.billing === "free" ? "Free" : m.ratesMicrosPerMillionTokens ? `${rate(m.ratesMicrosPerMillionTokens.input)} input / ${rate(m.ratesMicrosPerMillionTokens.output)} output per 1M` : "Price unknown"}</li>)}</ul><button type="button" disabled={busy} onClick={() => void approve()}>Allow and connect</button></>}
        {preview && !preview.ok && <p role="alert">{preview.reason}</p>}
      </div>}
    </div>}
    {candidate && settingsSnapshot && <ConnectionDrawer open={creating} mode="add" catalog={settingsSnapshot.catalog ?? []} connections={connections} secrets={settingsSnapshot.secrets} readOnly={settingsSnapshot.readOnly} initialCustom={{ name: candidate.gatewayName, baseUrl: candidate.gatewayBaseUrl, kind: candidate.gatewayKind }} onClose={() => { setCreating(false); void reloadSettings(); }} />}
  </div>;
}
