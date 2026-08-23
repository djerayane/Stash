export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_DURATION_SECONDS = 5 * 60;

export interface ReadableFile {
  readonly size: number;
  base64(): Promise<string>;
}

export async function readBoundedOriginal(file: ReadableFile): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("The original file is empty or invalid.");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("The original file is larger than the 10 MB limit.");
  return file.base64();
}
