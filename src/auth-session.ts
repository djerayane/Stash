import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { SessionRecord } from "./password-auth.js";

export interface SessionRepository {
  createSession(session: SessionRecord): Promise<void>;
}

export interface SessionMember {
  id: string;
  name: string;
  email: string;
}

export async function issueSession(
  repository: SessionRepository,
  member: SessionMember,
  userAgent?: string,
) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: randomUUID(),
    accountId: member.id,
    tokenHash: createHash("sha256").update(token).digest("base64"),
    createdAt: now,
    lastSeenAt: now,
    ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {}),
  };
  await repository.createSession(session);
  return {
    token,
    member,
    session: presentSession(session, session.id),
  };
}

export function presentSession(session: SessionRecord, currentSessionId: string) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    ...(session.userAgent ? { userAgent: session.userAgent } : {}),
    current: session.id === currentSessionId,
  };
}
