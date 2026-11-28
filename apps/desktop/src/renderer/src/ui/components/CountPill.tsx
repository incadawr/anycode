import type { ReactNode } from "react";
import { IconDashedRing } from "./icons.js";

export interface CountPillItem {
  /** Stable key, also exposed as `data-item` for tests. */
  id: string;
  /** Decorative glyph. Give it its own `width`/`height`; the pill adds no size of its own. */
  icon: ReactNode;
  /** Items with a count of 0 (or less) are not drawn. */
  count: number;
}

export interface CountPillProps {
  /** One icon + count group per item, in order. */
  items: readonly CountPillItem[];
  /** Draws a slowly rotating dashed ring after the items: something is still running. */
  busy?: boolean;
  /** Plain-words description for hover. The pill itself is not announced: put the same words in the accessible name of the control that contains it. */
  title?: string;
  className?: string;
}

/**
 * CountPill — a compact outlined pill of "icon + number" groups with an optional ambient "still running" ring.
 * It is presentational and non-interactive, and its glyphs are decorative: a screen reader gets nothing from it,
 * so the parent control must carry the meaning in its own accessible name. Renders nothing when every count is 0.
 */
export function CountPill({ items, busy = false, title, className }: CountPillProps): React.ReactElement | null {
  const visible = items.filter((item) => item.count > 0);
  if (visible.length === 0) return null;
  return (
    <span className={["ak-countpill", className ?? ""].filter(Boolean).join(" ")} title={title}>
      {visible.map((item) => (
        <span key={item.id} className="ak-countpill__item" data-item={item.id}>
          {item.icon}
          <span className="ak-countpill__count">{item.count}</span>
        </span>
      ))}
      {busy ? <IconDashedRing className="ak-countpill__ring" /> : null}
    </span>
  );
}
