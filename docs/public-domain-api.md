# Public domain API

Stash exposes its supported Member-domain capabilities below `/api/v1`. Send the same Member session bearer token used by the web application:

```http
Authorization: Bearer <member-session-token>
```

`GET /api/v1` reports the active API version and authentication contract. Responses through the versioned boundary include `Stash-API-Version: 1`.

The versioned paths are the existing Member-domain paths with `/api/v1` in place of `/api`. This includes Workspace and Project creation, Roles and invitations, Notes and Note links, Tasks, Workflows and boards, Attachments, Discussions, Portable Workspace Exports, Activity and Note history, Member notifications and per-Project notification settings, Member localization, Repository Connections, and GitHub development artifacts when the corresponding Instance capability is configured.

Notifications are derived from attributed `stash.activity.v1` records. Domain adapters publish direct mentions, requested reviews, failed Automations, and followed changes through `POST /api/v1/projects/{projectId}/notification-events`; the authenticated actor must match the Activity attribution, while assignment Activity is produced atomically by Task changes. Direct mentions, assignments, requested reviews, and failed Automations remain relevant even when ordinary Project activity is muted. For followed changes, `all` includes every change, `followed` includes only events identified as followed by the producing domain adapter, and `muted` suppresses them. Self-authored Activity is suppressed. `GET /api/v1/notifications` returns the current permission-filtered inbox, `GET /api/v1/notifications/digest` atomically claims unread entries in the current UTC daily or Monday-based weekly window so retrying the same delivery does not duplicate it, and `POST /api/v1/notifications/{id}/read` records read state. `GET` and `PUT /api/v1/projects/{projectId}/notification-settings` expose `activity` (`all`, `followed`, or `muted`), `digest` (`off`, `daily`, or `weekly`), and optional local quiet hours. Entries created during quiet hours carry `delivery: "quiet_hours"`, allowing delivery workers and clients to defer interruptions without hiding the event from the feed.

This is the permission-aware server capability and stable client contract. In accordance with ADR-0040, the Member-facing React notification interface and its browser acceptance coverage are delivered separately; these endpoints do not claim that client surface is complete.

The public API is an adapter over the same routes and application services used by the web application. It therefore derives the actor from the bearer session and retains the same Project and Workspace permission checks, input validation, conflict handling, Activity recording, and portable projections. A caller cannot provide a different actor identity in a request body.

Authentication, account recovery, mobile synchronization, health, diagnostics, and Instance-administration routes are separate Stash boundaries and are not mirrored below `/api/v1`.

Errors use a stable JSON shape with an `error` code and a human-readable `message`. Permission failures are `403`, invalid domain input is `422`, conflicts are `409`, and recoverable service failures are `503`; individual capabilities may document more specific codes. Error responses do not include database errors, credentials, or internal causes.
