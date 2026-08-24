# Instance Distribution Design

## Goal

Make a fresh Stash checkout immediately runnable with `docker compose up`, while publishing versioned Docker, standalone server, and mobile artifacts for operators and Members who do not want to build from source.

## Supported paths

### Local evaluation

From a fresh checkout, `docker compose up` builds and starts PostgreSQL and one Stash application container without requiring an `.env` file or exported variables. The Instance becomes healthy and serves the web application at `http://localhost:3000`.

The defaults are explicitly development-only. They use a deterministic administrator token and master key, a localhost public origin, persistent named volumes, and no optional external services. Startup output and documentation tell operators to replace these values before exposing the Instance beyond localhost.

### Production container deployment

Version tags publish multi-architecture OCI images to GitHub Container Registry for `linux/amd64` and `linux/arm64`. Images are addressed by immutable semantic-version and commit-digest references; moving major/minor aliases may be added only after a stable-release policy exists. The repository Compose file remains buildable from source and can also accept an image override without changing its service contract.

Production deployments must supply unique administrator and master-key secrets, an HTTPS `PUBLIC_ORIGIN`, and a strong PostgreSQL password. Release images must not embed secrets or silently substitute development defaults inside the application.

### Standalone server bundles

Version tags publish server bundles for Linux, macOS, and Windows on x64, plus arm64 where the packaging toolchain supports it. A bundle includes the compiled server, built web client, production JavaScript dependencies, license, and launch scripts so the operator does not install Node or pnpm. It does not embed PostgreSQL or create a separate storage model; `DATABASE_URL` and the same production configuration remain required.

Each archive has a SHA-256 checksum. CI extracts every bundle and runs a startup/configuration smoke check on its target runner before publishing it.

### Mobile builds

Pull requests verify that Expo configuration and native projects can be generated without publishing. Version tags submit Android and iOS production builds through EAS. Android produces an installable APK for direct testing and an AAB for store distribution. iOS produces an IPA only when repository/EAS signing credentials are configured; otherwise the workflow reports the missing release capability clearly rather than publishing an unsigned or unusable artifact.

Mobile artifacts connect directly to a Member-supplied HTTPS Instance and do not introduce a hosted Stash relay.

## Workflow boundaries

- Pull requests build, test, and smoke-check distributable artifacts but never publish them.
- Version tags matching `v*` publish immutable artifacts after the normal quality gates pass.
- Manual workflow dispatch may build diagnostics artifacts but may not overwrite a tagged release.
- GitHub Actions use least-privilege permissions. Package publication receives `packages: write`; release publication receives `contents: write`; mobile credentials remain encrypted secrets managed outside the repository.
- Artifact metadata records the source commit and version. Published checksums allow operators to verify downloaded server bundles.

## Documentation

The README leads with the exact zero-input local command and URL. A separate installation guide compares source Compose, prebuilt-container, and standalone-server paths, then documents production secrets, upgrades, persistence, architecture support, checksums, and mobile installation. No documentation calls a development default safe for Internet exposure.

## Acceptance

1. On a clean checkout with Docker available, `docker compose up -d` reaches a healthy Stash service and `http://localhost:3000` returns the built React application.
2. `docker compose config` succeeds without environment variables; a production validation path rejects missing or development-only secrets.
3. Pull-request workflows build and smoke-test the Docker image and standalone bundle without publishing.
4. A version tag publishes multi-architecture GHCR images, checksummed standalone bundles, and the configured mobile artifacts.
5. Release documentation lets an operator select a path and reach the web interface without inspecting source code.

