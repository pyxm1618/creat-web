import "server-only";

import { env } from "@/platform/config/env";

import type { EmailSender } from "./email-sender";
import { createFileTestEmailSender } from "./file-test-email-sender";
import { createProductionResendEmailSender } from "./resend-email-sender";

let testSender: EmailSender | undefined;
let productionSender: Promise<EmailSender> | undefined;

export function getTestEmailDirectory(): string {
  if (env.emailTransport !== "test" || !env.testEmailDirectory) {
    throw new Error("test email mailbox is unavailable outside test transport mode");
  }
  return env.testEmailDirectory;
}

export function getTestEmailSender(): EmailSender {
  testSender ??= createFileTestEmailSender(getTestEmailDirectory());
  return testSender;
}

export async function getEmailSender(): Promise<EmailSender> {
  if (env.emailTransport === "test") return getTestEmailSender();
  if (env.emailTransport !== "resend") throw new Error("email transport is disabled");
  if (!env.resendApiKey || !env.emailFrom || !env.supportEmail) {
    throw new Error("Resend runtime configuration is incomplete");
  }

  productionSender ??= createProductionResendEmailSender({
    apiKey: env.resendApiKey,
    from: env.emailFrom,
    replyTo: env.supportEmail,
  });
  return productionSender;
}
