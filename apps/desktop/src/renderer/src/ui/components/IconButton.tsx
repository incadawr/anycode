import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Обязателен: смысл кнопки без подписи. */
  label: string;
  icon: ReactNode;
  /** Подсвеченное состояние (aria-pressed). */
  pressed?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
}

/**
 * IconButton. Кнопка только с иконкой.
 * Обязательны `label` (→ aria-label и title) и hit-область ≥24px (--tap-min).
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
