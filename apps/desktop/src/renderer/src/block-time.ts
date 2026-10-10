/**
 * Wall-clock label for a transcript row (user bubble, child-report card,
 * turn-end footer). Pure: `nowMs` is injected. A missing/invalid time renders
 * nothing — never a fake one.
 *
 * Today -> "09:41"; another day -> "Oct 9, 09:41"; another year ->
 * "Oct 9, 2025, 09:41". `title` is the full local date-time.
 */
export interface BlockTime {
  label: string;
  title: string;
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const FULL = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatBlockTime(atMs: number | undefined | null, nowMs: number): BlockTime | null {
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs <= 0) return null;
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const time = TIME.format(at);
  let label: string;
  if (at.toDateString() === now.toDateString()) label = time;
  else if (at.getFullYear() === now.getFullYear()) label = `${DAY.format(at)}, ${time}`;
  else label = `${DAY_YEAR.format(at)}, ${time}`;
  return { label, title: FULL.format(at) };
}
