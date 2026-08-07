import "server-only";

import { siteConfig } from "@/config/site.config";
import { env } from "@/platform/config/env";
import { getEmailSender } from "@/platform/email/email-runtime";

import { buildMagicLinkConfirmationUrl } from "./magic-link-confirmation";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function sendMagicLinkEmail(input: {
  readonly email: string;
  readonly token: string;
  readonly returnTo: string;
}): Promise<{ providerMessageId: string }> {
  const confirmationUrl = buildMagicLinkConfirmationUrl({
    appOrigin: env.appOrigin,
    token: input.token,
    returnTo: input.returnTo,
  });
  const sender = await getEmailSender();

  return sender.send({
    to: input.email,
    template: "magic-link",
    subject: `Confirm sign in to ${siteConfig.name}`,
    html: `<p>Confirm that you want to sign in to ${escapeHtml(siteConfig.name)}.</p><p><a href="${escapeHtml(confirmationUrl)}">Confirm sign in</a></p><p>This link expires in 10 minutes and can be used once.</p>`,
  });
}
