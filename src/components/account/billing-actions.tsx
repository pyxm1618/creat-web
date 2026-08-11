"use client";

import { useRef, useState } from "react";

import {
  createSessionOperationKeyState,
  digestOperationFingerprint,
  refundOperationFingerprintParts,
  runKeyedOperation,
  subscriptionOperationFingerprintParts,
  type OperationKeyState,
} from "./operation-key";

const RETRYABLE_CLIENT_HTTP_STATUSES = new Set([408, 425, 429]);

class BillingCommandHttpError extends Error {
  constructor(readonly status: number) {
    super(`request failed (${status})`);
    this.name = "BillingCommandHttpError";
  }
}

function isTerminalBillingCommandError(error: unknown): boolean {
  return (
    error instanceof BillingCommandHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    !RETRYABLE_CLIENT_HTTP_STATUSES.has(error.status)
  );
}

async function command(url: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new BillingCommandHttpError(response.status);
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
    try {
      return await runKeyedOperation(state, fingerprint, operation);
    } catch (error) {
      if (isTerminalBillingCommandError(error)) state.complete(fingerprint);
      throw error;
    }
  };
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
