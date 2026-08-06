"use client";

import { useState, type FormEvent } from "react";

import { authClient } from "@/platform/auth/auth-client";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");

    const result = await authClient.signIn.magicLink({
      email,
      callbackURL: "/account",
      errorCallbackURL: "/sign-in?error=magic-link",
      metadata: { returnTo: "/account" },
    });

    setStatus(result.error ? "error" : "sent");
  }

  return (
    <form onSubmit={submit} aria-describedby="sign-in-status">
      <label htmlFor="email">Email address</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={status === "sending"}
      />
      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Send secure sign-in link"}
      </button>
      <p id="sign-in-status" aria-live="polite">
        {status === "sent"
          ? "If this address can receive mail, a sign-in link has been sent."
          : status === "error"
            ? "The sign-in request could not be completed. Try again later."
            : "The link expires after ten minutes and can be used once."}
      </p>
    </form>
  );
}
