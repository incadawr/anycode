import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** What it is (the heading). */
  title: string;
  /** Why it is empty — one line. */
  description?: string;
  /** One primary action. */
  action?: ReactNode;
  /** Decorative icon (hidden from screen readers). */
  icon?: ReactNode;
  /** Heading level for `h*` (2…6). Defaults to `h3`. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

/**
 * EmptyState: what it is + why it is empty + what to do.
 *
 * The heading renders as a real `h*` of the requested level (`headingLevel`,
 * defaulting to `h3`), so the document outline stays correct.
 * At most one primary action.
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
