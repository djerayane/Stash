# Embedded storage compatibility ruling

Issue: #148
Ruling date: 2026-08-24

## Inventory

Stash's operational store is PostgreSQL-specific by design. The repository implementation currently relies on:

- explicit transactions, row locks, `SKIP LOCKED`, and transaction/session advisory locks;
- UUID, `BYTEA`, `TIMESTAMPTZ`, arrays, and JSONB columns and operators;
- `RETURNING`, `ON CONFLICT`, lateral joins, common table expressions, and catalog queries;
- JSON aggregation/construction/mutation and full-text-style ranked search expressions;
- atomic durable-job claiming and lease renewal;
- 67 lazily applied, idempotent schema definitions plus the Instance format migration lock;
- coordinated database/Attachment backup and master-key-separated encrypted authentication state.

No optional PostgreSQL extension is currently required. Redis is acceleration only and is not part of this storage contract.

## Ruling

Use PGlite as the embedded adapter. PGlite runs PostgreSQL compiled to WebAssembly and therefore preserves the SQL semantics above more closely than a query translator or SQLite adapter. Stash composes the existing `PostgresDatabase` repository implementation over a serialized pool adapter, keeping domain rules, authorization, HTTP interfaces, portable schemas, search, synchronization state, and durable jobs in one implementation.

The adapter is deliberately narrower than `pg.Pool`: one embedded PostgreSQL process supports one serialized checked-out client. This matches standalone's single-process contract. A second Instance process is rejected by the data-directory lock before the engine opens.

PGlite 0.5.x has an upstream transaction-helper filesystem synchronization defect. Stash does not use that helper: its existing explicit `BEGIN`/`COMMIT` paths are retained, and the adapter calls `syncToFs()` after each successful `COMMIT`. Relaxed durability is disabled. Removing that barrier is a correctness bug and must fail restart acceptance.

Embedded startup must fail preflight if any inventoried PostgreSQL behavior is unavailable. It must never rewrite or silently omit unsupported SQL. Raw PGlite data-directory dumps are only PGlite restore material, not the migration format for external PostgreSQL; standalone-to-external migration is a semantic copy validated through Stash's shared repository contract.

## Data-directory boundary

All standalone durable state is rooted beneath the selected directory:

- `database/` — embedded PostgreSQL data;
- `attachments/` — local Attachment objects;
- `backups/` — coordinated Instance Backups;
- `config/` — generated non-secret configuration;
- `.instance.lock` — exclusive writer ownership (PID only; no secret token).

The Instance master key remains an external operator input and is not stored in any of these paths.
