import type { EmailSender, TransactionalEmail } from "./email-sender";

export type TestEmailSender = EmailSender & {
  readonly messages: readonly TransactionalEmail[];
};

export function createTestEmailSender(): TestEmailSender {
  const messages: TransactionalEmail[] = [];

  return {
    messages,
    async send(message) {
      messages.push({ ...message });
      return { providerMessageId: `test_${messages.length}` };
    },
  };
}
