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
  const canonicalDnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(hostname);
  return origin.protocol === "https:" && canonicalDnsName && !origin.username && !origin.password
    && origin.origin === raw.replace(/\/$/, "");
}

function isStrongPostgresPassword(value: string | undefined): boolean {
  const password = value?.trim() ?? "";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter((pattern) => pattern.test(password)).length;
  return password.length >= 16 && classes >= 3 && password !== developmentPostgresPassword;
}

export function validateComposeExposure(values: NodeJS.ProcessEnv): void {
  const bindAddress = values.STASH_BIND_ADDRESS?.trim() || "127.0.0.1";
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopback.has(bindAddress)) {
    const insecure = !values.INSTANCE_ADMIN_TOKEN?.trim()
      || values.INSTANCE_ADMIN_TOKEN.trim() === developmentAdminToken
      || !values.INSTANCE_MASTER_KEY?.trim()
      || values.INSTANCE_MASTER_KEY.trim() === developmentMasterKey
      || !isStrongPostgresPassword(values.POSTGRES_PASSWORD)
      || !isCanonicalExternalHttpsOrigin(values.PUBLIC_ORIGIN);
    if (insecure) {
      throw new Error("non-loopback STASH_BIND_ADDRESS requires unique secrets, a PostgreSQL password of at least 16 characters using three character classes, and a canonical HTTPS DNS PUBLIC_ORIGIN");
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
