import { useId } from "react";
import type { InputHTMLAttributes } from "react";
import { IconButton } from "./IconButton.js";
import { IconClose, IconSearch } from "./icons.js";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * SearchInput. Иконка поиска слева, кнопка очистки справа (хит-область 24px).
 */
export function SearchInput({
  value,
  onValueChange,
  label,
  placeholder = "Search…",
  disabled = false,
  ...rest
}: SearchInputProps): React.ReactElement {
  const id = useId();
  return (
    <div className="ak-search">
      <IconSearch size={14} className="ak-search__icon" />
      <input
        {...rest}
        id={id}
        type="search"
        className="ak-control"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {value ? (
        <IconButton
          label="Clear"
          disabled={disabled}
          icon={<IconClose size={12} />}
          className="ak-search__clear"
          onClick={() => onValueChange("")}
        />
      ) : null}
    </div>
  );
}
