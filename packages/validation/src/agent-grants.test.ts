import { describe, expect, it } from "vitest";
import { agentGrantListResponse, createAgentGrantRequest, revokeAgentGrantResponse } from "./index";
import { directAuthorityConfirmation } from "@stash/domain-types";

const request = { organizationId: "11111111-1111-4111-8111-111111111111", name: "Research agent", expiresAt: "2026-09-01T00:00:00.000Z", scopes: [{ capability: "note.write", mode: "propose" }] };
describe("Agent Grant validation", () => {
  it("accepts the shared request contract", () => expect(createAgentGrantRequest(request).ok).toBe(true));
  it("rejects extras, duplicate capabilities, and propose reads", () => {
    expect(createAgentGrantRequest({ ...request, surprise: true }).ok).toBe(false);
    expect(createAgentGrantRequest({ ...request, scopes: [...request.scopes, ...request.scopes] }).ok).toBe(false);
    expect(createAgentGrantRequest({ ...request, scopes: [{ capability: "note.read", mode: "propose" }] }).ok).toBe(false);
  });
  it("requires the exact acknowledgement for every Direct capability", () => { const direct = { ...request, scopes: [{ capability: "note.read", mode: "direct" }] };
    expect(createAgentGrantRequest(direct).ok).toBe(false); expect(createAgentGrantRequest({ ...direct, directAuthorityConfirmation }).ok).toBe(true);
    expect(createAgentGrantRequest({ ...direct, directAuthorityConfirmation: "yes" }).ok).toBe(false); });
  it("rejects extra and malformed response fields", () => { const grant = { id: "g", organizationId: "o", sponsoringMemberId: "m", name: "Agent", scopes: [{ capability: "note.read", mode: "direct" }], expiresAt: "later", createdAt: "now" };
    expect(agentGrantListResponse({ grants: [grant] }).ok).toBe(true); expect(agentGrantListResponse({ grants: [{ ...grant, extra: true }] }).ok).toBe(false);
    expect(revokeAgentGrantResponse({ grantId: "g", revoked: true }).ok).toBe(true); expect(revokeAgentGrantResponse({ grantId: "g", revoked: "yes" }).ok).toBe(false); });
});
