# Stash Capture

The Expo mobile client pairs directly with a Member-provided HTTPS Stash Instance. On native platforms, a Keychain/Keystore-backed key encrypts pairing, outbox, Project, tag, and reminder state with AES-GCM; SQLite stores only ciphertext and is not constrained by SecureStore payload limits. The web build is deliberately tab-memory-only: neither its key nor encrypted state enters browser storage, so credentials and Workspace metadata are never durably persisted. There is no relay service.

Text and checklist captures are saved locally before synchronization. Retriable network and server failures preserve the outbox; authorization and validation failures remain visible for correction. The stable client capture UUID makes retries idempotent at the Instance protocol.
