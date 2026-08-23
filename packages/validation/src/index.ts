export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly message?: string;
}

export function nonEmptyText(value: unknown, label = "Value"): ValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: `${label} is required` };
  return { ok: true, value: value.trim() };
}
