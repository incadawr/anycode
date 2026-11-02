import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { IconClose, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Тон баннера.
 *
 * Канонические тона (S3, волна W3): `info` | `success` | `warning` | `danger`.
 * Исторические `warn` | `bad` сохранены как синонимы (`warn`→`warning`,
 * `bad`→`danger`), чтобы существующий код и тесты не ломались.
 */
export type BannerTone = "info" | "success" | "warning" | "danger" | "warn" | "bad";

export interface BannerProps {
  /** Тон: цвет + значок + текст; `role` выводится из тона. */
  tone?: BannerTone;
  /** Текст сообщения. */
  children: ReactNode;
  /** Заголовок отдельной строкой. */
  title?: string;
  /** Дополнительное действие справа. */
  action?: ReactNode;
  /** Показать кнопку закрытия; `onDismiss` обязателен вместе с `closable`. */
  closable?: boolean;
  /** Обработчик закрытия. */
  onDismiss?: () => void;
  className?: string;
}

/** Канонический тон для каждого имени. */
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
 * Banner — встроенное сообщение полосой. Тон = цвет + значок + текст.
 *
 * Роль выводится из тона: `danger` — `role="alert"` (assertive),
 * остальные тона — `role="status"` (polite). Опционально закрываемый.
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
