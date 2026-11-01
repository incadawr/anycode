/**
 * AnyCode UI-kit — публичный API.
 * Все компоненты presentational: без Electron, без API AnyCode, без state-менеджеров.
 */
export { Button } from "./components/Button.js";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/Button.js";

export { IconButton } from "./components/IconButton.js";
export type { IconButtonProps } from "./components/IconButton.js";

export { Chip, ACCESS_MODE_LABEL } from "./components/Chip.js";
export type { ChipProps, AccessMode } from "./components/Chip.js";

export { Badge } from "./components/Badge.js";
export type { BadgeProps, BadgeStatus } from "./components/Badge.js";

export { Field, Input, Select, Textarea } from "./components/Field.js";
export type {
  FieldProps,
  InputProps,
  SelectProps,
  SelectOption,
  TextareaProps,
} from "./components/Field.js";

export { Switch } from "./components/Switch.js";
export type { SwitchProps } from "./components/Switch.js";

export { SegmentedControl } from "./components/SegmentedControl.js";
export type {
  SegmentedControlProps,
  SegmentedOption,
  SingleSegmentedControlProps,
  MultiSegmentedControlProps,
} from "./components/SegmentedControl.js";

export { ToolCard } from "./components/ToolCard.js";
export type { ToolCardProps } from "./components/ToolCard.js";

export { Modal } from "./components/Modal.js";
export type { ModalProps } from "./components/Modal.js";

export { Drawer } from "./components/Drawer.js";
export type { DrawerProps } from "./components/Drawer.js";

export { Toast, ToastStack } from "./components/Toast.js";
export type { ToastProps, ToastStatus, ToastStackProps } from "./components/Toast.js";

export { EmptyState } from "./components/EmptyState.js";
export type { EmptyStateProps } from "./components/EmptyState.js";

export { Banner } from "./components/Banner.js";
export type { BannerProps, BannerTone } from "./components/Banner.js";

export { ContextRing } from "./components/ContextRing.js";
export type { ContextRingProps } from "./components/ContextRing.js";

export { Popover, MenuItem, MenuSeparator } from "./components/Popover.js";
export type { PopoverProps, PopoverPosition, MenuItemProps } from "./components/Popover.js";

export { SearchInput } from "./components/SearchInput.js";
export type { SearchInputProps } from "./components/SearchInput.js";

export * from "./components/icons.js";
