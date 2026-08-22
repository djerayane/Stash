# Merge collaborative edits without silent data loss

Stash uses operation-based collaborative editing for Note bodies and field-level merging for structured objects so Members can work simultaneously or offline. The portable Markdown file is a materialized representation rather than the network protocol; when edits cannot be merged automatically, Stash preserves every version and presents a focused conflict resolver instead of silently choosing a winner or exposing raw conflict markers.
