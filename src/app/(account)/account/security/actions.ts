"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAccountContext } from "@/platform/auth/account-context";
import { getAuth } from "@/platform/auth/auth";

async function authenticatedHeaders(): Promise<Headers> {
  const requestHeaders = await headers();
  await requireAccountContext(requestHeaders);
  return requestHeaders;
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

  const requestHeaders = await authenticatedHeaders();
  const auth = requireAuth();
  const sessions = await auth.api.listSessions({ headers: requestHeaders });
  const matched = sessions.filter((session) => session.id === sessionId);
  if (matched.length !== 1 || !matched[0]) throw new Error("session not found");

  await auth.api.revokeSession({
    body: { token: matched[0].token },
    headers: requestHeaders,
  });
  revalidatePath("/account/security");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const requestHeaders = await authenticatedHeaders();
  await requireAuth().api.revokeOtherSessions({ headers: requestHeaders });
  revalidatePath("/account/security");
}

export async function revokeAllSessionsAction(): Promise<void> {
  const requestHeaders = await authenticatedHeaders();
  await requireAuth().api.revokeSessions({ headers: requestHeaders });
  redirect("/sign-in");
}

export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  await requireAuth().api.signOut({ headers: requestHeaders });
  redirect("/sign-in");
}
