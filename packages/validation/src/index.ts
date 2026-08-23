export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly message?: string;
}

export function nonEmptyText(value: unknown, label = "Value"): ValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: `${label} is required` };
  return { ok: true, value: value.trim() };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function canonicalUuid(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

export function validPortableFilename(value: string): boolean {
  return Boolean(value && value.length <= 255 && value === value.trim() && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value) && value !== "." && value !== ".."
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
}

export function validMobilePairingOrigin(value: string, allowLoopbackHttp = false): boolean {
  try {
    const url = new URL(value);
    const loopback = allowLoopbackHttp && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    return (url.protocol === "https:" || loopback) && !url.username && !url.password
      && url.origin === url.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}
