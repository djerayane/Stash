# Stash Capture

The Expo mobile client pairs directly with a Member-provided HTTPS Stash Instance. Pairing credentials and each pending capture are stored with `expo-secure-store`, using platform-backed Keychain/Keystore protection. Cached non-secret Project and tag options use Expo SQLite's local-storage layer. There is no relay service.

Text and checklist captures are saved locally before synchronization. Retriable network and server failures preserve the outbox; authorization and validation failures remain visible for correction. The stable client capture UUID makes retries idempotent at the Instance protocol.
