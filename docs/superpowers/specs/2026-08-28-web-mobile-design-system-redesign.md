# Web and Mobile Design-System Redesign

## Goal

Make Stash feel coherent, deliberate, and durable across web and mobile without replacing the established warm-paper, carbon, sage, and vermilion direction. The redesign must make authored knowledge visually dominant, keep work-management and administrative surfaces recognizably part of the same product, and turn Collections into direct, comprehensible working tables rather than exposed infrastructure.

This specification refines the interface described by the knowledge-workspace redesign. It does not change the domain relationships recorded in `CONTEXT.md` or ADR-0044: Collections remain canonical structured records owned by a Note, and View Blocks remain reusable presentations that never copy their source records.

## Design diagnosis

The current implementation has the right palette and strong reference imagery, but its component grammar is inconsistent. Similar borders, panels, uppercase labels, and small controls carry too much of the hierarchy. Geist fills every typographic role. Vermilion sometimes communicates brand, state, focus, and action at once. Notes, Tasks, Projects, Settings, setup, and mobile capture therefore feel assembled independently rather than authored as one system.

The mobile implementation diverges further from the approved references through platform-default blue accents, default surfaces, inline styling, and weak screen-level composition. Native behavior remains desirable, but native defaults must be expressed through Stash's own semantic palette and hierarchy.

Collections expose the internal model before producing value. Schema authoring, record authoring, View Block creation, presentation controls, ownership, and destructive impact appear as separate sections. A Member must infer that these sections describe one Collection. Ordinary actions such as adding a property or record are spatially separated from the table they modify.

## Visual foundation

The retained semantic palette is:

- **Paper** `#f4f1e9`: application canvas and calm working background.
- **Ivory** `#fffdf8`: authored documents and elevated working surfaces.
- **Carbon** `#181a18`: navigation, primary ink, and high-contrast actions.
- **Vermilion** `#bf381f`: focus, consequential primary actions, conflicts, and the active thread.
- **Sage** `#929b88`: synchronized, settled, or secondary structural state.
- **Warm rule** `#d8d3c9`: quiet separation where spacing alone is insufficient.

Vermilion is not general decoration. A screen should normally have one dominant vermilion action or active state. Errors use a distinct semantic error tone even when related to vermilion. Sage never substitutes for disabled state.

Geist remains the body and utility face because it is legible in dense application controls. Major Note titles, first-run statements, and rare editorial moments receive a restrained display treatment with an explicitly packaged local face and robust fallback. The display face does not appear in table cells, menus, form labels, or dense administration.

Typography, spacing, control height, radius, shadow, and motion values become shared semantic tokens. Web consumes CSS tokens. Mobile consumes an equivalent typed theme rather than platform-blue defaults or screen-local color literals. Web and mobile share meaning, not component implementations.

The product's signature is the thread from knowledge to action. It appears only where it communicates a real relationship or state: current Note ancestry, selected navigation, source Blocks linked to Tasks, provenance, synchronization progress, and conflict recovery. Repeated decorative red rules, arbitrary badges, and ornamental thread graphics are removed.

## Composition and hierarchy

The application shell recedes behind the current work. Desktop navigation remains carbon but becomes quieter, with clearer grouping, fewer simultaneous destinations, and a single active indicator. The top bar contains global actions only. Note-specific actions stay with the Note or its context drawer.

Notes use a document-led composition: a dominant title and readable content measure, a compact formatting surface, and contextual information that remains closed until requested. Empty states invite the next concrete action. They do not introduce abstract product concepts before those concepts are needed.

Tasks, Projects, Search, Settings, and administration share the same page rhythm, title scale, action placement, filter grammar, and feedback patterns. They may vary in density according to their work, but they do not invent new button families, card treatments, or label conventions.

Cards are reserved for objects or choices that behave as contained units. Borders do not wrap every section. Spacing, alignment, background changes, and typographic hierarchy carry ordinary grouping. Uppercase labels are used only when the text encodes a real compact status or category; decorative meta-labels are removed.

First-run and authentication may use the more cinematic asymmetrical composition shown in the references. Headings remain two or three lines at supported widths, the primary action is unmistakable, and reference imagery supports the promise of personal, durable knowledge rather than competing with the form.

## Motion and interaction

Motion explains continuity instead of decorating screens. Navigation selection, opening context, changing a Collection presentation, saving offline, and resolving synchronization may animate with short, interruptible transitions. Direct manipulation receives immediate hover, press, focus, and insertion feedback.

Long pinned sections, scroll-scrubbed text, card stacking, and ambient motion belong only in explanatory first-run material where they improve comprehension. They are excluded from daily authoring and management surfaces. Reduced-motion preferences remove nonessential movement without removing state communication.

Every interactive control has visible keyboard focus, an accessible name, and a non-drag alternative. Pointer targets meet the stable accessibility requirement. Layout remains usable at 320 CSS pixels and under text zoom without relying on horizontal page scrolling; data tables may scroll inside their bounded region.

## Collection mental model

A Member experiences a Collection as one structured table. The title, properties, records, presentation, and ordinary controls appear as one cohesive object. The interface does not require a Member to understand schema administration or View Blocks before entering useful information.

Creating a Collection immediately creates an empty table with a primary text property named `Name`. Focus moves into the Collection title or first record according to the invoking action, and both paths allow useful content without a setup wizard.

Inside the table:

- Each Collection has one visible title and one compact header.
- Existing properties are column headers.
- A trailing add control immediately to the right of the last property adds a property.
- Activating that control opens an anchored property menu for name and type, then inserts and focuses the new column.
- A property header menu contains rename, type change when safe, duplicate, reorder, and delete actions.
- A `New record` row sits immediately below the final record and focuses the primary cell when activated.
- Cells edit in place with type-appropriate controls and explicit save or recovery feedback when needed.
- Keyboard navigation follows familiar table behavior and does not trap focus.
- A `New collection` action appears immediately below the last Collection owned by the Note.

The initial table contains no separate authoring lane, schema form, or record-management section. Advanced structure is progressively disclosed from the exact property, record, or Collection it affects.

## Collection presentations and reuse

Table, board, list, and calendar are presentations of the same Collection records. The Collection header contains the presentation selector. Changing presentation does not create another apparent Collection, move records, or duplicate data.

Filters, sorting, grouping, visible properties, and density live behind one `View` control. The control summarizes active changes in plain language. Presentation-specific requirements are requested in context: choosing Calendar asks for a date property if none exists; choosing Board asks for a grouping property if none is suitable. Stash offers to add an appropriate property without forcing the Member into a distant schema editor.

Embedding records from a Collection owned by another Note is a distinct action named `Insert view of another collection`. It begins with source selection, then inserts a View Block whose default presentation is immediately useful. The Member sees the source Collection's title and owning Note so reuse is legible. The term `View Block` remains domain and implementation language; ordinary interface copy uses concrete language such as `Table`, `Board`, `Calendar`, `View`, and `Insert view`.

A reused view may have its own filters, sorting, grouping, presentation, and visible-property choices. Editing a record changes the canonical record everywhere. The interface states this at the point of the first cross-Note edit, not as permanent explanatory copy.

## Collection ownership and destructive actions

Ownership is not a permanent section in the normal Collection workspace. The Collection overflow menu exposes `Move to another Note`, `Duplicate`, and `Delete collection`. Moving or deleting opens a focused impact dialog listing affected records, relations, and inserted views.

Archiving the owning Note preserves its Collections. Trashing or permanently deleting that Note continues to require relocation or explicit Collection deletion as recorded in ADR-0044. These safeguards remain strong but appear only when the destructive journey begins.

If a Collection or reused view is unavailable, the interface preserves its place in the Note, explains whether access, deletion, or synchronization caused the problem when that information is safe to reveal, and provides the next available action. It never silently replaces the view with an empty table.

## Mobile direction

Mobile remains composition-light as recorded in ADR-0051. Its primary hierarchy is Capture, Inbox or Notes, Search, and Tasks. Pairing and synchronization status remain available without dominating every screen.

The approved mobile references define screen composition: warm paper, carbon type, Stash vermilion actions, sage synchronization feedback, generous titles, stable bottom actions, compact structure sheets, and clear offline recovery. Platform-native controls and accessibility behavior remain, but they use Stash semantic colors and deliberate spacing.

Mobile renders Collections readably and supports lightweight record inspection and editing. Large table schema construction, complex board manipulation, and advanced view configuration remain desktop-first. On a phone, a Collection defaults to a readable record list or focused-record surface rather than compressing an unusable desktop table. The presentation identity and canonical-record behavior remain visible.

## Content and feedback

Interface language names what the Member controls. Buttons use concrete verbs such as `New collection`, `Add property`, `New record`, `Insert view`, `Move collection`, and `Delete collection`. `Submit`, `Configure schema`, and unexplained implementation nouns are avoided.

Actions retain their names through completion feedback. Empty states state what can be added. Errors state what failed, whether work was preserved, and the next available action. Synchronization feedback distinguishes saved on this device, waiting to synchronize, synchronized, and needs attention.

## Delivery boundaries

The redesign is implemented as coordinated, reviewable slices:

1. Shared semantic tokens, typography, controls, feedback, and layout primitives.
2. Web shell, Note Tree, Note editor, context, and first-run surfaces.
3. Direct-manipulation Collections and presentation controls.
4. Tasks, Projects, Search, Settings, and administration alignment.
5. Mobile theme, pairing, capture, offline feedback, reader, and Task surfaces.
6. Responsive reference regeneration, interaction refinement, and accessibility verification.

Existing domain and API contracts should be preserved where they support this experience. Component boundaries may be reshaped substantially. Domain changes require separate justification and documentation; visual convenience alone does not authorize duplicating records or weakening Collection ownership.

## Verification

Each slice includes focused component and interaction tests plus the repository-wide type, check, and build gates appropriate to the changed clients. The Collection slice adds browser coverage for:

- creating a Collection and entering the first record without leaving the table;
- adding, renaming, reordering, and deleting a property from its header;
- adding and editing records with keyboard-only interaction;
- changing presentation and configuring required grouping or date properties in context;
- inserting a view of another Collection and observing canonical edits from both locations;
- recovering from save, access, and synchronization failures without losing entered work;
- moving or deleting a Collection through a complete impact preview;
- narrow viewport, text zoom, reduced motion, and automated accessibility checks.

Web and mobile reference captures are regenerated from running acceptance applications. Visual review compares the complete journeys, not isolated components, at desktop and narrow widths. Mobile verification uses the native development client or emulator for platform-specific interaction and appearance; a web export alone is insufficient.

## Acceptance

1. Web and mobile retain the approved color and image direction while sharing one recognizable visual grammar.
2. Notes remain the dominant authored surface; navigation and context support rather than compete with them.
3. Tasks, Projects, Search, Settings, and administration share consistent hierarchy, controls, spacing, and feedback.
4. A Member can create a Collection and enter records immediately without first configuring a schema or View Block.
5. Adding a property is discoverable at the right edge of the existing headers, and adding a record is discoverable below the final row.
6. Adding another Collection is available directly below the final Collection owned by the Note.
7. Table, board, list, and calendar remain presentations of one canonical Collection and are changed from the Collection header.
8. Advanced view configuration is progressively disclosed and remains attached to the Collection it affects.
9. Reusing another Collection is explicit, identifies its source, and never copies records.
10. Ownership and destructive-impact safeguards remain correct without occupying the ordinary authoring surface.
11. Mobile uses Stash semantic colors and the approved reference composition while retaining native behavior and dependable offline feedback.
12. All redesigned journeys remain keyboard accessible, understandable under reduced motion, and usable at supported narrow widths and text zoom.
