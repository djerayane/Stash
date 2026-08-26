# Install and operate Stash

Stash publishes one Instance through four paths. Choose source Compose when evaluating a checkout or developing; choose the prebuilt container when you want the supported PostgreSQL deployment without compiling Stash; choose a standalone bundle when the machine should need neither Docker nor a separate database; install a mobile artifact only as a client for an existing HTTPS Instance.

## Localhost evaluation from a checkout

### Prerequisites

- Git and Docker with the Compose v2 plugin.
- Enough disk for the application image, PostgreSQL image, and three persistent volumes.

From the repository root, start the Instance:

```sh
docker compose up -d
```

Open <http://localhost:3000>. The source port mapping is exactly `127.0.0.1:${STASH_PORT:-3000}:3000`, so the default evaluation Instance is reachable only from the local machine. Check startup and readiness with:

```sh
docker compose ps
docker compose logs stash
```

The localhost evaluation enables account creation and uses public, deterministic development credentials. It is not a production configuration and must never be exposed to another network.

Compose persistence keeps PostgreSQL, Attachments, and Instance Backups in the named volumes `stash-postgres`, `stash-attachments`, and `stash-backups`. Ordinary lifecycle commands retain them:

```sh
docker compose stop
docker compose start
docker compose down
```

Do not add `--volumes` unless you intend to delete the Instance data.

## Prebuilt container image

Published images are `ghcr.io/djerayane/stash:<version>` for `linux/amd64` and `linux/arm64`. They run the same application and external PostgreSQL deployment as the source-built Compose path. A checkout is still required for its `compose.yaml`, but no local application build is required:

```sh
STASH_IMAGE=ghcr.io/djerayane/stash:1.2.3 docker compose up -d --no-build
```

The version tag is convenient; the OCI manifest digest recorded by the release workflow is the immutable identity. Production automation should pin it:

```sh
STASH_IMAGE=ghcr.io/djerayane/stash@sha256:<manifest-digest> docker compose up -d --no-build
```

Before production use, create unique `INSTANCE_ADMIN_TOKEN`, `INSTANCE_MASTER_KEY`, and `POSTGRES_PASSWORD` values, set the canonical HTTPS `PUBLIC_ORIGIN`, and put Stash behind the intended firewall and TLS reverse proxy. Only then set `STASH_BIND_ADDRESS` to a non-loopback address. The application rejects evaluation credentials and an HTTP origin on an external bind.

```sh
export INSTANCE_ADMIN_TOKEN="$(openssl rand -base64 48)"
export INSTANCE_MASTER_KEY="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD="Aa1-$(openssl rand -hex 24)"
export PUBLIC_ORIGIN="https://stash.example.com"
export STASH_BIND_ADDRESS="0.0.0.0"
docker compose up -d
```

Store `INSTANCE_MASTER_KEY` outside PostgreSQL and backups. Compose fixes `INSTANCE_BACKUP_PATH` to `/var/lib/stash/backups`, backed by the `stash-backups` named volume. Create a coordinated backup through the protected API and verify its health:

```sh
curl -X POST https://stash.example.com/api/instance/backups -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN"
curl https://stash.example.com/api/instance/backups/health -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN"
```

The create response returns its safe relative `path`. Copy that directory off the Docker host without altering the named volume; refuse to overwrite an earlier copy:

```sh
BACKUP_NAME=2026-08-25T02-30-00.000Z
mkdir -p ./stash-backups
test ! -e "./stash-backups/$BACKUP_NAME"
docker compose cp "stash:/var/lib/stash/backups/$BACKUP_NAME" "./stash-backups/$BACKUP_NAME"
```

Preserve the matching `INSTANCE_MASTER_KEY` separately. A copied backup is not complete disaster-recovery material without that key.

### Upgrade a container Instance

Starting a new container does not upgrade durable Instance data. First take and verify a backup, set `STASH_IMAGE` to the desired immutable digest, then replace only the application container:

```sh
docker compose pull stash
docker compose up -d --no-build stash
```

The new application exposes a protected plan without mutating data. Read it, require every check to pass, and submit the exact returned `targetVersion` as `confirmation`:

```sh
export STASH_URL=https://stash.example.com
UPGRADE_PLAN="$(curl --fail "$STASH_URL/api/instance/upgrade" -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN")"
TARGET_VERSION="$(printf '%s' "$UPGRADE_PLAN" | jq -er 'select(.status == "ready") | .targetVersion')"
curl --fail -X POST "$STASH_URL/api/instance/upgrade" \
  -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data "{\"confirmation\":\"$TARGET_VERSION\"}"
```

The successful POST creates its own verified rollback backup, applies the migration, and returns `"restartRequired":true`; readiness then deliberately returns 503. Restart the application process and require readiness before reopening traffic:

```sh
docker compose restart stash
curl --retry 20 --retry-delay 1 --retry-connrefused --fail "$STASH_URL/health/ready"
docker compose ps
```

Never infer upgrade success from `docker compose up`. The supported sequence is protected GET plan, POST exact target-version confirmation, restart, then readiness.

## Self-contained Instance bundle

The standalone distribution contains the compiled server and web application, its Node runtime, an embedded PostgreSQL-compatible engine, and local Attachment storage. It stands alone: the target machine needs no Docker, Node, pnpm, or separately installed database.

### Select and verify an archive

Each GitHub Release publishes `SHA256SUMS`, an adjacent `.sha256` file for each archive, and these architectures:

| Operating system | Archive |
| --- | --- |
| Linux x64 | `stash-instance-<version>-linux-x64.tar.gz` |
| Linux arm64 | `stash-instance-<version>-linux-arm64.tar.gz` |
| macOS Intel | `stash-instance-<version>-darwin-x64.tar.gz` |
| macOS Apple silicon | `stash-instance-<version>-darwin-arm64.tar.gz` |
| Windows x64 | `stash-instance-<version>-win32-x64.zip` |

Verify the archive before extracting it. For example, on Linux:

```sh
sha256sum --check stash-instance-1.2.3-linux-x64.tar.gz.sha256
tar -xzf stash-instance-1.2.3-linux-x64.tar.gz
```

On macOS use `shasum -a 256 -c <archive>.sha256`. On Windows compare `(Get-FileHash .\stash-instance-1.2.3-win32-x64.zip -Algorithm SHA256).Hash` with the first value in the adjacent checksum file, then expand the ZIP.

### Start, stop, and persist

Choose one durable, absolute data directory and reuse it on every start:

```sh
cd stash-instance-1.2.3-linux-x64
./stash --data-dir /srv/stash-standalone
```

Windows uses the same options:

```powershell
stash.cmd --data-dir C:\Stash\data
```

Open <http://localhost:3000>. The standalone launcher binds to loopback by default, creates its embedded storage on first start, and holds an exclusive process lock; a second process cannot use the same data directory. Stop it with `Ctrl-C` or the service manager's normal termination signal, and restart with the same one-command start. Database files, Attachments, backups, and generated non-secret configuration remain beneath the selected data directory. The generated master-key file is outside that directory by design; protect and back it up separately.

Do not expose the first-run localhost evaluation configuration. The current standalone launcher deliberately supports loopback operation only. For a networked production deployment, migrate the complete Instance to the external-PostgreSQL path below, configure production secrets and a canonical HTTPS public origin there, and place that deployment behind the intended TLS reverse proxy and firewall.

### Back up and upgrade

Stop the standalone process before offline backup or restore. Backup paths must be absolute:

```sh
./stash backup create --data-dir /srv/stash-standalone --backup /srv/stash-backups/pre-upgrade
./stash backup verify --data-dir /srv/stash-standalone --backup /srv/stash-backups/pre-upgrade
./stash backup restore --data-dir /srv/stash-standalone --backup /srv/stash-backups/pre-upgrade --dry-run
./stash backup restore --data-dir /srv/stash-standalone --backup /srv/stash-backups/pre-upgrade
```

An Instance Backup never contains `INSTANCE_MASTER_KEY`; preserve the matching key file independently. To upgrade, verify the new archive's SHA-256 checksum, create and verify a backup with the old launcher, and stop the old process. Starting the new launcher against the existing data directory does not upgrade it automatically.

Start the new launcher with the same one-command start in one terminal:

```sh
./stash --data-dir /srv/stash-standalone
```

In another terminal, use the same protected protocol against the loopback Instance:

```sh
export STASH_URL=http://localhost:3000
export INSTANCE_ADMIN_TOKEN=stash-development-only-admin-token
UPGRADE_PLAN="$(curl --fail "$STASH_URL/api/instance/upgrade" -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN")"
TARGET_VERSION="$(printf '%s' "$UPGRADE_PLAN" | jq -er 'select(.status == "ready") | .targetVersion')"
curl --fail -X POST "$STASH_URL/api/instance/upgrade" \
  -H "Authorization: Bearer $INSTANCE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data "{\"confirmation\":\"$TARGET_VERSION\"}"
```

After the POST returns `"restartRequired":true`, stop the launcher normally, run `./stash --data-dir /srv/stash-standalone` again, and require `curl --fail "$STASH_URL/health/ready"` to succeed. The upgrade service creates a rollback point before changing durable state and restores it when migration fails. A failed rollback keeps the Instance offline for manual recovery.

### Migrate standalone storage to external PostgreSQL

Migration requires a prepared but otherwise empty, compatible destination PostgreSQL Instance, empty destination Attachment and configuration directories, adequate measured capacity, and a stopped source holding its exclusive process boundary. The destination is not a raw empty database: it must already contain the release schema, matching Instance format, and singleton authentication key check created with the intended destination `INSTANCE_MASTER_KEY`. The command stages and validates all data before cutover; on validation, copy, checksum, or re-encryption failure it rolls back the destination and leaves the standalone source authoritative and restartable.

`INSTANCE_MASTER_KEY` stays outside both storage engines and is never copied into migration output or passed as a command-line value. Use permission-protected key files. In preserve mode the destination key file is the source key file; in rotate mode it is the distinct destination key file.

Prepare a newly created PostgreSQL database with the same release version as the standalone archive. The bundled preparation command creates every empty semantic table, writes the authentication key check with the selected protected key file, and records the bundle's Instance format. It does not copy source data or start an Instance.

For preserve mode, select the source key file as the destination key boundary:

```sh
export DESTINATION_DATABASE_URL='postgresql://stash:strong-password@db.example/stash'
export STASH_DESTINATION_KEY_FILE=/srv/.stash-standalone.master-key
./stash migrate prepare-destination --mode preserve --source-key-file "$STASH_DESTINATION_KEY_FILE"
```

For rotate mode, initialize with the distinct destination key while still supplying the source key so the same protected input contract is checked:

```sh
openssl rand -base64 32 > /run/secrets/stash-destination-key
chmod 600 /run/secrets/stash-destination-key
export STASH_DESTINATION_KEY_FILE=/run/secrets/stash-destination-key
./stash migrate prepare-destination --mode rotate --source-key-file /srv/.stash-standalone.master-key --destination-key-file "$STASH_DESTINATION_KEY_FILE"
```

The initializer rejects every pre-existing user object in the destination schema, including relations, functions, types, collations, operators and their classes or families, conversions, text-search objects, extended statistics, extensions, constraints, and schema-specific default privileges. It creates the complete schema, authentication key check, and Instance format in one transaction on one connection. Every preparation advisory lock belongs to that transaction. Any failure rolls the transaction back, releases its locks, and leaves no partial key boundary or schema, so the same protected command can be retried against the still-empty destination. It reports `"status":"prepared"` only after commit and exits before migration, leaving no destination application process that could race writes. A raw empty database or a normally started application without this preparation is insufficient. Verify the destination has no accounts, Organizations, Workspaces, or other domain rows, and create empty operator-owned Attachment and configuration roots:

```sh
install -d -m 700 /srv/stash-postgres/attachments /srv/stash-postgres/config
```

In preserve mode, configure the destination Instance to reference the same key as the source. Do not supply a destination key file:

```sh
export DESTINATION_DATABASE_URL='postgresql://stash@db.example/stash'
export DESTINATION_DATABASE_AVAILABLE_BYTES=107374182400
./stash migrate --data-dir /srv/stash-standalone --attachment-root /srv/stash-postgres/attachments --configuration-root /srv/stash-postgres/config --mode preserve --source-key-file /srv/.stash-standalone.master-key
```

In rotate mode, configure the destination Instance with a distinct new key and pass both protected files so encrypted authentication, recovery, and integration state is re-encrypted:

```sh
./stash migrate --data-dir /srv/stash-standalone --attachment-root /srv/stash-postgres/attachments --configuration-root /srv/stash-postgres/config --mode rotate --source-key-file /srv/.stash-standalone.master-key --destination-key-file /run/secrets/stash-destination-key
```

Only cut traffic over after the command reports `"status":"migrated"`, the destination uses the intended key, migrated accounts can authenticate, authorization checks succeed, Attachments match their checksums, and the destination health check is ready. On Windows use `stash.cmd migrate` with the same options.

## Mobile artifacts

Mobile builds are clients, not an Instance. Install one only after an operator has published a production Stash Instance at a canonical HTTPS URL; on first launch, pair directly with that HTTPS Instance. Stash provides no hosted relay.

Release workflow artifact names are:

- `stash-capture-<version>-android-apk`: directly installable Android preview APK for prerelease and stable tags.
- `stash-capture-<version>-android-aab`: Play Store AAB for stable tags; it is not directly installable.
- `stash-capture-<version>-ios-ipa`: signed IPA for stable tags only when live Apple signing capability is configured.

Android signing is required for release publication. iOS is conditional and its absence never suppresses Android; do not claim an IPA unless the workflow actually produced `stash-capture-<version>-ios-ipa`.

The app is linked to the EAS project `@imnibis/stash-capture`. Its non-secret project UUID, `6441a17d-b6df-4442-909e-aa01813993f4`, is committed in `apps/mobile/app.json`; the protected `mobile-release` GitHub environment repeats that value as `EAS_PROJECT_ID` and supplies `EXPO_TOKEN` only to authenticated tag-release jobs. The remote Android `versionCode` and iOS `buildNumber` baselines are both initialized to `1`, and Android signing is configured in EAS. These statements describe the current operator configuration, not credentials stored in the repository.

An iOS artifact remains capability-gated even with that baseline initialized. Stable-tag preflight queries EAS for a live, unexpired Apple distribution certificate and App Store provisioning profile; it publishes and claims an IPA only when that probe succeeds. Missing or expired Apple credentials report the iOS capability as unavailable without suppressing the Android release.

APK users may need to allow installation from the download source. Store AAB and IPA distribution must follow Google Play and Apple provisioning rules. In every case, verify the workflow run, tag, source revision, and recorded artifact metadata before installation.
