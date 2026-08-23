import { useQuery } from "@tanstack/react-query";
import type { SessionState } from "./app-shell";

interface StoredSession {
  readonly token: string;
  readonly member: { readonly name: string; readonly email: string };
  readonly workspace?: { readonly name: string };
}

const storageKey = "stash.member-session";

function readStoredSession(): StoredSession | undefined {
  try {
    const value = window.localStorage.getItem(storageKey);
    if (!value) return undefined;
    const session = JSON.parse(value) as Partial<StoredSession>;
    if (typeof session.token !== "string" || !session.token || typeof session.member?.name !== "string" || typeof session.member.email !== "string") return undefined;
    return { token: session.token, member: session.member, ...(session.workspace?.name ? { workspace: session.workspace } : {}) };
  } catch { return undefined; }
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
      return "authenticated" as const;
    },
  });
  if (!stored || query.data === "anonymous") return { status: "anonymous" };
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "error", message: "The Instance could not be reached.", retry: () => { void query.refetch(); } };
  return { status: "authenticated", member: stored.member, workspace: stored.workspace ?? { name: "Personal workspace" } };
}
