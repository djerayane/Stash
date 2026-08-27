# Stash web direction

These references are captures of the implemented acceptance application, not speculative mockups. They are regenerated with `node scripts/capture-web-direction.mjs` after building the web client and starting `scripts/browser-instance.ts`. Captures use reduced motion so each image records a stable rendered state.

The visual system is warm paper and ivory content surfaces, carbon navigation, editorial Geist typography, and vermilion reserved for focus, state, and consequential actions. Inbox, Note Tree, Search, and Tasks form the primary hierarchy. Projects and Activity are secondary; Collections live with their defining Note; collaboration stays in the closed-by-default Note context.

| Reference | Implemented behavior |
| --- | --- |
| `01-instance-setup.png` | Protected browser setup before an Instance has an owner. |
| `02-starter-workspace.png` | The real starter Note branch after atomic setup and authentication. |
| `03-note-tree-editor.png` | Desktop Note Tree, Collection workspace, and rich Note editor. |
| `04-links-backlinks.png` | Open contextual drawer with breadcrumbs, links, backlinks, maintenance, and related-Note outline. |
| `05-collections-view-blocks.png` | Editable starter Collection and reusable Task View Block. |
| `06-tasks.png` | Workspace-owned Tasks destination and saved view controls. |
| `07-nested-projects.png` | Secondary nested Project navigation and creation authority. |
| `08-contextual-collaboration.png` | Discussion attached to its Note, visible only after opening context. |
| `09-search.png` | Workspace Search across canonical knowledge and work. |
| `10-settings.png` | Member settings and portable Workspace data entry points. |
| `11-responsive-note.png` | The same Note workspace at a 390-pixel viewport with bottom navigation and readable composition. |

## Visualization boundary

The shipped relationship lens is the focused, permission-filtered related-Notes neighborhood with an equivalent navigable outline. The portable `VisualizationDefinition` also names `global-graph`, `brain-map`, `word-cloud`, and `canvas` so future renderers can consume the same safe query and saved presentation state. Those renderers are optional future work: none of these images claims that they ship today, and view-only geometry or edges never mutate canonical Notes or Note Links.
