import { env } from "@/platform/config/env";
import { getTestEmailDirectory } from "@/platform/email/email-runtime";
import { readLatestTestEmail } from "@/platform/email/file-test-email-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (env.appEnv !== "test" || env.vercelEnv || env.emailTransport !== "test") {
    return new Response("Not Found", { status: 404 });
  }

  const recipient = new URL(request.url).searchParams.get("to")?.trim().toLowerCase();
  if (!recipient) {
    return Response.json({ error: "recipient_required" }, { status: 400 });
  }

  const message = await readLatestTestEmail(getTestEmailDirectory(), recipient);
  if (!message) {
    return Response.json({ error: "message_not_found" }, { status: 404 });
  }

  return Response.json(
    {
      to: message.to,
      template: message.template,
      subject: message.subject,
      html: message.html,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
