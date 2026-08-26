# Knowledge Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Stash around personal knowledge organization while delivering secure onboarding, deep capability modules, Note hierarchies, Collections/View Blocks, Workspace Tasks, nested Projects, and corrected visual direction.

**Architecture:** One deployable modular monolith exposes deep capability modules registered through a compact composition interface. PostgreSQL capability adapters share a private transaction/schema kernel; web capability modules contribute routes/navigation to a quiet Note-centered shell; shared packages remain limited to true cross-client contracts. Six substantial milestones are the review and CI boundaries, while their checkboxes are local red-green execution steps.

**Tech Stack:** Node.js 22, TypeScript 5.9, PostgreSQL/PGLite, React 19, React Router 7, TanStack Query 5, Tiptap/ProseMirror/Yjs, Radix UI, CSS Modules/design tokens, Vitest, Node test runner, Playwright, Expo/React Native.

**Spec:** `docs/superpowers/specs/2026-08-26-knowledge-workspace-redesign-design.md`

## Global Constraints

- No production data migration is required before the first functional release; replace prototype schema where doing so produces the correct model.
- Notes use one canonical parent, while ordinary links never imply containment, Project membership, or access.
- Tasks are Workspace objects with one canonical field set and zero or more Project associations.
- Each Project assigns its own Task Key and permanently reserves removed keys as aliases.
- The Workspace owns one Workflow.
- View Blocks reference canonical Tasks or Collection records and never copy them.
- Project association inherits through Note containment but never through Note Links.
- Non-loopback first-run claim requires a short-lived one-time setup code; request headers cannot establish loopback trust.
- Visualization queries are authorization-filtered before data reaches the client and always have a non-visual equivalent.
- UI work must read and follow `/Users/imnibis/.agents/skills/gpt-taste/SKILL.md` before implementation.
- Each milestone receives one consolidated review/CI boundary; do not split its internal steps into microscopic pull requests.

---

### Task 1: Establish capability seams and focused persistence adapters

**Files:**
- Create: `src/instance-operations/storage/postgres-kernel.ts`
- Create: `src/identity-access/index.ts`
- Create: `src/knowledge-authoring/index.ts`
- Create: `src/work-planning/index.ts`
- Create: `src/development-integration/index.ts`
- Create: `src/capability-registry.ts`
- Modify: `src/instance-runtime.ts`
- Modify: `src/instance.ts`
- Split incrementally: `src/postgres-database.ts`
- Create: `tests/contracts/capability-registry.test.ts`
- Move focused tests beside their capability; retain adapter contracts in `tests/postgres/` and journeys in `tests/journeys/`.

**Interfaces:**
- Produces: `CapabilityModule { readonly name: string; routes(): readonly HttpRoute[] }` and `CapabilityRegistry { readonly modules: readonly CapabilityModule[] }`.
- Produces: private `PostgresKernel` with `transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>` and `query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>`.
- Preserves: every existing HTTP route and response while ownership moves behind capability interfaces.

- [ ] Add a failing contract test that constructs a registry from five capability modules, rejects duplicate names, flattens routes in declared order, and proves the composition root depends only on the registry.
- [ ] Introduce `CapabilityModule`, `createCapabilityRegistry(modules)`, and route flattening; run `node --import tsx --test tests/contracts/capability-registry.test.ts` and make it pass.
- [ ] Extract the pool, transaction, advisory-lock, and schema-version mechanics from `PostgresDatabase` into the private `PostgresKernel`; keep existing repository methods delegating during this step and run `pnpm run test:server`.
- [ ] Move identity/auth repository implementations, knowledge repository implementations, planning repository implementations, integration repository implementations, and Instance-operation implementations into capability-owned Postgres adapters over the kernel. Delete each delegated method from `PostgresDatabase` immediately after its capability contract passes.
- [ ] Replace the roughly forty-field `InstanceOptions` route wiring with five capability registrations. Keep protocol behavior unchanged and add a journey assertion covering representative auth, Note, Task, integration, and diagnostics routes.
- [ ] Split `tests/postgres-*.test.ts` into `tests/postgres/<capability>.test.ts`, move behavior tests next to their capability modules, and retain only cross-capability journeys in `tests/journeys/`.
- [ ] Run `pnpm run check`, `pnpm run test:server`, `pnpm run build`, and `git diff --check`; commit the milestone as `refactor(server): establish capability module seams`.

### Task 2: Deliver secure personal first-run onboarding and Project creation

**Depends on:** Task 1.

**Files:**
- Create: `src/identity-access/instance-setup.ts`
- Create: `src/identity-access/instance-setup-routes.ts`
- Create: `apps/web/src/identity-access/setup-page.tsx`
- Create: `apps/web/src/identity-access/setup-page.module.css`
- Create: `apps/web/src/identity-access/setup-page.test.tsx`
- Create: `apps/web/src/work-planning/project-create-dialog.tsx`
- Create: `apps/web/src/work-planning/project-create-dialog.test.tsx`
- Modify: `src/deployment-configuration.ts`
- Modify: `src/owner-bootstrap.ts`
- Modify: `src/workspaces-projects.ts`
- Modify: `src/organization-roles.ts`
- Modify: `apps/web/src/app-shell.tsx`
- Test: `tests/identity-access/instance-setup.test.ts`
- Test: `tests/work-planning/project-permissions.test.ts`

**Interfaces:**
- Produces: `GET /api/instance/setup-state -> { state: "available-local" | "code-required" | "complete" }`.
- Produces: `POST /api/instance/setup` accepting `{ setupCode?: string; name: string; email: string; password: string; workspaceName: string }` and returning `{ token: string; workspaceId: string; starterNoteId: string }`.
- Produces: `canCreateProject(memberId, workspaceId): Promise<boolean>` as the single permission decision used by API discovery and mutation.

- [ ] Write failing server tests for loopback claim, non-loopback code requirement, expiry, single use, concurrent claim, header spoofing, atomic personal Workspace/tutorial/session creation, and refusal after completion.
- [ ] Implement cryptographically random setup-code generation with a stored hash and expiry; derive local trust from the bound peer/socket address and deployment configuration, never `Host` or forwarded headers.
- [ ] Replace Organization-first bootstrap output with the personal account/Workspace result and seed one removable tutorial branch containing linked Notes, a Collection, a Task View Block, and sample Tasks.
- [ ] Build the accessible multi-step setup page, success transition, retry behavior, password requirements, and code step shown only for `code-required`; verify keyboard flow and live error announcements in Vitest.
- [ ] Add `create_project` to Role permission evaluation, default it to Owner/Admin, retain it for personal owners, and deny built-in Members unless a custom Role grants it.
- [ ] Add Project capability metadata to Workspace discovery, implement a create dialog that posts to `/api/workspaces/:id/projects`, and show a concise reason when permission is absent.
- [ ] Run focused setup/project tests, `pnpm run check`, `pnpm test`, `pnpm run build`, `pnpm run test:a11y`, and `git diff --check`; commit as `feat(onboarding): make a fresh instance immediately usable`.

### Task 3: Rebuild the web shell around the Note Tree

**Depends on:** Task 2.

**Files:**
- Create: `src/knowledge-authoring/note-tree.ts`
- Create: `src/knowledge-authoring/note-tree-routes.ts`
- Create: `apps/web/src/knowledge-authoring/note-tree.tsx`
- Create: `apps/web/src/knowledge-authoring/note-tree.module.css`
- Create: `apps/web/src/knowledge-authoring/context-drawer.tsx`
- Create: `apps/web/src/knowledge-authoring/note-workspace.tsx`
- Split: `apps/web/src/core-workflows.tsx`
- Split: `apps/web/src/note-editor.tsx`
- Modify: `apps/web/src/app-shell.tsx`
- Test: `tests/knowledge-authoring/note-tree.test.ts`
- Test: `apps/web/src/knowledge-authoring/note-tree.test.tsx`
- Test: `tests/browser/knowledge-workspace.spec.ts`

**Interfaces:**
- Produces: `NoteTreeNode { id: string; parentId?: string; title: string; position: string; childCount: number }`.
- Produces: `moveNoteBranch(noteId, destination: { parentId?: string; beforeId?: string }, actorId): Promise<{ movedIds: string[]; projectAccessChanges: AccessChange[] }>`.
- Produces: web capability manifest `{ routes: RouteObject[]; primaryNavigation: NavigationItem[]; contextualNavigation: NavigationItem[] }` consumed by the shell.

- [ ] Write failing domain tests for root Notes, one parent, ordered siblings, cycle rejection, atomic branch moves, inherited Project membership previews, and links that do not change containment or access.
- [ ] Replace prototype Note storage with explicit parent/order fields and implement tree queries plus atomic move/archive/trash operations; preserve stable Note/Block identity and portable paths.
- [ ] Split Notes, Inbox, Search, Activity, Boards, Discussions, and Notifications out of `core-workflows.tsx`; delete the file once every export has a capability owner.
- [ ] Build the collapsible keyboard-navigable tree, breadcrumb trail, active Note restoration, fast sibling/child creation, drag/drop plus non-pointer move controls, and closed-by-default context drawer.
- [ ] Move backlinks, outgoing links, properties, Project associations, sharing, and Discussions into context-drawer tabs; keep editing central and preserve reduced-motion behavior.
- [ ] Add browser coverage for create/nest/move/link/backlink/archive/restore, focus restoration, narrow viewport rendering, and no accidental access propagation through links.
- [ ] Run focused server/web/browser tests, `pnpm run check`, `pnpm run build`, `pnpm run test:a11y`, and `git diff --check`; commit as `feat(notes): make the note tree the primary workspace`.

### Task 4: Add Collections and the shared View Block engine

**Depends on:** Task 3.

**Files:**
- Create: `src/knowledge-authoring/collections.ts`
- Create: `src/knowledge-authoring/collection-routes.ts`
- Create: `packages/domain-types/src/collections.ts`
- Create: `apps/web/src/knowledge-authoring/views/view-model.ts`
- Create: `apps/web/src/knowledge-authoring/views/table-view.tsx`
- Create: `apps/web/src/knowledge-authoring/views/board-view.tsx`
- Create: `apps/web/src/knowledge-authoring/views/list-view.tsx`
- Create: `apps/web/src/knowledge-authoring/views/calendar-view.tsx`
- Create: `apps/web/src/knowledge-authoring/collection-editor.tsx`
- Test: `tests/knowledge-authoring/collections.test.ts`
- Test: `apps/web/src/knowledge-authoring/views/view-model.test.ts`
- Test: `tests/browser/collections.spec.ts`

**Interfaces:**
- Produces: `CollectionProperty` discriminated union for the property types listed in the spec.
- Produces: `ViewDefinition { id: string; source: { kind: "collection"; collectionId: string } | { kind: "tasks"; workspaceId: string }; presentation: "table" | "board" | "list" | "calendar"; filters: ViewFilter[]; sorts: ViewSort[]; groupBy?: string }`.
- Produces: `relocateCollections(noteId, destinationNoteId, collectionIds): Promise<CollectionImpact>` and explicit destructive impact preview.

- [ ] Write failing contracts for property validation, stable record identity, direct relations, permission filtering, reusable views, archive preservation, relocation, deletion preview, and portable representations.
- [ ] Implement Collection schema/repositories/routes for the exact initial property union; reject formulas, rollups, generated fields, location, and unknown persisted types.
- [ ] Implement one pure view-model evaluator shared by table, board, list, and calendar renderers; presentation changes must retain source records and canonical identities.
- [ ] Add Tiptap View Block nodes that store `ViewDefinition` references, render access failures without leaking source metadata, and open a focused view without duplicating state.
- [ ] Build Collection definition/editing and accessible table/board/list/calendar interactions, including keyboard card movement and non-drag alternatives.
- [ ] Add deletion/relocation impact UI covering affected records, relations, and View Blocks; make archive non-destructive.
- [ ] Run focused contracts, web tests, browser/a11y tests, `pnpm run check`, `pnpm run build`, and `git diff --check`; commit as `feat(collections): add reusable structured knowledge views`.

### Task 5: Replace Project-owned Tasks with Workspace planning

**Depends on:** Task 4.

**Files:**
- Replace: `src/tasks.ts` with `src/work-planning/tasks.ts`
- Replace: `src/workspaces-projects.ts` with `src/work-planning/projects.ts` and `src/work-planning/workspaces.ts`
- Create: `src/work-planning/task-project-associations.ts`
- Create: `src/work-planning/workflow.ts`
- Create: `apps/web/src/work-planning/tasks-page.tsx`
- Create: `apps/web/src/work-planning/task-detail.tsx`
- Create: `apps/web/src/work-planning/projects-page.tsx`
- Modify: `packages/domain-types/src/index.ts`
- Modify: `packages/api-client/src/index.ts` by splitting planning operations into `packages/api-client/src/work-planning.ts`
- Test: `tests/work-planning/tasks-projects.test.ts`
- Test: `tests/browser/work-planning.spec.ts`

**Interfaces:**
- Produces: `Task { id: string; workspaceId: string; parentTaskId?: string; title: string; description: string; statusId: string; assigneeIds: string[] }`.
- Produces: `TaskProjectAssociation { taskId: string; projectId: string; activeKey: string }` with permanently reserved aliases.
- Produces: `Project { id: string; workspaceId: string; parentProjectId?: string; name: string; keyPrefix: string }`.
- Consumes: Task `ViewDefinition` source from Task 4.

- [ ] Write failing domain tests for Projectless Tasks, many-to-many associations, canonical fields, one parent Task, cycle rejection, independent Subtask associations, nested Project aggregation, permission-filtered parents, Workspace Workflow status, multi-key search, alias reservation, and re-association.
- [ ] Replace prototype project-owned tables with Workspace Tasks, Task parent relations, Task–Project associations, Project hierarchy, Workspace statuses, per-Project sequences, and permanent aliases; reset development data rather than adding prototype migrations.
- [ ] Rewrite Task, board, Workflow, dependency, Automation, Signal, export/import, and search behavior against canonical Task identity; accept every active or aliased Project key at lookup boundaries.
- [ ] Use the shared View Block engine for embedded Task views and the built-in Tasks destination; provide saved filters, “My Tasks,” and focused detail without Project-specific field overrides.
- [ ] Implement selected-Block Task promotion that preserves the source and adds a visible stable relation; leave checklist items local until promoted.
- [ ] Implement nested Project navigation, aggregation, repository association, branch Note membership inheritance, sharing warnings, and Project-specific key display.
- [ ] Split the API client by capability and retain only genuinely shared cross-client contracts in packages; verify mobile compilation against changed Task types.
- [ ] Run planning, automation, integration, export/import, search, web, mobile, browser, and accessibility tests plus `pnpm run check`, `pnpm run build`, and `git diff --check`; commit as `feat(planning): make tasks canonical across projects and views`.

### Task 6: Regenerate visual references, add relationship lenses, and harden the complete journey

**Depends on:** Tasks 1 through 5.

**Files:**
- Replace: `docs/design/stash-web-direction/*.png`
- Create: `docs/design/stash-web-direction/README.md`
- Create: `src/knowledge-authoring/relationship-query.ts`
- Create: `apps/web/src/knowledge-authoring/related-notes.tsx`
- Create: `apps/web/src/knowledge-authoring/visualization-block.tsx`
- Create: `packages/domain-types/src/visualizations.ts`
- Modify: capability-owned CSS modules and design tokens.
- Test: `tests/knowledge-authoring/relationship-query.test.ts`
- Test: `tests/browser/stable-knowledge-journey.spec.ts`
- Modify: `docs/stable-release-verification.md`

**Interfaces:**
- Produces: `RelationshipQuery { rootId: string; depth: number; relationTypes?: string[]; includeHierarchy: boolean; limit: number }` and permission-filtered `RelationshipNeighborhood`.
- Produces: portable `VisualizationDefinition { kind: "local-graph" | "global-graph" | "brain-map" | "word-cloud" | "canvas"; query: RelationshipQuery; layout: unknown; viewEdges: ViewEdge[] }` with list/outline fallback metadata.

- [ ] Before UI edits, read the required `gpt-taste` skill and generate a new coherent reference journey covering setup, starter Workspace, Note Tree/editor, links/backlinks, Collections/View Blocks, Tasks, nested Projects, contextual collaboration, search, settings, and responsive behavior.
- [ ] Add a design README mapping every image to implemented behavior and marking graph/brain-map/word-cloud/canvas concepts as optional lenses rather than acceptance claims.
- [ ] Write failing authorization contracts proving forbidden nodes, labels, counts, terms, and unresolved links never enter relationship or aggregate responses; add depth/node limits and progressive expansion.
- [ ] Implement breadcrumbs, backlinks, outgoing links, broken-link maintenance, and focused related-Note navigation as core UI with list/outline equivalents.
- [ ] Implement the internal Visualization Block interface and portable saved state; ship only the focused local relationship view initially, while ensuring later graph, brain-map, word-cloud, and canvas renderers can consume the interface without canonical mutations.
- [ ] Apply the regenerated visual system across the implemented journey, keeping contextual collaboration closed by default, responsive content readable, controls keyboard-accessible, contrast sufficient, and reduced motion respected.
- [ ] Add one stable browser journey from fresh Instance claim through Note nesting, Collection creation, Task promotion, Project association/key creation, contextual Discussion, search, export, logout/login, and durable restart.
- [ ] Update stable-release verification, run `pnpm run check`, `pnpm test`, `pnpm run build`, `pnpm run test:browser`, `pnpm run test:a11y`, `pnpm run smoke`, and `git diff --check`; perform Standards and Spec reviews and fix every finding before committing as `feat(web): complete the knowledge workspace redesign`.

## Plan self-review

- Every acceptance item in the linked specification maps to at least one milestone above.
- The six milestones, rather than individual checkboxes, are the intended ticket/PR/review/CI boundaries.
- The plan contains no legacy-content migration task because ADR-0053 explicitly permits replacing prototype state.
- Visualizations beyond the focused local relationship view have interfaces and portable state but are not falsely included in the first implementation acceptance gate.
- Task, Project, Collection, View, and visualization type names match the glossary and ADRs.
