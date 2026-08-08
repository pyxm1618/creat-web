import { describe, expect, it } from "vitest";

import { formatDisplayAmount, parseDisplayAmount } from "@/platform/commerce/domain/money";

describe("commerce money", () => {
  it("parses display strings without binary floating point", () => {
    expect(parseDisplayAmount("29.00", "USD")).toEqual({ currency: "USD", minor: 2900n });
    expect(parseDisplayAmount("4500", "JPY")).toEqual({ currency: "JPY", minor: 4500n });
  });

  it("rejects malformed, unsupported and over-precision values", () => {
    expect(() => parseDisplayAmount("29.001", "USD")).toThrow("invalid USD precision");
    expect(() => parseDisplayAmount("NaN", "USD")).toThrow("invalid amount");
    expect(() => parseDisplayAmount("9.99", "XXX")).toThrow("unsupported currency");
  });

  it("formats minor units back to provider display strings", () => {
    expect(formatDisplayAmount({ currency: "USD", minor: 299n })).toBe("2.99");
    expect(formatDisplayAmount({ currency: "JPY", minor: 4500n })).toBe("4500");
  });
});
