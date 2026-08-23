export interface StashApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly memberToken?: string;
}

import type { AgentGrant, AgentGrantOption, AgentProposal, CreateAgentGrantRequest, CreateAgentGrantResponse, ReviewAgentProposalRequest, ReviewAgentProposalResponse } from "@stash/domain-types";
import { agentGrantListResponse, agentGrantOptionsResponse, agentProposalListResponse, agentProposalResponse, createAgentGrantResponse, reviewAgentProposalResponse, revokeAgentGrantResponse } from "@stash/validation";

export interface AgentGrantsApi {
  options(): Promise<{ organizations: AgentGrantOption[] }>;
  list(organizationId: string): Promise<{ grants: AgentGrant[] }>;
  create(input: CreateAgentGrantRequest): Promise<CreateAgentGrantResponse>;
  revoke(organizationId: string, grantId: string): Promise<{ grantId: string; revoked: true }>;
  proposals(organizationId: string): Promise<{ proposals: AgentProposal[] }>;
  proposal(organizationId: string, proposalId: string): Promise<{ proposal: AgentProposal }>;
  reviewProposal(organizationId: string, proposalId: string, input: ReviewAgentProposalRequest): Promise<ReviewAgentProposalResponse>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MobileProtocolClientOptions {
  readonly instanceUrl: string;
  readonly memberToken: string;
  readonly fetch?: Fetch;
}

export interface MobileProtocolClient {
  captureOptions(workspaceId: string, signal: AbortSignal): Promise<Response>;
  uploadAttachment(workspaceId: string, input: {
    captureId: string; filename: string; contentType: string; body: Uint8Array;
  }, signal: AbortSignal): Promise<Response>;
  createCapture(workspaceId: string, body: unknown, signal: AbortSignal): Promise<Response>;
  applyNoteEdit(noteId: string, body: unknown, signal: AbortSignal): Promise<Response>;
  applyTaskEdit(projectId: string, taskKey: string, body: unknown, signal: AbortSignal): Promise<Response>;
}

export class StashApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "StashApiError";
  }
}

export function createStashApiClient(options: StashApiClientOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return {
    async get<T>(path: string): Promise<T> {
      const response = await request(`${baseUrl}${path}`, { credentials: "include", ...(options.memberToken ? { headers: { authorization: `Bearer ${options.memberToken}` } } : {}) });
      if (!response.ok) throw await apiError(response);
      return response.json() as Promise<T>;
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const response = await request(`${baseUrl}${path}`, { method: "POST", credentials: "include",
        headers: { ...(options.memberToken ? { authorization: `Bearer ${options.memberToken}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw await apiError(response);
      return response.json() as Promise<T>;
    },
    async put<T>(path: string, body: unknown): Promise<T> {
      const response = await request(`${baseUrl}${path}`, { method: "PUT", credentials: "include",
        headers: { ...(options.memberToken ? { authorization: `Bearer ${options.memberToken}` } : {}), "content-type": "application/json" },
        body: JSON.stringify(body) });
      if (!response.ok) throw await apiError(response);
      return response.json() as Promise<T>;
    },
  };
}

export function createAgentGrantsApi(options: StashApiClientOptions): AgentGrantsApi {
  const request = options.fetch ?? globalThis.fetch; const baseUrl = options.baseUrl.replace(/\/$/, "");
  const send = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await request(`${baseUrl}${path}`, { ...init, credentials: "include", headers: {
      ...(options.memberToken ? { authorization: `Bearer ${options.memberToken}` } : {}), ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers,
    } });
    if (!response.ok) throw await apiError(response); return response.json() as Promise<unknown>;
  };
  const validated = async <T>(promise: Promise<unknown>, parse: (value: unknown) => { ok: boolean; value?: T; message?: string }) => { const result = parse(await promise); if (!result.ok || !result.value) throw new StashApiError(502, result.message ?? "Stash returned an invalid Agent Grant response"); return result.value; };
  const root = (organizationId: string) => `/api/organizations/${encodeURIComponent(organizationId)}/agent-grants`;
  return {
    options: () => validated(send("/api/agent-grant-options"), agentGrantOptionsResponse), list: (organizationId) => validated(send(root(organizationId)), agentGrantListResponse),
    create: (input) => validated(send(root(input.organizationId), { method: "POST", body: JSON.stringify(input) }), createAgentGrantResponse),
    revoke: (organizationId, grantId) => validated(send(`${root(organizationId)}/${encodeURIComponent(grantId)}`, { method: "DELETE" }), revokeAgentGrantResponse),
    proposals: (organizationId) => validated(send(`${root(organizationId)}/proposals`), agentProposalListResponse),
    proposal: (organizationId, proposalId) => validated(send(`${root(organizationId)}/proposals/${encodeURIComponent(proposalId)}`), agentProposalResponse),
    reviewProposal: (organizationId, proposalId, input) => validated(send(`${root(organizationId)}/proposals/${encodeURIComponent(proposalId)}/review`, { method: "POST", body: JSON.stringify(input) }), reviewAgentProposalResponse),
  };
}

async function apiError(response: Response) {
  const value = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
  return new StashApiError(response.status, typeof value?.message === "string" ? value.message : `Stash request failed with ${response.status}`);
}

export function createMobileProtocolClient(options: MobileProtocolClientOptions): MobileProtocolClient {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.instanceUrl.replace(/\/$/, "");
  const send = (path: string, init: RequestInit = {}) => request(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${options.memberToken}`, ...init.headers },
  });
  return {
    captureOptions: (workspaceId, signal) => send(`/api/mobile/v1/workspaces/${encodeURIComponent(workspaceId)}/capture-options`, { signal }),
    uploadAttachment: (workspaceId, input, signal) => send(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
      method: "POST",
      headers: { "content-type": input.contentType, "x-stash-filename": encodePortableFilename(input.filename),
        "x-stash-source": "upload", "x-stash-operation-key": input.captureId },
      body: input.body as BodyInit,
      signal,
    }),
    createCapture: (workspaceId, body, signal) => send(`/api/mobile/v1/workspaces/${encodeURIComponent(workspaceId)}/captures`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    }),
    applyNoteEdit: (noteId, body, signal) => send(`/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    }),
    applyTaskEdit: (projectId, taskKey, body, signal) => send(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/edits`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal },
    ),
  };
}

function encodePortableFilename(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
