import nodemailer from "nodemailer";
import type { RecoveryEmailSender } from "./account-recovery.js";

interface MailTransport { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> }

export function createRecoveryEmailSender(
  configuration: { smtpUrl?: string; from?: string; publicOrigin: string },
  transportFactory: (url: string) => MailTransport = (url) => nodemailer.createTransport(url),
): RecoveryEmailSender | undefined {
  if (!configuration.smtpUrl && !configuration.from) return undefined;
  if (!configuration.smtpUrl || !configuration.from) throw new Error("SMTP_URL and EMAIL_RECOVERY_FROM must be configured together");
  const origin = new URL(configuration.publicOrigin);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") throw new Error("PUBLIC_ORIGIN must use HTTPS for email recovery");
  const transport = transportFactory(configuration.smtpUrl);
  return {
    async enqueueRecovery(delivery) {
      if (!delivery) return;
      const { address, token } = delivery;
      const recoveryUrl = new URL("/recover-account", origin);
      recoveryUrl.searchParams.set("token", token);
      await transport.sendMail({
        from: configuration.from!,
        to: address,
        subject: "Recover your Stash account",
        text: `Use this single-use link within 15 minutes to recover your Stash account:\n\n${recoveryUrl.toString()}\n\nIf you did not request this, ignore this message.`,
      });
    },
  };
}
