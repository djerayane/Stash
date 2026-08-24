# Instance Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a zero-input local Compose experience and publish verified Docker, standalone server, and mobile release artifacts.

**Architecture:** Every distribution path packages the same compiled server and React client and preserves PostgreSQL as the durable store. One reusable release-quality workflow verifies the complete artifact set; the central release workflow invokes it as `release-quality`, and every publisher depends directly on that job. Canonical semantic-version tags select releases, while collision checks and recorded content digests—not tag mutability—provide immutable artifact identity.

**Tech Stack:** Docker Compose, Docker Buildx, GitHub Actions, Node.js 22, pnpm, Expo/EAS, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-24-instance-distribution-design.md`

## Global Constraints

- `docker compose up -d` must work from a clean checkout with no environment variables.
- Development defaults must be bound to and documented for localhost evaluation only.
- Production deployments must retain explicit strong secrets and an HTTPS public origin.
- Standalone bundles require PostgreSQL and must not introduce an embedded database.
- Pull requests must never publish release artifacts.
- Only canonical SemVer 2.0.0 tags prefixed with `v` may publish artifacts from the tested revision; prereleases are allowed and build metadata is rejected so the version maps losslessly to an OCI tag.
- Every publish job must directly `needs: release-quality`; that job calls the reusable full gate covering repository checks/tests, Compose and OCI smoke checks, every standalone target, Expo validation, release invariants, and artifact metadata.
- Release preflight must reject a tag/ref mismatch or any existing GitHub Release, asset, GHCR version tag, or EAS version association; publishers never overwrite an existing artifact.
- OCI manifest and SHA-256 digests are immutable artifact identities. A moved or recreated Git tag fails collision/ref checks and cannot replace a prior release.

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
- Create: `.github/workflows/release-quality.yml`
- Create: `.github/workflows/release.yml`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the Dockerfile and Compose service contract verified by Task 1.
- Produces: `ghcr.io/djerayane/stash:<version>` for `linux/amd64` and `linux/arm64` on canonical SemVer tags after `release-quality`, plus its immutable manifest digest.

- [ ] Add a pull-request job that builds the image and runs its health smoke check without pushing.
- [ ] Create one reusable `workflow_call` quality workflow containing repository checks/tests, Compose startup and web response, OCI health smoke testing, the standalone target matrix, Expo identity/native generation, canonical SemVer/ref validation, publication-collision checks, and artifact metadata validation. Call it from pull-request verification without publication and from the central release workflow as the `release-quality` job.
- [ ] In that gate, validate canonical SemVer with a SemVer parser, allow prerelease identifiers but reject build metadata, verify `refs/tags/<version>` resolves to `GITHUB_SHA`, and fail if the GitHub Release, any expected release asset, or the GHCR version tag already exists.
- [ ] Make the container publish job declare `needs: release-quality`, use `contents: read` and `packages: write`, publish without overwrite, emit Buildx provenance, and record the OCI manifest digest and source commit.
- [ ] Add an `STASH_IMAGE` Compose override while retaining `build: .` for fresh-checkout use.
- [ ] Validate the workflow syntax and build the local target.
- [ ] Document prebuilt-image startup and digest pinning.
- [ ] Commit with `ci: publish verified Stash container images`.

### Task 3: Standalone server bundles

**Files:**
- Create: `scripts/package-server.mjs`
- Create: `scripts/smoke-server-bundle.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: platform archives containing `dist/`, `apps/web/dist/`, production dependencies, launch scripts, license, version metadata, and SHA-256 checksums.

- [ ] Add a packaging test that rejects missing server output, web assets, license, or version metadata.
- [ ] Run the packaging test and confirm it fails before the packager exists.
- [ ] Implement deterministic archive staging and platform launch scripts without embedding PostgreSQL.
- [ ] Extend the reusable quality workflow with matrix jobs for Linux, macOS, and Windows that extract and smoke-check each archive; its successful reusable-workflow result remains the single `release-quality` dependency required by publishers.
- [ ] Make the GitHub Release/server publish job declare `needs: release-quality`, reject an existing asset name, upload without clobbering, and record the source commit plus every archive's SHA-256 checksum.
- [ ] Document required PostgreSQL and runtime configuration.
- [ ] Commit with `ci: package standalone Stash server bundles`.

### Task 4: Mobile release builds

**Files:**
- Create: `apps/mobile/eas.json`
- Modify: `apps/mobile/app.json`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/mobile/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces: verified Expo native generation on pull requests and signed Android APK/AAB plus iOS IPA builds on canonical SemVer tags after `release-quality`.

- [ ] Initialize the existing `stash-capture` app under EAS owner `djerayane`; commit the real non-secret `extra.eas.projectId` UUID returned by `eas init`, retain iOS bundle identifier and Android package `app.stash.capture`, and add tests that reject missing, placeholder, or mismatched identity fields.
- [ ] Add Expo configuration validation and native-generation checks for pull requests without secrets; extend `release-quality` to run those checks and verify that the semantic version has no existing EAS release association.
- [ ] Define preview and production EAS profiles with non-interactive version sourcing and the APK, AAB, and IPA artifact contracts.
- [ ] Authenticate release submissions only with the `EXPO_TOKEN` GitHub Actions secret. Before submission, fail a missing token with `Mobile release unavailable: configure the EXPO_TOKEN GitHub Actions secret`.
- [ ] Make both Android and iOS publish jobs declare `needs: release-quality` and scope `EXPO_TOKEN` only to those jobs. Fail absent Android signing with `Android release unavailable: configure the EAS Android keystore for app.stash.capture`; fail absent iOS signing with `iOS release unavailable: configure the Apple distribution certificate and provisioning profile for app.stash.capture`; publish neither an unsigned nor partial mobile release.
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
