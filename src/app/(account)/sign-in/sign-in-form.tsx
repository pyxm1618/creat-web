"use client";

import { useState, type FormEvent } from "react";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "limited" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");

    const response = await fetch("/api/auth/magic-link/request", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, returnTo: "/account" }),
    }).catch(() => null);

    if (!response) {
      setStatus("error");
      return;
    }
    if (response.status === 429) {
      setStatus("limited");
      return;
    }
    setStatus(response.ok ? "sent" : "error");
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
          : status === "limited"
            ? "Too many sign-in requests. Try again later."
            : status === "error"
              ? "The sign-in request could not be completed. Try again later."
              : "The link expires after ten minutes and can be used once."}
      </p>
    </form>
  );
}
