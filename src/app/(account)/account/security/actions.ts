"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAccountContext } from "@/platform/auth/account-context";
import { getAuth } from "@/platform/auth/auth";

async function authenticatedRequest() {
  const requestHeaders = await headers();
  const context = await requireAccountContext(requestHeaders);
  return { context, requestHeaders } as const;
}

function requireAuth() {
  const auth = getAuth();
  if (!auth) throw new Error("authentication is disabled");
  return auth;
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("sessionId");
  if (typeof sessionId !== "string" || sessionId.length < 1) {
    throw new Error("invalid session id");
  }

  const { context, requestHeaders } = await authenticatedRequest();
  const auth = requireAuth();
  const sessions = await auth.api.listSessions({ headers: requestHeaders });
  const matched = sessions.filter((session) => session.id === sessionId);
  if (matched.length !== 1 || !matched[0]) throw new Error("session not found");
  if (matched[0].id === context.session.id) throw new Error("current session cannot be revoked");

  await auth.api.revokeSession({
    body: { token: matched[0].token },
    headers: requestHeaders,
  });
  revalidatePath("/account/security");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const { requestHeaders } = await authenticatedRequest();
  await requireAuth().api.revokeOtherSessions({ headers: requestHeaders });
  revalidatePath("/account/security");
}

export async function revokeAllSessionsAction(): Promise<void> {
  const { requestHeaders } = await authenticatedRequest();
  await requireAuth().api.revokeSessions({ headers: requestHeaders });
  redirect("/sign-in");
}

export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  await requireAuth().api.signOut({ headers: requestHeaders });
  redirect("/sign-in");
}
