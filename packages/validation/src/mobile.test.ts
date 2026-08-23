import { describe, expect, it } from "vitest";
import { canonicalUuid, isUuid, validMobilePairingOrigin, validPortableFilename } from "./index.js";

describe("mobile contract validation", () => {
  it("validates portable names and canonical identifiers", () => {
    expect(validPortableFilename("capture.jpg")).toBe(true);
    expect(validPortableFilename("../capture.jpg")).toBe(false);
    expect(isUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(true);
    expect(canonicalUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("accepts only credential-free HTTPS origins by default", () => {
    expect(validMobilePairingOrigin("https://stash.example")).toBe(true);
    expect(validMobilePairingOrigin("https://stash.example/path")).toBe(false);
    expect(validMobilePairingOrigin("http://stash.example")).toBe(false);
  });
});
