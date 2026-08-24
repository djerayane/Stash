# Instance Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a zero-input local Compose experience and publish verified Docker, standalone server, and mobile release artifacts.

**Architecture:** Every distribution path packages the same compiled server and React client. Compose and OCI use external PostgreSQL; standalone uses a filesystem-persistent embedded PostgreSQL-compatible adapter behind the same behavioral contracts and supplies a lossless migration path to external PostgreSQL. Tasks 2 through 5 add artifact checks to one reusable release-quality workflow; Task 6 invokes the completed workflow as `release-quality` and wires every publisher to that job. Pull requests run common checks without tag assumptions, while tag releases add conditional preflight.

**Tech Stack:** Docker Compose, Docker Buildx, GitHub Actions, Node.js 22, pnpm, Expo/EAS, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-24-instance-distribution-design.md`

## Global Constraints

- `docker compose up -d` must work from a clean checkout with no environment variables.
- Development defaults must be bound to and documented for localhost evaluation only.
- Production deployments must retain explicit strong secrets and an HTTPS public origin.
- Standalone startup must require no Docker, Node, pnpm, or separately installed database.
- Standalone durable state must live beneath one explicit data directory and migrate losslessly to the standard external-PostgreSQL deployment.
- Pull requests must never publish release artifacts.
- Only canonical SemVer 2.0.0 tags prefixed with `v` may publish artifacts from the tested revision; prereleases are allowed and build metadata is rejected so the version maps losslessly to an OCI tag.
- Every publish job must directly `needs: release-quality`; common quality and artifact-smoke checks run for pull requests, while ref, collision, credential, and signing preflight runs only when the workflow's explicit `release` input is `true`.
- Release preflight must reject a tag/ref mismatch or any existing GitHub Release, asset, GHCR version tag, or EAS version association; publishers never overwrite an existing artifact.
- OCI manifest and SHA-256 digests are immutable artifact identities. A moved or recreated Git tag fails collision/ref checks and cannot replace a prior release.

---

### Task 1: Zero-input Compose quick start

**Depends on:** none.

**Files:**
- Modify: `compose.yaml`
- Modify: `README.md`
- Create: `scripts/verify-compose.ts`
- Test: `tests/compose.test.ts`

**Interfaces:**
- Produces: a default Compose configuration whose `stash` service reaches `/health/ready` and serves `/` on `${STASH_PORT:-3000}`.

- [ ] Write an acceptance test that runs `docker compose config` with an empty environment and asserts localhost-only defaults and persistent volumes.
- [ ] Run `pnpm run test:server -- tests/compose.test.ts` and confirm it fails because required interpolation variables are absent.
- [ ] Add explicit development defaults in `compose.yaml` while preserving environment overrides and production validation in the application.
- [ ] Add a verifier that waits for readiness and confirms the React entry document is served.
- [ ] Run `docker compose up -d --build`, the verifier, and `docker compose down`; confirm data volumes are retained.
- [ ] Update the README quick start and production-hardening warning.
- [ ] Commit with `fix(compose): make local instance startup zero-config`.

### Task 2: Multi-architecture container publication

**Depends on:** Task 1.

**Files:**
- Create: `.github/workflows/release-quality.yml`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the Dockerfile and Compose service contract verified by Task 1.
- Produces: reusable common repository/Compose/OCI quality checks and a verified `linux/amd64`/`linux/arm64` container build contract for later publication by Task 6.

- [ ] Add a pull-request job that builds the image and runs its health smoke check without pushing.
- [ ] Create one reusable `workflow_call` quality workflow with a boolean `release` input defaulting to `false`; add repository checks/tests, Compose startup and web response, and OCI health smoke testing to its unconditional common path.
- [ ] Call the reusable workflow from pull-request verification with `release: false`; prove this path neither inspects a tag nor receives release credentials.
- [ ] Define the multi-architecture image, provenance, manifest-digest, and source-commit outputs that Task 6 will publish; do not add a publish job in this task.
- [ ] Add an `STASH_IMAGE` Compose override while retaining `build: .` for fresh-checkout use.
- [ ] Validate the workflow syntax and build the local target.
- [ ] Document prebuilt-image startup and digest pinning.
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
- Produces: one Instance-store contract implemented by external PostgreSQL and a filesystem-persistent embedded PostgreSQL-compatible engine; `migrateStandaloneInstance(sourceDataDir, destinationDatabaseUrl)` transfers one quiesced Instance without semantic loss.

- [ ] Inventory every SQL feature, extension, transaction boundary, search query, migration, and durable-job behavior used by the running Instance; encode unsupported embedded capabilities as failing contract tests before selecting or integrating the engine.
- [ ] Write shared red tests that run the same repository, authorization, synchronization, search, backup/restore, and upgrade behavior against external PostgreSQL and a temporary embedded data directory.
- [ ] Introduce the narrow Instance-store composition boundary without duplicating domain rules or weakening PostgreSQL behavior.
- [ ] Implement the embedded adapter with filesystem persistence, transactions, migrations, exclusive-process locking, clean shutdown, and crash-safe restart.
- [ ] Implement and test a quiesced migration into an empty external-PostgreSQL Instance, comparing identities, configuration, audit history, Workspaces, Attachments, and checksums independent of storage identifiers.
- [ ] Run both storage contract suites, full server tests, backup/restore acceptance, check, build, and diff hygiene.
- [ ] Commit with `feat(server): add embedded standalone instance storage`.

### Task 4: Self-contained Instance bundles

**Depends on:** Tasks 2 and 3.

**Files:**
- Create: `scripts/package-server.mjs`
- Create: `scripts/smoke-server-bundle.mjs`
- Modify: `.github/workflows/release-quality.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the embedded Instance-store and migration command from Task 3.
- Produces: platform archives that launch a persistent Instance with one command and no external runtime or database.

- [ ] Add a packaging test that rejects missing server output, web assets, license, or version metadata.
- [ ] Run the packaging test and confirm it fails before the packager exists.
- [ ] Implement deterministic archive staging with the server, web client, embedded engine, runtime, license, version metadata, and one launcher per platform.
- [ ] Make the launcher accept a data directory, default to loopback, generate local-only first-run configuration, acquire the exclusive Instance lock, and keep all database, Attachment, backup, and configuration files beneath that directory.
- [ ] Extend the reusable quality workflow with matrix jobs for Linux, macOS, and Windows that extract and smoke-check each archive; its successful reusable-workflow result remains the single `release-quality` dependency required by publishers.
- [ ] Expose verified archives, source metadata, and SHA-256 checksums for Task 6; do not publish a GitHub Release or release asset in this task.
- [ ] Smoke-test first start, web access, durable restart, second-process refusal, backup/restore, and migration to external PostgreSQL without any preinstalled database or Node runtime.
- [ ] Document the one-command start, data directory, backup, upgrade, and migration contract.
- [ ] Commit with `ci: package self-contained Stash instances`.

### Task 5: Mobile release builds

**Depends on:** Task 2.

**Files:**
- Create: `apps/mobile/eas.json`
- Modify: `apps/mobile/app.json`
- Modify: `.github/workflows/release-quality.yml`
- Modify: `apps/mobile/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces: verified Expo identity/native generation and Android/iOS build contracts for Task 6; iOS remains an optional release capability independent of Android.

- [ ] Initialize the existing `stash-capture` app under EAS owner `djerayane`; commit the real non-secret `extra.eas.projectId` UUID returned by `eas init`, retain iOS bundle identifier and Android package `app.stash.capture`, and add tests that reject missing, placeholder, or mismatched identity fields.
- [ ] Add Expo configuration validation and native-generation checks to the reusable workflow's unconditional common path so pull requests need no secret or tag context.
- [ ] Define preview and production EAS profiles with non-interactive version sourcing and the APK, AAB, and IPA artifact contracts.
- [ ] Define non-interactive `EXPO_TOKEN`, Android-keystore, and iOS certificate/profile capability probes for Task 6. Specify the exact missing-token and Android failure messages; specify missing iOS as an explicit skipped capability that does not suppress Android and never claims an IPA.
- [ ] Document direct Instance pairing, supported artifacts, and signing prerequisites.
- [ ] Commit with `ci(mobile): build installable release artifacts`.

### Task 6: Complete release wiring and installation contract

**Depends on:** Tasks 2, 4, and 5.

**Files:**
- Create: `docs/installation.md`
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/release-quality.yml`
- Modify: `README.md`
- Modify: `docs/adr/0022-preserve-forward-upgrade-and-export-compatibility.md` only if release compatibility wording needs clarification.

**Interfaces:**
- Consumes: commands and artifact names produced by Tasks 1 through 5.
- Produces: the complete gated release graph and one operator guide comparing source Compose, prebuilt image, and standalone bundle installation.

- [ ] Complete the reusable workflow's `release: true` conditional preflight: validate canonical SemVer with a SemVer parser, reject build metadata, verify the tag resolves to `GITHUB_SHA`, check GitHub Release/assets, GHCR, and EAS version collisions, and probe mobile capabilities without running these checks for pull requests.
- [ ] In the central tag workflow, invoke the completed reusable workflow as `release-quality` with `release: true`. Make the container, GitHub Release/server-bundle, Android, and conditional iOS publish jobs each declare `needs: release-quality`; publish without overwrite and record the source commit plus OCI/SHA-256 identities.
- [ ] Scope `EXPO_TOKEN` only to Android and iOS publish jobs. Fail a missing token with `Mobile release unavailable: configure the EXPO_TOKEN GitHub Actions secret`; fail missing Android signing with `Android release unavailable: configure the EAS Android keystore for app.stash.capture`; when iOS signing is missing, report `iOS release unavailable: configure the Apple distribution certificate and provisioning profile for app.stash.capture`, skip only iOS publication, allow valid Android artifacts, and never claim an IPA.
- [ ] Write executable documentation checks for every shell command and artifact name that can be validated without release credentials.
- [ ] Document prerequisites, first startup, URL, persistence, production hardening, upgrades, checksums, architectures, standalone data-directory backup, and standalone-to-PostgreSQL migration.
- [ ] Link the guide from the README before detailed configuration material.
- [ ] Run documentation checks, `pnpm run check`, `pnpm test`, and `git diff --check`.
- [ ] Commit with `docs: document supported Stash installation paths`.
