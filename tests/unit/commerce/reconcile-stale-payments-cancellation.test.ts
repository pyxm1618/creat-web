import { beforeEach, expect, it, vi } from "vitest";

import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";

const state = vi.hoisted(() => ({
  allowTerminal: false,
  terminalCalls: 0,
  claimCalls: 0,
  onClaim: undefined as (() => void) | undefined,
  claimWait: undefined as Promise<void> | undefined,
  claims: [
    {
      id: "00000000-0000-0000-0000-000000000101",
      orderId: "00000000-0000-0000-0000-000000000102",
      leaseToken: "lease-token",
    },
  ],
  seedInserts: 0,
}));

vi.mock("@/platform/commerce/application/job-leases", () => ({
  acquirePaymentReconciliationFence: async (
    _transaction: unknown,
    input: {
      id: string;
      owner: string;
      leaseToken: string;
      terminalClock: () => Date;
      signal?: AbortSignal;
    },
  ) => {
    state.terminalCalls += 1;
    if (!state.allowTerminal) throw new Error("terminal transaction must not start");
    return {
      id: input.id,
      owner: input.owner,
      leaseToken: input.leaseToken,
      terminalNow: input.terminalClock(),
      attempts: 0,
      orderId: "00000000-0000-0000-0000-000000000102",
      ...(input.signal ? { signal: input.signal } : {}),
    };
  },
  claimPaymentReconciliationJobs: async () => {
    state.claimCalls += 1;
    state.onClaim?.();
    if (state.claimWait) await state.claimWait;
    return state.claims;
  },
  completePaymentReconciliationJobInTransaction: async () => {
    state.terminalCalls += 1;
    return true;
  },
  operatorReviewPaymentReconciliationJob: async () => {
    state.terminalCalls += 1;
    return true;
  },
  operatorReviewPaymentReconciliationJobInTransaction: async () => {
    state.terminalCalls += 1;
    return true;
  },
  retryPaymentReconciliationJob: async () => {
    state.terminalCalls += 1;
    return true;
  },
}));

vi.mock("@/platform/commerce/application/process-provider-event", () => ({
  processProviderEventInTransaction: async () => "applied",
}));

import { reconcileStalePayments } from "@/platform/commerce/application/reconcile-stale-payments";

function fluentQuery<T>(result: Promise<T>) {
  const query: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) {
    query[method] = () => query;
  }
  query.limit = () => result;
  return query;
}

function cancellationDatabase() {
  const seedTransaction = {
    select: () => fluentQuery(Promise.resolve([])),
    insert: () => {
      throw new Error("seed insert must not run without candidates");
    },
  };
  return {
    transaction: async (run: (tx: typeof seedTransaction) => Promise<unknown>) =>
      run(seedTransaction),
    select: () =>
      fluentQuery(
        Promise.resolve([
          {
            orderId: "00000000-0000-0000-0000-000000000102",
            environment: "test",
            externalOrderId: "ORD_ABORT_IGNORED",
            model: "one_time",
            currency: "USD",
            amountMinor: 2900n,
          },
        ]),
      ),
  };
}

function seedBarrierDatabase(seedResult: () => Promise<readonly Record<string, unknown>[]>) {
  const seedTransaction = {
    select: () => fluentQuery(seedResult()),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            state.seedInserts += 1;
            return [{ id: "00000000-0000-0000-0000-000000000103" }];
          },
        }),
      }),
    }),
  };
  return {
    transaction: async (run: (tx: typeof seedTransaction) => Promise<unknown>) =>
      run(seedTransaction),
    select: () => {
      throw new Error("facts query must not run after seed abort");
    },
  };
}

function factsBarrierDatabase(factsResult: () => Promise<readonly Record<string, unknown>[]>) {
  const seedTransaction = {
    select: () => fluentQuery(Promise.resolve([])),
    insert: () => {
      throw new Error("seed insert must not run without candidates");
    },
  };
  return {
    transaction: async (run: (tx: typeof seedTransaction) => Promise<unknown>) =>
      run(seedTransaction),
    select: () => fluentQuery(factsResult()),
  };
}

function commitCutoverDatabase(controller: AbortController, failCommit = false) {
  let transactionCalls = 0;
  const seedTransaction = {
    select: () => fluentQuery(Promise.resolve([])),
    insert: () => {
      throw new Error("seed insert must not run without candidates");
    },
  };
  return {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      transactionCalls += 1;
      if (transactionCalls === 1) return run(seedTransaction);
      const result = await run({});
      controller.abort(new DOMException("payment slice expired during commit", "AbortError"));
      if (failCommit) throw new Error("terminal commit failed");
      return result;
    },
    select: () =>
      fluentQuery(
        Promise.resolve([
          {
            orderId: "00000000-0000-0000-0000-000000000102",
            environment: "test",
            externalOrderId: "ORD_COMMIT_CUTOVER",
            model: "one_time",
            currency: "USD",
            amountMinor: 2900n,
          },
        ]),
      ),
  };
}

function paymentProvider(getPayment: PaymentProvider["getPayment"]): PaymentProvider {
  const unsupported = async () => {
    throw new Error("unexpected provider operation");
  };
  return {
    name: "cancellation-test-provider",
    capabilities: { oneTime: true, subscriptions: true, partialRefunds: true },
    createCheckout: unsupported,
    createOneTimeCheckout: unsupported,
    cancelSubscription: unsupported,
    resumeSubscription: unsupported,
    requestRefund: unsupported,
    getPayment,
    verifyAndNormalizeWebhook: unsupported,
  };
}

beforeEach(() => {
  state.allowTerminal = false;
  state.terminalCalls = 0;
  state.claimCalls = 0;
  state.onClaim = undefined;
  state.claimWait = undefined;
  state.claims = [
    {
      id: "00000000-0000-0000-0000-000000000101",
      orderId: "00000000-0000-0000-0000-000000000102",
      leaseToken: "lease-token",
    },
  ];
  state.seedInserts = 0;
});

it("returns committed counters when abort arrives after the terminal cancellation cutover", async () => {
  const controller = new AbortController();
  state.allowTerminal = true;
  state.claims = [
    {
      id: "00000000-0000-0000-0000-000000000101",
      orderId: "00000000-0000-0000-0000-000000000102",
      leaseToken: "lease-token-1",
    },
    {
      id: "00000000-0000-0000-0000-000000000103",
      orderId: "00000000-0000-0000-0000-000000000102",
      leaseToken: "lease-token-2",
    },
  ];
  let providerCalls = 0;
  const provider = paymentProvider(async () => {
    providerCalls += 1;
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: "ORD_COMMIT_CUTOVER",
          merchantOrderReference: "00000000-0000-0000-0000-000000000102",
          externalPaymentId: "PAY_COMMIT_CUTOVER",
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });

  const result = await reconcileStalePayments(
    commitCutoverDatabase(controller) as never,
    provider,
    {
      owner: "commit-cutover-worker",
      expectedStoreId: "STORE_TEST",
      now: new Date("2030-05-02T00:00:00.000Z"),
      signal: controller.signal,
    },
  );

  expect(result).toEqual({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });
  expect(providerCalls).toBe(1);
});

it("preserves an ordinary commit error when the slice aborts at the same time", async () => {
  const controller = new AbortController();
  state.allowTerminal = true;
  const provider = paymentProvider(async () => ({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: "ORD_COMMIT_CUTOVER",
        merchantOrderReference: "00000000-0000-0000-0000-000000000102",
        externalPaymentId: "PAY_COMMIT_ERROR",
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [],
  }));

  const outcome = await reconcileStalePayments(
    commitCutoverDatabase(controller, true) as never,
    provider,
    {
      owner: "commit-error-worker",
      expectedStoreId: "STORE_TEST",
      now: new Date("2030-05-02T00:00:00.000Z"),
      signal: controller.signal,
    },
  ).then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({
    settled: "rejected",
    error: { name: "Error", message: "terminal commit failed" },
  });
});

it("does not insert or claim after an aborted seed query is released", async () => {
  const controller = new AbortController();
  let markSeedStarted!: () => void;
  const seedStarted = new Promise<void>((resolve) => {
    markSeedStarted = resolve;
  });
  let releaseSeed!: () => void;
  const seedRelease = new Promise<void>((resolve) => {
    releaseSeed = resolve;
  });
  let providerCalls = 0;
  const provider = paymentProvider(async () => {
    providerCalls += 1;
    return { payments: [], warnings: [] };
  });
  const seedResult = async () => {
    markSeedStarted();
    await seedRelease;
    return [
      {
        orderId: "00000000-0000-0000-0000-000000000102",
        environment: "test",
        externalOrderId: "ORD_SEED_ABORT",
        model: "one_time",
        currency: "USD",
        amountMinor: 2900n,
        fulfillmentKey: "seed-abort",
      },
    ];
  };
  const run = reconcileStalePayments(seedBarrierDatabase(seedResult) as never, provider, {
    owner: "seed-abort-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await seedStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  releaseSeed();
  const outcome = await run.then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(state.seedInserts).toBe(0);
  expect(state.claimCalls).toBe(0);
  expect(providerCalls).toBe(0);
  expect(state.terminalCalls).toBe(0);
});

it("rejects after an aborted claim phase returns no work", async () => {
  const controller = new AbortController();
  const claimStarted = new Promise<void>((resolve) => {
    state.onClaim = resolve;
  });
  let releaseClaim!: () => void;
  state.claimWait = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  state.claims = [];
  let providerCalls = 0;
  const provider = paymentProvider(async () => {
    providerCalls += 1;
    return { payments: [], warnings: [] };
  });
  const run = reconcileStalePayments(cancellationDatabase() as never, provider, {
    owner: "claim-abort-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await claimStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  releaseClaim();
  const outcome = await run.then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(state.claimCalls).toBe(1);
  expect(providerCalls).toBe(0);
  expect(state.terminalCalls).toBe(0);
});

it("does not call the provider after an aborted facts query is released", async () => {
  const controller = new AbortController();
  let markFactsStarted!: () => void;
  const factsStarted = new Promise<void>((resolve) => {
    markFactsStarted = resolve;
  });
  let releaseFacts!: () => void;
  const factsRelease = new Promise<void>((resolve) => {
    releaseFacts = resolve;
  });
  const factsResult = async () => {
    markFactsStarted();
    await factsRelease;
    return [
      {
        orderId: "00000000-0000-0000-0000-000000000102",
        environment: "test",
        externalOrderId: "ORD_FACTS_ABORT",
        model: "one_time",
        currency: "USD",
        amountMinor: 2900n,
      },
    ];
  };
  let providerCalls = 0;
  const provider = paymentProvider(async () => {
    providerCalls += 1;
    return { payments: [], warnings: [] };
  });
  const run = reconcileStalePayments(factsBarrierDatabase(factsResult) as never, provider, {
    owner: "facts-abort-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await factsStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  releaseFacts();
  const outcome = await run.then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(providerCalls).toBe(0);
  expect(state.terminalCalls).toBe(0);
});

it("settles on abort while a read-only provider promise ignores its signal forever", async () => {
  const controller = new AbortController();
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const provider = paymentProvider(async () => {
    markLookupStarted();
    return new Promise(() => undefined);
  });
  const run = reconcileStalePayments(cancellationDatabase() as never, provider, {
    owner: "provider-ignore-abort-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await lookupStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  const outcome = await Promise.race([
    run.then(
      () => ({ settled: "resolved" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    ),
    new Promise<{ settled: "still_pending" }>((resolve) =>
      setTimeout(() => resolve({ settled: "still_pending" }), 50),
    ),
  ]);

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(state.terminalCalls).toBe(0);
});

it("ignores a late read-only provider result after the service has settled on abort", async () => {
  const controller = new AbortController();
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  let resolveLookup!: (value: Awaited<ReturnType<PaymentProvider["getPayment"]>>) => void;
  const provider = paymentProvider(async () => {
    markLookupStarted();
    return new Promise((resolve) => {
      resolveLookup = resolve;
    });
  });
  const run = reconcileStalePayments(cancellationDatabase() as never, provider, {
    owner: "provider-late-result-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await lookupStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  const outcome = await Promise.race([
    run.then(
      () => ({ settled: "resolved" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    ),
    new Promise<{ settled: "still_pending" }>((resolve) =>
      setTimeout(() => resolve({ settled: "still_pending" }), 50),
    ),
  ]);
  resolveLookup({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: "ORD_ABORT_IGNORED",
        merchantOrderReference: "00000000-0000-0000-0000-000000000102",
        externalPaymentId: "PAY_LATE_RESULT",
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(state.terminalCalls).toBe(0);
});

it("preserves a provider ordinary error that settles just before the slice abort", async () => {
  const controller = new AbortController();
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  let rejectLookup!: (error: Error) => void;
  const provider = paymentProvider(() => {
    markLookupStarted();
    return new Promise((_resolve, reject) => {
      rejectLookup = reject;
    });
  });
  const run = reconcileStalePayments(cancellationDatabase() as never, provider, {
    owner: "provider-error-race-worker",
    expectedStoreId: "STORE_TEST",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await lookupStarted;

  rejectLookup(new Error("provider lookup ordinary failure"));
  controller.abort(new DOMException("payment slice expired", "AbortError"));
  const outcome = await run.then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({
    settled: "rejected",
    error: { name: "Error", message: "provider lookup ordinary failure" },
  });
  expect(state.terminalCalls).toBe(0);
});
