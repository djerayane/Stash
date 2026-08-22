# Portable projection creation records

Stash records a versioned JSON projection event whenever it creates a Workspace or Project. The
event is inserted into `stash_portable_projection_outbox` in the same PostgreSQL transaction as
the durable object. Creation succeeds only when both records commit; an outbox failure rolls back
the object and the API reports a recoverable failure.

The outbox is the reliable boundary for a future projector or Portable Workspace Export. A
`pending` record means its versioned payload is durably available for projection. It does not mean
that a complete export has already been generated.

## `stash.workspace.v1`

```json
{
  "id": "89fa5772-0439-4cc1-b67a-bdeb12ae0ed5",
  "name": "Acme Product",
  "owner": {
    "type": "organization",
    "identity": {
      "localOrganizationId": "c4c75c6b-68f7-44e0-b6d3-89920d216dc9",
      "displayName": "Acme"
    }
  },
  "createdBy": {
    "localAccountId": "dd24a52e-f591-42a8-90af-a981e1449877",
    "displayName": "Ada Lovelace"
  }
}
```

For a personal Workspace, `owner.type` is `personal` and `owner.identity` has the same shape as
`createdBy`. Identity fields are resolved from authenticated Instance records; clients cannot
submit display names for the projection.

## `stash.project.v1`

```json
{
  "id": "2a940fff-b3d9-4ef5-b55f-cc150b16b83e",
  "workspaceId": "89fa5772-0439-4cc1-b67a-bdeb12ae0ed5",
  "name": "Launch",
  "key": "LAUNCH",
  "createdBy": {
    "localAccountId": "dd24a52e-f591-42a8-90af-a981e1449877",
    "displayName": "Ada Lovelace"
  }
}
```

On import into another Instance, a matching stable local reference may be mapped explicitly. If no
matching account or Organization is available, importers preserve `displayName` so ownership and
attribution remain intelligible without impersonating a local Member. Account identities degrade
to Identity Stubs rather than being matched by name automatically.

The outbox envelope stores `object_kind`, `object_id`, `revision`, `projection_schema`, the JSON
`payload`, creation time, and processing `state`. Consumers select the format using
`projection_schema`; they must not infer a payload version from the database table layout.

## `stash.note.v1`

A captured Note records a Markdown-compatible content string and its durable metadata. Content is
preserved exactly as authored; tags are trimmed and deduplicated, reminder timestamps and
`createdAt` are normalized to UTC, and `projectId` and `reminder` are omitted when absent.

```json
{
  "schema": "stash.note.v1",
  "id": "d7289ce8-b0bb-4f44-971d-9b373fc34962",
  "workspaceId": "89fa5772-0439-4cc1-b67a-bdeb12ae0ed5",
  "projectId": "2a940fff-b3d9-4ef5-b55f-cc150b16b83e",
  "content": "Prepare the launch checklist.",
  "tags": ["launch", "follow-up"],
  "reminder": { "at": "2026-09-02T08:30:00.000Z" },
  "createdAt": "2026-08-22T18:42:03.193Z",
  "createdBy": {
    "localAccountId": "dd24a52e-f591-42a8-90af-a981e1449877",
    "displayName": "Ada Lovelace"
  }
}
```

`id` is the stable Note identity. `workspaceId` and optional `projectId` preserve its relationships;
the content field becomes the Note Markdown file body when projected. Creator identity is resolved
from the authenticated Instance account, never accepted from the client. On import, the same
explicit-mapping rules apply as for Workspace and Project creators: an unavailable local identity
degrades to an Identity Stub preserving `displayName`, without automatic name matching.

The Note row and its `stash.note.v1` outbox event commit in one transaction. A capture response
reports the projection as `recorded` only after both writes succeed; it does not claim that a full
Portable Workspace Export has already been generated.

## `stash.guest-project-access.v1`

Accepting a Guest invitation records the selected Project relationships and their containing
Workspaces in the same transaction as the read-only grants:

```json
{
  "schema": "stash.guest-project-access.v1",
  "id": "8af04cac-5f50-4cc7-a5c6-9ae312b10aac",
  "organizationId": "c4c75c6b-68f7-44e0-b6d3-89920d216dc9",
  "guest": {
    "localAccountId": "a86d4918-e5cb-4887-82c9-4d5646aa4578",
    "displayName": "Katherine Johnson"
  },
  "projects": [{
    "workspaceId": "89fa5772-0439-4cc1-b67a-bdeb12ae0ed5",
    "projectId": "2a940fff-b3d9-4ef5-b55f-cc150b16b83e"
  }],
  "acceptedAt": "2026-08-22T18:42:03.193Z",
  "invitedBy": {
    "localAccountId": "dd24a52e-f591-42a8-90af-a981e1449877",
    "displayName": "Ada Lovelace"
  }
}
```

Importers map `guest.localAccountId` only through an explicit stable-reference mapping. When no
local account is mapped, they create an Identity Stub that preserves `displayName`; names alone
never select or impersonate a local account. Projection failure rolls back both token acceptance
and every Project grant, leaving the invitation retryable.
