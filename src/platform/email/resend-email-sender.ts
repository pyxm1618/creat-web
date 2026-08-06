import type { EmailSender } from "./email-sender";

export type ResendClientLike = {
  readonly emails: {
    send(input: {
      readonly from: string;
      readonly to: readonly string[];
      readonly replyTo: string;
      readonly subject: string;
      readonly html: string;
    }): Promise<{
      readonly data: { readonly id: string } | null;
      readonly error: { readonly name?: string } | null;
    }>;
  };
};

export function createResendEmailSender(input: {
  readonly from: string;
  readonly replyTo: string;
  readonly client: ResendClientLike;
}): EmailSender {
  return {
    async send(message) {
      const result = await input.client.emails.send({
        from: input.from,
        to: [message.to],
        replyTo: input.replyTo,
        subject: message.subject,
        html: message.html,
      });

      if (result.error || !result.data?.id) {
        throw new Error(`email delivery failed: ${result.error?.name ?? "unknown_error"}`);
      }

      return { providerMessageId: result.data.id };
    },
  };
}

export async function createProductionResendEmailSender(input: {
  readonly apiKey: string;
  readonly from: string;
  readonly replyTo: string;
}): Promise<EmailSender> {
  const { Resend } = await import("resend");
  return createResendEmailSender({
    from: input.from,
    replyTo: input.replyTo,
    client: new Resend(input.apiKey),
  });
}
