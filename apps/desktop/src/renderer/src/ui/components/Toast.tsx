import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { IconAccent, IconClose, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

export type ToastStatus = "ok" | "run" | "warn" | "bad" | "info" | "neutral";

export interface ToastProps {
  status: ToastStatus;
  /** Текст сообщения — обязателен (статус = цвет + иконка + слово). */
  message: string;
  /** Дополнительное действие, например «Undo». */
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  /** assertive — только для ошибки, прерывающей работу. */
  assertive?: boolean;
  className?: string;
}

const STATUS_ICON: Record<ToastStatus, ReactNode> = {
  ok: <IconSuccess size={14} />,
  run: <IconAccent size={14} />,
  warn: <IconWarning size={14} />,
  bad: <IconDanger size={14} />,
  info: <IconInfo size={14} />,
  neutral: <IconInfo size={14} />,
};

/**
 * Toast. role="status" + aria-live="polite" (по умолчанию);
 * для ошибки — aria-live="assertive".
 */
export function Toast({
  status,
  message,
  action,
  onDismiss,
  assertive = false,
  className,
}: ToastProps): React.ReactElement {
  const classes = ["ak-toast", `ak-toast--${status}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
    >
      <span className="ak-toast__icon">{STATUS_ICON[status]}</span>
      <span className="ak-toast__text">{message}</span>
      {action ? (
        <button
          type="button"
          className="ak-btn ak-btn--ghost ak-btn--sm"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <IconButton label="Dismiss" icon={<IconClose size={12} />} onClick={onDismiss} />
      ) : null}
    </div>
  );
}

export interface ToastStackProps {
  /** Дочерние тосты (обычно <Toast/>). */
  children: ReactNode;
  className?: string;
}

/** Контейнер тостов: фиксированная полоса в правом нижнем углу. */
export function ToastStack({ children, className }: ToastStackProps): React.ReactElement {
  return <div className={["ak-toasts", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}
