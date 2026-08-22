# Stash

Stash is a self-hosted application that connects early project thinking with the development work that follows. The current minimal Instance provides an operator-visible browser page, health endpoints, and a protected Instance API backed by PostgreSQL readiness.

## Run an Instance

Docker Compose starts the supported baseline: one Stash application container and PostgreSQL.

```sh
export INSTANCE_ADMIN_TOKEN="replace-with-a-long-random-secret"
export INSTANCE_MASTER_KEY="$(openssl rand -base64 32)"
export PUBLIC_ORIGIN="https://stash.example.com"
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
| `INSTANCE_MASTER_KEY` | yes | Base64-encoded 32-byte key used to protect authentication material; store it outside PostgreSQL and Workspace exports |
| `PUBLIC_ORIGIN` | yes | Canonical HTTPS origin used for OIDC callbacks, such as `https://stash.example.com` |
| `HOST` | no | Bind address, defaults to `0.0.0.0` |
| `PORT` | no | TCP port, defaults to `3000` |
| `REDIS_URL` | no | Redis connection URL for best-effort acceleration; PostgreSQL remains authoritative |
| `WEBAUTHN_RP_ID` | no | WebAuthn relying-party domain; defaults to the `PUBLIC_ORIGIN` hostname |
| `WEBAUTHN_RP_NAME` | no | Name displayed by authenticators; defaults to `Stash` |
| `SMTP_URL` | no | SMTP connection URL; enables email recovery only when paired with `EMAIL_RECOVERY_FROM` |
| `EMAIL_RECOVERY_FROM` | no | Sender address for recovery messages; must be configured with `SMTP_URL` |

Never commit production secrets or include them in a Portable Workspace Export.

### Optional OpenID Connect

Built-in password authentication remains available when OIDC is enabled. An authenticated Organization Owner or Admin enables a provider through the Organization API:

```sh
curl -X PUT http://localhost:3000/api/organizations/<organizationId>/auth/oidc \
  -H "Authorization: Bearer <member-session>" -H "Content-Type: application/json" \
  -d '{"issuer":"https://login.example.com","clientId":"stash","clientSecret":"replace-me"}'
```

Provider identities are explicitly linked to an existing Organization Member with `POST /api/organizations/<organizationId>/auth/oidc/identities` and a JSON body containing `accountId` and provider `subject`; matching an email address never creates or links an account implicitly. Begin authentication at `GET /api/auth/oidc/<organizationId>`. The returned authorization URL uses Authorization Code flow with PKCE, state, and nonce, and its callback issues the same kind of Stash session used by built-in authentication. Provider client secrets are encrypted under `INSTANCE_MASTER_KEY` and excluded from Portable Workspace Exports.

OIDC issuer, discovery, token, and JWKS endpoints must use HTTPS and resolve only to public addresses. Stash pins each validated DNS result to the outbound connection, revalidates controlled discovery/JWKS redirects, rejects token-endpoint redirects, and bounds response time and size. The plain-HTTP/private-address exception exists only as an explicitly injected test adapter and is not available through Instance configuration.

OIDC callback URLs always use `PUBLIC_ORIGIN`; request `Host` and forwarding headers never influence them. Deployments behind a proxy must preserve the configured public URL when forwarding the callback. Production callback origins require HTTPS. The insecure-origin exception is injectable only by acceptance tests and is not available from environment configuration.

Production passkeys require an HTTPS `PUBLIC_ORIGIN` whose hostname matches the configured relying-party ID. Email recovery stays visibly disabled when SMTP is absent. Partial SMTP configuration fails startup rather than presenting a recovery option that cannot deliver mail.

`INSTANCE_MASTER_KEY` is part of the Instance's restore contract even though it is stored outside
PostgreSQL. Instance backup procedures must preserve this exact key separately and operators must
resupply the same key when restoring the Instance. If the key is missing or wrong, encrypted
authentication state is unreadable; restore preflight must fail visibly rather than starting with
partially usable or silently discarded authentication data. Portable Workspace Exports must never
contain the key or other Instance authentication secrets.

### Optional Redis acceleration

Redis is never required for correctness or for an application feature. When `REDIS_URL` is absent, Stash reads authoritative data directly. When it is configured, cache hits may accelerate reads; cache misses, invalid cached values, and Redis outages fall back to PostgreSQL and are reported in the Instance logs.

Compose includes an opt-in, non-persistent Redis profile:

```sh
export REDIS_URL=redis://redis:6379
docker compose --profile redis up --build -d
```

Stopping or deleting Redis does not remove durable Stash data. Do not include Redis in Instance backups; continue backing up PostgreSQL and Attachment storage as documented.

## Health and error semantics

- `GET /health/live` returns `200` when the application process can serve HTTP. It does not check PostgreSQL.
- `GET /health/ready` probes PostgreSQL and returns `200` with `{"status":"ready"}` or `503` with a stable `database_unavailable` error. Database details are deliberately not exposed.
- `GET /` is the browser surface.
- `GET /api/instance` requires `Authorization: Bearer <INSTANCE_ADMIN_TOKEN>`. Missing or invalid authorization returns a visible `401` without echoing the secret.
- `POST /api/workspaces` requires a Member session and creates either a personal Workspace owned by that Member or an Organization Workspace when the Member belongs to that Organization.
- `POST /api/workspaces/:workspaceId/projects` requires a Member session and creates a Project only when the Member owns the personal Workspace or belongs to its Organization. Project keys are normalized to uppercase and unique within their Workspace.
- Unknown routes, malformed JSON, oversized bodies, and unsupported writes return structured JSON errors rather than being silently accepted.

The Compose health check uses readiness, so a container is not marked healthy while PostgreSQL is unavailable.

Successful Workspace and Project creation atomically records a versioned portable-projection
event. The API reports its schema and `recorded` state; creation fails visibly if that event cannot
be committed. See [the portable projection format](docs/portable-projection.md).

## Development and acceptance tests

```sh
npm ci
npm run check
npm test
npm run build
```

Acceptance tests bind a real ephemeral HTTP port and exercise the public protocol. Protocol-compatible database and Member-access fakes provide deterministic ownership, healthy, and recoverable-outage scenarios without bypassing the Instance HTTP boundary. `npm run smoke` targets a running, PostgreSQL-backed Instance and verifies both readiness and the browser surface.
