// Accent is a device-local preference, independent of vault settings.
export const ACCENT_KEY = "anycode.appearance.accent";
export const ACCENTS = ["current", "blue", "gold", "indigo", "teal", "ember"] as const;
export type Accent = typeof ACCENTS[number];
// Keep the legacy gold value readable without rendering a duplicate swatch.
export const VISIBLE_ACCENTS = ["current", "blue", "indigo", "teal", "ember"] as const;
export function parseAccent(raw: string | null): Accent {
  return ACCENTS.includes(raw as Accent) ? raw as Accent : "current";
}
export function accentAttrValue(accent: Accent): Exclude<Accent, "current"> | null {
  return accent === "current" ? null : accent;
}
export function readAccent(): Accent {
  try { return parseAccent(localStorage.getItem(ACCENT_KEY)); } catch { return "current"; }
}
const listeners = new Set<() => void>();
export function applyAccent(accent: Accent): void {
  if (typeof document === "undefined") return;
  const value = accentAttrValue(accent);
  if (value === null) document.documentElement.removeAttribute("data-accent");
  else document.documentElement.setAttribute("data-accent", value);
  for (const cb of listeners) cb();
}
export function readAppliedAccent(): Accent {
  return parseAccent(document.documentElement.getAttribute("data-accent"));
}
export function subscribeAccent(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function nextAccent(current: Accent, key: string): Accent | null {
  if (key === "Home") return VISIBLE_ACCENTS[0];
  if (key === "End") return VISIBLE_ACCENTS[VISIBLE_ACCENTS.length - 1]!;
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  const visible = current === "gold" ? "current" : current;
  return step ? VISIBLE_ACCENTS[(VISIBLE_ACCENTS.indexOf(visible) + step + VISIBLE_ACCENTS.length) % VISIBLE_ACCENTS.length]! : null;
}
export function bindAccentStorageSync(win: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCENT_KEY) applyAccent(parseAccent(event.newValue));
  };
  win.addEventListener("storage", onStorage);
  return () => win.removeEventListener("storage", onStorage);
}
