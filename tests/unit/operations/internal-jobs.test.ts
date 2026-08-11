import { describe, expect, it } from "vitest";

import { authenticateInternalRequest } from "@/platform/operations/authenticate-internal-request";
import {
  JobRuntimeBudgetExceededError,
  runBoundedJob,
} from "@/platform/operations/run-bounded-job";

describe("internal job security", () => {
  it("authenticates only an exact bearer secret", () => {
    const secret = "internal-secret-value";
    expect(
      authenticateInternalRequest(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret,
      ),
    ).toBe(true);
    expect(
      authenticateInternalRequest(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${secret}x` },
        }),
        secret,
      ),
    ).toBe(false);
    expect(authenticateInternalRequest(new Request("https://example.com"), secret)).toBe(false);
    expect(
      authenticateInternalRequest(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        undefined,
      ),
    ).toBe(false);
  });

  it("provides an immutable batch limit and runtime deadline", async () => {
    let now = new Date("2026-08-09T00:00:00Z");
    const result = await runBoundedJob({
      batchLimit: 25,
      maxRuntimeMs: 5_000,
      now: () => now,
      run: async (job) => {
        expect(job.batchLimit).toBe(25);
        expect(job.remainingMs()).toBe(5_000);
        now = new Date("2026-08-09T00:00:04Z");
        expect(job.canContinue(2_000)).toBe(false);
        expect(job.canContinue(500)).toBe(true);
        now = new Date("2026-08-09T00:00:05Z");
        expect(() => job.assertWithinBudget()).toThrow(/budget exhausted/i);
        return "done";
      },
    });
    expect(result).toBe("done");
  });

  it("fails closed when the execution exceeds the hard runtime budget", async () => {
    const startedAt = Date.now();
    let signal: AbortSignal | undefined;
    const run = runBoundedJob({
      batchLimit: 1,
      maxRuntimeMs: 1_000,
      run: async (job) => {
        signal = job.signal;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return "too-late";
      },
    });

    await expect(run).rejects.toBeInstanceOf(JobRuntimeBudgetExceededError);
    expect(signal?.reason).toBeInstanceOf(JobRuntimeBudgetExceededError);
    expect((signal?.reason as Error).message).toBe("job runtime budget exhausted");
    expect(Date.now() - startedAt).toBeLessThan(1_800);
  });

  it("rejects unbounded batch and runtime configuration", async () => {
    await expect(
      runBoundedJob({ batchLimit: 0, maxRuntimeMs: 5_000, run: async () => undefined }),
    ).rejects.toThrow(/batch limit/i);
    await expect(
      runBoundedJob({ batchLimit: 1, maxRuntimeMs: 999, run: async () => undefined }),
    ).rejects.toThrow(/runtime budget/i);
  });
});
