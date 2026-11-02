import { useId } from "react";
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
 * Имя: `label` → aria-labelledby на отдельный узел подписи (тот же паттерн,
 * что у Checkbox/Radio), при отсутствии label — aria-label.
 * Геометрия совпадает с .settings-switch приложения: 32×18, ползунок 12px.
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
  const labelId = useId();
  const classes = ["ak-switch", className ?? ""].filter(Boolean).join(" ");

  const control = (
    <button
      type={type}
      role="switch"
      aria-labelledby={label ? labelId : undefined}
      aria-label={label ? undefined : rest["aria-label"]}
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
    <span className="ak-switch__row">
      {control}
      {label ? (
        <span className="ak-switch__label" id={labelId}>
          {label}
        </span>
      ) : null}
      {children}
    </span>
  );
}
