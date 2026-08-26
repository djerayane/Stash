# Stable release verification

Stash treats the running Instance as its release boundary. Before a stable release, run the complete repository gates and the focused first-release journey:

```sh
pnpm run check
pnpm test
pnpm run build
pnpm run test:stable-release
```

`test:stable-release` starts a disposable, embedded Instance and exercises the primary release story through HTTP: an Owner creates a Workspace and Project, a mobile capture becomes a Note, a stable Block becomes a Task, the Task moves on a board, a signed GitHub event becomes a Signal and applies an Automation, and the Portable Workspace Export imports into a clean Instance. It also verifies unauthenticated, invalid-input, and forged-provider failures remain visible. The test uses a protocol-compatible GitHub fake and makes no network request.

## Representative benchmark

Start the exact build and storage profile being evaluated, seed it with the intended fixture, then run:

```sh
STASH_BENCHMARK_URL=https://stash.example.com \
STASH_BENCHMARK_TOKEN=<member-session> \
STASH_BENCHMARK_REQUESTS=500 \
STASH_BENCHMARK_CONCURRENCY=25 \
pnpm run benchmark:stable-release
```

The harness measures end-to-end HTTP throughput and p50, p95, and p99 latency. By default it alternates readiness with the authenticated client-session boundary. `STASH_BENCHMARK_PATHS` accepts a comma-separated list of safe GET paths for a prepared fixture. Record the Stash commit and version, distribution path, CPU, memory, operating system, storage adapter and medium, database version, Redis state, fixture cardinalities, concurrency, duration, and the JSON output with every published result.

ADR-0038 defines the supported single-Instance design envelope: 1,000 active Members, 100 Organizations, 10,000 Projects, one million Notes and Tasks, 100 concurrent editing sessions, ten million searchable Blocks, and one terabyte of Attachments with external object storage. A representative release run should populate each cardinality relevant to the operation under test and exercise application HTTP boundaries against PostgreSQL and the selected Attachment adapter. The lightweight default run is a reproducibility check; it does not certify that full envelope. A benchmark also does not certify correctness, accessibility, backup restoration, mobile conflicts, or Portable Workspace Export compatibility; the acceptance and repository gates remain mandatory.

Publish conditions and results rather than a context-free performance promise. Instances larger than the ADR-0038 envelope remain unverified.
