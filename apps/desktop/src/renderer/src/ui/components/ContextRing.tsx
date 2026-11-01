export interface ContextRingProps {
  /** Заполнение 0..1. */
  value: number;
  /** Диаметр в px (по умолчанию 20 — как в мокапе). */
  size?: number;
  /** Тон заливки: normal (акцент) | warn | bad. */
  tone?: "normal" | "warn" | "bad";
  /** Доступное описание: «42% of context used». */
  label: string;
  className?: string;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * ContextRing — кольцевой индикатор заполнения контекста.
 * Значение обязательно дублируется текстом (label), а не несётся только формой.
 */
export function ContextRing({
  value,
  size = 20,
  tone = "normal",
  label,
  className,
}: ContextRingProps): React.ReactElement {
  const clamped = Math.min(1, Math.max(0, value));
  const offset = CIRCUMFERENCE * (1 - clamped);
  const classes = [
    "ak-ctxring",
    tone === "warn" ? "ak-ctxring--warn" : "",
    tone === "bad" ? "ak-ctxring--bad" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      <circle className="ak-ctxring__track" cx="8" cy="8" r={RADIUS} />
      <circle
        className="ak-ctxring__fill"
        cx="8"
        cy="8"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
      />
    </svg>
  );
}
