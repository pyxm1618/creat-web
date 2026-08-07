import { describe, expect, it, vi } from "vitest";

import { createResendEmailSender } from "@/platform/email/resend-email-sender";

describe("Resend email sender", () => {
  it("maps transactional email fields and returns the provider id", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });
    const sender = createResendEmailSender({
      from: "Example <login@example.com>",
      replyTo: "support@example.com",
      client: { emails: { send } },
    });

    await expect(
      sender.send({
        to: "user@example.com",
        template: "magic-link",
        subject: "Confirm sign in",
        html: "<p>Confirm</p>",
      }),
    ).resolves.toEqual({ providerMessageId: "email_123" });

    expect(send).toHaveBeenCalledWith({
      from: "Example <login@example.com>",
      replyTo: "support@example.com",
      to: ["user@example.com"],
      subject: "Confirm sign in",
      html: "<p>Confirm</p>",
    });
  });

  it("returns a stable redacted error without exposing provider payloads", async () => {
    const sender = createResendEmailSender({
      from: "Example <login@example.com>",
      replyTo: "support@example.com",
      client: {
        emails: {
          send: vi.fn().mockResolvedValue({
            data: null,
            error: { name: "validation_error", message: "secret provider detail" },
          }),
        },
      },
    });

    await expect(
      sender.send({
        to: "user@example.com",
        template: "magic-link",
        subject: "Confirm sign in",
        html: "<p>Confirm</p>",
      }),
    ).rejects.toThrow("email delivery failed: validation_error");
  });
});
