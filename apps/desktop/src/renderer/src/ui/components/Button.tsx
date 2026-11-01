import type { ButtonHTMLAttributes, ReactNode } from "react";
import { IconSpinner } from "./icons.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Показывает спиннер, aria-busy=true; ширина кнопки сохраняется. */
  loading?: boolean;
  disabled?: boolean;
  /** Иконка слева от подписи (aria-hidden). */
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * Button. Варианты: primary | secondary | ghost | danger.
 * Размеры: sm | md | lg.
 * disabled → opacity .45, форма не меняется.
 * loading → aria-busy="true", текст заменяется спиннером (дублируется текстом для скринридера).
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled = false,
  icon,
  className,
  children,
  type = "button",
  onClick,
  ...rest
}: ButtonProps): React.ReactElement {
  const classes = [
    "ak-btn",
    `ak-btn--${variant}`,
    size !== "md" ? `ak-btn--${size}` : "",
    loading ? "ak-btn--loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
      onClick={event => {
        if (loading || disabled) { event.preventDefault(); return; }
        onClick?.(event);
      }}
    >
      {loading ? (
        <IconSpinner size={size === "lg" ? 16 : 14} className="ak-btn__spinner" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
