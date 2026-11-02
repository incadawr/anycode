import type { ButtonHTMLAttributes, ReactNode } from "react";
import { IconAuto, IconBuild, IconEdit, IconPlan, IconYolo } from "./icons.js";

/** Режим доступа. Эскалация цвета: plan (нейтральный) → build/edit (акцент) → auto (warning) → yolo (danger). */
export type AccessMode = "plan" | "build" | "edit" | "auto" | "yolo";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Режим доступа — задаёт и цвет, и значок. */
  mode?: AccessMode;
  /** Обычный нейтральный чип (без режима). */
  label?: string;
  /** Переопределить иконку режима. */
  icon?: ReactNode;
  /** Выбранное состояние: `aria-pressed="true"` + акцентная подсветка. */
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
 * Chip. Если задан `mode` — чип показывает режим доступа: свой цвет И свой значок
 * (правило «статус = цвет + иконка + слово»). Иначе — нейтральный чип.
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
