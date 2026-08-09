export type BoundedJobContext = {
  readonly batchLimit: number;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
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
  const controller = new AbortController();
  const remainingMs = () => Math.max(0, deadlineAt.getTime() - now().getTime());
  const canContinue = (minimumRemainingMs = 250) =>
    !controller.signal.aborted && remainingMs() >= minimumRemainingMs;
  const assertWithinBudget = () => {
    if (!canContinue(1)) throw new Error("job runtime budget exhausted");
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("job runtime budget exhausted"));
    }, input.maxRuntimeMs);
  });

  try {
    return await Promise.race([
      input.run({
        batchLimit: input.batchLimit,
        startedAt,
        deadlineAt,
        signal: controller.signal,
        remainingMs,
        canContinue,
        assertWithinBudget,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
