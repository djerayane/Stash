import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { DevelopmentArtifactKind } from "./github-artifacts.js";
import type { AutomationService, AutomationTrigger } from "./automations.js";

export interface GitHubSignal {
  id: string;
  deliveryId: string;
  repositoryId: string;
  installationId: number;
  kind: DevelopmentArtifactKind;
  providerId: string;
  url: string;
  label: string;
  occurredAt: string;
  trigger?: AutomationTrigger;
}

export interface SignalCandidate {
  id: string;
  signalId: string;
  taskId: string;
  projectId: string;
  organizationId: string;
  taskKey: string;
  taskTitle: string;
  matchedKey: string;
  status: "confirmed" | "pending_confirmation";
}

export interface GitHubSignalRepository {
  matchingTasks(installationId: number, repositoryId: string, keys: string[]): Promise<Array<{ taskId: string; projectId: string; organizationId: string; taskKey: string; title: string; matchedKey: string }>>;
  receive(signal: GitHubSignal, candidates: SignalCandidate[]): Promise<void>;
  list(memberId: string, projectId: string, taskKey: string): Promise<Array<{ signal: GitHubSignal; suggestions: SignalCandidate[] }> | undefined>;
  confirm(memberId: string, projectId: string, taskKey: string, suggestionId: string): Promise<"confirmed" | "forbidden" | "not_found">;
}

export class InvalidGitHubWebhook extends Error {}
export class InvalidGitHubSignalInput extends Error {}
export class GitHubSignalNotFound extends Error {}
export class GitHubSignalWriteForbidden extends Error {}

const taskKey = /\b[A-Z][A-Z0-9]{0,15}-[1-9][0-9]*\b/gi;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GitHubSignalService {
  constructor(private readonly repository: GitHubSignalRepository, private readonly webhookSecret: string, private readonly automations?: AutomationService) {
    if (!webhookSecret) throw new Error("GitHub webhook secret must not be empty");
  }

  verify(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature?.startsWith("sha256=")) return false;
    const actual = Buffer.from(signature.slice(7), "hex");
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async receive(event: string | undefined, deliveryId: string | undefined, rawBody: Buffer): Promise<void> {
    if (!deliveryId || deliveryId.length > 128) throw new InvalidGitHubWebhook();
    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw new InvalidGitHubSignalInput(); }
    const parsed = parseEvent(event, deliveryId, payload);
    const keys = [...new Set((parsed.evidence.match(taskKey) ?? []).map((value) => value.toUpperCase()))];
    const matches = keys.length ? await this.repository.matchingTasks(parsed.signal.installationId, parsed.signal.repositoryId, keys) : [];
    const counts = new Map(matches.map((match) => [`${match.organizationId}:${match.matchedKey}`,
      matches.filter((candidate) => candidate.organizationId === match.organizationId && candidate.matchedKey === match.matchedKey).length]));
    const candidates = matches.map((match) => {
      const matchedKey = match.matchedKey;
      return {
        id: randomUUID(), signalId: parsed.signal.id, taskId: match.taskId, projectId: match.projectId, organizationId: match.organizationId,
        taskKey: match.taskKey, taskTitle: match.title, matchedKey,
        status: (counts.get(`${match.organizationId}:${matchedKey}`) === 1 ? "confirmed" : "pending_confirmation") as SignalCandidate["status"],
      };
    });
    await this.repository.receive(parsed.signal, candidates);
    await this.automations?.applySignal(parsed.signal, candidates);
  }

  async list(memberId: string, projectId: string, key: string) {
    validatePath(projectId, key);
    const signals = await this.repository.list(memberId, projectId, key.toUpperCase());
    if (!signals) throw new GitHubSignalNotFound();
    return signals;
  }

  async confirm(memberId: string, projectId: string, key: string, suggestionId: string) {
    validatePath(projectId, key);
    if (!uuid.test(suggestionId)) throw new InvalidGitHubSignalInput();
    const result = await this.repository.confirm(memberId, projectId, key.toUpperCase(), suggestionId);
    if (result === "forbidden") throw new GitHubSignalWriteForbidden();
    if (result === "not_found") throw new GitHubSignalNotFound();
    const signals = await this.list(memberId, projectId, key);
    const suggestion = signals.flatMap(({ suggestions }) => suggestions).find(({ id }) => id === suggestionId);
    if (!suggestion) throw new GitHubSignalNotFound();
    return suggestion;
  }
}

function parseEvent(event: string | undefined, deliveryId: string, payload: unknown): { signal: GitHubSignal; evidence: string } {
  if (!record(payload) || !record(payload.repository) || !positiveId(payload.repository.id)
    || !record(payload.installation) || !positiveId(payload.installation.id)) throw new InvalidGitHubSignalInput();
  const repositoryId = String(payload.repository.id);
  const installationId = Number(payload.installation.id);
  if (event === "push" && typeof payload.ref === "string" && /^[0-9a-f]{40}$/i.test(String(payload.after))) {
    const branch = payload.ref.replace(/^refs\/heads\//, "");
    const message = record(payload.head_commit) && typeof payload.head_commit.message === "string" ? payload.head_commit.message : "";
    return { signal: signal(deliveryId, installationId, repositoryId, "commit", String(payload.after), githubUrl(payload.repository, `/commit/${payload.after}`), branch), evidence: `${branch} ${message}` };
  }
  if (event === "create" && payload.ref_type === "branch" && typeof payload.ref === "string" && payload.ref.length > 0 && payload.ref.length <= 240) {
    return { signal: { ...signal(deliveryId, installationId, repositoryId, "branch", payload.ref, githubUrl(payload.repository, `/tree/${encodeURIComponent(payload.ref)}`), payload.ref), trigger: "branch_created" }, evidence: payload.ref };
  }
  if (event === "pull_request" && record(payload.pull_request) && positiveId(payload.pull_request.number)
    && typeof payload.pull_request.title === "string" && typeof payload.pull_request.html_url === "string") {
    const pull = payload.pull_request; const title = String(pull.title); const url = String(pull.html_url);
    const completed = payload.action === "closed" && pull.merged === true;
    return { signal: { ...signal(deliveryId, installationId, repositoryId, "pull_request", String(pull.number), safeGitHubUrl(url), `#${pull.number} ${title}`), ...(completed ? { trigger: "pull_request_completed" as const } : {}) }, evidence: `${title} ${typeof pull.body === "string" ? pull.body : ""}` };
  }
  throw new InvalidGitHubSignalInput();
}

function signal(deliveryId: string, installationId: number, repositoryId: string, kind: DevelopmentArtifactKind, providerId: string, url: string, label: string): GitHubSignal {
  return { id: createHash("sha256").update(`github:${deliveryId}`).digest("hex").slice(0, 8) + "-0000-4000-8000-" + createHash("sha256").update(deliveryId).digest("hex").slice(8, 20), deliveryId, installationId, repositoryId, kind, providerId, url, label, occurredAt: new Date().toISOString() };
}

function githubUrl(repository: Record<string, unknown>, suffix: string) {
  if (typeof repository.html_url === "string") return safeGitHubUrl(`${repository.html_url}${suffix}`);
  return `https://github.com/repositories/${repository.id}${suffix}`;
}
function safeGitHubUrl(value: string) { let url: URL; try { url = new URL(value); } catch { throw new InvalidGitHubSignalInput(); } if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) throw new InvalidGitHubSignalInput(); return url.toString(); }
function positiveId(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validatePath(projectId: string, key: string) { if (!uuid.test(projectId) || !/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]*$/i.test(key)) throw new InvalidGitHubSignalInput(); }
