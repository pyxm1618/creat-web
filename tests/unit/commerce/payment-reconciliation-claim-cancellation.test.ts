import { expect, it } from "vitest";

import { claimPaymentReconciliationJobs } from "@/platform/commerce/application/job-leases";

it("does not update a claim after an aborted candidate query is released", async () => {
  const controller = new AbortController();
  let markQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    markQueryStarted = resolve;
  });
  let releaseQuery!: () => void;
  const queryRelease = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  let updateCalls = 0;
  const candidateQuery: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    candidateQuery[method] = () => candidateQuery;
  }
  candidateQuery.for = async () => {
    markQueryStarted();
    await queryRelease;
    return [{ id: "00000000-0000-0000-0000-000000000201" }];
  };
  const transaction = {
    select: () => candidateQuery,
    update: () => {
      updateCalls += 1;
      return {
        set: () => ({
          where: () => ({
            returning: async () => [
              {
                id: "00000000-0000-0000-0000-000000000201",
                leaseToken: "late-lease-token",
              },
            ],
          }),
        }),
      };
    },
  };
  const database = {
    transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
  };
  const run = claimPaymentReconciliationJobs(database as never, {
    owner: "claim-query-abort-worker",
    now: new Date("2030-05-02T00:00:00.000Z"),
    signal: controller.signal,
  });
  await queryStarted;

  controller.abort(new DOMException("payment slice expired", "AbortError"));
  releaseQuery();
  const outcome = await run.then(
    () => ({ settled: "resolved" as const }),
    (error: unknown) => ({ settled: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({ settled: "rejected", error: { name: "AbortError" } });
  expect(updateCalls).toBe(0);
});
