# Instance Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a zero-input local Compose experience and publish verified Docker, standalone server, and mobile release artifacts.

**Architecture:** Every distribution path packages the same compiled server and React client and preserves PostgreSQL as the durable store. Pull requests verify artifacts; immutable version tags publish them with checksums and explicit credential boundaries.

**Tech Stack:** Docker Compose, Docker Buildx, GitHub Actions, Node.js 22, pnpm, Expo/EAS, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-24-instance-distribution-design.md`

## Global Constraints

- `docker compose up -d` must work from a clean checkout with no environment variables.
- Development defaults must be bound to and documented for localhost evaluation only.
- Production deployments must retain explicit strong secrets and an HTTPS public origin.
- Standalone bundles require PostgreSQL and must not introduce an embedded database.
- Pull requests must never publish release artifacts.
- Version tags matching `v*` publish immutable artifacts from the tested revision.

---

### Task 1: Zero-input Compose quick start

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

**Files:**
- Create: `.github/workflows/container-release.yml`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the Dockerfile and Compose service contract verified by Task 1.
- Produces: `ghcr.io/djerayane/stash:<version>` for `linux/amd64` and `linux/arm64` on `v*` tags.

- [ ] Add a pull-request job that builds the image and runs its health smoke check without pushing.
- [ ] Add a tag job with `contents: read` and `packages: write`, Buildx provenance, immutable version tags, and digest output.
- [ ] Add an `STASH_IMAGE` Compose override while retaining `build: .` for fresh-checkout use.
- [ ] Validate the workflow syntax and build the local target.
- [ ] Document prebuilt-image startup and digest pinning.
- [ ] Commit with `ci: publish verified Stash container images`.

### Task 3: Standalone server bundles

**Files:**
- Create: `scripts/package-server.mjs`
- Create: `scripts/smoke-server-bundle.mjs`
- Create: `.github/workflows/server-release.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: platform archives containing `dist/`, `apps/web/dist/`, production dependencies, launch scripts, license, version metadata, and SHA-256 checksums.

- [ ] Add a packaging test that rejects missing server output, web assets, license, or version metadata.
- [ ] Run the packaging test and confirm it fails before the packager exists.
- [ ] Implement deterministic archive staging and platform launch scripts without embedding PostgreSQL.
- [ ] Add matrix jobs for Linux, macOS, and Windows that extract and smoke-check each archive.
- [ ] Publish archives and checksums only for `v*` tags.
- [ ] Document required PostgreSQL and runtime configuration.
- [ ] Commit with `ci: package standalone Stash server bundles`.

### Task 4: Mobile release builds

**Files:**
- Create: `apps/mobile/eas.json`
- Create: `.github/workflows/mobile-release.yml`
- Modify: `apps/mobile/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces: verified Expo native generation on pull requests, Android APK/AAB release builds, and credential-gated iOS IPA builds on `v*` tags.

- [ ] Add Expo configuration validation and native-generation checks for pull requests.
- [ ] Define preview and production EAS profiles with non-interactive version sourcing.
- [ ] Add tag-triggered EAS build jobs whose secrets are scoped only to release jobs.
- [ ] Make absent iOS credentials fail with a precise setup message and no misleading artifact.
- [ ] Document direct Instance pairing, supported artifacts, and signing prerequisites.
- [ ] Commit with `ci(mobile): build installable release artifacts`.

### Task 5: Installation and release contract

**Files:**
- Create: `docs/installation.md`
- Modify: `README.md`
- Modify: `docs/adr/0022-preserve-forward-upgrade-and-export-compatibility.md` only if release compatibility wording needs clarification.

**Interfaces:**
- Consumes: commands and artifact names produced by Tasks 1 through 4.
- Produces: one operator guide comparing source Compose, prebuilt image, and standalone bundle installation.

- [ ] Write executable documentation checks for every shell command and artifact name that can be validated without release credentials.
- [ ] Document prerequisites, first startup, URL, persistence, production hardening, upgrades, checksums, and architecture support for each path.
- [ ] Link the guide from the README before detailed configuration material.
- [ ] Run documentation checks, `pnpm run check`, `pnpm test`, and `git diff --check`.
- [ ] Commit with `docs: document supported Stash installation paths`.

