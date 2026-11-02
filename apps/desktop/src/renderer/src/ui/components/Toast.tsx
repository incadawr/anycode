import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { IconAccent, IconClose, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Статус сообщения. Базовые: ok | run | warn | bad | info | neutral;
 * синонимы тонов: success (ok), warning (warn), error (bad).
 */
export type ToastStatus = "ok" | "run" | "warn" | "bad" | "info" | "neutral" | "success" | "warning" | "error";

export interface ToastProps {
  status: ToastStatus;
  /** Текст сообщения — обязателен (статус = цвет + иконка + слово). */
  message: string;
  /** Дополнительное действие, например «Undo». */
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  /** assertive — только для ошибки, прерывающей работу. */
  assertive?: boolean;
  /** Автозакрытие через N мс. Таймер снимается при размонтировании (без утечки). */
  duration?: number;
  /** Вызывается при автозакрытии (по истечении `duration`). */
  onAutoHide?: () => void;
  className?: string;
}

const STATUS_ICON: Record<ToastStatus, ReactNode> = {
  ok: <IconSuccess size={14} />,
  success: <IconSuccess size={14} />,
  run: <IconAccent size={14} />,
  warn: <IconWarning size={14} />,
  warning: <IconWarning size={14} />,
  bad: <IconDanger size={14} />,
  error: <IconDanger size={14} />,
  info: <IconInfo size={14} />,
  neutral: <IconInfo size={14} />,
};

/** Тона, которые читаются как ошибка: роль alert. */
const ALERT_STATUS: ToastStatus[] = ["bad", "error"];

/**
 * Toast. role="status" + aria-live="polite" (по умолчанию);
 * для ошибки (статус bad/error) — role="alert" + aria-live="assertive".
 *
 * `duration` включает автозакрытие: таймер снимается при размонтировании,
 * повторный вызов `onAutoHide` не происходит после ухода компонента.
 */
export function Toast({
  status,
  message,
  action,
  onDismiss,
  assertive = false,
  duration,
  onAutoHide,
  className,
}: ToastProps): React.ReactElement {
  const isAlert = assertive || ALERT_STATUS.includes(status);
  const classes = ["ak-toast", `ak-toast--${status}`, className].filter(Boolean).join(" ");

  const onAutoHideRef = useRef(onAutoHide);
  onAutoHideRef.current = onAutoHide;

  useEffect(() => {
    if (duration === undefined || duration <= 0) return;
    const timer = setTimeout(() => { onAutoHideRef.current?.(); }, duration);
    return () => clearTimeout(timer);
  }, [duration]);

  return (
    <div
      className={classes}
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
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
  children?: ReactNode;
  /** Имя области для скринридера (необязательно). */
  label?: string;
  className?: string;
}

/** Контейнер тостов: фиксированная полоса в правом нижнем углу. */
export function ToastStack({ children, label, className }: ToastStackProps): React.ReactElement {
  return <div
    className={["ak-toasts", className].filter(Boolean).join(" ")}
    role={label ? "region" : undefined}
    aria-label={label}
  >{children}</div>;
}
