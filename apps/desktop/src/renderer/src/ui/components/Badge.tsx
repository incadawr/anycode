import type { ReactNode } from "react";
import { IconAccent, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/** Статус бейджа. */
export type BadgeStatus = "ok" | "run" | "warn" | "bad" | "info" | "neutral";

export interface BadgeProps {
  status: BadgeStatus;
  /** Текстовый статус — обязателен: статус нельзя передавать только цветом. */
  label: string;
  /** Переопределить значок статуса. */
  icon?: ReactNode;
  className?: string;
}

const STATUS_ICON: Record<BadgeStatus, ReactNode> = {
  ok: <IconSuccess size={12} />,
  run: <IconAccent size={12} />,
  warn: <IconWarning size={12} />,
  bad: <IconDanger size={12} />,
  info: <IconInfo size={12} />,
  neutral: <IconInfo size={12} />,
};

/**
 * Badge. Статус = цвет + значок + слово (WCAG 1.4.1).
 * Значки: ok — галочка, run — ромб, warn — треугольник, bad — крест,
 * info — круг (единственная округлая форма).
 */
export function Badge({ status, label, icon, className }: BadgeProps): React.ReactElement {
  const classes = ["ak-badge", `ak-badge--${status}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <span className="ak-chip__icon">{icon ?? STATUS_ICON[status]}</span>
      <span>{label}</span>
    </span>
  );
}
