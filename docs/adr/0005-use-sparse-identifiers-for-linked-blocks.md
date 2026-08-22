# Give identity only to referenced Blocks

Stash stores a documented, Markdown-compatible identifier beside a Block only when another object needs to reference it. The editor renders live Task state without writing that volatile state into the Note, keeping ordinary Markdown clean and preventing status changes from creating content churn; externally broken references are surfaced rather than silently redirected when they cannot be repaired unambiguously.
