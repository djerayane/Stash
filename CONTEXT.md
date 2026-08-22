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
Authored content that captures an idea or project knowledge and may later become the source of actionable work.
_Avoid_: Page

**Block**:
A persistently identifiable passage or element within a Note, such as a paragraph or checklist item. A Block may be linked to one or more Tasks while remaining visibly part of its Note.
_Avoid_: Fragment, section

**Discussion**:
A portable thread of comments attached to a Note, Task, or Block. Selected Discussion content may become a linked Note or Task, but a Discussion does not automatically become authored knowledge.
_Avoid_: Note, chat

**Task**:
A discrete piece of actionable work whose development progress is visible in Stash. A Task may draw from any number of Notes, and a Note may contribute to any number of Tasks.
_Avoid_: Ticket, issue, card

**Task Key**:
A short, human-readable identifier unique within a Project that helps Members and development providers refer to a Task.
_Avoid_: Issue key, database ID

**Task Key Alias**:
A permanently reserved former Task Key that continues resolving to the same Task after it moves to another Project.
_Avoid_: Redirect, reused key

**Dependency**:
A directed relationship in which one Task depends on another being completed. Dependencies inform warnings and Automations but do not directly change either Task's status.
_Avoid_: Block, link

**Signal**:
Evidence about a Task's development activity, such as branch, commit, or pull-request activity. A Signal may drive a configured status transition but is not itself the Task's status.
_Avoid_: Status, event

**Workflow**:
The configurable set of statuses through which a Project's Tasks progress. Boards present views over Tasks and may manipulate Workflow status, but do not own or duplicate Tasks.
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
An optional organizational and access boundary within a Workspace that groups Tasks, Notes, Members, and any number of connected repositories. Every Task belongs to one Project; a Note may be project-specific or workspace-wide.
_Avoid_: Folder, repository

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
