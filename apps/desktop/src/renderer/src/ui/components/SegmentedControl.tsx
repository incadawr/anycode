export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface BaseProps<T extends string> {
  options: SegmentedOption<T>[];
  /** Подпись группы (label). */
  label: string;
  className?: string;
}

export interface SingleSegmentedControlProps<T extends string> extends BaseProps<T> {
  value: T;
  onChange: (value: T) => void;
  multiple?: false;
}

export interface MultiSegmentedControlProps<T extends string> extends BaseProps<T> {
  /** Выбранные значения. */
  value: T[];
  onChange: (value: T[]) => void;
  multiple: true;
}

export type SegmentedControlProps<T extends string> =
  | SingleSegmentedControlProps<T>
  | MultiSegmentedControlProps<T>;

/**
 * SegmentedControl.
 *  - single: роль `radiogroup`, у каждого пункта aria-checked;
 *  - multi:  группа кнопок с aria-pressed (мультивыбор — «усилия», модель и т.п.).
 */
export function SegmentedControl<T extends string>(
  props: SegmentedControlProps<T>,
): React.ReactElement {
  const { options, label, className } = props;
  const isMulti = props.multiple === true;
  const classes = ["ak-seg", className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      role={isMulti ? "group" : "radiogroup"}
      aria-label={label}
    >
      {options.map((option) => {
        if (isMulti) {
          const selected = props.value.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className="ak-seg__item"
              aria-pressed={selected}
              disabled={option.disabled}
              onClick={() => {
                const next = selected
                  ? props.value.filter((v) => v !== option.value)
                  : [...props.value, option.value];
                props.onChange(next);
              }}
            >
              {option.label}
            </button>
          );
        }
        const selected = props.value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="ak-seg__item"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
