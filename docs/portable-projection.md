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
