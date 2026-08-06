import "server-only";

import { env } from "@/platform/config/env";

import type { EmailSender } from "./email-sender";
import { createProductionResendEmailSender } from "./resend-email-sender";
import { createTestEmailSender, type TestEmailSender } from "./test-email-sender";

let testSender: TestEmailSender | undefined;
let productionSender: Promise<EmailSender> | undefined;

export function getTestEmailSender(): TestEmailSender {
  if (env.emailTransport !== "test") {
    throw new Error("test email sender is unavailable outside test transport mode");
  }
  testSender ??= createTestEmailSender();
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
