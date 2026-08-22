import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

interface ResolvedAddress { address: string; family: number }

interface OidcHttpClientOptions {
  allowUnsafeForTest?: (url: URL) => boolean;
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface OidcHttpClient {
  getJson(url: string): Promise<unknown>;
  postForm(url: string, body: URLSearchParams): Promise<unknown>;
  validateUrl(url: string): Promise<void>;
}

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicIpv4.addSubnet(network, prefix, "ipv4");

const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) nonPublicIpv6.addSubnet(network, prefix, "ipv6");

export function isPublicOidcAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (isIP(normalized) === 6 && normalized.startsWith("::ffff:")) {
    const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const hexadecimal = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const mapped = dotted ?? (hexadecimal
      ? `${Number.parseInt(hexadecimal[1]!, 16) >> 8}.${Number.parseInt(hexadecimal[1]!, 16) & 255}.${Number.parseInt(hexadecimal[2]!, 16) >> 8}.${Number.parseInt(hexadecimal[2]!, 16) & 255}`
      : undefined);
    return mapped ? isPublicOidcAddress(mapped) : false;
  }
  if (isIP(normalized) === 6) {
    return /^[23]/.test(normalized) && !nonPublicIpv6.check(normalized, "ipv6");
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  return !!ipv4 && !nonPublicIpv4.check(ipv4, "ipv4");
}

export function createOidcHttpClient(options: OidcHttpClientOptions = {}): OidcHttpClient {
  const resolve = options.resolve ?? (async (hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;

  async function resolveAllowed(url: URL): Promise<ResolvedAddress> {
    const testException = options.allowUnsafeForTest?.(url) === true;
    if (url.username || url.password || (url.protocol !== "https:" && !(testException && url.protocol === "http:"))) {
      throw new Error("OIDC URL is not allowed");
    }
    const addresses = await resolve(url.hostname);
    if (!addresses.length || addresses.some(({ address }) => !isIP(address)
      || (!testException && !isPublicOidcAddress(address)))) throw new Error("OIDC address is not allowed");
    return addresses[0]!;
  }

  async function requestJson(urlValue: string, method: "GET" | "POST", body?: URLSearchParams, redirects = 0): Promise<unknown> {
    const url = new URL(urlValue);
    const resolved = await resolveAllowed(url);
    return new Promise<unknown>((resolveResponse, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body.toString()) } : {}),
        },
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
      }, (response) => {
        const location = response.headers.location;
        if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          if (method === "POST") return reject(new Error("OIDC token endpoint redirects are not allowed"));
          if (redirects >= 3) return reject(new Error("too many OIDC redirects"));
          requestJson(new URL(location, url).toString(), method, body, redirects + 1).then(resolveResponse, reject);
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error("OIDC endpoint rejected request"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) response.destroy(new Error("OIDC response is too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try { resolveResponse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new Error("OIDC response is not valid JSON")); }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("OIDC request timed out")));
      request.on("error", reject);
      if (body) request.write(body.toString());
      request.end();
    });
  }

  return {
    getJson: (url) => requestJson(url, "GET"),
    postForm: (url, body) => requestJson(url, "POST", body),
    async validateUrl(url) { await resolveAllowed(new URL(url)); },
  };
}
