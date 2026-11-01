import { useId, useState } from "react";
import type { ReactNode } from "react";
import { IconChevron } from "./icons.js";

export interface ToolCardProps {
  /** Имя вызова (моноширинное). */
  name: string;
  /** Краткое описание одной строкой. */
  summary?: string;
  /** Содержимое раскрытой части (моноширинное). */
  body?: ReactNode;
  /** Дополнительный контент в заголовке справа (например Badge). */
  aside?: ReactNode;
  /** Управляемый режим: если задан — состояние полностью контролируется извне. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/**
 * ToolCard — раскрываемая карточка вызова инструмента.
 * Заголовок — <button aria-expanded> + aria-controls; тело связано через id.
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
