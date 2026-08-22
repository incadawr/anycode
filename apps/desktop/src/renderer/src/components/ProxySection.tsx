/**
 * The ONE proxy-profile editor plaque (TASK.141 §3, owner's explicit
 * requirement: "редактор-плашка существует ровно в одном месте"). Every knob a
 * proxy has — mode, host/port/scheme, exemptions, credentials, Check — is
 * declared here exactly once and rendered by whoever needs it:
 * `ProxyProfilesPane` (the Network settings pane) and `ProxyRefPicker`'s
 * "Create profile…" action. A scope never grows its own copy of any of this;
 * a scope carries a `proxyRef` string and nothing else.
 *
 * WHY THE LOGIC IS ALL EXPORTED PURE FUNCTIONS: this package's vitest runs in
 * `environment: "node"` with no jsdom and no testing-library, and its tests are
 * `*.test.ts` only — a `.test.tsx` is not collected at all. So every rule that
 * could be wrong (draft↔wire conversion, host/port composition and its inverse,
 * the password action, verdict text) lives in a function the test calls
 * directly, and the JSX below is reduced to wiring. The rendered behaviour is
 * proven live instead, the same standard TASK.132/139 held.
 *
 * CUSTODY: the password is write-only in both directions. Main never returns
 * it — the editor learns only `passwordSet: boolean`, derived from the
 * snapshot's `SecretStatus` list — the draft never seeds the field from
 * anything, and no verdict/error string this file builds can carry it (every
 * URL that reaches text goes through `maskProxyUrl`). The one honesty this
 * slice does NOT buy is the in-env half: the composed `user:pass@` URL still
 * rides `HTTPS_PROXY` into every child (TASK.135's perimeter, owner pending) —
 * the hint says so rather than implying the password is now contained.
 */
import { useState } from "react";
import type { ProviderConnection, SecretStatus } from "../../../shared/settings.js";
import type { ProxyCheckVerdict, ProxyProfile, ProxyProfileUpsertRequest } from "../../../shared/proxy.js";
import { isProxyProfileUrl, maskProxyUrl, proxyProfileSecretKey } from "../../../shared/proxy.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";

// ── frozen seams (design review B-11 / H-01) ───────────────────────────────
//
// These three aliases mirror contracts the review reshaped in `shared/proxy.ts`
// while this lane was being built in parallel. Each is written so that it is
// IDENTICAL to the shared type once lane A has landed the reshaped version —
// the verdict alias is a union WITH the shared one (union absorbs duplicates),
// the payload alias is an INTERSECTION with it (intersection absorbs an
// identical member) — so nothing here has to be revisited when it lands, and
// this lane compiles either way. Same "structural mirror" convention the
// renderer's `anycode-window.d.ts` already uses for shapes it cannot import.

/**
 * B-11: `Check` gained honest verdicts for the cases where the request never
 * touched the proxy at all. Without them a probe that skipped the proxy (a
 * `noProxy` match, a `system` profile Chromium resolved to DIRECT) would come
 * back `ok` and be read as "the proxy works".
 */
export type ProxyVerdict = ProxyCheckVerdict | "direct" | "bypassed_by_no_proxy" | "socks_unsupported";

/**
 * H-01: the password is part of the SAME atomic profile mutation rather than a
 * second `secret-set` round-trip. Two IPCs would leave an observable window in
 * which the URL/login had moved and the password had not — i.e. a materialised
 * proxy nobody ever configured — and would split the `lastHealth` invalidation
 * across two handlers.
 */
export type ProxyPasswordAction = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };

/** `proxy-profile-upsert` payload, password action included (H-01). */
export type ProxyProfileUpsertPayload = ProxyProfileUpsertRequest & { password?: ProxyPasswordAction };

/** B-11: the probe checks ONE target the CALLER names, and says which one it used. */
export type ProxyCheckTarget = { kind: "connection"; connectionId: string } | { kind: "url"; url: string };

/** What the renderer displays out of a `proxy-check` reply (B-11's result shape). */
export interface ProxyCheckOutcome {
  verdict: ProxyVerdict;
  /** The target actually probed, for display. Masked before it reaches text. */
  targetUrl?: string;
  /** Whether the request really went through the proxy (B-11's anti-false-green field). */
  proxyUsed?: boolean;
  /** True when the boot env owns the proxy family, so real traffic ignores every profile. */
  shellOverride?: boolean;
  detail?: string;
}

// ── draft ──────────────────────────────────────────────────────────────────

/**
 * The editor's local shape. Deliberately NOT `ProxyProfile`: the persisted form
 * stores one `url` string, while the editor shows the three controls JetBrains'
 * dialog shows (host, port, "HTTPS proxy") — that decomposition is the whole
 * reason the scheme-less-`host:port` typo class (TASK.132's `proxyUrlSaveBlocked`)
 * cannot exist here: the user never types a scheme, the checkbox picks it.
 */
export interface ProxyProfileDraft {
  /** Absent while creating — main mints `proxy-<uuid>` and returns it. */
  id?: string;
  name: string;
  mode: "system" | "manual";
  host: string;
  port: string;
  /** The `https://` half of the scheme checkbox — see `proxyComposeUrl`. */
  https: boolean;
  noProxy: string;
  login: string;
  /** A NEWLY TYPED password. Never seeded from main (main does not return one). */
  password: string;
  /** True once "Clear" was pressed and nothing has been typed since. */
  passwordCleared: boolean;
  /** Whether a password is already stored for this profile. A boolean — never the value. */
  passwordSet: boolean;
}

/** `••• (saved)` — the placeholder that says "a password exists" without echoing one. */
export const PROXY_PASSWORD_PLACEHOLDER = "••• (saved)";

/**
 * The exemption-syntax example. Honest `NO_PROXY` syntax (host suffixes), NOT
 * JetBrains' globs: `192.168.*` matches nothing in undici or curl, so showing
 * their example would teach a syntax that silently sends the traffic it claims
 * to exempt straight through the proxy.
 */
export const PROXY_NO_PROXY_PLACEHOLDER = "internal.corp, .example.com";

/** True when this profile already has a password in the vault (status list only — never a value). */
export function proxyPasswordSet(secrets: readonly SecretStatus[], profileId: string | undefined): boolean {
  if (profileId === undefined) {
    return false;
  }
  const key = proxyProfileSecretKey(profileId);
  return secrets.some((status) => status.key === key && status.set);
}

/**
 * Splits a stored proxy URL back into the editor's three controls plus any
 * userinfo login. Total: anything unparseable decomposes to blanks rather than
 * throwing, so a hand-edited settings.json opens the editor instead of a blank
 * screen. `login` is only ever non-empty for a LEGACY string being imported —
 * a profile URL is refused with userinfo at the main boundary.
 */
export function proxyDecomposeUrl(value: string): { host: string; port: string; https: boolean; login: string } {
  const blank = { host: "", port: "", https: false, login: "" };
  const trimmed = value.trim();
  if (trimmed === "") {
    return blank;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return blank;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return blank;
  }
  return {
    host: url.hostname,
    port: url.port,
    https: url.protocol === "https:",
    login: safeDecode(url.username),
  };
}

/** `decodeURIComponent` throws on a lone `%`; a malformed login is shown verbatim rather than crashing the editor. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Composes the three controls into the one URL that gets persisted. The scheme
 * comes from the checkbox and ONLY from the checkbox — that is what makes the
 * "pasted `proxy.host:3128` without a scheme" mistake unrepresentable here.
 * A blank host yields `""` (nothing to save yet), never a bare `http://`.
 */
export function proxyComposeUrl(host: string, port: string, https: boolean): string {
  const cleanHost = host.trim();
  if (cleanHost === "") {
    return "";
  }
  const cleanPort = port.trim();
  const scheme = https ? "https" : "http";
  return cleanPort === "" ? `${scheme}://${cleanHost}` : `${scheme}://${cleanHost}:${cleanPort}`;
}

/** The one message shown for a host/port pair main's profile validation would refuse. */
export const PROXY_HOST_ERROR =
  "Enter the proxy host name on its own — no scheme, no port, and no credentials. The port has its own field, the HTTPS checkbox picks the scheme, and the login/password go in the fields below.";

/**
 * True for a host field that is not a bare host name. The composed-URL check
 * alone is NOT enough to catch this: `new URL("http://http://proxy.corp:3128")`
 * parses happily, as host `http` with the rest as a path, so a pasted
 * `http://proxy.corp` would sail through `isProxyProfileUrl` and persist a
 * profile pointing at a host called "http". Rejecting the separators outright
 * is what makes the paste diagnosable instead of silently wrong.
 *
 * A bracketed IPv6 literal (`[::1]`) is the one legal use of `:` here and is
 * allowed explicitly.
 */
export function proxyHostBlocked(host: string): boolean {
  const value = host.trim();
  if (value === "") {
    return true;
  }
  if (/^\[[0-9a-fA-F:.]+\]$/.test(value)) {
    return false;
  }
  return /[:/\\@?#\s]/.test(value);
}

/** True for a port field that is neither blank (the scheme's default) nor a number in 1…65535. */
export function proxyPortBlocked(port: string): boolean {
  const value = port.trim();
  if (value === "") {
    return false;
  }
  if (!/^\d{1,5}$/.test(value)) {
    return true;
  }
  const parsed = Number(value);
  return parsed < 1 || parsed > 65535;
}

/**
 * Pre-flight for the manual mode's address (B-06: main validates the same rule,
 * `manual` REQUIRES a URL and REFUSES userinfo in it). `system` never has an
 * address, so it is never blocked. Blocking here rather than letting main's
 * generic "Invalid value" come back is the same reasoning TASK.132's
 * `proxyUrlSaveBlocked` had: the refusal is otherwise undiagnosable.
 */
export function proxyHostPortBlocked(draft: ProxyProfileDraft): boolean {
  if (draft.mode !== "manual") {
    return false;
  }
  if (proxyHostBlocked(draft.host) || proxyPortBlocked(draft.port)) {
    return true;
  }
  const url = proxyComposeUrl(draft.host, draft.port, draft.https);
  return url === "" || !isProxyProfileUrl(url);
}

/**
 * Pre-flight for the name: non-empty, and case-insensitively unique across the
 * registry (main enforces the same rule and answers `invalid`). The profile
 * being EDITED is excluded from the comparison by id, so re-saving a profile
 * without renaming it is never a collision with itself.
 * Returns the message to show, or undefined when the name is fine.
 */
export function proxyProfileNameBlocked(
  name: string,
  profiles: readonly ProxyProfile[],
  id: string | undefined,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") {
    return "Give the profile a name — every scope picks it from a list by that name.";
  }
  const clash = profiles.some(
    (profile) => profile.id !== id && profile.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? `A profile named “${trimmed}” already exists — pick another name.` : undefined;
}

/**
 * A fresh draft for `profile` (or a blank one for "create"). `passwordSet` is
 * the ONLY thing the password half of the draft ever learns from main; the
 * `password` field always starts empty, because a stored value has no path back
 * to the renderer by construction.
 */
export function proxyProfileDraftFrom(
  profile: ProxyProfile | undefined,
  passwordSet: boolean,
): ProxyProfileDraft {
  const parts = proxyDecomposeUrl(profile?.url ?? "");
  return {
    ...(profile === undefined ? {} : { id: profile.id }),
    name: profile?.name ?? "",
    mode: profile?.mode ?? "manual",
    host: parts.host,
    port: parts.port,
    https: parts.https,
    noProxy: profile?.noProxy ?? "",
    login: profile?.login ?? "",
    password: "",
    passwordCleared: false,
    passwordSet,
  };
}

/**
 * The password half of the upsert (H-01). Precedence is `set` > `clear` >
 * `keep`: a typed value always wins, because the Clear button blanks the field
 * and typing into the field un-presses Clear — so "typed AND cleared" can only
 * arrive from a caller that built the draft by hand, and answering "set" for it
 * is the only reading that cannot silently discard something the user entered.
 *
 * A password is NOT trimmed. Leading/trailing whitespace is legal in a proxy
 * password, and trimming it would authenticate against a different string than
 * the one on screen.
 */
export function proxyPasswordActionFor(draft: ProxyProfileDraft): ProxyPasswordAction {
  if (draft.password !== "") {
    return { action: "set", value: draft.password };
  }
  return draft.passwordCleared ? { action: "clear" } : { action: "keep" };
}

/**
 * Draft → `proxy-profile-upsert` payload. Only-truthy-on-disk: every optional
 * field is OMITTED when blank rather than sent as `""`, so a profile with no
 * exemptions and no login carries neither key. `url` is sent for `manual` only
 * — a `system` profile that carried a stale URL would read as "a real path"
 * to anyone inspecting settings.json while materialising as something else.
 */
export function proxyProfileDraftToUpsert(draft: ProxyProfileDraft): ProxyProfileUpsertPayload {
  const url = draft.mode === "manual" ? proxyComposeUrl(draft.host, draft.port, draft.https) : "";
  const noProxy = draft.noProxy.trim();
  const login = draft.login.trim();
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    mode: draft.mode,
    ...(url === "" ? {} : { url }),
    ...(noProxy === "" ? {} : { noProxy }),
    ...(login === "" ? {} : { login }),
    password: proxyPasswordActionFor(draft),
  };
}

// ── Check ──────────────────────────────────────────────────────────────────

/**
 * The `proxy-check` payload (B-11: the probe checks ONE target the caller
 * names). `""` means "let main pick its default target" (the active
 * connection, else Anthropic) and OMITS the key — sending
 * `target: undefined` explicitly would be a different thing to validate on the
 * far side for no gain.
 */
export function proxyCheckPayload(
  profileId: string,
  targetConnectionId: string,
): { profileId: string; target?: ProxyCheckTarget } {
  const connectionId = targetConnectionId.trim();
  return connectionId === "" ? { profileId } : { profileId, target: { kind: "connection", connectionId } };
}

/** The label a connection gets in the Check target picker. */
export function proxyCheckTargetLabel(connection: ProviderConnection): string {
  return connection.label?.trim() ? connection.label.trim() : connection.providerId;
}

/** One sentence per verdict class. `ok` is the ONLY one that means "reached the target THROUGH the proxy". */
const PROXY_VERDICT_TEXT: Record<ProxyVerdict, string> = {
  ok: "The target answered through the proxy.",
  direct: "No proxy was used — the request went straight to the target.",
  bypassed_by_no_proxy: "The target matched “No proxy for”, so the request skipped the proxy.",
  socks_unsupported: "The system proxy is a SOCKS proxy — unsupported, so traffic goes direct.",
  proxy_unreachable: "The proxy did not answer.",
  proxy_auth: "The proxy rejected the credentials (407).",
  tls: "TLS failed through the proxy — it may be intercepting with its own certificate.",
  target_unreachable: "The proxy answered, but the target did not.",
};

/**
 * The named caveat of §6: a shell-exported proxy owns the whole family
 * atomically (TASK.132's law), so a profile can probe green while every real
 * child still leaves through the shell's proxy. The verdict has to say so —
 * without this line a green Check is an actively misleading measurement.
 */
export const PROXY_SHELL_OVERRIDE_NOTE =
  "A shell-exported proxy overrides every profile — this probe used the profile, your real traffic will not.";

/** `http(s)://userinfo@` anywhere inside a longer string — see `maskProxyText`. */
const EMBEDDED_USERINFO_RE = /(https?:\/\/)([^\s/@]*)@/gi;

/**
 * Masks every `user:pass@` that appears ANYWHERE in a free-text string.
 *
 * `maskProxyUrl` (shared/proxy.ts) only masks a string that IS a URL — hand it
 * a sentence with a URL inside ("http://bob:hunter2@proxy:3128 answered 407")
 * and `new URL` throws, so it returns the input untouched, password and all.
 * A `detail` from main is exactly that shape, so the renderer needs its own net
 * rather than trusting the far side to have masked already: main masking is the
 * contract, this is the guarantee.
 */
export function maskProxyText(text: string): string {
  return text.replace(EMBEDDED_USERINFO_RE, (_match, scheme: string, userinfo: string) => {
    const user = userinfo.split(":")[0] ?? "";
    return `${scheme}${user === "" ? "" : `${user}:`}***@`;
  });
}

/**
 * Display text for a Check result. Every URL in it is masked
 * (`user:***@host:port`) — a verdict string is renderer-visible text, and the
 * password is the one thing that must never come back out of main, whether
 * main put it there deliberately or a legacy `user:pass@` string carried it in
 * (design review H-02). The mask is applied to the ASSEMBLED string, so it is
 * one choke point rather than a rule each branch below has to remember.
 */
export function proxyCheckVerdictText(outcome: ProxyCheckOutcome): string {
  const parts = [PROXY_VERDICT_TEXT[outcome.verdict] ?? "The check finished with an unknown result."];
  if (outcome.targetUrl !== undefined && outcome.targetUrl !== "") {
    parts.push(`Target: ${maskProxyUrl(outcome.targetUrl)}.`);
  }
  if (outcome.proxyUsed === false && outcome.verdict === "ok") {
    // Defensive: `ok` is defined as "through the proxy", so a reply that says
    // otherwise is main contradicting itself — surface it rather than let the
    // reassuring sentence stand alone.
    parts.push("The proxy was not used for this request.");
  }
  if (outcome.detail !== undefined && outcome.detail !== "") {
    parts.push(outcome.detail);
  }
  if (outcome.shellOverride === true) {
    parts.push(PROXY_SHELL_OVERRIDE_NOTE);
  }
  return maskProxyText(parts.join(" "));
}

// ── component ──────────────────────────────────────────────────────────────

export interface ProxySectionProps {
  /** The profile being edited; absent = create a new one. */
  profile?: ProxyProfile;
  /** The whole registry — for the case-insensitive name-uniqueness pre-flight. */
  profiles: readonly ProxyProfile[];
  /** Vault status list; the editor reads only `set` for its own key. */
  secrets: readonly SecretStatus[];
  /** Connections offered as Check targets. */
  connections: readonly ProviderConnection[];
  readOnly: boolean;
  /** Called with the profile id main confirmed (the minted one, when creating). */
  onSaved: (profileId: string) => void;
  onCancel: () => void;
  store?: SettingsStoreApi;
}

/**
 * The editor plaque. Hosts must give it a `key` that changes with the edited
 * profile id (`ProxyProfilesPane` does) — the draft is seeded once, in a
 * `useState` initialiser, so a remount is what re-seeds it. That is deliberate:
 * an effect that resynced the draft from the snapshot would wipe in-progress
 * typing every time an unrelated settings mutation refreshed it.
 */
export function ProxySection({
  profile,
  profiles,
  secrets,
  connections,
  readOnly,
  onSaved,
  onCancel,
  store = useSettingsStore,
}: ProxySectionProps) {
  const [draft, setDraft] = useState<ProxyProfileDraft>(() =>
    proxyProfileDraftFrom(profile, proxyPasswordSet(secrets, profile?.id)),
  );
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkTarget, setCheckTarget] = useState("");
  const [outcome, setOutcome] = useState<ProxyCheckOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patch(next: Partial<ProxyProfileDraft>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function handleSave(): Promise<void> {
    const nameProblem = proxyProfileNameBlocked(draft.name, profiles, draft.id);
    if (nameProblem !== undefined) {
      setError(nameProblem);
      return;
    }
    if (proxyHostPortBlocked(draft)) {
      setError(PROXY_HOST_ERROR);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.anycode.settings.proxyProfileUpsert(proxyProfileDraftToUpsert(draft));
      if (!result.ok) {
        setError(describeMutationFailure(result.reason));
        return;
      }
      await store.getState().load();
      // The minted id on create; the edited id otherwise. `draft.id` cannot be
      // undefined on the edit path, so the `??` is a total-function guard, not
      // a real branch.
      onSaved(result.createdProxyProfileId ?? draft.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the proxy profile.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck(): Promise<void> {
    if (draft.id === undefined) {
      return;
    }
    setChecking(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await window.anycode.settings.proxyCheck(proxyCheckPayload(draft.id, checkTarget));
      if (!result.ok) {
        setError(
          result.reason === "not_found"
            ? "That profile no longer exists — reopen Settings and try again."
            : "The check couldn't run — save the profile first.",
        );
        return;
      }
      setOutcome({
        verdict: result.verdict,
        targetUrl: result.targetUrl,
        proxyUsed: result.proxyUsed,
        shellOverride: result.shellOverride,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The proxy check failed to run.");
    } finally {
      setChecking(false);
    }
  }

  const manual = draft.mode === "manual";

  return (
    <section className="settings-section">
      <div className="settings-section-title">{profile === undefined ? "New proxy profile" : "Edit proxy profile"}</div>

      <label className="settings-field">
        <span className="settings-field-label">Name</span>
        <input
          className="settings-field-input"
          type="text"
          value={draft.name}
          disabled={readOnly}
          placeholder="e.g. Corporate"
          onChange={(e) => patch({ name: e.target.value })}
        />
        <span className="settings-field-hint">
          Scopes reference this profile by name. Renaming it never moves the password — that is stored under the
          profile's id.
        </span>
      </label>

      {/* "No proxy" is deliberately NOT a mode here: it is a property of a
          SCOPE (the picker's own entry), never of a profile. A profile always
          describes a real network path. */}
      <div className="settings-field">
        <span className="settings-field-label">Mode</span>
        <div className="mcp-radio-row">
          <label>
            <input
              type="radio"
              name={`proxy-mode-${draft.id ?? "new"}`}
              checked={draft.mode === "system"}
              disabled={readOnly}
              onChange={() => patch({ mode: "system" })}
            />
            <span>System proxy</span>
          </label>
          <label>
            <input
              type="radio"
              name={`proxy-mode-${draft.id ?? "new"}`}
              checked={manual}
              disabled={readOnly}
              onChange={() => patch({ mode: "manual" })}
            />
            <span>Manual</span>
          </label>
        </div>
        <span className="settings-field-hint">
          System asks the OS (PAC included) once per spawn and materialises that answer into the child's environment.
          A PAC that hands out different proxies per host cannot be carried this way — the child gets one proxy for
          all of its traffic — and a running child never sees a network change.
        </span>
      </div>

      {manual && (
        <>
          <label className="settings-field">
            <span className="settings-field-label">Host name</span>
            <input
              className="settings-field-input"
              type="text"
              value={draft.host}
              disabled={readOnly}
              placeholder="proxy.example.com"
              onChange={(e) => patch({ host: e.target.value })}
            />
          </label>

          <label className="settings-field">
            <span className="settings-field-label">Port number</span>
            <input
              className="settings-field-input"
              type="text"
              inputMode="numeric"
              value={draft.port}
              disabled={readOnly}
              placeholder="3128"
              onChange={(e) => patch({ port: e.target.value })}
            />
          </label>

          <label className="settings-field-checkbox">
            <input
              type="checkbox"
              checked={draft.https}
              disabled={readOnly}
              onChange={(e) => patch({ https: e.target.checked })}
            />
            <span>HTTPS proxy (the connection to the proxy itself uses TLS)</span>
          </label>
        </>
      )}

      <label className="settings-field">
        <span className="settings-field-label">No proxy for:</span>
        <input
          className="settings-field-input"
          type="text"
          value={draft.noProxy}
          disabled={readOnly}
          placeholder={PROXY_NO_PROXY_PLACEHOLDER}
          onChange={(e) => patch({ noProxy: e.target.value })}
        />
        <span className="settings-field-hint">
          Comma-separated <code>NO_PROXY</code> host suffixes — <code>{PROXY_NO_PROXY_PLACEHOLDER}</code>. Wildcards
          such as <code>192.168.*</code> match nothing and are not a supported syntax. These are ADDED to the built-in
          loopback exemptions, never a replacement for them, so a local model server always stays direct.
        </span>
      </label>

      <div className="settings-section-title">Proxy authentication</div>

      <label className="settings-field">
        <span className="settings-field-label">Login</span>
        <input
          className="settings-field-input"
          type="text"
          value={draft.login}
          disabled={readOnly}
          autoComplete="off"
          onChange={(e) => patch({ login: e.target.value })}
        />
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Password</span>
        <input
          className="settings-field-input"
          type="password"
          value={draft.password}
          disabled={readOnly}
          autoComplete="new-password"
          placeholder={draft.passwordSet && !draft.passwordCleared ? PROXY_PASSWORD_PLACEHOLDER : ""}
          onChange={(e) => patch({ password: e.target.value, passwordCleared: false })}
        />
        <span className="settings-field-hint">
          Stored in the encrypted vault under this profile's id, never in settings.json. It is still composed into the
          proxy URL that every child process receives in its environment, where a shell command can read it — that half
          is not fixed by this screen.
        </span>
      </label>

      {(draft.passwordSet || draft.password !== "") && (
        <div className="settings-field-row">
          <button
            type="button"
            className="settings-button"
            disabled={readOnly || saving}
            onClick={() => patch({ password: "", passwordCleared: true })}
          >
            Clear password
          </button>
          {draft.passwordCleared && <span className="settings-field-hint">Cleared on save.</span>}
        </div>
      )}

      <div className="settings-section-title">Check</div>

      <label className="settings-field">
        <span className="settings-field-label">Target</span>
        <select
          className="settings-field-select"
          value={checkTarget}
          disabled={readOnly}
          onChange={(e) => setCheckTarget(e.target.value)}
        >
          <option value="">(active connection)</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {proxyCheckTargetLabel(connection)}
            </option>
          ))}
        </select>
        <span className="settings-field-hint">
          Spawns a child with this profile's environment and makes one request, with no retries. It is not a replay of
          a real agent spawn — those end in the Codex/Claude CLI, with their own certificate handling — but it uses the
          same materialisation and reports whether the proxy was actually used.
        </span>
      </label>

      <div className="settings-field-row">
        <button
          type="button"
          className="settings-button"
          disabled={readOnly || checking || draft.id === undefined}
          onClick={() => void handleCheck()}
        >
          {checking ? "Checking…" : "Check Connection"}
        </button>
        {draft.id === undefined && <span className="settings-field-hint">Save the profile first.</span>}
      </div>

      {outcome !== null && <p className="settings-notice">{proxyCheckVerdictText(outcome)}</p>}

      {error !== null && (
        <p className="settings-notice" role="alert">
          {error}
        </p>
      )}

      <div className="settings-field-row">
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={readOnly || saving}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
        <button type="button" className="settings-button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
