import type { ReactNode } from "react";
import { IconAccent, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Badge status.
 *
 * Canonical tones (S3, wave W3): `neutral` | `success` | `warning` | `danger` |
 * `info`. The historical names `ok` | `warn` | `bad` | `run` are kept as aliases
 * (`ok`→`success`, `warn`→`warning`, `bad`→`danger`, `run`→`accent`), so that
 * existing code and tests don't break.
 */
export type BadgeStatus =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent"
  | "ok"
  | "run"
  | "warn"
  | "bad";

export interface BadgeProps {
  /** Status: tone + icon + word. */
  status: BadgeStatus;
  /** Text status — required: status cannot be conveyed by color alone. */
  label: string;
  /** Override the status icon. */
  icon?: ReactNode;
  className?: string;
}

/** Canonical tone for each status name. */
const TONE: Record<BadgeStatus, "neutral" | "success" | "warning" | "danger" | "info" | "accent"> = {
  neutral: "neutral",
  success: "success",
  ok: "success",
  warning: "warning",
  warn: "warning",
  danger: "danger",
  bad: "danger",
  info: "info",
  accent: "accent",
  run: "accent",
};

/** Tone icon: the icon's shape carries meaning (not only color). */
const TONE_ICON: Record<"neutral" | "success" | "warning" | "danger" | "info" | "accent", ReactNode> = {
  neutral: <IconInfo size={12} />,
  success: <IconSuccess size={12} />,
  warning: <IconWarning size={12} />,
  danger: <IconDanger size={12} />,
  info: <IconInfo size={12} />,
  accent: <IconAccent size={12} />,
};

/**
 * Badge. Status = color + icon + word (WCAG 1.4.1).
 * Icons: success — checkmark, accent — diamond, warning — triangle,
 * danger — cross, info/neutral — circle (the only round shape).
 * `label` is required: color alone is not a status.
 */
export function Badge({ status, label, icon, className }: BadgeProps): React.ReactElement {
  const tone = TONE[status];
  const classes = [...new Set(["ak-badge", `ak-badge--${tone}`, `ak-badge--${status}`, className ?? ""])]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-tone={tone}>
      <span className="ak-chip__icon">{icon ?? TONE_ICON[tone]}</span>
      <span>{label}</span>
    </span>
  );
}
