# Stash

Stash connects early project thinking with the development work that follows, while keeping a user's information portable outside the product.

## Language

**Member**:
A person who belongs to a Workspace and may participate in planning, development, or both according to their permissions.
_Avoid_: Planner, Developer, User

**Guest**:
A person invited with read-only access to selected Projects rather than general Organization membership.
_Avoid_: Public visitor, Member

**Identity Stub**:
An immutable representation of a person imported from another Instance when no local account has been mapped to that identity. It preserves original attribution without impersonating a local Member.
_Avoid_: Guest, placeholder Member

**Role**:
A named collection of permissions assigned to Members. Owner, Admin, and Member are immutable built-in Roles; additional Roles may be created and edited within the administrator's own authority.
_Avoid_: User type, access level

**Note**:
Authored, block-based content that captures and develops knowledge. A Note may contain child Notes in the Note Tree, link to Notes elsewhere in that tree, and become the source of actionable work.
_Avoid_: Page

**Note Tree**:
The primary navigational hierarchy of Notes within a Workspace. A Note has at most one parent; links and later graph views reveal relationships across the tree without replacing it as the familiar way to orient and organize.
_Avoid_: Folder tree, Project hierarchy

**Block**:
A persistently identifiable passage or element within a Note, such as a paragraph, checklist item, or interactive view. A Block may be linked to one or more Tasks while remaining visibly part of its Note.
_Avoid_: Fragment, section

**Note Link**:
A directed relationship from one Note or Block to another Note. Links are untyped by default but may carry a Member-chosen relationship type; they never imply containment, Project membership, or access.
_Avoid_: Note Tree edge, shared Note

**Discussion**:
A portable thread of comments attached to a Note, Task, or Block. Selected Discussion content may become a linked Note or Task, but a Discussion does not automatically become authored knowledge.
_Avoid_: Note, chat

**Task**:
A discrete piece of actionable work within a Workspace whose development progress may be visible in Stash. A Task may draw from any number of Notes and may be associated with zero, one, or several Projects without being owned by any of them.
_Avoid_: Ticket, issue, card

**Subtask**:
A Task with one parent Task. It remains independently actionable and may have Project associations different from its parent.
_Avoid_: Checklist item, Project-specific Task

**Task Key**:
A short, human-readable identifier assigned from a Project's own prefix and sequence when a Task is associated with it. One Task may have a different Task Key in each associated Project; Project nesting does not produce compound keys, and Projectless or Project-agnostic views identify the Task by title while stable identity remains internal.
_Avoid_: Issue key, database ID

**Task Key Alias**:
A permanently reserved former Task Key that continues resolving to the same Task after its Project association is removed. Re-association with that Project restores the reserved key, which is never assigned to another Task.
_Avoid_: Redirect, reused key

**Dependency**:
A directed relationship in which one Task depends on another being completed. Dependencies inform warnings and Automations but do not directly change either Task's status.
_Avoid_: Block, link

**Signal**:
Evidence about a Task's development activity, such as branch, commit, or pull-request activity. A Signal may drive a configured status transition but is not itself the Task's status.
_Avoid_: Status, event

**Workflow**:
The Workspace-owned configurable set of statuses through which Tasks progress. Projects customize Task views, filters, and grouping without defining a conflicting status for the same Task.
_Avoid_: Board workflow, pipeline

**Status Category**:
One of unstarted, started, or completed, assigned to every Workflow status so reporting and Automations retain stable meaning when Projects customize status names.
_Avoid_: Status, column

**Automation**:
A Project-scoped rule that responds to a trigger, optionally evaluates conditions, and performs an action. Automations are configured through contextual recipes or a no-code When/If/Then editor.
_Avoid_: Script, bot

**Agent Grant**:
A revocable, scoped authorization through which an external agent acts on behalf of a sponsoring Member. It limits data access, capabilities, lifetime, and which actions require a Proposal or confirmation.
_Avoid_: API key, bot account

**Proposal**:
A reviewable set of changes prepared by an agent but not applied to canonical Workspace data until a Member accepts it. Agent Grants may instead permit selected actions to apply directly.
_Avoid_: Draft Note, pull request

**Linked Issue**:
An issue owned by an external development provider and represented in Stash without becoming a native Task.
_Avoid_: Synced Task

**Workspace**:
The portable collection of a person or team's Notes, Tasks, relationships, and project metadata. A Workspace belongs to either an individual or an organization rather than to the Stash service.
_Avoid_: Vault, space

**Instance**:
A self-hosted Stash installation that serves the web application and owns its runtime configuration, accounts, and one or more Workspaces.
_Avoid_: Server, deployment

**Instance Administrator**:
An operator responsible for an Instance's infrastructure and configuration who does not automatically become an Organization Member or receive content access through the application.
_Avoid_: Owner, superuser

**Organization**:
An isolated group of Members, Roles, Projects, and team Workspaces hosted within an Instance. An Instance may host multiple Organizations without sharing their membership or ordinary application access.
_Avoid_: Team, tenant

**Portable Workspace Export**:
A documented, self-contained representation from which all durable Workspace meaning can be reconstructed in another Instance. Instance-specific identities may degrade to preserved names when no matching account exists.
_Avoid_: Backup, dump

**Instance Backup**:
A restorable representation of an Instance that preserves Instance-specific state and identity links in addition to every Workspace.
_Avoid_: Export, Workspace archive

**Project**:
An optional execution context within a Workspace that relates Tasks, Notes, Members, and connected repositories around a goal or initiative. A Project has at most one parent and aggregates information from its child Projects, but does not own the Workspace's knowledge hierarchy.
_Avoid_: Folder, repository, Task container

**Collection**:
A structured set of records defined and owned by one Note for knowledge that benefits from consistent typed properties without becoming Tasks. Collections support direct relations to other Collections and may be presented through multiple accessible View Blocks without copying records; removing the owning Note requires deliberate relocation or deletion of its Collections.
_Avoid_: Task list, spreadsheet

**Collection Property**:
A typed field shared by the records in a Collection, initially supporting text, number, checkbox, date and time, single-select, multi-select, person, URL, Attachment, and direct relations to Collection records, Notes, Tasks, or Projects.
_Avoid_: Column, Task field

**View Block**:
An interactive Block that presents canonical Tasks or Collection records as a board, table, list, calendar, or another supported view. A View Block stores presentation and filtering choices rather than owning or copying the items it displays.
_Avoid_: Board object, embedded copy

**Visualization Block**:
An optional Block that presents a permission-filtered relationship or content query through a saved visual layout, such as a local graph, brain map, word cloud, or spatial canvas. Its query, geometry, and view-only edges are presentation state and do not alter canonical Notes or Note Links without an explicit action.
_Avoid_: Note Tree, canonical graph

**Repository Connection**:
An Organization-owned authorization and configuration that lets Projects relate Tasks to repositories and receive development Signals. One Repository Connection may serve several Projects within its Organization but never crosses Organization boundaries.
_Avoid_: Repository, integration account

**Inbox**:
The state and view for Notes captured before they have been organized. An Inbox Note may optionally carry structure, but none is required at capture time.
_Avoid_: Unsorted Project

**Template**:
An optional starting structure that may suggest content, properties, and validation hints for a Note without creating a distinct Note type.
_Avoid_: Note type, schema

**Decision Note**:
A Note created from the Decision template to record a settled choice, its context, and resulting work. It remains a Note rather than a separate domain object.
_Avoid_: Decision object, record

**Attachment**:
A file deliberately added to a Workspace and owned as part of its portable data. Content referenced only through an external URL is an embed, not an Attachment.
_Avoid_: Embed, asset

**Archive**:
The retained state for a Note, Task, or other durable object removed from normal active views without deleting its content or relationships.
_Avoid_: Trash, deleted
