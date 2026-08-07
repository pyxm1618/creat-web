export type TransactionalEmailTemplate = "magic-link" | "account-deletion" | "security-notice";

export type TransactionalEmail = {
  readonly to: string;
  readonly template: TransactionalEmailTemplate;
  readonly subject: string;
  readonly html: string;
};

export type EmailSendResult = {
  readonly providerMessageId: string;
};

export interface EmailSender {
  send(message: TransactionalEmail): Promise<EmailSendResult>;
}
