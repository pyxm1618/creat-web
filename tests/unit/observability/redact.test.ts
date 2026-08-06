import { describe, expect, it } from "vitest";

import { redactForLogging } from "@/platform/observability/redact";

describe("redactForLogging", () => {
  it("redacts sensitive keys recursively without mutating input", () => {
    const input = {
      requestId: "req_123",
      email: "person@example.com",
      headers: {
        cookie: "session=secret",
        authorization: "Bearer top-secret",
      },
      nested: [{ token: "magic-token", safe: "visible" }],
    };

    expect(redactForLogging(input)).toEqual({
      requestId: "req_123",
      email: "[REDACTED]",
      headers: {
        cookie: "[REDACTED]",
        authorization: "[REDACTED]",
      },
      nested: [{ token: "[REDACTED]", safe: "visible" }],
    });
    expect(input.email).toBe("person@example.com");
  });

  it("normalizes errors without retaining arbitrary secret fields", () => {
    const error = Object.assign(new Error("provider failed"), {
      apiKey: "sk-secret",
      response: { checkoutUrl: "https://provider.example/checkout?secret=value" },
    });

    expect(redactForLogging(error)).toEqual({
      name: "Error",
      message: "provider failed",
    });
  });

  it("handles cycles safely", () => {
    const value: Record<string, unknown> = { safe: "value" };
    value.self = value;

    expect(redactForLogging(value)).toEqual({ safe: "value", self: "[CIRCULAR]" });
  });
});
