import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Что это (заголовок). */
  title: string;
  /** Почему пусто — одна строка. */
  description?: string;
  /** Одно главное действие. */
  action?: ReactNode;
  /** Декоративная иконка (aria-hidden). */
  icon?: ReactNode;
  className?: string;
}

/**
 * EmptyState: что это + почему пусто + что делать.
 * Максимум одно главное действие.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps): React.ReactElement {
  const classes = ["ak-empty", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {icon ? <div className="ak-empty__icon">{icon}</div> : null}
      <p className="ak-empty__title">{title}</p>
      {description ? <p className="ak-empty__desc">{description}</p> : null}
      {action ? <div style={{ marginTop: "var(--sp-2)" }}>{action}</div> : null}
    </div>
  );
}
