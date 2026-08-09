import type { Metadata } from "next";

import { env } from "@/platform/config/env";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: true },
};

export default function SignInPage() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="sign-in-title">
        <p className="eyebrow">Account access</p>
        <h1 id="sign-in-title">Sign in securely</h1>
        <p>No password is required. We will send a single-use confirmation link.</p>
        <SignInForm turnstileSiteKey={env.turnstileSiteKey} />
      </section>
    </main>
  );
}
