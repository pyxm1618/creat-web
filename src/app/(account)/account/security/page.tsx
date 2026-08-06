import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAccountContext } from "@/platform/auth/account-context";
import { auth } from "@/platform/auth/auth";

import {
  revokeAllSessionsAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  signOutAction,
} from "./actions";

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export default async function AccountSecurityPage() {
  const requestHeaders = await headers();
  const context = await getAccountContext(requestHeaders);
  if (!context) redirect("/sign-in");

  const sessions = await auth.api.listSessions({ headers: requestHeaders });

  return (
    <main className="shell">
      <section className="card" aria-labelledby="security-title">
        <p className="eyebrow">Account security</p>
        <h1 id="security-title">Active sessions</h1>
        <p>Review signed-in devices and revoke access you no longer recognize.</p>

        <ul>
          {sessions.map((session) => {
            const current = session.token === context.session.token;
            return (
              <li key={session.id}>
                <p>
                  <strong>{current ? "Current session" : "Other session"}</strong>
                  <br />
                  {session.userAgent ?? "Unknown browser"}
                  <br />
                  Created {formatDate(session.createdAt)} · Expires {formatDate(session.expiresAt)}
                </p>
                {!current ? (
                  <form action={revokeSessionAction}>
                    <input type="hidden" name="token" value={session.token} />
                    <button type="submit">Revoke this session</button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>

        <form action={revokeOtherSessionsAction}>
          <button type="submit">Revoke all other sessions</button>
        </form>
        <form action={signOutAction}>
          <button type="submit">Sign out this session</button>
        </form>
        <form action={revokeAllSessionsAction}>
          <button type="submit">Revoke every session</button>
        </form>
      </section>
    </main>
  );
}
