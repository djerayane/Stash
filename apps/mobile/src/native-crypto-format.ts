export function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Stored encrypted state is not valid base64.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let target = 0;
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const encoded = chunk.split("").map((character) => character === "=" ? 0 : alphabet.indexOf(character));
    const combined = (encoded[0]! << 18) | (encoded[1]! << 12) | (encoded[2]! << 6) | encoded[3]!;
    if (target < bytes.length) bytes[target++] = combined >> 16;
    if (target < bytes.length) bytes[target++] = combined >> 8;
    if (target < bytes.length) bytes[target++] = combined;
  }
  return bytes;
}
