# Final scoped re-review closure report

Date: 2026-08-29
Branch: `codex/web-mobile-design-system-redesign`
Reviewed baseline: `b41590e`
Verified implementation commit: `119f0e3` (`fix: close scoped redesign rereview`)

## Outcome

All nine Important findings in `final-scoped-rereview.md` (R1-R9) are addressed. The final reviewed source passes the exact repository release-gate commands. No permission bypass, copied canonical record, plaintext mobile state, or portability regression was introduced.

The re-review is the durable red baseline below. Focused tests were added before implementation wherever the behavior could be reproduced locally. R8's real PostgreSQL deadlock regression has both embedded coverage and an optional external-PostgreSQL suite; the latter could not run because `STASH_TEST_DATABASE_URL` is not configured.

## Per-finding red/green evidence

| Finding | Red evidence | Green implementation and evidence |
| --- | --- | --- |
| R1 / S1 | Activating the packaged STIX display face made dense administration, Task, menu, table, and form-adjacent headings serif. The new token audit initially failed on remaining dense consumers. | Dense system surfaces now use the interface sans. Display use is limited to the Note title, first-run setup statements, and starter tutorial. `packages/tokens/scripts/check.mjs` recursively maps every actual CSS rule containing `--stash-font-display` to the four allowed selectors; token check, repository check, and builds pass. |
| R2 / S5 | The new Board regression showed a cross-Note move could PATCH the shared record without opening `Edit this canonical record?`. | Table activation and Board moves now enter one `requestCanonicalRecordMutation` acknowledgement gate. Confirmation executes the saved mutation; cancellation resolves without mutation and restores the exact trigger. `collection-editor.test.tsx` is 16/16, including the Board disclosure/focus regression. |
| R3 / S7 | Reader tests exposed UUID strings for Person and Attachment values. The queue/sync recovery test was red before `collection-record-update.ts` existed, and the previous combined catch offered synchronization even when no mutation had been stored. | The snapshot carries permission-filtered Member/file label maps. Typed rendering uses labels or `Unavailable Member` / `Unavailable file`, never stable IDs. Queue failure retains the draft and retries enqueue with an explicit “not saved on this device” status; post-queue failure retries only synchronization with an explicit durable-local-save status. Reader/model/helper tests pass. |
| R4 / S11 | Focused browser measurement found the inline retry about 15 CSS px high and Board controls about 24 CSS px high. | Inline recovery, Board cards, every move choice, and failed-move retry now have at least a 44 by 44 CSS-pixel hit area. The Collection recovery and Board browser journeys assert both dimensions and pass in the 55-test browser gate. |
| R5 / Q6 | A deterministic stale-after-commit property append reached service validation with the same client position and failed as `InvalidCollectionInput`, never reaching the locked allocator. | The service validates the incoming property independently. The repository locks the Collection, allocates `MAX(position)+1`, and persists the stable client property ID. The staggered regression now produces positions 4 and 5; the complete 11-test Collection contract suite passes. |
| R6 | Offline Collection PATCH was last-write-wins and replay had no receipt. Revision/conflict tests initially observed no revision envelope and no protected stale outcome. | Canonical records have monotonically increasing revisions. Mobile sends stable `operationId`, `baseRevision`, and typed values. PostgreSQL stores a per-record operation digest/outcome receipt: identical replay returns the original outcome without overwriting intervening work, operation reuse with another payload conflicts, and stale base revision returns the current record without applying values. Mobile retains conflicts, supports new-operation reconciliation against the latest cached revision, and explicitly discards to the server version. A compatibility migration upgrades pre-revision queued edits from the cached record without changing their operation ID. HTTP, sync, component, check, and build gates pass. |
| R7 | A readable Project Guest snapshot had no edit-access contract, rendered an editor, allowed enqueue, and retained the inevitable 404 indefinitely. | Collection list responses and cached snapshots carry `{read, edit}` access. Missing legacy access fails safe as read-only. Read-only Collections remain inspectable but have no editor; enqueue also refuses independently. Permanent 403/404/422 Collection rejections are marked and can be safely discarded, revealing the underlying server snapshot. Permission, sync, reader, and discard/reset regressions pass. |
| R8 / Q2 | The reviewed lock graph acquired source A before target B and source B before target A, permitting PostgreSQL SQLSTATE `40P01`. | Record create/update now authorizes the source, then locks every Collection in the Workspace in global ID order before source/target record validation. Target records are key-locked in sorted order and cross-Workspace targets are rejected. Reciprocal A-to-B/B-to-A writes both complete in the embedded contract test. `postgres-collection-concurrency.test.ts` supplies the same real-PostgreSQL regression when `STASH_TEST_DATABASE_URL` is available. |
| R9 / Q7 | The two-client split-outcome regression initially let a successful client remove an operation and a slower 503 client save its stale copy again. | A module/process-wide synchronization coordinator serializes complete sync ownership across live `MobileCaptureClient` instances. The second client reads the outbox only after the first completes, so an applied operation is absent and no second network request or resurrection occurs. The two-client regression and the full 19-test sync suite pass. |

## Focused TDD verification

- Token/display placement: `pnpm --filter @stash/tokens check` — passed with four allowed editorial selectors and no other display-face consumers.
- Collection web unit: `apps/web/src/knowledge-authoring/collection-editor.test.tsx` — 16/16 passed.
- Mobile reader model/component/update helper — 21/21 passed (8 model, 11 component, 2 queue/sync recovery).
- Mobile sync: `packages/sync/src/mobile-workspace.test.ts` — 19/19 passed, including access refusal, legacy mutation upgrade, conflict/reconcile/discard, permanent rejection, and two-client coordination.
- Domain types: 6/6 passed.
- Collection contracts: 11/11 passed, including staggered append and reciprocal relations.
- Collection HTTP: 1/1 passed, including record revision, receipt replay, intervening edit, and stale conflict assertions.
- Optional real PostgreSQL Collection concurrency: suite added; skipped because `STASH_TEST_DATABASE_URL` is absent.
- Focused browser recovery and Board journeys passed before the full browser gate.

## Exact release gate

Commands run sequentially from the repository root after the final source review:

```sh
pnpm test
pnpm run check
pnpm run build
pnpm run test:browser
pnpm run test:a11y
pnpm run test:stable-release
git diff --check
```

Final result: every command exited 0.

- `pnpm test`: 334/334 server tests and 227/227 workspace-package tests passed (561 total): domain types 6, validation 7, API client 9, sync 19, web 145, mobile 41. Token checks passed; rich-text has no unit files.
- `pnpm run check`: server and every participating workspace TypeScript/token check passed.
- `pnpm run build`: server, packages, production web, and Expo web export passed.
- `pnpm run test:browser`: 55/55 passed.
- `pnpm run test:a11y`: 33/33 passed on the final full rerun.
- `pnpm run test:stable-release`: 2/2 passed.
- `git diff --check` and staged `git diff --cached --check`: passed.

One first full a11y attempt reached the stable journey's `/restart` call at the 30-second test timeout after 31 tests had passed. The identical isolated journey then passed in 4.0 seconds, including restart and post-restart sign-in; the complete a11y suite rerun passed 33/33 with that journey at 4.1 seconds. No source change was needed or made for the transient timing outlier.

The build retains the existing non-blocking Vite large-chunk advisory and Expo warning that `ios.appleTeamId` is not configured.

## Native Android provenance

The checked-in normal editable Workspace/Collection states 09-12 were inspected again. This closure does not alter their visible state: the fixture contains text and select properties with edit access; record revision/operation receipts are invisible, and the new Guest, enqueue-failure, permanent-rejection, conflict, reconcile, and discard UI appears only in conditional states outside those captures. The closure instruction required recapture only when the evidenced UI visibly changed, so the exact durable provenance was preserved rather than replacing byte-identical target states.

- Package: `app.stash.capture`, version `0.1.0` / version code 1.
- AVD: `Pixel_9_Pro_API_36`, `sdk_gphone64_arm64`, Android 16 / API 36.
- Existing exact APK SHA-256 for captures 09-12: `8992360140fa605a29ba6315b1bea6bedf46c5e71fee7232be32009271d60e52`.
- Raw captures: 1280 by 2856 RGBA Android `screencap`, no device frame or retouching.
- `09-workspace-reader.png`: `38575db29b4061165a93dddf83c8f6eec5bf98ca5c9c24458915499917196f76`.
- `10-collection-browser.png`: `33255ead5880ae78c73890af8b9f45dab6446fe954b8f2763e8941c488b6d22c`.
- `11-collection-record.png`: `cf045c5f8911fb8f71b3b5a4e84409ee2b2f976f2a27461d0ac9bfd664ce3809`.
- `12-collection-record-synced.png`: `3afc04d74896e1c9cff3d9bc8ad523a562be03d14d2769b2e61524dd687f8232`.
- Fixture/journey details remain in `docs/design/stash-mobile-direction/README.md`.

Conditional closure behavior is covered by native-component, reader-model, encrypted-store, and sync tests rather than relabeling the existing captures as proof of states they do not show.

## Self-review

- Permissions/privacy: Project Guests receive readable Collections with `edit: false`; attachment values are removed, Person values are limited to visible Members, label maps are permission-filtered, and unknown typed identities render a neutral unavailable label rather than a UUID.
- Portability/canonical records: the canonical Collection record remains the only record. Revision is additive to `stash.collection.v1`; selectors and relations retain stable IDs/fallbacks; legacy snapshots normalize read-only, and legacy queued edits acquire a safe cached base revision.
- Offline integrity/encryption: snapshots and outboxes stay behind the encrypted store. Queue failure never claims durability; committed local mutations survive sync failure. Process-wide write and sync barriers prevent local lost updates and cross-client resurrection.
- Idempotency/conflicts: operation receipts are record-scoped, payload-digested, transactionally written under the record lock, and cascade with record deletion. Stale values are preserved for explicit reconcile/discard rather than silently winning.
- Concurrency: all Collections in a Workspace are locked in one order before relation target checks. This is deliberately coarse correctness-first serialization; it can reduce write concurrency in a Workspace but avoids reciprocal lock inversion.
- Accessibility/UX: the shared cross-Note mutation gate restores focus on cancel; Board/card/retry targets are measured at 44 CSS px; readable mobile metadata contains no raw stable IDs; discarded optimistic drafts reset to the current server value.
- Typography: a recursive rule-level gate prevents future dense-surface use of the editorial face.
- Repository hygiene: no Playwright result directory or disposable native fixture is committed; final whitespace checks pass.

## Commits and remaining concerns

- `119f0e3` — `fix: close scoped redesign rereview` — R1-R9 implementation and focused tests.
- The document-only commit containing this report is identified in the final handoff because this file cannot contain the immutable hash of the commit that first adds itself.

No known functional R1-R9 finding remains.

Residual verification limits and operational concerns:

- `STASH_TEST_DATABASE_URL` was unavailable, so the new real-PostgreSQL reciprocal-lock suite and the repository's existing external Note Tree suite were skipped. Embedded concurrency, SQL compilation, HTTP, and service gates are green.
- Workspace-wide Collection locking is safe but intentionally coarse; a narrower globally ordered source-plus-target scheme may be an optimization later.
- Native evidence remains Android-only; iOS was not captured or verified.
- The conditional read-only/conflict/recovery states added in this closure have automated native-component evidence but no new device screenshots because the existing captured journey did not visibly change.
- The pre-existing Vite chunk-size and missing `ios.appleTeamId` warnings remain.
