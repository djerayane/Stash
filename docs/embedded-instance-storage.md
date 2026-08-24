# Embedded Instance storage

The self-contained distribution runs the same Stash server and web application against embedded PostgreSQL. It requires no separately installed database. Bundle packaging and launchers are tracked separately; this document defines the storage contract they consume.

## Data directory

Set `STASH_DATA_DIR` to an operator-owned directory and omit `DATABASE_URL`. Stash creates `database`, `attachments`, `backups`, and `config` beneath it. `ATTACHMENT_STORAGE_PATH` and S3 configuration are rejected in this mode so durable state cannot escape the selected boundary.

The Instance master key remains external. Supply `INSTANCE_MASTER_KEY` through the launcher-created protected key-file environment boundary; Stash never writes it into the data directory, a backup, a migration artifact, diagnostics, or logs.

Only one process may open a data directory. A concurrent writer fails before PostgreSQL starts. A lock whose recorded process no longer exists is recovered on the next start. Clean shutdown flushes embedded PostgreSQL before releasing the lock.

## Backup and restart

Embedded coordinated backups use the existing Instance Backup manifest and integrity checks. Their database payload format is `pglite-data-directory-v1`; it is adapter-native restore material and must not be imported directly into external PostgreSQL. Attachments and non-secret configuration remain separate verified entries in the backup.

Startup runs the same idempotent schema preparation used by external PostgreSQL. Unsupported PostgreSQL syntax, catalog behavior, locking, search, synchronization, or durable-job behavior is a startup/contract failure, never a reduced feature mode.

## Migration to external PostgreSQL

The migration destination must be an empty compatible PostgreSQL Instance and an empty Attachment directory. Stop the standalone Instance first; the migration command obtains its exclusive data-directory lock and copies a serializable semantic snapshot through one destination transaction. Attachments are checksum-verified in a staging directory and cut over only with the database transaction. Failure removes staged destination state and leaves the source authoritative.

Store each key in an owner-private (`0600` on POSIX) file. Preserve mode configures the destination with the same key:

```sh
DESTINATION_DATABASE_URL='postgresql://…' pnpm migrate:embedded -- \
  --data-dir /srv/stash-standalone \
  --attachment-root /srv/stash/attachments \
  --mode preserve \
  --source-key-file /run/secrets/stash-master-key
```

Rotate mode requires distinct source and destination key files and re-encrypts protected authentication, recovery, invitation, OIDC, and key-check records while recomputing keyed lookups:

```sh
DESTINATION_DATABASE_URL='postgresql://…' pnpm migrate:embedded -- \
  --data-dir /srv/stash-standalone \
  --attachment-root /srv/stash/attachments \
  --mode rotate \
  --source-key-file /run/secrets/stash-old-key \
  --destination-key-file /run/secrets/stash-new-key
```

Master-key values are rejected on the command line. Configure the destination Instance to read the selected destination key file before cutover.
