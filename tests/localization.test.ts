import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  MemberLocalizationService,
  type MemberLocalizationPreferences,
  type MemberLocalizationRepository,
} from "../src/member-localization.js";

class ProtocolCompatibleDatabaseProbe implements DatabaseProbe {
  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}
}

class ProtocolCompatibleLocalizationRepository implements MemberLocalizationRepository {
  readonly preferences = new Map<string, MemberLocalizationPreferences>();
  failure: Error | undefined;

  async findMemberLocalizationPreferences(memberId: string): Promise<MemberLocalizationPreferences | undefined> {
    if (this.failure) throw this.failure;
    return this.preferences.get(memberId);
  }

  async saveMemberLocalizationPreferences(memberId: string, preferences: MemberLocalizationPreferences): Promise<void> {
    if (this.failure) throw this.failure;
    this.preferences.set(memberId, preferences);
  }
}

describe("Member localization through a running Stash Instance", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run(repository = new ProtocolCompatibleLocalizationRepository()) {
    instance = await startInstance({
      database: new ProtocolCompatibleDatabaseProbe(),
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      memberAccess: {
        async authenticateBearer(authorization) {
          return authorization === "Bearer member-session"
            ? { accountId: "member-1", sessionId: "session-1" }
            : undefined;
        },
      },
      memberLocalization: new MemberLocalizationService(
        repository,
        () => new Date("2026-08-22T12:34:56.789Z"),
      ),
    });
    return { baseUrl: instance.url, repository };
  }

  it("stores Member preferences and renders UTC timestamps in their locale and time zone", async () => {
    const { baseUrl } = await run();
    const headers = { authorization: "Bearer member-session", "content-type": "application/json" };

    const update = await fetch(`${baseUrl}/api/member/localization`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        locale: "en-GB",
        timeZone: "Europe/Paris",
        dateFormat: "long",
        weekStartsOn: "monday",
      }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(await update.json(), {
      locale: "en-GB",
      timeZone: "Europe/Paris",
      dateFormat: "long",
      weekStartsOn: "monday",
      updatedAt: "2026-08-22T12:34:56.789Z",
    });

    const rendered = await fetch(
      `${baseUrl}/api/member/localization/render?message=instance.running&timestamp=2026-12-24T23:30:00-05:00`,
      { headers },
    );
    assert.equal(rendered.status, 200);
    assert.deepEqual(await rendered.json(), {
      message: "This Instance is running.",
      date: "25 December 2026",
      timestamp: "2026-12-25T04:30:00.000Z",
      weekStartsOn: "monday",
    });
  });

  it("ships safe defaults and pseudo-localizes catalog messages", async () => {
    const { baseUrl } = await run();
    const headers = { authorization: "Bearer member-session", "content-type": "application/json" };

    const defaults = await fetch(`${baseUrl}/api/member/localization`, { headers });
    assert.equal(defaults.status, 200);
    assert.deepEqual(await defaults.json(), {
      locale: "en",
      timeZone: "UTC",
      dateFormat: "medium",
      weekStartsOn: "monday",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });

    await fetch(`${baseUrl}/api/member/localization`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ locale: "en-XA", timeZone: "UTC", dateFormat: "short", weekStartsOn: "sunday" }),
    });
    const rendered = await fetch(
      `${baseUrl}/api/member/localization/render?message=instance.running&timestamp=2026-08-22T00:00:00Z`,
      { headers },
    );
    assert.equal(rendered.status, 200);
    assert.deepEqual(await rendered.json(), {
      message: "[Thïs Ïnstàncë ïs rünnïng. !!!]",
      date: "8/22/26",
      timestamp: "2026-08-22T00:00:00.000Z",
      weekStartsOn: "sunday",
    });
  });

  it("makes authorization, invalid input, and recoverable storage failures visible", async () => {
    const repository = new ProtocolCompatibleLocalizationRepository();
    const { baseUrl } = await run(repository);
    const denied = await fetch(`${baseUrl}/api/member/localization`);
    assert.equal(denied.status, 401);

    const headers = { authorization: "Bearer member-session", "content-type": "application/json" };
    const invalid = await fetch(`${baseUrl}/api/member/localization`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ locale: "not a locale", timeZone: "Mars/Olympus", dateFormat: "verbose", weekStartsOn: "tuesday" }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      error: "invalid_input",
      message: "Locale, time zone, date format, and week start must be valid.",
    });
    assert.equal(repository.preferences.size, 0);

    const ambiguousTimestamp = await fetch(
      `${baseUrl}/api/member/localization/render?message=instance.running&timestamp=2026-08-22T12:00:00`,
      { headers },
    );
    assert.equal(ambiguousTimestamp.status, 422);

    repository.failure = new Error("connection refused");
    const unavailable = await fetch(`${baseUrl}/api/member/localization`, { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "localization_unavailable",
      message: "Localization preferences are temporarily unavailable.",
    });
  });
});
