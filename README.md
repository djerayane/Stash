# Stash

Stash is a self-hosted application that connects early project thinking with the development work that follows. The current minimal Instance provides an operator-visible browser page, health endpoints, and a protected Instance API backed by PostgreSQL readiness.

Member-facing integrations use the versioned, permission-aware [public domain API](docs/public-domain-api.md).

## Client architecture

The product clients use the architecture fixed by [ADR-0040](docs/adr/0040-standardize-the-web-and-mobile-client-stack.md):

- `apps/web`: React 19, TypeScript, Vite, React Router, TanStack Query, Radix primitives, CSS Modules, and shared CSS design tokens.
- Rich text: Tiptap/ProseMirror with Yjs and a self-hosted collaboration service.
- `apps/mobile`: Expo and React Native, sharing domain types, API clients, validation, and synchronization logic rather than most UI components.
- Repository: pnpm workspaces with focused shared packages.
- Client testing: Vitest, Testing Library, Playwright, and axe accessibility checks.

The Vite build is the sole browser application. The server hosts its static assets and returns `index.html` for non-operational HTML deep links; it does not implement Member features with server-rendered HTML or imperative DOM scripts. A Member-facing ticket is not frontend-complete until its behavior exists in the appropriate React or Expo client and passes client acceptance tests. Canonical domain rules and authorization remain server-owned rather than being reimplemented in either client.

## Run an Instance

From a fresh checkout, start a localhost evaluation Instance with one command:

```sh
docker compose up -d
```

Open <http://localhost:3000>. Docker Compose starts the supported baseline: one Stash application container and PostgreSQL, bound to localhost by default. The [Installation guide](docs/installation.md) compares source Compose, the prebuilt GHCR image, self-contained bundles, and mobile artifacts, and covers production hardening, persistence, backups, upgrades, and checksums.

Use `docker compose ps` to inspect readiness and `docker compose logs stash` to inspect startup. Stop the Instance with `docker compose down`. PostgreSQL, local Attachments, and Instance Backups remain in the `stash-postgres`, `stash-attachments`, and `stash-backups` named volumes; removing those volumes deletes local Instance data and is intentionally not part of the normal stop command.

The signed-out page offers **Create an account** in the localhost Compose evaluation configuration. Registration creates a built-in password account and a personal Workspace, then signs the new Member in. Set `OPEN_REGISTRATION=false` to close registration. The application default is closed, so non-Compose deployments must explicitly set `OPEN_REGISTRATION=true` to enable it. Existing built-in accounts always use the Password sign-in method.
To use a published multi-architecture image instead of building from the checkout, set `STASH_IMAGE`. Compose retains the same PostgreSQL, persistence, health, and localhost-only defaults:

```sh
STASH_IMAGE=ghcr.io/djerayane/stash:1.2.3 docker compose up -d --no-build
```

Version tags are convenient selectors, while the manifest digest reported by the release workflow is the immutable artifact identity. Production automation should pin that digest:

```sh
STASH_IMAGE=ghcr.io/djerayane/stash@sha256:<manifest-digest> docker compose up -d --no-build
```

Published images support `linux/amd64` and `linux/arm64`. They contain no Instance credentials; all configuration continues to come from the Compose environment or the operator's deployment system.

### Self-contained Instance bundle

GitHub Releases also provide `stash-instance-<version>-<platform>-<architecture>` archives and matching `.sha256` files. Each archive contains the server, React client, PGlite embedded PostgreSQL engine, Node runtime, license, launcher, and source metadata; the machine needs no Docker, Node, pnpm, or separately installed database. Extract the archive, verify its checksum, and select one durable data directory:

```sh
sha256sum --check stash-instance-1.2.3-linux-x64.tar.gz.sha256
tar -xzf stash-instance-1.2.3-linux-x64.tar.gz
./stash-instance-1.2.3-linux-x64/stash --data-dir /srv/stash-standalone
```

On macOS, use `shasum -a 256 -c stash-instance-1.2.3-darwin-arm64.tar.gz.sha256`. On Windows PowerShell, compare `(Get-FileHash .\stash-instance-1.2.3-win32-x64.zip -Algorithm SHA256).Hash` with the first value in `Get-Content .\stash-instance-1.2.3-win32-x64.zip.sha256` before expanding the ZIP.

On Windows, extract the ZIP and run `stash.cmd --data-dir C:\Stash\data`. The launcher binds to `127.0.0.1:3000`, enables local account creation, and refuses a public bind while its evaluation configuration remains. Database files, Attachments, backups, and generated non-secret configuration stay beneath the selected directory. The generated master-key file is deliberately adjacent to, not inside, that directory; protect and back it up separately because neither the bundle nor an Instance Backup contains it.

Stop the Instance before using the offline backup commands:

```sh
./stash backup create --data-dir /srv/stash-standalone --backup /srv/stash-standalone/backups/pre-upgrade
./stash backup verify --data-dir /srv/stash-standalone --backup /srv/stash-standalone/backups/pre-upgrade
./stash backup restore --data-dir /srv/stash-standalone --backup /srv/stash-standalone/backups/pre-upgrade --dry-run
```

To upgrade, verify and extract the newer archive, take a backup with the old launcher, stop it, then start the new launcher with the same data directory. Stash runs its normal format preflight and keeps a rollback backup before changing durable state.

The bundled `stash migrate` command exposes the same tested standalone-to-PostgreSQL migration described in [Embedded Instance storage](docs/embedded-instance-storage.md). Configure `DESTINATION_DATABASE_URL` and measured `DESTINATION_DATABASE_AVAILABLE_BYTES`, then use protected source/destination key files and explicit preserve or rotate mode; the migration keeps the source authoritative unless its database, Attachment, configuration, authentication, authorization, and checksum validation all succeed.

Preserve the existing encryption key:

```sh
export DESTINATION_DATABASE_URL='postgresql://stash@db.example/stash'
export DESTINATION_DATABASE_AVAILABLE_BYTES=107374182400
./stash migrate --data-dir /srv/stash-standalone --attachment-root /srv/stash-postgres/attachments --configuration-root /srv/stash-postgres/config --mode preserve --source-key-file /srv/.stash-standalone.master-key
```

Or rotate it by creating a separately protected 32-byte base64 destination key file and passing it explicitly:

```sh
openssl rand -base64 32 > /run/secrets/stash-destination-key
chmod 600 /run/secrets/stash-destination-key
./stash migrate --data-dir /srv/stash-standalone --attachment-root /srv/stash-postgres/attachments --configuration-root /srv/stash-postgres/config --mode rotate --source-key-file /srv/.stash-standalone.master-key --destination-key-file /run/secrets/stash-destination-key
```

The same options work with `stash.cmd migrate` in PowerShell. Both destination directories must be empty, the destination PostgreSQL schema must already be initialized, and the source remains authoritative until the command reports `"status":"migrated"`. These commands use only the extracted bundle; Node and pnpm are not required.

### Local evaluation defaults are not production secrets

The zero-configuration path is deliberately bound to `127.0.0.1` and supplies conspicuous, deterministic development-only values for the administrator token, Instance master key, PostgreSQL password, and `http://localhost:3000` public origin. Anyone with local machine access can discover these values. Do not expose this configuration to a network, reuse its data as a production Instance, or treat its credentials as private.

Before any external exposure, supply unique secrets and the canonical HTTPS origin. Set the bind address explicitly only after the Instance is behind the intended firewall or reverse proxy:

```sh
export INSTANCE_ADMIN_TOKEN="$(openssl rand -base64 48)"
export INSTANCE_MASTER_KEY="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD="Aa1-$(openssl rand -hex 24)"
export PUBLIC_ORIGIN="https://stash.example.com"
export STASH_BIND_ADDRESS="0.0.0.0"
docker compose up -d
```

Store `INSTANCE_MASTER_KEY` separately from PostgreSQL and backups; restoring encrypted Instance state requires the exact same key. External binds require a PostgreSQL password of at least 16 characters containing at least three of lowercase, uppercase, digits, and symbols. Their `PUBLIC_ORIGIN` must be canonical HTTPS with a DNS hostname; IP literals and localhost names are rejected. `STASH_PORT` changes the published host port, `STASH_BIND_ADDRESS` defaults to localhost, and `STASH_URL` tells the smoke test where to find an Instance. Application-level validation remains active for Compose overrides and fails unsafe production configuration clearly.

### Mobile applications

Each version-tag release workflow retains an Android preview APK. Stable releases additionally build the Play Store AAB and, when Apple signing capability is configured, an iOS IPA. Installation and signing details are in [the mobile client guide](apps/mobile/README.md). After installation, Members pair the app directly with their own HTTPS Instance; Stash operates no hosted relay.

## Configuration

The application fails at startup with a clear error when required configuration is absent or invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes outside Compose | PostgreSQL connection URL; Compose instead URL-encodes its separate PostgreSQL fields so reserved password characters remain safe |
| `INSTANCE_ADMIN_TOKEN` | yes | Bearer token for Instance Administrator surfaces; keep it outside Workspace content |
| `INSTANCE_MASTER_KEY` | yes | Base64-encoded 32-byte key used to protect authentication material; store it outside PostgreSQL and Workspace exports |
| `PUBLIC_ORIGIN` | yes | Canonical HTTPS origin used for OIDC callbacks, such as `https://stash.example.com`; plain HTTP is accepted only for `localhost` evaluation |
| `HOST` | no | Bind address, defaults to `0.0.0.0` |
| `PORT` | no | TCP port, defaults to `3000` |
| `OPEN_REGISTRATION` | no | `true` opens built-in account registration and `false` closes it; the application default is `false`, while the localhost Compose evaluation configuration explicitly defaults to `true` |
| `REDIS_URL` | no | Redis connection URL for best-effort acceleration; PostgreSQL remains authoritative |
| `WEBAUTHN_RP_ID` | no | WebAuthn relying-party domain; defaults to the `PUBLIC_ORIGIN` hostname |
| `WEBAUTHN_RP_NAME` | no | Name displayed by authenticators; defaults to `Stash` |
| `SMTP_URL` | no | SMTP connection URL; enables email recovery only when paired with `EMAIL_RECOVERY_FROM` |
| `EMAIL_RECOVERY_FROM` | no | Sender address for recovery messages; must be configured with `SMTP_URL` |
| `GITHUB_APP_ID` | no | Numeric ID of the Instance-owned GitHub App; must be configured with `GITHUB_APP_PRIVATE_KEY` |
| `GITHUB_APP_PRIVATE_KEY` | no | PEM private key for the Instance-owned GitHub App; keep it outside PostgreSQL and configure it with `GITHUB_APP_ID` |
| `GITHUB_WEBHOOK_SECRET` | no | Shared secret used to verify GitHub webhook deliveries before development Signals are accepted |
| `MCP_ENABLED` | no | Set to `true` to expose `/mcp`; disabled by default and always requires an active Agent Grant credential |
| `INSTANCE_BACKUP_PATH` | no | Operator-owned directory for backups created through the protected Instance administration API |
| `ATTACHMENT_STORAGE_PATH` | no | Local Attachment directory, used by default (`/var/lib/stash/attachments`) |
| `S3_ENDPOINT` | no | S3-compatible HTTP(S) endpoint; enables remote Attachment storage when all required `S3_*` values below are set |
| `S3_REGION` | with `S3_ENDPOINT` | S3 signing region |
| `S3_BUCKET` | with `S3_ENDPOINT` | Existing bucket used for Attachment objects |
| `S3_ACCESS_KEY_ID` | with `S3_ENDPOINT` | S3 access-key identifier; keep it outside PostgreSQL and exports |
| `S3_SECRET_ACCESS_KEY` | with `S3_ENDPOINT` | S3 secret access key; keep it outside PostgreSQL and exports |
| `S3_PREFIX` | no | Optional object-key prefix within the bucket |
| `S3_FORCE_PATH_STYLE` | no | Set to `false` for virtual-hosted bucket addressing; defaults to path-style for broad provider compatibility |

Never commit production secrets or include them in a Portable Workspace Export.

S3-compatible Attachment storage is opt-in and fails closed on partial configuration. Attachment keys remain portable across local and S3 adapters. Coordinated Instance backups download the selected objects into the encrypted backup, and restore requires the destination Instance to use the same adapter kind.

### Optional MCP access

MCP is disabled unless the Instance Administrator sets `MCP_ENABLED=true`. A Member then pairs a client from **Agents** in the React application, selects Direct, Propose, or Deny policy, and copies the one-time Agent Grant credential into that client. The Instance stores only a lookup and hash. Grants are scoped to the sponsoring Member's Organization, optionally to one Project, expire within 90 days, and can be revoked immediately from the same screen. Member sessions and the Instance Administrator token are never accepted at `/mcp`.

### Optional OpenID Connect

Built-in password authentication remains available when OIDC is enabled. An authenticated Organization Owner or Admin enables a provider through the Organization API:

```sh
curl -X PUT http://localhost:3000/api/organizations/<organizationId>/auth/oidc \
  -H "Authorization: Bearer <member-session>" -H "Content-Type: application/json" \
  -d '{"issuer":"https://login.example.com","clientId":"stash","clientSecret":"replace-me"}'
```

Provider identities are explicitly linked to an existing Organization Member with `POST /api/organizations/<organizationId>/auth/oidc/identities` and a JSON body containing `accountId` and provider `subject`; matching an email address never creates or links an account implicitly. Begin authentication at `GET /api/auth/oidc/<organizationId>`. The returned authorization URL uses Authorization Code flow with PKCE, state, and nonce, and its callback issues the same kind of Stash session used by built-in authentication. Provider client secrets are encrypted under `INSTANCE_MASTER_KEY` and excluded from Portable Workspace Exports.

OIDC issuer, discovery, token, and JWKS endpoints must use HTTPS and resolve only to public addresses. Stash pins each validated DNS result to the outbound connection, revalidates controlled discovery/JWKS redirects, rejects token-endpoint redirects, and bounds response time and size. The plain-HTTP/private-address exception exists only as an explicitly injected test adapter and is not available through Instance configuration.

OIDC callback URLs always use `PUBLIC_ORIGIN`; request `Host` and forwarding headers never influence them. The zero-configuration, loopback-bound evaluation Instance may configure `http://localhost:3000` through the environment because browsers treat localhost as a secure development context. Every production or otherwise non-local callback origin must be canonical HTTPS, and changing Compose to a non-loopback bind fails startup while the localhost origin remains. The separately injected acceptance-test adapter does not enable any broader environment-configured insecure origin. Deployments behind a proxy must preserve the configured public URL when forwarding the callback.

When the Instance GitHub App is configured, an authenticated Organization Owner or Admin creates a Repository Connection with `POST /api/organizations/<organizationId>/repository-connections` and a JSON body containing the numeric `installationId`, repository `owner`, and repository `name`. `GET` on the same path lists only that Organization's connections. A connection is reused for the same GitHub repository inside one Organization and is never shared across Organizations. The installation and repository IDs remain operational Instance data. Stash never persists short-lived GitHub installation tokens: the Instance-owned App mints a fresh token for each provider operation, and the App private key remains in Instance configuration. Tokens, private keys, and provider operational IDs are never returned in portable metadata.

Production passkeys require an HTTPS `PUBLIC_ORIGIN` whose hostname matches the configured relying-party ID. Email recovery stays visibly disabled when SMTP is absent. Partial SMTP configuration fails startup rather than presenting a recovery option that cannot deliver mail. Recovery requests queue encrypted local delivery jobs and return without waiting for SMTP; transient delivery failures remain queued for retry and are reported in Instance logs.

`INSTANCE_MASTER_KEY` is part of the Instance's restore contract even though it is stored outside
PostgreSQL. Instance backup procedures must preserve this exact key separately and operators must
resupply the same key when restoring the Instance. If the key is missing or wrong, encrypted
authentication state is unreadable; restore preflight must fail visibly rather than starting with
partially usable or silently discarded authentication data. Portable Workspace Exports must never
contain the key or other Instance authentication secrets.

### Coordinated Instance Backups

Instance Backups are distinct from Portable Workspace Exports. They contain a transactionally
consistent PostgreSQL dump (including accounts, identity links, Activity, and application-encrypted
integration state), the local Attachment store, and non-secret runtime requirements. A versioned
manifest records SHA-256 checksums for every payload and a keyed verification value, but never
contains `INSTANCE_MASTER_KEY`. Preserve that exact key in a separate secret manager.

With `INSTANCE_BACKUP_PATH` configured, an Instance Administrator can create a backup and inspect
its health without supplying a filesystem path over HTTP:

```sh
curl -X POST https://stash.example.com/api/instance/backups \
  -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN"
curl https://stash.example.com/api/instance/backups/health \
  -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN"
```

The Instance remains readable but rejects writes while the coordinated database and Attachment
snapshot is made. Verification rejects missing, changed, symbolic, unsupported, and unlisted files.
Its signed verification timestamp is stored in the published manifest, so backup age and the latest
verification remain visible after an Instance restart or a separate CLI verification process.
Scheduling and off-site copying remain operator responsibilities. Redis is an acceleration layer
and is never included.

The operator command supports explicit creation and disaster-recovery preflight. Paths must be
absolute. Use the protected HTTP command for a live coordinated backup; stop the application before
using the CLI `create` command or a real restore. `--dry-run` verifies the version, manifest,
every checksum, local Attachment adapter requirement, and supplied master key without changing
PostgreSQL or files.

```sh
pnpm run backup -- create /srv/stash-backups/2026-08-23
pnpm run backup -- verify /srv/stash-backups/2026-08-23
pnpm run backup -- restore /srv/stash-backups/2026-08-23 --dry-run
# after stopping the Stash application:
pnpm run backup -- restore /srv/stash-backups/2026-08-23
```

Instance Administrators can instead open `/instance-admin/backups` in the React web client, enter
the separately configured `INSTANCE_ADMIN_TOKEN`, inspect the backups under `INSTANCE_BACKUP_PATH`,
and run the same restore preflight. A passing dry-run unlocks restore only for that backup; the
operator must then type its exact directory name. The protected boundary accepts backup names from
the configured root rather than arbitrary filesystem paths and returns stable diagnostics for
invalid manifests, checksum failures, unsupported versions, master-key mismatches, and incompatible
runtime configuration.

After a live administrative restore succeeds, Stash marks readiness unavailable and rejects API
traffic until the process is restarted. This prevents process-local state from being served across
the restored database boundary; restart the Instance, then validate readiness before reopening it.

Restore copies only the verified Attachment inventory into staging before touching PostgreSQL. It
then snapshots the current database, uses `pg_restore --single-transaction --exit-on-error`, and
atomically swaps the staged Attachment tree. A failed Attachment swap restores the pre-restore
database snapshot. Missing files, corruption, unsupported versions, a wrong master key, or an
incompatible Attachment adapter fail visibly. A failed backup is never published under its
destination name.

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
- `GET /` serves `apps/web/dist/index.html`; deployments must build the Vite application before starting Stash.
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
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run check
pnpm run test
pnpm run build
```

Run each client quality gate independently when working on the React application:

```sh
pnpm run test:unit
pnpm run test:integration
pnpm run test:browser
pnpm run test:a11y
```

The browser and accessibility commands build the Vite client, start a real Stash Instance, and wait on its readiness endpoint before running Playwright. The harness shuts the Instance down automatically and does not use arbitrary delays.

Acceptance tests bind a real ephemeral HTTP port and exercise the public protocol. Protocol-compatible database and Member-access fakes provide deterministic ownership, healthy, and recoverable-outage scenarios without bypassing the Instance HTTP boundary. `pnpm run smoke` targets a running, PostgreSQL-backed Instance and verifies both readiness and the Vite browser application.
