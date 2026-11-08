import { useEffect, useState } from "react";
import { startAccountSourcesStore, useAccountSourcesStore } from "../account-sources-store.js";
import { useSettingsStore } from "../settings-store.js";
import { accountSourceTransportCompatible, type AccountSourceCandidateView, type AccountSourcePreviewFailure, type AccountSourcePreviewResult } from "../../../shared/account-sources.js";
import type { AnycodeSettings } from "../../../shared/settings.js";
import { Button, Select } from "../ui/index.js";
import { accountModelPrice } from "./account-source-pricing.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";

function money(value: string): string {
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${amount / 1_000_000n}.${fraction}`;
}
function sameUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return false; } }
export function eligibleAccountConnections(settings: AnycodeSettings, candidate: AccountSourceCandidateView) {
  const connections = settings.provider.connections;
  return connections.filter((c) => {
    const record = settings.provider.custom?.find((p) => p.id === c.providerId);
    return record && record.kind === candidate.gatewayKind && sameUrl(record.baseUrl, candidate.gatewayBaseUrl)
      && (!c.baseUrl || sameUrl(c.baseUrl, candidate.gatewayBaseUrl))
      && accountSourceTransportCompatible(record.kind, c.transport)
      && connections.filter((other) => other.providerId === record.id).length === 1
      && !(settings.plugins?.accountSources ?? []).some((b) => b.connectionId === c.id && (b.plugin !== candidate.key.plugin || b.source !== candidate.key.source));
  });
}
export function previewFailureText(reason: AccountSourcePreviewFailure): string {
  const messages: Record<AccountSourcePreviewFailure, string> = {
    not_found: "This source is no longer available.", connection_invalid: "The connection is unsuitable or has no API key.", stale: "The source or connection changed. Preview again.", invalid: "The source returned an invalid catalog.", auth_required: "Authentication failed. Check the connection's API key.", access_denied: "Access to this source was denied.", timeout: "The preview timed out or was cancelled.", unavailable: "The source is unavailable. Try again later.", expired: "Preview expired or connection changed."
  };
  return messages[reason];
}
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
  const eligible = candidate && settings ? eligibleAccountConnections(settings, candidate) : [];
  async function showPreview() {
    if (!candidate || !connectionId) return;
    setBusy(true); try { setPreview(await window.anycode.accountSources.preview(candidate.key, connectionId)); } finally { setBusy(false); }
  }
  async function approve() {
    if (!preview?.ok) return;
    setBusy(true);
    try { if (await window.anycode.accountSources.bind(preview.token)) { setCandidate(null); setPreview(null); await load(); await reloadSettings(); } else setPreview({ ok: false, reason: "expired" }); } finally { setBusy(false); }
  }
  return <div className={`account-budget ${collapsed ? "account-budget-collapsed" : ""}`}>
    <Button type="button" className="account-budget-toggle" aria-label="Employee budget" aria-expanded={open} onClick={() => setOpen(!open)}>{collapsed ? "$" : "Employee budget"}</Button>
    {(!collapsed || open) && <div className="account-budget-content">
      {snapshot.sources.map((source) => <div key={`${source.key.plugin}/${source.key.source}`} className="account-budget-source">
        <strong>{source.displayName}</strong>
        {source.budget?.windows.map((w) => <div key={w.kind}>{w.kind === "day" ? "Today" : "Month"}: {money(w.spent)} / {money(w.limit)}{open && <small> Remaining {money(w.remaining)}{w.reserved !== undefined ? ` · Reserved ${money(w.reserved)}` : ""} · Resets {new Date(w.resetsAt).toLocaleString()}</small>}</div>)}
        {source.status === "ready" && source.budget?.windows.some((w) => BigInt(w.remaining) === 0n) && <small>Budget exhausted. Free models remain available; metered models may be unavailable.</small>}
        {source.status !== "ready" && <span>{source.status === "needs_connection" ? "Choose or create a dedicated connection" : source.status === "needs_approval" ? "Review the updated source" : source.status.replaceAll("_", " ")}</span>}
        {open && (() => { const binding = settings?.plugins?.accountSources?.find((b) => b.plugin === source.key.plugin && b.source === source.key.source); const catalog = snapshot.catalogs?.find((c) => c.connectionId === binding?.connectionId); return catalog && <ul>{catalog.models.map((m) => <li key={m.id}>{m.displayName || m.id} · {accountModelPrice(m)}</li>)}</ul>; })()}
        {open && <><small>Employee spending, independent of this chat.{source.budget ? ` Observed ${new Date(source.budget.observedAt).toLocaleString()}` : ""}</small><Button type="button" onClick={() => void window.anycode.accountSources.refresh(source.key)}>Refresh</Button><Button type="button" onClick={() => void window.anycode.accountSources.reset(source.key)}>Restore source settings</Button><Button type="button" onClick={() => void window.anycode.accountSources.unbind(source.key)}>Disconnect</Button></>}
      </div>)}
      {open && <><Button type="button" onClick={onSettings}>Connections</Button>{candidates.map((item) => <Button type="button" key={`${item.key.plugin}/${item.key.source}`} onClick={() => { setCandidate(item); setConnectionId(""); setPreview(null); }}>Set up {item.displayName}</Button>)}</>}
      {open && candidate && <div className="account-budget-setup"><strong>{candidate.displayName}</strong><small>Gateway: {candidate.gatewayBaseUrl}<br />Account API: {candidate.apiBaseUrl}</small><Select label="Connection" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} options={[{ value: "", label: "Choose a connection" }, ...eligible.map((c) => ({ value: c.id, label: c.label || c.providerId }))]} /><Button type="button" onClick={() => setCreating(true)}>Create dedicated connection</Button><Button type="button" disabled={!connectionId || busy} onClick={() => void showPreview()}>Preview catalog</Button>
        {preview?.ok && <><p>Allow this source to read the account budget and synchronize these models:</p><ul>{preview.models.map((m) => <li key={m.id}>{m.displayName || m.id} · {accountModelPrice(m)}</li>)}</ul><Button type="button" disabled={busy} onClick={() => void approve()}>Allow and connect</Button></>}
        {preview && !preview.ok && <p role="alert">{previewFailureText(preview.reason)}</p>}
      </div>}
    </div>}
    {candidate && settingsSnapshot && <ConnectionDrawer open={creating} mode="add" catalog={settingsSnapshot.catalog ?? []} connections={connections} secrets={settingsSnapshot.secrets} readOnly={settingsSnapshot.readOnly} initialCustom={{ name: candidate.gatewayName, baseUrl: candidate.gatewayBaseUrl, kind: candidate.gatewayKind }} onClose={() => { setCreating(false); void reloadSettings(); }} />}
  </div>;
}
