# Final exact re-review — `3f233a1..cad9ba8`

## Verdict

- **Spec compliance: FAIL** — 0 Critical, 1 Important, 0 Minor.
- **Code quality: FAIL** — 0 Critical, 1 Important, 0 Minor.
- **Combined unique count:** 0 Critical, 1 Important, 0 Minor.

The exact diff resolves four of the five Important closure findings: cross-Note record creation now uses the shared disclosure gate while preserving the staged draft and focus; historical Collection receipts cannot replace a higher cached revision; `permanentFailure` is mutable encrypted-outbox metadata; and conflict/permanent entries are terminal to ordinary synchronization. The legacy pre-revision edit is safely prevented from being sent automatically, but its explicit reconcile path still cannot establish an authoritative concurrency base.

## Scope and method

Reviewed the immutable range `3f233a19b5261d3ceb303adc32ae1119bd420a37..cad9ba8` against the five Important findings in `closure-rereview.md`. The repository-required `gpt-taste` and `frontend-design` skills were read before review. Spec compliance and code quality were assessed separately.

Per instruction, tests were not rerun and source was not modified. This report is the only review artifact added.

## Actionable finding

### [Important] [Spec + Quality] Legacy Collection reconciliation still invents its new base from a potentially stale cache

The sync loop now correctly stops a pre-revision Collection mutation, marks it conflicted, and does not send it (`packages/sync/src/index.ts:508-514`). However, the user-facing recovery action calls `reconcileCollectionRecordEdit` directly and then synchronizes (`apps/mobile/app/workspace.tsx:154-158`). `reconcileCollectionRecordEdit` reads the existing local workspace snapshot and assigns `record.revision ?? 1` as the new operation's `baseRevision` (`packages/sync/src/index.ts:323-330`); it does not refresh the Collection from the server first or otherwise prove that this revision is the current canonical base.

That leaves the original divergent-history case open after one tap: an old queued edit and its cached record may both normalize to revision 1, while deployment also labels an independently changed server row revision 1. The first ordinary sync now preserves the edit, but “reconcile” immediately recreates it with the same unproven base 1 and the following sync can silently overwrite the intervening server edit. The new regression only asserts that the first sync makes no request and sets `conflict`; it does not exercise the actual reconcile action against divergent server state (`packages/sync/src/mobile-workspace.test.ts:162-177`).

**Required:** before converting a legacy conflicted edit into a new operation, fetch and persist the authoritative canonical Collection record (or require an already refreshed snapshot with verifiable provenance), then use that server revision as the new base while preserving the local values. If the refresh cannot complete, leave the legacy edit terminal and unchanged. Add a regression that performs the reconcile action with cached revision 1 and a divergent server revision/value, and proves the new operation uses the refreshed server revision.

## Five-finding closure matrix

| Prior finding | Result | Evidence |
| --- | --- | --- |
| R2 cross-Note record creation bypass | **Resolved** | Both Save and field confirmation route through `requestCanonicalRecordMutation`; cancellation retains `newValues` and restores the Save trigger. |
| R6 unprovable legacy base | **Partial** | Ordinary sync no longer sends it, but explicit reconcile still assigns a base from the unverified cached record. |
| R6 historical receipt cache rollback | **Resolved** | `#applySuccessfulMutation` refuses a remote record whose revision is below the cached record revision; success and conflict receipt tests cover the monotonic projection. |
| R7 encrypted-store permanent marker rejection | **Resolved** | `mutationContribution` excludes `permanentFailure`, with a real encrypted-store metadata update regression. |
| R7 terminal entries resent | **Resolved** | The scheduler skips conflicted and permanently rejected Collection entries before network dispatch; consecutive-sync regressions cover both states. |

## Closure condition

Do not accept the final closure at `cad9ba8`. Make legacy reconciliation establish an authoritative server base, add the focused divergent-state regression, rerun the affected gates, and perform one final exact-head Spec and Quality review.
