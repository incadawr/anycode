/**
 * The detached Markdown popout's appearance handoff (main -> renderer, via
 * the popout's own query string — no channel on either bridge).
 *
 * The F2 narrowing took away both sources the popout's renderer used to read
 * its appearance from: the narrow bridge (preload/md-preview-bridge.ts) has
 * no settings family, so `useSettingsStore.load()` can never resolve the
 * vault theme, and the dedicated in-memory session partition starts with
 * EMPTY localStorage, so the device-local `readAccent()`/`readDensity()`
 * readers can only yield their defaults. Without a handoff, a light-theme
 * user with a custom accent got a dark popout with default accent/density.
 *
 * Main already owns the popout's document URL (main/index.ts's
 * `loadMdPreviewWindow`, closed over as `MdWindowAdapterDeps.loadRenderer`),
 * so the handoff rides in the SAME query that carries
 * `view`/`tabId`/`previewId`. Main reads the values from the one authority
 * it can see without a new IPC surface: the main window's already-applied
 * `<html>` stamps — `data-theme` is always a RESOLVED concrete value
 * (renderer/src/theme.ts), `data-accent`/`data-density` are the applied
 * device-local choices. The popout's renderer applies them at start
 * (renderer main.tsx + md-view-state.ts's `parseMdWindowAppearanceQuery`)
 * instead of reading its own empty stores.
 *
 * Everything here fails safe to the same triple the popout's own readers
 * would have produced (`dark`/`current`/`comfortable` in DOM terms —
 * index.html's pre-boot theme and the pure readers' fallbacks): a probe that
 * arrives garbled, or from a not-yet-booted main window, can only ever
 * produce an appearance the user could still have chosen by hand.
 */

export type MdWindowTheme = "light" | "dark";

export interface MdWindowAppearance {
  theme: MdWindowTheme;
  accent: string;
  density: string;
}

/** Structural view of a webContents the probe needs — injectable so tests never touch Electron. */
export interface AppearanceSource {
  executeJavaScript(script: string): Promise<unknown>;
}

/**
 * The fallback triple: exactly what the popout's own empty stores would have
 * yielded (index.html's pre-boot `data-theme="dark"`, `parseAccent`'s
 * `"current"`, `parseDensity`'s compact default).
 */
export const DEFAULT_MD_WINDOW_APPEARANCE: MdWindowAppearance = { theme: "dark", accent: "current", density: "compact" };

const THEMES: readonly string[] = ["light", "dark"];
/** Same membership as renderer/src/accent.ts's ACCENTS — kept literal so this module stays free of renderer imports. */
const ACCENTS: readonly string[] = ["current", "blue", "gold", "indigo", "teal", "ember"];

function isMdWindowTheme(value: string): value is MdWindowTheme {
  return THEMES.includes(value);
}

/** The script main evaluates on the main window: the three live `<html>` stamps, nothing else. */
const APPEARANCE_PROBE_SCRIPT =
  "({ theme: document.documentElement.getAttribute('data-theme'), accent: document.documentElement.getAttribute('data-accent'), density: document.documentElement.getAttribute('data-density') })";

/**
 * Reads the main window's applied appearance. A missing main window (null
 * source) or any probe failure resolves to `DEFAULT_MD_WINDOW_APPEARANCE` —
 * the popout still boots, just with the defaults its own empty stores would
 * have produced.
 */
export async function readAppliedAppearance(source: AppearanceSource | null): Promise<MdWindowAppearance> {
  if (source === null) {
    return DEFAULT_MD_WINDOW_APPEARANCE;
  }
  let raw: unknown;
  try {
    raw = await source.executeJavaScript(APPEARANCE_PROBE_SCRIPT);
  } catch {
    return DEFAULT_MD_WINDOW_APPEARANCE;
  }
  return parseAppliedAppearance(raw);
}

/**
 * Validates one probe result field-by-field: an unknown value falls back per
 * field (never poisons the whole triple). Density follows the DOM's own
 * semantics (density.ts): only a literal `"compact"` attribute means compact,
 * anything else — including the attribute being absent — is comfortable.
 */
export function parseAppliedAppearance(raw: unknown): MdWindowAppearance {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_MD_WINDOW_APPEARANCE;
  }
  const record = raw as Record<string, unknown>;
  const theme = record["theme"];
  const accent = record["accent"];
  return {
    theme: typeof theme === "string" && isMdWindowTheme(theme) ? theme : DEFAULT_MD_WINDOW_APPEARANCE.theme,
    accent: typeof accent === "string" && ACCENTS.includes(accent) ? accent : DEFAULT_MD_WINDOW_APPEARANCE.accent,
    density: record["density"] === "compact" ? "compact" : "comfortable",
  };
}

/**
 * The popout document's full load query: the routing triple the window needs
 * to mount `MdPreviewWindowApp`, plus the appearance handoff params. The
 * renderer's `parseMdWindowAppearanceQuery` consumes exactly these keys.
 */
export function mdWindowDocumentQuery(opts: { previewId: string; tabId: string }, appearance: MdWindowAppearance): Record<string, string> {
  return {
    view: "md-preview",
    tabId: opts.tabId,
    previewId: opts.previewId,
    theme: appearance.theme,
    accent: appearance.accent,
    density: appearance.density,
  };
}
