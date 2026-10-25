/**
 * "Full browser access for new sessions" (Taskana 4759 owner amendment): the
 * Settings → Permissions switch for `settings.browser.fullAccessDefault`. It only
 * seeds NEW root sessions; a session's own switch lives in its environment menu.
 * Written through the generic `settings-set` patch (the key is not a dedicated channel).
 */
import { useStore } from "zustand";
import type { AnycodeSettings, SettingsPatch } from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";

export const BROWSER_DEFAULT_LABEL = "Full browser access for new sessions";
export const BROWSER_DEFAULT_WARNING =
  "The agent can open any website, click, type (including passwords) and run JavaScript in the preview without asking. Folders you have not trusted stay off.";

/** The patch a switch change sends. Deep-merged, so no sibling key is touched. */
export function browserDefaultPatch(on: boolean): SettingsPatch {
  return { browser: { fullAccessDefault: on ? "on" : "off" } };
}

/** Absent or unknown reads as off (fail closed, the same as the main-side reader). */
export function browserDefaultOn(settings: Pick<AnycodeSettings, "browser"> | undefined): boolean {
  return settings?.browser?.fullAccessDefault === "on";
}

export function BrowserAccessDefaultSection({ store = useSettingsStore }: { store?: SettingsStoreApi }) {
  const snapshot = useStore(store, (state) => state.snapshot);
  if (!snapshot) {
    return null;
  }
  const on = browserDefaultOn(snapshot.settings);
  const readOnly = snapshot.readOnly;

  return (
    <section className="settings-section browser-access-default-section">
      <div className="settings-section-title">Browser</div>
      <div className="settings-field">
        <div className="settings-field-row">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="settings-browser-full-access-caption"
            className={`settings-switch${on ? " settings-switch-on" : ""}`}
            disabled={readOnly}
            onClick={() => {
              void store.getState().setPatch(browserDefaultPatch(!on));
            }}
          >
            <span className="settings-switch-thumb" />
          </button>
          <span id="settings-browser-full-access-caption" className="settings-switch-caption">
            {BROWSER_DEFAULT_LABEL}
          </span>
        </div>
        <p className="settings-page-description">{BROWSER_DEFAULT_WARNING}</p>
      </div>
    </section>
  );
}
