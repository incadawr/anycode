import { useId } from "react";
import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export interface FieldProps {
  label: string;
  /** Подсказка под полем. Показывать только для ошибки/предупреждения/статуса, меняющего поведение. */
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  /** Ошибка: ставит aria-invalid и связывает через aria-describedby. */
  error?: string;
  required?: boolean;
  /** Идентификатор поля; по умолчанию — из useId. Связь label↔control. */
  id?: string;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
    "aria-required": boolean | undefined;
  }) => ReactNode;
}

/**
 * Обёртка поля: подпись + контрол + подсказка.
 * Связь label↔control — через id (генерируется useId), ошибка — aria-describedby.
 * Подсказка и ошибка могут присутствовать одновременно: aria-describedby перечисляет оба id.
 * Ошибка рендерится ровно одним элементом с role="alert".
 */
export function Field({
  label,
  hint,
  hintTone = "muted",
  error,
  required = false,
  id: idProp,
  children,
}: FieldProps): React.ReactElement {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  const hintClass =
    hintTone === "error" ? "ak-field__hint ak-field__hint--error" :
    hintTone === "warn" ? "ak-field__hint ak-field__hint--warn" :
    "ak-field__hint";

  return (
    <div className="ak-field">
      <label className="ak-field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true">*</span> : null}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required || undefined,
      })}
      {error ? (
        <p className="ak-field__hint ak-field__hint--error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p className={hintClass} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "size"> {
  label: string;
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
  /** Компактное поле для плотных форм. */
  size?: "sm" | "md";
  /** Моноширинный ввод (идентификаторы, пути, команды). */
  mono?: boolean;
  /** Явный id поля; по умолчанию — из useId. */
  id?: string;
}

export function Input({
  label,
  hint,
  hintTone,
  error,
  mono = false,
  size = "md",
  required,
  id,
  ...rest
}: InputProps): React.ReactElement {
  return (
    <Field id={id} label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <input
          {...p}
          {...rest}
          className={["ak-control", size === "sm" ? "ak-control--sm" : "", mono ? "ak-control--mono" : "", rest.className ?? ""]
            .filter(Boolean)
            .join(" ")}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children" | "size"> {
  label: string;
  options: SelectOption[];
  size?: "sm" | "md";
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
  /** Явный id поля; по умолчанию — из useId. */
  id?: string;
}

export function Select({
  label,
  options,
  size = "md",
  hint,
  hintTone,
  error,
  required,
  id,
  ...rest
}: SelectProps): React.ReactElement {
  return (
    <Field id={id} label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <select {...p} {...rest} className={["ak-control", "ak-select", size === "sm" ? "ak-control--sm" : "", rest.className ?? ""].filter(Boolean).join(" ")}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  mono?: boolean;
  tall?: boolean;
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
  /** Явный id поля; по умолчанию — из useId. */
  id?: string;
}

export function Textarea({
  label,
  mono = false,
  tall = false,
  hint,
  hintTone,
  error,
  required,
  id,
  ...rest
}: TextareaProps): React.ReactElement {
  return (
    <Field id={id} label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <textarea
          {...p}
          {...rest}
          className={["ak-control", "ak-textarea", mono ? "ak-textarea--mono" : "", tall ? "ak-textarea--tall" : "", rest.className ?? ""].filter(Boolean).join(" ")}
        />
      )}
    </Field>
  );
}
