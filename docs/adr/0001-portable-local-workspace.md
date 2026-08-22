---
status: superseded by ADR-0012
---

# Keep the workspace portable outside Stash

The local Workspace is the canonical record and must remain meaningfully usable without Stash. Notes and project metadata will use documented, text-based formats so users can move to other tools without losing their content or the relationships needed to understand it; accounts, synchronization, and hosted integrations may enhance a Workspace but must not be required to recover it. Files deliberately added to Stash export as Workspace-owned Attachments with relative links, while external embeds remain URLs with portable preview metadata and are not silently copied.
