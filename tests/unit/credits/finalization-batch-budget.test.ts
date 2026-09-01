import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expireGrants: vi.fn(),
  expireReservations: vi.fn(),
  reconcileCreditLedgerBatch: vi.fn(),
  runCreditFinalizationWorker: vi.fn(),
}));

vi.mock("@/config/features.config", () => ({
  featuresConfig: { commerce: { credits: true } },
}));
vi.mock("@/platform/config/env", () => ({ env: { cronSecret: "test-secret" } }));
vi.mock("@/platform/database/application-database", () => ({ db: {} }));
vi.mock("@/platform/operations/authenticate-internal-request", () => ({
  authenticateInternalRequest: () => true,
  unauthorizedInternalResponse: () => new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/platform/credits/application/credit-service", () => ({
  expireGrants: mocks.expireGrants,
  expireReservations: mocks.expireReservations,
}));
vi.mock("@/platform/credits/application/finalization-worker", () => ({
  runCreditFinalizationWorker: mocks.runCreditFinalizationWorker,
}));
vi.mock("@/platform/credits/application/reconcile-credit-ledger", () => ({
  reconcileCreditLedgerBatch: mocks.reconcileCreditLedgerBatch,
}));

import { GET as runCreditExpiryJob } from "@/app/api/internal/jobs/credit-expiry/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.expireReservations.mockResolvedValue(0);
  mocks.runCreditFinalizationWorker.mockResolvedValue({
    claimed: 4,
    processed: 4,
    completed: 0,
    deferred: 0,
    deadLettered: 0,
    lostLease: 4,
  });
  mocks.expireGrants.mockResolvedValue(46);
  mocks.reconcileCreditLedgerBatch.mockResolvedValue({
    issues: [],
    processed: 0,
    cycleComplete: false,
  });
});

it("charges lost finalization claims against the internal Credits batch", async () => {
  const response = await runCreditExpiryJob(
    new Request("https://example.com/api/internal/jobs/credit-expiry"),
  );

  expect(response.status).toBe(200);
  expect(mocks.runCreditFinalizationWorker).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ limit: 50 }),
  );
  expect(mocks.expireGrants).toHaveBeenCalledWith({}, { limit: 46 });
  expect(mocks.reconcileCreditLedgerBatch).not.toHaveBeenCalled();
});
