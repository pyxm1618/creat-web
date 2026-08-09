"use client";

import { useState } from "react";

async function command(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return response.json();
}

export function SubscriptionAction({
  subscriptionId,
  action,
}: Readonly<{ subscriptionId: string; action: "cancel" | "resume" }>) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  return (
    <button
      type="button"
      disabled={state === "pending" || state === "done"}
      onClick={async () => {
        setState("pending");
        try {
          await command(`/api/commerce/subscription/${action}`, { subscriptionId });
          setState("done");
        } catch {
          setState("error");
        }
      }}
    >
      {state === "pending" ? "Submitting…" : state === "done" ? "Queued" : state === "error" ? "Retry" : action === "cancel" ? "Cancel at period end" : "Resume subscription"}
    </button>
  );
}

export function RefundAction({
  paymentId,
  currency,
  refundableAmount,
}: Readonly<{ paymentId: string; currency: string; refundableAmount: string }>) {
  const [amount, setAmount] = useState(refundableAmount);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  return (
    <div className="billing-action">
      <label>
        Refund amount ({currency})
        <input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={state === "pending" || state === "done" || reason.trim().length < 3}
        onClick={async () => {
          setState("pending");
          try {
            await command("/api/commerce/refunds", { paymentId, amount, currency, reason });
            setState("done");
          } catch {
            setState("error");
          }
        }}
      >
        {state === "pending" ? "Submitting…" : state === "done" ? "Refund queued" : state === "error" ? "Retry refund" : "Request refund"}
      </button>
    </div>
  );
}
