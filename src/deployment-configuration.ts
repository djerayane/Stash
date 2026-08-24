export const developmentAdminToken = "stash-development-only-admin-token";
export const developmentMasterKey = "c3Rhc2gtbG9jYWwtZGV2ZWxvcG1lbnQta2V5LTAwMDA=";

export function validateComposeExposure(values: NodeJS.ProcessEnv): void {
  const bindAddress = values.STASH_BIND_ADDRESS?.trim() || "127.0.0.1";
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const usesDevelopmentCredential = values.INSTANCE_ADMIN_TOKEN?.trim() === developmentAdminToken
    || values.INSTANCE_MASTER_KEY?.trim() === developmentMasterKey;
  if (usesDevelopmentCredential && !loopback.has(bindAddress)) {
    throw new Error("development-only credentials cannot be used with non-loopback STASH_BIND_ADDRESS; configure unique Instance secrets before external exposure");
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
