import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  canContinue: true,
  workerClaimed: 0,
  workerLimit: 0,
  purgeLimit: 0,
  purgeCalls: 0,
  budgetAssertions: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/platform/config/env", () => ({ env: { cronSecret: "test-secret" } }));
vi.mock("@/platform/operations/authenticate-internal-request", () => ({
  authenticateInternalRequest: () => true,
  unauthorizedInternalResponse: () => new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: async () => ({
    database: { name: "database-double" },
    provider: { name: "provider-double" },
    fulfillment: { name: "fulfillment-double" },
  }),
}));
vi.mock("@/platform/commerce/application/run-commerce-worker", () => ({
  runCommerceWorker: async (input: { limit: number; onClaimed?: (count: number) => void }) => {
    state.workerLimit = input.limit;
    input.onClaimed?.(state.workerClaimed);
    return { inboxProcessed: 1, commandProcessed: 2, fulfillmentProcessed: 3 };
  },
}));
vi.mock("@/platform/commerce/application/purge-webhook-payloads", () => ({
  purgeRejectedWebhookDiagnostics: async (_database: unknown, input: { limit: number }) => {
    state.purgeCalls += 1;
    state.purgeLimit = input.limit;
    return input.limit;
  },
}));
vi.mock("@/platform/operations/run-bounded-job", () => ({
  runBoundedJob: async (input: {
    batchLimit: number;
    run: (job: {
      batchLimit: number;
      canContinue: (minimumRemainingMs?: number) => boolean;
      assertWithinBudget: () => void;
    }) => Promise<unknown>;
  }) =>
    input.run({
      batchLimit: input.batchLimit,
      canContinue: () => state.canContinue,
      assertWithinBudget: () => {
        state.budgetAssertions += 1;
      },
    }),
}));

import { GET } from "@/app/api/internal/jobs/commerce/route";

describe("internal Commerce maintenance route capacity", () => {
  beforeEach(() => {
    state.canContinue = true;
    state.workerClaimed = 0;
    state.workerLimit = 0;
    state.purgeLimit = 0;
    state.purgeCalls = 0;
    state.budgetAssertions = 0;
  });

  it("gives rejected-diagnostic purge only the unclaimed batch capacity", async () => {
    state.workerClaimed = 17;

    const response = await GET(new Request("https://example.test/api/internal/jobs/commerce"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inboxProcessed: 1,
      commandProcessed: 2,
      fulfillmentProcessed: 3,
      rejectedDiagnosticsPurged: 3,
    });
    expect(state.workerLimit).toBe(20);
    expect(state.purgeLimit).toBe(3);
    expect(state.workerClaimed + state.purgeLimit).toBe(20);
    expect(state.budgetAssertions).toBe(2);
  });

  it("does not start purge when the runtime budget cannot continue", async () => {
    state.canContinue = false;
    state.workerClaimed = 4;

    const response = await GET(new Request("https://example.test/api/internal/jobs/commerce"));

    expect(response.status).toBe(200);
    expect((await response.json()).rejectedDiagnosticsPurged).toBe(0);
    expect(state.purgeCalls).toBe(0);
    expect(state.budgetAssertions).toBe(2);
  });
});
