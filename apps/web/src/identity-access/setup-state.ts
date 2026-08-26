import { useQuery } from "@tanstack/react-query";

import type { SetupAvailability } from "./setup-page";

export type InstanceSetupState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string; readonly retry?: () => void }
  | { readonly status: "ready"; readonly state: SetupAvailability | "complete" };

const setupStates = new Set<SetupAvailability | "complete">(["available-local", "code-required", "complete"]);

async function loadSetupState(fetcher: typeof fetch): Promise<SetupAvailability | "complete"> {
  const response = await fetcher("/api/instance/setup-state");
  const body = await response.json().catch(() => ({})) as { state?: unknown; message?: string };
  if (!response.ok || typeof body.state !== "string" || !setupStates.has(body.state as SetupAvailability | "complete")) {
    throw new Error(body.message || "Instance setup state is unavailable.");
  }
  return body.state as SetupAvailability | "complete";
}

export function useInstanceSetupState(fetcher: typeof fetch = fetch): InstanceSetupState {
  const query = useQuery({ queryKey: ["instance-setup-state"], retry: false, queryFn: () => loadSetupState(fetcher) });
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "error", message: query.error.message, retry: () => void query.refetch() };
  return { status: "ready", state: query.data };
}
