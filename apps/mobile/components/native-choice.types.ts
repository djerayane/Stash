export type NativeChoiceProps = {
  label: string;
  value?: string;
  items: { value: string; label: string }[];
  onChange: (value?: string) => void;
};
