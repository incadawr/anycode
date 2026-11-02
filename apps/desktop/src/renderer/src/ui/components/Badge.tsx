import type { ReactNode } from "react";
import { IconAccent, IconDanger, IconInfo, IconSuccess, IconWarning } from "./icons.js";

/**
 * Статус бейджа.
 *
 * Канонические тона (S3, волна W3): `neutral` | `success` | `warning` | `danger` |
 * `info`. Исторические имена `ok` | `warn` | `bad` | `run` сохранены как синонимы
 * (`ok`→`success`, `warn`→`warning`, `bad`→`danger`, `run`→`accent`), чтобы
 * существующий код и тесты не ломались.
 */
export type BadgeStatus =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent"
  | "ok"
  | "run"
  | "warn"
  | "bad";

export interface BadgeProps {
  /** Статус: тон + значок + слово. */
  status: BadgeStatus;
  /** Текстовый статус — обязателен: статус нельзя передавать только цветом. */
  label: string;
  /** Переопределить значок статуса. */
  icon?: ReactNode;
  className?: string;
}

/** Канонический тон для каждого имени статуса. */
const TONE: Record<BadgeStatus, "neutral" | "success" | "warning" | "danger" | "info" | "accent"> = {
  neutral: "neutral",
  success: "success",
  ok: "success",
  warning: "warning",
  warn: "warning",
  danger: "danger",
  bad: "danger",
  info: "info",
  accent: "accent",
  run: "accent",
};

/** Значок тона: форма значка несёт смысл (не только цвет). */
const TONE_ICON: Record<"neutral" | "success" | "warning" | "danger" | "info" | "accent", ReactNode> = {
  neutral: <IconInfo size={12} />,
  success: <IconSuccess size={12} />,
  warning: <IconWarning size={12} />,
  danger: <IconDanger size={12} />,
  info: <IconInfo size={12} />,
  accent: <IconAccent size={12} />,
};

/**
 * Badge. Статус = цвет + значок + слово (WCAG 1.4.1).
 * Значки: success — галочка, accent — ромб, warning — треугольник,
 * danger — крест, info/neutral — круг (единственная округлая форма).
 * `label` обязателен: цвет сам по себе не является статусом.
 */
export function Badge({ status, label, icon, className }: BadgeProps): React.ReactElement {
  const tone = TONE[status];
  const classes = [...new Set(["ak-badge", `ak-badge--${tone}`, `ak-badge--${status}`, className ?? ""])]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-tone={tone}>
      <span className="ak-chip__icon">{icon ?? TONE_ICON[tone]}</span>
      <span>{label}</span>
    </span>
  );
}
