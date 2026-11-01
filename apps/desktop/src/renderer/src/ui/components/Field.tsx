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
 */
export function Field({
  label,
  hint,
  hintTone = "muted",
  error,
  required = false,
  children,
}: FieldProps): React.ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

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
      ) : hint ? (
        <p className={hintClass} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
  /** Моноширинный ввод (идентификаторы, пути, команды). */
  mono?: boolean;
}

export function Input({
  label,
  hint,
  hintTone,
  error,
  mono = false,
  required,
  ...rest
}: InputProps): React.ReactElement {
  return (
    <Field label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <input
          {...p}
          {...rest}
          className={["ak-control", mono ? "ak-control--mono" : "", rest.className ?? ""]
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

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> {
  label: string;
  options: SelectOption[];
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
}

export function Select({
  label,
  options,
  hint,
  hintTone,
  error,
  required,
  ...rest
}: SelectProps): React.ReactElement {
  return (
    <Field label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <select {...p} {...rest} className={["ak-control", "ak-select", rest.className ?? ""].filter(Boolean).join(" ")}>
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
  hint?: ReactNode;
  hintTone?: "muted" | "warn" | "error";
  error?: string;
}

export function Textarea({
  label,
  hint,
  hintTone,
  error,
  required,
  ...rest
}: TextareaProps): React.ReactElement {
  return (
    <Field label={label} hint={hint} hintTone={hintTone} error={error} required={required}>
      {(p) => (
        <textarea
          {...p}
          {...rest}
          className={["ak-control", "ak-textarea", rest.className ?? ""].filter(Boolean).join(" ")}
        />
      )}
    </Field>
  );
}
