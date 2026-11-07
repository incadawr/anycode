export interface ContextRingProps {
  /** Fill, 0..1. */
  value: number;
  /** Diameter in px (default 20, as in the mockup). */
  size?: number;
  /** Fill tone: normal (accent) | warn | bad. */
  tone?: "normal" | "warn" | "bad";
  /** Accessible description: «42% of context used». */
  label: string;
  className?: string;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * ContextRing — a ring indicator of context fill.
 * The value must be duplicated as text (label), not carried by the shape alone.
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
