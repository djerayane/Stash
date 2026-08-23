import { useQuery } from "@tanstack/react-query";
import type { SessionState } from "./app-shell";

interface StoredSession {
  readonly token: string;
}

interface ClientSessionResponse {
  readonly authenticated: true;
  readonly member: { readonly id: string; readonly name: string; readonly email: string };
  readonly workspace: { readonly id: string; readonly name: string };
  readonly capabilities: readonly string[];
}

const storageKey = "stash.member-session";

function readStoredSession(): StoredSession | undefined {
  try {
    const value = window.localStorage.getItem(storageKey);
    if (!value) return undefined;
    const session = JSON.parse(value) as Partial<StoredSession>;
    if (typeof session.token !== "string" || !session.token) return undefined;
    return { token: session.token };
  } catch { return undefined; }
}

function isClientSessionResponse(value: unknown): value is ClientSessionResponse {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ClientSessionResponse>;
  return session.authenticated === true && typeof session.member?.id === "string" && typeof session.member.name === "string"
    && typeof session.member.email === "string" && typeof session.workspace?.id === "string"
    && typeof session.workspace.name === "string" && Array.isArray(session.capabilities)
    && session.capabilities.every((capability) => typeof capability === "string");
}

export function useSessionState(fetcher: typeof fetch = globalThis.fetch): SessionState {
  const stored = readStoredSession();
  const query = useQuery({
    queryKey: ["member-session", stored?.token],
    enabled: Boolean(stored),
    retry: false,
    queryFn: async () => {
      const response = await fetcher("/api/client-session", { headers: { authorization: `Bearer ${stored!.token}` } });
      if (response.status === 401) return "anonymous" as const;
      if (!response.ok) throw new Error("The Instance could not be reached.");
      const session: unknown = await response.json();
      if (!isClientSessionResponse(session)) throw new Error("Invalid Member session response.");
      return session;
    },
  });
  if (!stored || query.data === "anonymous") return { status: "anonymous" };
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "error", message: "The Instance could not be reached.", retry: () => { void query.refetch(); } };
  return { status: "authenticated", token: stored.token, member: query.data.member, workspace: query.data.workspace, capabilities: query.data.capabilities };
}
