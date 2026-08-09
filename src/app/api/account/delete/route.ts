import { getAccountDeletionService } from "@/platform/accounts/account-deletion-runtime";
import { requireAccountContext } from "@/platform/auth/account-context";
import { assertFreshSession } from "@/platform/auth/session";
import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const accountDeletionService = getAccountDeletionService();
  if (!accountDeletionService) return new Response("Not Found", { status: 404 });
  if (request.headers.get("origin") !== env.appOrigin) {
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.startsWith("application/x-www-form-urlencoded") &&
    !contentType.startsWith("multipart/form-data")
  ) {
    return Response.json({ error: "invalid_content_type" }, { status: 415 });
  }

  const context = await requireAccountContext(request.headers);
  assertFreshSession({ authenticatedAt: new Date(context.session.createdAt) }, new Date());

  const form = await request.formData();
  if (form.get("confirmation") !== "DELETE") {
    return Response.json({ error: "confirmation_required" }, { status: 400 });
  }

  const deletionRequest = await accountDeletionService.request({
    subjectId: context.subject.id,
    authUserId: context.user.id,
  });

  try {
    await accountDeletionService.run(deletionRequest.id);
  } catch {
    // The durable request is already committed. The cron worker owns retries from here.
  }

  return Response.redirect(new URL("/account/deleted", env.appOrigin), 303);
}
