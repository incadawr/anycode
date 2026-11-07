import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the button's meaning without a visible label. */
  label: string;
  icon: ReactNode;
  /** Highlighted state (aria-pressed). */
  pressed?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
}

/**
 * IconButton. A button with an icon only.
 * `label` is required (→ aria-label and title), and a hit area ≥24px (--tap-min).
 */
export function IconButton({
  label,
  icon,
  pressed,
  size = "sm",
  disabled = false,
  className,
  type = "button",
  ...rest
}: IconButtonProps): React.ReactElement {
  const classes = [
    "ak-iconbtn",
    size === "md" ? "ak-iconbtn--md" : "",
    pressed ? "ak-iconbtn--on" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      {...rest}
    >
      {icon}
    </button>
  );
}
