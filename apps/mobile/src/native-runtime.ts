type DomExceptionConstructor = new (message?: string, name?: string) => Error;
type RuntimeWithDomException = { DOMException?: DomExceptionConstructor };

export function ensureDomException(runtime: RuntimeWithDomException): void {
  if (runtime.DOMException) return;
  runtime.DOMException = class NativeDOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  };
}
