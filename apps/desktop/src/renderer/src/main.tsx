import { applyAccent, readAccent, bindAccentStorageSync } from "./accent.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./agent-messages.css";
import { MdPreviewWindowApp } from "./components/MdPreviewWindowApp.js";
import { applyDensity, readDensity } from "./density.js";
import { parseMdWindowAppearanceQuery } from "./preview/md-view-state.js";
import { applyThemePreference } from "./theme.js";

// Claude-smoke automation facade (design/phase-2-smoke-channel.md §2.2/§5):
// DEV-gated so `import.meta.env.DEV` is statically false in a production
// build and Vite drops both this import and the automation.js chunk entirely
// — the facade is physically absent from the packaged renderer.
if (import.meta.env.DEV) {
  void import("./automation.js").then((m) => m.installAutomation());
}

// Custom titlebar (design/ui-track custom-titlebar §2/§4): platform stamp the
// chrome CSS branches on (`:root[data-platform="darwin"]` etc. in app.css).
// Optional-chaining keeps the partial `window.anycode` stub used by tests green.
document.documentElement.dataset.platform = window.anycode?.platform ?? "darwin";

// M3 (CUT.md GAP 1): the md-preview WINDOW loads this SAME entry
// under `?view=md-preview&tabId=...&previewId=...` (main/index.ts's
// `loadMdPreviewWindow`) — branched BEFORE mounting `<App/>` so that window
// never pulls in the whole chat shell (Sidebar, connection manager, etc.).
// electron.vite.config.ts stays single-entry either way (the LAW of GAP 1).
const view = new URLSearchParams(location.search).get("view");

// The md-preview WINDOW's appearance rides in that same query (main/
// preview/md-window-appearance.ts): the narrow bridge has no settings family
// and the in-memory partition's localStorage starts empty, so the readers
// below would only yield defaults there. Outside the popout the handed-over
// values are absent and the device-local readers decide, exactly as before.
// Density stays eager pre-React (R19) either way, so the first paint already
// matches the resolved density — no reflow flash.
const mdWindowAppearance = view === "md-preview" ? parseMdWindowAppearanceQuery(location.search) : null;

applyDensity(mdWindowAppearance === null ? readDensity() : mdWindowAppearance.density);
applyAccent(mdWindowAppearance === null ? readAccent() : mdWindowAppearance.accent);
// The handed-over theme is already a RESOLVED concrete value (main probes the
// main window's applied stamp), so this stamps the attribute and binds no OS
// listener — the popout is boot-time-read-only (MdPreviewWindowApp's module
// doc) and index.html's pre-boot `data-theme="dark"` covers a handoff that
// failed safe to dark.
if (mdWindowAppearance !== null) {
  applyThemePreference(mdWindowAppearance.theme);
}

bindAccentStorageSync(window);

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

if (import.meta.env.DEV && view === "ui-gallery") {
  void import("./ui/gallery/Gallery.js").then(({ Gallery }) => {
    createRoot(container).render(<StrictMode><Gallery /></StrictMode>);
  });
} else {
  createRoot(container).render(
    <StrictMode>{view === "md-preview" ? <MdPreviewWindowApp /> : <App />}</StrictMode>,
  );
}
