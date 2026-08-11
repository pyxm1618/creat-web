import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  class TestJobRuntimeBudgetExceededError extends Error {
    override readonly name = "JobRuntimeBudgetExceededError";

    constructor() {
      super("job runtime budget exhausted");
    }
  }

  return {
    BudgetError: TestJobRuntimeBudgetExceededError,
    scenario: "slice_abort" as
      | "slice_abort"
      | "distinct_slice_error"
      | "ordinary_error_after_slice"
      | "commit_after_slice",
    boundedCalls: 0,
    runtimeEnabled: true,
    runtimeCalls: 0,
    paymentCalls: 0,
    outerAtSlice: false,
    outerTimeoutMs: undefined as number | undefined,
    paymentSignal: undefined as AbortSignal | undefined,
    serviceSettled: false,
    serviceObservedAbort: false,
    serviceError: undefined as Error | undefined,
    resolveService: undefined as
      | ((result: {
          scanned: number;
          applied: number;
          retried: number;
          operatorReview: number;
        }) => void)
      | undefined,
    refundCalls: 0,
    purgeCalls: 0,
    creditCalls: 0,
    snapshotCalls: 0,
    alertCalls: 0,
    maintenanceBeforeServiceSettled: false,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/config/features.config", () => ({
  featuresConfig: { commerce: { enabled: true, credits: true } },
}));
vi.mock("@/platform/config/env", () => ({
  env: { cronSecret: "route-secret", waffoStoreId: "STORE_ROUTE" },
}));
vi.mock("@/platform/database/application-database", () => ({ db: {} }));
vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: async () => {
    state.runtimeCalls += 1;
    return state.runtimeEnabled
      ? {
          database: {},
          provider: {},
          environment: "test",
        }
      : null;
  },
}));
vi.mock("@/platform/commerce/application/reconcile-stale-payments", () => ({
  reconcileStalePayments: async (
    _database: unknown,
    _provider: unknown,
    input: { signal?: AbortSignal },
  ) => {
    state.paymentCalls += 1;
    if (!input.signal) throw new Error("payment signal missing");
    state.paymentSignal = input.signal;
    const result = new Promise<{
      scanned: number;
      applied: number;
      retried: number;
      operatorReview: number;
    }>((resolve, reject) => {
      state.resolveService = resolve;
      input.signal!.addEventListener(
        "abort",
        () => {
          state.serviceObservedAbort = true;
          if (state.scenario === "slice_abort") {
            reject(input.signal!.reason);
          } else if (state.scenario === "distinct_slice_error") {
            state.serviceError = new state.BudgetError();
            reject(state.serviceError);
          } else if (state.scenario === "ordinary_error_after_slice") {
            reject(new Error("payment database unavailable"));
          }
        },
        { once: true },
      );
    });
    return result.finally(() => {
      state.serviceSettled = true;
    });
  },
}));
vi.mock("@/platform/commerce/application/reconcile-stale-refunds", () => ({
  reconcileStaleRefunds: async () => {
    if (!state.serviceSettled) state.maintenanceBeforeServiceSettled = true;
    state.refundCalls += 1;
    return 0;
  },
}));
vi.mock("@/platform/commerce/application/purge-webhook-payloads", () => ({
  purgeExpiredWebhookPayloads: async () => {
    state.purgeCalls += 1;
    return 0;
  },
}));
vi.mock("@/platform/commerce/application/webhook-retention-metrics", () => ({
  getWebhookRetentionMetrics: async () => ({
    retainedPayloads: 0,
    oldestRetainedPayloadAgeSeconds: 0,
  }),
}));
vi.mock("@/platform/credits/application/reconcile-credit-ledger", () => ({
  reconcileCreditLedgerBatch: async () => {
    state.creditCalls += 1;
    return { processed: 0, issues: [], cycleComplete: true };
  },
}));
vi.mock("@/platform/observability/operational-snapshot", () => ({
  collectOperationalAlertSnapshot: async () => {
    state.snapshotCalls += 1;
    return {
      deadLettersCreated: 0,
      magicLinkRequests5m: 0,
      invalidWebhookSignatures5m: 0,
      reconciliationMismatches: 0,
      jobBacklog: 0,
      oldestJobAgeSeconds: 0,
      providerFailures5m: 0,
    };
  },
}));
vi.mock("@/platform/observability/metrics", () => ({ emitMetric: () => undefined }));
vi.mock("@/platform/observability/alerts", () => ({
  evaluateOperationalAlerts: () => [],
  emitOperationalAlerts: () => {
    state.alertCalls += 1;
  },
}));
vi.mock("@/platform/operations/run-bounded-job", () => ({
  JobRuntimeBudgetExceededError: state.BudgetError,
  runBoundedJob: async (input: {
    batchLimit: number;
    maxRuntimeMs: number;
    run: (job: {
      batchLimit: number;
      signal: AbortSignal;
      canContinue: () => boolean;
      assertWithinBudget: () => void;
    }) => Promise<unknown>;
  }) => {
    state.boundedCalls += 1;
    const callNumber = state.boundedCalls;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const controlledOuterTimeout =
      callNumber === 1
        ? (state.outerTimeoutMs ?? (state.outerAtSlice ? 5_000 : undefined))
        : undefined;
    const timeoutMs = controlledOuterTimeout ?? input.maxRuntimeMs;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const error =
          controlledOuterTimeout !== undefined
            ? new DOMException("outer runtime exhausted", "AbortError")
            : new state.BudgetError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        input.run({
          batchLimit: input.batchLimit,
          signal: controller.signal,
          canContinue: () => !controller.signal.aborted,
          assertWithinBudget: () => {
            if (controller.signal.aborted) throw controller.signal.reason;
          },
        }),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  },
}));

import { GET } from "@/app/api/internal/jobs/reconcile/route";

function authorizedRequest() {
  return new Request("https://example.test/api/internal/jobs/reconcile", {
    headers: { authorization: "Bearer route-secret" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  state.scenario = "slice_abort";
  state.boundedCalls = 0;
  state.runtimeEnabled = true;
  state.runtimeCalls = 0;
  state.paymentCalls = 0;
  state.outerAtSlice = false;
  state.outerTimeoutMs = undefined;
  state.paymentSignal = undefined;
  state.serviceSettled = false;
  state.serviceObservedAbort = false;
  state.serviceError = undefined;
  state.resolveService = undefined;
  state.refundCalls = 0;
  state.purgeCalls = 0;
  state.creditCalls = 0;
  state.snapshotCalls = 0;
  state.alertCalls = 0;
  state.maintenanceBeforeServiceSettled = false;
});

it("does not construct Commerce runtime or call the payment service when authentication fails", async () => {
  const response = await GET(new Request("https://example.test/api/internal/jobs/reconcile"));

  expect(response.status).toBe(401);
  expect(state.runtimeCalls).toBe(0);
  expect(state.paymentCalls).toBe(0);
  expect(state.refundCalls).toBe(0);
});

it("does not call the payment service or maintenance when Commerce is disabled", async () => {
  state.runtimeEnabled = false;

  const response = await GET(authorizedRequest());

  expect(response.status).toBe(404);
  expect(state.runtimeCalls).toBe(1);
  expect(state.paymentCalls).toBe(0);
  expect(state.refundCalls).toBe(0);
});

afterEach(() => {
  vi.useRealTimers();
});

it("waits for payment service quiescence before maintenance after a typed slice timeout", async () => {
  const responsePromise = GET(authorizedRequest());

  await vi.advanceTimersByTimeAsync(5_000);
  const response = await responsePromise;

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    paymentScanned: 0,
    paymentApplied: 0,
    paymentRetried: 0,
    paymentOperatorReview: 0,
  });
  expect(state.serviceObservedAbort).toBe(true);
  expect(state.serviceSettled).toBe(true);
  expect(state.maintenanceBeforeServiceSettled).toBe(false);
  expect(state.refundCalls).toBe(1);
});

it("rethrows an ordinary database error even when the slice is already aborted", async () => {
  state.scenario = "ordinary_error_after_slice";
  const responsePromise = GET(authorizedRequest());
  const outcome = responsePromise.then(
    (response) => ({ kind: "resolved" as const, response }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await vi.advanceTimersByTimeAsync(5_000);

  const result = await outcome;
  expect(result).toMatchObject({
    kind: "rejected",
    error: { message: "payment database unavailable" },
  });
  expect(state.paymentSignal?.aborted).toBe(true);
  expect(state.serviceSettled).toBe(true);
  expect(state.refundCalls).toBe(0);
});

it("rethrows a distinct typed error instead of treating it as the slice reason", async () => {
  state.scenario = "distinct_slice_error";
  const responsePromise = GET(authorizedRequest());
  const outcome = responsePromise.then(
    (response) => ({ kind: "resolved" as const, response }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await vi.advanceTimersByTimeAsync(5_000);

  const result = await outcome;
  expect(result).toMatchObject({ kind: "rejected" });
  if (result.kind !== "rejected") throw new Error("expected route rejection");
  expect(result.error).toBe(state.serviceError);
  expect(result.error).not.toBe(state.paymentSignal?.reason);
  expect(state.refundCalls).toBe(0);
  expect(state.purgeCalls).toBe(0);
  expect(state.creditCalls).toBe(0);
  expect(state.snapshotCalls).toBe(0);
  expect(state.alertCalls).toBe(0);
});

it("awaits a terminal commit past the cancellation cutover and returns its real counters", async () => {
  state.scenario = "commit_after_slice";
  let responseSettled = false;
  const responsePromise = GET(authorizedRequest()).finally(() => {
    responseSettled = true;
  });

  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.serviceObservedAbort).toBe(true);
  expect(responseSettled).toBe(false);
  expect(state.serviceSettled).toBe(false);
  expect(state.maintenanceBeforeServiceSettled).toBe(false);
  expect(state.refundCalls).toBe(0);

  state.resolveService?.({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });
  const response = await responsePromise;

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ paymentScanned: 1, paymentApplied: 1 });
  expect(state.serviceSettled).toBe(true);
  expect(state.refundCalls).toBe(1);
});

it("keeps an outer abort authoritative after terminal cutover and before maintenance", async () => {
  state.scenario = "commit_after_slice";
  state.outerTimeoutMs = 4_000;
  const responsePromise = GET(authorizedRequest());
  const outcome = responsePromise.then(
    (response) => ({ kind: "resolved" as const, response }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await vi.advanceTimersByTimeAsync(4_000);
  expect(await outcome).toMatchObject({
    kind: "rejected",
    error: { name: "AbortError", message: "outer runtime exhausted" },
  });
  expect(state.serviceObservedAbort).toBe(true);
  expect(state.serviceSettled).toBe(false);

  state.resolveService?.({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });
  await vi.advanceTimersByTimeAsync(0);

  expect(state.serviceSettled).toBe(true);
  expect(state.refundCalls).toBe(0);
  expect(state.purgeCalls).toBe(0);
  expect(state.creditCalls).toBe(0);
  expect(state.snapshotCalls).toBe(0);
  expect(state.alertCalls).toBe(0);
});

it("keeps an outer abort authoritative when outer and slice deadlines coincide", async () => {
  state.outerAtSlice = true;
  const responsePromise = GET(authorizedRequest());
  const outcome = responsePromise.then(
    (response) => ({ kind: "resolved" as const, response }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await vi.advanceTimersByTimeAsync(5_000);

  expect(await outcome).toMatchObject({
    kind: "rejected",
    error: { name: "AbortError", message: "outer runtime exhausted" },
  });
  expect(state.paymentSignal?.reason).toMatchObject({ message: "outer runtime exhausted" });
  expect(state.refundCalls).toBe(0);
});
