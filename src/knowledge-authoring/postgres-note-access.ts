/** Shared containment-aware Note access policy for capability-owned PostgreSQL adapters. */
export function workspaceMemberSql(workspace: string, memberParameter: string): string {
  return `((${workspace}.owner_type='personal' AND ${workspace}.personal_owner_id=${memberParameter}) OR
    (${workspace}.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=${workspace}.organization_owner_id AND membership.account_id=${memberParameter})))`;
}

export function inheritedProjectGuestSql(note: string, memberParameter: string): string {
  return `EXISTS(WITH RECURSIVE ancestry AS (
    SELECT ${note}.id,${note}.parent_id,${note}.project_id UNION ALL
    SELECT parent.id,parent.parent_id,parent.project_id FROM stash_notes parent JOIN ancestry ON ancestry.parent_id=parent.id
  ) SELECT 1 FROM ancestry JOIN stash_project_guests guest ON guest.project_id=ancestry.project_id
    WHERE guest.account_id=${memberParameter})`;
}

export function effectiveNoteReadSql(note: string, workspace: string, memberParameter: string): string {
  return `(${workspaceMemberSql(workspace, memberParameter)} OR ${inheritedProjectGuestSql(note, memberParameter)})`;
}
