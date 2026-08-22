# Stash

Stash is a self-hosted application that connects early project thinking with the development work that follows. The current minimal Instance provides an operator-visible browser page, health endpoints, and a protected Instance API backed by PostgreSQL readiness.

## Run an Instance

Docker Compose starts the supported baseline: one Stash application container and PostgreSQL.

```sh
export INSTANCE_ADMIN_TOKEN="replace-with-a-long-random-secret"
docker compose up --build -d
npm ci
npm run smoke
```

Open <http://localhost:3000>. Stop the Instance with `docker compose down`. PostgreSQL data remains in the `stash-postgres` volume; removing that volume deletes the local database and is intentionally not part of the normal stop command.

For a non-development installation, also set a strong `POSTGRES_PASSWORD`. `STASH_PORT` changes the published host port, and `STASH_URL` tells the smoke test where to find an Instance.

## Configuration

The application fails at startup with a clear error when required configuration is absent or invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection URL |
| `INSTANCE_ADMIN_TOKEN` | yes | Bearer token for Instance Administrator surfaces; keep it outside Workspace content |
| `HOST` | no | Bind address, defaults to `0.0.0.0` |
| `PORT` | no | TCP port, defaults to `3000` |

Never commit production secrets or include them in a Portable Workspace Export.

## Health and error semantics

- `GET /health/live` returns `200` when the application process can serve HTTP. It does not check PostgreSQL.
- `GET /health/ready` probes PostgreSQL and returns `200` with `{"status":"ready"}` or `503` with a stable `database_unavailable` error. Database details are deliberately not exposed.
- `GET /` is the browser surface.
- `GET /api/instance` requires `Authorization: Bearer <INSTANCE_ADMIN_TOKEN>`. Missing or invalid authorization returns a visible `401` without echoing the secret.
- Unknown routes, malformed JSON, oversized bodies, and unsupported writes return structured JSON errors rather than being silently accepted.

The Compose health check uses readiness, so a container is not marked healthy while PostgreSQL is unavailable.

## Development and acceptance tests

```sh
npm ci
npm run check
npm test
npm run build
```

Acceptance tests bind a real ephemeral HTTP port and exercise the public protocol. They substitute only the PostgreSQL probe with a documented protocol-compatible fake that implements `verifyConnection()` and `close()`, allowing deterministic healthy and recoverable-outage scenarios. `npm run smoke` targets a running, PostgreSQL-backed Instance and verifies both readiness and the browser surface.
