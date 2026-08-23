import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type AgentGrant, type AgentGrantCapability, type AgentGrantOption, type AgentGrantScope,
  type AgentProposal, type CreateAgentGrantRequest } from "@stash/domain-types";
import { createAgentGrantRequest } from "@stash/validation";
export type { AgentGrant, AgentGrantOption, AgentGrantScope, AgentProposal } from "@stash/domain-types";
export interface StoredAgentGrant extends AgentGrant { tokenLookup: string; tokenHash: string }

export interface AgentGrantRepository {
  createAgentGrant(actorId: string, grant: StoredAgentGrant): Promise<"created" | "forbidden">;
  listAgentGrants(actorId: string, organizationId: string): Promise<AgentGrant[] | undefined>;
  revokeAgentGrant(actorId: string, organizationId: string, grantId: string): Promise<"revoked" | "not_found" | "forbidden">;
  findActiveAgentGrant(tokenLookup: string): Promise<StoredAgentGrant | undefined>;
  agentGrantOptions(actorId: string): Promise<AgentGrantOption[]>;
  createAgentProposal(proposal: AgentProposal): Promise<void>;
  listAgentProposals(actorId: string, organizationId: string): Promise<AgentProposal[] | undefined>;
  agentGrantTargetAllowed(grant: AgentGrant, target: { workspaceId?: string; projectId?: string }): Promise<boolean>;
}

export class InvalidAgentGrantInput extends Error {}

export class AgentGrantService {
  constructor(private readonly repository: AgentGrantRepository, private readonly now = () => new Date()) {}

  async create(actorId: string, input: unknown, expectedOrganizationId?: string): Promise<{ status: "created"; grant: AgentGrant; token: string } | { status: "forbidden" }> {
    const parsed = createAgentGrantRequest(input); if (!parsed.ok || !parsed.value || expectedOrganizationId && parsed.value.organizationId !== expectedOrganizationId) throw new InvalidAgentGrantInput();
    const validInput: CreateAgentGrantRequest = parsed.value; const expiresAt = new Date(validInput.expiresAt);
    if (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= this.now() || expiresAt.valueOf() > this.now().valueOf() + 90 * 86_400_000) throw new InvalidAgentGrantInput();
    const secret = randomBytes(32).toString("base64url");
    const tokenLookup = randomBytes(12).toString("base64url");
    const token = `stash_agent_${tokenLookup}.${secret}`;
    const grant: StoredAgentGrant = { id: randomUUID(), organizationId: validInput.organizationId, sponsoringMemberId: actorId,
      name: validInput.name, ...(validInput.projectId ? { projectId: validInput.projectId } : {}), scopes: [...validInput.scopes],
      expiresAt: expiresAt.toISOString(), createdAt: this.now().toISOString(), tokenLookup, tokenHash: hashSecret(secret) };
    const status = await this.repository.createAgentGrant(actorId, grant);
    if (status === "forbidden") return { status };
    return { status: "created", grant: publicGrant(grant), token };
  }

  async list(actorId: string, organizationId: string) {
    if (!isUuid(organizationId)) throw new InvalidAgentGrantInput();
    return this.repository.listAgentGrants(actorId, organizationId);
  }

  options(actorId: string) { return this.repository.agentGrantOptions(actorId); }

  proposals(actorId: string, organizationId: string) { if (!isUuid(organizationId)) throw new InvalidAgentGrantInput(); return this.repository.listAgentProposals(actorId, organizationId); }

  async propose(grant: AgentGrant, capability: AgentGrantCapability, input: unknown): Promise<AgentProposal> {
    const proposal: AgentProposal = { id: randomUUID(), grantId: grant.id, sponsoringMemberId: grant.sponsoringMemberId,
      capability, input, createdAt: this.now().toISOString(), status: "pending" };
    await this.repository.createAgentProposal(proposal); return proposal;
  }
  authorizeTarget(grant: AgentGrant, target: { workspaceId?: string; projectId?: string }) { return this.repository.agentGrantTargetAllowed(grant, target); }

  async revoke(actorId: string, organizationId: string, grantId: string) {
    if (!isUuid(organizationId) || !isUuid(grantId)) throw new InvalidAgentGrantInput();
    return this.repository.revokeAgentGrant(actorId, organizationId, grantId);
  }

  async authenticate(token: string | undefined): Promise<AgentGrant | undefined> {
    const match = /^stash_agent_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
    if (!match) return undefined;
    const stored = await this.repository.findActiveAgentGrant(match[1]!);
    if (!stored || new Date(stored.expiresAt) <= this.now()) return undefined;
    const expected = Buffer.from(stored.tokenHash, "hex"); const actual = Buffer.from(hashSecret(match[2]!), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? publicGrant(stored) : undefined;
  }
}

function publicGrant({ tokenLookup: _lookup, tokenHash: _hash, ...grant }: StoredAgentGrant): AgentGrant { return grant; }
function hashSecret(secret: string): string { return createHash("sha256").update(secret).digest("hex"); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
