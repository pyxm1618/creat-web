import { describe, expect, it } from "vitest";

import { createTestEmailSender } from "@/platform/email/test-email-sender";

describe("transactional email sender", () => {
  it("records test messages without logging or sending externally", async () => {
    const sender = createTestEmailSender();

    const result = await sender.send({
      to: "user@example.com",
      template: "magic-link",
      subject: "Confirm sign in",
      html: '<a href="https://example.com/auth/magic-link/confirm#token=secret">Confirm</a>',
    });

    expect(result.providerMessageId).toBe("test_1");
    expect(sender.messages).toEqual([
      expect.objectContaining({
        to: "user@example.com",
        template: "magic-link",
        subject: "Confirm sign in",
      }),
    ]);
  });

  it("copies messages so callers cannot mutate the stored test mailbox", async () => {
    const sender = createTestEmailSender();
    const message = {
      to: "user@example.com",
      template: "security-notice" as const,
      subject: "Security notice",
      html: "<p>Notice</p>",
    };

    await sender.send(message);
    message.subject = "mutated";

    expect(sender.messages[0]?.subject).toBe("Security notice");
  });
});
