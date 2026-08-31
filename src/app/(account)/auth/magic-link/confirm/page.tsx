import type { Metadata } from "next";

import { AccountShell } from "@/components/account/account-shell";

import { MagicLinkConfirmation } from "./magic-link-confirmation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm sign in",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MagicLinkConfirmationPage() {
  return (
    <AccountShell eyebrow="Security confirmation" title="Confirm sign in" titleId="confirm-title">
      <MagicLinkConfirmation />
    </AccountShell>
  );
}
