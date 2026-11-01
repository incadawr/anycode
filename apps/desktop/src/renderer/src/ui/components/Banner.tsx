import type { ReactNode } from "react";
import { IconDanger, IconInfo, IconWarning } from "./icons.js";

export type BannerTone = "info" | "warn" | "bad";

export interface BannerProps {
  tone?: BannerTone;
  /** Заголовок/текст сообщения. */
  children: ReactNode;
  /** Заголовок отдельной строкой. */
  title?: string;
  /** Дополнительное действие справа. */
  action?: ReactNode;
  className?: string;
}

const TONE_ICON: Record<BannerTone, ReactNode> = {
  info: <IconInfo size={14} />,
  warn: <IconWarning size={14} />,
  bad: <IconDanger size={14} />,
};

/**
 * Banner — встроенное сообщение полосой. Тон = цвет + значок + текст.
 */
export function Banner({
  tone = "info",
  children,
  title,
  action,
  className,
}: BannerProps): React.ReactElement {
  const classes = ["ak-banner", tone !== "info" ? `ak-banner--${tone}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role={tone === "bad" ? "alert" : "status"}>
      <span className="ak-banner__icon">{TONE_ICON[tone]}</span>
      <div className="ak-banner__body">
        {title ? <div className="ak-banner__title">{title}</div> : null}
        <div>{children}</div>
      </div>
      {action ? <span style={{ marginLeft: "auto" }}>{action}</span> : null}
    </div>
  );
}
