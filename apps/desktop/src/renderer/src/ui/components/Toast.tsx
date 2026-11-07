import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { IconAccent, IconClose, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Message status. Base tones: ok | run | warn | bad | info | neutral;
 * tone aliases: success (ok), warning (warn), error (bad).
 */
export type ToastStatus = "ok" | "run" | "warn" | "bad" | "info" | "neutral" | "success" | "warning" | "error";

export interface ToastProps {
  status: ToastStatus;
  /** Message text — required (status = color + icon + word). */
  message: string;
  /** Optional extra action, e.g. «Undo». */
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  /** assertive — only for errors that interrupt work. */
  assertive?: boolean;
  /** Auto-hide after N ms. The timer is cleared on unmount (no leak). */
  duration?: number;
  /** Called on auto-hide (after `duration` elapses). */
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

/** Tones read as errors: role alert. */
const ALERT_STATUS: ToastStatus[] = ["bad", "error"];

/**
 * Toast. role="status" + aria-live="polite" (default);
 * for errors (status bad/error) — role="alert" + aria-live="assertive".
 *
 * `duration` enables auto-hide: the timer is cleared on unmount,
 * `onAutoHide` is not called after the component unmounts.
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
  /** Child toasts (usually <Toast/>). */
  children?: ReactNode;
  /** Landmark name for screen readers (optional). */
  label?: string;
  className?: string;
}

/** Toast container: a fixed strip in the bottom-right corner. */
export function ToastStack({ children, label, className }: ToastStackProps): React.ReactElement {
  return <div
    className={["ak-toasts", className].filter(Boolean).join(" ")}
    role={label ? "region" : undefined}
    aria-label={label}
  >{children}</div>;
}
