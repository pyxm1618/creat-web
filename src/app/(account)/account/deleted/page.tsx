import type { Metadata } from "next";
import Link from "next/link";

import { AccountShell } from "@/components/account/account-shell";
import { bodyText, inlineLink } from "@/components/ui/styles";

export const metadata: Metadata = {
  title: "Account deletion submitted",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <AccountShell
      eyebrow="Account lifecycle"
      title="Account deletion submitted"
      titleId="deleted-title"
    >
      <p className={bodyText}>
        Access to account-scoped product data is blocked immediately. The deletion workflow runs now
        and retries durable downstream cleanup automatically if a dependency is temporarily
        unavailable.
      </p>
      <p className="mt-6">
        <Link href="/" className={inlineLink}>
          Return to the homepage
        </Link>
      </p>
    </AccountShell>
  );
}
