/**
 * One row of the environment dropdown in the same shape as Workspace / Branch /
 * Changes: a decorative icon, a title with an optional secondary line, and the
 * row's control on the right. The Sessions API, external-approvals, handle and
 * full-browser-access rows all use it so the menu stays one rhythm.
 *
 * Secondary lines here WRAP instead of being clipped: they carry hints and state
 * sentences that the owner must be able to read in full.
 */
import type { ReactNode } from "react";

export interface EnvironmentMenuRowProps {
  /** Decorative glyph shown before the text (the row's accessible name is `ariaLabel`). */
  icon: ReactNode;
  title: string;
  /** Secondary line under the title; wraps, never ellipsized. */
  detail?: string | null;
  /** Tooltip for the secondary line when the visible text is a short form of it. */
  detailTitle?: string;
  /** Control rendered on the right side of the row. */
  control?: ReactNode;
  /** Accessible name of the row (its inputs keep their own labels). */
  ariaLabel: string;
  /** Error line under the detail, announced to assistive tech. */
  error?: string | null;
}

export function EnvironmentMenuRow({ icon, title, detail, detailTitle, control, ariaLabel, error }: EnvironmentMenuRowProps) {
  return (
    <div className="environment-menu-row" role="group" aria-label={ariaLabel}>
      {icon}
      <span className="environment-menu-row-main">
        <span className="environment-menu-row-title">{title}</span>
        {detail !== undefined && detail !== null && detail !== "" && (
          <span className="environment-menu-row-detail environment-menu-row-detail-prose" title={detailTitle}>
            {detail}
          </span>
        )}
        {error !== undefined && error !== null && error !== "" && (
          <span className="environment-menu-row-error" role="alert">
            {error}
          </span>
        )}
      </span>
      {control !== undefined && control !== null && <span className="environment-menu-actions">{control}</span>}
    </div>
  );
}
