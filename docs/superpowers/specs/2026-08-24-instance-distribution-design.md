# Instance Distribution Design

## Goal

Make a fresh Stash checkout immediately runnable with `docker compose up`, while publishing versioned Docker, standalone server, and mobile artifacts for operators and Members who do not want to build from source.

## Supported paths

### Local evaluation

From a fresh checkout, `docker compose up` builds and starts PostgreSQL and one Stash application container without requiring an `.env` file or exported variables. The Instance becomes healthy and serves the web application at `http://localhost:3000`.

The defaults are explicitly development-only. They use a deterministic administrator token and master key, a localhost public origin, persistent named volumes, and no optional external services. Startup output and documentation tell operators to replace these values before exposing the Instance beyond localhost.

### Production container deployment

Strict semantic-version tags publish multi-architecture OCI images to GitHub Container Registry for `linux/amd64` and `linux/arm64`. Images are addressed by the exact semantic version and, as the permanent identity, the OCI manifest digest; moving major/minor aliases may be added only after a stable-release policy exists. The repository Compose file remains buildable from source and can also accept an image override without changing its service contract.

Production deployments must supply unique administrator and master-key secrets, an HTTPS `PUBLIC_ORIGIN`, and a strong PostgreSQL password. Release images must not embed secrets or silently substitute development defaults inside the application.

### Standalone server bundles

Version tags publish server bundles for Linux, macOS, and Windows on x64, plus arm64 where the packaging toolchain supports it. A bundle includes the compiled server, built web client, production JavaScript dependencies, license, and launch scripts so the operator does not install Node or pnpm. It does not embed PostgreSQL or create a separate storage model; `DATABASE_URL` and the same production configuration remain required.

Each archive has a SHA-256 checksum. CI extracts every bundle and runs a startup/configuration smoke check on its target runner before publishing it.

### Mobile builds

Pull requests verify that Expo configuration and native projects can be generated without publishing. Release configuration commits the EAS owner `djerayane` and the real, non-secret EAS project UUID returned by `eas init` alongside the existing `stash-capture`, `app.stash.capture`, and `app.stash.capture` application identities. CI authenticates non-interactively only through the `EXPO_TOKEN` GitHub Actions secret, while pull requests validate all non-secret identity fields without receiving that secret.

Strict semantic-version tags submit Android and iOS production builds through EAS. Android produces an installable APK for direct testing and an AAB for store distribution; its preflight fails with `Android release unavailable: configure the EAS Android keystore for app.stash.capture` when that signing capability is absent. iOS produces an IPA; its preflight fails with `iOS release unavailable: configure the Apple distribution certificate and provisioning profile for app.stash.capture` when that signing capability is absent. A missing `EXPO_TOKEN` fails before either platform is submitted with `Mobile release unavailable: configure the EXPO_TOKEN GitHub Actions secret`. The release does not publish an unsigned, partial, or misleading mobile artifact.

Mobile artifacts connect directly to a Member-supplied HTTPS Instance and do not introduce a hosted Stash relay.

## Workflow boundaries

- Pull requests build, test, and smoke-check distributable artifacts but never publish them.
- One reusable release-quality workflow verifies the repository checks and tests, Compose startup and web response, OCI image health, extracted standalone bundles on every target runner, Expo identity/native generation, strict semantic-version/ref invariants, and artifact metadata. The central release workflow invokes it as the `release-quality` job, and every container, GitHub Release/server-bundle, Android, and iOS publish job directly declares `needs: release-quality`; no publisher can run from a merely successful build job.
- A tag event is only a candidate release. The release-quality job parses the ref as canonical SemVer 2.0.0 and accepts `v<major>.<minor>.<patch>` with an optional prerelease field; build metadata is rejected so the version maps losslessly to an OCI tag. It rejects a tag whose resolved commit differs from `GITHUB_SHA` and rejects any existing GitHub Release, release asset name, GHCR semantic-version tag, or EAS release association for that version.
- Published GitHub Release assets are created without overwrite, and the workflow records the source commit, OCI manifest digest, and SHA-256 digest of every downloadable artifact. Those digests are the immutable identities. Because Git tags can be force-moved, moving or recreating a tag never authorizes replacement: protected-tag rules are the first guard, collision/ref checks make the rerun fail closed, and already-published artifacts remain identified by their original digests.
- Manual workflow dispatch may build diagnostics artifacts but may not overwrite a tagged release.
- GitHub Actions use least-privilege permissions. Package publication receives `packages: write`; release publication receives `contents: write`; mobile credentials remain encrypted secrets managed outside the repository.
- Artifact metadata records the source commit and version. Published checksums allow operators to verify downloaded server bundles.

## Documentation

The README leads with the exact zero-input local command and URL. A separate installation guide compares source Compose, prebuilt-container, and standalone-server paths, then documents production secrets, upgrades, persistence, architecture support, checksums, and mobile installation. No documentation calls a development default safe for Internet exposure.

## Acceptance

1. On a clean checkout with Docker available, `docker compose up -d` reaches a healthy Stash service and `http://localhost:3000` returns the built React application.
2. `docker compose config` succeeds without environment variables; a production validation path rejects missing or development-only secrets.
3. Pull-request workflows build and smoke-test the Docker image and standalone bundle without publishing.
4. A canonical semantic-version tag whose ref and version have no publication collision passes the complete release-quality job before publishing multi-architecture GHCR images, checksummed standalone bundles, and both signed mobile artifacts; every publish job directly depends on that gate.
5. Release documentation lets an operator select a path and reach the web interface without inspecting source code.
