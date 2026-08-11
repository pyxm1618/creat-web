"use client";

import { useRef, useState } from "react";

import {
  checkoutOperationFingerprintParts,
  createSessionOperationKeyState,
  digestOperationFingerprint,
  refundOperationFingerprintParts,
  runKeyedOperation,
  subscriptionOperationFingerprintParts,
  type OperationKeyState,
} from "./operation-key";

async function command(url: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return (await response.json()) as unknown;
}

function useKeyedOperation(scopeParts: readonly string[]) {
  const stateRef = useRef<{
    readonly scope: string;
    readonly state: Promise<OperationKeyState>;
  } | null>(null);

  return async function run<T>(
    fingerprintParts: readonly string[],
    operation: (key: string) => Promise<T>,
  ): Promise<T> {
    const scope = JSON.stringify(scopeParts);
    if (!stateRef.current || stateRef.current.scope !== scope) {
      stateRef.current = {
        scope,
        state: createSessionOperationKeyState(scopeParts),
      };
    }
    const [state, fingerprint] = await Promise.all([
      stateRef.current.state,
      digestOperationFingerprint(fingerprintParts),
    ]);
    return runKeyedOperation(state, fingerprint, operation);
  };
}

function checkoutUrl(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("checkoutUrl" in value) ||
    typeof value.checkoutUrl !== "string"
  ) {
    throw new Error("checkout response is invalid");
  }
  return value.checkoutUrl;
}

export function CheckoutAction({
  productKey,
  label = "Continue to checkout",
}: Readonly<{ productKey: string; label?: string }>) {
  const [state, setState] = useState<"idle" | "pending" | "error">("idle");
  const fingerprintParts = checkoutOperationFingerprintParts(productKey);
  const run = useKeyedOperation(fingerprintParts);
  return (
    <button
      type="button"
      disabled={state === "pending"}
      onClick={async () => {
        setState("pending");
        try {
          const target = await run(fingerprintParts, async (key) =>
            checkoutUrl(await command("/api/commerce/checkout", { productKey }, key)),
          );
          window.location.assign(target);
        } catch {
          setState("error");
        }
      }}
    >
      {state === "pending" ? "Opening checkout…" : state === "error" ? "Retry checkout" : label}
    </button>
  );
}

export function SubscriptionAction({
  subscriptionId,
  action,
}: Readonly<{ subscriptionId: string; action: "cancel" | "resume" }>) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const fingerprintParts = subscriptionOperationFingerprintParts(subscriptionId, action);
  const run = useKeyedOperation(fingerprintParts);
  return (
    <button
      type="button"
      disabled={state === "pending" || state === "done"}
      onClick={async () => {
        setState("pending");
        try {
          await run(fingerprintParts, (key) =>
            command(`/api/commerce/subscription/${action}`, { subscriptionId }, key),
          );
          setState("done");
        } catch {
          setState("error");
        }
      }}
    >
      {state === "pending"
        ? "Submitting…"
        : state === "done"
          ? "Queued"
          : state === "error"
            ? "Retry"
            : action === "cancel"
              ? "Cancel at period end"
              : "Resume subscription"}
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
  const run = useKeyedOperation(["refund", paymentId]);
  return (
    <div className="billing-action">
      <label>
        Refund amount ({currency})
        <input
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
        />
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
          const fingerprintParts = refundOperationFingerprintParts({
            paymentId,
            amount,
            currency,
            reason,
          });
          const normalizedAmount = fingerprintParts[2];
          const normalizedCurrency = fingerprintParts[3];
          const normalizedReason = fingerprintParts[4];
          try {
            await run(fingerprintParts, (key) =>
              command(
                "/api/commerce/refunds",
                {
                  paymentId,
                  amount: normalizedAmount,
                  currency: normalizedCurrency,
                  reason: normalizedReason,
                },
                key,
              ),
            );
            setState("done");
          } catch {
            setState("error");
          }
        }}
      >
        {state === "pending"
          ? "Submitting…"
          : state === "done"
            ? "Refund queued"
            : state === "error"
              ? "Retry refund"
              : "Request refund"}
      </button>
    </div>
  );
}
