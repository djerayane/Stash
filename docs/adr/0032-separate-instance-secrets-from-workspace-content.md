# Separate Instance secrets from Workspace content

Stash application-encrypts integration credentials, recovery secrets, and authentication material with an Instance master key stored outside the database, while ordinary Workspace content relies initially on operator-managed database and volume encryption. Mobile offline data uses platform-backed keys, Portable Workspace Exports never contain secrets, and Instance Backup restore behavior explicitly accounts for the separate master key rather than producing undecryptable silent failures.
