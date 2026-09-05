"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { bodyText, buttonPrimary, inlineLink, metaText } from "@/components/ui/styles";

type CheckoutResponse = { readonly checkoutUrl?: unknown };
type State = "idle" | "pending" | "signin" | "conflict" | "error";

function newIdempotencyKey(): string {
  return `subscription-checkout:${crypto.randomUUID()}`;
}

export function SubscriptionOffer({
  productKey,
  headline,
  body,
  priceLabel,
}: Readonly<{
  productKey: string;
  headline: string;
  body: string;
  priceLabel: string;
}>) {
  const [state, setState] = useState<State>("idle");
  const keyRef = useRef<string | null>(null);

  async function startCheckout(): Promise<void> {
    setState("pending");
    const idempotencyKey = keyRef.current ?? newIdempotencyKey();
    keyRef.current = idempotencyKey;
    try {
      const response = await fetch("/api/commerce/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ productKey }),
      });
      if (response.status === 401) {
        setState("signin");
        return;
      }
      if (response.status === 409) {
        setState("conflict");
        return;
      }
      if (!response.ok) {
        setState("error");
        return;
      }
      const payload = (await response.json()) as CheckoutResponse;
      if (typeof payload.checkoutUrl !== "string") {
        setState("error");
        return;
      }
      window.location.assign(payload.checkoutUrl);
    } catch {
      setState("error");
    }
  }

  return (
    <article>
      <h3 className="text-base font-semibold text-foreground">{headline}</h3>
      <p className={`mt-3 ${bodyText}`}>{body}</p>
      <button
        type="button"
        className={`mt-5 ${buttonPrimary}`}
        disabled={state === "pending" || state === "conflict"}
        onClick={() => void startCheckout()}
      >
        {state === "pending"
          ? "Opening checkout…"
          : state === "conflict"
            ? "Checkout requires review"
            : `Subscribe for ${priceLabel}`}
      </button>
      {state === "signin" ? (
        <p className={`mt-3 ${metaText}`}>
          Subscriptions are tied to an account.{" "}
          <Link href="/sign-in" className={inlineLink}>
            Sign in
          </Link>{" "}
          and try again.
        </p>
      ) : null}
      {state === "error" ? (
        <p className={`mt-3 ${metaText}`}>Subscription checkout could not be started.</p>
      ) : null}
      {state === "conflict" ? (
        <p className={`mt-3 ${metaText}`}>
          Checkout requires review. Do not retry this subscription checkout.
        </p>
      ) : null}
    </article>
  );
}
