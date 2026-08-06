import { describe, expect, it } from "vitest";

import { createLogger } from "@/platform/observability/logger";

describe("createLogger", () => {
  it("does not allow base context to override logger-owned fields", () => {
    const records: Record<string, unknown>[] = [];
    const logger = createLogger(
      { level: "forged", event: "forged", timestamp: "forged", requestId: "req_1" },
      (record) => records.push({ ...record }),
    );

    logger.error("payment_failed", { token: "secret" });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      event: "payment_failed",
      requestId: "req_1",
      data: { token: "[REDACTED]" },
    });
    expect(records[0]?.timestamp).not.toBe("forged");
  });
});
