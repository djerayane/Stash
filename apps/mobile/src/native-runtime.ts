type DomExceptionConstructor = new (message?: string, name?: string) => Error;
type RuntimeWithDomException = { DOMException?: DomExceptionConstructor };
type RuntimeWithCrypto = { crypto?: { randomUUID?: () => string } };

export function ensureDomException(runtime: RuntimeWithDomException): void {
  if (runtime.DOMException) return;
  runtime.DOMException = class NativeDOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  };
}

export function ensureCryptoRandomUuid(runtime: RuntimeWithCrypto, createUuid: () => string): void {
  const runtimeCrypto = runtime.crypto ??= {};
  runtimeCrypto.randomUUID ??= createUuid;
}
