import type { Metadata } from "next";

import { AccountShell } from "@/components/account/account-shell";
import { env } from "@/platform/config/env";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: true },
};

export default function SignInPage() {
  return (
    <AccountShell
      eyebrow="Account access"
      title="Sign in securely"
      titleId="sign-in-title"
      intro="No password is required. We will send a single-use confirmation link."
    >
      <SignInForm turnstileSiteKey={env.turnstileSiteKey} />
    </AccountShell>
  );
}
