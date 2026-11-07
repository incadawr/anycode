import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { IconClose, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Banner tone.
 *
 * Canonical tones (S3, wave W3): `info` | `success` | `warning` | `danger`.
 * Legacy `warn` | `bad` are kept as aliases (`warn`→`warning`,
 * `bad`→`danger`), so existing code and tests keep working.
 */
export type BannerTone = "info" | "success" | "warning" | "danger" | "warn" | "bad";

export interface BannerProps {
  /** Tone: color + icon + text; `role` is derived from the tone. */
  tone?: BannerTone;
  /** Message text. */
  children: ReactNode;
  /** Title on a separate line. */
  title?: string;
  /** Extra action on the right. */
  action?: ReactNode;
  /** Show the close button; `onDismiss` is required together with `closable`. */
  closable?: boolean;
  /** Close handler. */
  onDismiss?: () => void;
  className?: string;
}

/** Canonical tone for each name. */
const TONE: Record<BannerTone, "info" | "success" | "warning" | "danger"> = {
  info: "info",
  success: "success",
  warning: "warning",
  warn: "warning",
  danger: "danger",
  bad: "danger",
};

const TONE_ICON: Record<"info" | "success" | "warning" | "danger", ReactNode> = {
  info: <IconInfo size={14} />,
  success: <IconSuccess size={14} />,
  warning: <IconWarning size={14} />,
  danger: <IconDanger size={14} />,
};

/**
 * Banner — an inline message bar. Tone = color + icon + text.
 *
 * The role is derived from the tone: `danger` — `role="alert"` (assertive),
 * other tones — `role="status"` (polite). Optionally dismissible.
 */
export function Banner({
  tone = "info",
  children,
  title,
  action,
  closable = false,
  onDismiss,
  className,
}: BannerProps): React.ReactElement {
  const canonical = TONE[tone];
  const classes = [...new Set([
    "ak-banner",
    `ak-banner--${canonical}`,
    `ak-banner--${tone}`,
    className ?? "",
  ])]
    .filter(Boolean)
    .join(" ");
  const assertive = canonical === "danger";
  return (
    <div
      className={classes}
      data-tone={canonical}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
    >
      <span className="ak-banner__icon">{TONE_ICON[canonical]}</span>
      <div className="ak-banner__body">
        {title ? <div className="ak-banner__title">{title}</div> : null}
        <div>{children}</div>
      </div>
      {action ? <span className="ak-banner__action">{action}</span> : null}
      {closable ? (
        <span className="ak-banner__close">
          <IconButton label="Dismiss notice" icon={<IconClose size={12} />} onClick={onDismiss} />
        </span>
      ) : null}
    </div>
  );
}
