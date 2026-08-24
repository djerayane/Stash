# Instance Distribution Design

## Goal

Make a fresh Stash checkout immediately runnable with `docker compose up -d`, while publishing versioned Docker, standalone server, and mobile artifacts for operators and Members who do not want to build from source.

## Supported paths

### Local evaluation

From a fresh checkout, `docker compose up -d` builds and starts PostgreSQL and one Stash application container without requiring an `.env` file or exported variables. Compose publishes exactly `127.0.0.1:${STASH_PORT:-3000}:3000`; the Instance becomes healthy and serves the web application at `http://localhost:3000` with the default port without listening on every host interface.

The defaults are explicitly development-only. They use a deterministic administrator token and master key, a localhost public origin, persistent named volumes, and no optional external services. Startup output and documentation tell operators to replace these values before exposing the Instance beyond localhost.

### Production container deployment

Strict semantic-version tags publish `ghcr.io/djerayane/stash` multi-architecture OCI images for `linux/amd64` and `linux/arm64`. Images are addressed by the exact semantic version and, as the permanent identity, the OCI manifest digest; moving major/minor aliases may be added only after a stable-release policy exists. The repository Compose file remains buildable from source and can also accept an image override without changing its service contract.

Production deployments must supply unique administrator and master-key secrets, an HTTPS `PUBLIC_ORIGIN`, and a strong PostgreSQL password. Release images must not embed secrets or silently substitute development defaults inside the application.

### Self-contained Instance bundles

Version tags publish self-contained Instance bundles for Linux, macOS, and Windows on x64, plus arm64 where the packaging toolchain supports it. A bundle includes the compiled server, built web client, embedded PostgreSQL-compatible engine, local Attachment storage, required runtime, license, and launcher. Starting it requires one command and no Docker, Node, pnpm, or separately installed database.

The standalone Instance defaults to loopback and keeps its database, Attachments, backups, and generated local configuration beneath one explicit data directory. The launcher accepts a data-directory option, refuses unsafe external binding while evaluation credentials remain, obtains an exclusive process lock, and never writes durable state beside the executable. An interrupted start or upgrade must leave the prior data directory recoverable.

The embedded engine is an adapter behind the same permission-aware repositories and transaction boundaries as PostgreSQL. It must pass the shared behavioral contract for migrations, transactions, search, synchronization, durable jobs, backup/restore, and Portable Workspace Export. Unsupported PostgreSQL behavior fails during build or preflight rather than degrading a feature silently.

A documented migration command exports a consistent standalone Instance and imports it into an empty, compatible external-PostgreSQL Instance with identities, history, configuration, Attachments, and checksums preserved. `INSTANCE_MASTER_KEY` remains outside both databases under ADR-0032 and is never included in an archive, export, backup payload, checksum manifest, or log. The operator selects one of two explicit modes using protected key-file inputs rather than command-line secret values: preserve mode supplies the source key file and requires the destination Instance configuration to reference the same key; rotate mode supplies distinct source and destination key files and re-encrypts all protected authentication, recovery, and integration state before cutover. The command never copies a key into destination storage or silently generates one.

Migration preflight quiesces and locks the source, requires an empty compatible destination, validates that the source key decrypts representative and then all protected records, validates the destination key/configuration boundary, checks capacity and Attachment destinations, and writes only to a destination staging transaction/directory. Any validation, copy, checksum, or re-encryption failure rolls back the destination and leaves the source authoritative and restartable. The migration fixture contains accounts, Organizations, built-in and custom Roles, memberships, local and imported identities, Workspaces, history, audit records, Instance configuration, and Attachments with checksums. Cutover occurs only after that complete fixture matches, encrypted authentication and integration state decrypts with the configured destination key, migrated accounts can authenticate, Role and membership authorization decisions remain identical, and neither key appears in artifacts, process arguments, diagnostics, or logs.

Each archive has a SHA-256 checksum. CI extracts every bundle and runs a startup/configuration smoke check on its target runner before publishing it.

### Mobile builds

Pull requests verify that Expo configuration and native projects can be generated without publishing. Release configuration commits the EAS owner `djerayane` and the real, non-secret EAS project UUID returned by `eas init` alongside the existing `stash-capture`, `app.stash.capture`, and `app.stash.capture` application identities. CI authenticates non-interactively only through the `EXPO_TOKEN` GitHub Actions secret, while pull requests validate all non-secret identity fields without receiving that secret.

Strict semantic-version tags submit Android and, when configured, iOS production builds through EAS. Android produces an installable APK for direct testing and an AAB for store distribution; its job fails with `Android release unavailable: configure the EAS Android keystore for app.stash.capture` when that required signing capability is absent. The independent iOS job produces and claims an IPA only when its Apple distribution certificate and provisioning profile are available. Otherwise it records a skipped iOS capability with `iOS release unavailable: configure the Apple distribution certificate and provisioning profile for app.stash.capture` without suppressing a valid Android publication. A missing `EXPO_TOKEN` fails both platform jobs before submission with `Mobile release unavailable: configure the EXPO_TOKEN GitHub Actions secret`. No job publishes or claims an unsigned artifact.

Mobile artifacts connect directly to a Member-supplied HTTPS Instance and do not introduce a hosted Stash relay.

## Workflow boundaries

- Pull requests build, test, and smoke-check distributable artifacts but never publish them.
- One reusable release-quality workflow has an explicit `release` boolean input, defaulting to `false`. Its common path always verifies repository checks and tests, Compose startup and web response, OCI image health, extracted standalone bundles on every target runner, Expo identity/native generation, and artifact metadata; pull requests call only this common path and neither receive nor reference `EXPO_TOKEN` or any release credential. When `release: true`, a separate conditional preflight receives a dedicated least-privilege Expo automation token through the explicitly mapped `EXPO_TOKEN` secret and uses it only for authenticated EAS collision and signing-capability probes, alongside semantic-version/ref and other publication-collision checks. The token is masked and never exported to common jobs or artifacts. The central tag workflow invokes the reusable workflow as the `release-quality` job with `release: true`, and every container, GitHub Release/server-bundle, Android, and iOS publish job directly declares `needs: release-quality`; mobile publisher jobs receive the same explicitly scoped secret, and no publisher can run from a merely successful build job.
- A tag event is only a candidate release. The tag-only preflight parses the ref as canonical SemVer 2.0.0 and accepts `v<major>.<minor>.<patch>` with an optional prerelease field; build metadata is rejected so the version maps losslessly to an OCI tag. It rejects a tag whose resolved commit differs from `GITHUB_SHA` and rejects any existing GitHub Release, release asset name, GHCR semantic-version tag, or EAS release association for that version.
- Published GitHub Release assets are created without overwrite, and the workflow records the source commit, OCI manifest digest, and SHA-256 digest of every downloadable artifact. Those digests are the immutable identities. Because Git tags can be force-moved, moving or recreating a tag never authorizes replacement: protected-tag rules are the first guard, collision/ref checks make the rerun fail closed, and already-published artifacts remain identified by their original digests.
- Manual workflow dispatch may build diagnostics artifacts but may not overwrite a tagged release.
- GitHub Actions use least-privilege permissions. Package publication receives `packages: write`; release publication receives `contents: write`; mobile credentials remain encrypted secrets managed outside the repository.
- Artifact metadata records the source commit and version. Published checksums allow operators to verify downloaded server bundles.

## Documentation

The README leads with the exact zero-input local command and URL. A separate installation guide compares source Compose, prebuilt-container, and standalone-server paths, then documents production secrets, upgrades, persistence, architecture support, checksums, and mobile installation. No documentation calls a development default safe for Internet exposure.

## Acceptance

1. On a clean checkout with Docker available, `docker compose up -d` reaches a healthy Stash service and `http://localhost:3000` returns the built React application.
2. `docker compose config` succeeds without environment variables; the source mapping is exactly `127.0.0.1:${STASH_PORT:-3000}:3000`, the empty-environment render is `127.0.0.1:3000:3000`, and an automated socket check proves it is unreachable through non-loopback host interfaces. A production validation path rejects missing or development-only secrets.
3. Pull-request workflows build and smoke-test the Docker image and a fresh and restarted standalone Instance without publishing or using an external database.
4. A canonical semantic-version tag whose ref and version have no publication collision passes the common quality checks and tag-only release preflight before publishing `ghcr.io/djerayane/stash`, checksummed standalone bundles, signed Android artifacts, and an IPA only when iOS signing is configured; every publish job directly depends on the gate containing all checks available at that task boundary.
5. A standalone Instance survives restart from its chosen data directory and migrates into an external-PostgreSQL Instance without semantic loss.
6. Standalone migration preserves accounts, Organizations, Roles and memberships, identities, Workspaces, history, audit data, configuration, Attachments/checksums, usable authentication and authorization, and encrypted recovery/integration state through explicit operator-controlled key preservation or re-encryption; it rolls back safely on failure and never exposes either master key in an artifact or log.
7. Release documentation lets an operator select a path and reach the web interface without inspecting source code.
