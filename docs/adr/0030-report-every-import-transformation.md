# Report every import transformation

Stash imports Obsidian and ordinary Markdown folders first, preserving paths, links, tags, and Attachments where possible, followed by Notion exports and Jira CSV migration for established teams. Every importer emits a durable report of transformed, skipped, and ambiguous records rather than silently discarding or inventing data.
