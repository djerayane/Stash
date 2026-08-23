# Public domain API

Stash exposes its supported Member-domain capabilities below `/api/v1`. Send the same Member session bearer token used by the web application:

```http
Authorization: Bearer <member-session-token>
```

`GET /api/v1` reports the active API version and authentication contract. Responses through the versioned boundary include `Stash-API-Version: 1`.

The versioned paths are the existing Member-domain paths with `/api/v1` in place of `/api`. This includes Workspace and Project creation, Roles and invitations, Notes and Note links, Tasks, Workflows and boards, Attachments, Discussions, Portable Workspace Exports, Activity and Note history, Member localization, Repository Connections, and GitHub development artifacts when the corresponding Instance capability is configured.

The public API is an adapter over the same routes and application services used by the web application. It therefore derives the actor from the bearer session and retains the same Project and Workspace permission checks, input validation, conflict handling, Activity recording, and portable projections. A caller cannot provide a different actor identity in a request body.

Authentication, account recovery, mobile synchronization, health, diagnostics, and Instance-administration routes are separate Stash boundaries and are not mirrored below `/api/v1`.

Errors use a stable JSON shape with an `error` code and a human-readable `message`. Permission failures are `403`, invalid domain input is `422`, conflicts are `409`, and recoverable service failures are `503`; individual capabilities may document more specific codes. Error responses do not include database errors, credentials, or internal causes.
