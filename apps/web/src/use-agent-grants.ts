import { createAgentGrantsApi } from "@stash/api-client";
import type { CreateAgentGrantRequest } from "@stash/domain-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useAgentGrants(token: string | undefined, organizationId: string) {
  const client = createAgentGrantsApi({ baseUrl: "", ...(token ? { memberToken: token } : {}) }); const cache = useQueryClient();
  const options = useQuery({ queryKey: ["agent-grant-options"], enabled: Boolean(token), retry: false, queryFn: () => client.options() });
  const grants = useQuery({ queryKey: ["agent-grants", organizationId], enabled: Boolean(token && organizationId), retry: false, queryFn: () => client.list(organizationId) });
  const proposals = useQuery({ queryKey: ["agent-proposals", organizationId], enabled: Boolean(token && organizationId), retry: false, queryFn: () => client.proposals(organizationId) });
  const create = useMutation({ mutationFn: (input: CreateAgentGrantRequest) => client.create(input), onSuccess: async () => {
    await Promise.all([cache.invalidateQueries({ queryKey: ["agent-grants", organizationId] }), cache.invalidateQueries({ queryKey: ["agent-proposals", organizationId] })]);
  } });
  const revoke = useMutation({ mutationFn: (id: string) => client.revoke(organizationId, id), onSuccess: async () => cache.invalidateQueries({ queryKey: ["agent-grants", organizationId] }) });
  return { options, grants, proposals, create, revoke };
}
