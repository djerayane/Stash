# Prefer Instance-owned GitHub Apps

Each Instance primarily connects to GitHub through an operator-configured GitHub App, providing scoped repository installation, webhooks, auditable permissions, and clean revocation. Fine-grained personal access tokens may support limited solo setups with explicit capability warnings; credentials are encrypted at rest, excluded from Portable Workspace Exports, and Repository Connections never cross Organization boundaries.
