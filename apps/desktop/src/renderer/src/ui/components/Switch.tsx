import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  /** Текущее состояние — отражается в aria-checked. */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Текстовая подпись рядом с переключателем. */
  label?: string;
  /** Описание под подписью (id для aria-describedby). */
  describedBy?: string;
  disabled?: boolean;
  children?: ReactNode;
}

/**
 * Switch. Роль `switch`, состояние — aria-checked.
 * Управляется клавиатурой (Space/Enter) через нативный <button>.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  describedBy,
  disabled = false,
  className,
  children,
  type = "button",
  ...rest
}: SwitchProps): React.ReactElement {
  const classes = ["ak-switch", className ?? ""].filter(Boolean).join(" ");

  const control = (
    <button
      type={type}
      role="switch"
      aria-label={label}
      className={classes}
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    />
  );

  if (!label && !children) return control;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
      {control}
      {label ? <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-1)" }}>{label}</span> : null}
      {children}
    </span>
  );
}
