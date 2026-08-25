import { performance } from "node:perf_hooks";

type Sample = { status: number; milliseconds: number };

function positiveInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function main() {
  const origin = new URL(process.env.STASH_BENCHMARK_URL ?? "http://localhost:3000").origin;
  const requests = positiveInteger("STASH_BENCHMARK_REQUESTS", 500);
  const concurrency = positiveInteger("STASH_BENCHMARK_CONCURRENCY", 25);
  const paths = (process.env.STASH_BENCHMARK_PATHS ?? "/health/ready,/api/client-session").split(",").map((path) => path.trim()).filter(Boolean);
  if (!paths.length || paths.some((path) => !path.startsWith("/") || path.startsWith("//") || path.includes("\\")
    || new URL(path, origin).origin !== origin || new URL(path, origin).hash)) {
    throw new Error("STASH_BENCHMARK_PATHS must contain only absolute paths on the configured Instance origin");
  }
  const token = process.env.STASH_BENCHMARK_TOKEN?.trim();
  const samples: Sample[] = [];
  let cursor = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (cursor < requests) {
      const index = cursor++;
      const before = performance.now();
      const response = await fetch(new URL(paths[index % paths.length]!, origin), token
        ? { headers: { authorization: `Bearer ${token}` } }
        : {});
      await response.arrayBuffer();
      samples.push({ status: response.status, milliseconds: performance.now() - before });
    }
  }));
  const elapsed = performance.now() - started;
  const latencies = samples.map(({ milliseconds }) => milliseconds);
  const unexpected = samples.filter(({ status }) => status < 200 || status >= 400).length;
  const report = {
    schema: "stash.stable-release-benchmark.v1", origin, conditions: { requests, concurrency, paths },
    results: { requestsPerSecond: Number((samples.length / (elapsed / 1_000)).toFixed(2)),
      latencyMilliseconds: { p50: Number(percentile(latencies, 0.5).toFixed(2)), p95: Number(percentile(latencies, 0.95).toFixed(2)), p99: Number(percentile(latencies, 0.99).toFixed(2)) },
      unexpectedResponses: unexpected },
  };
  console.log(JSON.stringify(report, null, 2));
  if (unexpected) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "benchmark failed"); process.exitCode = 1; });
