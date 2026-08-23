export async function responseMessage(response: Response, fallback: string) {
  try { const body = await response.json() as { message?: unknown }; return typeof body.message === "string" ? body.message : fallback; }
  catch { return fallback; }
}

export async function authenticatedJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) throw new Error(await responseMessage(response, "The operation could not be completed. No changes were saved."));
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
