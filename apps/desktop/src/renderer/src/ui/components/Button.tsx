import type { ComponentPropsWithRef, ReactNode } from "react";
import { IconSpinner } from "./icons.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ComponentPropsWithRef<"button">, "disabled"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, aria-busy=true; the button width is preserved. */
  loading?: boolean;
  disabled?: boolean;
  /** Icon to the left of the label (aria-hidden). */
  icon?: ReactNode;
  /** Icon to the left of the label (aria-hidden). Primary name; `icon` is a deprecated alias. */
  leadingIcon?: ReactNode;
  children?: ReactNode;
}

/**
 * Button. Variants: primary | secondary | ghost | danger.
 * Sizes: sm | md | lg.
 * disabled → opacity .45, shape stays the same.
 * loading → aria-busy="true", the text is replaced by a spinner (duplicated as text for screen readers).
 * `type` defaults to "button" (so the button does not submit a form by accident).
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled = false,
  icon,
  leadingIcon,
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
      ) : leadingIcon ?? icon ? (
        <span className="ak-btn__icon" aria-hidden="true">{leadingIcon ?? icon}</span>
      ) : null}
      {children}
    </button>
  );
}
