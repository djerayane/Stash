import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  OwnerBootstrapService,
  type BootstrapRecord,
  type OwnerBootstrapRepository,
} from "../../src/owner-bootstrap.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";

class ProtocolCompatibleDatabase implements DatabaseProbe, OwnerBootstrapRepository {
  public record: BootstrapRecord | undefined;
  public failure: Error | undefined;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}

  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    if (this.failure) throw this.failure;
    if (this.record) return false;
    this.record = record;
    return true;
  }
}

describe("bootstrapping the first Organization Owner", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleDatabase();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      ownerBootstrap: new OwnerBootstrapService(database),
    });
    return { database, baseUrl: instance.url };
  }

  function bootstrap(baseUrl: string, body: object, token = "test-instance-admin-token") {
    return fetch(`${baseUrl}/api/instance/organizations/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets the Instance Administrator create the first Organization Owner", async () => {
    const { baseUrl, database } = await run();
    const response = await bootstrap(baseUrl, {
      organizationName: "Acme",
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      password: "correct horse battery staple",
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.organizationName, "Acme");
    assert.equal(body.ownerName, "Ada Lovelace");
    assert.equal(body.ownerEmail, "ada@example.com");
    assert.equal(body.role, "Owner");
    assert.ok(typeof body.organizationId === "string");
    assert.ok(typeof body.ownerId === "string");
    assert.equal("password" in body, false);

    assert.equal(database.record?.ownerEmail, "ada@example.com");
    assert.notEqual(database.record?.passwordHash, "correct horse battery staple");
    assert.match(database.record?.passwordHash ?? "", /^scrypt\$/);
    assert.equal(database.record?.role, "Owner");
  });

  it("rejects unauthorized attempts without exposing submitted or configured secrets", async () => {
    const { baseUrl, database } = await run();
    const response = await bootstrap(
      baseUrl,
      {
        organizationName: "Acme",
        ownerName: "Ada",
        ownerEmail: "ada@example.com",
        password: "submitted-secret-password",
      },
      "wrong-token",
    );

    assert.equal(response.status, 401);
    const text = await response.text();
    assert.doesNotMatch(text, /wrong-token|test-instance-admin-token|submitted-secret-password/);
    assert.equal(database.record, undefined);
  });

  it("reports invalid input and does not persist partial state", async () => {
    const { baseUrl, database } = await run();
    const response = await bootstrap(baseUrl, {
      organizationName: " ",
      ownerName: "Ada",
      ownerEmail: "not-an-email",
      password: "short",
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "invalid_input",
      message: "organizationName, ownerName, ownerEmail, and password must be valid.",
    });
    assert.equal(database.record, undefined);
  });

  it("prevents a second bootstrap and keeps open registration unavailable", async () => {
    const { baseUrl } = await run();
    const input = {
      organizationName: "Acme",
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      password: "correct horse battery staple",
    };
    assert.equal((await bootstrap(baseUrl, input)).status, 201);

    const duplicate = await bootstrap(baseUrl, { ...input, ownerEmail: "grace@example.com" });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      error: "already_bootstrapped",
      message: "The first Organization Owner has already been created.",
    });

    const registration = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(registration.status, 404);
  });

  it("makes a recoverable persistence failure visible without leaking details", async () => {
    const { baseUrl, database } = await run();
    database.failure = new Error("postgres://stash:secret@database/stash");
    const response = await bootstrap(baseUrl, {
      organizationName: "Acme",
      ownerName: "Ada Lovelace",
      ownerEmail: "ada@example.com",
      password: "correct horse battery staple",
    });

    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      error: "bootstrap_unavailable",
      message: "The first Organization Owner could not be created. Try again.",
    });
    assert.doesNotMatch(text, /postgres|secret|password/i);
  });
});
