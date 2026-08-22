import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRecoveryEmailSender } from "../src/recovery-email.js";

describe("operator-configured email recovery delivery", () => {
  it("is disabled when SMTP is absent and rejects partial configuration", () => {
    assert.equal(createRecoveryEmailSender({ publicOrigin: "https://stash.test" }), undefined);
    assert.throws(() => createRecoveryEmailSender({ smtpUrl: "smtp://mail.test", publicOrigin: "https://stash.test" }), /configured together/);
  });
  it("delivers a single-use recovery URL through a protocol-compatible SMTP fake", async () => {
    const messages: Array<{ to: string; text: string }> = [];
    const sender = createRecoveryEmailSender(
      { smtpUrl: "smtp://mail.test", from: "Stash <recovery@stash.test>", publicOrigin: "https://stash.test" },
      () => ({ async sendMail(message) { messages.push(message); } }),
    );
    await sender!.enqueueRecovery({ address: "ada@example.com", token: "secret-token" });
    assert.equal(messages[0]?.to, "ada@example.com");
    assert.match(messages[0]?.text ?? "", /https:\/\/stash\.test\/recover-account\?token=secret-token/);
  });
});
