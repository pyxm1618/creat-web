export type BoundedJobContext = {
  readonly batchLimit: number;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly remainingMs: () => number;
  readonly canContinue: (minimumRemainingMs?: number) => boolean;
  readonly assertWithinBudget: () => void;
};

export async function runBoundedJob<T>(input: {
  readonly batchLimit: number;
  readonly maxRuntimeMs: number;
  readonly now?: () => Date;
  readonly run: (context: BoundedJobContext) => Promise<T>;
}): Promise<T> {
  const now = input.now ?? (() => new Date());
  if (!Number.isSafeInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > 500) {
    throw new Error("job batch limit must be an integer between 1 and 500");
  }
  if (
    !Number.isSafeInteger(input.maxRuntimeMs) ||
    input.maxRuntimeMs < 1_000 ||
    input.maxRuntimeMs > 10 * 60_000
  ) {
    throw new Error("job runtime budget must be between one second and ten minutes");
  }

  const startedAt = now();
  const deadlineAt = new Date(startedAt.getTime() + input.maxRuntimeMs);
  const remainingMs = () => Math.max(0, deadlineAt.getTime() - now().getTime());
  const canContinue = (minimumRemainingMs = 250) => remainingMs() >= minimumRemainingMs;
  const assertWithinBudget = () => {
    if (!canContinue(1)) throw new Error("job runtime budget exhausted");
  };

  return input.run({
    batchLimit: input.batchLimit,
    startedAt,
    deadlineAt,
    remainingMs,
    canContinue,
    assertWithinBudget,
  });
}
