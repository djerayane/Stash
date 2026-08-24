export const developmentAdminToken = "stash-development-only-admin-token";
export const developmentMasterKey = "c3Rhc2gtbG9jYWwtZGV2ZWxvcG1lbnQta2V5LTAwMDA=";
export const developmentPostgresPassword = "stash-development-only";
export const developmentPublicOrigin = "http://localhost:3000";

function isCanonicalExternalHttpsOrigin(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const raw = value.trim();
  let origin: URL;
  try { origin = new URL(raw); } catch { return false; }
  const hostname = origin.hostname.toLowerCase();
  const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const usableHost = hostname !== "localhost" && !hostname.endsWith(".localhost")
    && (isIP(address) === 0 || isPublicIpAddress(address));
  return origin.protocol === "https:" && usableHost && !origin.username && !origin.password
    && origin.origin === raw.replace(/\/$/, "");
}

function isPublicIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function ipv6Value(address: string): bigint {
  const [head = "", tail = ""] = address.split("::");
  const expand = (part: string): string[] => part ? part.split(":") : [];
  const headGroups = expand(head);
  const tailGroups = expand(tail);
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = address.includes("::")
    ? [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups]
    : headGroups;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  const top8 = Number(value >> 120n);
  const top16 = Number(value >> 112n);
  const top32 = Number(value >> 96n);
  const top64 = value >> 64n;
  const top96 = value >> 32n;
  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) {
    const ipv4 = Number(value & 0xffff_ffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  return !(value === 0n || value === 1n || value >> 32n === 0n
    || top8 === 0xfc || top8 === 0xfd || top8 === 0xff
    || (top16 & 0xffc0) === 0xfe80 || (top16 & 0xffc0) === 0xfec0
    || top32 === 0x2001_0db8 || top64 === 0x0100_0000_0000_0000n
    || top96 === 0x0064_ff9b_0000_0000_0000_0000n || top32 === 0x2001_0000
    || top16 === 0x2002);
}

function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isPublicIpv4(address) : version === 6 && isPublicIpv6(address);
}

export function validateComposeExposure(values: NodeJS.ProcessEnv): void {
  const bindAddress = values.STASH_BIND_ADDRESS?.trim() || "127.0.0.1";
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopback.has(bindAddress)) {
    const insecure = !values.INSTANCE_ADMIN_TOKEN?.trim()
      || values.INSTANCE_ADMIN_TOKEN.trim() === developmentAdminToken
      || !values.INSTANCE_MASTER_KEY?.trim()
      || values.INSTANCE_MASTER_KEY.trim() === developmentMasterKey
      || !values.POSTGRES_PASSWORD?.trim()
      || values.POSTGRES_PASSWORD.trim().length < 16
      || values.POSTGRES_PASSWORD.trim() === developmentPostgresPassword
      || !isCanonicalExternalHttpsOrigin(values.PUBLIC_ORIGIN);
    if (insecure) {
      throw new Error("non-loopback STASH_BIND_ADDRESS requires unique secrets, a PostgreSQL password of at least 16 characters, and a canonical HTTPS PUBLIC_ORIGIN");
    }
  }
}

export function databaseUrlFromEnvironment(values: NodeJS.ProcessEnv): string {
  if (values.DATABASE_URL?.trim()) return values.DATABASE_URL.trim();
  const required = (name: string): string => {
    const value = values[name];
    if (!value) throw new Error(`${name} must be configured when DATABASE_URL is absent`);
    return value;
  };
  const user = encodeURIComponent(required("POSTGRES_USER"));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD"));
  const host = required("POSTGRES_HOST").trim();
  const port = required("POSTGRES_PORT").trim();
  const database = encodeURIComponent(required("POSTGRES_DB"));
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}
import { isIP } from "node:net";
