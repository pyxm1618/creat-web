"use client";

import { useEffect, useState } from "react";

export function MagicLinkConfirmation() {
  const [token, setToken] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState("/account");
  const [status, setStatus] = useState<"loading" | "ready" | "submitting" | "error">("loading");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = fragment.get("token");
    const fragmentReturnTo = fragment.get("returnTo") ?? "/account";
    window.history.replaceState(null, "", window.location.pathname);

    if (!fragmentToken) {
      setStatus("error");
      return;
    }

    setToken(fragmentToken);
    setReturnTo(fragmentReturnTo);
    setStatus("ready");
  }, []);

  async function confirm() {
    if (!token || status !== "ready") return;
    setStatus("submitting");

    const response = await fetch("/api/auth/magic-link/confirm", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, returnTo }),
    });

    setToken(null);
    if (!response.ok) {
      setStatus("error");
      return;
    }

    window.location.assign(returnTo);
  }

  return (
    <div>
      <p>
        This page has not signed you in yet. Confirm only if you requested this link on this device.
      </p>
      <button type="button" onClick={confirm} disabled={status !== "ready"}>
        {status === "submitting" ? "Confirming…" : "Confirm sign in"}
      </button>
      <p aria-live="polite">
        {status === "error"
          ? "This sign-in link is invalid, expired, or already used. Request a new link."
          : status === "loading"
            ? "Preparing secure confirmation…"
            : ""}
      </p>
    </div>
  );
}
