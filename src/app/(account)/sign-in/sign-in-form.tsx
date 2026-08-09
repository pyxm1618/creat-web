"use client";

import { useState, type FormEvent } from "react";

import { TurnstileWidget } from "@/components/security/turnstile-widget";

type Status = "idle" | "sending" | "sent" | "limited" | "challenge" | "error";

export function SignInForm({ turnstileSiteKey }: Readonly<{ turnstileSiteKey?: string }>) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!turnstileToken) {
      setStatus("challenge");
      return;
    }
    setStatus("sending");

    const response = await fetch("/api/auth/magic-link/request", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, returnTo: "/account", turnstileToken }),
    }).catch(() => null);

    setTurnstileToken(null);
    setResetSignal((value) => value + 1);

    if (!response) {
      setStatus("error");
      return;
    }
    if (response.status === 429) {
      setStatus("limited");
      return;
    }
    if (response.status === 403 || response.status === 503) {
      setStatus("challenge");
      return;
    }
    setStatus(response.ok ? "sent" : "error");
  }

  const challengeReady = Boolean(turnstileSiteKey && turnstileToken);

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
      {turnstileSiteKey ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          resetSignal={resetSignal}
          onToken={(token) => {
            setTurnstileToken(token);
            if (token) setStatus((current) => (current === "challenge" ? "idle" : current));
          }}
          onUnavailable={() => setStatus("challenge")}
        />
      ) : (
        <p role="alert">Human verification is unavailable. Sign-in requests are disabled.</p>
      )}
      <button type="submit" disabled={status === "sending" || !challengeReady}>
        {status === "sending" ? "Sending…" : "Send secure sign-in link"}
      </button>
      <p id="sign-in-status" aria-live="polite">
        {status === "sent"
          ? "If this address can receive mail, a sign-in link has been sent."
          : status === "limited"
            ? "Too many sign-in requests. Try again later."
            : status === "challenge"
              ? "Human verification expired or could not be completed. Try the verification again."
              : status === "error"
                ? "The sign-in request could not be completed. Try again later."
                : "The link expires after ten minutes and can be used once."}
      </p>
    </form>
  );
}
