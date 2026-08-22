# Portable projection creation records

Stash records a versioned JSON projection event whenever it creates portable domain state, including
Workspaces, Projects, Notes, and Repository Connections. The
event is inserted into `stash_portable_projection_outbox` in the same PostgreSQL transaction as
the durable object. Creation succeeds only when both records commit; an outbox failure rolls back
the object and the API reports a recoverable failure.

The outbox is the reliable boundary for a future projector or Portable Workspace Export. A
`pending` record means its versioned payload is durably available for projection. It does not mean
that a complete export has already been generated.

## `stash.attachment.v1`

An Attachment records its Workspace ownership, original safe filename, declared media type, byte
size, capture source, creator attribution, creation time, and a portable path such as
`./attachments/<stable-id>/design-notes.pdf`.
The operational storage key is deliberately absent. Attachment metadata and its projection event
commit in one database transaction; local bytes are written atomically before metadata becomes
visible and are removed when that transaction fails. Notes and exports use `relativePath`, never an
Instance URL, so moving a Workspace does not break its links. Portable exports copy the bytes to
that relative path and contain no Instance secrets.
Markdown links URI-encode the literal portable path separately; a percent sign in an encoded disk
component is itself encoded as `%25`, so resolving the href names the exact exported file.

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

## Inbox triage projections

Triage appends a new projection revision in the same transaction as the canonical change. Organizing
or archiving a Note records `stash.note.v2`, containing the complete current Note state and portable
creator identity. Archive is a retained `archivedAt` timestamp; it does not delete content or
relationships.

Linking Notes records `stash.note-link.v1` with a stable link identity, `workspaceId`, and stable
source and target Note identities. The portable Markdown projector may render a readable relative
path, but these identities remain authoritative for safe repair after a move.

Creating actionable work records `stash.task.v1` with a stable Task identity, its Project and
Workspace, Project-scoped Task Key, canonical Workflow status (including its stable status
category), title, creator, creation time, and `sourceNoteIds`. The first Task creation atomically
initializes the canonical Project Workflow—Backlog and Ready (`unstarted`), In Progress and In
Review (`started`), then Done (`completed`)—and assigns Backlog. Task Key sequence allocation is serialized
inside the same transaction so keys are never duplicated or reused. The source Note remains unchanged.
All referenced Notes and Projects must exist in the same authorized Workspace; a failed validation
or outbox write rolls back the whole triage operation.

Tasks created from a Block additionally record `sourceBlocks` entries containing the stable Note and
Block identities. The first successful relationship sparsely assigns the Block's portable UUID and
records the updated Note projection in the same transaction as the Task key, Backlog status,
relationship, and Task projection. Later Tasks from that Block reuse the UUID; the authored Block
content stays in place and is not copied into the Task.

The running Instance exposes linked Tasks as a permission-aware Note read model. It resolves each
Task's current canonical Workflow status at read time, and the WYSIWYG editor renders that Task key,
title, and status adjacent to the referenced Block. This live state is never written into the Note's
authored Markdown, so a reload can show status changes without content churn.

The operational Note body is a versioned rich-text document rendered by Stash's WYSIWYG editor.
Every successful edit atomically increments the Note revision and records another `stash.note.v1`
outbox revision whose `content` is the complete Markdown rendering. Ordinary Blocks have no
identifier. Once another durable object references a Block, its UUID is preserved in the rich-text
document and projected immediately after that Block as an HTML comment:

```markdown
Decide how release candidates are signed.
<!-- stash-block:44444444-4444-4444-8444-444444444444 -->
```

The comment is stable, readable by ordinary Markdown tools, and does not include live Task status.
Importers preserve valid identifiers exactly and report malformed or ambiguous references instead
of guessing. Rich formatting uses ordinary Markdown headings, emphasis, links, quotes, lists,
checklists, and fenced code so the WYSIWYG and portable surfaces round-trip intelligibly.

Editor updates are idempotent operation batches. Every operation has a UUID and addresses a stable
operational `blockKey`; retries do not create another revision. Concurrent operations based on an
older revision merge automatically when they address different Blocks. Same-Block changes are
preserved in `stash_note_edit_conflicts` for focused resolution rather than choosing a contribution.
An operation may preserve an existing portable Block `id`, but cannot move it to another Block,
mint a linked identity, or delete a linked Block. Missing or ambiguous references are rejected
visibly; linking capabilities own the sparse portable-identity lifecycle.
Operation UUIDs are bound to a canonical SHA-256 digest of their type, target, placement, and full
payload. Reusing an ID with altered intent is rejected visibly and the attempted contribution is
retained for investigation; property ordering does not affect the digest. Edit projections always
retain the immutable original Note creator resolved from the locked Note row. The editing Member
is authorization and activity context, never a replacement for `createdBy`.

The rich-text foundation round-trips paragraphs, headings (levels one through three), bold,
italic, inline code, links, quotes, bullet items, checklists, and fenced code through documented
Markdown. Tables, callouts, images, and Attachments are delivered by the downstream expressive
content and Attachment slices; encountering those constructs in this foundation produces an
explicit unsupported-construct result instead of silently flattening or discarding them.

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

## `stash.repository-connection.v1`

Repository Connections project only durable, non-secret meaning. The stable connection identity,
provider, readable repository URL, Organization identity, creator attribution, and same-Organization
Project relationships are portable:

```json
{
  "schema": "stash.repository-connection.v1",
  "id": "622910d0-cb95-42ad-9445-688b11ef9342",
  "provider": "github",
  "repositoryUrl": "https://github.com/acme/platform",
  "organization": {
    "localOrganizationId": "c4c75c6b-68f7-44e0-b6d3-89920d216dc9",
    "displayName": "Acme"
  },
  "createdBy": {
    "localAccountId": "dd24a52e-f591-42a8-90af-a981e1449877",
    "displayName": "Ada Lovelace",
    "attribution": "recorded"
  },
  "projectIds": ["2a940fff-b3d9-4ef5-b55f-cc150b16b83e"]
}
```

GitHub installation IDs, repository provider IDs, installation tokens, and the Instance App private
key are operational Instance state and never appear in this schema. On import, unavailable local
Organization and creator identities retain their display names; unavailable creators degrade to
Identity Stubs and are never matched by name automatically. Project IDs preserve stable relationships
and are reconciled through the same explicit stable-identity mapping used by Project imports.
Connections upgraded from the pre-projection schema select a current Owner or Admin as a migration
identity and set `createdBy.attribution` to `inferred-during-upgrade`; consumers must not present that
identity as a historically recorded creator. Newly created connections use `recorded`.
The upgrade inserts revision 1 for every legacy connection, including its existing Project links,
before removing any formerly persisted installation token. Projection backfill and credential removal
commit together; failure leaves the old state retryable, and repeated startup cannot duplicate revision 1.

Creation and each Project attachment insert a new outbox revision in the same PostgreSQL transaction
as the operational mutation. If projection recording fails, the Repository Connection or attachment
rolls back. This keeps exported relationships synchronized without exposing provider credentials.
