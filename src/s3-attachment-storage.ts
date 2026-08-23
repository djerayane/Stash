import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { AttachmentStorage } from "./attachments.js";

function storageKey(key: string): string { if (!/^[0-9a-f-]+\/[0-9a-f-]+$/i.test(key)) throw new Error("invalid_storage_key"); return key; }
function prefix(value: string): string { const normalized = value.replace(/^\/+|\/+$/g, ""); return normalized ? `${normalized}/` : ""; }

export interface S3AttachmentStorageOptions {
  bucket: string; prefix?: string; client?: { send(command: object): Promise<any> };
  endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean;
}
export class S3AttachmentStorage implements AttachmentStorage {
  readonly #client: { send(command: object): Promise<any> }; readonly #bucket: string; readonly #prefix: string;
  constructor(options: S3AttachmentStorageOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("S3_BUCKET must be a valid bucket name");
    this.#bucket = options.bucket; this.#prefix = prefix(options.prefix ?? "");
    if (options.client) this.#client = options.client;
    else { const config: S3ClientConfig = { ...(options.region ? { region: options.region } : {}), ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      ...(options.accessKeyId && options.secretAccessKey ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } } : {}) };
      this.#client = new S3Client(config); }
  }
  #key(key: string) { return `${this.#prefix}${storageKey(key)}`; }
  async put(key: string, content: Buffer): Promise<void> { await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: this.#key(key), Body: content, ContentLength: content.length })); }
  async get(key: string): Promise<Buffer> { return this.getBounded(key, Number.MAX_SAFE_INTEGER); }
  async getBounded(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("attachment_size_limit");
    const result = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }));
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes) throw new Error("attachment_size_limit");
    if (!result.Body) throw new Error("attachment_missing_body");
    if (typeof result.Body[Symbol.asyncIterator] !== "function") throw new Error("attachment_body_not_streaming");
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > maxBytes) throw new Error("attachment_size_limit");
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (typeof result.Body.destroy === "function") result.Body.destroy();
      throw error;
    }
  }
  async delete(key: string): Promise<void> { await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) })); }
  async listKeys(): Promise<ReadonlyArray<string>> {
    const keys: string[] = []; let continuationToken: string | undefined;
    do { const result = await this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: this.#prefix, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }));
      for (const item of result.Contents ?? []) if (item.Key?.startsWith(this.#prefix)) { const key = item.Key.slice(this.#prefix.length); storageKey(key); keys.push(key); }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
  }
}

export function s3AttachmentStorageFromEnvironment(environment: NodeJS.ProcessEnv): S3AttachmentStorage | undefined {
  const names = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  const values = Object.fromEntries(names.map((name) => [name, environment[name]?.trim()])); const configured = names.filter((name) => values[name]);
  if (configured.length === 0) return undefined;
  if (configured.length !== names.length) throw new Error(`${names.filter((name) => !values[name]).join(", ")} must be configured when S3 Attachment storage is enabled`);
  let endpoint: URL; try { endpoint = new URL(values.S3_ENDPOINT!); } catch { throw new Error("S3_ENDPOINT must be an absolute HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("S3_ENDPOINT must be an absolute HTTP or HTTPS URL without credentials, query, or fragment");
  return new S3AttachmentStorage({ endpoint: endpoint.toString().replace(/\/$/, ""), region: values.S3_REGION!, bucket: values.S3_BUCKET!, accessKeyId: values.S3_ACCESS_KEY_ID!, secretAccessKey: values.S3_SECRET_ACCESS_KEY!,
    ...(environment.S3_PREFIX?.trim() ? { prefix: environment.S3_PREFIX.trim() } : {}),
    forcePathStyle: environment.S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== "false" });
}
