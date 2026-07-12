import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyDensity, readDensity } from "./density.js";

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

// Density stamp (R19): eager, pre-React, so the first paint already matches the
// resolved density — no reflow flash. Compact is the default (F13), so this
// stamp writes data-density="compact" pre-paint for default users; the CSS
// still treats absent-attribute as comfortable, so no index.html pre-boot
// default is needed (unlike theme) — the stamp is what enforces the default.
applyDensity(readDensity());

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
