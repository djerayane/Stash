import { describe, expect, it } from "vitest";

import { decodeBase64 } from "./native-crypto-format";

describe("native crypto persistence format", () => {
  it("decodes persisted base64 ciphertext for the native AES bridge", () => {
    expect(Array.from(decodeBase64("AAECA/7/"))).toEqual([0, 1, 2, 3, 254, 255]);
  });
});
