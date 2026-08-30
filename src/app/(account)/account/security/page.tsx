import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { AccountShell } from "@/components/account/account-shell";
import {
  bodyText,
  buttonDanger,
  buttonSecondary,
  input,
  label,
  listDivided,
  metaText,
  panel,
  subTitle,
} from "@/components/ui/styles";
import { getAccountContext } from "@/platform/auth/account-context";
import { getAuth } from "@/platform/auth/auth";

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
  const auth = getAuth();
  if (!auth) notFound();
  const requestHeaders = await headers();
  const context = await getAccountContext(requestHeaders);
  if (!context) redirect("/sign-in");

  const sessions = await auth.api.listSessions({ headers: requestHeaders });

  return (
    <AccountShell
      eyebrow="Account security"
      title="Active sessions"
      titleId="security-title"
      intro="Review signed-in devices and revoke access you no longer recognize."
    >
      <ul className={`${panel} ${listDivided} px-5`}>
        {sessions.map((session) => {
          const current = session.token === context.session.token;
          return (
            <li key={session.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {current ? "Current session" : "Other session"}
                </p>
                <p className={`mt-1 ${metaText}`}>{session.userAgent ?? "Unknown browser"}</p>
                <p className={`mt-1 ${metaText}`}>
                  Created {formatDate(session.createdAt)} · Expires {formatDate(session.expiresAt)}
                </p>
              </div>
              {!current ? (
                <form action={revokeSessionAction}>
                  <input type="hidden" name="sessionId" value={session.id} />
                  <button type="submit" className={buttonSecondary}>
                    Revoke this session
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex flex-wrap gap-3">
        <form action={revokeOtherSessionsAction}>
          <button type="submit" className={buttonSecondary}>
            Revoke all other sessions
          </button>
        </form>
        <form action={signOutAction}>
          <button type="submit" className={buttonSecondary}>
            Sign out this session
          </button>
        </form>
        <form action={revokeAllSessionsAction}>
          <button type="submit" className={buttonSecondary}>
            Revoke every session
          </button>
        </form>
      </div>

      <div className="mt-12 rounded-xl border border-red-200 bg-red-50/50 p-6 dark:border-red-900/60 dark:bg-red-950/20">
        <h2 className={subTitle}>Delete account</h2>
        <p className={`mt-3 ${bodyText}`}>
          This revokes all access and permanently removes your authentication identity. Required
          financial or security records may remain pseudonymized according to the published policy.
        </p>
        <form action="/api/account/delete" method="post" className="mt-5 max-w-sm">
          <label htmlFor="delete-confirmation" className={label}>
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirmation"
            name="confirmation"
            type="text"
            autoComplete="off"
            pattern="DELETE"
            required
            className={input}
          />
          <button type="submit" className={`mt-4 ${buttonDanger}`}>
            Permanently delete account
          </button>
        </form>
      </div>
    </AccountShell>
  );
}
