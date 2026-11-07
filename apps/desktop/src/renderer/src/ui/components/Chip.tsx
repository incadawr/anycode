import type { ButtonHTMLAttributes, ReactNode } from "react";
import { IconAuto, IconBuild, IconEdit, IconPlan, IconYolo } from "./icons.js";

/** Access mode. Color escalation: plan (neutral) → build/edit (accent) → auto (warning) → yolo (danger). */
export type AccessMode = "plan" | "build" | "edit" | "auto" | "yolo";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Access mode — sets both the color and the icon. */
  mode?: AccessMode;
  /** Plain neutral chip (no mode). */
  label?: string;
  /** Override the mode icon. */
  icon?: ReactNode;
  /** Selected state: `aria-pressed="true"` + accent highlight. */
  selected?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}

const MODE_ICON: Record<AccessMode, ReactNode> = {
  plan: <IconPlan size={12} />,
  build: <IconBuild size={12} />,
  edit: <IconEdit size={12} />,
  auto: <IconAuto size={12} />,
  yolo: <IconYolo size={12} />,
};

export const ACCESS_MODE_LABEL: Record<AccessMode, string> = {
  plan: "plan",
  build: "build",
  edit: "edit",
  auto: "auto",
  yolo: "yolo",
};

/**
 * Chip. If `mode` is set, the chip shows the access mode: its own color AND its own icon
 * (the rule "status = color + icon + word"). Otherwise — a neutral chip.
 */
export function Chip({
  mode,
  label,
  icon,
  selected,
  disabled = false,
  className,
  children,
  type = "button",
  ...rest
}: ChipProps): React.ReactElement {
  const classes = [
    "ak-chip",
    mode ? `ak-chip--${mode}` : "",
    selected ? "ak-chip--selected" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = mode ? (
    <>
      <span className="ak-chip__icon">{icon ?? MODE_ICON[mode]}</span>
      <span>{label ?? ACCESS_MODE_LABEL[mode]}</span>
    </>
  ) : (
    <>
      {icon ? <span className="ak-chip__icon">{icon}</span> : null}
      {label}
    </>
  );

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      aria-pressed={selected}
      {...rest}
    >
      {content}
      {children}
    </button>
  );
}
