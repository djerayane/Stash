# Knowledge Workspace Redesign

## Goal

Make Stash a coherent, personal-first knowledge environment for capturing, organizing, connecting, and developing Notes, while preserving serious Task, Project, collaboration, development-integration, portability, and self-hosting capabilities.

## Product hierarchy

Stash opens around knowledge rather than team activity. The default shell presents Inbox, the Note Tree, Search, and Tasks. Projects and Collections remain one click away or appear contextually. Sharing, Discussions, Activity, integrations, and administration appear only when relevant.

When a Member has one personal Workspace, the shell does not expose redundant Workspace or Organization selectors. Returning Members reopen their last active Note or view. New Members enter a small disposable starter branch that teaches nesting, links, a Collection, a Task View Block, and Task promotion by editing real content.

The existing design references remain art direction: warm paper surfaces, carbon navigation, strong editorial typography, restrained vermilion signals, generous spacing, and clear focus. They are not layout specifications. New references must depict the product model in this document rather than the current collaboration-heavy information architecture.

## First-run setup

An empty Instance offers browser-guided setup for a personal account and personal Workspace. The form asks only for name, email, password, and Workspace name. A loopback-only Instance may be claimed without a code. Any non-loopback Instance requires a short-lived, single-use setup code printed to operator-owned startup output. Client-supplied host headers never establish loopback trust.

Successful setup creates an authenticated session and the disposable starter branch atomically. Organizations, OIDC, SMTP, backups, integrations, repositories, and advanced administration remain outside first-run setup. They appear later through a concise setup checklist visible to the relevant authority.

There is no real installed-data compatibility obligation before the first functional release. Prototype schema and seed data may be replaced rather than migrated, as recorded in ADR-0053.

## Notes and navigation

A Note is authored block-based knowledge. Every Note has zero or one parent, producing a strict Note Tree with ordered siblings. Containment and links are different:

- Containment determines location and breadcrumb paths.
- A Note Link creates a directed relationship without changing location, Project membership, or access.
- Links are untyped by default and may optionally receive a Member-defined semantic type.
- Backlinks, outgoing links, breadcrumbs, orphan detection, and broken-link maintenance are core navigation.

The desktop layout uses a collapsible left Note Tree, a dominant center editor, and a closed-by-default right context drawer for backlinks, properties, Project associations, sharing, and Discussions. Moving, archiving, or trashing a parent acts on the contained branch. Destructive confirmations preview descendants, Collections, Project-access changes, and external links. Moving a branch previews inherited Project membership gained or lost.

## Collections and views

A Note may define and own a Collection. A Collection stores records with these initial property types: text, number, checkbox, date/time, single-select, multi-select, person, URL, Attachment, and direct relations to Collection records, Notes, Tasks, and Projects.

View Blocks present either canonical Tasks or Collection records as boards, tables, lists, calendars, and later supported views. They own query, filter, grouping, sorting, and presentation state; they never own or copy the displayed items. Any accessible Note may embed a view of a Collection owned by another Note.

Archiving the defining Note preserves its Collections. Trashing or permanently deleting it requires moving each Collection to another Note or explicitly deleting it after previewing affected View Blocks and relations. Formulas, rollups, generated values, location, and plugin-defined persisted property types are deferred.

## Tasks, Workflows, and Projects

A Task is a canonical Workspace object. It may be associated with zero, one, or several Projects. Title, description, assignees, Workflow status, dependencies, and Subtasks remain identical in every view. A Subtask is a canonical Task with zero or one parent Task and independent Project associations.

Tasks appear through Task View Blocks and a built-in Tasks destination using the same view engine. The default Tasks view emphasizes the current Member and supports saved filters plus list, board, table, and calendar presentation. A focused Task detail surface remains available.

Members create Tasks inside Task View Blocks or deliberately promote selected Note content. Promotion preserves the source Block and visibly links it to the Task. Checklist items remain ordinary content unless explicitly promoted.

The Workspace owns one configurable Workflow, giving each Task one truthful status. Projects customize views, filters, and grouping rather than creating conflicting status systems.

A Project is an optional, nestable execution context around a goal or initiative. Each Project has zero or one parent. Parents aggregate child Projects and only information visible to the current Member. Projects relate Notes, Tasks, Members, repositories, and development activity without owning the Note Tree.

Associating a parent Note with a Project associates the complete contained branch. Moving a Note out of the branch removes inherited associations while retaining explicit ones. Linked Notes never inherit Project membership.

Each Project owns a prefix and Task-key sequence. Associating a Task assigns that Project's key; one Task may therefore be `MOBILE-7` and `LAUNCH-12`. Projectless and Project-agnostic views show the title and Project badges without inventing a Workspace key. Removed keys remain permanent aliases and are restored if the Task is re-associated with that Project.

## Permissions and collaboration

Project creation is a named Role permission. Owner and Admin receive it by default, Member does not, custom Roles may receive it, and personal Workspace owners always have it. The UI must expose permitted actions and explain unavailable actions instead of making capabilities appear nonexistent. Instance Administrator authority remains operational and grants no content access.

Access through any associated Project reveals the canonical Task but not inaccessible Project associations or related content. Associating content where it gains a broader audience is an explicit sharing action. Project parents do not silently grant access to restricted children; aggregation is permission-filtered.

Collaboration is contextual. Presence, sharing, and Discussions appear on the relevant Note, Block, Task, or Project. The context drawer is closed by default. Activity is a secondary aggregate view, not the homepage or permanent editor chrome.

## Visualization

Core navigation includes breadcrumbs, outgoing links, backlinks, broken-link maintenance, and a focused related-Notes neighborhood. Optional Visualization Blocks may save queries, filters, geometry, and presentation for local or global graphs, brain maps, word clouds, and freeform canvases. The same view may open full-screen.

Visualization state never mutates canonical Notes or Note Links without an explicit action. Canvas edges are view-only until promoted. Every visual view provides an equivalent navigable list, outline, or table. Server-side authorization filters nodes, labels, counts, and terms before transmission; queries use depth/node limits and progressive expansion.

Stash first defines a stable internal visualization interface and portable saved-view representation. Third-party execution waits for an explicit plugin security, permission, compatibility, and export design.

## Mobile

Mobile prioritizes offline capture, search, reading, lightweight editing, Note Tree organization, and Task review or updates. Existing complex views render readably, but Collection construction, large boards, administration, and visualization authoring remain desktop-first initially.

## Codebase architecture

The flat folders are replaced by deep capability modules, not technical-layer folders or noun buckets. Target server capabilities are:

- `identity-access`: setup, authentication, recovery, Roles, invitations, and sessions.
- `knowledge-authoring`: Notes, Blocks, Note Tree, links, Collections, Attachments, history, search, and export behavior.
- `work-planning`: Workspace Tasks, Subtasks, Workflows, Projects, View definitions, dependencies, and Automations.
- `development-integration`: repository connections, Signals, linked issues, and provider artifacts.
- `instance-operations`: runtime composition, diagnostics, backups, upgrades, deployment configuration, and storage kernel.

Each capability owns behavior, its internal repository seam, HTTP route registration, and focused interface tests behind one compact external interface. PostgreSQL adapters are split by capability over one private transaction/schema kernel. The composition root receives a compact capability registry instead of dozens of optional feature fields.

Web modules align with product capabilities without duplicating server internals. The shell consumes route and navigation contributions rather than importing every page. Shared workspace packages contain only contracts or behavior used by multiple real clients.

## Delivery and quality

Delivery uses a small number of substantial vertical milestones. Internal red-green-refactor steps do not become separate pull requests or CI runs. Each milestone must produce a coherent usable workflow or meaningful coupling reduction and pass its focused tests, `pnpm run check`, relevant browser/accessibility coverage, `pnpm run build`, and `git diff --check` before review.

UI implementation must follow the repository-required `gpt-taste` skill, preserve reduced-motion behavior, maintain keyboard access and visible focus, meet ADR-0033, and regenerate the reference images before final visual implementation.

## Acceptance

1. A fresh local Instance can be claimed without technical tokens, while a non-local Instance cannot be claimed without its short-lived setup code.
2. Setup lands in an authenticated personal Workspace containing a removable working tutorial.
3. A Member can create and navigate nested Notes, links, backlinks, and breadcrumbs without understanding Projects or Organizations.
4. Collections support the listed typed properties, relations, and reusable board/table/list/calendar View Blocks without copying records.
5. Tasks are canonical across global and embedded views, may participate in several nested Projects, retain one Workspace Workflow status, and receive stable Project-specific keys and aliases.
6. Project creation is visible and functional for authorized Roles and clearly explained when unauthorized.
7. Project association flows through Note containment but never through links, with permission-safe previews for moves and sharing.
8. Contextual collaboration does not occupy permanent editor space by default.
9. Core relationship navigation is usable without a graph; optional visualizations are permission-safe, portable, bounded, and accessible through non-visual equivalents.
10. The server and web no longer rely on universal flat-file composition or a single all-domain PostgreSQL adapter.
11. Mobile retains dependable offline capture and can read, organize, and update the redesigned core objects.
