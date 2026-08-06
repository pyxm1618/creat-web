"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAccountContext } from "@/platform/auth/account-context";
import { auth } from "@/platform/auth/auth";

async function authenticatedHeaders(): Promise<Headers> {
  const requestHeaders = await headers();
  await requireAccountContext(requestHeaders);
  return requestHeaders;
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const token = formData.get("token");
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("invalid session token");
  }

  const requestHeaders = await authenticatedHeaders();
  await auth.api.revokeSession({
    body: { token },
    headers: requestHeaders,
  });
  revalidatePath("/account/security");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const requestHeaders = await authenticatedHeaders();
  await auth.api.revokeOtherSessions({ headers: requestHeaders });
  revalidatePath("/account/security");
}

export async function revokeAllSessionsAction(): Promise<void> {
  const requestHeaders = await authenticatedHeaders();
  await auth.api.revokeSessions({ headers: requestHeaders });
  redirect("/sign-in");
}

export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  await auth.api.signOut({ headers: requestHeaders });
  redirect("/sign-in");
}
