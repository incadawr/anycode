/**
 * "Context window limit" (Settings → Claude): the `settings.claude.
 * contextWindowTokens` field. It caps the context meter and Claude Code's own
 * auto-compact threshold for every NEW Claude session — the CLI clamps the
 * value to the running model's window, so a limit above a smaller model's
 * window is a harmless no-op for that model. Blank = the CLI's own default.
 * Written through the generic `settings-set` patch; clearing sends the `""`
 * sentinel the settings-set gate defines (deepMerge cannot delete a key).
 */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { AnycodeSettings, SettingsPatch } from "../../../shared/settings.js";
import { CLAUDE_CONTEXT_WINDOW_MAX, CLAUDE_CONTEXT_WINDOW_MIN } from "../../../shared/engines.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";

export const CLAUDE_CONTEXT_WINDOW_LABEL = "Context window limit (tokens)";
export const CLAUDE_CONTEXT_WINDOW_HINT =
  `Caps the context meter and Claude's own auto-compact threshold for new Claude sessions (whole number, ${CLAUDE_CONTEXT_WINDOW_MIN}–${CLAUDE_CONTEXT_WINDOW_MAX}). ` +
  "Applies to the next session; blank uses Claude Code's own default.";

/**
 * The patch a save sends. The empty string is the settings-set gate's clear
 * sentinel for this field — the wire type widens the persisted `number` the
 * same way the connection channel's `contextWindowTokens` does; main strips
 * it and deletes the persisted key. Cast is localized to this one helper.
 */
export function claudeContextWindowPatch(value: number | ""): SettingsPatch {
  const contextWindowTokens = value === "" ? ("" as unknown as number) : value;
  return { claude: { contextWindowTokens } };
}

/** The persisted limit, or `undefined` for "not configured" (blank input). */
export function claudeContextWindowOf(settings: Pick<AnycodeSettings, "claude"> | undefined): number | undefined {
  return settings?.claude?.contextWindowTokens;
}

/**
 * Strict parse of the input text: blank → `""` (clear), otherwise a whole
 * number inside the CLI's accepted range or a field-naming error — the
 * `buildSessionLimitsPatch` discipline. The error names the bounds so a
 * refused save never leaves the user guessing.
 */
export function parseClaudeContextWindowInput(text: string): { value: number | "" } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: "" };
  if (!/^-?\d+$/.test(trimmed)) return { error: "Enter a whole number of tokens, or leave blank." };
  const value = Number(trimmed);
  if (value < CLAUDE_CONTEXT_WINDOW_MIN || value > CLAUDE_CONTEXT_WINDOW_MAX) {
    return { error: `Must be between ${CLAUDE_CONTEXT_WINDOW_MIN} and ${CLAUDE_CONTEXT_WINDOW_MAX} (Claude Code ignores values outside that range).` };
  }
  return { value };
}

export function ClaudeContextWindowSection({ store = useSettingsStore }: { store?: SettingsStoreApi }) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const persisted = claudeContextWindowOf(snapshot?.settings);
  const [text, setText] = useState(persisted === undefined ? "" : String(persisted));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-populate from the snapshot that comes back after every save — same
  // resolved-value discipline as the Tools pane fields.
  useEffect(() => {
    setText(persisted === undefined ? "" : String(persisted));
  }, [persisted]);

  if (!snapshot) {
    return null;
  }
  const readOnly = snapshot.readOnly;

  async function save(): Promise<void> {
    const parsed = parseClaudeContextWindowInput(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    // A blank field with nothing persisted is a no-op: `""` is the CLEAR
    // sentinel, not the persisted value, so it compares as `undefined` —
    // otherwise every untouched blur would send a needless settings write.
    if ((parsed.value === "" ? undefined : parsed.value) === persisted) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await store.getState().setPatch(claudeContextWindowPatch(parsed.value));
      if (!result.ok) setError("The context window limit could not be saved.");
    } catch {
      setError("The context window limit could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-section claude-context-window-section">
      <div className="settings-section-title">Context window limit</div>
      <label className="settings-field">
        <span className="settings-field-label">{CLAUDE_CONTEXT_WINDOW_LABEL}</span>
        <input
          className="settings-field-input"
          type="text"
          inputMode="numeric"
          value={text}
          disabled={readOnly || saving}
          placeholder="(Claude default)"
          aria-label={CLAUDE_CONTEXT_WINDOW_LABEL}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onBlur={() => void save()}
        />
      </label>
      <p className="settings-page-description">{CLAUDE_CONTEXT_WINDOW_HINT}</p>
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}
