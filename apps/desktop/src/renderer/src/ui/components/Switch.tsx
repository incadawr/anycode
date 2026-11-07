import { useId } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  /** Current state — reflected in aria-checked. */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Text label next to the toggle. */
  label?: string;
  /** Description under the label (id for aria-describedby). */
  describedBy?: string;
  disabled?: boolean;
  children?: ReactNode;
}

/**
 * Switch. Role `switch`, state — aria-checked.
 * Keyboard-controlled (Space/Enter) via a native <button>.
 * Name: `label` → aria-labelledby on a separate label node (same pattern
 * as Checkbox/Radio); without a label — aria-label.
 * Geometry matches the app's .settings-switch: 32×18, thumb 12px.
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
