export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly message?: string;
}

export function nonEmptyText(value: unknown, label = "Value"): ValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: `${label} is required` };
  return { ok: true, value: value.trim() };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function canonicalUuid(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

import { agentGrantCapabilities, agentGrantModes, type AgentGrant, type AgentGrantOption, type AgentProposal, type CreateAgentGrantRequest, type CreateAgentGrantResponse, type RevokeAgentGrantResponse } from "@stash/domain-types";

export function createAgentGrantRequest(value: unknown): ValidationResult<CreateAgentGrantRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Agent Grant request is invalid" };
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => ["organizationId", "projectId", "name", "scopes", "expiresAt"].includes(key))
    || typeof input.organizationId !== "string" || !isUuid(input.organizationId)
    || input.projectId !== undefined && (typeof input.projectId !== "string" || !isUuid(input.projectId))
    || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80
    || typeof input.expiresAt !== "string" || !Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 20)
    return { ok: false, message: "Agent Grant request is invalid" };
  const scopes = input.scopes as unknown[];
  if (new Set(scopes.map((scope) => scope && typeof scope === "object" ? (scope as any).capability : "")).size !== scopes.length
    || !scopes.every((scope) => scope && typeof scope === "object" && !Array.isArray(scope) && Object.keys(scope).length === 2
      && agentGrantCapabilities.includes((scope as any).capability) && agentGrantModes.includes((scope as any).mode)
      && (!(scope as any).capability.endsWith(".read") || (scope as any).mode !== "propose")))
    return { ok: false, message: "Agent Grant request is invalid" };
  return { ok: true, value: { organizationId: input.organizationId, ...(input.projectId ? { projectId: input.projectId as string } : {}),
    name: input.name.trim(), scopes: scopes as CreateAgentGrantRequest["scopes"], expiresAt: input.expiresAt } };
}

export function agentGrantOptionsResponse(value: unknown): ValidationResult<{ organizations: AgentGrantOption[] }> { return collectionResponse(value, "organizations", isOption); }
export function agentGrantListResponse(value: unknown): ValidationResult<{ grants: AgentGrant[] }> { return collectionResponse(value, "grants", isGrant); }
export function agentProposalListResponse(value: unknown): ValidationResult<{ proposals: AgentProposal[] }> { return collectionResponse(value, "proposals", isProposal); }
export function createAgentGrantResponse(value: unknown): ValidationResult<CreateAgentGrantResponse> { if (!plain(value) || !exact(value, ["status", "grant", "token"]) || value.status !== "created" || typeof value.token !== "string" || !isGrant(value.grant)) return { ok: false, message: "Agent Grant response is invalid" }; return { ok: true, value: value as unknown as CreateAgentGrantResponse }; }
export function revokeAgentGrantResponse(value: unknown): ValidationResult<RevokeAgentGrantResponse> { if (!plain(value) || !exact(value, ["grantId", "revoked"]) || typeof value.grantId !== "string" || value.revoked !== true) return { ok: false, message: "Agent Grant response is invalid" }; return { ok: true, value: value as unknown as RevokeAgentGrantResponse }; }
function collectionResponse<K extends "organizations" | "grants" | "proposals", T>(value: unknown, key: K, predicate: (item: unknown) => item is T): ValidationResult<Record<K, T[]>> { if (!plain(value) || !exact(value, [key]) || !Array.isArray(value[key]) || !value[key].every(predicate)) return { ok: false, message: "Agent Grant response is invalid" }; return { ok: true, value: value as Record<K, T[]> }; }
function isScope(value: unknown): boolean { return plain(value) && exact(value, ["capability", "mode"]) && agentGrantCapabilities.includes(value.capability as any) && agentGrantModes.includes(value.mode as any); }
function isGrant(value: unknown): value is AgentGrant { return plain(value) && exact(value, ["id", "organizationId", "sponsoringMemberId", "name", "projectId", "scopes", "expiresAt", "createdAt", "revokedAt"], ["id", "organizationId", "sponsoringMemberId", "name", "scopes", "expiresAt", "createdAt"]) && typeof value.id === "string" && typeof value.organizationId === "string" && typeof value.sponsoringMemberId === "string" && typeof value.name === "string" && (value.projectId === undefined || typeof value.projectId === "string") && Array.isArray(value.scopes) && value.scopes.every(isScope) && typeof value.expiresAt === "string" && typeof value.createdAt === "string" && (value.revokedAt === undefined || typeof value.revokedAt === "string"); }
function isOption(value: unknown): value is AgentGrantOption { return plain(value) && exact(value, ["organizationId", "organizationName", "projects"]) && typeof value.organizationId === "string" && typeof value.organizationName === "string" && Array.isArray(value.projects) && value.projects.every((project) => plain(project) && exact(project, ["id", "name"]) && typeof project.id === "string" && typeof project.name === "string"); }
function isProposal(value: unknown): value is AgentProposal { return plain(value) && exact(value, ["id", "grantId", "sponsoringMemberId", "capability", "input", "createdAt", "status"]) && typeof value.id === "string" && typeof value.grantId === "string" && typeof value.sponsoringMemberId === "string" && agentGrantCapabilities.includes(value.capability as any) && "input" in value && typeof value.createdAt === "string" && value.status === "pending"; }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function exact(value: Record<string, unknown>, allowed: string[], required = allowed): boolean { return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value); }

export function validPortableFilename(value: string): boolean {
  return Boolean(value && value.length <= 255 && value === value.trim() && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value) && value !== "." && value !== ".."
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
}

export function validMobilePairingOrigin(value: string, allowLoopbackHttp = false): boolean {
  try {
    const url = new URL(value);
    const loopback = allowLoopbackHttp && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    return (url.protocol === "https:" || loopback) && !url.username && !url.password
      && url.origin === url.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export type ProjectActivityPreference = "all" | "followed" | "muted";
export type NotificationDigestCadence = "off" | "daily" | "weekly";
export interface ProjectNotificationSettings {
  readonly activity: ProjectActivityPreference;
  readonly digest: NotificationDigestCadence;
  readonly quietHours?: { readonly start: string; readonly end: string; readonly timeZone: string };
}

const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function projectNotificationSettings(value: unknown): ValidationResult<ProjectNotificationSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Notification settings are invalid" };
  const item = value as Record<string, unknown>;
  if (!["all", "followed", "muted"].includes(String(item.activity)) || !["off", "daily", "weekly"].includes(String(item.digest)))
    return { ok: false, message: "Notification settings are invalid" };
  let quietHours: ProjectNotificationSettings["quietHours"];
  if (item.quietHours !== undefined) {
    if (!item.quietHours || typeof item.quietHours !== "object" || Array.isArray(item.quietHours)) return { ok: false, message: "Quiet hours are invalid" };
    const quiet = item.quietHours as Record<string, unknown>;
    if (typeof quiet.start !== "string" || !clockTime.test(quiet.start) || typeof quiet.end !== "string" || !clockTime.test(quiet.end)
      || typeof quiet.timeZone !== "string" || !quiet.timeZone.trim()) return { ok: false, message: "Quiet hours are invalid" };
    quietHours = { start: quiet.start, end: quiet.end, timeZone: quiet.timeZone };
  }
  return { ok: true, value: { activity: item.activity as ProjectActivityPreference, digest: item.digest as NotificationDigestCadence,
    ...(quietHours ? { quietHours } : {}) } };
}

export function projectFollowState(value: unknown): ValidationResult<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { followed?: unknown }).followed !== "boolean")
    return { ok: false, message: "Project follow state is invalid" };
  return { ok: true, value: (value as { followed: boolean }).followed };
}
