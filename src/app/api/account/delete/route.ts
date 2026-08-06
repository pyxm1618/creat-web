import { createAccountDeletionService } from "@/platform/accounts/account-deletion-service";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { requireAccountContext } from "@/platform/auth/account-context";
import { assertFreshSession } from "@/platform/auth/session";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const subjects = createPostgresAccountSubjectRepository(db);
const deletion = createAccountDeletionService({
  database: db,
  subjects,
  coordinator: createPlatformAccountDeletionCoordinator(),
});

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.appOrigin) {
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded") && !contentType.startsWith("multipart/form-data")) {
    return Response.json({ error: "invalid_content_type" }, { status: 415 });
  }

  const context = await requireAccountContext(request.headers);
  assertFreshSession(
    { authenticatedAt: new Date(context.session.createdAt) },
    new Date(),
  );

  const form = await request.formData();
  if (form.get("confirmation") !== "DELETE") {
    return Response.json({ error: "confirmation_required" }, { status: 400 });
  }

  const deletionRequest = await deletion.request({
    subjectId: context.subject.id,
    authUserId: context.user.id,
  });

  try {
    await deletion.run(deletionRequest.id);
  } catch {
    return Response.json(
      { error: "deletion_pending_retry" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.redirect(new URL("/account/deleted", env.appOrigin), 303);
}
