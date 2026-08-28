# Web and Mobile Design-System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one deliberate Stash visual system across web and mobile and replace the fragmented Collection workspace with a direct-manipulation table experience.

**Architecture:** Shared semantic tokens define color, type, spacing, elevation, controls, focus, and motion; web CSS Modules and a typed React Native theme consume the same meanings without sharing UI components. The Collection workspace is split into focused table, property, record, view-control, and impact components while retaining canonical Collection and View Block contracts. Work proceeds from foundations through web shell, Collections, remaining web surfaces, mobile, and final cross-client acceptance.

**Tech Stack:** React 19, TypeScript 5.9, Vite, CSS Modules, TanStack Query, Radix Dialog, GSAP with reduced-motion guards, Expo SDK 55, React Native 0.83, Vitest, Testing Library, Playwright, axe-core.

**Spec:** `docs/superpowers/specs/2026-08-28-web-mobile-design-system-redesign.md`

## Global Constraints

- Read `CONTEXT.md`, ADR-0033, ADR-0040, ADR-0044, ADR-0051, and the required `gpt-taste` skill before each UI task.
- Preserve Paper `#f4f1e9`, Ivory `#fffdf8`, Carbon `#181a18`, Vermilion `#bf381f`, Sage `#929b88`, and Warm rule `#d8d3c9` with the semantic roles defined by the spec.
- Vermilion communicates focus, consequential primary action, conflict, or the active thread; it is not general decoration.
- Keep Collection records canonical and owned by one Collection; View Blocks store presentation state and never copy records.
- Ordinary interface copy uses `Table`, `Board`, `Calendar`, `View`, and `Insert view`; do not expose `View Block` unless technical precision is required.
- Maintain visible keyboard focus, non-drag alternatives, 44-pixel-equivalent pointer targets, reduced-motion behavior, 320 CSS-pixel support, and text-zoom usability.
- Preserve unrelated user changes and do not rewrite server/domain contracts merely for visual convenience.
- Use test-driven development and finish every task with focused tests, relevant checks/builds, `git diff --check`, reference review when visual output changes, and a dedicated commit.

---

### Task 1: Establish shared semantic foundations

**Files:**
- Modify: `packages/tokens/src/tokens.css`
- Modify: `packages/tokens/scripts/check.mjs`
- Create: `apps/web/src/ui/control.module.css`
- Create: `apps/web/src/ui/control.tsx`
- Create: `apps/web/src/ui/control.test.tsx`
- Create: `apps/mobile/theme/theme.ts`
- Create: `apps/mobile/theme/theme.test.ts`
- Modify: `apps/mobile/theme/colors.ts`

**Interfaces:**
- Consumes: the six semantic colors and role constraints in the specification.
- Produces: `Button`, `IconButton`, `Field`, and `StatusNotice` web primitives; `stashTheme` with `colors`, `spacing`, `radius`, `type`, `shadow`, and `motion`; backward-compatible `colors` derived from `stashTheme.colors`.

- [ ] **Step 1: Write failing token and primitive tests**

Add assertions that the token checker requires semantic canvas, surface, ink, accent, success, border, focus, control-height, type-scale, radius, elevation, and motion variables. In `control.test.tsx`, require primary/secondary/danger variants, accessible pending labels, and an icon-button label. In `theme.test.ts`, require `stashTheme.colors.accent === "#bf381f"`, `stashTheme.colors.canvas === "#f4f1e9"`, minimum control height `44`, and no default `#2463eb` accent.

```tsx
render(<Button variant="primary" pending>Save capture</Button>);
expect(screen.getByRole("button", { name: "Saving capture" })).toBeDisabled();
render(<IconButton label="Add property">+</IconButton>);
expect(screen.getByRole("button", { name: "Add property" })).toBeVisible();
```

- [ ] **Step 2: Run tests and confirm the missing foundations fail**

Run: `pnpm --filter @stash/tokens test && pnpm --filter @stash/web exec vitest run src/ui/control.test.tsx && pnpm --filter @stash/mobile exec vitest run theme/theme.test.ts`

Expected: FAIL because the semantic scale, primitives, and mobile theme do not exist.

- [ ] **Step 3: Expand tokens without renaming established compatibility variables**

Define semantic aliases and exact control/motion values in `tokens.css`, including:

```css
--stash-color-success: #67745f;
--stash-color-success-surface: #e1e5dc;
--stash-control-height: 2.75rem;
--stash-control-height-compact: 2.25rem;
--stash-radius-control: .55rem;
--stash-radius-surface: .9rem;
--stash-duration-fast: 140ms;
--stash-duration-standard: 220ms;
--stash-ease-standard: cubic-bezier(.2, .8, .2, 1);
```

Retain existing `--stash-color-*` names where consumers already use them, but derive their values from the new semantic roles.

- [ ] **Step 4: Build focused web controls and the typed mobile theme**

Implement the web primitives as semantic HTML wrappers with forwarded native props; keep layout decisions in consumers. Define the mobile theme as a frozen object and make `colors.ts` map legacy names to it so later tasks can migrate incrementally.

```ts
export const stashTheme = Object.freeze({
  colors: { canvas: "#f4f1e9", surface: "#fffdf8", ink: "#181a18", accent: "#bf381f", success: "#67745f", rule: "#d8d3c9" },
  spacing: { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 },
  radius: { control: 10, surface: 18 },
  controlHeight: 44,
  motion: { fast: 140, standard: 220 },
});
```

- [ ] **Step 5: Verify foundations**

Run: `pnpm --filter @stash/tokens test && pnpm --filter @stash/web exec vitest run src/ui/control.test.tsx && pnpm --filter @stash/mobile exec vitest run theme/theme.test.ts && pnpm --filter @stash/web check && pnpm --filter @stash/mobile check && git diff --check`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tokens apps/web/src/ui apps/mobile/theme
git commit -m "feat(ui): establish shared semantic foundations"
```

### Task 2: Refine the web shell, first run, and Note workspace

**Files:**
- Modify: `apps/web/src/global.css`
- Modify: `apps/web/src/app-shell.tsx`
- Modify: `apps/web/src/app-shell.module.css`
- Modify: `apps/web/src/app-shell.test.tsx`
- Modify: `apps/web/src/identity-access/setup-page.tsx`
- Modify: `apps/web/src/identity-access/setup-page.module.css`
- Modify: `apps/web/src/identity-access/setup-page.test.tsx`
- Modify: `apps/web/src/knowledge-authoring/note-tree.tsx`
- Modify: `apps/web/src/knowledge-authoring/note-tree.module.css`
- Modify: `apps/web/src/knowledge-authoring/note-tree.test.tsx`
- Modify: `apps/web/src/note-editor.tsx`
- Modify: `apps/web/src/note-editor.module.css`
- Modify: `apps/web/src/note-editor.test.tsx`
- Modify: `apps/web/src/knowledge-authoring/context-drawer.tsx`
- Test: `tests/browser/knowledge-workspace.spec.ts`
- Test: `tests/browser/note-editor.spec.ts`

**Interfaces:**
- Consumes: Task 1 web primitives and CSS tokens.
- Produces: one shell hierarchy, document-led Note composition, restrained context drawer, and approved first-run visual treatment used by all later web tasks.

- [ ] **Step 1: Add failing hierarchy and accessibility assertions**

Require a single current primary destination, Note-specific actions outside the global top bar, a closed context drawer on initial Note load, descriptive icon-button labels, and setup headings that do not exceed the approved content hierarchy. Add a browser assertion at 320 pixels that the shell has no page-level horizontal overflow.

```ts
await page.setViewportSize({ width: 320, height: 740 });
await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm --filter @stash/web exec vitest run src/app-shell.test.tsx src/identity-access/setup-page.test.tsx src/knowledge-authoring/note-tree.test.tsx src/note-editor.test.tsx`

Expected: FAIL on the new hierarchy, copy, or control assertions.

- [ ] **Step 3: Apply the shared shell grammar**

Use semantic controls, remove decorative kickers, reduce simultaneous navigation, keep one active thread indicator, and reserve the top bar for search, notifications, and creation. Replace broad card/border wrappers with spacing and surface transitions. Keep all existing routes and permissions.

- [ ] **Step 4: Make Notes document-led**

Give the Note title and editor the dominant measure; reduce persistent toolbar and context weight; leave the context drawer closed initially; preserve breadcrumbs, links, Discussions, branch impact, markdown mode, keyboard controls, and error recovery. Use GSAP only for short drawer/selection continuity and disable it through `prefers-reduced-motion`.

- [ ] **Step 5: Refine first-run composition**

Retain the existing reference image and fields. Use asymmetrical editorial composition, a two-to-three-line statement, one vermilion primary action, Carbon/Ivory contrast, and explicit setup-code recovery. Do not add promotional pills, statistics, or decorative labels.

- [ ] **Step 6: Run web verification and capture the key journey**

Run: `pnpm --filter @stash/web exec vitest run src/app-shell.test.tsx src/identity-access/setup-page.test.tsx src/knowledge-authoring/note-tree.test.tsx src/note-editor.test.tsx && pnpm --filter @stash/web check && pnpm run build:web && pnpm exec playwright test tests/browser/knowledge-workspace.spec.ts tests/browser/note-editor.spec.ts && git diff --check`

Expected: unit, browser, check, build, and diff gates PASS at desktop, 320-pixel, keyboard, and reduced-motion settings.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src tests/browser/knowledge-workspace.spec.ts tests/browser/note-editor.spec.ts
git commit -m "feat(web): refine shell and note workspace"
```

### Task 3: Replace Collections with direct table manipulation

**Files:**
- Modify: `apps/web/src/knowledge-authoring/collection-editor.tsx`
- Modify: `apps/web/src/knowledge-authoring/collection-editor.module.css`
- Modify: `apps/web/src/knowledge-authoring/collection-editor.test.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-table.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-property-menu.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-cell.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-view-controls.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-impact-dialog.tsx`
- Modify: `apps/web/src/knowledge-authoring/views/table-view.tsx`
- Modify: `apps/web/src/knowledge-authoring/views/board-view.tsx`
- Modify: `apps/web/src/knowledge-authoring/views/list-view.tsx`
- Modify: `apps/web/src/knowledge-authoring/views/calendar-view.tsx`
- Modify: `apps/web/src/knowledge-authoring/views/view-model.ts`
- Modify: `apps/web/src/knowledge-authoring/views/view-model.test.ts`
- Modify: `src/knowledge-authoring/collections.ts`
- Modify: `src/knowledge-authoring/collection-routes.ts`
- Test: `tests/knowledge-authoring/collections.test.ts`
- Test: `tests/knowledge-authoring/collections-http.test.ts`
- Test: `tests/browser/collections.spec.ts`

**Interfaces:**
- Consumes: existing `Collection`, `CollectionProperty`, `CollectionRecord`, `ViewBlock`, and `ViewDefinition` contracts plus Task 1 controls.
- Produces: `CollectionTable`, `CollectionCell`, `CollectionPropertyMenu`, `CollectionViewControls`, and `CollectionImpactDialog`; server operations for collection title/property update, property reorder/delete, and record update if current routes do not already expose them.

- [ ] **Step 1: Write failing browser tests for the approved mental model**

Replace tests that search separate authoring lanes with one Collection region. Cover immediate creation, trailing property addition, inline records, presentation changes, cross-Note insertion, keyboard use, and impact review.

```ts
await page.getByRole("button", { name: "New collection" }).click();
const collection = page.getByRole("region", { name: "Untitled collection" });
await expect(collection.getByRole("columnheader", { name: "Name" })).toBeVisible();
await collection.getByRole("button", { name: "Add property" }).click();
await page.getByRole("textbox", { name: "Property name" }).fill("Status");
await page.getByRole("option", { name: "Single select" }).click();
await collection.getByRole("button", { name: "New record" }).click();
await collection.getByRole("textbox", { name: "Name, new record" }).fill("Research");
```

- [ ] **Step 2: Write failing component and server tests**

Require collection creation to default to a `Name` text property, property operations to preserve unique positions and valid record values, inline edit failures to retain the draft, and deletion to report affected values/relations/views. Define route expectations explicitly:

```text
PATCH  /api/collections/:collectionId
PATCH  /api/collections/:collectionId/properties/:propertyId
DELETE /api/collections/:collectionId/properties/:propertyId
PATCH  /api/collections/:collectionId/properties/order
```

- [ ] **Step 3: Run focused tests and confirm the old fragmented UI fails**

Run: `pnpm --filter @stash/web exec vitest run src/knowledge-authoring/collection-editor.test.tsx src/knowledge-authoring/views/view-model.test.ts && pnpm run test:server -- tests/knowledge-authoring/collections.test.ts tests/knowledge-authoring/collections-http.test.ts`

Expected: FAIL because inline table operations and any missing mutation routes are not implemented.

- [ ] **Step 4: Implement required Collection mutations behind existing authorization**

Add only operations required by the direct table. Reuse Collection normalization for validation, reject deletion of the sole primary text property, rewrite positions atomically, remove deleted property values from every record, and return the updated canonical Collection. Do not add formulas, rollups, generated fields, locations, or copied records.

- [ ] **Step 5: Split the Collection workspace into focused components**

Keep `CollectionWorkspace` responsible for loading Note-owned Collections, creating a default Collection, inserting another Collection's view, and invalidating queries. Make each `CollectionTable` own presentation and direct editing for one Collection. Use anchored menus/dialogs with focus restoration; do not render separate schema, records, ownership, or view-creation panels.

```ts
export interface CollectionTableProps {
  collection: Collection;
  views: readonly ViewBlock[];
  editable: boolean;
  token: string;
  fetcher: typeof fetch;
  onChanged(): Promise<void>;
}
```

- [ ] **Step 6: Implement inline property, record, and cell behavior**

Render semantic table headers followed by an `Add property` header control. Put `New record` after the final body row. `CollectionCell` selects a control from the property discriminant and saves on explicit confirmation or well-defined blur; Escape restores the saved value. Keep a failed draft visible with an adjacent retry/error message. Provide arrow-key cell movement without overriding native text-editing keys.

- [ ] **Step 7: Consolidate presentations and advanced View controls**

Place Table/Board/List/Calendar selection in the Collection header. Collapse filter, sort, group, visible-property, and density controls behind `View`. When Calendar lacks a date property or Board lacks a grouping property, offer an in-context `Add date property` or `Add select property` action before switching. Preserve each reused View Block's independent definition.

- [ ] **Step 8: Move reuse and impact to explicit journeys**

Name cross-Note reuse `Insert view of another collection`, show its source Note, and insert a useful default table. Put move/delete behind the Collection overflow menu and use `CollectionImpactDialog` for records, relations, and inserted views. Restore focus to the invoking control when dialogs close.

- [ ] **Step 9: Verify Collection behavior and accessibility**

Run: `pnpm --filter @stash/web exec vitest run src/knowledge-authoring/collection-editor.test.tsx src/knowledge-authoring/views/view-model.test.ts && pnpm run test:server -- tests/knowledge-authoring/collections.test.ts tests/knowledge-authoring/collections-http.test.ts && pnpm run build:web && pnpm exec playwright test tests/browser/collections.spec.ts && pnpm run test:a11y -- --grep "Collection" && git diff --check`

Expected: direct creation/edit/reuse/impact flows PASS with keyboard, 320-pixel, text-zoom, reduced-motion, and axe coverage.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/knowledge-authoring src/knowledge-authoring tests/knowledge-authoring tests/browser/collections.spec.ts
git commit -m "feat(collections): make structured knowledge direct"
```

### Task 4: Align Tasks, Projects, Search, Settings, and administration

**Files:**
- Modify: `apps/web/src/work-planning/tasks-page.tsx`
- Modify: `apps/web/src/work-planning/tasks-page.module.css`
- Modify: `apps/web/src/work-planning/tasks-page.test.tsx`
- Modify: `apps/web/src/work-planning/project-browser.tsx`
- Modify: `apps/web/src/work-planning/project-browser.module.css`
- Modify: `apps/web/src/work-planning/project-browser.test.tsx`
- Modify: `apps/web/src/knowledge-authoring/workspace-pages.tsx`
- Modify: `apps/web/src/knowledge-authoring/workspace-pages.test.tsx`
- Modify: `apps/web/src/product-settings.tsx`
- Modify: `apps/web/src/product-settings.module.css`
- Modify: `apps/web/src/member-administration.tsx`
- Modify: `apps/web/src/member-administration.module.css`
- Modify: remaining `apps/web/src/*.tsx` and matching CSS Modules only when required to adopt Task 1 primitives.
- Test: `tests/browser/product-settings.spec.ts`
- Test: `tests/browser/core-workflows.spec.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2 page/control grammar and Task 3 view-control language.
- Produces: consistent page hierarchy, action placement, filters, empty/error states, and feedback across every remaining web destination.

- [ ] **Step 1: Add failing consistency tests**

Assert each destination has one page-level heading, one clearly named primary action at most, no decorative uppercase kicker, common filter disclosure language, and errors that identify preservation/recovery. Add keyboard navigation and narrow-width assertions to the two browser journeys.

- [ ] **Step 2: Run targeted tests and confirm failure**

Run: `pnpm --filter @stash/web exec vitest run src/work-planning/tasks-page.test.tsx src/work-planning/project-browser.test.tsx src/knowledge-authoring/workspace-pages.test.tsx src/product-settings.test.tsx`

Expected: FAIL where existing surfaces use divergent panels, labels, or controls.

- [ ] **Step 3: Apply the shared page and control grammar**

Migrate buttons, fields, feedback, page headers, filters, empty states, and destructive actions to Task 1 primitives. Replace borders/cards that do not represent contained objects. Keep canonical Task/Project behavior, permissions, administration boundaries, and existing query flows unchanged.

- [ ] **Step 4: Verify all web destinations together**

Run: `pnpm --filter @stash/web test:unit && pnpm --filter @stash/web check && pnpm run build:web && pnpm exec playwright test tests/browser/core-workflows.spec.ts tests/browser/product-settings.spec.ts tests/browser/accessibility.spec.ts && git diff --check`

Expected: web unit, browser, accessibility, check, build, and diff gates PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src tests/browser
git commit -m "feat(web): unify workspace surfaces"
```

### Task 5: Recompose mobile capture and workspace surfaces

**Files:**
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/app/index.tsx`
- Modify: `apps/mobile/app/pairing.tsx`
- Modify: `apps/mobile/app/workspace.tsx`
- Create: `apps/mobile/components/screen.tsx`
- Create: `apps/mobile/components/capture-composer.tsx`
- Create: `apps/mobile/components/mobile-status-notice.tsx`
- Modify: `apps/mobile/components/native-controls.*.tsx`
- Modify: `apps/mobile/components/native-choice.*.tsx`
- Modify: `apps/mobile/components/media-capture-controls.tsx`
- Modify: `apps/mobile/components/workspace-reader.tsx`
- Modify: `apps/mobile/components/workspace-reader-model.ts`
- Modify: `apps/mobile/components/workspace-reader-model.test.ts`
- Create: `apps/mobile/components/workspace-reader.test.tsx`
- Modify: `apps/mobile/package.json` only if the test renderer needs an existing compatible package.

**Interfaces:**
- Consumes: Task 1 `stashTheme`, existing sync/capture clients, and canonical mobile snapshot types.
- Produces: `Screen`, `CaptureComposer`, `MobileStatusNotice`, and a mobile reader that presents Collections as readable record lists/focused records rather than compressed desktop tables.

- [ ] **Step 1: Add failing mobile theme and composition tests**

Require Capture's title/composer/structure/media/save order, stable 44-point actions, Stash accent usage, semantic offline statuses, and accessible Notes/Tasks/Search/Views navigation. Require Collection views to announce their source/presentation and render readable property/value rows.

```tsx
expect(screen.getByRole("button", { name: "Save capture" })).toHaveAccessibilityState({ disabled: false });
expect(screen.getByText("Saved on this device")).toBeTruthy();
expect(screen.getByRole("header", { name: "Research" })).toBeTruthy();
```

- [ ] **Step 2: Run focused tests and confirm current inline/default styling fails**

Run: `pnpm --filter @stash/mobile exec vitest run components/workspace-reader-model.test.ts components/workspace-reader.test.tsx theme/theme.test.ts`

Expected: FAIL on missing composed components or semantic presentation.

- [ ] **Step 3: Build shared native composition primitives**

Implement `Screen` with safe-area-aware canvas, content measure, title slot, scroll behavior, and optional stable bottom action. Implement `MobileStatusNotice` variants `saved`, `waiting`, `synchronized`, `attention`, and `error`. Preserve platform-native input and sheet behavior while sourcing all colors, spacing, radius, and type roles from `stashTheme`.

- [ ] **Step 4: Recompose pairing and capture to match the approved references**

Keep all existing encryption, incoming share, media, structure, retry, and synchronization behavior. Replace loose links and controls with a clear Capture hierarchy: status, composer, text/checklist mode, media, collapsed `Add project, tag, or reminder`, and stable save action. Pairing retains instance/member/workspace fields with clearer progress and recovery.

- [ ] **Step 5: Recompose the offline Workspace reader**

Use a deliberate native navigation treatment for Notes, Tasks, Search, and Views. Render Collection views as readable record lists and focused-record surfaces; do not attempt desktop schema construction or wide boards. Keep Task status updates, pending mutation feedback, Note Tree collapse, search, canonical record values, and offline refresh behavior.

- [ ] **Step 6: Verify TypeScript, tests, web export, and native behavior**

Run: `pnpm --filter @stash/mobile test && pnpm --filter @stash/mobile check && pnpm --filter @stash/mobile build && pnpm run test:server -- tests/knowledge-authoring/mobile-native-entrypoints.test.ts tests/mobile-capture.test.ts && git diff --check`

Then run the native development client on the available emulator/device and manually verify pairing, text capture, checklist capture, media sheet, offline save, reconnection sync, reader navigation, Collection records, Task status changes, large text, dark system overlays, and reduced motion. Record the device/OS and observed result in the task handoff.

Expected: automated gates PASS and every native checklist item is observed on-device; a web export alone does not satisfy this step.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile tests/knowledge-authoring/mobile-native-entrypoints.test.ts tests/mobile-capture.test.ts
git commit -m "feat(mobile): apply the Stash workspace direction"
```

### Task 6: Regenerate references and run the complete release gate

**Files:**
- Modify: `scripts/capture-web-direction.mjs`
- Modify: `docs/design/stash-web-direction/README.md`
- Modify: `docs/design/stash-web-direction/*.png`
- Modify: `docs/design/stash-mobile-direction/*.png` only from verified native captures.
- Modify: `tests/browser/accessibility-release-gate.spec.ts`
- Modify: `tests/stable-release-journey.test.ts` only when the redesigned accessible names or workflow order require it.

**Interfaces:**
- Consumes: completed Tasks 1–5 and the acceptance list in the specification.
- Produces: reviewed current web/mobile references and evidence that the complete repository remains releasable.

- [ ] **Step 1: Extend the stable visual journey before recapturing**

Make the capture script cover setup, starter Workspace, Note Tree/editor, context, direct Collection creation, inline property/record editing, reused Collection view, Tasks, Projects, Search, Settings, and the 390-pixel Note surface. Use reduced motion and deterministic seeded data. Add release-gate assertions for the Collection path and page-level overflow.

- [ ] **Step 2: Run the complete automated gate**

Run: `pnpm test && pnpm run check && pnpm run build && pnpm run test:browser && pnpm run test:a11y && pnpm run test:stable-release && git diff --check`

Expected: every command exits 0. If environment-only failures occur, capture the exact command/output and resolve the environment before changing product code.

- [ ] **Step 3: Generate current web references from the acceptance Instance**

Run `pnpm exec tsx scripts/browser-instance.ts` in one terminal, then `node scripts/capture-web-direction.mjs` in another. Verify every image is from the current build, uses reduced motion, contains no placeholder/loading/error state, and matches the README inventory.

- [ ] **Step 4: Capture and inspect native references**

Capture pairing, text capture, checklist capture, media capture, structure, offline saved, shared-to-Stash, and outbox-attention states from the verified native development client. Do not substitute browser-rendered mobile images. Inspect desktop, 390-pixel web, and native contact sheets for hierarchy, clipping, contrast, accidental card repetition, decorative vermilion, and inconsistent controls.

- [ ] **Step 5: Run the final self-critique and remove one unnecessary visual device**

Compare the complete journeys against the specification. Remove any repeated border, label, shadow, animation, or accent that does not communicate structure or state. Re-run affected focused tests and recapture changed references.

- [ ] **Step 6: Commit the reviewed references and release evidence**

```bash
git add scripts/capture-web-direction.mjs docs/design tests/browser/accessibility-release-gate.spec.ts tests/stable-release-journey.test.ts
git commit -m "docs(design): refresh cohesive product references"
```

- [ ] **Step 7: Record final verification**

Report exact command results, native device/OS, reference paths, any consciously deferred behavior, and `git status --short`. Do not call CI green unless CI actually ran; local verification and native verification must be described separately.
