# Final whole-branch fix report

Date: 2026-08-29
Branch: `codex/web-mobile-design-system-redesign`
Reviewed baseline: `e730cf6`
Verified implementation commit: `185fe27` (`fix: close final redesign review gaps`)

## Outcome

All 19 actionable findings in `final-branch-review.md` (S1-S11 and Q1-Q8) are addressed. The exact release gate completed with exit code 0 after the final source and native evidence were in place.

The review document is the durable red baseline for every row below. Focused acceptance tests were added before or alongside each production correction and then run green. Where a failing command transcript was captured during the last refinement pass, it is called out explicitly; other red entries describe the exact failing reviewed behavior instead of inventing a console transcript.

## Per-finding red/green evidence

| Finding | Red evidence | Green implementation and evidence |
| --- | --- | --- |
| S1 | Both font tokens resolved to the same Geist/system stack; no packaged display face existed. | Packaged the unmodified STIX Two Text variable font, OFL, and source notice; declared `Stash Editorial` with serif fallbacks and a distinct display token. `packages/tokens/scripts/check.mjs` asserts the local file, license, alias, and token distinction. The production web build emitted `stix-two-text-DV038M9q.ttf` (418.96 kB). |
| S2 | `New collection` followed reused Collection Views and Task Views. | `CollectionWorkspace` now renders Note-owned Collections, then the primary creation action, then reused views; `places primary Collection creation directly after the Note-owned Collections` verifies DOM order. |
| S3 | A hidden primary field made a new record unnamed and focused a different property. | The creation row temporarily includes the primary text property even when the View hides it and autofocuses by property identity; `keeps the primary text field available and focused when a View hides it` passes. |
| S4 | Collapsed View state exposed only an opaque numeric count. | The trigger now says, for example, `View · Filtered · Grouped · Compact`, with a fuller accessible label naming filter/sort/group/hidden-field state. Collection component and browser suites pass. |
| S5 | Cross-Note View cells edited the canonical record immediately. | The first cell activation now opens `Edit this canonical record?`, explains the shared source of truth, restores focus on cancel, and focuses the requested typed editor after acknowledgement. `discloses canonical impact once before editing through a cross-Note View` plus the browser cross-Note journey pass. |
| S6 | A stale delete token remained in the open dialog, causing repeated 409 responses. | The service and HTTP 409 now return the refreshed impact; the dialog replaces counts/token and requires confirmation again. `refreshes Collection deletion impact after a stale confirmation` and the HTTP stale-token assertion pass. |
| S7 | Mobile exposed Collections only through saved View Blocks and offered no record mutation. | The native Views tab now lists every cached Collection directly, opens its records, shows typed readable values, edits the primary text field, queues an encrypted `collection_record_edit`, applies it optimistically, and synchronizes through the canonical record route. Mobile component/sync tests and captures 10-12 prove the journey. |
| S8 | Durable native evidence ended at capture/outbox screens. | Added raw exact-device captures 09-12 for Workspace, direct Collection browser, record inspection, and synchronized edit; provenance and hashes are recorded below and in `docs/design/stash-mobile-direction/README.md`. |
| S9 | Browser coverage omitted property rename/reorder/delete, failure preservation, completed move/delete, and a motion assertion. | Added full Playwright journeys for those operations, including three failure modes that preserve a draft, completed impact actions, narrow/text-zoom checks, 44 px targets, reduced-motion computed styles, and axe. All 55 browser and 33 a11y tests pass. |
| S10 | Person/attachment/relation cells and typed filters exposed comma-delimited/raw identities. | Added permission-filtered member, attachment, Note, Task, Project, Collection, and record options. Cells/property setup/View filters use readable selectors while payloads retain stable IDs and relation fallbacks. `uses readable member, attachment, and relation selectors while storing stable identities`, `uses option-aware filters and Collection labels for typed relation setup`, and guest non-disclosure service assertions pass. |
| S11 | Note Tree, Collection presentation, option, and recovery targets measured about 28-36 px. | Relevant controls now use the 44 px `--stash-control-height` hit area; the checkbox keeps a compact glyph inside a 44 px label. Browser coverage measures primary Collection and Note Tree controls at narrow width and remains axe-clean. |
| Q1 | The complete deletion impact was URL-encoded into the token and could exceed the 64 KiB request limit. | Impact confirmation is now a bounded `sha256:` digest over the exact Note/scope/impact. The 420-relation HTTP case asserts a token at most 100 bytes and successfully completes deletion through HTTP. |
| Q2 | Relation updates locked only the source and could restore a target deleted while the update waited. | Relation writes lock referenced target Collections in sorted order, key-lock and revalidate target records, and reject missing targets before value/projection writes. The concurrent write/delete service case plus a post-delete stale write assert that the repaired relation remains empty. |
| Q3 | Rapid/offline Task taps queued multiple operations with one stale base revision and offered no genuine-conflict recovery. | Canonical Task updates serialize and coalesce by Task, pending status actions disable synchronously, successful responses refresh cached revision, only real 409 revision conflicts are marked, and `Use server Task version` discards/reloads. During red refinement, the simultaneous-tap test produced two mutations; it now produces one. The sync suite covers repeat/simultaneous coalescing, rebase, genuine conflict, discard, and 503 non-conflict behavior. |
| Q4 | Mobile collapsed multi-value groups into one comma-joined synthetic group. | Mobile now expands multi-select and relation values into each web-equivalent group, includes `No value`, keys relations by readable fallback like the web evaluator, and counts unique records. During red refinement, same-fallback relations split and one record reported as two; both cases are green in model/component tests. |
| Q5 | Switching existing records to Board hid records without a value. | Board renders an explicit `No value` column and can move records into/out of it; multi-select moves preserve other groups. Component and browser Board tests pass without artificial record backfill. |
| Q6 | Concurrent clients repeatedly proposed the same client-derived append position. | Property and record append positions are allocated as `MAX(position)+1` while holding the server Collection lock; callers keep their stable object IDs. The concurrent property and record append service test verifies both requests succeed with contiguous positions. |
| Q7 | Screen-local stores/repositories/barriers could lose or resurrect whole-value encrypted outbox writes. | Native and web store wrappers now share process-wide repository/cipher instances, and all encrypted state reads/writes use one process-wide barrier. `does not lose an update across independent stores sharing one repository` deterministically delays interleaved writes and passes. |
| Q8 | Arrow navigation clamped against all canonical records rather than filtered rendered rows. | Navigation now clamps against `evaluated.records` and visible table properties, including empty bounds. `keeps filtered arrow navigation bounded to rendered rows` passes. |

## Focused TDD verification

- Collection web unit: `collection-cell.test.tsx` + `collection-editor.test.tsx` — 22/22 passed.
- Mobile reader/store unit: reader model + reader component + independent encrypted-store race — 17/17 passed.
- Mobile sync unit: `packages/sync/src/mobile-workspace.test.ts` — 13/13 passed.
- Collection service: `tests/knowledge-authoring/collections.test.ts` — 10/10 passed.
- Collection HTTP: `tests/knowledge-authoring/collections-http.test.ts` — 1/1 passed, including stale impact and the large bounded confirmation.
- Browser Collection journeys: 8 scenarios are present; 7 run in the browser gate and the tagged accessibility scenario runs in the a11y gate.

## Exact release gate

Command, run from the repository root after the final native evidence and README update:

```sh
pnpm test && pnpm run check && pnpm run build && pnpm run test:browser && pnpm run test:a11y && pnpm run test:stable-release && git diff --check
```

Result: exit code 0.

- `pnpm test`: 333/333 server tests plus 215/215 workspace package tests passed (548 total): domain types 6, validation 7, API client 9, sync 13, web 144, mobile 36. Token checks passed; rich-text has no unit files.
- `pnpm run check`: server and every participating workspace TypeScript/token check passed.
- `pnpm run build`: server, all participating packages, web, and Expo web export passed. The web build bundled the local STIX font.
- `pnpm run test:browser`: 55/55 passed.
- `pnpm run test:a11y`: 33/33 passed.
- `pnpm run test:stable-release`: 2/2 passed.
- `git diff --check`: passed with no whitespace errors.

The build emitted only the pre-existing/non-blocking Vite large-chunk advisory and Expo warning that `ios.appleTeamId` is not configured.

## Native Android provenance

- Package: `app.stash.capture`, version `0.1.0` / version code 1.
- AVD: `Pixel_9_Pro_API_36`, `sdk_gphone64_arm64`, Android 16 / API 36.
- Raw capture dimensions: 1280 by 2856 RGBA PNG; no device frame or retouching.
- APK: fresh debug build from the final mobile source in commit `185fe27`'s working tree, with `assets/index.android.bundle` embedded (1,989,040 bytes).
- APK SHA-256: `8992360140fa605a29ba6315b1bea6bedf46c5e71fee7232be32009271d60e52`.
- Fixture: disposable authenticated HTTPS proxy on 43128, temporary debug-only trusted CA, `adb reverse tcp:43128 tcp:43128`, real `startInstance` services, and a deterministic canonical `Native research` Collection seeded through its HTTP route.
- Journey: clean app data; pair; synchronize Workspace; open direct Collection; inspect `Interview synthesis`; edit to `Interview findings`; synchronize; verify a canonical Collection GET returned `Interview findings`.
- `09-workspace-reader.png`: `38575db29b4061165a93dddf83c8f6eec5bf98ca5c9c24458915499917196f76`.
- `10-collection-browser.png`: `33255ead5880ae78c73890af8b9f45dab6446fe954b8f2763e8941c488b6d22c`.
- `11-collection-record.png`: `cf045c5f8911fb8f71b3b5a4e84409ee2b2f976f2a27461d0ac9bfd664ce3809`.
- `12-collection-record-synced.png`: `3afc04d74896e1c9cff3d9bc8ad523a562be03d14d2769b2e61524dd687f8232`.
- All four screens were inspected after pulling them from the emulator. The generated Android project was moved out of the repository after the capture; no disposable key, certificate, debug trust configuration, or APK is committed.

## Self-review

- Permissions: selector queries are workspace/member scoped; guests receive only their own member identity and permitted Notes, Projects, associated Tasks, and relations. The service test asserts inaccessible titles, IDs, and owner identity do not appear.
- Portability/canonical records: selectors store stable identities; relations retain readable fallbacks; mobile mutations patch the canonical record route; no copied record type or device-only canonical object was introduced.
- Encryption/offline integrity: snapshots and mutation outboxes remain encrypted; the shared process barrier covers independent screen store instances; pending mutations remain pairing-scoped.
- Concurrency: Collection append allocation and relation target revalidation occur under database locks; Task changes coalesce and update cached revisions; stale impact confirmation is recomputed transactionally.
- Accessibility: filtered keyboard movement follows rendered rows, first-edit disclosure restores/focuses the right control, and affected targets are at least 44 CSS pixels.
- Repository hygiene: generated Android and Playwright result directories are outside the working tree; `git diff --check` and the exact gate are green.

## Commits and remaining concerns

- `185fe27` — `fix: close final redesign review gaps` — all implementation, tests, packaged font/license, and exact native captures/provenance.
- The document-only commit containing this report is identified in the final handoff because a file cannot contain the immutable hash of the commit that first adds itself.

No known functional review finding remains.

Residual verification limits:

- Native appearance/provenance was captured on Android only; iOS was not captured or verified.
- `STASH_TEST_DATABASE_URL` was not configured, so the repository's optional external-PostgreSQL-only suites were not exercised by this local gate. The new Collection locking/concurrency coverage ran through the embedded PostgreSQL-compatible store and the SQL paths passed type/build/service gates.
- The production build still reports the existing large JavaScript chunk advisory, and Expo reports the existing missing iOS team configuration warning; neither failed the requested gate.
