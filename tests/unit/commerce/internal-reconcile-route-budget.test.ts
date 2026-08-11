import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  boundedCalls: 0,
  paymentSignal: undefined as AbortSignal | undefined,
  sliceSignal: undefined as AbortSignal | undefined,
  abortOuter: true,
  reconciliationError: undefined as Error | undefined,
  refundCalls: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/config/features.config", () => ({
  featuresConfig: { commerce: { enabled: true, credits: false } },
}));
vi.mock("@/platform/config/env", () => ({
  env: { cronSecret: "route-secret", waffoStoreId: "STORE_ROUTE" },
}));
vi.mock("@/platform/database/application-database", () => ({ db: {} }));
vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: async () => ({
    database: {},
    provider: {},
    environment: "test",
  }),
}));
vi.mock("@/platform/commerce/application/reconcile-stale-payments", () => ({
  reconcileStalePayments: async (
    _database: unknown,
    _provider: unknown,
    input: { signal?: AbortSignal },
  ) => {
    if (state.reconciliationError) throw state.reconciliationError;
    if (!input.signal) throw new Error("payment signal missing");
    state.paymentSignal = input.signal;
    return new Promise((_resolve, reject) => {
      input.signal!.addEventListener(
        "abort",
        () => reject(input.signal!.reason ?? new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  },
}));
vi.mock("@/platform/commerce/application/reconcile-stale-refunds", () => ({
  reconcileStaleRefunds: async () => {
    state.refundCalls += 1;
    return 0;
  },
}));
vi.mock("@/platform/commerce/application/purge-webhook-payloads", () => ({
  purgeExpiredWebhookPayloads: async () => 0,
}));
vi.mock("@/platform/commerce/application/webhook-retention-metrics", () => ({
  getWebhookRetentionMetrics: async () => ({
    retainedPayloads: 0,
    oldestRetainedPayloadAgeSeconds: 0,
  }),
}));
vi.mock("@/platform/credits/application/reconcile-credit-ledger", () => ({
  reconcileCreditLedgerBatch: async () => ({ processed: 0, issues: [], cycleComplete: true }),
}));
vi.mock("@/platform/observability/operational-snapshot", () => ({
  collectOperationalAlertSnapshot: async () => ({}),
}));
vi.mock("@/platform/observability/metrics", () => ({ emitMetric: () => undefined }));
vi.mock("@/platform/observability/alerts", () => ({
  evaluateOperationalAlerts: () => [],
  emitOperationalAlerts: () => undefined,
}));
vi.mock("@/platform/operations/run-bounded-job", () => ({
  runBoundedJob: async (input: {
    batchLimit: number;
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
    const running = input.run({
      batchLimit: input.batchLimit,
      signal: controller.signal,
      canContinue: () => true,
      assertWithinBudget: () => undefined,
    });
    if (callNumber === 1 && state.abortOuter) {
      queueMicrotask(() =>
        controller.abort(new DOMException("global runtime exhausted", "AbortError")),
      );
      return Promise.race([
        running,
        new Promise((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          }),
        ),
      ]);
    }
    state.sliceSignal = controller.signal;
    return running;
  },
}));

import { GET } from "@/app/api/internal/jobs/reconcile/route";

beforeEach(() => {
  state.boundedCalls = 0;
  state.paymentSignal = undefined;
  state.sliceSignal = undefined;
  state.abortOuter = true;
  state.reconciliationError = undefined;
  state.refundCalls = 0;
});

it("propagates the outer global abort into an active payment slice", async () => {
  await expect(
    GET(
      new Request("https://example.test/api/internal/jobs/reconcile", {
        headers: { authorization: "Bearer route-secret" },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(state.paymentSignal?.aborted).toBe(true);
  expect(state.sliceSignal?.aborted).toBe(false);
  expect(state.refundCalls).toBe(0);
});

it("does not swallow an ordinary payment database failure", async () => {
  state.abortOuter = false;
  state.reconciliationError = new Error("payment database unavailable");

  await expect(
    GET(
      new Request("https://example.test/api/internal/jobs/reconcile", {
        headers: { authorization: "Bearer route-secret" },
      }),
    ),
  ).rejects.toThrow("payment database unavailable");

  expect(state.sliceSignal?.aborted).toBe(false);
  expect(state.refundCalls).toBe(0);
});
