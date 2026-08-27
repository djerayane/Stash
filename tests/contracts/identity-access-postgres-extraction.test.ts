import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("PostgreSQL identity-access persistence ownership", () => {
  it("owns every identity binding in the focused kernel adapter", async () => {
    const adapter = await readFile(new URL("../../src/identity-access/postgres-identity-access-repositories.ts", import.meta.url), "utf8");
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
    const methods = ["findMemberLocalizationPreferences", "saveMemberLocalizationPreferences", "createWorkspace", "listAccessibleWorkspaces",
      "canCreateProject", "createProject", "findPortableMemberIdentity", "resolveClientSessionPrincipal", "findOidcIdentity",
      "findOidcConfiguration", "organizationRole", "saveOidcConfiguration", "linkOidcIdentity", "assignBuiltInRole",
      "removeOrganizationMember", "createInvitation", "acceptInvitation", "readProject", "canWriteProject", "savePasskey",
      "findPasskey", "updatePasskeyCounterAndCreateSession", "replaceRecoveryCodes", "consumeRecoveryCodeAndCreateSession",
      "enqueueEmailRecovery", "claimEmailRecoveryDelivery", "renewEmailRecoveryDelivery", "completeEmailRecoveryDelivery",
      "retryEmailRecoveryDelivery", "findEmailRecoveryAccount", "consumeEmailRecoveryAndCreateSession", "createAgentGrant",
      "listAgentGrants", "revokeAgentGrant", "findActiveAgentGrant", "agentGrantOptions", "createAgentProposal",
      "listAgentProposals", "findAgentProposal", "claimAgentProposal", "finishAgentProposal", "releaseAgentProposal",
      "agentGrantTargetAllowed", "listPendingImportedIdentities", "mapImportedIdentityAsMember"];
    for (const method of methods) assert.match(adapter, new RegExp(`(?:async )?${method}\\(`));
    assert.match(database, /identityAccessRepositories\(\): IdentityAccessPostgresRepositories \{\s+return this\.#identityAccessAdapter;/);
    assert.doesNotMatch(database, new RegExp(`^  (?:async )?(?:${methods.join("|")})\\(`, "m"));
    assert.doesNotMatch(database, /Object\.assign\(this\.#identityAccessAdapter/);
  });

  it("owns identity schema preparation outside the universal database", async () => {
    const adapter = await readFile(new URL("../../src/identity-access/postgres-identity-access-repositories.ts", import.meta.url), "utf8");
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
    for (const table of ["stash_member_localization_preferences", "stash_oidc_configurations", "stash_passkeys", "stash_invitations",
      "stash_agent_grants", "stash_identity_stubs"]) assert.match(adapter, new RegExp(table));
    assert.doesNotMatch(database, /async #ensure(?:Auth|Oidc|Recovery|Bootstrap|WorkspaceProject|MemberLocalization|Invitation|MemberDeparture)Schema\(/);
  });
});
