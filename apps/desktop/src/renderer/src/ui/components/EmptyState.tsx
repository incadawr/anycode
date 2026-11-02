import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Что это (заголовок). */
  title: string;
  /** Почему пусто — одна строка. */
  description?: string;
  /** Одно главное действие. */
  action?: ReactNode;
  /** Декоративная иконка (скрыта от скринридера). */
  icon?: ReactNode;
  /** Уровень заголовка `h*` (2…6). По умолчанию `h3`. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

/**
 * EmptyState: что это + почему пусто + что делать.
 *
 * Заголовок рендерится настоящим `h*` нужного уровня (`headingLevel`,
 * по умолчанию `h3`), чтобы структура документа оставалась корректной.
 * Максимум одно главное действие.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  headingLevel = 3,
  className,
}: EmptyStateProps): React.ReactElement {
  const classes = ["ak-empty", className ?? ""].filter(Boolean).join(" ");
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <div className={classes}>
      {icon ? (
        <div className="ak-empty__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <Heading className="ak-empty__title">{title}</Heading>
      {description ? <p className="ak-empty__desc">{description}</p> : null}
      {action ? <div className="ak-empty__action">{action}</div> : null}
    </div>
  );
}
