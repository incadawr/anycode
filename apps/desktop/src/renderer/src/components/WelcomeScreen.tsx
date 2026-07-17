/**
 * Welcome screen (slice 2.2, ruling reviews/slice-2.2-forks-ruling.md §2 —

 * -> quit` boot path): rendered by App.tsx precisely when the app is
 * unconfigured (`!providerReady && tabs.length === 0 && connections.length <= 1`, `shouldShowWelcome`
 * in ../App.tsx). There is nothing else on screen in that state — main
 * opened the window with zero hosts.
 *
 * Deliberately owns no readiness logic itself: App.tsx decides WHETHER to
 * mount this component at all (off the settings-store's `snapshot` +
 * tabs-store's `tabs.length`, per the gating function it exports). Once the
 * provider is ready App.tsx shows the normal shell; the user opens the first
 * session explicitly.
 *
 * R11 restage (slice-R11-cut.md §2.2): full first-run redesign — brand beat
 * (wordmark + mode-ramp motif) + a first-connection form + an honest two-beat
 * progress footer. Auto-advance is still App's declarative unmount above —
 * this component adds no readiness state of its own.
 *
 * TASK.45 W12 (cut §"Отдельный first-run empty state в WelcomeScreen"): this no
 * longer embeds the full `ProviderSettings` grid (management screen) — it
 * embeds `ConnectionDrawerFields` (the SAME add/edit form the Settings grid's
 * drawer uses) directly, chrome-free, narrowed to ONE connection. A fresh
 * install has no connections yet ("add" mode); reopening mid-setup (a
 * connection exists but isn't ready yet — e.g. metadata saved, credential not
 * yet entered) resumes editing that SAME first connection rather than minting
 * a second one on every restart.
 */
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { ConnectionDrawerFields } from "./ConnectionDrawer.js";
import { BrandMark } from "./icons.js";
import "../settings.css";

export interface WelcomeScreenProps {
  /** Injectable for test isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
}

export function WelcomeScreen({ store = useSettingsStore }: WelcomeScreenProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const notice = useStore(store, (s) => s.notice);
  const cardRef = useRef<HTMLDivElement>(null);
  // Beat 2 of the honest two-beat footer: providerReady flips true just before
  // App stops rendering Welcome and shows the normal shell.
  const ready = snapshot?.providerReady === true;

  // R17 a11y: this is the setup screen with nothing else to do — focus the first
  // provider field on mount so a keyboard/SR user lands directly on the one
  // actionable control (an intentional focus-steal, scoped here rather than in
  // the shared ProviderSettings, which the settings dialog also mounts).
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("select, input, textarea")?.focus();
  }, []);

  return (
    <div className="welcome-screen">
      <div className="welcome-screen-card" ref={cardRef}>
        <header className="welcome-brand">
          <BrandMark className="welcome-mark" />
          <h1 className="welcome-wordmark">
            <span className="welcome-wordmark-any">Any</span>Code
          </h1>
          {/* The mode-ramp motif: plan → build → edit → auto → yolo, quoting
              the mode chip's escalation colors. Decorative — aria-hidden. */}
          <div className="welcome-ramp" aria-hidden="true">
            <span className="welcome-ramp-dot welcome-ramp-plan" />
            <span className="welcome-ramp-dot welcome-ramp-build" />
            <span className="welcome-ramp-dot welcome-ramp-edit" />
            <span className="welcome-ramp-dot welcome-ramp-auto" />
            <span className="welcome-ramp-dot welcome-ramp-yolo" />
          </div>
          <p className="welcome-promise">
            A coding agent for any provider — every step legible, every permission yours.
          </p>
        </header>

        {snapshot?.readOnly && (
          <div className="settings-banner-readonly" role="alert">
            Settings file is a newer version than this app understands — changes are disabled
            until you upgrade.
          </div>
        )}

        {snapshot && (
          <ConnectionDrawerFields
            mode={snapshot.settings.provider.connections.length === 0 ? "add" : "edit"}
            editConnection={snapshot.settings.provider.connections[0]}
            catalog={snapshot.catalog ?? []}
            connections={snapshot.settings.provider.connections}
            secrets={snapshot.secrets}
            readOnly={snapshot.readOnly}
            store={store}
          />
        )}

        {notice && (
          <div className="settings-notice" role="alert">
            {notice}
          </div>
        )}

        <footer className="welcome-steps" role="status">
          <span
            className={`welcome-step-dot ${ready ? "welcome-step-dot-done" : "welcome-step-dot-active"}`}
            aria-hidden="true"
          />
          <span className={`welcome-step-dot${ready ? " welcome-step-dot-active" : ""}`} aria-hidden="true" />
          <span className="welcome-steps-caption">
            {ready ? "Provider ready — open a task from the sidebar" : "Connect a provider to begin"}
          </span>
        </footer>
      </div>
    </div>
  );
}
