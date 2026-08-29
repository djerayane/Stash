export type NativeActionVariant = "primary" | "secondary" | "danger";

export interface NativeToggleProps {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
}

export interface NativeActionButtonProps {
  label: string;
  variant?: NativeActionVariant;
  disabled?: boolean;
  onPress(): void;
}
