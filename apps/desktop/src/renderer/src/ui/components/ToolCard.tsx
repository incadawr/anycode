import { useId, useState } from "react";
import type { ReactNode } from "react";
import { IconChevron } from "./icons.js";

export interface ToolCardProps {
  /** Tool call name (monospace). */
  name: string;
  /** Short one-line description. */
  summary?: string;
  /** Expanded content (monospace). */
  body?: ReactNode;
  /** Extra content on the right of the header (e.g. Badge). */
  aside?: ReactNode;
  /** Controlled mode: if set, the state is fully driven from outside. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/**
 * ToolCard — an expandable card for a tool call.
 * Header — <button aria-expanded> + aria-controls; the body is linked via id.
 */
export function ToolCard({
  name,
  summary,
  body,
  aside,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className,
}: ToolCardProps): React.ReactElement {
  const bodyId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? expanded : uncontrolled;

  const toggle = (): void => {
    const next = !isExpanded;
    if (!isControlled) setUncontrolled(next);
    onExpandedChange?.(next);
  };

  const classes = ["ak-toolcard", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <button
        type="button"
        className="ak-toolcard__head"
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <IconChevron size={12} className="ak-toolcard__chev" />
        <span className="ak-toolcard__name">{name}</span>
        {summary ? <span className="ak-toolcard__summary">{summary}</span> : null}
        {aside}
      </button>
      {body !== undefined ? (
        <div className="ak-toolcard__body" id={bodyId} hidden={!isExpanded}>
          {body}
        </div>
      ) : null}
    </div>
  );
}
