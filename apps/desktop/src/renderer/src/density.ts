// Density is a device-local preference (localStorage, like notifications),
// NOT a vault setting: it describes this machine's screen, not the account.
// CSS consumes it via the `data-density` attribute on <html>; nothing in
// React subscribes to it, so there is no store — just a key, two pure
// helpers, a guarded reader, and a DOM stamp (mirrors notifications.ts).

export const DENSITY_KEY = "anycode.appearance.density";

export type Density = "comfortable" | "compact";

// Stored-value parser: only the exact string "comfortable" opts out of the
// compact default; null/corrupt/unknown values fail safe to compact
// (owner decision, phase-7 F13). Explicitly saved choices are honored either way.
export function parseDensity(raw: string | null): Density {
  return raw === "comfortable" ? "comfortable" : "compact";
}

// Attribute value for <html data-density>; null means the attribute is
// removed (absent attribute = comfortable, so no stale state can persist).
export function densityAttrValue(density: Density): "compact" | null {
  return density === "compact" ? "compact" : null;
}

// localStorage read; fails safe to the compact default when storage is
// unavailable (same try/catch discipline as notifications.ts readTurnNotifyEnabled).
export function readDensity(): Density {
  try {
    return parseDensity(localStorage.getItem(DENSITY_KEY));
  } catch {
    return "compact";
  }
}

// Stamps or removes data-density on <html>. Guarded so importing this
// module (and calling this in node-env tests) is a no-op without a DOM.
export function applyDensity(density: Density): void {
  if (typeof document === "undefined") return;
  const value = densityAttrValue(density);
  if (value === null) {
    document.documentElement.removeAttribute("data-density");
  } else {
    document.documentElement.setAttribute("data-density", value);
  }
}
