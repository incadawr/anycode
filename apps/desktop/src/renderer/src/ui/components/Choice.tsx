import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRovingTabindex } from "./useRovingTabindex.js";

export interface CheckboxProps {
  /** Текстовая подпись; связывается с контролом через label htmlFor. */
  label: ReactNode;
  /** Контролируемое состояние. */
  checked?: boolean;
  /** Начальное состояние для неконтролируемого режима. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Третье состояние «частично выбрано» (aria-checked="mixed"). */
  indeterminate?: boolean;
  disabled?: boolean;
  /** Вспомогательный текст под подписью (id для aria-describedby). */
  description?: string;
  className?: string;
  id?: string;
}

/**
 * Checkbox. Роль `checkbox`, состояния checked / indeterminate (mixed) / disabled.
 * Метка связана с контролом через id (useId), описание — через aria-describedby.
 * Нативный <input type="checkbox">: клик мышью и Space работают без скриптов.
 */
export function Checkbox({
  label,
  checked,
  defaultChecked,
  onCheckedChange,
  indeterminate = false,
  disabled = false,
  description,
  className,
  id: idProp,
}: CheckboxProps): React.ReactElement {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultChecked ?? false);
  const isChecked = checked ?? uncontrolled;

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const classes = ["ak-choice", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <input
        ref={inputRef}
        id={id}
        type="checkbox"
        className="ak-choice__control"
        checked={isChecked}
        disabled={disabled}
        aria-describedby={descriptionId}
        aria-checked={indeterminate ? "mixed" : isChecked}
        onChange={event => {
          const next = event.target.checked;
          event.target.indeterminate = indeterminate;
          if (checked === undefined) setUncontrolled(next);
          onCheckedChange?.(next);
        }}
      />
      <label className="ak-choice__label" htmlFor={id}>
        {label}
      </label>
      {description ? (
        <p className="ak-choice__description" id={descriptionId}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** Вспомогательный текст под подписью. */
  description?: string;
}

export interface RadioGroupProps {
  /** Подпись группы (legend). */
  label: string;
  options: RadioOption[];
  /** Выбранное значение. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Направление навигации стрелками. */
  orientation?: "vertical" | "horizontal" | "both";
  disabled?: boolean;
  className?: string;
}

/**
 * RadioGroup. Роль `radiogroup` внутри fieldset/legend, roving tabindex:
 * в табуляции только выбранный (или первый) пункт, стрелки перемещают выбор.
 * Общий механизм — useRovingTabindex (его переиспользуют пикер акцента и RolePickerDialog).
 */
export function RadioGroup({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  orientation = "vertical",
  disabled = false,
  className,
}: RadioGroupProps): React.ReactElement {
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? options.find(option => !option.disabled)?.value ?? "");
  const current = value ?? uncontrolled;
  const selectedIndex = options.findIndex(option => option.value === current && !option.disabled);
  const select = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const pendingFocus = useRef<number | null>(null);
  const roving = useRovingTabindex({
    count: options.length,
    orientation,
    isDisabled: index => Boolean(options[index]?.disabled) || disabled,
    onActiveIndexChange: index => {
      pendingFocus.current = index;
    },
  });
  // Внешняя смена выбора (например, из props) двигает roving-фокус следом.
  useEffect(() => {
    if (selectedIndex >= 0) roving.setActiveIndex(selectedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);
  const groupId = useId();

  const classes = ["ak-choice-group", `ak-choice-group--${orientation}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <fieldset className={classes} disabled={disabled}>
      <legend className="ak-choice-group__legend" id={`${groupId}-legend`}>
        {label}
      </legend>
      <div className="ak-choice-group__items" role="radiogroup" aria-labelledby={`${groupId}-legend`}>
        {options.map((option, index) => {
          const checked = option.value === current;
          const optionId = `${groupId}-${option.value}`;
          return (
            <div className="ak-choice" key={option.value}>
              <input
                id={optionId}
                type="radio"
                className="ak-choice__control ak-choice__control--radio"
                name={groupId}
                value={option.value}
                checked={checked}
                disabled={disabled || option.disabled}
                role="radio"
                aria-checked={checked}
                tabIndex={roving.tabIndexFor(index)}
                onChange={() => select(option.value)}
                ref={element => { inputs.current[index] = element; }}
                onFocus={() => roving.setActiveIndex(index)}
                onKeyDown={event => {
                  pendingFocus.current = null;
                  roving.onKeyDown(index)(event);
                  const next = pendingFocus.current;
                  pendingFocus.current = null;
                  if (next !== null) {
                    const option = options[next];
                    if (option && option.value !== current) select(option.value);
                    if (next !== index) inputs.current[next]?.focus();
                  }
                }}
              />
              <label className="ak-choice__label" htmlFor={optionId}>
                {option.label}
              </label>
              {option.description ? (
                <p className="ak-choice__description">{option.description}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface RadioProps {
  label: ReactNode;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * Radio. Одиночный переключатель (роль `radio`, aria-checked).
 * Обычно применяется внутри RadioGroup, который владеет roving tabindex.
 */
export function Radio({
  label,
  value,
  checked,
  onChange,
  name,
  disabled = false,
  className,
  id: idProp,
}: RadioProps): React.ReactElement {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const classes = ["ak-choice", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <input
        id={id}
        type="radio"
        className="ak-choice__control ak-choice__control--radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        role="radio"
        aria-checked={checked}
        onChange={() => onChange(value)}
      />
      <label className="ak-choice__label" htmlFor={id}>
        {label}
      </label>
    </div>
  );
}
