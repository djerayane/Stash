# Portable Workspace Export v1

`stash.portable-workspace-export.v1` is a deterministic ZIP archive for the
permission-aware Workspace snapshot visible to the requesting Member. It is a
portable export, not an Instance Backup: authentication material, integration
credentials, and other Instance secrets are never included.

## Layout

- `manifest.json` identifies the Workspace and lists the byte length and SHA-256
  checksum of every other file.
- `notes/<note-id>.md` stores `stash.note.v1` metadata in YAML-compatible front
  matter and the readable Note Markdown as its body. Stable identifiers and
  relative links remain in the document; Attachment links use `../attachments/`.
- `tasks/<task-key>--<task-id>.md` stores the complete `stash.task.v1` projection
  in YAML-compatible front matter, including Task Key aliases, Note and Block
  relationships, Dependencies, planning properties, and development links. Its
  body begins with a readable Task Key and title.
- `attachments/<attachment-id>/<encoded-filename>` contains the exact uploaded
  Attachment bytes at the path recorded by `stash.attachment.v1`.
- `README.md` explains the archive to a person opening it without Stash.

Every ZIP entry is stored without compression, uses a fixed archive timestamp,
and is ordered by its UTF-8 path. Exporting an unchanged snapshot therefore
produces identical bytes. `manifest.json` is omitted from its own checksum list.

The repository boundary must read all included records and Attachment bytes as
one consistent, authorization-filtered snapshot. Stash buffers and validates the
complete archive before writing an HTTP response; failures return JSON and never
produce a partial archive.
