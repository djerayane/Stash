# Instance Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a zero-input local Compose experience and publish verified Docker, standalone server, and mobile release artifacts.

**Architecture:** Every distribution path packages the same compiled server and React client. Compose and OCI use external PostgreSQL; standalone uses a filesystem-persistent embedded PostgreSQL-compatible adapter behind the same behavioral contracts and supplies a lossless migration path to external PostgreSQL. Task 2 creates the reusable gate, central release workflow, and container publisher; Tasks 4 and 5 sequentially extend that same gate and workflow with server and mobile checks/publishers. Each publisher directly needs the complete `release-quality` gate as it exists after its task, while Task 6 validates and documents the finished contract without owning publication wiring.

**Tech Stack:** Docker Compose, Docker Buildx, GitHub Actions, Node.js 22, pnpm, Expo/EAS, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-24-instance-distribution-design.md`

## Global Constraints

- `docker compose up -d` must work from a clean checkout with no environment variables.
- Compose must publish the application port as exactly `127.0.0.1:${STASH_PORT:-3000}:3000` and must not listen on all host interfaces by default.
- Development defaults must be bound to and documented for localhost evaluation only.
- Production deployments must retain explicit strong secrets and an HTTPS public origin.
- Standalone startup must require no Docker, Node, pnpm, or separately installed database.
- Standalone durable state must live beneath one explicit data directory and migrate losslessly to the standard external-PostgreSQL deployment.
- `INSTANCE_MASTER_KEY` remains operator-managed outside storage and must never appear in a bundle, migration artifact, backup payload, process argument, diagnostic, or log.
- Pull requests must never publish release artifacts.
- Only canonical SemVer 2.0.0 tags prefixed with `v` may publish artifacts from the tested revision; prereleases are allowed and build metadata is rejected so the version maps losslessly to an OCI tag.
- Prerelease tags publish OCI/server artifacts and an Android preview APK, but skip the store AAB and IPA. Stable `vMAJOR.MINOR.PATCH` maps exactly to iOS `CFBundleShortVersionString` and Android `versionName` `MAJOR.MINOR.PATCH`.
- EAS remotely allocates strictly increasing Android `versionCode` and iOS `buildNumber` values; preflight rejects semantic-version or native-build-number collisions before submission.
- Every publish job must directly `needs: release-quality`; common quality and artifact-smoke checks run for pull requests without secrets, while ref, collision, credential, and signing preflight runs only when the workflow's explicit `release` input is `true` and may receive explicitly mapped `EXPO_TOKEN`.
- Release preflight must reject a tag/ref mismatch or any existing GitHub Release, asset, GHCR version tag, or EAS version association; publishers never overwrite an existing artifact.
- OCI manifest and SHA-256 digests are immutable artifact identities. A moved or recreated Git tag fails collision/ref checks and cannot replace a prior release.
- The canonical container repository is exactly `ghcr.io/djerayane/stash` in workflow outputs, examples, and executable documentation checks.

---

### Task 1: Zero-input Compose quick start

**Depends on:** none.

**Files:**
- Modify: `compose.yaml`
- Modify: `README.md`
- Create: `scripts/verify-compose.ts`
- Test: `tests/compose.test.ts`

**Interfaces:**
- Produces: a default Compose configuration whose `stash` service reaches `/health/ready` and serves `/` through exactly `127.0.0.1:${STASH_PORT:-3000}:3000`.

- [ ] Write an acceptance test that runs `docker compose config` with an empty environment, asserts the source mapping is exactly `127.0.0.1:${STASH_PORT:-3000}:3000`, its rendered default is `127.0.0.1:3000:3000`, and persistent volumes remain configured.
- [ ] Run `pnpm run test:server -- tests/compose.test.ts` and confirm it fails because required interpolation variables are absent.
- [ ] Add explicit development defaults in `compose.yaml` while preserving environment overrides and production validation in the application.
- [ ] Add a verifier that waits for readiness, confirms the React entry document is served through loopback, and proves the published port is unreachable through non-loopback host interfaces.
- [ ] Run `docker compose up -d --build`, the verifier, and `docker compose down`; confirm data volumes are retained.
- [ ] Update the README quick start and production-hardening warning.
- [ ] Commit with `fix(compose): make local instance startup zero-config`.

### Task 2: Multi-architecture container publication

**Depends on:** Task 1. GitHub Task #138 retains its existing prerequisite and precedes #139.

**Files:**
- Create: `.github/workflows/release-quality.yml`
- Create: `.github/workflows/release.yml`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the Dockerfile and Compose service contract verified by Task 1.
- Produces: reusable common repository/Compose/OCI quality checks and published `ghcr.io/djerayane/stash:<version>` images for `linux/amd64`/`linux/arm64`, with immutable manifest-digest and source-commit outputs.

- [ ] Add a pull-request job that builds the image and runs its health smoke check without pushing.
- [ ] Create one reusable `workflow_call` quality workflow with a boolean `release` input defaulting to `false`; add repository checks/tests, Compose startup and web response, and OCI health smoke testing to its unconditional common path.
- [ ] Call the reusable workflow from pull-request verification with `release: false`; prove this path neither inspects a tag nor receives release credentials.
- [ ] Add the initial `release: true` preflight that parses canonical SemVer, rejects build metadata, verifies the tag resolves to `GITHUB_SHA`, and rejects existing `ghcr.io/djerayane/stash:<version>` or GitHub Release collisions without running on pull requests.
- [ ] Create the central tag workflow, invoke the reusable workflow as `release-quality` with `release: true`, and add the container publisher with `needs: release-quality`, `packages: write`, no-overwrite collision handling, Buildx provenance, and exact `ghcr.io/djerayane/stash:<version>`, manifest-digest, and source-commit outputs.
- [ ] Add an `STASH_IMAGE` Compose override while retaining `build: .` for fresh-checkout use.
- [ ] Validate workflow syntax, build the local target, assert the Compose source mapping is exactly `127.0.0.1:${STASH_PORT:-3000}:3000` and its empty-environment render is `127.0.0.1:3000:3000`, then prove the running port is unreachable through non-loopback host interfaces.
- [ ] Document prebuilt-image startup and digest pinning using exactly `ghcr.io/djerayane/stash`.
- [ ] Commit with `ci: publish verified Stash container images`.

### Task 3: Embedded standalone storage

**Depends on:** none.

**Files:**
- Create: `src/storage/instance-store.ts`
- Create: `src/storage/postgres-instance-store.ts`
- Create: `src/storage/embedded-instance-store.ts`
- Create: `src/standalone-migration.ts`
- Modify: server composition roots that currently construct PostgreSQL repositories directly.
- Test: shared storage contract, backup/restore, upgrade, and migration acceptance suites.

**Interfaces:**
- Produces: one Instance-store contract implemented by external PostgreSQL and a filesystem-persistent embedded PostgreSQL-compatible engine; `migrateStandaloneInstance({ sourceDataDir, destinationDatabaseUrl, mode, sourceMasterKeyFile, destinationMasterKeyFile? })` transfers one quiesced Instance without semantic loss. `mode: "preserve"` requires the destination configuration to use the source key and forbids `destinationMasterKeyFile`; `mode: "rotate"` requires both protected key files and re-encrypts protected state for the destination key.

- [ ] Inventory every SQL feature, extension, transaction boundary, search query, migration, and durable-job behavior used by the running Instance; encode unsupported embedded capabilities as failing contract tests before selecting or integrating the engine.
- [ ] Write shared red tests that run the same repository, authorization, synchronization, search, backup/restore, and upgrade behavior against external PostgreSQL and a temporary embedded data directory.
- [ ] Introduce the narrow Instance-store composition boundary without duplicating domain rules or weakening PostgreSQL behavior.
- [ ] Implement the embedded adapter with filesystem persistence, transactions, migrations, exclusive-process locking, clean shutdown, and crash-safe restart.
- [ ] Build one migration fixture containing accounts, Organizations, immutable built-in Roles, memberships, local and imported identities, Workspaces, history, audit records, Instance configuration, and Attachments with checksums; do not require deferred custom-Role creation or editing. Write red tests for both key modes: preserve mode rejects a destination not configured with the supplied source key; rotate mode rejects a missing or identical destination-key input; both modes prove migrated accounts authenticate, authorization decisions for every built-in Role/membership remain identical, and recovery/integration records decrypt after cutover.
- [ ] Implement migration preflight that quiesces and exclusively locks the source, requires an empty compatible destination, reads keys only from permission-checked files, validates source decryption and destination key configuration, checks capacity and Attachment destinations, and rejects secret-bearing command-line arguments.
- [ ] Implement the copy through a destination database transaction and staging Attachment directory. In preserve mode leave encrypted values unchanged after proving the destination key boundary; in rotate mode decrypt and re-encrypt every protected record. Atomically cut over only after semantic/checksum and protected-state validation; otherwise roll back destination writes, remove staging output, and leave the source authoritative and restartable.
- [ ] Test that failed validation, copy, checksum, and re-encryption each roll back cleanly, and scan archives, migration artifacts, backups, diagnostics, process arguments, and captured logs to prove neither master key is present.
- [ ] Run both storage contract suites, full server tests, backup/restore acceptance, check, build, and diff hygiene.
- [ ] Commit with `feat(server): add embedded standalone instance storage`.

### Task 4: Self-contained Instance bundles

**Depends on:** Tasks 2 and 3. GitHub Task #139 must depend on both #138 and embedded-storage Task #148, so its shared workflow edits cannot race either prerequisite.

**Files:**
- Create: `scripts/package-server.mjs`
- Create: `scripts/smoke-server-bundle.mjs`
- Modify: `.github/workflows/release-quality.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the embedded Instance-store and migration command from Task 3.
- Produces: platform archives that launch a persistent Instance with one command and no external runtime or database.

- [ ] Add a packaging test that rejects missing server output, web assets, license, or version metadata.
- [ ] Run the packaging test and confirm it fails before the packager exists.
- [ ] Implement deterministic archive staging with the server, web client, embedded engine, runtime, license, version metadata, and one launcher per platform.
- [ ] Make the launcher accept a data directory, default to loopback, generate local-only first-run configuration including a protected external master-key file reference, acquire the exclusive Instance lock, and keep all database, Attachment, backup, and configuration files beneath that directory without packaging or logging the key.
- [ ] Extend the reusable quality workflow with matrix jobs for Linux, macOS, and Windows that extract and smoke-check each archive; its successful reusable-workflow result remains the single `release-quality` dependency required by publishers.
- [ ] Extend tag-only preflight to reject every expected server-bundle asset-name collision before any publisher runs.
- [ ] Extend the central tag workflow with the GitHub Release/server-bundle publisher, make it directly `needs: release-quality`, reject existing releases/assets, upload without clobbering, and record verified archives, source metadata, and SHA-256 checksums.
- [ ] Smoke-test first start, web access, durable restart, second-process refusal, backup/restore, and both preserve-key and rotate-key migration to external PostgreSQL with Docker removed from `PATH` and no Docker socket, preinstalled database, Node, or pnpm available. Trace child processes and fail if the launcher invokes `docker` or any Docker API; also verify migrated encrypted state and secret-free artifacts/logs.
- [ ] Document the one-command start, data directory, backup, upgrade, and migration contract.
- [ ] Commit with `ci: package self-contained Stash instances`.

### Task 5: Mobile release builds

**Depends on:** Task 4. GitHub Task #140 must depend on #139 so their edits to the reusable gate and central release workflow are sequential.

**Files:**
- Create: `apps/mobile/eas.json`
- Modify: `apps/mobile/app.json`
- Modify: `.github/workflows/release-quality.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/mobile/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces: verified Expo identity/native generation plus Android and conditional iOS publishers in the central release workflow; iOS remains an optional release capability independent of Android.

- [ ] Initialize the existing `stash-capture` app under EAS owner `djerayane`; commit the real non-secret `extra.eas.projectId` UUID returned by `eas init`, retain iOS bundle identifier and Android package `app.stash.capture`, and add tests that reject missing, placeholder, or mismatched identity fields.
- [ ] Add Expo configuration validation and native-generation checks to the reusable workflow's unconditional common path so pull requests need no secret or tag context.
- [ ] Define EAS preview and production profiles with remote app-version sourcing and automatic native-build-number increments. Prerelease tags enable only the preview APK; stable tags enable the AAB and conditional IPA, map `MAJOR.MINOR.PATCH` exactly to Android `versionName` and iOS `CFBundleShortVersionString`, and never put prerelease identifiers into App Store version fields.
- [ ] Extend the `release: true` gate with non-interactive `EXPO_TOKEN`, Android-keystore, and iOS certificate/profile capability probes. Specify the exact missing-token and Android failure messages; specify missing iOS as an explicit skipped capability that does not suppress Android and never claims an IPA.
- [ ] Extend tag-only preflight to reject an existing EAS release association, read the remote Android `versionCode` and iOS `buildNumber`, require each candidate to be strictly greater than its platform's prior value, and expose stable/prerelease publisher conditions before any mobile job runs.
- [ ] Extend the central tag workflow with Android preview APK, stable-only AAB, and stable-only conditional iOS publishers. Make each publisher directly `needs: release-quality`, scope `EXPO_TOKEN` only to tag preflight and applicable jobs, and verify the completed EAS build reports the allocated native number before claiming its artifact.
- [ ] For prereleases, report `Android store prerelease skipped: Play Store version requires a stable semantic version` and exactly `iOS prerelease skipped: App Store version requires a stable semantic version`; do not run iOS signing probes or claim an AAB/IPA. For stable releases, preserve Android publication when iOS capability is absent.
- [ ] Document direct Instance pairing, supported artifacts, and signing prerequisites.
- [ ] Commit with `ci(mobile): build installable release artifacts`.

### Task 6: Installation and release contract validation

**Depends on:** Task 5. GitHub Task #141 must depend on #140 and validates the completed graph without modifying its ownership.

**Files:**
- Create: `docs/installation.md`
- Modify: `README.md`
- Modify: `docs/adr/0022-preserve-forward-upgrade-and-export-compatibility.md` only if release compatibility wording needs clarification.

**Interfaces:**
- Consumes: commands and artifact names produced by Tasks 1 through 5.
- Produces: executable contract validation and one operator guide comparing source Compose, prebuilt image, and standalone bundle installation.

- [ ] Add executable workflow-contract checks proving every container, GitHub Release/server-bundle, Android APK/AAB, and conditional iOS publisher directly `needs: release-quality`; the PR call is `release: false` and secret-free; tag preflight is `release: true`; prereleases skip AAB/IPA with the specified statuses; stable mobile versions map exactly and allocate monotonic native numbers; and `EXPO_TOKEN` is scoped only to tag preflight and mobile publishers.
- [ ] Write executable documentation checks for every shell command and artifact name that can be validated without release credentials.
- [ ] Document prerequisites, first startup, URL, exact `127.0.0.1:${STASH_PORT:-3000}:3000` binding, persistence, production hardening, upgrades, checksums, architectures, `ghcr.io/djerayane/stash`, standalone data-directory backup, and standalone-to-PostgreSQL preserve-key and rotate-key migration, including destination configuration, preflight, rollback, and secret-handling guarantees.
- [ ] Link the guide from the README before detailed configuration material.
- [ ] Run documentation checks, `pnpm run check`, `pnpm test`, and `git diff --check`.
- [ ] Commit with `docs: document supported Stash installation paths`.
