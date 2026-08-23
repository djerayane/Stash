import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type AgentGrant, type AgentGrantCapability, type AgentGrantOption, type AgentGrantScope,
  type AgentProposal, type CreateAgentGrantRequest, type ReviewAgentProposalRequest, type ReviewAgentProposalResponse } from "@stash/domain-types";
import { createAgentGrantRequest } from "@stash/validation";
import type { NoteService } from "./notes.js";
import type { TaskService } from "./tasks.js";
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
  findAgentProposal(actorId: string, organizationId: string, proposalId: string): Promise<AgentProposal | "forbidden" | undefined>;
  claimAgentProposal(actorId: string, organizationId: string, proposalId: string, operationId: string): Promise<{ status: "claimed" | "duplicate" | "in_progress" | "already_reviewed"; proposal: AgentProposal } | { status: "forbidden" | "not_found" }>;
  finishAgentProposal(actorId: string, proposalId: string, operationId: string, update: Pick<AgentProposal, "status" | "reviewedAt" | "reviewedByMemberId" | "result" | "conflict">): Promise<AgentProposal>;
  releaseAgentProposal(actorId: string, proposalId: string, operationId: string): Promise<void>;
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

  async propose(grant: AgentGrant, capability: AgentGrantCapability, input: unknown, baseRevision?: number): Promise<AgentProposal> {
    const proposal: AgentProposal = { id: randomUUID(), grantId: grant.id, organizationId: grant.organizationId,
      sponsoringMemberId: grant.sponsoringMemberId, agentName: grant.name, ...(grant.projectId ? { projectId: grant.projectId } : {}),
      capability, input, ...(baseRevision ? { baseRevision } : {}), createdAt: this.now().toISOString(), status: "pending" };
    await this.repository.createAgentProposal(proposal); return proposal;
  }
  async proposal(actorId: string, organizationId: string, proposalId: string) {
    if (!isUuid(organizationId) || !isUuid(proposalId)) throw new InvalidAgentGrantInput();
    return this.repository.findAgentProposal(actorId, organizationId, proposalId);
  }
  async review(actorId: string, organizationId: string, proposalId: string, input: unknown,
    domain: { notes?: NoteService; tasks?: TaskService }): Promise<ReviewAgentProposalResponse | { status: "forbidden" | "not_found" | "already_reviewed" | "in_progress" }> {
    if (!isUuid(organizationId) || !isUuid(proposalId) || !validReview(input)) throw new InvalidAgentGrantInput();
    const request = input as ReviewAgentProposalRequest;
    const claimed = await this.repository.claimAgentProposal(actorId, organizationId, proposalId, request.operationId);
    if (!("proposal" in claimed)) return { status: claimed.status };
    if (claimed.status === "already_reviewed" || claimed.status === "in_progress") return { status: claimed.status };
    if (claimed.status === "duplicate") return { status: "duplicate", proposal: claimed.proposal };
    const proposal = claimed.proposal; const reviewedAt = this.now().toISOString();
    try {
      if (request.decision === "reject") return { status: "rejected", proposal: await this.repository.finishAgentProposal(actorId, proposal.id,
        request.operationId, { status: "rejected", reviewedAt, reviewedByMemberId: actorId }) };
      const args = proposal.input as any; const cause = { kind: "agent" as const, agentGrantId: proposal.grantId,
        sponsoringMemberId: proposal.sponsoringMemberId, agentName: proposal.agentName };
      if (request.decision === "keep_current" || request.decision === "apply_contribution") {
        if (proposal.status !== "applying" || proposal.capability !== "task.write" || !proposal.conflict || !domain.tasks) throw new InvalidAgentGrantInput();
        const resolved = await domain.tasks.resolveStructuredConflict(actorId, args.projectId, args.taskKey, proposal.conflict.id,
          { resolution: request.decision === "keep_current" ? "keep_current" : "apply_contribution", expectedRevision: proposal.conflict.currentRevision });
        if (resolved.status !== "resolved") throw new Error("proposal_conflict_changed");
        return { status: "applied", proposal: await this.repository.finishAgentProposal(actorId, proposal.id, request.operationId,
          { status: "applied", reviewedAt, reviewedByMemberId: actorId, result: resolved }) };
      }
      if (proposal.capability === "note.write" && domain.notes) {
        const result = await domain.notes.capture(actorId, args.workspaceId, { ...args.input, ...(args.projectId ? { projectId: args.projectId } : {}) }, cause);
        if (result.status !== "created") throw new Error("proposal_target_forbidden");
        return { status: "applied", proposal: await this.repository.finishAgentProposal(actorId, proposal.id, request.operationId,
          { status: "applied", reviewedAt, reviewedByMemberId: actorId, result }) };
      }
      if (proposal.capability === "task.write" && domain.tasks && proposal.baseRevision) {
        const result = await domain.tasks.applyProposedEdit(actorId, args.projectId, args.taskKey, request.operationId, proposal.baseRevision, args.input, cause);
        if (result.status === "conflict_preserved") return { status: "conflict", proposal: await this.repository.finishAgentProposal(actorId, proposal.id,
          request.operationId, { status: "conflict", reviewedAt, reviewedByMemberId: actorId, result,
            conflict: { id: result.conflict.id, fields: result.conflict.fields, currentRevision: result.conflict.currentRevision } }) };
        if (result.status !== "applied") throw new Error("proposal_target_unavailable");
        return { status: "applied", proposal: await this.repository.finishAgentProposal(actorId, proposal.id, request.operationId,
          { status: "applied", reviewedAt, reviewedByMemberId: actorId, result }) };
      }
      throw new InvalidAgentGrantInput();
    } catch (error) { await this.repository.releaseAgentProposal(actorId, proposal.id, request.operationId); throw error; }
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
function validReview(value: unknown): value is ReviewAgentProposalRequest { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; return Object.keys(item).length === 3 && isUuid(item.operationId)
    && ["apply", "reject", "keep_current", "apply_contribution"].includes(String(item.decision)) && item.confirmed === true; }
