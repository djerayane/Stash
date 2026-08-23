import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const agentGrantModes = ["direct", "propose", "deny"] as const;
export type AgentGrantMode = (typeof agentGrantModes)[number];

export interface AgentGrantScope { capability: string; mode: AgentGrantMode }
export interface AgentGrant {
  id: string; organizationId: string; sponsoringMemberId: string; name: string;
  projectId?: string; scopes: AgentGrantScope[]; expiresAt: string; createdAt: string; revokedAt?: string;
}
export interface StoredAgentGrant extends AgentGrant { tokenLookup: string; tokenHash: string }

export interface AgentGrantRepository {
  createAgentGrant(actorId: string, grant: StoredAgentGrant): Promise<"created" | "forbidden">;
  listAgentGrants(actorId: string, organizationId: string): Promise<AgentGrant[] | undefined>;
  revokeAgentGrant(actorId: string, organizationId: string, grantId: string): Promise<"revoked" | "not_found" | "forbidden">;
  findActiveAgentGrant(tokenLookup: string): Promise<StoredAgentGrant | undefined>;
}

export class InvalidAgentGrantInput extends Error {}

export class AgentGrantService {
  constructor(private readonly repository: AgentGrantRepository, private readonly now = () => new Date()) {}

  async create(actorId: string, input: unknown): Promise<{ status: "created"; grant: AgentGrant; token: string } | { status: "forbidden" }> {
    if (!isCreateInput(input)) throw new InvalidAgentGrantInput();
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= this.now() || expiresAt.valueOf() > this.now().valueOf() + 90 * 86_400_000) throw new InvalidAgentGrantInput();
    const secret = randomBytes(32).toString("base64url");
    const tokenLookup = randomBytes(12).toString("base64url");
    const token = `stash_agent_${tokenLookup}.${secret}`;
    const grant: StoredAgentGrant = { id: randomUUID(), organizationId: input.organizationId, sponsoringMemberId: actorId,
      name: input.name.trim(), ...(input.projectId ? { projectId: input.projectId } : {}), scopes: input.scopes,
      expiresAt: expiresAt.toISOString(), createdAt: this.now().toISOString(), tokenLookup, tokenHash: hashSecret(secret) };
    const status = await this.repository.createAgentGrant(actorId, grant);
    if (status === "forbidden") return { status };
    return { status: "created", grant: publicGrant(grant), token };
  }

  async list(actorId: string, organizationId: string) {
    if (!isUuid(organizationId)) throw new InvalidAgentGrantInput();
    return this.repository.listAgentGrants(actorId, organizationId);
  }

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
function isCreateInput(value: unknown): value is { organizationId: string; projectId?: string; name: string; scopes: AgentGrantScope[]; expiresAt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>; const keys = Object.keys(input);
  return keys.every((key) => ["organizationId", "projectId", "name", "scopes", "expiresAt"].includes(key))
    && isUuid(input.organizationId) && (input.projectId === undefined || isUuid(input.projectId))
    && typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 80
    && typeof input.expiresAt === "string" && Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.length <= 20
    && input.scopes.every((scope) => scope && typeof scope === "object" && !Array.isArray(scope)
      && Object.keys(scope).length === 2 && typeof (scope as AgentGrantScope).capability === "string"
      && /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test((scope as AgentGrantScope).capability)
      && agentGrantModes.includes((scope as AgentGrantScope).mode));
}
